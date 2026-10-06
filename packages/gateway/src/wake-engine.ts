/**
 * Trigger Engine：四类触发器的调度与派发（PLAN 阶段 8 交付物 1）。
 *
 * ## 最需要想清楚的一件事：**错过触发怎么办**
 *
 * 进程停了两小时，期间有 10 个 timer 到点。重启后如果"补醒 10 次"，
 * 用户会被 10 条迟到的消息砸中 —— 而这些事**早就过去了**。
 * 如果"全丢掉"，那"每天 9 点提醒吃药"在机器重启那天就**静默失效**了。
 *
 * 采取的策略是 **补一次、并说明**：
 *  - 错过的 timer **只醒一次**（不是 N 次），payload 里带上"原定 X 点，因停机顺延"；
 *  - 周期性的（every/daily）**推进到下一个未来的点**，而不是把过去的点逐个补完；
 *  - 一次性的（after/at）醒完就停用。
 *
 * 这样"该提醒的没漏"和"不被迟到消息淹没"两件事同时成立。
 *
 * ## 为什么 tick 只做一件事
 *
 * tick 扫"到点的 timer"→ 过六道闸 → 派发。**watcher 不走 tick**
 * （它们是独立的长驻进程，由监督器管，见交付物 3）——
 * 混在一起会让"某次唤醒是谁触发的"变得难以回答。
 *
 * @module @forlife/gateway/wake-engine
 */
import type { DatabaseSync } from 'node:sqlite'

import {
  countFiredToday,
  decideWake,
  DEFAULT_MERGE_WINDOW_MS,
  getWakeTrigger,
  isWakePaused,
  listDueTimers,
  markFired,
  recordWakeEvent,
  type WakeTriggerRow,
} from '@forlife/store'

/** 派发结果（由唤醒桥回报）。 */
export interface DispatchResult {
  readonly ok: boolean
  readonly reason: string
  readonly costTokens?: number
  readonly modelDid?: string
}

/** 派发器：真正去"叫醒模型"的那一层（交付物 2 的桥）。 */
export type WakeDispatcher = (input: {
  readonly trigger: WakeTriggerRow
  readonly reason: string
  readonly payload: Record<string, unknown>
}) => Promise<DispatchResult>

/** 引擎配置。 */
export interface WakeEngineOptions {
  readonly db: DatabaseSync
  readonly dispatch: WakeDispatcher
  readonly log?: (message: string) => void
  /** tick 间隔（默认 1 秒）。 */
  readonly tickMs?: number
  readonly now?: () => Date
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
}

/** 引擎。 */
export interface WakeEngine {
  /** 跑一次 tick（测试直接调它，不用等定时器）。 */
  readonly tick: () => Promise<readonly TickOutcome[]>
  /** 立刻触发一条（`wake_now` 工具、system/external 事件都走它）。 */
  readonly fireNow: (triggerId: string, reason: string, payload?: Record<string, unknown>) => Promise<TickOutcome>
  readonly stop: () => void
}

/** 一次 tick 的结果。 */
export interface TickOutcome {
  readonly triggerId: string
  readonly title: string
  readonly decision: string
  readonly reason: string
}

/** 从 spec 里取"周期"（毫秒）；没有则返回 null（一次性）。 */
export function periodOf(spec: unknown): number | null {
  if (spec === null || typeof spec !== 'object') return null
  const s = spec as Record<string, unknown>
  const everyMs = s['everyMs']
  if (typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs >= 1000) return everyMs
  return null
}

/**
 * 算出**下一次**该触发的时间。
 *
 * 关键：从 `from`（现在是"当前时刻"，不是"上次该触发的时刻"）往后推。
 * 如果从"上次该触发"推，停机期间攒下的每一次都会被算出来，
 * 于是补醒 N 次 —— 正是我们要避免的。
 */
export function nextFireAt(spec: unknown, from: Date): string | null {
  const period = periodOf(spec)
  if (period === null) return null // 一次性：没有下一次
  return new Date(from.getTime() + period).toISOString()
}

/** 造一个引擎。 */
export function createWakeEngine(options: WakeEngineOptions): WakeEngine {
  const { db, dispatch } = options
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})
  const tickMs = options.tickMs ?? 1000

  /** 过闸 + 派发 + 记账（timer 与 fireNow 共用这一段）。 */
  const evaluateAndFire = async (
    trigger: WakeTriggerRow,
    reason: string,
    payload: Record<string, unknown>,
    /** 是否推进 next_fire_at（timer 需要，system/external 不需要）。 */
    advance: boolean,
  ): Promise<TickOutcome> => {
    const at = now()
    const spec = safeParse(trigger.spec)

    const decision = decideWake({
      paused: isWakePaused(db),
      quietUntil: trigger.quiet_until,
      firedToday: countFiredToday(db, trigger.id, at),
      dailyLimit: trigger.daily_limit,
      spentTokens: 0, // token 预算由派发层累计（这里先只判配置）
      budgetTokens: 0,
      lastFiredAt: trigger.last_fired_at,
      minIntervalMs: trigger.min_interval_ms,
      depth: trigger.depth,
      now: at,
      pendingInWindow: 1,
      mergeWindowMs: 0,
    })

    if (!decision.allow) {
      // **被拦下也要留痕**（而且是可区分的原因）—— 否则用户看到"没醒"却查不出为什么
      recordWakeEvent(db, {
        triggerId: trigger.id,
        kind: trigger.kind,
        decision: decision.decision,
        reason: decision.reason,
        now: at,
      })
      // timer 即使被拦，也要推进到下一次 —— 否则它会**卡在过去**，每个 tick 都重试
      if (advance) markFired(db, trigger.id, nextFireAt(spec, at), at)
      return { triggerId: trigger.id, title: trigger.title, decision: decision.decision, reason: decision.reason }
    }

    let result: DispatchResult
    try {
      result = await dispatch({ trigger, reason, payload })
    } catch (error) {
      // 派发抛异常要**接住**：否则一次失败会杀掉整个 tick 循环，唤醒从此静默失效
      result = { ok: false, reason: `派发异常：${String(error).slice(0, 160)}` }
    }

    recordWakeEvent(db, {
      triggerId: trigger.id,
      kind: trigger.kind,
      decision: result.ok ? 'fired' : 'failed',
      reason: result.ok ? reason : result.reason,
      payload: JSON.stringify(payload),
      sessionId: trigger.scope,
      turnOk: result.ok,
      costTokens: result.costTokens,
      modelDid: result.modelDid,
      now: at,
    })

    if (advance) markFired(db, trigger.id, nextFireAt(spec, at), at)
    else markFired(db, trigger.id, trigger.next_fire_at, at)

    log(`唤醒 ${trigger.title}（${trigger.kind}）：${result.ok ? '已派发' : result.reason}`)
    return { triggerId: trigger.id, title: trigger.title, decision: result.ok ? 'fired' : 'failed', reason: result.reason }
  }

  const tick = async (): Promise<readonly TickOutcome[]> => {
    const outcomes: TickOutcome[] = []
    const at = now()

    for (const trigger of listDueTimers(db, at)) {
      const spec = safeParse(trigger.spec)
      // **错过触发的策略**：到这里说明它已经到点（可能迟到很久）。
      // 只醒一次，并把"迟到了多久"写进 payload —— 用户能看出这不是准点提醒。
      const scheduledAt = trigger.next_fire_at
      const lateMs = scheduledAt === null ? 0 : at.getTime() - new Date(scheduledAt).getTime()
      const payload: Record<string, unknown> = {
        scheduledAt,
        firedAt: at.toISOString(),
        ...(lateMs > 60_000 ? { lateByMs: lateMs, lateNote: '原定时间已过（可能是停机顺延），只补一次' } : {}),
      }
      outcomes.push(await evaluateAndFire(trigger, lateMs > 60_000 ? '错过的定时（已顺延）' : '定时到点', payload, true))
    }

    return outcomes
  }

  const fireNow = async (
    triggerId: string,
    reason: string,
    payload: Record<string, unknown> = {},
  ): Promise<TickOutcome> => {
    const trigger = getWakeTrigger(db, triggerId)
    if (trigger === undefined) {
      return { triggerId, title: '(不存在)', decision: 'failed', reason: `没有这条触发器：${triggerId}` }
    }
    // 手动/系统触发**不推进** next_fire_at（它没有"下一次"的概念，或由自己的周期决定）
    return evaluateAndFire(trigger, reason, payload, false)
  }

  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))

  const handle = setIntervalFn(() => {
    // tick 里已经接住了派发异常，这里再兜一层：**定时器里抛异常会静默杀死整个循环**
    void tick().catch((error: unknown) => {
      log(`唤醒 tick 异常：${String(error).slice(0, 200)}`)
    })
  }, tickMs)
  handle.unref?.()

  return {
    tick,
    fireNow,
    stop: () => clearIntervalFn(handle),
  }
}

/** 解析 spec；坏 JSON 返回 `{}`（不抛 —— 一条坏数据不该让整个引擎停摆）。 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 默认合并窗口（导出给上层用，避免两边各写一个数）。 */
export { DEFAULT_MERGE_WINDOW_MS }
