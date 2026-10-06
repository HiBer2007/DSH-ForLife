/**
 * 「表情与媒体」板块的数据。
 *
 * ## 为什么不给这两张表写死列名
 *
 * `image_descriptions` 与 `vision_call_log` 的 schema 归**视觉层**所有（不是面板）。
 * 在面板里写死列名，视觉层一改列就会在这里静默出错（要么报错、要么显示空白列），
 * 而面板是"看得见的门面"，最不该因为底层演进就坏掉。
 *
 * 所以这里读 `SELECT *`，把**实际存在的列**交给前端按需渲染：
 * 面板展示"库里有什么"，而不是"我以为库里有什么"。
 * 代价是前端要处理动态列 —— 但那比"改列就白屏"划算得多。
 *
 * 唯一例外是 QQ 的媒体入站：那张表（`qq_inbox`）是我们自己的，列名稳定，
 * 所以照常按字段取。
 *
 * @module @forlife/gateway/admin/queries-media
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一张"列不归我们管"的表。 */
export interface DynamicTable {
  readonly name: string
  readonly label: string
  /** 实际存在的列名（按表里的顺序）。 */
  readonly columns: readonly string[]
  /** 行（值为 JSON 可序列化的原样内容；超长文本已截断）。 */
  readonly rows: readonly Record<string, unknown>[]
  /** 总行数（可能大于返回的行数）。 */
  readonly total: number
  /** 表不存在时为 true —— 与"表是空的"区分开。 */
  readonly missing: boolean
}

/** QQ 媒体入站（列名是我们自己的，按字段取）。 */
export interface MediaInbound {
  readonly id: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly mediaKind: string
  readonly text: string
  readonly at: string
  readonly isGroup: boolean
}

/** 板块数据。 */
export interface MediaOverview {
  readonly inbound: readonly MediaInbound[]
  readonly inboundStats: { readonly images: number; readonly files: number; readonly total: number }
  readonly tables: readonly DynamicTable[]
  /** 表情包：目前**没有**存储层，如实说明而不是显示一个空表。 */
  readonly stickers: { readonly supported: boolean; readonly note: string }
}

/** 单字段截断上限：面板不需要看完整 base64 / 向量。 */
const CELL_LIMIT = 160

/** 这些列名一律不展示（体积大且无展示价值）。 */
const HIDDEN_PATTERNS = [/embedding/i, /vector/i, /base64/i, /^blob$/i, /image_data/i, /raw/i]

/** 是否该隐藏这一列。 */
function hidden(column: string): boolean {
  return HIDDEN_PATTERNS.some((pattern) => pattern.test(column))
}

/** 取一张动态表的快照。 */
function snapshot(db: DatabaseSync, name: string, label: string, limit: number): DynamicTable {
  try {
    const info = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
    if (info.length === 0) {
      return { name, label, columns: [], rows: [], total: 0, missing: true }
    }
    const columns = info.map((row) => row.name).filter((column) => !hidden(column))
    const total = (db.prepare(`SELECT COUNT(*) AS v FROM ${name}`).get() as { v?: number } | undefined)?.v ?? 0
    const raw = db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT ?`).all(limit) as Record<string, unknown>[]
    const rows = raw.map((row) => {
      const out: Record<string, unknown> = {}
      for (const column of columns) {
        const value = row[column]
        out[column] = typeof value === 'string' && value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…` : value
      }
      return out
    })
    return { name, label, columns, rows, total, missing: false }
  } catch {
    return { name, label, columns: [], rows: [], total: 0, missing: true }
  }
}

/** 组装板块数据。 */
export function queryMedia(db: DatabaseSync, options: { readonly limit?: number } = {}): MediaOverview {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 30)))

  const inboundRows = db
    .prepare(
      `SELECT id, conversation_key, sender_name, media_kind, text, at, is_group
         FROM qq_inbox WHERE media_kind IS NOT NULL
        ORDER BY received_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string
    conversation_key: string
    sender_name: string | null
    media_kind: string
    text: string
    at: string
    is_group: number
  }[]

  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN media_kind = 'image' THEN 1 ELSE 0 END), 0) AS images,
         COALESCE(SUM(CASE WHEN media_kind = 'file' THEN 1 ELSE 0 END), 0) AS files,
         COUNT(*) AS total
       FROM qq_inbox WHERE media_kind IS NOT NULL`,
    )
    .get() as { images: number; files: number; total: number }

  return {
    inbound: inboundRows.map((row) => ({
      id: row.id,
      conversationKey: row.conversation_key,
      ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
      mediaKind: row.media_kind,
      text: row.text,
      at: row.at,
      isGroup: row.is_group === 1,
    })),
    inboundStats: { images: counts.images, files: counts.files, total: counts.total },
    tables: [
      snapshot(db, 'image_descriptions', '图片描述（视觉层写入）', limit),
      snapshot(db, 'vision_call_log', '视觉调用日志（视觉层写入）', limit),
    ],
    stickers: {
      supported: false,
      note:
        '表情包（sticker）目前**没有存储层**：现在只支持发送时指定表情，没有"表情库/收藏/语义检索"。' +
        '这一页不显示空表来充数 —— 表都没有，画一张空表只会让人以为"功能已就绪只是没数据"。',
    },
  }
}
