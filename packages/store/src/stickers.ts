/**
 * 表情库与私有媒体库的读写。
 *
 * ## 这一层的核心是"省钱主线"
 *
 * PLAN 阶段六有一条验收：**同一个表情第二次出现 ⇒ 0 次视觉调用**。
 * 把它做成"调用方记得先查一下"是不行的 —— 只要有一个调用点忘了，
 * 钱就悄悄花掉了，而且**没有任何报错**。
 *
 * 所以这里提供 `describeStickerOnce()`：**有描述就直接返回，根本不调用视觉模型**。
 * 调用方拿不到"绕过"的机会。判断逻辑只有一处，测试也只守这一处。
 *
 * ## 指纹（sha256）是这一切的物理基础
 *
 * `sticker_assets.sha256` 是 UNIQUE 的，所以"重复入库"在数据库层面就被挡掉，
 * 不依赖应用层的 if 判断（那种判断在并发下会漏）。
 *
 * @module @forlife/store/stickers
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 表情/媒体的来源。 */
export type StickerSource = 'manual' | 'search' | 'self-made' | 'learned'

/** 一条资产。 */
export interface StickerAssetRow {
  readonly id: string
  readonly sha256: string
  readonly kind: string
  readonly mime: string
  readonly size_bytes: number
  readonly storage_path: string
  readonly source: StickerSource
  readonly source_url: string | null
  /** 1 = 我们自己的（可主动发）；0 = 学来的（默认不主动转发）。 */
  readonly ours: number
  readonly scopes: string
  readonly use_count: number
  readonly last_used_at: string | null
  readonly status: string
  readonly reject_reason: string | null
  readonly width: number | null
  readonly height: number | null
  readonly created_at: string
}

/** 一条描述。 */
export interface StickerDescriptionRow {
  readonly id: string
  readonly asset_id: string
  readonly description: string
  readonly emotion_tags: string
  readonly model: string | null
  readonly token_count: number
  readonly created_at: string
}

/** 入库输入。 */
export interface UpsertStickerInput {
  readonly sha256: string
  readonly kind?: string
  readonly mime: string
  readonly sizeBytes: number
  readonly storagePath: string
  readonly source: StickerSource
  readonly sourceUrl?: string | null
  /** 默认 true（我们自己收藏的）；学别人的表情传 false。 */
  readonly ours?: boolean
  readonly width?: number | null
  readonly height?: number | null
  readonly scope?: string | null
  readonly now?: Date
}

/** 入库结果。`created=false` 表示**指纹命中**（已存在，没新增行）。 */
export interface UpsertStickerResult {
  readonly id: string
  readonly created: boolean
  /** 命中已有行时，顺带把它带出来（调用方通常要复用它的描述）。 */
  readonly asset: StickerAssetRow
}

/** 按 id 取一条。 */
export function getStickerAsset(db: DatabaseSync, id: string): StickerAssetRow | undefined {
  return db.prepare('SELECT * FROM sticker_assets WHERE id = ?').get(id) as StickerAssetRow | undefined
}

/** 按指纹取一条（去重与复用的入口）。 */
export function findStickerBySha(db: DatabaseSync, sha256: string): StickerAssetRow | undefined {
  return db.prepare('SELECT * FROM sticker_assets WHERE sha256 = ?').get(sha256) as StickerAssetRow | undefined
}

/** 把 scope 加进 JSON 数组（去重；已存在则原样返回）。 */
function withScope(existing: string, scope: string): string {
  let list: string[] = []
  try {
    const parsed: unknown = JSON.parse(existing)
    if (Array.isArray(parsed)) list = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    list = []
  }
  if (list.includes(scope)) return existing
  list.push(scope)
  return JSON.stringify(list)
}

/**
 * 入库（按 sha256 去重）。
 *
 * 指纹命中时**只更新** `scopes`（累积"在哪些会话见过"）与 `last_used_at`，
 * 不覆盖其它字段 —— 因为已有那行可能带着"我们自己的"标记与使用统计，
 * 被一次重复入库重置掉就丢信息了。
 */
export function upsertStickerAsset(db: DatabaseSync, input: UpsertStickerInput): UpsertStickerResult {
  const now = (input.now ?? new Date()).toISOString()
  const existing = findStickerBySha(db, input.sha256)
  if (existing !== undefined) {
    const scopes = input.scope === null || input.scope === undefined ? existing.scopes : withScope(existing.scopes, input.scope)
    db.prepare('UPDATE sticker_assets SET scopes = ?, last_used_at = ? WHERE id = ?').run(scopes, now, existing.id)
    return { id: existing.id, created: false, asset: { ...existing, scopes, last_used_at: now } }
  }

  const id = `stk_${randomUUID()}`
  db.prepare(
    `INSERT INTO sticker_assets
       (id, sha256, kind, mime, size_bytes, width, height, storage_path, source, source_url,
        ours, scopes, use_count, last_used_at, status, reject_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', NULL, ?)`,
  ).run(
    id,
    input.sha256,
    input.kind ?? 'sticker',
    input.mime,
    input.sizeBytes,
    input.width ?? null,
    input.height ?? null,
    input.storagePath,
    input.source,
    input.sourceUrl ?? null,
    input.ours === false ? 0 : 1,
    input.scope === null || input.scope === undefined ? '[]' : JSON.stringify([input.scope]),
    now,
  )
  const asset = getStickerAsset(db, id)
  if (asset === undefined) throw new Error('入库后取不到行（数据库异常）')
  return { id, created: true, asset }
}

/** 拒绝一条（白名单外来源 / 超大 / 非法类型）。**不留垃圾行**：记下来但标成 rejected。 */
export function rejectStickerAsset(
  db: DatabaseSync,
  input: { readonly sha256: string; readonly reason: string; readonly sourceUrl?: string | null; readonly now?: Date },
): string {
  const now = (input.now ?? new Date()).toISOString()
  const existing = findStickerBySha(db, input.sha256)
  if (existing !== undefined) {
    db.prepare("UPDATE sticker_assets SET status = 'rejected', reject_reason = ? WHERE id = ?").run(input.reason, existing.id)
    return existing.id
  }
  const id = `stk_${randomUUID()}`
  db.prepare(
    `INSERT INTO sticker_assets
       (id, sha256, kind, mime, size_bytes, storage_path, source, source_url, ours, scopes,
        use_count, status, reject_reason, created_at)
     VALUES (?, ?, 'rejected', 'application/octet-stream', 0, '', 'search', ?, 0, '[]', 0, 'rejected', ?, ?)`,
  ).run(id, input.sha256, input.sourceUrl ?? null, input.reason, now)
  return id
}

/** 存一条描述。 */
export function saveStickerDescription(
  db: DatabaseSync,
  input: {
    readonly assetId: string
    readonly description: string
    readonly emotionTags?: readonly string[]
    readonly model?: string | null
    readonly tokenCount?: number
    readonly now?: Date
  },
): string {
  const id = `sd_${randomUUID()}`
  db.prepare(
    `INSERT INTO sticker_descriptions (id, asset_id, description, emotion_tags, model, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.assetId,
    input.description,
    JSON.stringify(input.emotionTags ?? []),
    input.model ?? null,
    input.tokenCount ?? 0,
    (input.now ?? new Date()).toISOString(),
  )
  return id
}

/** 取某资产最新的一条描述。 */
export function findStickerDescription(db: DatabaseSync, assetId: string): StickerDescriptionRow | undefined {
  return db
    .prepare('SELECT * FROM sticker_descriptions WHERE asset_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(assetId) as StickerDescriptionRow | undefined
}

/** `describeStickerOnce` 的结果。 */
export interface DescribeOnceResult {
  readonly description: string
  readonly emotionTags: readonly string[]
  /** **是否真的调用了视觉模型**。测试断言这个为 false 就等于断言"没花钱"。 */
  readonly calledModel: boolean
  readonly assetId: string
}

/**
 * 只描述一次 —— **省钱主线的唯一入口**。
 *
 * 已有描述 ⇒ 直接返回，**不调用** `describe`。
 * 没有描述 ⇒ 调一次 `describe`，落库后返回。
 *
 * 为什么把"要不要调模型"的判断收进这里，而不是交给调用方：
 * 只要有一个调用点忘了先查，钱就悄悄花掉，而且**没有任何报错**。
 * 收进来之后，判断只有一处，测试也只守这一处。
 */
export async function describeStickerOnce(
  db: DatabaseSync,
  input: {
    readonly sha256: string
    readonly describe: () => Promise<{ description: string; emotionTags?: readonly string[]; model?: string; tokenCount?: number }>
    readonly now?: Date
  },
): Promise<DescribeOnceResult> {
  const asset = findStickerBySha(db, input.sha256)
  if (asset !== undefined) {
    const existing = findStickerDescription(db, asset.id)
    if (existing !== undefined) {
      return {
        description: existing.description,
        emotionTags: (() => {
          try {
            const parsed: unknown = JSON.parse(existing.emotion_tags)
            return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
          } catch {
            return []
          }
        })(),
        calledModel: false,
        assetId: asset.id,
      }
    }
  }

  // 走到这里说明确实没有可复用的描述 —— 这是唯一允许调用模型的路径
  const produced = await input.describe()
  const target =
    asset ??
    upsertStickerAsset(db, {
      sha256: input.sha256,
      mime: 'image/unknown',
      sizeBytes: 0,
      storagePath: '',
      source: 'learned',
      // 自动建行的场景都是「别人发的陌生表情」⇒ 必须标成学来的。
      // 不传的话默认 ours=true，会违反「能学但不主动转发」这条要求（测试抓到过）。
      ours: false,
      ...(input.now === undefined ? {} : { now: input.now }),
    }).asset
  saveStickerDescription(db, {
    assetId: target.id,
    description: produced.description,
    emotionTags: produced.emotionTags ?? [],
    model: produced.model ?? null,
    tokenCount: produced.tokenCount ?? 0,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return {
    description: produced.description,
    emotionTags: produced.emotionTags ?? [],
    calledModel: true,
    assetId: target.id,
  }
}

/** 记一次使用（LRU 的依据）。 */
export function touchStickerUse(db: DatabaseSync, id: string, now: Date = new Date()): void {
  db.prepare('UPDATE sticker_assets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(now.toISOString(), id)
}

/** 列表。 */
export function listStickerAssets(
  db: DatabaseSync,
  options: { readonly ours?: boolean; readonly status?: string; readonly limit?: number } = {},
): readonly StickerAssetRow[] {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)))
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (options.ours !== undefined) {
    clauses.push('ours = ?')
    params.push(options.ours ? 1 : 0)
  }
  if (options.status !== undefined) {
    clauses.push('status = ?')
    params.push(options.status)
  } else {
    clauses.push("status = 'active'")
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  params.push(limit)
  return db
    .prepare(`SELECT * FROM sticker_assets ${where} ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?`)
    .all(...params) as unknown as StickerAssetRow[]
}

/**
 * LRU 淘汰：只保留最近使用的 `keep` 条（**只淘汰 `ours = 0` 的学来的表情**）。
 *
 * 为什么不淘汰自己的：那些是用户主动收藏的，删掉等于删用户的东西。
 * 学来的表情是自动积累的，可以按容量回收。
 */
export function evictLearnedStickers(db: DatabaseSync, keep: number): number {
  const result = db
    .prepare(
      `UPDATE sticker_assets SET status = 'evicted'
        WHERE ours = 0 AND status = 'active' AND id NOT IN (
          SELECT id FROM sticker_assets WHERE ours = 0 AND status = 'active'
           ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?
        )`,
    )
    .run(Math.max(0, Math.floor(keep)))
  return Number(result.changes)
}
