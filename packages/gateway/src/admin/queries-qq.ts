/**
 * 「会话与队列」与「唤醒」两块管理面板的**只读**查询。
 *
 * ## 为什么是纯函数 + 直接读 SQLite
 *
 * 面板要的是"此刻库里是什么样"，不是"网关内存里以为是什么样"：网关可能刚重启、
 * 可能根本没接管 QQ 连接，而 SQLite 是唯一真源（与 DSH 内嵌面板读的是同一个文件）。
 * 所以这里不做缓存、不订阅事件，进来就查、查完就返回；调用方拿到的是**快照**，
 * 一秒后过期也无所谓 —— 面板每次刷新都会重新调。
 *
 * 两条纪律：
 *  - **列名以真实 schema 为准**（见 `packages/store/src/migrations.ts` 的迁移 5/6/7），
 *    不按文档简写猜名字（例如 `wake_events` 里判定结果叫 `decision` 而不是 `verdict`）；
 *  - **一次查询拿一屏数据**，绝不在循环里查库（N+1 会让一个面板把连接池打满）。
 *
 * @module @forlife/gateway/admin/queries-qq
 */
import type { DatabaseSync } from 'node:sqlite'

/** 会话/队列/轮次/待读池的默认页大小。 */
const DEFAULT_LIMIT = 50
/** 出站记录的默认页大小：面板上它是"最近动作"，一屏 30 条就够，翻更多没有信息量。 */
const DEFAULT_OUTBOX_LIMIT = 30
/** 唤醒判定留痕的默认页大小。 */
const DEFAULT_WAKE_EVENT_LIMIT = 100
/** 页大小硬上限：面板一次最多看这么多行，防止前端传个 10 万把 JSON 撑爆。 */
const MAX_LIMIT = 200
/** 判定留痕的硬上限（它比其它表增长快得多，单页给宽一点）。 */
const MAX_WAKE_EVENT_LIMIT = 500

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 一个会话（`qq_sessions` 一行 + 该会话未处理的入站条数）。 */
export interface ConversationSession {
  readonly conversationKey: string
  readonly platform: string
  readonly chatId: string
  /** `private` | `group` | `temp`。 */
  readonly kind: string
  readonly title?: string
  readonly lastMessageAt?: string
  /** 该会话在 `qq_inbox` 里 `processed = 0` 的条数。 */
  readonly unread: number
}

/** 入站队列里的一条消息。 */
export interface InboxItem {
  readonly id: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly text: string
  /** 事件时间（平台侧）。 */
  readonly at: string
  /** 落库时间（本地侧）；与 `at` 的差就是"消息在路上花了多久"。 */
  readonly receivedAt: string
  readonly processed: boolean
  readonly attempt: number
  readonly error?: string
  /** `image` | `file`；纯文本消息没有。 */
  readonly mediaKind?: string
}

/** 队列计数。 */
export interface QueueStats {
  readonly pending: number
  readonly total: number
  readonly failed: number
}

/** 一轮（`qq_turns` 一行）。 */
export interface TurnItem {
  readonly id: string
  readonly conversationKey: string
  /** 取值域由迁移 5 的列注释钉死。 */
  readonly status: 'running' | 'done' | 'failed' | 'deferred'
  readonly startedAt: string
  readonly endedAt?: string
  readonly model?: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly toolCalls: number
  readonly deferReason?: string
  readonly error?: string
}

/** 轮次计数。 */
export interface TurnStats {
  readonly running: number
  readonly done: number
  readonly failed: number
  readonly deferred: number
  /** **只统计有 `ended_at` 的轮次**；一条都没有时是整个字段缺失，而不是 0。 */
  readonly avgDurationMs?: number
}

/** 出站记录（`qq_outbox` 一行）。 */
export interface OutboxItem {
  readonly id: string
  readonly conversationKey: string
  /** `text` | `image` | `file` | `sticker` | `notice` | `mention_all` | ... */
  readonly kind: string
  /** `pending`（等认领）| `sending` | `sent` | `failed`，见迁移 6。 */
  readonly status: 'pending' | 'sending' | 'sent' | 'failed'
  readonly attempt: number
  readonly sentAt: string
  readonly confirmed: boolean
  readonly error?: string
}

/** 出站计数。 */
export interface OutboxStats {
  readonly pending: number
  readonly failed: number
  readonly confirmed: number
}

/** 有界待读池里的一条。 */
export interface PendingItem {
  readonly id: string
  readonly scope: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly summary: string
  readonly at: string
  readonly read: boolean
}

/** 「会话与队列」面板的全部数据。 */
export interface ConversationsOverview {
  readonly sessions: readonly ConversationSession[]
  readonly queue: readonly InboxItem[]
  readonly queueStats: QueueStats
  readonly turns: readonly TurnItem[]
  readonly turnStats: TurnStats
  readonly outbox: readonly OutboxItem[]
  readonly outboxStats: OutboxStats
  readonly pending: readonly PendingItem[]
}

/** 唤醒规则（`wake_rules` 一行；主键是 `(scope, condition)`）。 */
export interface WakeRuleItem {
  /** `'*'` 或 `private:ID` / `group:ID`（具体会话的覆盖）。 */
  readonly scope: string
  readonly condition: string
  readonly enabled: boolean
  /** 0-100。 */
  readonly probability: number
  readonly minIntervalMs: number
  /** 0 = 不限。 */
  readonly dailyLimit: number
  readonly quietUntil?: string
}

/** 分组后的一条条件（同一 condition 在多个 scope 下的合并结果）。 */
export interface WakeGroupRule {
  readonly condition: string
  readonly enabled: boolean
  readonly probability: number
  /** 该条件出现过的所有 scope（含 `'*'`）。 */
  readonly scopes: readonly string[]
}

/** 一个会话类型分组。 */
export interface WakeGroup {
  readonly group: string
  readonly rules: readonly WakeGroupRule[]
}

/** 一次唤醒判定（`wake_events` 一行）。 */
export interface WakeEventItem {
  readonly id: string
  readonly at: string
  readonly scope: string
  readonly condition: string
  /** 真实列名是 `decision`（`wake` | `skip`）；表里**没有** `verdict` 列。 */
  readonly decision: 'wake' | 'skip'
  readonly reason: string
  /** 判定发生在哪个会话（表里可空，旧的/全局判定没有）。 */
  readonly conversationKey?: string
}

/** 唤醒规则计数。 */
export interface WakeStats {
  readonly total: number
  readonly enabled: number
  /** scope 不是 `'*'` 的行数 —— 即"被单独覆盖过的"规则条数。 */
  readonly overridden: number
}

/** 「唤醒」面板的全部数据。 */
export interface WakeOverview {
  readonly rules: readonly WakeRuleItem[]
  readonly groups: readonly WakeGroup[]
  readonly events: readonly WakeEventItem[]
  readonly stats: WakeStats
}

// ── 行类型（与真实建表语句一一对应，NULL 一律标 `| null`）──────────────────

interface SessionRow {
  conversation_key: string
  platform: string
  chat_id: string
  kind: string
  title: string | null
  last_message_at: string | null
}

interface InboxRow {
  id: string
  conversation_key: string
  sender_name: string | null
  text: string
  at: string
  received_at: string
  processed: number
  attempt: number
  error: string | null
  media_kind: string | null
}

interface CountRow {
  total: number | null
  pending: number | null
  failed: number | null
  confirmed?: number | null
}

interface TurnRow {
  id: string
  conversation_key: string
  status: 'running' | 'done' | 'failed' | 'deferred'
  started_at: string
  ended_at: string | null
  model: string | null
  tokens_in: number
  tokens_out: number
  tool_calls: number
  defer_reason: string | null
  error: string | null
}

interface TurnStatsRow {
  running: number | null
  done: number | null
  failed: number | null
  deferred: number | null
  avg_ms: number | null
}

interface OutboxRow {
  id: string
  conversation_key: string
  kind: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempt: number
  sent_at: string
  confirmed: number
  error: string | null
}

interface PendingRow {
  id: string
  scope: string
  conversation_key: string
  sender_name: string | null
  summary: string
  at: string
  read: number
}

interface WakeStatsRow {
  total: number | null
  enabled: number | null
  overridden: number | null
}

interface WakeRuleRow {
  scope: string
  condition: string
  enabled: number
  probability: number
  min_interval_ms: number
  daily_limit: number
  quiet_until: string | null
}

interface WakeEventRow {
  id: string
  at: string
  scope: string
  condition: string
  decision: 'wake' | 'skip'
  reason: string
  conversation_key: string | null
}

// ── 取值小工具 ──────────────────────────────────────────────────────────────

/** 页大小：非法值/缺省走默认，超出上限截断，最小 1（负数不是"全都要"的意思）。 */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** SQLite 的布尔就是 0/1，面板要真 `boolean`（否则模板渲染出 1/0）。 */
function toBool(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && value !== 0
}

/** 可空文本列 → `undefined`：`exactOptionalPropertyTypes` 下不能把 `null` 塞进可选属性。 */
function optionalText(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value
}

/** 聚合结果一律 number（空表时 SUM/AVG 给 NULL，按 0 处理）。 */
function num(value: number | null | undefined): number {
  return value === null || value === undefined ? 0 : value
}

// ── 「会话与队列」───────────────────────────────────────────────────────────

/**
 * 查「会话与队列」面板。
 *
 * @param db - 已迁移的 SQLite 连接（只读使用，本函数不写库）。
 * @param options.limit - 每张列表的页大小；默认 50（出站记录 30），上限 200。
 */
export function queryConversations(db: DatabaseSync, options?: { readonly limit?: number }): ConversationsOverview {
  const limit = clampLimit(options?.limit, DEFAULT_LIMIT, MAX_LIMIT)
  const outboxLimit = clampLimit(options?.limit, DEFAULT_OUTBOX_LIMIT, MAX_LIMIT)

  // ── 会话 ──
  // `last_message_at IS NULL` 参与排序是显式写法：SQLite 里 NULL 最小，
  // `DESC` 本来就把 NULL 排最后，但写出来才不依赖"读者记得这条规则"。
  const sessionRows = db
    .prepare(
      `SELECT conversation_key, platform, chat_id, kind, title, last_message_at
         FROM qq_sessions
        ORDER BY last_message_at IS NULL, last_message_at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as SessionRow[]

  // unread 用**一次** GROUP BY 把全库未处理计数捞进内存 Map，再逐行查表：
  // 页大小最多 200，逐个会话再查一次 qq_inbox 就是 N+1（200 次 prepare+execute），
  // 而 qq_inbox 上有 (processed, conversation_key, at) 索引，一次分组扫描就够。
  // 代价是"顺便数了没上屏的会话"，对一次聚合扫描来说可以忽略。
  const unreadRows = db
    .prepare('SELECT conversation_key, COUNT(*) AS n FROM qq_inbox WHERE processed = 0 GROUP BY conversation_key')
    .all() as unknown as { conversation_key: string; n: number }[]
  const unreadByKey = new Map<string, number>()
  for (const row of unreadRows) unreadByKey.set(row.conversation_key, num(row.n))

  const sessions: ConversationSession[] = sessionRows.map((row) => {
    const title = optionalText(row.title)
    const lastMessageAt = optionalText(row.last_message_at)
    return {
      conversationKey: row.conversation_key,
      platform: row.platform,
      chatId: row.chat_id,
      kind: row.kind,
      ...(title === undefined ? {} : { title }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      unread: unreadByKey.get(row.conversation_key) ?? 0,
    }
  })

  // ── 入站队列 ──
  const queueRows = db
    .prepare(
      `SELECT id, conversation_key, sender_name, text, at, received_at, processed, attempt, error, media_kind
         FROM qq_inbox
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as InboxRow[]

  const queue: InboxItem[] = queueRows.map((row) => {
    const senderName = optionalText(row.sender_name)
    const error = optionalText(row.error)
    const mediaKind = optionalText(row.media_kind)
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      ...(senderName === undefined ? {} : { senderName }),
      text: row.text,
      at: row.at,
      receivedAt: row.received_at,
      processed: toBool(row.processed),
      attempt: num(row.attempt),
      ...(error === undefined ? {} : { error }),
      ...(mediaKind === undefined ? {} : { mediaKind }),
    }
  })

  // 计数用 SQL 的布尔求和（`x = 0` 在 SQLite 里就是 0/1），空表靠 COALESCE 归 0。
  const queueCounts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(processed = 0), 0) AS pending,
              COALESCE(SUM(error IS NOT NULL), 0) AS failed
         FROM qq_inbox`,
    )
    .get() as unknown as CountRow

  // ── 轮次 ──
  const turnRows = db
    .prepare(
      `SELECT id, conversation_key, status, started_at, ended_at, model, tokens_in, tokens_out,
              tool_calls, defer_reason, error
         FROM qq_turns
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as TurnRow[]

  const turns: TurnItem[] = turnRows.map((row) => {
    const endedAt = optionalText(row.ended_at)
    const model = optionalText(row.model)
    const deferReason = optionalText(row.defer_reason)
    const error = optionalText(row.error)
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      status: row.status,
      startedAt: row.started_at,
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(model === undefined ? {} : { model }),
      tokensIn: num(row.tokens_in),
      tokensOut: num(row.tokens_out),
      toolCalls: num(row.tool_calls),
      ...(deferReason === undefined ? {} : { deferReason }),
      ...(error === undefined ? {} : { error }),
    }
  })

  // 平均时长交给 SQL 的 `julianday`：本库时间列统一是 ISO-8601 UTC（带 `Z`），
  // SQLite 的日期函数明确接受 `Z` 时区后缀（已实测 5.5s 的差值算得准）。
  // 放在 SQL 里就不用把整表 ended_at/started_at 搬进 JS —— 那是纯浪费。
  // `CASE ... END` 让没有 ended_at 的行给 NULL，AVG 自动跳过它们（而不是当 0 拉低均值）。
  const turnCounts = db
    .prepare(
      `SELECT COALESCE(SUM(status = 'running'), 0) AS running,
              COALESCE(SUM(status = 'done'), 0) AS done,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(status = 'deferred'), 0) AS deferred,
              AVG(CASE WHEN ended_at IS NOT NULL
                       THEN (julianday(ended_at) - julianday(started_at)) * 86400000.0 END) AS avg_ms
         FROM qq_turns`,
    )
    .get() as unknown as TurnStatsRow

  const avgRaw = turnCounts.avg_ms
  const avgDurationMs = avgRaw === null || avgRaw === undefined ? undefined : Math.round(avgRaw)
  const turnStats: TurnStats = {
    running: num(turnCounts.running),
    done: num(turnCounts.done),
    failed: num(turnCounts.failed),
    deferred: num(turnCounts.deferred),
    ...(avgDurationMs === undefined ? {} : { avgDurationMs }),
  }

  // ── 出站 ──
  const outboxRows = db
    .prepare(
      `SELECT id, conversation_key, kind, status, attempt, sent_at, confirmed, error
         FROM qq_outbox
        ORDER BY sent_at DESC
        LIMIT ?`,
    )
    .all(outboxLimit) as unknown as OutboxRow[]

  const outbox: OutboxItem[] = outboxRows.map((row) => {
    const error = optionalText(row.error)
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      kind: row.kind,
      status: row.status,
      attempt: num(row.attempt),
      sentAt: row.sent_at,
      confirmed: toBool(row.confirmed),
      ...(error === undefined ? {} : { error }),
    }
  })

  // `failed` 只数终态 `status = 'failed'`：重试中的行会被写回 `pending`（同时留着 error），
  // 若按 `error IS NOT NULL` 数，一条最终发送成功的消息会永远躺在"失败"里。
  const outboxCounts = db
    .prepare(
      `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(confirmed = 1), 0) AS confirmed
         FROM qq_outbox`,
    )
    .get() as unknown as CountRow

  // ── 待读池 ──
  const pendingRows = db
    .prepare(
      `SELECT id, scope, conversation_key, sender_name, summary, at, read
         FROM pending_messages
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as PendingRow[]

  const pending: PendingItem[] = pendingRows.map((row) => {
    const senderName = optionalText(row.sender_name)
    return {
      id: row.id,
      scope: row.scope,
      conversationKey: row.conversation_key,
      ...(senderName === undefined ? {} : { senderName }),
      summary: row.summary,
      at: row.at,
      read: toBool(row.read),
    }
  })

  return {
    sessions,
    queue,
    queueStats: { pending: num(queueCounts.pending), total: num(queueCounts.total), failed: num(queueCounts.failed) },
    turns,
    turnStats,
    outbox,
    outboxStats: {
      pending: num(outboxCounts.pending),
      failed: num(outboxCounts.failed),
      confirmed: num(outboxCounts.confirmed),
    },
    pending,
  }
}

// ── 「唤醒」─────────────────────────────────────────────────────────────────

/** 四个分组的固定顺序（面板分区展示；空组也保留，免得前端要处理"这一块今天不存在"）。 */
const WAKE_GROUP_ORDER = ['私聊', '临时会话', '群聊', '不分会话类型'] as const

/**
 * 条件名 → 会话类型分组。
 *
 * 为什么按**前缀**归类而不是硬编码条件清单：`wake_rules.condition` 是开放集合 ——
 * 真库里已经有 `group_message_any`（文档里简写成 `group_message`）、`bot_offline`、
 * `media_received`、`message_recalled` 这些名字。硬编码清单漏掉一个，那个条件就会
 * 掉进兜底组，面板上看起来像"这条规则没人管"。前缀规则对未知条件同样成立：
 * `private_` / `temp_` / `group_` 本身就是私聊 / 临时会话 / 群聊，
 * 其余（状态通道、系统事件、全局条件）本来就跟"在哪说的"无关。
 *
 * 与 `wake.ts` 的 `WAKE_CONDITION_GROUPS` 有一处刻意的差异：那里把 `peer_input_status`
 * 放进"私聊"（它确实只有 C2C 有）；本面板按**消息来源**分组，它是对方正在输入的
 * 状态信号、不是消息，所以归"不分会话类型"。
 */
function wakeGroupOf(condition: string): string {
  if (condition.startsWith('private_')) return '私聊'
  if (condition.startsWith('temp_')) return '临时会话'
  if (condition.startsWith('group_')) return '群聊'
  return '不分会话类型'
}

/** 把规则行合并成四个会话类型分组（归类规则见 `wakeGroupOf`）。 */
function buildWakeGroups(rows: readonly WakeRuleRow[]): WakeGroup[] {
  // 先按 (分组, condition) 聚合：同一个 condition 可能既有 `'*'` 基准行、又有具体会话的覆盖行，
  // 面板要看的是"这个条件整体什么样 + 哪几处配过"，所以合并成一行、scopes 列出全部出处。
  interface Merged {
    condition: string
    /** 基准行（scope = '*'）的取值；没有基准就退回第一条覆盖行。 */
    base: WakeRuleRow
    scopes: string[]
  }
  const byGroup = new Map<string, Map<string, Merged>>()
  for (const row of rows) {
    const group = wakeGroupOf(row.condition)
    const conditions = byGroup.get(group) ?? new Map<string, Merged>()
    byGroup.set(group, conditions)
    const existing = conditions.get(row.condition)
    if (existing === undefined) {
      conditions.set(row.condition, { condition: row.condition, base: row, scopes: [row.scope] })
      continue
    }
    existing.scopes.push(row.scope)
    // 取 `'*'` 行当基准：它是全局默认，具体 scope 是覆盖。展示"整体概率"时，
    // 拿某个具体会话的覆盖值当代表会误导（那个值只对那一个会话成立）。
    if (existing.base.scope !== '*' && row.scope === '*') existing.base = row
  }
  return WAKE_GROUP_ORDER.map((group) => {
    const conditions = byGroup.get(group)
    const rules: WakeGroupRule[] =
      conditions === undefined
        ? []
        : [...conditions.values()].map((merged) => ({
            condition: merged.condition,
            enabled: toBool(merged.base.enabled),
            probability: num(merged.base.probability),
            scopes: merged.scopes,
          }))
    return { group, rules }
  })
}

/**
 * 查「唤醒」面板。
 *
 * `options.scope` **只筛判定留痕**（`events`），规则矩阵与统计始终是全库口径 ——
 * 理由是数据结构本身：`groups` 里每条规则要列出"出现过的所有 scope"（多 scope 合并），
 * `stats.overridden` 要数"有多少条被单独覆盖过"，两者一旦被 scope 过滤就退化成常量、
 * 失去意义。排查某个会话为什么没被唤醒时，看的是它的判定留痕，不是规则矩阵。
 *
 * @param db - 已迁移的 SQLite 连接（只读使用，本函数不写库）。
 * @param options.scope - 只看某个 scope 的判定留痕（如 `group:123`）；缺省看全部。
 * @param options.limit - 判定留痕页大小，默认 100，上限 500。
 */
export function queryWake(
  db: DatabaseSync,
  options?: { readonly scope?: string; readonly limit?: number },
): WakeOverview {
  const limit = clampLimit(options?.limit, DEFAULT_WAKE_EVENT_LIMIT, MAX_WAKE_EVENT_LIMIT)
  const scope = options?.scope

  // 排序按 (scope, condition)：主键就是这两列，面板从上到下顺序稳定，不会每次刷新跳来跳去。
  const ruleRows = db
    .prepare(
      `SELECT scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until
         FROM wake_rules
        ORDER BY scope, condition`,
    )
    .all() as unknown as WakeRuleRow[]

  const rules: WakeRuleItem[] = ruleRows.map((row) => {
    const quietUntil = optionalText(row.quiet_until)
    return {
      scope: row.scope,
      condition: row.condition,
      enabled: toBool(row.enabled),
      probability: num(row.probability),
      minIntervalMs: num(row.min_interval_ms),
      dailyLimit: num(row.daily_limit),
      ...(quietUntil === undefined ? {} : { quietUntil }),
    }
  })

  // 判定留痕：scope 过滤走索引 idx_wake_events_scope (scope, condition, at)。
  const eventSql =
    `SELECT id, at, scope, condition, decision, reason, conversation_key
       FROM wake_events` +
    (scope === undefined ? '' : ' WHERE scope = ?') +
    ' ORDER BY at DESC LIMIT ?'
  const eventParams: (string | number)[] = scope === undefined ? [limit] : [scope, limit]
  const eventRows = db.prepare(eventSql).all(...eventParams) as unknown as WakeEventRow[]

  const events: WakeEventItem[] = eventRows.map((row) => {
    const conversationKey = optionalText(row.conversation_key)
    return {
      id: row.id,
      at: row.at,
      scope: row.scope,
      condition: row.condition,
      // 真实列名是 decision（不是文档里写顺手的 verdict）；`roll`（复算用的随机数）
      // 不对面板开放 —— 它是排障时从库里复算用的，塞进 JSON 只会让人以为面板要靠它。
      decision: row.decision,
      reason: row.reason,
      ...(conversationKey === undefined ? {} : { conversationKey }),
    }
  })

  // 统计固定全库口径（见本函数的 scope 说明）。
  const statsRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(enabled = 1), 0) AS enabled,
              COALESCE(SUM(scope <> '*'), 0) AS overridden
         FROM wake_rules`,
    )
    .get() as unknown as WakeStatsRow

  return {
    rules,
    groups: buildWakeGroups(ruleRows),
    events,
    stats: { total: num(statsRow.total), enabled: num(statsRow.enabled), overridden: num(statsRow.overridden) },
  }
}
