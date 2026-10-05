/**
 * 唤醒条件矩阵（EXECUTION_PLAN §2.17.2，规则按用户拍板）。
 *
 * ## 核心设计：**每个条件互相独立，不派生**
 *
 * 用户明确要求："直接把每个唤醒条件拆分为独立的开关/概率调节器，不再设置关系等级"，
 * 并特别强调 `@全体成员` **另外算**（默认 50%），与 `@我`（100%）分开。
 * 所以这里没有任何"等级/关系"推导 —— 每个 `(scope, condition)` 一行规则，各判各的。
 *
 * ## 默认值（用户拍板，写进保真度基线）
 *
 * | 条件 | 默认 |
 * | :--- | :--- |
 * | 群聊里任何消息（`group_message_any`） | **完全关**（默认群聊零唤醒） |
 * | `@我`（`group_mention`） | 100% |
 * | `@全体成员`（`group_mention_all`） | **50%，独立算** |
 * | 拍一拍（`group_poke`） | 100% |
 * | 私聊（`private_message`） | 80% |
 * | 临时会话（`temp_message`） | 20% |
 *
 * ## 判定顺序（很重要）
 *
 * 关闭 → 静默期 → 频率/日限 → 概率 → 全局预算。顺序决定了"为什么没唤醒"的归因，
 * 每次判定都写 `wake_events`，面板与排障全靠它。
 *
 * @module @forlife/gateway/wake
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { nowIso } from '@forlife/store'

/** 全部唤醒条件（与基线 `wake.rules.*` 一一对应）。 */
export const WAKE_CONDITIONS = [
  'private_message',
  'temp_message',
  'group_message_any',
  'group_mention',
  'group_mention_all',
  'group_poke',
  'reply_to_me',
  'peer_input_status',
  'peer_status_change',
  'media_received',
  'file_received',
  'bot_offline',
  'message_recalled',
  'external_request',
  'self_message_sent',
] as const

/** 唤醒条件。 */
export type WakeCondition = (typeof WAKE_CONDITIONS)[number]

/** 一条唤醒规则。 */
export interface WakeRule {
  readonly scope: string
  readonly condition: WakeCondition
  readonly enabled: boolean
  readonly probability: number
  readonly minIntervalMs: number
  readonly dailyLimit: number
  readonly quietUntil: string | null
  readonly updatedBy: 'system' | 'model' | 'admin'
  readonly updatedAt: string
}

/** 判定结果的原因码。 */
export type WakeReason =
  | 'matched'
  | 'disabled'
  | 'quiet_hours'
  | 'daily_limit'
  | 'min_interval'
  | 'probability'
  | 'budget'

/** 判定结果。 */
export interface WakeVerdict {
  readonly decision: 'wake' | 'skip'
  readonly reason: WakeReason
  readonly condition: WakeCondition
  readonly scope: string
  /** 命中的规则（含概率），便于解释。 */
  readonly rule: WakeRule
  /** 概率判定用的随机数（可复算，排障用）。 */
  readonly roll?: number
}

/** 判定请求。 */
export interface WakeRequest {
  /** 规则作用域：`*` 全局，`private:<id>` / `group:<id>` 覆盖。 */
  readonly scope: string
  readonly condition: WakeCondition
  readonly conversationKey: string
  /** 被判定消息的摘要（跳过时进待读池）。 */
  readonly summary?: string
  readonly senderName?: string
}

/** 每次判定都要留痕，这里对上账。 */
export interface WakeDecisionOptions {
  readonly now?: Date
  /** 注入随机数（测试用固定序列）。 */
  readonly random?: () => number
  /** 全局预算覆盖（测试用）。 */
  readonly budget?: { readonly globalPerHour: number; readonly globalPerDay: number }
}

/** 从保真度基线取默认规则（保证与文档一比一）。 */
export function defaultWakeRules(): readonly Omit<WakeRule, 'scope' | 'quietUntil' | 'updatedAt'>[] {
  const read = (name: WakeCondition): { enabled: boolean; probability: number } => {
    const key = `wake.rules.${camel(name)}`
    return defaultFor<{ enabled: boolean; probability: number }>(key)
  }
  return WAKE_CONDITIONS.map((condition) => {
    const value = read(condition)
    return {
      condition,
      enabled: value.enabled,
      probability: value.probability,
      minIntervalMs: 0,
      dailyLimit: 0,
      updatedBy: 'system' as const,
    }
  })
}

/** `group_mention_all` → `groupMentionAll`。 */
function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase())
}

/**
 * 播种默认规则（幂等：已有规则不覆盖）。
 *
 * @param db - 数据库。
 * @returns 本次新增的规则数。
 */
export function seedWakeRules(db: DatabaseSync): number {
  let inserted = 0
  const statement = db.prepare(
    `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until, updated_by, updated_at)
     VALUES ('*', ?, ?, ?, ?, ?, NULL, 'system', ?)
     ON CONFLICT(scope, condition) DO NOTHING`,
  )
  const at = nowIso()
  for (const rule of defaultWakeRules()) {
    inserted += Number(statement.run(rule.condition, rule.enabled ? 1 : 0, rule.probability, rule.minIntervalMs, rule.dailyLimit, at).changes)
  }
  return inserted
}

/** 读一条规则（先查精确作用域，再回落到 `*`）。 */
export function resolveWakeRule(db: DatabaseSync, scope: string, condition: WakeCondition): WakeRule {
  const read = (target: string): WakeRule | undefined => {
    const row = db.prepare('SELECT * FROM wake_rules WHERE scope = ? AND condition = ?').get(target, condition) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) return undefined
    return {
      scope: String(row['scope']),
      condition,
      enabled: Number(row['enabled']) === 1,
      probability: Number(row['probability']),
      minIntervalMs: Number(row['min_interval_ms']),
      dailyLimit: Number(row['daily_limit']),
      quietUntil: row['quiet_until'] === null ? null : String(row['quiet_until']),
      updatedBy: String(row['updated_by']) as WakeRule['updatedBy'],
      updatedAt: String(row['updated_at']),
    }
  }
  const exact = read(scope)
  if (exact !== undefined) return exact
  const global = read('*')
  if (global !== undefined) return global
  // 兜底：表没播种时用基线默认值（保证"零配置也能按文档工作"）
  const fallback = defaultWakeRules().find((r) => r.condition === condition)
  return {
    scope: '*',
    condition,
    enabled: fallback?.enabled ?? true,
    probability: fallback?.probability ?? 100,
    minIntervalMs: 0,
    dailyLimit: 0,
    quietUntil: null,
    updatedBy: 'system',
    updatedAt: nowIso(),
  }
}

/** 列出规则（可按作用域过滤；含继承来的全局规则）。 */
export function listWakeRules(db: DatabaseSync, scope?: string): readonly WakeRule[] {
  return WAKE_CONDITIONS.map((condition) => resolveWakeRule(db, scope ?? '*', condition))
}

/**
 * 修改一条规则（模型自调 / 后台调节都走这里）。
 *
 * @param db - 数据库。
 * @param scope - 作用域。
 * @param condition - 条件。
 * @param patch - 要改的字段。
 * @param updatedBy - 谁改的（进审计与面板）。
 * @returns 修改后的规则。
 */
export function setWakeRule(
  db: DatabaseSync,
  scope: string,
  condition: WakeCondition,
  patch: Partial<Pick<WakeRule, 'enabled' | 'probability' | 'minIntervalMs' | 'dailyLimit' | 'quietUntil'>>,
  updatedBy: 'system' | 'model' | 'admin' = 'model',
): WakeRule {
  const current = resolveWakeRule(db, scope, condition)
  const next = {
    enabled: patch.enabled ?? current.enabled,
    probability: Math.max(0, Math.min(100, patch.probability ?? current.probability)),
    minIntervalMs: Math.max(0, patch.minIntervalMs ?? current.minIntervalMs),
    dailyLimit: Math.max(0, patch.dailyLimit ?? current.dailyLimit),
    quietUntil: patch.quietUntil === undefined ? current.quietUntil : patch.quietUntil,
  }
  db.prepare(
    `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, condition) DO UPDATE SET
       enabled = excluded.enabled, probability = excluded.probability,
       min_interval_ms = excluded.min_interval_ms, daily_limit = excluded.daily_limit,
       quiet_until = excluded.quiet_until, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(
    scope,
    condition,
    next.enabled ? 1 : 0,
    next.probability,
    next.minIntervalMs,
    next.dailyLimit,
    next.quietUntil,
    updatedBy,
    nowIso(),
  )
  return resolveWakeRule(db, scope, condition)
}

/** 统计某规则近期唤醒次数（用于日限与最小间隔）。 */
function recentWakes(db: DatabaseSync, scope: string, condition: WakeCondition, sinceIso: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM wake_events WHERE scope = ? AND condition = ? AND decision = 'wake' AND at >= ?")
    .get(scope, condition, sinceIso) as { n: number }
  return row.n
}

/** 全局唤醒预算检查（§2.14.5）。 */
function budgetExceeded(db: DatabaseSync, at: Date, budget: { globalPerHour: number; globalPerDay: number }): boolean {
  const hourAgo = new Date(at.getTime() - 3600_000).toISOString()
  const dayAgo = new Date(at.getTime() - 86_400_000).toISOString()
  const hour = db.prepare("SELECT count(*) AS n FROM wake_events WHERE decision = 'wake' AND at >= ?").get(hourAgo) as { n: number }
  if (hour.n >= budget.globalPerHour) return true
  const day = db.prepare("SELECT count(*) AS n FROM wake_events WHERE decision = 'wake' AND at >= ?").get(dayAgo) as { n: number }
  return day.n >= budget.globalPerDay
}

/**
 * 判定一次唤醒（并在 `wake_events` 留痕；跳过时把摘要放进待读池）。
 *
 * @param db - 数据库。
 * @param request - 判定请求。
 * @param options - 时钟与随机数注入。
 * @returns 判定结果。
 */
export function decideWake(db: DatabaseSync, request: WakeRequest, options: WakeDecisionOptions = {}): WakeVerdict {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const at = now.toISOString()
  const budget = options.budget ?? {
    globalPerHour: defaultFor<number>('wake.budget.globalPerHour'),
    globalPerDay: defaultFor<number>('wake.budget.globalPerDay'),
  }

  const rule = resolveWakeRule(db, request.scope, request.condition)
  const finish = (decision: 'wake' | 'skip', reason: WakeReason, roll?: number): WakeVerdict => {
    db.prepare(
      `INSERT INTO wake_events (id, scope, condition, conversation_key, decision, reason, roll, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), request.scope, request.condition, request.conversationKey, decision, reason, roll ?? null, at)
    if (decision === 'skip' && request.summary !== undefined) {
      recordPending(db, {
        scope: request.scope,
        conversationKey: request.conversationKey,
        summary: request.summary,
        ...(request.senderName === undefined ? {} : { senderName: request.senderName }),
        at,
      })
    }
    return { decision, reason, condition: request.condition, scope: request.scope, rule, ...(roll === undefined ? {} : { roll }) }
  }

  // ① 开关（默认群聊零唤醒就靠这里）
  if (!rule.enabled || rule.probability === 0) return finish('skip', 'disabled')

  // ② 静默期
  if (rule.quietUntil !== null && rule.quietUntil > at) return finish('skip', 'quiet_hours')

  // ③ 日限
  if (rule.dailyLimit > 0) {
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString()
    if (recentWakes(db, request.scope, request.condition, dayAgo) >= rule.dailyLimit) return finish('skip', 'daily_limit')
  }

  // ④ 最小间隔
  if (rule.minIntervalMs > 0) {
    const last = db
      .prepare("SELECT at FROM wake_events WHERE scope = ? AND condition = ? AND decision = 'wake' ORDER BY at DESC LIMIT 1")
      .get(request.scope, request.condition) as { at: string } | undefined
    if (last !== undefined && now.getTime() - Date.parse(last.at) < rule.minIntervalMs) return finish('skip', 'min_interval')
  }

  // ⑤ 概率
  const roll = random() * 100
  if (roll >= rule.probability) return finish('skip', 'probability', roll)

  // ⑥ 全局预算（概率过了也要看预算，避免一天被叫醒几百次）
  if (budgetExceeded(db, now, budget)) return finish('skip', 'budget', roll)

  return finish('wake', 'matched', roll)
}

// ── 待读池（§2.17.3）────────────────────────────────────────────────────────

/** 池容量与窗口（来自基线，超限时删最旧的）。 */
function pendingLimits(): { perScope: number; windowHours: number } {
  return {
    perScope: defaultFor<number>('wake.pending.perScope'),
    windowHours: defaultFor<number>('wake.pending.windowHours'),
  }
}

/** 记一条待读（跳过唤醒时自动调用，也可手动）。 */
export function recordPending(
  db: DatabaseSync,
  input: { readonly scope: string; readonly conversationKey: string; readonly summary: string; readonly senderName?: string; readonly at?: string },
): void {
  const { perScope } = pendingLimits()
  const at = input.at ?? nowIso()
  db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
  ).run(randomUUID(), input.scope, input.conversationKey, input.senderName ?? null, input.summary, at)

  // 有界：超出容量就删该 scope 最旧的（未读优先保留？不 —— 最旧的先走，宁可丢陈旧的）
  const count = db.prepare('SELECT count(*) AS n FROM pending_messages WHERE scope = ?').get(input.scope) as { n: number }
  if (count.n > perScope) {
    db.prepare(
      `DELETE FROM pending_messages WHERE id IN (
         SELECT id FROM pending_messages WHERE scope = ? ORDER BY at ASC LIMIT ?
       )`,
    ).run(input.scope, count.n - perScope)
  }
}

/** 待读条目。 */
export interface PendingItem {
  readonly id: string
  readonly scope: string
  readonly conversationKey: string
  readonly senderName: string | null
  readonly summary: string
  readonly at: string
}

/**
 * 主动读待读池（模型调 `read_pending` 时用）。
 *
 * @param db - 数据库。
 * @param options - 范围、条数与是否标记已读。
 * @returns 待读条目（按时间升序，保证阅读顺序）。
 */
export function readPending(
  db: DatabaseSync,
  options: { readonly scope?: string; readonly limit?: number; readonly markRead?: boolean } = {},
): readonly PendingItem[] {
  const limit = options.limit ?? 20
  const rows = (
    options.scope === undefined
      ? db.prepare('SELECT * FROM pending_messages WHERE read = 0 ORDER BY at ASC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM pending_messages WHERE read = 0 AND scope = ? ORDER BY at ASC LIMIT ?').all(options.scope, limit)
  ) as unknown as Record<string, unknown>[]

  const items = rows.map((row) => ({
    id: String(row['id']),
    scope: String(row['scope']),
    conversationKey: String(row['conversation_key']),
    senderName: row['sender_name'] === null ? null : String(row['sender_name']),
    summary: String(row['summary']),
    at: String(row['at']),
  }))

  if (options.markRead !== false && items.length > 0) {
    const statement = db.prepare('UPDATE pending_messages SET read = 1, read_at = ? WHERE id = ?')
    const at = nowIso()
    for (const item of items) statement.run(at, item.id)
  }
  return items
}

/** 待读池统计（面板用）。 */
export function pendingStats(db: DatabaseSync): { readonly unread: number; readonly total: number } {
  const unread = db.prepare('SELECT count(*) AS n FROM pending_messages WHERE read = 0').get() as { n: number }
  const total = db.prepare('SELECT count(*) AS n FROM pending_messages').get() as { n: number }
  return { unread: unread.n, total: total.n }
}
