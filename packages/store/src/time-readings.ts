/**
 * 时间读数与漂移的持久化（阶段 4 交付物 7/9）。
 *
 * 为什么要**落库**而不只是注入完就算：
 *  ① 验收要求"压缩后/唤醒后/长空闲后都存在一条新鲜读数（年龄 < 30s）"——
 *     不落库就只能靠日志肉眼看；
 *  ② 面板要显示"最新读数年龄"与"注入次数/token 成本"；
 *  ③ `time_drift` 要能画出"时间幻觉随时间的变化"。
 *
 * @module @forlife/store/time-readings
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一条读数记录。 */
export interface TimeReadingRow {
  readonly id: string
  readonly session_id: string | null
  readonly conversation_key: string | null
  readonly at: string
  readonly reason: string
  readonly timezone: string
  readonly text: string
  readonly token_count: number
  readonly created_at: string
}

/** 记一条读数。 */
export function recordTimeReading(
  db: DatabaseSync,
  input: {
    readonly at: string
    readonly reason: string
    readonly timezone: string
    readonly text: string
    readonly tokenCount?: number
    readonly sessionId?: string | null
    readonly conversationKey?: string | null
  },
): string {
  const id = `tr_${randomUUID()}`
  db.prepare(
    `INSERT INTO time_readings (id, session_id, conversation_key, at, reason, timezone, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.conversationKey ?? null,
    input.at,
    input.reason,
    input.timezone,
    input.text,
    input.tokenCount ?? 0,
    nowIso(),
  )
  return id
}

/** 最近一条读数（可限定会话）。 */
export function lastTimeReading(db: DatabaseSync, sessionId?: string): TimeReadingRow | undefined {
  return (
    sessionId === undefined
      ? db.prepare('SELECT * FROM time_readings ORDER BY at DESC LIMIT 1').get()
      : db.prepare('SELECT * FROM time_readings WHERE session_id = ? ORDER BY at DESC LIMIT 1').get(sessionId)
  ) as TimeReadingRow | undefined
}

/** 列最近读数（新的在前）。 */
export function listTimeReadings(db: DatabaseSync, limit = 50): readonly TimeReadingRow[] {
  return db.prepare('SELECT * FROM time_readings ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as unknown as TimeReadingRow[]
}

/** 按原因统计（面板要回答"压缩后到底有没有补读数"）。 */
export function timeReadingStats(db: DatabaseSync): readonly { reason: string; count: number; lastAt: string }[] {
  return db
    .prepare('SELECT reason, count(*) AS count, max(at) AS lastAt FROM time_readings GROUP BY reason ORDER BY count DESC')
    .all() as unknown as { reason: string; count: number; lastAt: string }[]
}

/** 读数总 token 成本（注入是"每轮都花"的开销，必须看得见）。 */
export function timeReadingTokens(db: DatabaseSync): number {
  return (db.prepare('SELECT coalesce(sum(token_count), 0) AS n FROM time_readings').get() as { n: number }).n
}

// ── 漂移遥测 ───────────────────────────────────────────────────────────────

/** 记一次时间漂移。 */
export function recordTimeDrift(
  db: DatabaseSync,
  input: {
    readonly claimed: string
    readonly actualAt: string
    readonly claimedAt?: string | null
    readonly driftMs?: number | null
    readonly severity?: 'info' | 'warn' | 'bad'
    readonly excerpt?: string | null
    readonly sessionId?: string | null
    readonly at?: string
  },
): string {
  const id = `td_${randomUUID()}`
  db.prepare(
    `INSERT INTO time_drift (id, session_id, at, claimed, claimed_at, actual_at, drift_ms, excerpt, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.at ?? nowIso(),
    input.claimed,
    input.claimedAt ?? null,
    input.actualAt,
    input.driftMs ?? null,
    input.excerpt ?? null,
    input.severity ?? 'info',
  )
  return id
}

/** 漂移统计（均值、最大值、按严重度计数）。 */
export function timeDriftStats(db: DatabaseSync): {
  readonly count: number
  readonly avgMs: number | null
  readonly maxMs: number | null
  readonly bySeverity: readonly { severity: string; count: number }[]
} {
  const row = db
    .prepare('SELECT count(*) AS count, avg(abs(coalesce(drift_ms, 0))) AS avgMs, max(abs(coalesce(drift_ms, 0))) AS maxMs FROM time_drift')
    .get() as { count: number; avgMs: number | null; maxMs: number | null }
  const bySeverity = db.prepare('SELECT severity, count(*) AS count FROM time_drift GROUP BY severity').all() as unknown as {
    severity: string
    count: number
  }[]
  return { count: row.count, avgMs: row.avgMs, maxMs: row.maxMs, bySeverity }
}

/** 列最近漂移记录。 */
export function listTimeDrift(db: DatabaseSync, limit = 50): readonly Record<string, unknown>[] {
  return db.prepare('SELECT * FROM time_drift ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
}


