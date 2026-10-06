import { readFileSync } from 'node:fs'
/**
 * 表情服务：把「入库 → 描述 → 检索 → 发送」串成一条可用的链。
 *
 * ## 为什么要有这一层，而不是让工具直接调各模块
 *
 * 因为有一条**产品约束**必须在一个地方守住：
 * **学来的表情（`ours = 0`）默认不主动转发**（用户明确要求："能学，但不拿去用"）。
 * 如果发送逻辑散在工具里，那么"某个工具忘了判 ours"就是一个
 * **会往别人群里发我们不认识来源的图**的 bug —— 而且它不会报错，只会悄悄发出去。
 *
 * 所以 `sendSticker()` 是唯一出口，`ours` 判断只在这里做一次。
 *
 * ## 描述与发送分开
 *
 * `addSticker()` 负责"入库并确保有描述"（走 `describeStickerOnce`，第二次同图 0 次视觉调用）；
 * `sendSticker()` 只负责"挑一个并排队发出去"。分开的理由是它们的失败模式完全不同：
 * 前者失败是"少一条可用表情"，后者失败是"往聊天里发错东西"。
 *
 * @module @forlife/gateway/sticker-service
 */
import type { DatabaseSync } from 'node:sqlite'

import { describeStickerOnce, getStickerAsset, markStickerOurs, rejectStickerAsset, touchStickerUse, type StickerAssetRow, type StickerSource } from '@forlife/store'

import { enqueueOutbound } from './outbox.ts'
import { checkMediaBytes, checkSourceUrl, DEFAULT_MEDIA_WHITELIST, fingerprintOf, ingestSticker, MAX_MEDIA_BYTES, type IngestStickerResult } from './stickers.ts'
import type { StickerFetcher } from './sticker-restock.ts'
import type { WatermarkChecker } from './sticker-watermark.ts'
import { searchStickers, type StickerHit } from './sticker-search.ts'
import type { StickerVisionDescriber } from './sticker-vision.ts'

/** 服务配置。 */
export interface StickerServiceOptions {
  readonly db: DatabaseSync
  /** 表情文件落盘目录。 */
  readonly storageRoot: string
  /** 视觉描述器。**不给就只入库、不生成描述**（描述缺失时检索靠标签，仍可用）。 */
  readonly describer?: StickerVisionDescriber | undefined
  readonly whitelist?: readonly string[]
  /** 下载器（注入以便离线测试；不给则用真实 HTTP）。 */
  readonly fetcher?: StickerFetcher | undefined
  /**
   * 水印检查器。**不给就拒绝导入**（用户的硬要求：绝对不允许带水印的表情）。
   *
   * 为什么 fail-closed：放行的代价是把带水印的表情发到群里 —— 那是对外的错误，
   * 比「暂时存不进表情」严重得多。
   */
  readonly watermark?: WatermarkChecker | undefined
  readonly log?: (message: string) => void
}

/** 入库结果（带描述）。 */
export interface AddStickerResult {
  readonly status: IngestStickerResult['status']
  readonly reason: string
  readonly assetId?: string
  readonly description?: string
  readonly emotionTags?: readonly string[]
  /** **是否真的调用了视觉模型** —— 第二次同图必须是 false（省钱主线）。 */
  readonly calledModel?: boolean
}

/** 发送结果。 */
export interface SendStickerResult {
  readonly ok: boolean
  readonly reason: string
  readonly assetId?: string
  readonly outboundId?: string
  readonly score?: number
}

/** 表情服务。 */
export interface StickerService {
  add: (input: {
    readonly bytes: Uint8Array
    readonly mime: string
    readonly source: StickerSource
    readonly sourceUrl?: string | undefined
    readonly scope?: string | undefined
    readonly ours?: boolean
    readonly describe?: boolean
  }) => Promise<AddStickerResult>
  find: (query: string, options?: { readonly limit?: number }) => readonly StickerHit[]
  /**
   * 按 URL 导入一张图（**搜索归模型，安全下载归我们**）。
   *
   * 为什么这样分工：模型在轮次里本来就有搜索工具，让它去找图最自然；
   * 而「下载任意 URL」是危险动作（SSRF、超大文件、非法类型、来源审计），
   * 必须走我们这一条带白名单与校验的路。
   */
  importFromUrl: (input: {
    readonly url: string
    readonly scope?: string | undefined
    readonly ours?: boolean
    readonly describe?: boolean
  }) => Promise<AddStickerResult>
  send: (input: {
    readonly to: string
    readonly query?: string | undefined
    readonly assetId?: string | undefined
    readonly replyTo?: string | undefined
    readonly conversationKind?: 'private' | 'group'
    /** 允许发送学来的表情（默认 false —— 用户要求"能学但不主动转发"）。 */
    readonly allowLearned?: boolean
  }) => SendStickerResult
}


/**
 * 默认下载器：**流式**读取并卡大小上限。
 *
 * 为什么不用 `await response.arrayBuffer()` 再检查大小：那时整个文件**已经进内存了** ——
 * 一个 500 MiB 的响应会把进程拖垮，而我们的上限是 5 MiB。
 * 所以先看 `content-length`（能挡住绝大多数），再逐块累加、超限立刻中断。
 */
const defaultFetcher: StickerFetcher = async (url) => {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-forlife/0.1' } })
  const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ?? 'application/octet-stream'
  if (!response.ok) return { ok: false, mime, bytes: new Uint8Array(), reason: `HTTP ${String(response.status)}` }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    return { ok: false, mime, bytes: new Uint8Array(), reason: `声明大小超限（${String(declared)} 字节）` }
  }

  const reader = response.body?.getReader()
  if (reader === undefined) {
    // 拿不到流（老环境）就退回整体读取，但**仍然检查大小**
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > MAX_MEDIA_BYTES) return { ok: false, mime, bytes: new Uint8Array(), reason: '实际大小超限' }
    return { ok: true, mime, bytes: buffer }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel()
      return { ok: false, mime, bytes: new Uint8Array(), reason: `超过上限（读到 ${String(total)} 字节即中断）` }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, mime, bytes }
}
/** 创建表情服务。 */
/**
 * 把表情文件读成 OneBot 的 `base64://` 形式。
 *
 * **为什么不能直接给本地路径**：NapCat 跑在 Docker（Linux）里，
 * 而文件在 Windows 的 `D:\` 上 —— 容器里没有那个盘。
 * 真机报错是 `文件处理失败: 识别URL失败`（因为 OneBot 的 `file` 字段
 * 接受 URL / `base64://` / 容器内路径，唯独不接受宿主机路径）。
 *
 * **为什么用 base64 而不是 URL**：URL 要求 NapCat 能访问到那个地址
 * （要暴露文件服务 + 容器能路由到宿主，因部署而异）；
 * `base64://` 把内容直接放进消息体，**不依赖任何网络可达性**。
 *
 * 读不到时**抛出**（由调用方转成明确失败）—— 退化成路径等于把原 bug 留下。
 */
function readStickerAsBase64(storagePath: string, log: (m: string) => void): string {
  try {
    const bytes = readFileSync(storagePath)
    return `base64://${bytes.toString('base64')}`
  } catch (error) {
    log(`表情文件读不到（${storagePath}）：${String(error).slice(0, 120)}`)
    throw new Error(`表情文件读不到：${String(error).slice(0, 120)}`)
  }
}

export function createStickerService(options: StickerServiceOptions): StickerService {
  const { db } = options
  const log = options.log ?? ((): void => {})

  return {
    async importFromUrl(input): Promise<AddStickerResult> {
      // ① 白名单**在下载前**判：判晚了，恶意 URL 已经让我们发起了请求（SSRF 入口）
      const sourceCheck = checkSourceUrl(input.url, options.whitelist ?? DEFAULT_MEDIA_WHITELIST)
      if (!sourceCheck.ok) return { status: 'rejected', reason: sourceCheck.reason }

      // ② 下载（大小上限在下载器里兜住：不能等整个文件进内存才发现它 500 MiB）
      const fetcher = options.fetcher ?? defaultFetcher
      let downloaded: Awaited<ReturnType<StickerFetcher>>
      try {
        downloaded = await fetcher(input.url)
      } catch (error) {
        return { status: 'rejected', reason: `下载失败：${String(error)}` }
      }
      if (!downloaded.ok) return { status: 'rejected', reason: downloaded.reason ?? '下载失败' }

      // ③ 走同一条入库管线（类型/大小/指纹都再判一次）
      return await this.add({
        bytes: downloaded.bytes,
        mime: downloaded.mime,
        source: 'search',
        sourceUrl: input.url,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.ours === undefined ? {} : { ours: input.ours }),
        ...(input.describe === undefined ? {} : { describe: input.describe }),
      })
    },

    async add(input): Promise<AddStickerResult> {
      // ★ 水印闸门（用户硬要求）。放在**最前面**，且就在这一层 ——
      //   add 是唯一入口：手动导入 / 联网抓取 / 自造 / 学别人的四条路径都经过它，
      //   所以没有任何地方能绕过去。先做便宜的字节校验，避免把明显非法的东西送给模型。
      const bytesCheck = checkMediaBytes({ mime: input.mime, sizeBytes: input.bytes.byteLength })
      if (!bytesCheck.ok) return { status: 'rejected', reason: bytesCheck.reason }

      const checker = options.watermark
      if (checker === undefined) {
        return {
          status: 'rejected',
          reason: '没有配置视觉模型 ⇒ 无法检查水印，拒绝导入（绝对不允许带水印的表情）',
        }
      }
      let verdict: Awaited<ReturnType<WatermarkChecker>>
      try {
        verdict = await checker(input.bytes, input.mime)
      } catch (error) {
        // 检查本身失败也**不能放行**：查不了就不许用
        return { status: 'rejected', reason: `水印检查失败 ⇒ 拒绝导入：${String(error)}` }
      }
      if (verdict.hasWatermark) {
        const sha256 = fingerprintOf(input.bytes)
        rejectStickerAsset(db, {
          sha256,
          reason: `带水印：${verdict.evidence}`,
          ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        })
        return { status: 'rejected', reason: `带水印，已拒绝入库：${verdict.evidence}` }
      }

      const ingested = ingestSticker({
        db,
        bytes: input.bytes,
        mime: input.mime,
        source: input.source,
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.ours === undefined ? {} : { ours: input.ours }),
        storageRoot: options.storageRoot,
        ...(options.whitelist === undefined ? {} : { whitelist: options.whitelist }),
      })
      if (ingested.status === 'rejected') return { status: 'rejected', reason: ingested.reason }
      if (ingested.sha256 === undefined || ingested.assetId === undefined) {
        return { status: ingested.status, reason: ingested.reason }
      }

      // 用户明确收藏（ours=true）⇒ **显式提升**。
      // 不做这一步的话，一张先被学来、后被收藏的图永远发不出去 ——
      // 而"先学来、后收藏"正是最常见的顺序。
      if (input.ours === true && ingested.assetId !== undefined) markStickerOurs(db, ingested.assetId)

      // 不给描述器 / 显式不要描述 ⇒ 到此为止（检索仍能靠标签工作）
      if (options.describer === undefined || input.describe === false) {
        return { status: ingested.status, reason: `${ingested.reason}（未生成描述：没有配置视觉描述器）`, assetId: ingested.assetId }
      }

      // describeStickerOnce 会在已有描述时**直接返回、不调模型**（省钱主线）
      const described = await describeStickerOnce(db, {
        sha256: ingested.sha256,
        describe: async () => {
          const asset = getStickerAsset(db, ingested.assetId ?? '')
          const bytes = input.bytes
          void asset
          return await options.describer!(bytes, input.mime)
        },
      })
      return {
        status: ingested.status,
        reason: `${ingested.reason}；描述${described.calledModel ? '已生成' : '复用已有（0 次视觉调用）'}`,
        assetId: described.assetId,
        description: described.description,
        emotionTags: described.emotionTags,
        calledModel: described.calledModel,
      }
    },

    find(query, findOptions = {}): readonly StickerHit[] {
      return searchStickers(db, query, { limit: findOptions.limit ?? 5 })
    },

    send(input): SendStickerResult {
      let asset: StickerAssetRow | undefined
      let score: number | undefined

      if (input.assetId !== undefined && input.assetId !== '') {
        asset = getStickerAsset(db, input.assetId)
        if (asset === undefined) return { ok: false, reason: `找不到表情 ${input.assetId}` }
      } else if (input.query !== undefined && input.query.trim() !== '') {
        const hits = searchStickers(db, input.query, { limit: 1 })
        const top = hits[0]
        if (top === undefined) {
          // 没命中要如实回报：调用方据此决定"要不要去补货"，而不是收到一个沉默的失败
          return { ok: false, reason: `没有匹配「${input.query}」的表情（可以先去联网抓一张，或换个说法）` }
        }
        asset = top.asset
        score = top.score
      } else {
        return { ok: false, reason: '必须给 query 或 assetId 之一' }
      }

      if (asset.status !== 'active') {
        return { ok: false, reason: `表情 ${asset.id} 状态是 ${asset.status}，不能发送` }
      }

      // ★ 产品约束的唯一守点：学来的表情默认不主动转发
      if (asset.ours !== 1 && input.allowLearned !== true) {
        return {
          ok: false,
          reason: '这是「学来的」表情（别人发的），默认不主动转发。确实要发就显式允许。',
          assetId: asset.id,
        }
      }

      const segments: Record<string, unknown>[] = []
      // 回复引用要排在前面：QQ 侧的回复关系由第一个段决定
      if (input.replyTo !== undefined && input.replyTo !== '') segments.push({ kind: 'reply', messageId: input.replyTo })
      segments.push({ kind: 'sticker', file: readStickerAsBase64(asset.storage_path, log) })

      const outboundId = enqueueOutbound(db, {
        conversationKey: input.to,
        kind: 'sticker',
        payload: { segments },
        conversationKind: input.conversationKind ?? 'private',
        source: 'model',
      })
      touchStickerUse(db, asset.id)
      log(`表情已入队：${asset.id} → ${input.to}（第 ${String(asset.use_count + 1)} 次使用）`)

      return {
        ok: true,
        reason: `已交给发送队列（${asset.sha256.slice(0, 12)}…）`,
        assetId: asset.id,
        outboundId,
        ...(score === undefined ? {} : { score }),
      }
    },
  }
}
