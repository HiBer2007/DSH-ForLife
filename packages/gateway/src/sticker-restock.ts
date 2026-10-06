/**
 * 缺货自动补货（PLAN 阶段六的进阶验收）。
 *
 * 验收原文：**库内检索低于阈值 → 自动联网抓取入库并发送（一次调用完成）；
 * 每轮抓取不超过 3 张；白名单外来源被拒。**
 *
 * ## 三个必须在这一层守住的约束
 *
 * 1. **每轮上限**（默认 3，来自 PLAN 参数 `sticker.autoFetch.perTurnLimit`）。
 *    上限按"轮"算而不是按"天"算 —— 所以计数器由调用方持有、每轮开始清零。
 *    做成全局累计的话，第一轮就会把额度用光，之后永远不再补货。
 * 2. **白名单**：下载前就要判，不是下载完再判。判晚了，恶意的 URL 已经
 *    让我们发起了请求（SSRF 的入口），而且流量已经花掉。
 * 3. **fail-closed**：没配置搜索源时**不补货**，而不是"随便找个源"。
 *    搜索引擎的选择是用户的决定（涉及费用与内容来源），不该由代码替他挑。
 *
 * ## 搜索源是可插拔的
 *
 * 我没有得到任何搜索 API 的授权，所以这里只定义接口、不内置实现。
 * 这样"编排逻辑"（上限、白名单、入库、去重）现在就能测，而"用哪个源"
 * 等用户决定后注入即可。
 *
 * @module @forlife/gateway/sticker-restock
 */
import type { DatabaseSync } from 'node:sqlite'

import { checkSourceUrl, DEFAULT_MEDIA_WHITELIST, ingestSticker } from './stickers.ts'
import { searchStickers } from './sticker-search.ts'
import type { StickerVisionDescriber } from './sticker-vision.ts'
import { describeStickerOnce } from '@forlife/store'

/** 搜索源返回的一个候选。 */
export interface SearchCandidate {
  readonly url: string
  /** 搜索源已知的 MIME（没有则下载后按响应头判断）。 */
  readonly mime?: string
  readonly title?: string
}

/** 可插拔的搜索源。 */
export type StickerSearcher = (query: string) => Promise<readonly SearchCandidate[]>

/** 每轮的抓取额度。**由调用方持有并每轮清零** —— 全局累计会让额度第一轮就用光。 */
export interface RestockBudget {
  used: number
  readonly limit: number
}

/** 新建一份额度。 */
export function newRestockBudget(limit = 3): RestockBudget {
  return { used: 0, limit: Math.max(0, Math.floor(limit)) }
}

/** 下载器（注入以便离线测试）。 */
export type StickerFetcher = (url: string) => Promise<{ readonly ok: boolean; readonly mime: string; readonly bytes: Uint8Array; readonly reason?: string }>

/** 补货配置。 */
export interface RestockOptions {
  readonly db: DatabaseSync
  readonly storageRoot: string
  readonly searcher?: StickerSearcher | undefined
  readonly fetcher: StickerFetcher
  readonly describer?: StickerVisionDescriber | undefined
  readonly budget: RestockBudget
  readonly whitelist?: readonly string[]
  /** 库内检索低于这个分数就认为"缺货"（默认 0.25）。 */
  readonly minScore?: number
  readonly scope?: string | undefined
  readonly now?: Date
}

/** 补货结果。 */
export interface RestockResult {
  readonly status: 'not-needed' | 'restocked' | 'exhausted' | 'unavailable' | 'failed'
  readonly reason: string
  readonly assetId?: string
  readonly description?: string
  /** 这一轮实际抓了几张（用于观察是否总在打满额度）。 */
  readonly fetched: number
  readonly skipped: readonly string[]
}

/**
 * 确保库里有能匹配 `query` 的表情；不够就联网补一张。
 *
 * 返回值刻意区分了五种状态，因为它们的**处置方式完全不同**：
 *  - `not-needed`：库里有 ⇒ 直接用（省钱）
 *  - `restocked`：抓到了 ⇒ 用新的
 *  - `exhausted`：本轮额度用完 ⇒ 本轮别再试了（**不是错误**）
 *  - `unavailable`：没配搜索源 ⇒ 需要用户决定（**不是错误**）
 *  - `failed`：搜索/下载/校验都失败 ⇒ 可以换个说法重试
 */
export async function restockSticker(query: string, options: RestockOptions): Promise<RestockResult> {
  const minScore = options.minScore ?? 0.25

  // ① 先查库：够用就别花钱（"省钱主线"在补货路径上的体现）
  const hits = searchStickers(options.db, query, { limit: 1 })
  const top = hits[0]
  if (top !== undefined && top.score >= minScore) {
    return { status: 'not-needed', reason: `库里已有匹配（${top.score.toFixed(2)}）`, assetId: top.asset.id, fetched: 0, skipped: [] }
  }

  // ② 没配搜索源 ⇒ 明确告诉调用方"这需要人来决定"，而不是随便找个源
  if (options.searcher === undefined) {
    return {
      status: 'unavailable',
      reason: '没有配置联网搜索源 ⇒ 不补货（fail-closed）。搜索源的选择涉及费用与内容来源，应由人决定。',
      fetched: 0,
      skipped: [],
    }
  }

  // ③ 额度闸门
  if (options.budget.used >= options.budget.limit) {
    return {
      status: 'exhausted',
      reason: `本轮抓取额度已用完（${String(options.budget.used)}/${String(options.budget.limit)}），下一轮再试`,
      fetched: 0,
      skipped: [],
    }
  }

  // ④ 搜索
  let candidates: readonly SearchCandidate[]
  try {
    candidates = await options.searcher(query)
  } catch (error) {
    return { status: 'failed', reason: `搜索失败：${String(error)}`, fetched: 0, skipped: [] }
  }

  const whitelist = options.whitelist ?? DEFAULT_MEDIA_WHITELIST
  const skipped: string[] = []

  for (const candidate of candidates) {
    if (options.budget.used >= options.budget.limit) {
      return { status: 'exhausted', reason: `抓取过程中额度用尽（${String(options.budget.used)}/${String(options.budget.limit)}）`, fetched: options.budget.used, skipped }
    }

    // ⑤ **下载前**就判白名单：判晚了，恶意的 URL 已经让我们发起了请求（SSRF 入口），流量也花了
    const sourceCheck = checkSourceUrl(candidate.url, whitelist)
    if (!sourceCheck.ok) {
      skipped.push(`${candidate.url} —— ${sourceCheck.reason}`)
      continue
    }

    // ⑥ 下载（记额度：一次尝试算一次，避免"失败的尝试"被无限重试绕过上限）
    options.budget.used += 1
    let fetched: Awaited<ReturnType<StickerFetcher>>
    try {
      fetched = await options.fetcher(candidate.url)
    } catch (error) {
      skipped.push(`${candidate.url} —— 下载异常：${String(error)}`)
      continue
    }
    if (!fetched.ok) {
      skipped.push(`${candidate.url} —— ${fetched.reason ?? '下载失败'}`)
      continue
    }

    // ⑦ 入库（走同一条管线：类型/大小/白名单都再判一次，指纹去重）
    const ingested = ingestSticker({
      db: options.db,
      bytes: fetched.bytes,
      mime: fetched.mime,
      source: 'search',
      sourceUrl: candidate.url,
      storageRoot: options.storageRoot,
      whitelist,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (ingested.status === 'rejected') {
      skipped.push(`${candidate.url} —— ${ingested.reason}`)
      continue
    }

    // ⑧ 顺手生成描述（已有描述则 0 次视觉调用）
    let description: string | undefined
    if (options.describer !== undefined && ingested.sha256 !== undefined) {
      const describer = options.describer
      const described = await describeStickerOnce(options.db, {
        sha256: ingested.sha256,
        describe: async () => await describer(fetched.bytes, fetched.mime),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      description = described.description
    }

    return {
      status: 'restocked',
      reason: `已补货并入库（${ingested.status === 'duplicate' ? '指纹已存在，复用' : '新增'}）`,
      ...(ingested.assetId === undefined ? {} : { assetId: ingested.assetId }),
      ...(description === undefined ? {} : { description }),
      fetched: options.budget.used,
      skipped,
    }
  }

  return {
    status: 'failed',
    reason: candidates.length === 0 ? '搜索源没有返回任何结果' : `所有候选都不可用（跳过 ${String(skipped.length)} 个）`,
    fetched: options.budget.used,
    skipped,
  }
}
