/**
 * 私有媒体库 —— 用户自己保存的图片/文件，**并入长期记忆**。
 *
 * ## 为什么保存时要顺手建一条长期记忆
 *
 * 验收是：`media_save` 之后 `recall_longterm("那张架构图")` 能命中。
 * 如果只写 `media_assets` 表，模型**永远找不到它** ——
 * 因为 `recall_longterm` 走的是长期记忆的全文检索（FTS），不是媒体表。
 *
 * 所以保存动作必须**同时**做两件事，而且要在同一个函数里做完：
 *   ① 写 media_assets（拿到文件与元数据）
 *   ② 写一条 long_memory_entries 并把两边用 `long_memory_id` 串起来
 *
 * 分成两个函数（"先存文件、以后再并记忆"）一定会出现"存了但没并"的行，
 * 而那种行的表现是**模型说它记得，却永远找不到** —— 最难查的一类问题。
 *
 * ## 与表情库为什么必须分开
 *
 * 表情是"可以发出去的东西"，私有媒体是"只给自己看的东西"。
 * 两者混在一张表里，`sticker_search` 就会命中用户的私人文件，
 * 而 `qq_send_sticker` 有可能会把它发出去 —— 那是隐私事故。
 * 所以这里是**两张表、两条检索路径**，绝不交叉。
 *
 * @module @forlife/store/media
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { insertLongEntry } from './repository.ts'

/** 媒体资产行。 */
export interface MediaAssetRow {
  readonly id: string
  readonly sha256: string
  readonly kind: string
  readonly mime: string
  readonly size_bytes: number
  readonly storage_path: string
  readonly source_url: string | null
  readonly original_name: string | null
  readonly note: string | null
  readonly long_memory_id: string | null
  readonly conversation_key: string | null
  readonly created_at: string
}

/** 保存输入。 */
export interface SaveMediaInput {
  readonly sha256: string
  readonly kind: 'image' | 'file'
  readonly mime: string
  readonly sizeBytes: number
  readonly storagePath: string
  /** 用户写的说明（**这是 recall 能命中的主要信号**，越具体越好）。 */
  readonly note?: string | undefined
  readonly originalName?: string | undefined
  readonly sourceUrl?: string | undefined
  readonly conversationKey?: string | undefined
  readonly now?: Date
}

/** 保存结果。 */
export interface SaveMediaResult {
  readonly id: string
  readonly created: boolean
  readonly longMemoryId: string
}

/**
 * 组装长期记忆条目的文本。
 *
 * 为什么把这几样拼在一起：`recall_longterm` 是**全文检索**，
 * 而用户回忆时说的话可能来自任何一样 ——
 * "那张架构图"（备注）、"我发的那个 png"（文件名）、"图片"（类型）。
 * 只放备注的话，用户按文件名找就找不到。
 */
export function buildMediaMemoryText(input: { readonly note?: string | undefined; readonly originalName?: string | undefined; readonly kind: string }): string {
  const parts: string[] = []
  if (input.note !== undefined && input.note.trim() !== '') parts.push(input.note.trim())
  if (input.originalName !== undefined && input.originalName.trim() !== '') parts.push(`文件名：${input.originalName.trim()}`)
  parts.push(input.kind === 'image' ? '（用户保存的图片）' : '（用户保存的文件）')
  return parts.join('；')
}

/** 按指纹查。 */
export function findMediaBySha(db: DatabaseSync, sha256: string): MediaAssetRow | undefined {
  return db.prepare('SELECT * FROM media_assets WHERE sha256 = ?').get(sha256) as unknown as MediaAssetRow | undefined
}

/** 按 id 取（`recall_media` 用它取回原图）。 */
export function getMediaAsset(db: DatabaseSync, id: string): MediaAssetRow | undefined {
  return db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as unknown as MediaAssetRow | undefined
}

/** 列出媒体（可按会话过滤）。 */
export function listMediaAssets(
  db: DatabaseSync,
  options: { readonly limit?: number; readonly conversationKey?: string } = {},
): readonly MediaAssetRow[] {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)))
  if (options.conversationKey === undefined) {
    return db.prepare('SELECT * FROM media_assets ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as MediaAssetRow[]
  }
  return db
    .prepare('SELECT * FROM media_assets WHERE conversation_key = ? ORDER BY created_at DESC LIMIT ?')
    .all(options.conversationKey, limit) as unknown as MediaAssetRow[]
}

/**
 * 保存一份媒体，并**同时**把它并入长期记忆。
 *
 * 指纹已存在时：不重复落盘、不重复建记忆条目，只补充备注（备注可能是后补的）。
 * 这一点很重要 —— 同一张图被保存两次时，第二次往往带着**更好的备注**，
 * 直接丢弃就等于把用户刚写的说明扔了。
 */
export function saveMediaAsset(db: DatabaseSync, input: SaveMediaInput): SaveMediaResult {
  const now = (input.now ?? new Date()).toISOString()
  const existing = findMediaBySha(db, input.sha256)

  if (existing !== undefined) {
    // 备注后补：只在新备注非空且与旧的不同时更新，并同步刷新记忆条目文本
    const nextNote = input.note !== undefined && input.note.trim() !== '' ? input.note.trim() : existing.note
    if (nextNote !== existing.note) {
      db.prepare('UPDATE media_assets SET note = ? WHERE id = ?').run(nextNote, existing.id)
      if (existing.long_memory_id !== null) {
        const text = buildMediaMemoryText({ note: nextNote ?? undefined, originalName: existing.original_name ?? undefined, kind: existing.kind })
        insertLongEntry(db, { id: existing.long_memory_id, content: text, summary: text.slice(0, 80) })
      }
    }
    return { id: existing.id, created: false, longMemoryId: existing.long_memory_id ?? '' }
  }

  const id = `med_${randomUUID()}`
  const longMemoryId = `lng_${randomUUID()}`
  const text = buildMediaMemoryText({ note: input.note, originalName: input.originalName, kind: input.kind })

  // ① 媒体行
  db.prepare(
    `INSERT INTO media_assets
       (id, sha256, kind, mime, size_bytes, storage_path, source_url, original_name, note, long_memory_id, conversation_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sha256,
    input.kind,
    input.mime,
    input.sizeBytes,
    input.storagePath,
    input.sourceUrl ?? null,
    input.originalName ?? null,
    input.note ?? null,
    longMemoryId,
    input.conversationKey ?? null,
    now,
  )

  // ② 长期记忆条目（`recall_longterm` 靠它命中）
  insertLongEntry(db, {
    id: longMemoryId,
    content: text,
    summary: text.slice(0, 80),
    entities: [],
    sourceScope: input.conversationKey ?? null,
  })

  return { id, created: true, longMemoryId }
}

/**
 * 检索私有媒体（词法，与表情检索**同一套思路但完全独立的路径**）。
 *
 * 与 `searchStickers` 分开的理由见文件头：混用会导致
 * `sticker_search` 命中用户的私人文件，进而可能被发出去。
 */
export function searchMedia(db: DatabaseSync, query: string, options: { readonly limit?: number } = {}): readonly MediaAssetRow[] {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 5)))
  const needle = query.trim()
  if (needle === '') return []
  const like = `%${needle}%`
  return db
    .prepare(
      `SELECT * FROM media_assets
        WHERE note LIKE ? OR original_name LIKE ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(like, like, limit) as unknown as MediaAssetRow[]
}
