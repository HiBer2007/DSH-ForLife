/**
 * 沉降循环（PLAN 阶段 9 交付物 1 的**最后一块**）。
 *
 * ## 为什么需要一个"循环"而不只是 `settleBlobs` 函数
 *
 * `settleBlobs` 只是**一次**沉降。交付物 1 要的是「**定时**沉降任务」——
 * 而"定时"意味着：进程活着的时候它自己会跑，而不是等人手动调。
 *
 * 没有这一层的话，交付物 1 只是"有沉降能力"，不是"有沉降"。
 *
 * ## 四条设计（都从项目里已有的循环学来）
 *
 * 1. **没配根路径 ⇒ 不启动**（而不是跑一个什么都不做的循环）——
 *    与 `wake-system-monitor` 的"没配挂载点就不起循环"一致。
 * 2. **自己接住异常** —— 定时器里抛异常会**静默杀死整个循环**，
 *    沉降从此失效而没人知道。
 * 3. **一轮跑完再排下一轮**（不是固定间隔硬塞）——
 *    沉降可能跑很久；固定间隔会让轮次堆积，和唤醒引擎那个
 *    "每秒重放"的 bug 是同一类。
 * 4. **汇报结果** —— 界面与日志要能看到"搬了几条、失败几条"，
 *    否则"沉降没生效"和"没有东西可沉"看起来一模一样。
 *
 * @module @forlife/gateway/settle-loop
 */
import type { DatabaseSync } from 'node:sqlite'

import { resolveTierRoots, settleBlobs, settlePolicyFromEnv, type MoveFile } from '@forlife/store'

/** 循环配置（从环境变量解析）。 */
export interface SettleLoopConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly limit: number
  readonly disabledReason: string | undefined
}

/** 从环境变量读循环配置。 */
export function settleLoopConfigFromEnv(env: Record<string, string | undefined>): SettleLoopConfig {
  const hot = env['FORLIFE_ROOT_HOT']
  if (hot === undefined || hot.trim() === '') {
    // **没配根路径 ⇒ 明确禁用**（而不是跑一个什么都不做的循环）
    return {
      enabled: false,
      intervalMs: 0,
      limit: 0,
      disabledReason: '没有配置 FORLIFE_ROOT_HOT，沉降循环未启动（不知道往哪搬）',
    }
  }
  const raw = Number(env['FORLIFE_SETTLE_INTERVAL_MS'] ?? '')
  // 默认 30 分钟：沉降是**低频**运维动作，跑太勤只会白扫表
  const intervalMs = Number.isFinite(raw) && raw >= 10_000 ? raw : 30 * 60_000
  const rawLimit = Number(env['FORLIFE_SETTLE_LIMIT'] ?? '')
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50
  return { enabled: true, intervalMs, limit, disabledReason: undefined }
}

/** 一轮的结果摘要（给日志与界面）。 */
export interface SettleTickResult {
  readonly moved: number
  readonly skipped: number
  readonly failed: number
  /** 失败的原因（最多几条，够排障就行）。 */
  readonly failures: readonly string[]
}

/** 沉降循环。 */
export interface SettleLoop {
  /** 跑一轮（测试直接调它）。 */
  readonly tick: () => Promise<SettleTickResult>
  readonly stop: () => void
  readonly config: SettleLoopConfig
}

/** 启动沉降循环。 */
export function startSettleLoop(options: {
  readonly db: DatabaseSync
  readonly env: Record<string, string | undefined>
  readonly moveFile: MoveFile
  readonly log: (message: string) => void
  readonly now?: () => Date
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void }
}): SettleLoop {
  const log = options.log
  const config = settleLoopConfigFromEnv(options.env)
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))
  const setTimeoutFn = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))

  if (!config.enabled) {
    log(`沉降循环未启用：${String(config.disabledReason)}`)
    return {
      config,
      tick: async () => ({ moved: 0, skipped: 0, failed: 0, failures: [] }),
      stop: () => {},
    }
  }

  let stopped = false
  let handle: { unref?: () => void } | undefined

  const tick = async (): Promise<SettleTickResult> => {
    const roots = resolveTierRoots(options.env)
    const outcomes = await settleBlobs({
      db: options.db,
      roots,
      policy: settlePolicyFromEnv(options.env),
      moveFile: options.moveFile,
      limit: config.limit,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const moved = outcomes.filter((o) => o.action === 'moved').length
    const skipped = outcomes.filter((o) => o.action === 'skipped').length
    const failed = outcomes.filter((o) => o.action === 'failed').length
    const failures = outcomes.filter((o) => o.action === 'failed').map((o) => `${o.id}：${o.reason}`)
    if (moved > 0 || failed > 0) {
      log(`沉降一轮：搬了 ${String(moved)} 条、跳过 ${String(skipped)} 条、失败 ${String(failed)} 条`)
    }
    return { moved, skipped, failed, failures }
  }

  /**
   * **一轮跑完再排下一轮**（不是固定间隔硬塞）。
   *
   * 沉降可能跑很久（几万条 blob）。固定间隔会让轮次堆积 ——
   * 那与唤醒引擎"每秒重放同一条触发器"是同一类 bug
   * （真机烧了 141 次模型调用的那个）。
   */
  const schedule = (): void => {
    if (stopped) return
    handle = setTimeoutFn(() => {
      void tick()
        .catch((error: unknown) => {
          // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环
          log(`沉降一轮异常：${String(error).slice(0, 200)}`)
        })
        .finally(() => {
          schedule()
        })
    }, config.intervalMs)
    handle.unref?.()
  }

  schedule()
  log(`沉降循环已启动：每 ${String(Math.round(config.intervalMs / 60_000))} 分钟一轮，每次最多 ${String(config.limit)} 条`)

  return {
    config,
    tick,
    stop: () => {
      stopped = true
      if (handle !== undefined) clearIntervalFn(handle)
    },
  }
}
