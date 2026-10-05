/**
 * 推理端点的持久化（阶段 5 交付物 2，§2.13.2 末）。
 *
 * @module @forlife/store/endpoints
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一行端点。 */
export interface EndpointRow {
  readonly id: string
  readonly type: string
  readonly mode: string
  readonly backend: string
  readonly base_url: string
  readonly api_key_ref: string | null
  readonly arch: string | null
  readonly deploy_target: string | null
  readonly deploy_host: string | null
  readonly container_name: string | null
  readonly model_root: string | null
  readonly models: string
  readonly limits: string | null
  readonly health_ok: number | null
  readonly health_checked_at: string | null
  readonly health_latency_ms: number | null
  readonly effective_backend: string | null
  readonly health_note: string | null
  readonly enabled: number
  readonly created_at: string
  readonly updated_at: string
}

/** 写入端点的输入。 */
export interface EndpointInput {
  readonly id?: string
  readonly type: string
  readonly mode: string
  readonly backend: string
  readonly baseUrl: string
  /** **只存引用**（如环境变量名或密钥库条目名），绝不存明文。 */
  readonly apiKeyRef?: string | null
  readonly arch?: string | null
  readonly deployTarget?: string | null
  readonly deployHost?: string | null
  readonly containerName?: string | null
  readonly modelRoot?: string | null
  readonly models: readonly Record<string, unknown>[]
  readonly limits?: Record<string, unknown> | null
  readonly enabled?: boolean
}

/**
 * 写一个端点（按 id upsert）。
 *
 * @param db - 数据库。
 * @param input - 端点内容。
 * @returns 端点 id。
 */
export function upsertEndpoint(db: DatabaseSync, input: EndpointInput): string {
  const id = input.id ?? `ep_${randomUUID()}`
  const existing = db.prepare('SELECT id, created_at FROM inference_endpoints WHERE id = ?').get(id) as
    | { id: string; created_at: string }
    | undefined
  const timestamp = nowIso()
  db.prepare(
    `INSERT INTO inference_endpoints (id, type, mode, backend, base_url, api_key_ref, arch, deploy_target, deploy_host,
                                      container_name, model_root, models, limits, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type, mode = excluded.mode, backend = excluded.backend, base_url = excluded.base_url,
       api_key_ref = excluded.api_key_ref, arch = excluded.arch, deploy_target = excluded.deploy_target,
       deploy_host = excluded.deploy_host, container_name = excluded.container_name, model_root = excluded.model_root,
       models = excluded.models, limits = excluded.limits, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(
    id,
    input.type,
    input.mode,
    input.backend,
    input.baseUrl,
    input.apiKeyRef ?? null,
    input.arch ?? null,
    input.deployTarget ?? null,
    input.deployHost ?? null,
    input.containerName ?? null,
    input.modelRoot ?? null,
    JSON.stringify(input.models),
    input.limits === null || input.limits === undefined ? null : JSON.stringify(input.limits),
    (input.enabled ?? true) ? 1 : 0,
    existing?.created_at ?? timestamp,
    timestamp,
  )
  return id
}

/** 列出端点。 */
export function listEndpoints(db: DatabaseSync, options: { readonly enabledOnly?: boolean } = {}): readonly EndpointRow[] {
  return (
    options.enabledOnly === true
      ? db.prepare('SELECT * FROM inference_endpoints WHERE enabled = 1 ORDER BY type, id').all()
      : db.prepare('SELECT * FROM inference_endpoints ORDER BY type, id').all()
  ) as unknown as EndpointRow[]
}

/** 取一个端点。 */
export function getEndpoint(db: DatabaseSync, id: string): EndpointRow | undefined {
  return db.prepare('SELECT * FROM inference_endpoints WHERE id = ?').get(id) as EndpointRow | undefined
}

/** 删除端点。 */
export function deleteEndpoint(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM inference_endpoints WHERE id = ?').run(id).changes) > 0
}

/** 更新健康状态（含**实际生效的后端** —— 有些镜像会静默回落到 CPU）。 */
export function recordEndpointHealth(
  db: DatabaseSync,
  id: string,
  input: { readonly ok: boolean; readonly latencyMs?: number; readonly effectiveBackend?: string; readonly note?: string },
): void {
  db.prepare(
    `UPDATE inference_endpoints
        SET health_ok = ?, health_checked_at = ?, health_latency_ms = ?, effective_backend = ?, health_note = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.ok ? 1 : 0,
    nowIso(),
    input.latencyMs ?? null,
    input.effectiveBackend ?? null,
    input.note ?? null,
    nowIso(),
    id,
  )
}

/** 只改运行模式（模式切换走这条，避免把别的字段一起覆盖）。 */
export function setEndpointMode(db: DatabaseSync, id: string, mode: string): boolean {
  return Number(db.prepare('UPDATE inference_endpoints SET mode = ?, updated_at = ? WHERE id = ?').run(mode, nowIso(), id).changes) > 0
}

// ── 模式切换审计 ───────────────────────────────────────────────────────────

/** 记一次模式切换尝试（**含失败的与幂等跳过的**）。 */
export function recordModeSwitch(
  db: DatabaseSync,
  input: {
    readonly endpointId: string
    readonly from: string
    readonly to: string
    readonly actor: string
    readonly reason: string
    readonly ok: boolean
    readonly note: string
    readonly at?: string
  },
): string {
  const id = `ms_${randomUUID()}`
  db.prepare(
    `INSERT INTO endpoint_mode_audit (id, at, endpoint_id, from_mode, to_mode, actor, reason, ok, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.at ?? nowIso(),
    input.endpointId,
    input.from,
    input.to,
    input.actor,
    input.reason,
    input.ok ? 1 : 0,
    input.note,
  )
  return id
}

/**
 * 最近的模式切换记录。
 *
 * 排序用 `at DESC, rowid DESC`：`at` 只到毫秒，同一毫秒内的多次尝试
 * （重试、连续点击、自动策略连跑）顺序会是**不确定的**。
 * 审计日志的价值就在于"能按顺序读"，所以必须用 `rowid` 做次序兜底。
 */
export function listModeSwitches(db: DatabaseSync, endpointId?: string, limit = 20): readonly Record<string, unknown>[] {
  return (
    endpointId === undefined
      ? db.prepare('SELECT * FROM endpoint_mode_audit ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM endpoint_mode_audit WHERE endpoint_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(endpointId, limit)
  ) as unknown as Record<string, unknown>[]
}

/** 端点目录概览（面板用）。 */
export function endpointOverview(db: DatabaseSync): {
  readonly total: number
  readonly byType: readonly { type: string; count: number }[]
  readonly byMode: readonly { mode: string; count: number }[]
  readonly unhealthy: readonly { id: string; note: string | null }[]
  /** **实际后端与声明后端不一致**的端点（镜像静默回落 CPU 的迹象）。 */
  readonly backendMismatch: readonly { id: string; declared: string; effective: string }[]
} {
  const total = (db.prepare('SELECT count(*) AS n FROM inference_endpoints').get() as { n: number }).n
  const byType = db.prepare('SELECT type, count(*) AS count FROM inference_endpoints GROUP BY type').all() as unknown as {
    type: string
    count: number
  }[]
  const byMode = db.prepare('SELECT mode, count(*) AS count FROM inference_endpoints GROUP BY mode').all() as unknown as {
    mode: string
    count: number
  }[]
  const unhealthy = db
    .prepare('SELECT id, health_note AS note FROM inference_endpoints WHERE health_ok = 0')
    .all() as unknown as { id: string; note: string | null }[]
  const backendMismatch = db
    .prepare(
      `SELECT id, backend AS declared, effective_backend AS effective FROM inference_endpoints
        WHERE effective_backend IS NOT NULL AND effective_backend != backend`,
    )
    .all() as unknown as { id: string; declared: string; effective: string }[]
  return { total, byType, byMode, unhealthy, backendMismatch }
}



