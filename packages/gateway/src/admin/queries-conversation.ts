/**
 * 会话子窗口的数据：**一个会话的全部信息**。
 *
 * 用户要求：子窗口要能看到该会话的「所有信息与数据以及配置（例如时区、备注等等信息，
 * 以及 AI 关于它的一些基础印象和画像，这也是辅助记忆手段），以及手动配置点位」。
 *
 * ## 为什么一次全给，而不是让前端拼几个接口
 *
 * 子窗口是一个**整体视图**。分成多个接口的话：
 *  - 面板会出现"一半有数据一半转圈"的中间态，而它恰恰是用户判断
 *    "这个会话到底怎么了"时看的；
 *  - 各部分来自不同时刻的快照，**互相矛盾时无法解释**（比如时区已改但备注还是旧的）。
 * 一次查完，至少保证是**同一个瞬间**的一致视图。
 *
 * @module @forlife/gateway/admin/queries-conversation
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一条唤醒规则（该会话生效的）。 */
export interface ConversationWakeRule {
  readonly scope: string
  readonly condition: string
  readonly enabled: boolean
  readonly probability: number
  readonly minIntervalMs: number
  readonly dailyLimit: number
  /** 这条是**该会话自己的**（scope 等于本会话），还是继承来的全局默认。 */
  readonly own: boolean
}

/** 会话详情。 */
export interface ConversationDetail {
  readonly conversationKey: string
  readonly platform: string
  readonly chatId: string
  readonly kind: string
  readonly title?: string
  readonly lastMessageAt?: string
  readonly createdAt?: string
  readonly counts: {
    readonly inbound: number
    readonly outbound: number
    readonly turns: number
    /** 还没被轮次消费的入站消息数（接管模式下这就是"待人工处理"）。 */
    readonly pendingInbound: number
  }
  /** 时区（来自 `conversation_clock_settings`，缺失表示用系统默认）。 */
  readonly clock?: {
    readonly timezone: string
    readonly hour24: boolean
    readonly source: string
    readonly reason?: string
    readonly updatedAt: string
  }
  readonly note?: string
  readonly impression?: string
  readonly impressionSource?: string
  readonly profileUpdatedAt?: string
  readonly wakeRules: readonly ConversationWakeRule[]
  readonly recentWakeEvents: readonly {
    readonly at: string
    readonly condition: string
    readonly decision: string
    readonly reason?: string
  }[]
}

/** 查一个会话的详情。会话不存在时返回 `undefined`（不是空壳）。 */
export function queryConversation(db: DatabaseSync, conversationKey: string): ConversationDetail | undefined {
  const session = db
    .prepare('SELECT * FROM qq_sessions WHERE conversation_key = ?')
    .get(conversationKey) as
    | {
        conversation_key: string
        platform: string
        chat_id: string
        kind: string
        title: string | null
        last_message_at: string | null
        created_at: string | null
      }
    | undefined
  if (session === undefined) return undefined

  const count = (sql: string, ...params: unknown[]): number =>
    ((db.prepare(sql).get(...(params as never[])) as { v?: number } | undefined)?.v ?? 0)

  // 时区：先看这个会话自己的，再看全局默认（`*`）。
  // 只看会话自己的话，没单独设过的会话会显示"无时区"，而实际是有默认值的 —— 那是误导。
  const clockRow = db
    .prepare(
      `SELECT scope, timezone, hour24, source, reason, updated_at FROM conversation_clock_settings
        WHERE scope = ? OR scope = ?
        ORDER BY CASE WHEN scope = ? THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(conversationKey, '*', conversationKey) as
    | { scope: string; timezone: string; hour24: number; source: string; reason: string | null; updated_at: string }
    | undefined

  const profile = db.prepare('SELECT * FROM conversation_profiles WHERE conversation_key = ?').get(conversationKey) as
    | { note: string | null; impression: string | null; impression_source: string; updated_at: string }
    | undefined

  // 唤醒规则：该会话自己的 + 全局默认。
  // 两样都要给：只看自己的会让人以为"没配过 = 不会唤醒"，
  // 而实际全局默认在生效 —— 那是最容易误判的地方。
  const rules = db
    .prepare(
      `SELECT scope, condition, enabled, probability, min_interval_ms, daily_limit FROM wake_rules
        WHERE scope = ? OR scope = '*'
        ORDER BY CASE WHEN scope = ? THEN 0 ELSE 1 END, condition`,
    )
    .all(conversationKey, conversationKey) as {
    scope: string
    condition: string
    enabled: number
    probability: number
    min_interval_ms: number
    daily_limit: number
  }[]

  const events = db
    .prepare(
      `SELECT at, condition, decision, reason FROM wake_events
        WHERE conversation_key = ? ORDER BY at DESC LIMIT 10`,
    )
    .all(conversationKey) as { at: string; condition: string; decision: string; reason: string | null }[]

  return {
    conversationKey: session.conversation_key,
    platform: session.platform,
    chatId: session.chat_id,
    kind: session.kind,
    ...(session.title === null ? {} : { title: session.title }),
    ...(session.last_message_at === null ? {} : { lastMessageAt: session.last_message_at }),
    ...(session.created_at === null ? {} : { createdAt: session.created_at }),
    counts: {
      inbound: count('SELECT COUNT(*) AS v FROM qq_inbox WHERE conversation_key = ?', conversationKey),
      outbound: count('SELECT COUNT(*) AS v FROM qq_outbox WHERE conversation_key = ?', conversationKey),
      turns: count('SELECT COUNT(*) AS v FROM qq_turns WHERE conversation_key = ?', conversationKey),
      pendingInbound: count('SELECT COUNT(*) AS v FROM qq_inbox WHERE conversation_key = ? AND processed = 0', conversationKey),
    },
    ...(clockRow === undefined
      ? {}
      : {
          clock: {
            timezone: clockRow.timezone,
            hour24: clockRow.hour24 === 1,
            source: clockRow.source,
            ...(clockRow.reason === null ? {} : { reason: clockRow.reason }),
            updatedAt: clockRow.updated_at,
          },
        }),
    ...(profile?.note === null || profile?.note === undefined ? {} : { note: profile.note }),
    ...(profile?.impression === null || profile?.impression === undefined ? {} : { impression: profile.impression }),
    ...(profile === undefined ? {} : { impressionSource: profile.impression_source, profileUpdatedAt: profile.updated_at }),
    wakeRules: rules.map((row) => ({
      scope: row.scope,
      condition: row.condition,
      enabled: row.enabled === 1,
      probability: row.probability,
      minIntervalMs: row.min_interval_ms,
      dailyLimit: row.daily_limit,
      own: row.scope === conversationKey,
    })),
    recentWakeEvents: events.map((row) => ({
      at: row.at,
      condition: row.condition,
      decision: row.decision,
      ...(row.reason === null ? {} : { reason: row.reason }),
    })),
  }
}
