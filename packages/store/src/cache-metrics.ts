/**
 * 缓存用量的持久化（阶段 4 交付物 6）。
 *
 * 数据来源是宿主的 `assistant/message` 会话事件（带 `usage: TokenUsage`），
 * 由组件插件订阅后写进这张表。**两个进程都能读**：网关要把"这轮花了多少"记进轮次记录，
 * 面板要画曲线，将来阶段 9 的运维页也要看。
 *
 * @module @forlife/store/cache-metrics
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一行用量记录。 */
export interface CacheMetricRow {
  readonly id: string
  readonly session_id: string | null
  readonly turn: number | null
  readonly step: number | null
  readonly at: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly reasoning_tokens: number | null
  readonly source: string
  readonly miss_reason: string | null
  readonly note: string | null
}

/** 记一条用量。 */
export function recordCacheUsage(
  db: DatabaseSync,
  input: {
    readonly sessionId?: string | null
    readonly turn?: number | null
    readonly step?: number | null
    readonly at?: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly reasoningTokens?: number
    readonly source?: string
    readonly missReason?: string | null
    readonly note?: string | null
  },
): string {
  const id = `cm_${randomUUID()}`
  db.prepare(
    `INSERT INTO cache_metrics (id, session_id, turn, step, at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, source, miss_reason, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.turn ?? null,
    input.step ?? null,
    input.at ?? nowIso(),
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens ?? 0,
    input.cacheWriteTokens ?? 0,
    input.reasoningTokens ?? null,
    input.source ?? 'session',
    input.missReason ?? null,
    input.note ?? null,
  )
  return id
}

/** 列最近的用量记录（新的在后，便于按时间画曲线）。 */
export function listCacheUsage(db: DatabaseSync, options: { readonly limit?: number; readonly sinceHours?: number } = {}): readonly CacheMetricRow[] {
  const limit = options.limit ?? 200
  const since = new Date(Date.now() - (options.sinceHours ?? 168) * 3600_000).toISOString()
  const rows = db
    // ★ 2026-10-10（`FIX_PLAN.md` §45）：`at` 是**毫秒**精度（`nowIso()` = `toISOString()`），
    //   同一毫秒内写入的多行**并列**，而 `ORDER BY at DESC` 对并列行**不保证顺序**
    //   ⇒ 下面那个 `.reverse()` 之后，"新的在后"就成了**空话**：
    //   面板按时间画的曲线会**点序错乱**，端到端测试也会**偶发红**
    //   （实测：`cache-collector-wiring.test.ts:164` 期望 8192 实得 0 —— 取到了上一行）。
    //   `rowid` 是 SQLite 的**插入序**单调键，本表是普通表（`id TEXT PRIMARY KEY`，
    //   非 `WITHOUT ROWID`）⇒ 有 rowid 可用。
    //   ★ 这也是**本仓库既有的约定**：`endpoints.ts` / `routing.ts` / `time-readings.ts`
    //   的同类查询**全都**写了 `, rowid DESC` —— 只有这里漏了。
    .prepare('SELECT * FROM cache_metrics WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?')
    .all(since, limit) as unknown as CacheMetricRow[]
  return [...rows].reverse()
}

/** 用量总数（面板概览用）。 */
export function cacheUsageCount(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM cache_metrics').get() as { n: number }).n
}

/** 最近一次用量时间（判断"最近有没有真的跑过模型"）。 */
export function lastCacheUsageAt(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT max(at) AS at FROM cache_metrics').get() as { at: string | null }
  return row.at
}

/**
 * 回填未命中原因（把采样与压缩/编辑事件对齐）。
 *
 * 单独一步而不是插入时定：因为"这次未命中是不是刚压缩过"取决于**插入时**还看不到的信息
 * （例如压缩事务在采样之后才提交），回填让归因可以晚一点做、且可重算。
 *
 * @param db - 数据库。
 * @param id - 记录 id。
 * @param reason - 原因。
 */
export function setMissReason(db: DatabaseSync, id: string, reason: string | null): void {
  db.prepare('UPDATE cache_metrics SET miss_reason = ? WHERE id = ?').run(reason, id)
}

/** 未归因的未命中记录（`cache_read_tokens = 0` 且没原因）。 */
export function unattrributedMisses(db: DatabaseSync, limit = 50): readonly CacheMetricRow[] {
  return db
    // ★ 同上（`FIX_PLAN.md` §45）：`at` 并列时补 `rowid` 兜底，方向与 `at` 一致。
    //   归因是**按顺序**回填的，顺序不确定 ⇒ 同一毫秒内的两条谁先被归因就不确定。
    .prepare('SELECT * FROM cache_metrics WHERE cache_read_tokens = 0 AND miss_reason IS NULL AND (input_tokens + cache_write_tokens) > 0 ORDER BY at ASC, rowid ASC LIMIT ?')
    .all(limit) as unknown as CacheMetricRow[]
}

/** 把用量挂到某条轮次上（网关消费完一轮后调用，便于"这轮花了多少"）。 */
export function attachUsageToTurn(db: DatabaseSync, options: { readonly sessionId: string; readonly turnId: string }): number {
  return Number(
    db
      .prepare(
        `UPDATE cache_metrics SET note = coalesce(note || ' ', '') || ? WHERE session_id = ? AND (note IS NULL OR note NOT LIKE ?)`,
      )
      .run(`turn:${options.turnId}`, options.sessionId, `%turn:${options.turnId}%`).changes,
  )
}

