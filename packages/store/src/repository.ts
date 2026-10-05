/**
 * 表访问层（中期 / 长期 / 压缩日志 / 渲染状态）。
 *
 * 设计要点：
 *  - **append 协议在外层事务里完成**（表写入 + 渲染修订号自增同事务），见 {@link appendMidEntry}；
 *  - 时间一律 **UTC ISO-8601**（§2.16：存储用系统时区，显示才转换）；
 *  - 所有写操作都返回"影响后的渲染修订号"，让调用方判断是否需要重渲染；
 *  - SQL 只出现在本文件与 migrations.ts —— 其他包不碰 SQL（便于日后换存储）。
 *
 * @module @forlife/store/repository
 */
import type { DatabaseSync } from 'node:sqlite'

/** 时间戳工具：存储一律 UTC。 */
export function nowIso(): string {
  return new Date().toISOString()
}

// ── 中文检索的关键：自己切分，不信 unicode61 ─────────────────────────────────
//
// SQLite 的 unicode61 分词器把**连续的 CJK 字符当成一个整词**，
// 所以"防抖与消息队列策略"整段是一个 token，搜"防抖"命中不了
// （除非原文里"防抖"两边恰好有空格 —— 这就是最容易骗过测试的假象）。
//
// 做法：写入时把每个 CJK 字符用空格隔开再进 FTS；查询时同样切分，
// 并对含 CJK 的查询加**短语引号**，保证是"相邻匹配"而不是"包含这些字"。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g

/** 把文本切成"FTS 友好"形式（CJK 按字分隔，拉丁词保持完整）。 */
export function segmentForFts(text: string): string {
  return text.replace(CJK, (ch) => ` ${ch} `).replace(/\s+/g, ' ').trim()
}

/** 把用户输入转成 FTS5 查询串。 */
export function ftsQuery(raw: string): string {
  const segmented = segmentForFts(raw)
  if (segmented === '') return '""'
  // 含 CJK 时用短语查询（相邻匹配），否则原样（拉丁词/前缀）
  return CJK.test(raw) ? `"${segmented.replace(/"/g, '""')}"` : segmented
}

/** 取一行在基表里的 rowid（FTS 外部内容表要与基表 rowid 对齐）。 */
function rowidOf(db: DatabaseSync, table: string, id: string): number | undefined {
  const row = db.prepare(`SELECT rowid AS rid FROM ${table} WHERE id = ?`).get(id) as { rid: number } | undefined
  return row?.rid
}

/** 写入/更新中期 FTS 行（必须在与基表写入同一事务内调用）。 */
function upsertMidFts(db: DatabaseSync, rowid: number, summary: string, content: string | null, entities: string): void {
  db.prepare('DELETE FROM mid_memory_fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO mid_memory_fts (rowid, summary, content, entities) VALUES (?, ?, ?, ?)').run(
    rowid,
    segmentForFts(summary),
    segmentForFts(content ?? ''),
    segmentForFts(entities),
  )
}

/** 写入长期 FTS 行。 */
function upsertLongFts(db: DatabaseSync, rowid: number, summary: string, content: string | null, entities: string): void {
  db.prepare('DELETE FROM long_memory_fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO long_memory_fts (rowid, summary, content, entities) VALUES (?, ?, ?, ?)').run(
    rowid,
    segmentForFts(summary),
    segmentForFts(content ?? ''),
    segmentForFts(entities),
  )
}

/** 中期记忆条目（对应 mid_memory_entries 一行）。 */
export interface MidEntryRow {
  readonly id: string
  readonly entry_type: 'semantic' | 'fragment'
  readonly content: string | null
  readonly summary: string
  readonly entities: string
  readonly token_count: number
  readonly window_offset: number
  readonly status: 'active' | 'fragmented' | 'archived'
  readonly fragmented_into: string | null
  readonly fragment_hint: string | null
  readonly compaction_epoch: number
  readonly source_short_ids: string
  readonly created_at: string
  readonly last_accessed_at: string | null
  readonly storage_tier: 'ssd' | 'hdd'
  readonly revision: number
  readonly source_scope: string | null
}

/** 追加中期条目的输入。 */
export interface AppendMidInput {
  readonly id: string
  readonly summary: string
  readonly content?: string | null
  readonly entities?: readonly string[]
  readonly tokenCount: number
  readonly sourceShortIds?: readonly string[]
  readonly sourceScope?: string | null
  readonly entryType?: 'semantic' | 'fragment'
}

/** 追加结果。 */
export interface AppendMidResult {
  readonly entry: MidEntryRow
  /** 写入后的全局渲染修订号（渲染缓存键的一部分）。 */
  readonly revision: number
}

/** 中长期统计。 */
export interface MidStats {
  readonly activeCount: number
  readonly fragmentCount: number
  readonly activeTokens: number
  readonly fragmentTokens: number
}

// ── 渲染状态（全局修订号与压缩 epoch）────────────────────────────────────────

/** 读取一个状态值。 */
export function getState(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

/** 当前渲染修订号。 */
export function currentRevision(db: DatabaseSync): number {
  return Number(getState(db, 'render_revision') ?? '0')
}

/** 当前压缩 epoch。 */
export function currentEpoch(db: DatabaseSync): number {
  return Number(getState(db, 'compaction_epoch') ?? '0')
}

/** 递增渲染修订号（在同一事务内调用）。 */
function bumpRevision(db: DatabaseSync): number {
  db.prepare("UPDATE forlife_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'render_revision'").run()
  return currentRevision(db)
}

/** 递增压缩 epoch（压缩事务开始时调用）。 */
export function bumpEpoch(db: DatabaseSync): number {
  db.prepare("UPDATE forlife_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'compaction_epoch'").run()
  return currentEpoch(db)
}

// ── 中期记忆 ────────────────────────────────────────────────────────────────

/**
 * 追加一条中期记忆。
 *
 * **append 协议（PLAN §2.3）**：写入表 + 递增渲染修订号在**同一个事务**里完成；
 * 返回值既含落库的行，也含新的修订号 —— 窗口文本由调用方用返回的行渲染，
 * 因此"表是权威、窗口是渲染"这条不会出现双写不一致。
 */
export function appendMidEntry(db: DatabaseSync, input: AppendMidInput): AppendMidResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const offsetRow = db
      .prepare('SELECT coalesce(max(window_offset), -1) + 1 AS next FROM mid_memory_entries WHERE compaction_epoch = ?')
      .get(currentEpoch(db)) as { next: number }
    const createdAt = nowIso()
    db.prepare(
      `INSERT INTO mid_memory_entries
         (id, entry_type, content, summary, entities, token_count, window_offset, status,
          fragmented_into, fragment_hint, compaction_epoch, source_short_ids, created_at,
          last_accessed_at, storage_tier, revision, source_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?, NULL, 'ssd', ?, ?)`,
    ).run(
      input.id,
      input.entryType ?? 'semantic',
      input.content ?? null,
      input.summary,
      JSON.stringify(input.entities ?? []),
      input.tokenCount,
      offsetRow.next,
      currentEpoch(db),
      JSON.stringify(input.sourceShortIds ?? []),
      createdAt,
      bumpRevision(db),
      input.sourceScope ?? null,
    )
    const entry = getMidEntry(db, input.id)
    if (entry === undefined) throw new Error('追加后读不到条目，事务异常')
    const rid = rowidOf(db, 'mid_memory_entries', input.id)
    if (rid === undefined) throw new Error('追加后取不到 rowid')
    upsertMidFts(db, rid, entry.summary, entry.content, entry.entities)
    db.exec('COMMIT')
    return { entry, revision: currentRevision(db) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 按 id 取中期条目。 */
export function getMidEntry(db: DatabaseSync, id: string): MidEntryRow | undefined {
  return db.prepare('SELECT * FROM mid_memory_entries WHERE id = ?').get(id) as MidEntryRow | undefined
}

/**
 * 列出某 epoch 下参与渲染的条目。
 *
 * 渲染视图定义（PLAN §2.2）：`compaction_epoch = current AND status IN ('active','fragmented')`，
 * 按 `window_offset` 升序。
 */
export function listRenderableMidEntries(db: DatabaseSync, epoch = currentEpoch(db)): readonly MidEntryRow[] {
  return db
    .prepare(
      `SELECT * FROM mid_memory_entries
        WHERE compaction_epoch = ? AND status IN ('active','fragmented')
        ORDER BY window_offset ASC`,
    )
    .all(epoch) as MidEntryRow[]
}

/** 中期统计（用于碎片占比等约束判断）。 */
export function midStats(db: DatabaseSync, epoch = currentEpoch(db)): MidStats {
  const row = db
    .prepare(
      `SELECT
         sum(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS activeCount,
         sum(CASE WHEN status = 'fragmented' THEN 1 ELSE 0 END) AS fragmentCount,
         coalesce(sum(CASE WHEN status = 'active'    THEN token_count ELSE 0 END), 0) AS activeTokens,
         coalesce(sum(CASE WHEN status = 'fragmented' THEN token_count ELSE 0 END), 0) AS fragmentTokens
       FROM mid_memory_entries WHERE compaction_epoch = ?`,
    )
    .get(epoch) as { activeCount: number | null; fragmentCount: number | null; activeTokens: number; fragmentTokens: number }
  return {
    activeCount: row.activeCount ?? 0,
    fragmentCount: row.fragmentCount ?? 0,
    activeTokens: row.activeTokens,
    fragmentTokens: row.fragmentTokens,
  }
}

/** 把一个中期条目降级为碎片（指向长期记忆）。 */
export function fragmentMidEntry(db: DatabaseSync, id: string, longMemoryId: string, hint: string, tokenCount: number): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const info = db
      .prepare(
        `UPDATE mid_memory_entries
            SET status = 'fragmented', entry_type = 'fragment', content = NULL,
                fragmented_into = ?, fragment_hint = ?, token_count = ?, revision = revision + 1
          WHERE id = ?`,
      )
      .run(longMemoryId, hint, tokenCount, id)
    if (info.changes === 0) throw new Error(`碎片化失败：找不到中期条目 ${id}`)
    // 碎片化改变了 summary/hint 与 content，FTS 必须同步（否则检索会命中已失效的原文）
    const updated = getMidEntry(db, id)
    if (updated !== undefined) {
      const rid = rowidOf(db, 'mid_memory_entries', id)
      if (rid !== undefined) upsertMidFts(db, rid, updated.summary, updated.content, updated.entities)
    }
    bumpRevision(db)
    db.exec('COMMIT')
    return currentRevision(db)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 记录一次访问（用于沉降策略的 `last_accessed_at > 90 天` 判断）。 */
export function touchMidEntry(db: DatabaseSync, id: string, at = nowIso()): void {
  db.prepare('UPDATE mid_memory_entries SET last_accessed_at = ? WHERE id = ?').run(at, id)
}

/** 词法检索（FTS5）。 */
export function searchMidFts(db: DatabaseSync, query: string, limit: number): readonly MidEntryRow[] {
  return db
    .prepare(
      `SELECT m.* FROM mid_memory_fts f JOIN mid_memory_entries m ON m.rowid = f.rowid
        WHERE mid_memory_fts MATCH ? ORDER BY bm25(mid_memory_fts) LIMIT ?`,
    )
    .all(ftsQuery(query), limit) as MidEntryRow[]
}

// ── 长期记忆 ────────────────────────────────────────────────────────────────

/** 长期记忆条目。 */
export interface LongEntryRow {
  readonly id: string
  readonly content: string | null
  readonly summary: string | null
  readonly entities: string | null
  readonly embedding_id: string | null
  readonly source_mid_ids: string | null
  readonly storage_tier: 'ssd' | 'hdd' | null
  readonly status: 'active' | 'archived' | null
  readonly created_at: string | null
  readonly last_accessed_at: string | null
  readonly access_count: number
  readonly source_scope: string | null
  readonly archive_path: string | null
}

/** 写入长期记忆（沉降或直接归档）。 */
export function insertLongEntry(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly content: string
    readonly summary: string
    readonly entities?: readonly string[]
    readonly embeddingId?: string | null
    readonly sourceMidIds?: readonly string[]
    readonly sourceScope?: string | null
    readonly storageTier?: 'ssd' | 'hdd'
  },
): LongEntryRow {
  const at = nowIso()
  db.prepare(
    `INSERT INTO long_memory_entries
       (id, content, summary, entities, embedding_id, source_mid_ids, storage_tier, status,
        created_at, last_accessed_at, access_count, source_scope, archive_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 0, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content, summary = excluded.summary, entities = excluded.entities,
       storage_tier = excluded.storage_tier, status = 'active'`,
  ).run(
    input.id,
    input.content,
    input.summary,
    JSON.stringify(input.entities ?? []),
    input.embeddingId ?? null,
    JSON.stringify(input.sourceMidIds ?? []),
    input.storageTier ?? 'ssd',
    at,
    input.sourceScope ?? null,
  )
  const row = db.prepare('SELECT * FROM long_memory_entries WHERE id = ?').get(input.id) as LongEntryRow | undefined
  if (row === undefined) throw new Error('写入后读不到长期条目')
  const rid = rowidOf(db, 'long_memory_entries', input.id)
  if (rid !== undefined) upsertLongFts(db, rid, row.summary ?? '', row.content, row.entities ?? '[]')
  return row
}

/** 按 id 取长期条目。 */
export function getLongEntry(db: DatabaseSync, id: string): LongEntryRow | undefined {
  return db.prepare('SELECT * FROM long_memory_entries WHERE id = ?').get(id) as LongEntryRow | undefined
}

/** 记录一次长期条目的访问。 */
export function touchLongEntry(db: DatabaseSync, id: string, at = nowIso()): void {
  db.prepare('UPDATE long_memory_entries SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?').run(at, id)
}

/** 找出满足沉降条件（超过给定天数未访问）的长期条目。 */
export function listSettleCandidates(db: DatabaseSync, olderThanDays: number, limit: number, now = new Date()): readonly LongEntryRow[] {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
  return db
    .prepare(
      `SELECT * FROM long_memory_entries
        WHERE storage_tier = 'ssd'
          AND coalesce(last_accessed_at, created_at) < ?
        ORDER BY coalesce(last_accessed_at, created_at) ASC
        LIMIT ?`,
    )
    .all(cutoff, limit) as LongEntryRow[]
}

/** 把长期条目标记为已沉降到 HDD（表内 content 置空，全文移入归档）。 */
export function markLongSettled(db: DatabaseSync, id: string, archivePath: string): void {
  db.prepare(
    `UPDATE long_memory_entries SET storage_tier = 'hdd', content = NULL, archive_path = ? WHERE id = ?`,
  ).run(archivePath, id)
}

/** 把 HDD 条目提升回 SSD（`recover`）。 */
export function markLongRecovered(db: DatabaseSync, id: string, content: string): void {
  db.prepare(
    `UPDATE long_memory_entries SET storage_tier = 'ssd', content = ?, archive_path = NULL WHERE id = ?`,
  ).run(content, id)
}

/** 长期记忆词法检索。 */
export function searchLongFts(db: DatabaseSync, query: string, limit: number): readonly LongEntryRow[] {
  return db
    .prepare(
      `SELECT l.* FROM long_memory_fts f JOIN long_memory_entries l ON l.rowid = f.rowid
        WHERE long_memory_fts MATCH ? ORDER BY bm25(long_memory_fts) LIMIT ?`,
    )
    .all(ftsQuery(query), limit) as LongEntryRow[]
}

// ── 压缩日志 ────────────────────────────────────────────────────────────────

/** 压缩日志输入（字段对齐 PLAN §4.5）。 */
export interface CompactionLogInput {
  readonly id: string
  readonly requestedBy: 'model' | 'system'
  readonly approved: boolean
  readonly reasonIfRejected?: string | null
  readonly shortTokensBefore: number
  readonly turnsSinceLast: number
  readonly timeSinceLastMs: number
  readonly pushedEntries: readonly string[]
  readonly fragmentedEntries: readonly string[]
  readonly keptInShortTokens: number
  readonly modelUsed: string
  readonly cacheWarmed?: boolean
}

/** 写一条压缩日志。 */
export function recordCompaction(db: DatabaseSync, input: CompactionLogInput): void {
  db.prepare(
    `INSERT INTO compaction_log
       (id, requested_by, approved, reason_if_rejected, short_tokens_before, turns_since_last,
        time_since_last, pushed_entries, fragmented_entries, kept_in_short_tokens, model_used, timestamp, cache_warmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.requestedBy,
    input.approved ? 1 : 0,
    input.reasonIfRejected ?? null,
    input.shortTokensBefore,
    input.turnsSinceLast,
    input.timeSinceLastMs,
    JSON.stringify(input.pushedEntries),
    JSON.stringify(input.fragmentedEntries),
    input.keptInShortTokens,
    input.modelUsed,
    nowIso(),
    input.cacheWarmed === true ? 1 : 0,
  )
}

/** 读最近的压缩日志。 */
export function listCompactionLog(db: DatabaseSync, limit = 20): readonly Record<string, unknown>[] {
  return db.prepare('SELECT * FROM compaction_log ORDER BY timestamp DESC LIMIT ?').all(limit) as Record<string, unknown>[]
}

/** 距上次成功压缩的信息（冷却期判断用）。 */
export function lastSuccessfulCompaction(db: DatabaseSync): { readonly at: string; readonly turnsSince: number } | undefined {
  const row = db
    .prepare("SELECT timestamp FROM compaction_log WHERE approved = 1 ORDER BY timestamp DESC LIMIT 1")
    .get() as { timestamp: string } | undefined
  if (row === undefined) return undefined
  // 轮次数由上层统计（本层只负责时间），这里返回 0 表示"由调用方覆盖"
  return { at: row.timestamp, turnsSince: 0 }
}

// ── 溢出存储（大工具结果的全文，供 recall_full 取回）─────────────────────────

/** 一条溢出记录。 */
export interface SpillRow {
  readonly id: string
  readonly session_id: string | null
  readonly tool_name: string
  readonly tool_call_id: string | null
  readonly head: string
  readonly content: string
  readonly byte_size: number
  readonly line_count: number
  readonly created_at: string
}

/**
 * 存入一份大工具结果的全文，返回可被 `recall_full` 引用的 id。
 *
 * `head` 是留在上下文里的前 N 行，`content` 是完整结果 ——
 * 这样"分层降噪"（PLAN §3.2）与"可按需取回"同时成立。
 */
export function insertSpill(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly toolName: string
    readonly content: string
    readonly sessionId?: string | null
    readonly toolCallId?: string | null
    readonly headLines?: number
  },
): SpillRow {
  const lines = input.content.split('\n')
  const headLines = input.headLines ?? 20
  const head = lines.slice(0, headLines).join('\n')
  db.prepare(
    `INSERT INTO spill_entries (id, session_id, tool_name, tool_call_id, head, content, byte_size, line_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    input.id,
    input.sessionId ?? null,
    input.toolName,
    input.toolCallId ?? null,
    head,
    input.content,
    Buffer.byteLength(input.content, 'utf8'),
    lines.length,
    nowIso(),
  )
  const row = getSpill(db, input.id)
  if (row === undefined) throw new Error('写入后读不到溢出记录')
  return row
}

/** 按 id 取溢出记录（含全文）。 */
export function getSpill(db: DatabaseSync, id: string): SpillRow | undefined {
  return db.prepare('SELECT * FROM spill_entries WHERE id = ?').get(id) as SpillRow | undefined
}

/** 列出某会话最近的溢出记录（不含全文，供面板/诊断用）。 */
export function listSpills(db: DatabaseSync, sessionId: string, limit = 20): readonly Omit<SpillRow, 'content'>[] {
  return db
    .prepare(
      `SELECT id, session_id, tool_name, tool_call_id, head, byte_size, line_count, created_at
         FROM spill_entries WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Omit<SpillRow, 'content'>[]
}


