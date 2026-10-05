/**
 * 图片描述缓存与视觉调用计数的持久化（阶段 5 交付物 8）。
 *
 * @module @forlife/store/vision
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一行图片描述。 */
export interface ImageDescriptionRow {
  readonly attachment_id: string
  readonly scene: string
  readonly ocr_text: string | null
  readonly uncertain: string | null
  readonly description: string
  readonly provider: string | null
  readonly model: string | null
  readonly vision_calls: number
  readonly created_at: string
  readonly updated_at: string
}

/** 取一张图的描述。 */
export function getImageDescription(db: DatabaseSync, attachmentId: string): ImageDescriptionRow | undefined {
  return db.prepare('SELECT * FROM image_descriptions WHERE attachment_id = ?').get(attachmentId) as ImageDescriptionRow | undefined
}

/**
 * 写/更新一张图的描述。
 *
 * 重复写同一张图时 `vision_calls` **累加**（它是成本计数器，不是状态位）。
 *
 * @param db - 数据库。
 * @param input - 描述内容。
 */
export function saveImageDescription(
  db: DatabaseSync,
  input: {
    readonly attachmentId: string
    readonly scene: string
    readonly ocrText?: string | null
    readonly uncertain?: string | null
    readonly description: string
    readonly provider?: string | null
    readonly model?: string | null
  },
): void {
  const existing = getImageDescription(db, input.attachmentId)
  const timestamp = nowIso()
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO image_descriptions (attachment_id, scene, ocr_text, uncertain, description, provider, model, vision_calls, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      input.attachmentId,
      input.scene,
      input.ocrText ?? null,
      input.uncertain ?? null,
      input.description,
      input.provider ?? null,
      input.model ?? null,
      timestamp,
      timestamp,
    )
    return
  }
  db.prepare(
    `UPDATE image_descriptions
        SET scene = ?, ocr_text = ?, uncertain = ?, description = ?, provider = ?, model = ?,
            vision_calls = vision_calls + 1, updated_at = ?
      WHERE attachment_id = ?`,
  ).run(
    input.scene,
    input.ocrText ?? null,
    input.uncertain ?? null,
    input.description,
    input.provider ?? null,
    input.model ?? null,
    timestamp,
    input.attachmentId,
  )
}

/** 记一次视觉调用。 */
export function recordVisionCall(
  db: DatabaseSync,
  input: {
    readonly attachmentId: string
    readonly reason: 'bridge' | 'verify-important-fields' | 'tool'
    readonly provider?: string | null
    readonly model?: string | null
    readonly ok?: boolean
    readonly latencyMs?: number
    readonly note?: string | null
  },
): string {
  const id = `vc_${randomUUID()}`
  db.prepare(
    `INSERT INTO vision_call_log (id, at, attachment_id, provider, model, reason, ok, latency_ms, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nowIso(),
    input.attachmentId,
    input.provider ?? null,
    input.model ?? null,
    input.reason,
    input.ok === false ? 0 : 1,
    input.latencyMs ?? null,
    input.note ?? null,
  )
  return id
}

/** 视觉调用统计（面板要显示"这个月为看图花了多少次调用"）。 */
export function visionStats(db: DatabaseSync, sinceHours = 24 * 30): {
  readonly total: number
  readonly byReason: readonly { reason: string; count: number }[]
  readonly failed: number
  readonly avgLatencyMs: number | null
  readonly cachedImages: number
} {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString()
  const total = (db.prepare('SELECT count(*) AS n FROM vision_call_log WHERE at >= ?').get(since) as { n: number }).n
  const byReason = db
    .prepare('SELECT reason, count(*) AS count FROM vision_call_log WHERE at >= ? GROUP BY reason ORDER BY count DESC')
    .all(since) as unknown as { reason: string; count: number }[]
  const failed = (db.prepare('SELECT count(*) AS n FROM vision_call_log WHERE at >= ? AND ok = 0').get(since) as { n: number }).n
  const avg = (db.prepare('SELECT avg(latency_ms) AS v FROM vision_call_log WHERE at >= ? AND latency_ms IS NOT NULL').get(since) as {
    v: number | null
  }).v
  const cachedImages = (db.prepare('SELECT count(*) AS n FROM image_descriptions').get() as { n: number }).n
  return { total, byReason, failed, avgLatencyMs: avg, cachedImages }
}

/** 某张图的调用次数（验收项：第二次应当 0 次新调用）。 */
export function visionCallsFor(db: DatabaseSync, attachmentId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM vision_call_log WHERE attachment_id = ?').get(attachmentId) as { n: number }).n
}

/** 最近一次调用时间（面板显示"最近看图是什么时候"）。 */
export function lastVisionCallAt(db: DatabaseSync): string | undefined {
  const row = db.prepare('SELECT max(at) AS at FROM vision_call_log').get() as { at: string | null }
  return row.at ?? undefined
}
