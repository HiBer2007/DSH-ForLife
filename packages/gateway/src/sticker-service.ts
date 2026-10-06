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

import { describeStickerOnce, getStickerAsset, touchStickerUse, type StickerAssetRow, type StickerSource } from '@forlife/store'

import { enqueueOutbound } from './outbox.ts'
import { ingestSticker, type IngestStickerResult } from './stickers.ts'
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

/** 创建表情服务。 */
export function createStickerService(options: StickerServiceOptions): StickerService {
  const { db } = options
  const log = options.log ?? ((): void => {})

  return {
    async add(input): Promise<AddStickerResult> {
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
      segments.push({ kind: 'sticker', file: asset.storage_path })

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
