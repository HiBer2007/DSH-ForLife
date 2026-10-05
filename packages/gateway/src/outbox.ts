/**
 * 动作队列：DSH 进程（工具）与网关进程之间的接缝。
 *
 * ## 为什么用共享 SQLite 而不是 HTTP
 *
 * 工具在 **DSH 进程**里执行，发送在**网关进程**里执行。两者同机、同一个数据卷，
 * 而阶段 1 选 `node:sqlite` + WAL + `busy_timeout` 时就是为了"多进程共享一个库"。
 * 用文件队列的额外好处：**发送意图天然持久化** —— 网关崩了重启后，未发送的动作还在，
 * 不会出现"模型以为发出去了、其实进程崩了没发"这类静默丢失。
 *
 * ## 生命周期
 *
 * ```
 * 工具 qq_reply  → enqueue（pending）→ 轮询等待
 * 网关          → claim（sending）→ transport.send → confirm（sent）/ fail（failed）
 * 工具          → 看到 sent ⇒ {confirmed:true, messageId}；超时 ⇒ {confirmed:false, hint}
 * ```
 *
 * 认领（claim）必须是**原子**的：两个网关进程（或一次重入）不能同时发同一条消息。
 * 这里用条件 UPDATE（`status='pending'` → `'sending'`）配合 `changes` 判断谁抢到了。
 *
 * @module @forlife/gateway/outbox
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

/** 出站动作的种类。 */
export type OutboundKind = 'text' | 'image' | 'file' | 'sticker' | 'notice' | 'mention_all' | 'reaction' | 'input_status' | 'delete'

/** 队列里的一行。 */
export interface OutboxRow {
  readonly id: string
  readonly conversation_key: string
  readonly kind: OutboundKind
  readonly payload: string
  readonly status: 'pending' | 'sending' | 'sent' | 'failed'
  readonly source: 'model' | 'system' | 'admin'
  readonly platform_msg_id: string | null
  readonly confirmed: number
  readonly confirmed_at: string | null
  readonly error: string | null
  readonly attempt: number
  readonly sent_at: string
  readonly claimed_at: string | null
}

/** 入队参数。 */
export interface EnqueueInput {
  readonly conversationKey: string
  readonly kind: OutboundKind
  readonly payload: unknown
  readonly source?: 'model' | 'system' | 'admin'
}

/**
 * 入队一个出站动作。
 *
 * @param db - 共享数据库。
 * @param input - 动作内容。
 * @returns 队列行 id（工具要靠它等确认）。
 */
export function enqueueOutbound(db: DatabaseSync, input: EnqueueInput): string {
  const id = `out_${randomUUID()}`
  db.prepare(
    `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source)
     VALUES (?, ?, NULL, ?, ?, ?, 0, NULL, NULL, 'pending', NULL, 0, ?)`,
  ).run(id, input.conversationKey, input.kind, JSON.stringify(input.payload ?? {}), nowIso(), input.source ?? 'model')
  return id
}

/** 按 id 取一行。 */
export function getOutbound(db: DatabaseSync, id: string): OutboxRow | undefined {
  return db.prepare('SELECT * FROM qq_outbox WHERE id = ?').get(id) as OutboxRow | undefined
}

/**
 * 认领一批待发送动作（原子）。
 *
 * @param db - 数据库。
 * @param options - 批量上限与最大重试次数。
 * @returns 被本次认领的行（只有认领成功的才返回）。
 */
export function claimPendingOutbound(
  db: DatabaseSync,
  options: { readonly limit?: number; readonly maxAttempt?: number } = {},
): readonly OutboxRow[] {
  const limit = options.limit ?? 20
  const maxAttempt = options.maxAttempt ?? 3
  const candidates = db
    .prepare("SELECT id FROM qq_outbox WHERE status = 'pending' AND attempt < ? ORDER BY sent_at ASC LIMIT ?")
    .all(maxAttempt, limit) as unknown as { id: string }[]

  const claimed: OutboxRow[] = []
  const claim = db.prepare("UPDATE qq_outbox SET status = 'sending', claimed_at = ?, attempt = attempt + 1 WHERE id = ? AND status = 'pending'")
  for (const candidate of candidates) {
    // 条件 UPDATE：只有把 pending 改成 sending 成功的那一方才算认领到
    if (Number(claim.run(nowIso(), candidate.id).changes) === 1) {
      const row = getOutbound(db, candidate.id)
      if (row !== undefined) claimed.push(row)
    }
  }
  return claimed
}

/** 标记发送成功（平台已确认，带回平台消息 id）。 */
export function confirmOutbound(db: DatabaseSync, id: string, platformMessageId?: string): void {
  db.prepare(
    `UPDATE qq_outbox SET status = 'sent', confirmed = 1, confirmed_at = ?, platform_msg_id = coalesce(?, platform_msg_id), error = NULL
      WHERE id = ?`,
  ).run(nowIso(), platformMessageId ?? null, id)
}

/**
 * 标记发送失败。
 *
 * 失败是否重试取决于**是否可重试**：网络类失败可以，平台明确拒绝（如风控/无权限）不该反复撞。
 *
 * @param db - 数据库。
 * @param id - 队列行。
 * @param error - 失败原因。
 * @param options - `retryable` 为 true 时退回 pending 等待下次认领。
 */
export function failOutbound(db: DatabaseSync, id: string, error: string, options: { readonly retryable?: boolean } = {}): void {
  if (options.retryable === true) {
    db.prepare("UPDATE qq_outbox SET status = 'pending', error = ? WHERE id = ?").run(error, id)
    return
  }
  db.prepare("UPDATE qq_outbox SET status = 'failed', error = ?, confirmed = 0 WHERE id = ?").run(error, id)
}

/** 把卡在 sending 太久的行退回 pending（网关崩溃后的自愈）。 */
export function reclaimStaleOutbound(db: DatabaseSync, olderThanMs: number, now = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString()
  return Number(
    db
      .prepare("UPDATE qq_outbox SET status = 'pending' WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?)")
      .run(cutoff).changes,
  )
}

/** 等待结果。 */
export interface ConfirmationResult {
  readonly confirmed: boolean
  readonly status: OutboxRow['status']
  readonly messageId?: string
  readonly error?: string
}

/**
 * 等一条动作被确认（§2.17.9 的送达确认窗口）。
 *
 * **超时不是错误**：返回 `confirmed:false` 并带上自助确认手段，由模型自己判断要不要重发。
 * 这正是"模型是主体、工具只是它的手"的体现 —— 工具不替它决定。
 *
 * @param db - 数据库。
 * @param id - 队列行。
 * @param options - 超时与轮询间隔。
 * @returns 确认结果。
 */
export async function waitForConfirmation(
  db: DatabaseSync,
  id: string,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<ConfirmationResult> {
  const timeoutMs = options.timeoutMs ?? 3000
  const pollMs = options.pollMs ?? 50
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const row = getOutbound(db, id)
    if (row === undefined) return { confirmed: false, status: 'failed', error: '队列里找不到该动作（可能已被清理）' }
    if (row.status === 'sent') {
      return { confirmed: true, status: 'sent', ...(row.platform_msg_id === null ? {} : { messageId: row.platform_msg_id }) }
    }
    if (row.status === 'failed') {
      return { confirmed: false, status: 'failed', ...(row.error === null ? {} : { error: row.error }) }
    }
    if (Date.now() >= deadline) {
      return {
        confirmed: false,
        status: row.status,
        error: `已提交但未在 ${String(timeoutMs)}ms 内收到送达确认（当前状态 ${row.status}）`,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** 队列统计（面板用）。 */
export function outboxStats(db: DatabaseSync): {
  readonly pending: number
  readonly sending: number
  readonly sent: number
  readonly failed: number
} {
  const rows = db.prepare('SELECT status, count(*) AS n FROM qq_outbox GROUP BY status').all() as unknown as {
    status: string
    n: number
  }[]
  const get = (status: string): number => rows.find((r) => r.status === status)?.n ?? 0
  return { pending: get('pending'), sending: get('sending'), sent: get('sent'), failed: get('failed') }
}

/** 列最近的出站记录（面板用）。 */
export function listOutbound(db: DatabaseSync, limit = 50): readonly OutboxRow[] {
  return db.prepare('SELECT * FROM qq_outbox ORDER BY sent_at DESC LIMIT ?').all(limit) as unknown as OutboxRow[]
}
