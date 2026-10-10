/**
 * 插件侧的唤醒轮询器（方向性调整第 3 步）。
 *
 * ## 它做什么
 *
 * 每秒认领 `wake_requests` 里的待办，逐个交给 DSH 的会话去执行：
 *
 * ```
 * claim → resolveAgent → 忙判定 → createMessage → followup → flush → complete
 * ```
 *
 * ## 为什么**不**走 `handleWakeRequest`
 *
 * `handleWakeRequest` 是给**跨进程 HTTP** 用的，它有三层守卫：
 * 密钥校验、忙判定、flush。而轮询器**就在 DSH 进程内**：
 *  - **密钥校验在这里没有意义** —— 同进程调自己，校验的是一个自己刚写进去的值；
 *  - 忙判定与 flush **仍然必要**，所以这里**原样保留**它们的语义。
 *
 * 结论：复用**守卫的语义**，不复用**那层 HTTP 外壳**。
 * （`handleWakeRequest` 保留不删 —— 将来 DSH 若提供免鉴权路由，可以切回去。）
 *
 * ## 三条必须守住的判断
 *
 * 1. **`sourceKind` 绝不能是 `user`** —— 那等于伪造人类授权。
 *    库里存的就是 `wake-timer` / `wake-system`，这里只透传，
 *    但**要显式挡一道**：万一将来有人写错，不该静默地变成"用户说的"。
 * 2. **会话忙 ⇒ 不打断**，并且**不标记完成** —— 让超时回收后重试。
 *    标记完成的话那次唤醒就丢了；打断的话会把用户正在等的回答截断。
 * 3. **flush 失败 ⇒ 算失败** —— 没落盘的话进程一挂那次唤醒就没了，
 *    而模型可能已经做了动作（比如发了消息）—— 账对不上。
 *
 * @module forlife-memory/wake-poller
 */
import { claimWakeRequests, completeWakeRequest, type WakeRequestRow } from '@forlife/store'
import { atLevel } from '@forlife/gateway'

/** 执行一次唤醒所需的能力（注入，便于测试）。 */
export interface WakeDeliveryHost {
  readonly resolveAgent: (sessionId: string) => Promise<
    | {
        readonly agent: {
          readonly status: string
          readonly followup: (message: unknown) => void
          readonly session: unknown
        }
      }
    | undefined
  >
  readonly flush: (session: unknown) => Promise<boolean>
  readonly createMessage: (input: { readonly text: string; readonly sourceKind: string; readonly summary: string }) => unknown
  readonly withoutInitiator: <T>(fn: () => Promise<T>) => Promise<T>
}

/** 一次投递的结果。 */
export interface DeliveryResult {
  /** 是否算完成（false ⇒ 留在队列里等重试）。 */
  readonly done: boolean
  readonly reason: string
  /** 模型做了什么（给面板显示）。 */
  readonly modelDid?: string
}

/** 投递一条（**纯逻辑，不碰数据库** —— 便于测试）。 */
export async function deliverWakeRequest(host: WakeDeliveryHost, row: WakeRequestRow): Promise<DeliveryResult> {
  // ① **绝不能是 user** —— 那等于伪造人类授权
  if (row.source_kind === 'user' || row.source_kind.trim() === '') {
    return { done: true, reason: `拒绝投递：sourceKind 是「${row.source_kind}」（系统唤醒不能伪装成用户消息）` }
  }

  // ② 取 agent（冷会话会被 resume）
  const resolved = await host.withoutInitiator(async () => host.resolveAgent(row.session_id))
  if (resolved === undefined) {
    // 会话不存在 ⇒ 重试也没用 ⇒ **标记完成**（避免它永远卡在队列里）
    return { done: true, reason: `会话 ${row.session_id} 不存在（或取不到 agent），放弃` }
  }

  // ③ 忙 ⇒ **不打断，也不标记完成**（让超时回收后重试）
  if (resolved.agent.status !== 'idle') {
    return { done: false, reason: `会话正忙（status=${resolved.agent.status}），稍后重试` }
  }

  // ④ 构造并投递
  const message = host.createMessage({ text: row.text, sourceKind: row.source_kind, summary: row.summary })
  resolved.agent.followup(message)

  // ⑤ 落盘确认 —— 没落盘的话进程一挂那次唤醒就没了
  const flushed = await host.flush(resolved.agent.session)
  if (!flushed) {
    return { done: false, reason: '会话未能落盘（flush 返回 false），稍后重试' }
  }

  return { done: true, reason: '已投递给会话', modelDid: `按「${row.summary}」醒来并执行了提示词` }
}

/** 轮询器。 */
export interface WakePoller {
  /** 跑一轮（测试直接调它）。 */
  readonly tick: () => Promise<readonly { readonly id: string; readonly result: DeliveryResult }[]>
  readonly stop: () => void
}

/** 启动轮询器。 */
export function startWakePoller(options: {
  readonly db: Parameters<typeof claimWakeRequests>[0]
  readonly host: WakeDeliveryHost
  readonly claimer: string
  readonly intervalMs?: number
  readonly log?: (message: string) => void
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
}): WakePoller {
  const intervalMs = Math.max(250, options.intervalMs ?? 1000)
  const log = options.log ?? ((): void => {})
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))

  const tick = async (): Promise<readonly { id: string; result: DeliveryResult }[]> => {
    const claimed = claimWakeRequests(options.db, options.claimer)
    const out: { id: string; result: DeliveryResult }[] = []
    for (const row of claimed) {
      try {
        const result = await deliverWakeRequest(options.host, row)
        if (result.done) {
          completeWakeRequest(options.db, row.id, result.reason)
          log(`唤醒已投递（${row.summary}）：${result.reason}`)
        } else {
          // **不标记完成** —— 留在队列里等超时回收后重试
          log(`唤醒暂缓（${row.summary}）：${result.reason}`)
        }
        out.push({ id: row.id, result })
      } catch (error) {
        // 一条出问题不该拖垮整轮；**也不标记完成**（等重试）
        log(`唤醒投递异常（${row.summary}）：${String(error).slice(0, 160)}`)
        out.push({ id: row.id, result: { done: false, reason: `投递异常：${String(error).slice(0, 120)}` } })
      }
    }
    return out
  }

  const handle = setIntervalFn(() => {
    // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环，
    // 唤醒从此失效而没人知道
    void tick().catch((error: unknown) => {
      atLevel(log, 'fault')(`唤醒轮询 tick 异常：${String(error).slice(0, 200)}`)
    })
  }, intervalMs)
  handle.unref?.()
  log(`唤醒轮询器已启动：每 ${String(intervalMs)}ms 认领一次（claimer=${options.claimer}）`)

  return { tick, stop: () => clearIntervalFn(handle) }
}
