/**
 * 路由表、路由日志与不确定案例的持久化（阶段 5 交付物 5/10）。
 *
 * @module @forlife/store/routing
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

// ── 路由表 ─────────────────────────────────────────────────────────────────

/** 一行路由。 */
export interface ModelRouteRow {
  readonly id: string
  readonly role: string
  readonly rank: number
  readonly provider: string
  readonly model: string
  readonly reasoning_effort: string | null
  readonly enabled: number
  readonly note: string | null
  readonly updated_by: string
  readonly updated_at: string
}

/** 列出全部路由（按 role, rank）。 */
export function listModelRoutes(db: DatabaseSync, role?: string): readonly ModelRouteRow[] {
  return (
    role === undefined
      ? db.prepare('SELECT * FROM model_routes ORDER BY role, rank').all()
      : db.prepare('SELECT * FROM model_routes WHERE role = ? ORDER BY rank').all(role)
  ) as unknown as ModelRouteRow[]
}

/**
 * 写一行路由（按 `(role, rank)` upsert）。
 *
 * @param db - 数据库。
 * @param input - 路由内容。
 * @returns 行 id。
 */
export function upsertModelRoute(
  db: DatabaseSync,
  input: {
    readonly role: string
    readonly rank: number
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string | null
    readonly enabled?: boolean
    readonly note?: string | null
    readonly updatedBy?: string
  },
): string {
  const existing = db.prepare('SELECT id FROM model_routes WHERE role = ? AND rank = ?').get(input.role, input.rank) as
    | { id: string }
    | undefined
  const id = existing?.id ?? `mr_${randomUUID()}`
  db.prepare(
    `INSERT INTO model_routes (id, role, rank, provider, model, reasoning_effort, enabled, note, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(role, rank) DO UPDATE SET
       provider = excluded.provider, model = excluded.model, reasoning_effort = excluded.reasoning_effort,
       enabled = excluded.enabled, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(
    id,
    input.role,
    input.rank,
    input.provider,
    input.model,
    input.reasoningEffort ?? null,
    (input.enabled ?? true) ? 1 : 0,
    input.note ?? null,
    input.updatedBy ?? 'admin',
    nowIso(),
  )
  return id
}

/** 删除某角色某序号的候选（面板删行用）。 */
export function deleteModelRoute(db: DatabaseSync, role: string, rank: number): boolean {
  return Number(db.prepare('DELETE FROM model_routes WHERE role = ? AND rank = ?').run(role, rank).changes) > 0
}

// ── 路由日志 ───────────────────────────────────────────────────────────────

/** 记一条路由决策。 */
export function recordRoutingDecision(
  db: DatabaseSync,
  input: {
    readonly tier: string
    readonly source: string
    readonly rule?: string | null
    readonly backend?: string | null
    readonly confidence: number
    readonly escalated?: boolean
    readonly degraded?: boolean
    readonly degradeReason?: string | null
    readonly latencyMs: number
    readonly provider?: string | null
    readonly model?: string | null
    readonly reasoningEffort?: string | null
    readonly routeRank?: number | null
    readonly skipped?: unknown
    readonly switched?: boolean
    readonly switchReason?: string | null
    readonly sessionId?: string | null
    readonly turnId?: string | null
    readonly note?: string | null
    readonly at?: string
  },
): string {
  const id = `rl_${randomUUID()}`
  db.prepare(
    `INSERT INTO routing_log (id, at, session_id, turn_id, tier, source, rule, backend, confidence, escalated, degraded,
                              degrade_reason, latency_ms, provider, model, reasoning_effort, route_rank, skipped,
                              switched, switch_reason, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.at ?? nowIso(),
    input.sessionId ?? null,
    input.turnId ?? null,
    input.tier,
    input.source,
    input.rule ?? null,
    input.backend ?? null,
    input.confidence,
    input.escalated === true ? 1 : 0,
    input.degraded === true ? 1 : 0,
    input.degradeReason ?? null,
    Math.round(input.latencyMs),
    input.provider ?? null,
    input.model ?? null,
    input.reasoningEffort ?? null,
    input.routeRank ?? null,
    input.skipped === undefined ? null : JSON.stringify(input.skipped),
    input.switched === true ? 1 : 0,
    input.switchReason ?? null,
    input.note ?? null,
  )
  return id
}

/** 最近的路由决策（新的在前）。 */
export function listRoutingLog(db: DatabaseSync, limit = 50): readonly Record<string, unknown>[] {
  return db.prepare('SELECT * FROM routing_log ORDER BY at DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
}

/** 路由统计（面板看"各档位用了多少次、降级率多少"）。 */
export function routingStats(db: DatabaseSync, sinceHours = 24): {
  readonly byTier: readonly { tier: string; count: number; avgLatencyMs: number; degraded: number; escalated: number }[]
  readonly bySource: readonly { source: string; count: number }[]
  readonly degradedRate: number
  readonly total: number
} {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString()
  const byTier = db
    .prepare(
      `SELECT tier, count(*) AS count, avg(latency_ms) AS avgLatencyMs,
              sum(degraded) AS degraded, sum(escalated) AS escalated
         FROM routing_log WHERE at >= ? GROUP BY tier ORDER BY tier`,
    )
    .all(since) as unknown as { tier: string; count: number; avgLatencyMs: number; degraded: number; escalated: number }[]
  const bySource = db
    .prepare('SELECT source, count(*) AS count FROM routing_log WHERE at >= ? GROUP BY source ORDER BY count DESC')
    .all(since) as unknown as { source: string; count: number }[]
  const total = byTier.reduce((sum, row) => sum + row.count, 0)
  const degraded = byTier.reduce((sum, row) => sum + row.degraded, 0)
  return { byTier, bySource, degradedRate: total === 0 ? 0 : degraded / total, total }
}

// ── 不确定案例 ─────────────────────────────────────────────────────────────

/** 记一条不确定案例。 */
export function recordUncertainCase(
  db: DatabaseSync,
  input: { readonly textExcerpt: string; readonly tier: string; readonly confidence: number; readonly backend?: string | null },
): string {
  const id = `uc_${randomUUID()}`
  db.prepare(
    `INSERT INTO uncertain_cases (id, at, text_excerpt, tier, confidence, backend, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, nowIso(), input.textExcerpt.slice(0, 200), input.tier, input.confidence, input.backend ?? null)
  return id
}

/** 待复盘的案例。 */
export function pendingUncertainCases(db: DatabaseSync, limit = 100): readonly Record<string, unknown>[] {
  return db.prepare("SELECT * FROM uncertain_cases WHERE status = 'pending' ORDER BY at ASC LIMIT ?").all(limit) as unknown as Record<
    string,
    unknown
  >[]
}

/** 标记案例已复盘（带结论与建议）。 */
export function markCaseReviewed(db: DatabaseSync, id: string, input: { readonly note: string; readonly suggestion?: string }): void {
  db.prepare("UPDATE uncertain_cases SET status = 'reviewed', review_note = ?, suggestion = ?, reviewed_at = ? WHERE id = ?").run(
    input.note,
    input.suggestion ?? null,
    nowIso(),
    id,
  )
}

/** 案例统计。 */
export function uncertainStats(db: DatabaseSync): { readonly pending: number; readonly reviewed: number } {
  const rows = db.prepare('SELECT status, count(*) AS n FROM uncertain_cases GROUP BY status').all() as unknown as {
    status: string
    n: number
  }[]
  const get = (status: string): number => rows.find((row) => row.status === status)?.n ?? 0
  return { pending: get('pending'), reviewed: get('reviewed') }
}
