/**
 * 记忆条目的编辑与归档。
 *
 * ## 编辑为什么复用 `insertLongEntry`
 *
 * 它的 SQL 里本来就有 `ON CONFLICT(id) DO UPDATE SET content/summary/entities`
 * —— 同一个 id 再写一次就是"更新"。另写一个 `updateLongEntry` 的话，
 * 两条路径的字段处理迟早分叉（比如一边更新了 FTS 索引、另一边忘了）。
 *
 * ## 归档为什么不是真删
 *
 * 长期记忆是**模型的经历**。真删掉的话：
 *  - 它引用过的中期条目会指向一个不存在的 id（渲染时断链）；
 *  - 用户改错了**没有回头路**（记忆是不可再生数据）。
 *
 * 所以归档 = 标成 `archived`：检索不再命中它，但数据还在，能查、能恢复。
 *
 * @module @forlife/gateway/admin/memory-write
 */
import type { DatabaseSync } from 'node:sqlite'

import { getLongEntry, insertLongEntry } from '@forlife/store'

/** 编辑结果。 */
export interface EditMemoryResult {
  readonly ok: boolean
  readonly reason: string
}

/** 编辑一条长期记忆的正文与摘要。 */
export function updateLongMemory(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly content: string
    readonly summary: string
    readonly entities?: readonly string[]
  },
): EditMemoryResult {
  const existing = getLongEntry(db, input.id)
  if (existing === undefined) return { ok: false, reason: `没有这条记忆：${input.id}` }

  const content = input.content.trim()
  const summary = input.summary.trim()
  if (content === '') return { ok: false, reason: '正文不能为空' }
  if (summary === '') {
    // 摘要不是可有可无的：列表与注入提示词用的是摘要，
    // 空摘要会让这条记忆在界面上显示成一片空白，而正文其实很长。
    return { ok: false, reason: '摘要不能为空 —— 列表与提示词注入用的都是摘要' }
  }

  insertLongEntry(db, {
    id: input.id,
    content,
    summary,
    entities: [...(input.entities ?? [])],
    ...(existing.source_scope === null ? {} : { sourceScope: existing.source_scope }),
    storageTier: existing.storage_tier === 'hdd' ? 'hdd' : 'ssd',
  })
  return { ok: true, reason: '已保存' }
}

/**
 * 归档一条长期记忆（**不是真删**）。
 *
 * 真删的代价：它引用过的中期条目会指向不存在的 id（渲染断链），
 * 而且用户改错了**没有回头路** —— 记忆是不可再生数据。
 */
export function archiveLongMemory(db: DatabaseSync, id: string): EditMemoryResult {
  const existing = getLongEntry(db, id)
  if (existing === undefined) return { ok: false, reason: `没有这条记忆：${id}` }
  db.prepare("UPDATE long_memory_entries SET status = 'archived' WHERE id = ?").run(id)
  return { ok: true, reason: '已归档（检索不再命中，数据保留可恢复）' }
}

/** 恢复一条被归档的记忆。 */
export function restoreLongMemory(db: DatabaseSync, id: string): EditMemoryResult {
  const existing = getLongEntry(db, id)
  if (existing === undefined) return { ok: false, reason: `没有这条记忆：${id}` }
  db.prepare("UPDATE long_memory_entries SET status = 'active' WHERE id = ?").run(id)
  return { ok: true, reason: '已恢复' }
}
