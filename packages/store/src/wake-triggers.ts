/**
 * 唤醒触发器的存储层 + **六道闸**的判定（PLAN 阶段 8 交付物 1 与 5）。
 *
 * ## 六道闸为什么必须在这里，而且必须**各自可区分**
 *
 * PLAN 要求六道闸：预算、静默期、合并窗口、级联深度、过期、幂等。
 * 它们防的是**不同的事**，所以判定结果**不能压成一个布尔**：
 *
 * | 闸 | 防什么 | 被它拦下时用户该知道什么 |
 * |---|---|---|
 * | 静默期 | 半夜被吵醒 | "我设了静默期，所以没叫你" |
 * | 预算 | 悄悄烧钱 | "这个触发器这轮的钱用完了" |
 * | 合并窗口 | 高频触发刷屏 | "这段时间有 7 次触发，合并成一次" |
 * | 级联深度 | **自激循环**（唤醒→干活→又唤醒自己） | "它自己叫自己超过 3 层了，切断了" |
 * | 过期 | 陈旧任务突然醒来 | "这条已经过期了" |
 * | 幂等 | 重启后重复投递 | "这条已经处理过了" |
 *
 * 压成一个 `fired=false` 的话，用户看到"没醒"却**查不出为什么** ——
 * 而其中"级联深度切断"是他最需要知道的一个（说明模型可能陷进循环了）。
 *
 * ## 为什么判定是**纯函数**
 *
 * 判定要能在没有数据库、没有时钟的情况下被反复测试 ——
 * 六道闸的边界（比如"恰好等于 daily_limit 算不算超"）很容易写错，
 * 而这类错误在真机上表现为"偶尔多醒一次"，**几乎不可能靠观察发现**。
 *
 * @module @forlife/store/wake-triggers
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { getState, setState } from './repository.ts'

/** 触发器类型。 */
export type WakeTriggerKind = 'timer' | 'watcher' | 'system' | 'external'

/** 触发器行。 */
export interface WakeTriggerRow {
  readonly id: string
  readonly kind: string
  readonly scope: string
  readonly title: string
  readonly prompt: string
  readonly spec: string
  readonly enabled: number
  readonly next_fire_at: string | null
  readonly last_fired_at: string | null
  readonly fire_count: number
  readonly min_interval_ms: number
  readonly daily_limit: number
  readonly budget_tokens: number
  readonly quiet_until: string | null
  readonly depth: number
  readonly created_by: string
  readonly created_at: string
  readonly updated_at: string
}

/** 新建触发器的输入。 */
export interface CreateWakeTriggerInput {
  readonly kind: WakeTriggerKind
  readonly scope: string
  readonly title: string
  readonly prompt: string
  /** 规格（会被 JSON.stringify）。 */
  readonly spec: unknown
  readonly createdBy: string
  readonly minIntervalMs?: number
  readonly dailyLimit?: number
  readonly budgetTokens?: number
  readonly nextFireAt?: string | null
  /** 级联深度（由调用链传入，默认 0）。 */
  readonly depth?: number
  readonly now?: Date
}

/** 新建结果。 */
export interface CreateWakeTriggerResult {
  readonly ok: boolean
  readonly reason: string
  readonly row?: WakeTriggerRow
}

/** 级联深度的上限（PLAN 验收明确要求"在级联深度 3 处被切断"）。 */
export const MAX_CASCADE_DEPTH = 3

/** 默认合并窗口：这段时间内同一触发器的多次触发合并成一次。 */
export const DEFAULT_MERGE_WINDOW_MS = 60_000

/** 新建一条触发器。 */
export function createWakeTrigger(db: DatabaseSync, input: CreateWakeTriggerInput): CreateWakeTriggerResult {
  if (input.title.trim() === '') return { ok: false, reason: '标题不能为空' }
  if (input.prompt.trim() === '') {
    // 提示词为空的话，唤醒后模型不知道要做什么 —— 那这次唤醒就是纯浪费
    return { ok: false, reason: 'prompt 不能为空（唤醒后模型要做什么）' }
  }
  if (input.kind === 'timer' && (input.nextFireAt === undefined || input.nextFireAt === null)) {
    return { ok: false, reason: 'timer 触发器必须给 nextFireAt' }
  }

  const now = (input.now ?? new Date()).toISOString()
  const id = `wt_${randomUUID()}`
  db.prepare(
    `INSERT INTO wake_triggers
       (id, kind, scope, title, prompt, spec, enabled, next_fire_at, last_fired_at, fire_count,
        min_interval_ms, daily_limit, budget_tokens, quiet_until, depth, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.scope,
    input.title,
    input.prompt,
    JSON.stringify(input.spec ?? {}),
    input.nextFireAt ?? null,
    // 负数一律夹到 0（0 = 不限）—— 负数会让"是否超限"的比较全部反过来
    Math.max(0, input.minIntervalMs ?? 0),
    Math.max(0, input.dailyLimit ?? 0),
    Math.max(0, input.budgetTokens ?? 0),
    Math.max(0, input.depth ?? 0),
    input.createdBy,
    now,
    now,
  )

  const row = db.prepare('SELECT * FROM wake_triggers WHERE id = ?').get(id) as unknown as WakeTriggerRow
  return { ok: true, reason: '已创建', row }
}

/** 取一条。 */
export function getWakeTrigger(db: DatabaseSync, id: string): WakeTriggerRow | undefined {
  return db.prepare('SELECT * FROM wake_triggers WHERE id = ?').get(id) as unknown as WakeTriggerRow | undefined
}

/** 列出（可按会话过滤）。 */
export function listWakeTriggers(db: DatabaseSync, scope?: string): readonly WakeTriggerRow[] {
  return (
    scope === undefined
      ? db.prepare('SELECT * FROM wake_triggers ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM wake_triggers WHERE scope = ? ORDER BY created_at DESC').all(scope)
  ) as unknown as WakeTriggerRow[]
}

/**
 * 列出**到点该醒**的触发器（**不限制 kind**）。
 *
 * `next_fire_at` 的语义是"下次该醒的时刻"：
 *  - timer 用它排周期；
 *  - 其它类型用它表达"现在就想醒"（`wake_now` 就是这么实现的）。
 *
 * 只看 kind='timer' 的话，对 watcher/system 的"立刻执行"会**静默失效** ——
 * 设了 next_fire_at 但没人看。
 */
export function listDueTriggers(db: DatabaseSync, now: Date = new Date()): readonly WakeTriggerRow[] {
  return db
    .prepare(
      `SELECT * FROM wake_triggers
       WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
       ORDER BY next_fire_at`,
    )
    .all(now.toISOString()) as unknown as WakeTriggerRow[]
}

/** 改字段（只允许这几个，避免调用方随手改 id / created_at）。 */
export function updateWakeTrigger(
  db: DatabaseSync,
  id: string,
  patch: {
    readonly title?: string
    readonly prompt?: string
    readonly enabled?: boolean
    readonly nextFireAt?: string | null
    readonly minIntervalMs?: number
    readonly dailyLimit?: number
    readonly budgetTokens?: number
    readonly quietUntil?: string | null
    readonly depth?: number
  },
  now: Date = new Date(),
): boolean {
  const sets: string[] = []
  const values: unknown[] = []
  const push = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`)
    values.push(value)
  }

  if (patch.title !== undefined) push('title', patch.title)
  if (patch.prompt !== undefined) push('prompt', patch.prompt)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.nextFireAt !== undefined) push('next_fire_at', patch.nextFireAt)
  if (patch.minIntervalMs !== undefined) push('min_interval_ms', Math.max(0, patch.minIntervalMs))
  if (patch.dailyLimit !== undefined) push('daily_limit', Math.max(0, patch.dailyLimit))
  if (patch.budgetTokens !== undefined) push('budget_tokens', Math.max(0, patch.budgetTokens))
  if (patch.quietUntil !== undefined) push('quiet_until', patch.quietUntil)
  if (patch.depth !== undefined) push('depth', Math.max(0, patch.depth))

  if (sets.length === 0) return false
  push('updated_at', now.toISOString())
  values.push(id)

  const result = db.prepare(`UPDATE wake_triggers SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]))
  return Number(result.changes) > 0
}

/** 删除。 */
export function deleteWakeTrigger(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM wake_triggers WHERE id = ?').run(id).changes) > 0
}

/** 记一次触发（更新 last_fired_at / fire_count / next_fire_at）。 */
export function markFired(db: DatabaseSync, id: string, nextFireAt: string | null, at: Date = new Date()): void {
  db.prepare(
    'UPDATE wake_triggers SET last_fired_at = ?, fire_count = fire_count + 1, next_fire_at = ?, updated_at = ? WHERE id = ?',
  ).run(at.toISOString(), nextFireAt, at.toISOString(), id)
}

// ── 六道闸 ───────────────────────────────────────────────────────────

/** 判定结果。 */
export interface GateDecision {
  readonly allow: boolean
  /** 被拦下时的原因码（**必须能区分**，见模块头）。 */
  readonly decision: 'fired' | 'quiet' | 'budget' | 'depth' | 'merged' | 'duplicate' | 'expired' | 'paused'
  readonly reason: string
}

/** 判定的输入（都是**已算好的事实**，不是数据库查询 —— 这样才好测）。 */
export interface GateInput {
  /** 全局暂停开关。 */
  readonly paused: boolean
  /** 静默期截止时间（ISO）；null 表示没有静默期。 */
  readonly quietUntil: string | null
  /** 该触发器**今天**已经触发过几次。 */
  readonly firedToday: number
  readonly dailyLimit: number
  /** 该触发器**这轮**已花的 token。 */
  readonly spentTokens: number
  readonly budgetTokens: number
  /** 上一次触发时间（ISO）。 */
  readonly lastFiredAt: string | null
  readonly minIntervalMs: number
  /** 当前级联深度。 */
  readonly depth: number
  /** 现在。 */
  readonly now: Date
  /** 合并窗口内已经攒了几次（含本次）。 */
  readonly pendingInWindow: number
  readonly mergeWindowMs: number
}

/**
 * 六道闸判定（纯函数）。
 *
 * **顺序是有讲究的**：先判"根本不该醒"（暂停、过期、深度），再判"现在不该醒"
 * （静默期、间隔、合并），最后判"还能不能醒"（预算、日限）。
 * 顺序错了会出现"因为超预算所以没合并"这类奇怪的记录。
 */
export function decideWake(input: GateInput): GateDecision {
  // ① 全局暂停：最高优先级 —— 用户按了暂停就是不想被任何事打扰
  if (input.paused) return { allow: false, decision: 'paused', reason: '全局暂停开关已打开' }

  // ② 级联深度：防自激循环（唤醒 → 干活 → 又唤醒自己）。
  //    这一条要**排在静默期之前**：自激是"系统出问题了"，比"现在不该吵"更严重，
  //    而且被深度切断时用户最需要看到原因。
  if (input.depth >= MAX_CASCADE_DEPTH) {
    return {
      allow: false,
      decision: 'depth',
      reason: `级联深度已达 ${String(input.depth)}（上限 ${String(MAX_CASCADE_DEPTH)}）—— 疑似自激循环，已切断`,
    }
  }

  // ③ 静默期
  if (input.quietUntil !== null && input.now.toISOString() < input.quietUntil) {
    return { allow: false, decision: 'quiet', reason: `静默期到 ${input.quietUntil}` }
  }

  // ④ 最小间隔
  if (input.lastFiredAt !== null && input.minIntervalMs > 0) {
    const elapsed = input.now.getTime() - new Date(input.lastFiredAt).getTime()
    if (elapsed < input.minIntervalMs) {
      return {
        allow: false,
        decision: 'merged',
        reason: `距上次触发仅 ${String(Math.round(elapsed / 1000))} 秒（最小间隔 ${String(Math.round(input.minIntervalMs / 1000))} 秒）`,
      }
    }
  }

  // ⑤ 合并窗口：窗口内多次触发**合并成一次**（不是丢弃 —— 所以 decision 是 merged）
  if (input.mergeWindowMs > 0 && input.pendingInWindow > 1) {
    return {
      allow: false,
      decision: 'merged',
      reason: `合并窗口内有 ${String(input.pendingInWindow)} 次触发，合并为一次`,
    }
  }

  // ⑥ 日限
  //    边界：**恰好等于**上限算超（用 >=）。写成 > 的话，"每天 3 次"实际会醒 4 次，
  //    而这类差一错误几乎不可能靠观察发现。
  if (input.dailyLimit > 0 && input.firedToday >= input.dailyLimit) {
    return {
      allow: false,
      decision: 'budget',
      reason: `今日已触发 ${String(input.firedToday)} 次（上限 ${String(input.dailyLimit)}）`,
    }
  }

  // ⑦ token 预算
  if (input.budgetTokens > 0 && input.spentTokens >= input.budgetTokens) {
    return {
      allow: false,
      decision: 'budget',
      reason: `已花 ${String(input.spentTokens)} tokens（预算 ${String(input.budgetTokens)}）`,
    }
  }

  return { allow: true, decision: 'fired', reason: '允许唤醒' }
}

// ── 唤醒事件 ─────────────────────────────────────────────────────────

/** 记一次唤醒事件。 */
export function recordWakeEvent(
  db: DatabaseSync,
  input: {
    readonly triggerId?: string | null
    readonly kind: string
    readonly decision: string
    readonly reason?: string | undefined
    readonly payload?: string | undefined
    readonly sessionId?: string | undefined
    readonly turnOk?: boolean | undefined
    readonly costTokens?: number | undefined
    readonly modelDid?: string | undefined
    readonly now?: Date
  },
): string {
  const id = `we_${randomUUID()}`
  const at = (input.now ?? new Date()).toISOString()
  db.prepare(
    `INSERT INTO wake_trigger_events
       (id, trigger_id, kind, fired_at, decision, reason, payload, session_id, turn_ok, cost_tokens, model_did, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.triggerId ?? null,
    input.kind,
    at,
    input.decision,
    input.reason ?? null,
    input.payload ?? null,
    input.sessionId ?? null,
    input.turnOk === undefined ? null : input.turnOk ? 1 : 0,
    input.costTokens ?? null,
    input.modelDid ?? null,
    at,
  )
  return id
}

/** 列最近的唤醒事件。 */
export function listWakeEvents(db: DatabaseSync, limit = 50): readonly Record<string, unknown>[] {
  return db.prepare('SELECT * FROM wake_trigger_events ORDER BY fired_at DESC LIMIT ?').all(limit) as unknown as Record<
    string,
    unknown
  >[]
}

/** 数某个触发器**今天**触发过几次（用 UTC 日界，与 ISO 时间戳一致）。 */
export function countFiredToday(db: DatabaseSync, triggerId: string, now: Date = new Date()): number {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const row = db
    .prepare("SELECT COUNT(*) AS v FROM wake_trigger_events WHERE trigger_id = ? AND decision = 'fired' AND fired_at >= ?")
    .get(triggerId, dayStart) as { v: number }
  return row.v
}

/** 全局暂停开关（存在 `forlife_state` 里，与其它设置一致）。 */
export const WAKE_PAUSED_KEY = 'wake.paused'

/** 读全局暂停。 */
/** 全局暂停开关（存在 `forlife_state` 里，与其它设置一致）。 */

/**
 * 读全局暂停。
 *
 * 复用 `getState` —— `forlife_state` 只有 key/value 两列（没有 updated_at），
 * 自己写 SQL 很容易假设出不存在的列。
 */
export function isWakePaused(db: DatabaseSync): boolean {
  return getState(db, WAKE_PAUSED_KEY) === '1'
}

/** 设全局暂停（复用 `setState`，与其它设置走同一条路）。 */
export function setWakePaused(db: DatabaseSync, paused: boolean): void {
  setState(db, WAKE_PAUSED_KEY, paused ? '1' : '0')
}
