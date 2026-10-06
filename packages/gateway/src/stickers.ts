/**
 * 表情与媒体的入库管线：**校验 → 指纹 → 去重 → 落盘 → 登记**。
 *
 * ## 为什么校验必须在这一层，而不是在调用方
 *
 * PLAN 阶段六有一条验收：**非白名单来源 / 超大 / 非法类型被拒绝，且库里不留垃圾行**。
 * 如果校验散在各个调用点（手动导入、联网抓取、学别人的表情），
 * 那么"联网抓取"那条路少写一句白名单检查，就是一个**远程可触发的写盘漏洞**。
 *
 * 所以这里只有一个入口 `ingestSticker()`，四条路径都走它。
 *
 * ## 顺序很重要
 *
 * 先校验来源与字节，**再**算指纹落盘。反过来（先落盘再校验）会在磁盘上留下
 * 被拒绝的文件 —— 那正是"库里不留垃圾行"想避免的情况，只不过从库里换到了盘上。
 *
 * @module @forlife/gateway/stickers
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { findStickerBySha, rejectStickerAsset, upsertStickerAsset, type StickerSource } from '@forlife/store'

/**
 * 默认允许的下载域名。
 *
 * 这些是 QQ 媒体 CDN 的域名族。**它们会变**，所以：
 *  - 白名单可配置（`FORLIFE_MEDIA_WHITELIST`），部署时应按自己 NapCat 版本的实际 payload 核对；
 *  - 匹配用**后缀**（`gchat.qpic.cn` 也允许 `a.gchat.qpic.cn`），但不允许"任意子域"式的通配
 *    （`*.qq.com` 会让任何 qq.com 子域都能让我们下载并落盘）。
 */
export const DEFAULT_MEDIA_WHITELIST: readonly string[] = [
  'gchat.qpic.cn',
  'c2cpicdw.qpic.cn',
  'multimedia.nt.qq.com.cn',
  'pic.qq.com',
]

/** 允许的 MIME（只收图片；文件走另一条路）。 */
export const ALLOWED_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 单张上限：5 MiB。表情包再大就不是表情包了。 */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024

/** 校验结果。 */
export interface CheckResult {
  readonly ok: boolean
  readonly reason: string
}

/** 来源校验：只允许白名单内的 http(s) 域名。 */
export function checkSourceUrl(url: string, whitelist: readonly string[] = DEFAULT_MEDIA_WHITELIST): CheckResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `来源不是合法 URL：${url.slice(0, 80)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http(s) 来源，实际是 ${parsed.protocol}` }
  }
  if (whitelist.length === 0) {
    // fail-closed：白名单为空时**拒绝一切**，而不是"没配就都放行"
    return { ok: false, reason: '白名单为空 ⇒ 拒绝（fail-closed；请配置 FORLIFE_MEDIA_WHITELIST）' }
  }
  const host = parsed.hostname.toLowerCase()
  const matched = whitelist.some((allowed) => {
    const entry = allowed.toLowerCase().trim()
    return entry !== '' && (host === entry || host.endsWith(`.${entry}`))
  })
  return matched ? { ok: true, reason: `来源在白名单内：${host}` } : { ok: false, reason: `来源不在白名单：${host}` }
}

/** 字节校验：类型与大小。 */
export function checkMediaBytes(input: { readonly mime: string; readonly sizeBytes: number }): CheckResult {
  const mime = input.mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!ALLOWED_MIME.includes(mime)) {
    return { ok: false, reason: `类型不允许：${mime}（只收 ${ALLOWED_MIME.join(' / ')}）` }
  }
  if (input.sizeBytes <= 0) return { ok: false, reason: '空文件' }
  if (input.sizeBytes > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      reason: `超过上限：${(input.sizeBytes / 1024 / 1024).toFixed(1)} MiB > ${String(MAX_MEDIA_BYTES / 1024 / 1024)} MiB`,
    }
  }
  return { ok: true, reason: '类型与大小都合规' }
}

/** 内容指纹。 */
export function fingerprintOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** MIME → 扩展名（落盘用；未知则 .bin）。 */
function extensionFor(mime: string): string {
  switch (mime.split(';')[0]?.trim().toLowerCase()) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    default:
      return '.bin'
  }
}

/** 入库输入。 */
export interface IngestStickerInput {
  readonly db: DatabaseSync
  readonly bytes: Uint8Array
  readonly mime: string
  readonly source: StickerSource
  /** 联网抓取时必填（要过白名单）；手动/自造可省。 */
  readonly sourceUrl?: string | undefined
  readonly scope?: string | undefined
  readonly ours?: boolean
  readonly storageRoot: string
  readonly whitelist?: readonly string[]
  readonly now?: Date
}

/** 入库结果。 */
export interface IngestStickerResult {
  readonly status: 'created' | 'duplicate' | 'rejected'
  readonly reason: string
  readonly assetId?: string
  readonly sha256?: string
  readonly storagePath?: string
}

/**
 * 入库一条表情/图片。
 *
 * 四条路径（手动 / 联网抓取 / 自造 / 学别人的）**都走这里**，
 * 所以"非白名单被拒"这件事只需要在一个地方做对。
 */
export function ingestSticker(input: IngestStickerInput): IngestStickerResult {
  const now = input.now ?? new Date()

  // ① 来源校验（联网抓取才需要；手动导入没有来源 URL）
  if (input.sourceUrl !== undefined && input.sourceUrl !== '') {
    const sourceCheck = checkSourceUrl(input.sourceUrl, input.whitelist ?? DEFAULT_MEDIA_WHITELIST)
    if (!sourceCheck.ok) {
      // 记一行 rejected 而不是静默丢弃：拒绝也要留证据（审计要求）
      rejectStickerAsset(input.db, {
        sha256: fingerprintOf(input.bytes),
        reason: sourceCheck.reason,
        sourceUrl: input.sourceUrl,
        now,
      })
      return { status: 'rejected', reason: sourceCheck.reason }
    }
  }

  // ② 字节校验
  const bytesCheck = checkMediaBytes({ mime: input.mime, sizeBytes: input.bytes.byteLength })
  if (!bytesCheck.ok) {
    rejectStickerAsset(input.db, {
      sha256: fingerprintOf(input.bytes),
      reason: bytesCheck.reason,
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
      now,
    })
    return { status: 'rejected', reason: bytesCheck.reason }
  }

  // ③ 指纹（校验通过之后才算、才落盘）
  const sha256 = fingerprintOf(input.bytes)

  // ④ 去重：指纹命中就**不重复落盘**（省磁盘，也省一次写）
  const existing = findStickerBySha(input.db, sha256)
  if (existing !== undefined && existing.status === 'active') {
    const result = upsertStickerAsset(input.db, {
      sha256,
      mime: input.mime,
      sizeBytes: input.bytes.byteLength,
      storagePath: existing.storage_path,
      source: input.source,
      sourceUrl: input.sourceUrl ?? null,
      ...(input.ours === undefined ? {} : { ours: input.ours }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      now,
    })
    return { status: 'duplicate', reason: '指纹已存在 ⇒ 复用原行（不新增、不重复落盘）', assetId: result.id, sha256, storagePath: existing.storage_path }
  }

  // ⑤ 落盘
  mkdirSync(input.storageRoot, { recursive: true })
  const storagePath = join(input.storageRoot, `${sha256}${extensionFor(input.mime)}`)
  writeFileSync(storagePath, input.bytes)

  // ⑥ 登记
  const result = upsertStickerAsset(input.db, {
    sha256,
    mime: input.mime,
    sizeBytes: input.bytes.byteLength,
    storagePath,
    source: input.source,
    sourceUrl: input.sourceUrl ?? null,
    ...(input.ours === undefined ? {} : { ours: input.ours }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    now,
  })
  return {
    status: 'created',
    reason: `入库成功（${String(input.bytes.byteLength)} 字节，${extname(storagePath)}）`,
    assetId: result.id,
    sha256,
    storagePath,
  }
}
