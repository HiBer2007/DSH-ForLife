/**
 * QQ 侧的两个方向限流：**取消息**与**发消息**。
 *
 * ## 为什么两个方向都要限（用户明确要求）
 *
 * > 「同时在取消息和发消息的位置做出限制就行。」
 *
 * 它们是两类**完全不同**的事故：
 *
 * | 方向 | 不限会怎样 | 谁来管 |
 * | :--- | :--- | :--- |
 * | **取**（把积压读进上下文） | 积压 300 条时模型一口气全读 ⇒ **上下文被撑爆**，本轮直接废掉 | 本模块的取回额度 |
 * | **发**（往 QQ 发消息） | 死循环/话痨把消息连刷出去 ⇒ **QQ 风控**（本项目 QQ 号掉线的已知原因之一） | 本模块的发送额度 + 网关节拍 |
 *
 * ## ★ 两个方向各自限制在哪一层（这是刻意的分工，不是重复）
 *
 * **取**：限制在**工具层**（`read_pending` 每次调用都问一次额度）。
 * 因为"取多少进上下文"只有模型这一侧看得见，网关无从判断。
 *
 * **发**：**拆成两半**：
 *  - **入队侧（工具层）** 限**速率**（每分钟 + 突发窗口）——
 *    超了就**明确告诉模型"被限流了、还有多久"**，而不是把消息默默丢掉。
 *    放这一侧的好处是模型立刻知道，且**不会**写进队列表。
 *  - **投递侧（网关层）** 限**节拍**（两条之间的最小间隔）——
 *    ⚠️ 这一半**不能**放在入队侧：`qq_reply` 的设计就是"多次调用实现分段回复"，
 *    三段回复天然在同一毫秒内入队。在入队处按最小间隔拦，会把**正常的分段回复**打掉。
 *    所以"节奏"必须消失在网关真正调 QQ API 的那一步。
 *
 * ## 计数不用新表
 *
 * - 发送计数读**既有的** `qq_outbox.sent_at`（那一列本来就在，见 `outbox.ts`）；
 * - 取回计数复用**既有的** `forlife_state` 键值表，并且**只用一行**
 *   （`qq_backlog_read` 里存 `{turnId, batches, count}`）——
 *   每个轮次一行会让这张表随轮次数无限长，那是另一种漏水。
 *
 * @module @forlife/gateway/limits
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { getState, setState } from '@forlife/store'

/** 取回额度的判定结果（给工具层直接渲染）。 */
export interface BacklogReadQuota {
  /** 本次是否允许取。 */
  readonly allowed: boolean
  /** 允许取几条（`allowed` 为 false 时是 0）。 */
  readonly granted: number
  /** 单次上限（基线）。 */
  readonly perBatchMax: number
  /** 本轮的批次用量 / 上限。 */
  readonly batchesUsed: number
  readonly batchesMax: number
  /** 本轮的条数用量 / 上限。 */
  readonly countUsed: number
  readonly countMax: number
  /** 人话原因（允许时也说明"还剩多少"，让模型自己规划）。 */
  readonly reason: string
}

/** 取回计数在 `forlife_state` 里的键（**只有这一行**）。 */
const BACKLOG_READ_KEY = 'qq_backlog_read'

/**
 * ★ 不产生**平台可见动作**的出站种类（只读查询）—— 它们**不占**发送额度与投递节拍。
 *
 * ## 为什么必须剔除（审计 §10.6 的"未实测"那一条，这里顺手修掉）
 *
 * `decideSendQuota` / `deliverPacing` 都是按 `qq_outbox` 的行数/时间戳算的，
 * 而 `probe`（取好友列表 / 取合并转发 / 取群成员）**也是这张表里的一行** ——
 * 于是"模型查了三次联系人"会吃掉三次发送额度，表现为
 * **"刚才还能发消息，查了个列表之后突然发不出去了"**，而原因从表象完全看不出来。
 *
 * 判定标准是**"这一行会不会在对方的聊天窗口里产生东西"**：
 *  - `probe` 是只读查询 ⇒ 剔除；
 *  - 其余（含 `delete` / `input_status` / `reaction` / 群公告…）都会真的打到 QQ ⇒ 保留。
 *
 * @module @forlife/gateway/limits
 */
export const NON_SENDING_OUTBOUND_KINDS = ['probe'] as const

/** 拼进 SQL 的白名单片段（值全部来自上面的常量，不存在注入）。 */
const NON_SENDING_SQL = NON_SENDING_OUTBOUND_KINDS.map((kind) => `'${kind}'`).join(', ')

/** 当前 running 轮次的 id（与 `defer_turn` 用的是同一个查询口径）。 */
export function currentTurnId(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT id FROM qq_turns WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() as
    | { id: string }
    | undefined
  return row?.id
}

/** 读本轮的取回计数；轮次换了就**归零**（计数是"本轮"的口径）。 */
function readBacklogCounter(db: DatabaseSync): { readonly turnId: string; readonly batches: number; readonly count: number } {
  const turnId = currentTurnId(db) ?? ''
  const raw = getState(db, BACKLOG_READ_KEY)
  if (raw === undefined || raw === '') return { turnId, batches: 0, count: 0 }
  try {
    const parsed = JSON.parse(raw) as { turnId?: unknown; batches?: unknown; count?: unknown }
    if (typeof parsed.turnId !== 'string' || parsed.turnId !== turnId) return { turnId, batches: 0, count: 0 }
    return {
      turnId,
      batches: typeof parsed.batches === 'number' && Number.isFinite(parsed.batches) ? parsed.batches : 0,
      count: typeof parsed.count === 'number' && Number.isFinite(parsed.count) ? parsed.count : 0,
    }
  } catch {
    // 脏值按"没用过"处理（不抛：读个计数不该让取消息失败）
    return { turnId, batches: 0, count: 0 }
  }
}

/**
 * 判本次能取几条。
 *
 * 三重上限**同时**生效，取最紧的那个：
 *  1. 单次上限 `qq.backlog.readBatchMax`；
 *  2. 本轮批次数 `qq.backlog.readPerTurnBatches`；
 *  3. 本轮总条数 `qq.backlog.readPerTurnMax`。
 *
 * @param db - 数据库。
 * @param options.requested - 模型想取几条（不传按单次上限）。
 * @returns 额度判定。
 */
export function backlogReadQuota(db: DatabaseSync, options: { readonly requested?: number } = {}): BacklogReadQuota {
  const perBatchMax = defaultFor<number>('qq.backlog.readBatchMax')
  const batchesMax = defaultFor<number>('qq.backlog.readPerTurnBatches')
  const countMax = defaultFor<number>('qq.backlog.readPerTurnMax')
  const used = readBacklogCounter(db)
  const base = {
    perBatchMax,
    batchesUsed: used.batches,
    batchesMax,
    countUsed: used.count,
    countMax,
  }

  if (used.batches >= batchesMax) {
    return {
      ...base,
      allowed: false,
      granted: 0,
      reason:
        `本轮已经取回 ${String(used.batches)} 批（上限 ${String(batchesMax)}，基线 qq.backlog.readPerTurnBatches）。` +
        '先把已经取回的处理完再取——一次读太多会把上下文撑爆，反而什么都做不成。',
    }
  }
  const countLeft = Math.max(0, countMax - used.count)
  if (countLeft === 0) {
    return {
      ...base,
      allowed: false,
      granted: 0,
      reason: `本轮取回总量已达上限 ${String(countMax)} 条（基线 qq.backlog.readPerTurnMax）。请先处理已取回的部分。`,
    }
  }
  const requested = options.requested ?? perBatchMax
  const wanted = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : perBatchMax
  const granted = Math.max(1, Math.min(wanted, perBatchMax, countLeft))
  const clamped = granted < wanted
  return {
    ...base,
    allowed: true,
    granted,
    reason: clamped
      ? `本次取 ${String(granted)} 条（你要 ${String(wanted)} 条，被单次上限 ${String(perBatchMax)} 或本轮剩余额度压下来了）。`
      : `本次取 ${String(granted)} 条；本轮还剩 ${String(countLeft - granted)} 条、${String(batchesMax - used.batches - 1)} 批。`,
  }
}

/**
 * 记一次取回（**在真的返回给模型之后**调）。
 *
 * 顺序很重要：先判定、后取、再记账。反过来（先记账再取）会让"取失败"也吃掉额度。
 *
 * @param db - 数据库。
 * @param count - 实际返回了几条。
 */
export function consumeBacklogRead(db: DatabaseSync, count: number): void {
  if (count <= 0) return
  const used = readBacklogCounter(db)
  setState(db, BACKLOG_READ_KEY, JSON.stringify({ turnId: used.turnId, batches: used.batches + 1, count: used.count + count }))
}

/** 发送额度的判定结果。 */
export interface SendQuotaDecision {
  readonly allowed: boolean
  readonly reason: string
  /** 被限流时建议等多久（毫秒）。 */
  readonly retryAfterMs: number
  readonly windowCount: number
  readonly burstCount: number
  readonly perMinuteMax: number
  readonly burstMax: number
}

/**
 * 判现在能不能再发一条（**入队侧**的速率闸门）。
 *
 * 计数口径：`qq_outbox.sent_at`（那一列是**入队时间**）。
 * 用它而不是"真正发出去的时间"是有意的 —— 要防的是"模型一口气刷 N 条"，
 * 而那在入队那一刻就已经发生了（等真发出去再拦，消息已经在队列里排着了）。
 *
 * @param db - 数据库。
 * @param options.now - 注入时钟（测试用）。
 * @returns 判定结果。
 */
export function decideSendQuota(db: DatabaseSync, options: { readonly now?: Date } = {}): SendQuotaDecision {
  const now = options.now ?? new Date()
  const perMinuteMax = defaultFor<number>('qq.send.perMinuteMax')
  const burstMax = defaultFor<number>('qq.send.burstMax')
  const burstWindowMs = defaultFor<number>('qq.send.burstWindowMs')

  const minuteAgo = new Date(now.getTime() - 60_000).toISOString()
  const burstAgo = new Date(now.getTime() - burstWindowMs).toISOString()
  const countSince = (since: string): number => {
    // ★ 只读查询（`probe`）不算"要发的消息"：它们不在任何人聊天窗口里产生东西，
    //   拿它们吃发送额度会让限流表现得毫无道理（见 NON_SENDING_OUTBOUND_KINDS 的说明）。
    const row = db
      .prepare(`SELECT count(*) AS n FROM qq_outbox WHERE sent_at >= ? AND kind NOT IN (${NON_SENDING_SQL})`)
      .get(since) as { n: number }
    return row.n
  }
  const windowCount = countSince(minuteAgo)
  const burstCount = countSince(burstAgo)

  if (burstCount >= burstMax) {
    return {
      allowed: false,
      reason:
        `${String(burstWindowMs / 1000)} 秒内已经有 ${String(burstCount)} 条要发（突发上限 ${String(burstMax)}，基线 qq.send.burstMax）。` +
        '连着刷屏是最容易被 QQ 风控盯上的行为——把要说的话合并成一条，或等一会儿。',
      retryAfterMs: burstWindowMs,
      windowCount,
      burstCount,
      perMinuteMax,
      burstMax,
    }
  }
  if (windowCount >= perMinuteMax) {
    return {
      allowed: false,
      reason: `最近一分钟已经发了 ${String(windowCount)} 条（上限 ${String(perMinuteMax)}，基线 qq.send.perMinuteMax）。请等一分钟再发。`,
      retryAfterMs: 60_000,
      windowCount,
      burstCount,
      perMinuteMax,
      burstMax,
    }
  }
  return {
    allowed: true,
    reason: `最近一分钟 ${String(windowCount)}/${String(perMinuteMax)} 条，突发窗口 ${String(burstCount)}/${String(burstMax)} 条。`,
    retryAfterMs: 0,
    windowCount,
    burstCount,
    perMinuteMax,
    burstMax,
  }
}

/**
 * **投递侧**的节拍判定：距离上一条真正发出去的太近就再等等。
 *
 * ⚠️ 与 {@link decideSendQuota} 是两个不同的闸门，不要合并（理由见模块头）：
 * 那个防"模型刷屏"，这个防"我们以机器速度调 QQ API"。
 *
 * @param db - 数据库。
 * @param options.now - 注入时钟（测试用）。
 * @returns `waitMs > 0` 表示还要等这么久才该发下一条。
 */
export function deliverPacing(db: DatabaseSync, options: { readonly now?: Date } = {}): { readonly waitMs: number; readonly minIntervalMs: number } {
  const now = options.now ?? new Date()
  const minIntervalMs = defaultFor<number>('qq.send.minIntervalMs')
  if (minIntervalMs <= 0) return { waitMs: 0, minIntervalMs }
  const row = db
    .prepare(`SELECT max(confirmed_at) AS at FROM qq_outbox WHERE status = 'sent' AND confirmed_at IS NOT NULL AND kind NOT IN (${NON_SENDING_SQL})`)
    .get() as { at: string | null }
  if (row.at === null) return { waitMs: 0, minIntervalMs }
  const elapsed = now.getTime() - Date.parse(row.at)
  return { waitMs: elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed, minIntervalMs }
}
