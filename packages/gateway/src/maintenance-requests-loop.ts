/**
 * ★★ 维护请求的**认领循环**（`FIX_PLAN.md` §72 / §74）。
 *
 * ## 它解决什么
 * ★ 用户裁定「所有的沉降**都有手动触发途径，都有工具触发途径**」。
 * ★ 但维护循环**只该有一个 owner**（`settle-loop.ts` 的模块头写了原因：
 *   冷层根路径只有那个进程解析得到；而插件可能被多个 profile 各起一份）。
 * ⇒ ★ 所以插件侧**不自己搬文件**，而是**写一条请求**；由 owner 认领并执行。
 *
 * ## ★★ 「被动模式」与「看邮箱」是两件事
 * ★ 用户要求沉降循环**默认为惰性**（不主动跑）。★ 那说的是**不主动跑维护**。
 * ★ 而"有没有人请求过"必须有人看一眼 —— ★ 那是一次 `SELECT`（走 `idx_maintenance_requests_pending`
 *   索引，几乎零成本），**不是维护本身**。
 * ⇒ ★ 两者分开：**维护仍然是惰性的**（没人请求就什么都不做），**只是邮箱有人看**。
 *
 * ## ★★ 认领之后跑的是**同一条 `tick()`**
 * ★ 这是"手动与自动走同一引擎"这句承诺的凭据。
 * ★ PLAN §2.14.14 警告过：另写一套"整理型"实现会让
 *   「面板点了压缩，实际压缩的参数与自动压缩不一样」—— ★ **这种不一致极难发现**。
 *
 * ## 三条纪律（照抄 `settle-loop.ts` 的，理由一样）
 * 1. **一轮跑完再排下一轮** —— 维护可能跑很久，固定间隔会让轮次堆积；
 * 2. **自己接住异常** —— 循环里抛异常会**静默杀死整个循环**；
 * 3. **`unref()`** —— 一个维护轮询不该让进程无法退出。
 *
 * @module forlife-gateway/maintenance-requests-loop
 */
import { claimMaintenanceRequests, finishMaintenanceRequest } from '@forlife/store'
import type { DatabaseSync } from 'node:sqlite'

import { atLevel } from './admin/log.ts'

/** 轮询间隔：看一眼邮箱而已，30 秒足够，且成本可忽略。 */
export const MAINTENANCE_POLL_INTERVAL_MS = 30_000

/** 轮询器的选项。 */
export interface MaintenanceRequestLoopOptions {
  readonly db: DatabaseSync
  /**
   * ★★ 跑维护 —— **必须是维护循环那条 `tick()`**。
   * ★ 传别的（比如另写一套）就等于把"手动与自动一致"变成谎话。
   */
  readonly run: (kind: string) => Promise<string>
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearTimeoutImpl?: (handle: unknown) => void
  readonly now?: (() => Date) | undefined
}

/** 轮询器句柄。 */
export interface MaintenanceRequestLoop {
  /** 手动跑一轮认领（测试直接调它）。 */
  readonly tick: () => Promise<number>
  readonly stop: () => void
}

/**
 * 启动维护请求的认领循环。
 *
 * @param options - 见 {@link MaintenanceRequestLoopOptions}。
 * @returns 句柄（`tick` / `stop`）。
 */
export function startMaintenanceRequestLoop(options: MaintenanceRequestLoopOptions): MaintenanceRequestLoop {
  const log = options.log
  const intervalMs = options.intervalMs ?? MAINTENANCE_POLL_INTERVAL_MS
  const now = options.now ?? ((): Date => new Date())

  /**
   * 认领并执行一批请求。
   *
   * @returns 这一轮处理了几条（0 = 邮箱是空的，那是最常见的情况）。
   */
  const tick = async (): Promise<number> => {
    let claimed: readonly { readonly id: string; readonly kind: string; readonly reason: string | null }[] = []
    try {
      claimed = claimMaintenanceRequests(options.db, 'gateway', 3, now())
    } catch (error) {
      // ★ **fault**：认领都做不到 ⇒ 这一类操作都会出问题（不是"这一次没兜住"）
      atLevel(log, 'fault')(`维护请求认领失败：${String(error).slice(0, 160)}`)
      return 0
    }
    if (claimed.length === 0) return 0

    for (const request of claimed) {
      try {
        // ★★ **跑的是同一条 `tick()`**（由调用方注入）—— 不另写一套。
        const result = await options.run(request.kind)
        finishMaintenanceRequest(options.db, request.id, true, result, now())
        log(`维护请求 ${request.id}（${request.kind}）已完成：${result}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // ★ **失败也要落 result** —— 否则面板上看到的是"跑过了"，而实际什么都没做
        finishMaintenanceRequest(options.db, request.id, false, detail, now())
        atLevel(log, 'error')(`维护请求 ${request.id}（${request.kind}）失败：${detail}`)
      }
    }
    return claimed.length
  }

  const scheduleFn = options.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearFn = options.clearTimeoutImpl ?? ((handle: unknown) => clearTimeout(handle as never))

  let stopped = false
  let handle: { unref?: () => void } | undefined

  const schedule = (): void => {
    if (stopped) return
    if (intervalMs <= 0) return
    handle = scheduleFn(() => {
      void tick()
        .catch((error: unknown) => {
          // ★ 循环里抛异常会**静默杀死整个循环** ⇒ 必须自己接住
          atLevel(log, 'fault')(`维护请求轮询异常：${String(error).slice(0, 160)}`)
        })
        .finally(() => {
          schedule()
        })
    }, intervalMs)
    handle.unref?.()
  }

  if (intervalMs <= 0) {
    atLevel(log, 'note')('维护请求轮询：未启动（间隔 0）—— 只能靠面板手动触发')
  } else {
    schedule()
    atLevel(log, 'note')(
      `维护请求轮询已启动：每 ${String(Math.round(intervalMs / 1000))} 秒看一眼邮箱` +
        '（★ 只是 SELECT，不跑维护；没人请求时什么都不做）',
    )
  }

  return {
    tick,
    stop: () => {
      stopped = true
      if (handle !== undefined) clearFn(handle)
    },
  }
}
