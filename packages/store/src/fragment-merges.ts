/**
 * **碎片合并的落库**（D8 第 4 步；用户 2026-10-13 裁定"落库形态 = B：新表、多对一、可回溯"）。
 *
 * ## 分工（★ 别把"算"和"写"混在一起）
 *
 * - `@forlife/memory-core/fragment-merge` **只算**（纯函数：判据、分组、粗 hint）；
 * - ★ **本模块只写**：把算好的结果落库 —— 写 `fragment_merges` 留痕、
 *   给保留的那条换粗 hint、把被并的标 `archived`，以及**反向恢复**。
 *
 * ## 三条纪律（都来自本仓踩过的坑）
 *
 * 1. ★★ **可恢复**：被并的碎片标 `archived`（**不是删**）—— 表保留、留痕在，
 *    `restoreFragmentMerge()` 能把它们改回 `fragmented` 并撤掉留痕；
 * 2. ★★ **一条事务**：换 hint + 标 archived + 写留痕必须**同生共死**，
 *    否则会出现"hint 换了但留痕没写"这种**事后查不清**的状态；
 * 3. ★ **幂等**：重复执行同一组不会灌水（主键 `(merged_id, source_id)` 挡住），
 *    已 `archived` 的不会被重复计数。
 *
 * @module @forlife/store/fragment-merges
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一次合并要落库的内容（由 `planFragmentMerges()` 的结果映射而来）。 */
export interface MergeApplyInput {
  /** 合并后**保留**的那条碎片 id。 */
  readonly mergedId: string
  /** 被并进去的那些（★ 不含 `mergedId`）。 */
  readonly sourceIds: readonly string[]
  /** 粗 hint（模型只看到这个）。 */
  readonly hint: string
  /** 用了哪套判据与参数（写进留痕，事后可回溯）。 */
  readonly rule: string
  /** 合并时间（不传就取现在）。 */
  readonly at?: string
}

/** 落库结果。 */
export interface MergeApplyResult {
  /** 换成粗 hint 的条数（0 或 1）。 */
  readonly hinted: number
  /** 被标 `archived` 的条数（★ 幂等：已经是 archived 的不再计）。 */
  readonly archived: number
  /** 新写的留痕行数（★ 幂等：已记过的不再计）。 */
  readonly recorded: number
}

/**
 * 落一次合并（★ 一条事务）。
 *
 * @param db - 库。
 * @param input - 合并内容。
 * @returns 落库结果。
 */
export function applyFragmentMerge(db: DatabaseSync, input: MergeApplyInput): MergeApplyResult {
  const at = input.at ?? nowIso()
  const sources = input.sourceIds.filter((id) => id !== input.mergedId)
  let hinted = 0
  let archived = 0
  let recorded = 0

  db.exec('BEGIN IMMEDIATE')
  try {
    // ① 保留的那条换成粗 hint（★ 模型唯一看得到的东西）
    const hintInfo = db
      .prepare("UPDATE mid_memory_entries SET fragment_hint = ? WHERE id = ? AND status = 'fragmented'")
      .run(input.hint, input.mergedId)
    hinted = Number(hintInfo.changes)

    for (const sourceId of sources) {
      // ② 留痕（先写：主键冲突 ⇒ 说明这对已经记过，跳过后续动作）
      const info = db
        .prepare('INSERT OR IGNORE INTO fragment_merges (merged_id, source_id, merged_at, rule) VALUES (?, ?, ?, ?)')
        .run(input.mergedId, sourceId, at, input.rule)
      if (Number(info.changes) === 0) continue
      recorded += 1

      // ③ 被并的标 archived（★ 不是删 —— 可恢复）
      const arch = db
        .prepare("UPDATE mid_memory_entries SET status = 'archived' WHERE id = ? AND status = 'fragmented'")
        .run(sourceId)
      archived += Number(arch.changes)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { hinted, archived, recorded }
}

/** 一条留痕。 */
export interface FragmentMergeRow {
  readonly mergedId: string
  readonly sourceId: string
  readonly mergedAt: string
  readonly rule: string
}

/**
 * 读留痕（★ "这条粗 hint 是由哪几条合出来的"）。
 *
 * @param db - 库。
 * @param mergedId - 只看这一组（不传就看全部）。
 * @returns 留痕行（按合并时间倒序）。
 */
export function listFragmentMerges(db: DatabaseSync, mergedId?: string): readonly FragmentMergeRow[] {
  const sql =
    mergedId === undefined
      ? 'SELECT merged_id, source_id, merged_at, rule FROM fragment_merges ORDER BY merged_at DESC, source_id'
      : 'SELECT merged_id, source_id, merged_at, rule FROM fragment_merges WHERE merged_id = ? ORDER BY source_id'
  const rows = (mergedId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(mergedId)) as unknown as {
    merged_id: string
    source_id: string
    merged_at: string
    rule: string
  }[]
  return rows.map((r) => ({ mergedId: r.merged_id, sourceId: r.source_id, mergedAt: r.merged_at, rule: r.rule }))
}

/**
 * **撤掉一次合并**（★ 可恢复：把被并的改回 `fragmented` 并删掉留痕）。
 *
 * ★ 为什么必须有：合并**改变模型看到的文本**（hint），做错了要能退回去；
 *   而"退回去"不能靠猜 —— 留痕里记着**谁被并进了谁**。
 *
 * @param db - 库。
 * @param mergedId - 撤这一组。
 * @returns 恢复的条数（改回 `fragmented` 的）与删掉的留痕行数。
 */
export function restoreFragmentMerge(db: DatabaseSync, mergedId: string): { restored: number; removed: number } {
  let restored = 0
  let removed = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = listFragmentMerges(db, mergedId)
    for (const row of rows) {
      const info = db
        .prepare("UPDATE mid_memory_entries SET status = 'fragmented' WHERE id = ? AND status = 'archived'")
        .run(row.sourceId)
      restored += Number(info.changes)
    }
    removed = Number(db.prepare('DELETE FROM fragment_merges WHERE merged_id = ?').run(mergedId).changes)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { restored, removed }
}

/** 一条**待合并候选**（只取合并需要的字段 —— 与 memory-core 的 MergeCandidate 同形）。 */
export interface MergeCandidateRow {
  readonly id: string
  readonly entities: readonly string[]
  /** ★ 现有的 hint（机械拼接的原料；空串表示还没泛化过）。 */
  readonly hint: string
}

/**
 * 读出**可以参与合并的碎片**（★ D8 的输入）。
 *
 * ## 为什么只取 status='fragmented'
 *
 * §5.3-3 说的是"**碎片**合并"；ctive 是还没被代表的原始记忆 ——
 * ★ 把它们并进来等于**改动模型看到的原文**，那是另一件事（不是这条规则）。
 *
 * ## 为什么按 created_at 升序
 *
 * 分组结果要**稳定可复现**（同样的库两次跑出同样的组），
 * 而"哪条当保留项"取决于输入顺序 ⇒ 顺序必须由**数据**决定，不能靠 SQLite 的默认顺序。
 *
 * ## ntities 解析失败怎么办
 *
 * ★ 返回**空数组**（不是抛）：一条坏数据不该让整轮维护停摆；
 * 而"entities 全空"这件事本身已经有 data-gaps 那条告警在盯（§78.42）。
 *
 * @param db - 库。
 * @returns 候选（按创建时间升序）。
 */
export function listMergeCandidates(db: DatabaseSync): readonly MergeCandidateRow[] {
  const rows = db
    .prepare(
      `SELECT id, entities, COALESCE(fragment_hint, summary) AS hint
         FROM mid_memory_entries
        WHERE status = 'fragmented'
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as { id: string; entities: string | null; hint: string | null }[]
  return rows.map((row) => {
    let entities: readonly string[] = []
    try {
      const parsed: unknown = JSON.parse(row.entities ?? '[]')
      if (Array.isArray(parsed)) entities = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    } catch {
      entities = []
    }
    return { id: row.id, entities, hint: (row.hint ?? '').trim() }
  })
}