/**
 * 三层时区的按会话设置（阶段 4 交付物 8，§2.16）。
 *
 * ## 来源优先级（验收项：`user_set > model_note > 小模型建议`）
 *
 * 这条优先级的意义在于**谁能推翻谁**：
 * 用户明确说的时区最硬；模型推断的次之；小模型建议最软（而且根本不会自动生效）。
 * 所以写入时要比优先级 —— 低优先级不能覆盖高优先级，否则"用户设过"会被后来的推断悄悄改掉。
 *
 * @module @forlife/store/conversation-clocks
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 时区来源（按优先级从高到低）。 */
export const TIMEZONE_SOURCES = ['user_set', 'model_note', 'small_model_suggest', 'default'] as const

/** 时区来源。 */
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number]

/** 来源优先级（数字越小越硬）。 */
export function sourceRank(source: string): number {
  const index = (TIMEZONE_SOURCES as readonly string[]).indexOf(source)
  return index === -1 ? TIMEZONE_SOURCES.length : index
}

/** 一条会话时钟设置。 */
export interface ConversationClock {
  readonly scope: string
  readonly timezone: string
  readonly hour24: boolean
  readonly source: TimezoneSource
  readonly reason: string | null
  readonly updatedBy: string
  readonly updatedAt: string
}

/** 读某会话的时钟设置。 */
export function getConversationClock(db: DatabaseSync, scope: string): ConversationClock | undefined {
  const row = db.prepare('SELECT * FROM conversation_clock_settings WHERE scope = ?').get(scope) as
    | Record<string, unknown>
    | undefined
  if (row === undefined) return undefined
  return {
    scope: String(row['scope']),
    timezone: String(row['timezone']),
    hour24: Number(row['hour24']) === 1,
    source: String(row['source']) as TimezoneSource,
    reason: row['reason'] === null ? null : String(row['reason']),
    updatedBy: String(row['updated_by']),
    updatedAt: String(row['updated_at']),
  }
}

/** 列出全部按会话设置。 */
export function listConversationClocks(db: DatabaseSync): readonly ConversationClock[] {
  return (db.prepare('SELECT * FROM conversation_clock_settings ORDER BY scope').all() as unknown as Record<string, unknown>[]).map(
    (row) => ({
      scope: String(row['scope']),
      timezone: String(row['timezone']),
      hour24: Number(row['hour24']) === 1,
      source: String(row['source']) as TimezoneSource,
      reason: row['reason'] === null ? null : String(row['reason']),
      updatedBy: String(row['updated_by']),
      updatedAt: String(row['updated_at']),
    }),
  )
}

/**
 * 写某会话的时钟设置（带优先级保护）。
 *
 * @param db - 数据库。
 * @param input - 作用域、时区与来源。
 * @returns 是否写入（被更硬的来源挡住时返回 false）。
 */
export function setConversationClock(
  db: DatabaseSync,
  input: {
    readonly scope: string
    readonly timezone: string
    readonly hour24?: boolean
    readonly source: TimezoneSource
    readonly reason?: string
    readonly updatedBy?: string
  },
): boolean {
  const current = getConversationClock(db, input.scope)
  if (current !== undefined && sourceRank(input.source) > sourceRank(current.source)) {
    // 低优先级不能覆盖高优先级：否则"用户设过"会被后来的模型推断悄悄改掉
    return false
  }
  db.prepare(
    `INSERT INTO conversation_clock_settings (scope, timezone, hour24, source, reason, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       timezone = excluded.timezone, hour24 = excluded.hour24, source = excluded.source,
       reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(
    input.scope,
    input.timezone,
    (input.hour24 ?? current?.hour24 ?? true) ? 1 : 0,
    input.source,
    input.reason ?? null,
    input.updatedBy ?? 'model',
    nowIso(),
  )
  return true
}

/** 删除会话设置（回到全局）。 */
export function clearConversationClock(db: DatabaseSync, scope: string): boolean {
  return Number(db.prepare('DELETE FROM conversation_clock_settings WHERE scope = ?').run(scope).changes) > 0
}

// ── 待确认建议 ─────────────────────────────────────────────────────────────

/** 一条待确认建议。 */
export interface ClockSuggestion {
  readonly scope: string
  readonly timezone: string
  readonly confidence: string
  readonly origin: string
  readonly reason: string | null
  readonly createdAt: string
}

/** 写一条待确认建议（**不生效**）。 */
export function setClockSuggestion(
  db: DatabaseSync,
  input: { readonly scope: string; readonly timezone: string; readonly confidence: string; readonly origin: string; readonly reason?: string },
): void {
  db.prepare(
    `INSERT INTO clock_suggestions (scope, timezone, confidence, origin, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       timezone = excluded.timezone, confidence = excluded.confidence,
       origin = excluded.origin, reason = excluded.reason, created_at = excluded.created_at`,
  ).run(input.scope, input.timezone, input.confidence, input.origin, input.reason ?? null, nowIso())
}

/** 读某会话的待确认建议。 */
export function getClockSuggestion(db: DatabaseSync, scope: string): ClockSuggestion | undefined {
  const row = db.prepare('SELECT * FROM clock_suggestions WHERE scope = ?').get(scope) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return {
    scope: String(row['scope']),
    timezone: String(row['timezone']),
    confidence: String(row['confidence']),
    origin: String(row['origin']),
    reason: row['reason'] === null ? null : String(row['reason']),
    createdAt: String(row['created_at']),
  }
}

/** 确认建议（人/高置信度证据把它变成 model_note 或 user_set）。 */
export function acceptClockSuggestion(db: DatabaseSync, scope: string, source: TimezoneSource = 'model_note'): boolean {
  const suggestion = getClockSuggestion(db, scope)
  if (suggestion === undefined) return false
  const applied = setConversationClock(db, {
    scope,
    timezone: suggestion.timezone,
    source,
    reason: `采纳建议（原置信度 ${suggestion.confidence}）`,
  })
  if (applied) db.prepare('DELETE FROM clock_suggestions WHERE scope = ?').run(scope)
  return applied
}

/** 列出全部待确认建议。 */
export function listClockSuggestions(db: DatabaseSync): readonly ClockSuggestion[] {
  return (db.prepare('SELECT * FROM clock_suggestions ORDER BY created_at DESC').all() as unknown as Record<string, unknown>[]).map((row) => ({
    scope: String(row['scope']),
    timezone: String(row['timezone']),
    confidence: String(row['confidence']),
    origin: String(row['origin']),
    reason: row['reason'] === null ? null : String(row['reason']),
    createdAt: String(row['created_at']),
  }))
}
