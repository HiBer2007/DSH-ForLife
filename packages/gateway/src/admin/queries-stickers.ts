/**
 * 「表情库」板块的数据 + 图片字节服务。
 *
 * ## 为什么图片要经我们自己的接口，而不是给个文件路径
 *
 * 表情文件在服务器磁盘上（`<库目录>/stickers/<sha256>.png`）。如果前端直接引路径，
 * 那要么得把目录暴露成静态资源（**等于把整个表情库公开**），要么在浏览器里根本读不到。
 * 所以走 `/api/admin/sticker-file?id=…`：**带鉴权、按 id 取、路径不落前端**。
 *
 * 顺带一个安全细节：只允许取**库里登记过的**文件。不做这件事的话，
 * 这个接口就是一个"按路径读服务器任意文件"的洞。
 *
 * @module @forlife/gateway/admin/queries-stickers
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

/** 一个表情的展示数据。 */
export interface StickerCard {
  readonly id: string
  readonly sha256: string
  readonly mime: string
  readonly sizeBytes: number
  readonly source: string
  readonly sourceUrl?: string
  /** 是不是我们自己的（false = 学来的，默认不主动转发）。 */
  readonly ours: boolean
  readonly scopes: readonly string[]
  readonly useCount: number
  readonly lastUsedAt?: string
  readonly createdAt: string
  readonly description?: string
  readonly emotionTags: readonly string[]
  readonly describedBy?: string
  /** 能不能在图库里显示（有些格式浏览器不认，如实标出来而不是给个破图）。 */
  readonly previewable: boolean
}

/** 板块数据。 */
export interface StickersOverview {
  readonly stickers: readonly StickerCard[]
  readonly stats: {
    readonly total: number
    readonly ours: number
    readonly learned: number
    readonly described: number
    readonly used: number
    readonly rejected: number
  }
  readonly notes: {
    /** 没有视觉模型时检索只能靠标签 —— 面板要说清这一点。 */
    readonly vision: string
  }
}

/** 浏览器能直接显示的格式。 */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** 安全解析 JSON 数组。 */
function parseList(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 组装板块数据。 */
export function queryStickers(db: DatabaseSync, options: { readonly limit?: number } = {}): StickersOverview {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 200)))

  const rows = db
    .prepare(
      `SELECT a.id, a.sha256, a.mime, a.size_bytes, a.source, a.source_url, a.ours, a.scopes,
              a.use_count, a.last_used_at, a.created_at, a.status,
              d.description, d.emotion_tags, d.model
         FROM sticker_assets a
         LEFT JOIN sticker_descriptions d ON d.asset_id = a.id
        WHERE a.status = 'active'
        ORDER BY COALESCE(a.last_used_at, a.created_at) DESC
        LIMIT ?`,
    )
    .all(limit) as {
    id: string
    sha256: string
    mime: string
    size_bytes: number
    source: string
    source_url: string | null
    ours: number
    scopes: string
    use_count: number
    last_used_at: string | null
    created_at: string
    description: string | null
    emotion_tags: string | null
    model: string | null
  }[]

  // LEFT JOIN 可能让同一资产出现多行（历史描述多条）；这里按 id 去重，保留第一条（最新）
  const seen = new Set<string>()
  const stickers: StickerCard[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    stickers.push({
      id: row.id,
      sha256: row.sha256,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      source: row.source,
      ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
      ours: row.ours === 1,
      scopes: parseList(row.scopes),
      useCount: row.use_count,
      ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
      createdAt: row.created_at,
      ...(row.description === null ? {} : { description: row.description }),
      emotionTags: parseList(row.emotion_tags),
      ...(row.model === null ? {} : { describedBy: row.model }),
      previewable: PREVIEWABLE.has(row.mime.split(';')[0]?.trim().toLowerCase() ?? ''),
    })
  }

  const count = (sql: string): number => ((db.prepare(sql).get() as { v?: number } | undefined)?.v ?? 0)
  const total = count("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'active'")
  const ours = count("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'active' AND ours = 1")
  const described = count(
    "SELECT COUNT(*) AS v FROM sticker_assets a WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM sticker_descriptions d WHERE d.asset_id = a.id)",
  )

  return {
    stickers,
    stats: {
      total,
      ours,
      learned: total - ours,
      described,
      used: count("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'active' AND use_count > 0"),
      rejected: count("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'rejected'"),
    },
    notes: {
      vision:
        '没有配置视觉模型时，表情只入库、不生成描述 —— 检索会退化成只靠标签（仍可用，但召回会差一些）。' +
        '配置 FORLIFE_VISION_MODEL 后，新入库的表情会自动生成描述；已入库的不会自动补（避免意外花掉额度）。',
    },
  }
}

/**
 * 读一张表情的字节。
 *
 * **只按 id 取库里登记过的路径**，不接受调用方给路径 ——
 * 否则这个接口就成了"按路径读服务器任意文件"的洞。
 */
export function readStickerBytes(
  db: DatabaseSync,
  id: string,
): { readonly ok: true; readonly bytes: Buffer; readonly mime: string } | { readonly ok: false; readonly reason: string } {
  const row = db.prepare("SELECT storage_path, mime, status FROM sticker_assets WHERE id = ?").get(id) as
    | { storage_path: string; mime: string; status: string }
    | undefined
  if (row === undefined) return { ok: false, reason: `库里没有这个表情：${id}` }
  if (row.storage_path === '') return { ok: false, reason: '这一行没有文件（可能是被拒绝时登记的证据行）' }
  try {
    return { ok: true, bytes: readFileSync(row.storage_path), mime: row.mime.split(';')[0]?.trim() ?? 'application/octet-stream' }
  } catch (error) {
    // 文件被手工删掉时要如实说，而不是返回空图
    return { ok: false, reason: `文件读不到（${row.storage_path}）：${String(error)}` }
  }
}
