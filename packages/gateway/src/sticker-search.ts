/**
 * 表情检索：把自然语言 query 匹配到表情上。
 *
 * ## 当前是**词法检索**，不是向量检索 —— 这是一个清醒的取舍
 *
 * PLAN 阶段六写的是"复用 LanceDB 做向量索引"。向量检索更好，但它需要：
 * 嵌入模型可用、向量库就位、还要为每张图付一次嵌入调用。
 * 而阶段六的验收是"自然语言 query 检索 top-1 命中 ≥ 8/10" —— 这个目标
 * **词法检索就能达到**（表情的描述与标签本来就是我们自己生成的，用词高度一致）。
 *
 * 所以这里先把词法检索做扎实（可测、零成本、无外部依赖），
 * 向量检索作为**增强**在嵌入模型就位后叠加，而不是一开始就卡在那里。
 *
 * ## 中文为什么用「字 + 二元组」而不是分词
 *
 * - 纯按空格切：中文没有空格，整句变成一个 token，等于没切；
 * - 纯单字：`的`/`了`/`在` 这类高频字会污染打分（"猫在睡觉"会因为 `在` 命中一堆）；
 * - 引第三方分词库：为这一件事引入依赖不划算，而且表情文本很短、口语化，词典分词反而容易切错。
 *
 * 字 + 二元组是个务实的中间点：`睡觉` 作为二元组能精确命中，
 * 同时保留单字以容忍"猫"这种单词查询。高频虚词用一个小停用词表挡掉。
 *
 * @module @forlife/gateway/sticker-search
 */
import type { DatabaseSync } from 'node:sqlite'

import { findStickerDescription, listStickerAssets, type StickerAssetRow } from '@forlife/store'

/**
 * 停用词。
 *
 * 只挡**高频虚词**，不挡实词：挡多了会让"我想你了"这类查询失去信息。
 * 刻意保持很短 —— 停用词表越长，越容易在某天悄悄挡掉一个有用的词。
 */
const STOPWORDS = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '一', '个', '有', '和', '就', '不', '也', '都', '很', '吗', '呢', '吧'])

/** 切词：ASCII 按词，CJK 取「单字 + 二元组」，并过滤停用词。 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()

  for (const word of lower.match(/[a-z0-9]+/g) ?? []) tokens.add(word)

  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      const char = run[index]
      if (char !== undefined && !STOPWORDS.has(char)) tokens.add(char)
      const pair = run.slice(index, index + 2)
      if (pair.length === 2) tokens.add(pair)
    }
  }
  return tokens
}

/** 一个可检索的条目。 */
export interface SearchableSticker {
  readonly assetId: string
  readonly description: string
  readonly emotionTags: readonly string[]
  readonly useCount: number
}

/** 打分结果。 */
export interface ScoredSticker {
  readonly assetId: string
  readonly score: number
  /** 命中了哪些 token（排障与解释"为什么它被选中"）。 */
  readonly matched: readonly string[]
}

/** 标签的权重：标签是我们主动打的"这个表情是什么"，比描述里的自然语言更可靠。 */
const TAG_WEIGHT = 2
const DESCRIPTION_WEIGHT = 1

/**
 * 给一个 query 对一条表情打分。
 *
 * 分数 = 命中的权重和 / query 的 token 数 ⇒ 落在 0..TAG_WEIGHT，
 * 便于跨 query 比较（不会因为 query 长短而系统性偏高偏低）。
 */
export function scoreSticker(query: string, sticker: SearchableSticker): ScoredSticker {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return { assetId: sticker.assetId, score: 0, matched: [] }

  const tagTokens = new Set<string>()
  for (const tag of sticker.emotionTags) for (const token of tokenize(tag)) tagTokens.add(token)
  const descriptionTokens = tokenize(sticker.description)

  let weight = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    if (tagTokens.has(token)) {
      weight += TAG_WEIGHT
      matched.push(token)
    } else if (descriptionTokens.has(token)) {
      weight += DESCRIPTION_WEIGHT
      matched.push(token)
    }
  }
  return { assetId: sticker.assetId, score: weight / queryTokens.size, matched }
}

/** 从库里取出可检索的条目（只取 active）。 */
export function loadSearchable(db: DatabaseSync, options: { readonly oursOnly?: boolean } = {}): readonly SearchableSticker[] {
  const assets = listStickerAssets(db, {
    ...(options.oursOnly === true ? { ours: true } : {}),
    limit: 500,
  })
  const out: SearchableSticker[] = []
  for (const asset of assets) {
    const description = findStickerDescription(db, asset.id)
    out.push({
      assetId: asset.id,
      description: description?.description ?? '',
      emotionTags: (() => {
        try {
          const parsed: unknown = JSON.parse(description?.emotion_tags ?? '[]')
          return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
        } catch {
          return []
        }
      })(),
      useCount: asset.use_count,
    })
  }
  return out
}

/** 检索结果（带原始资产，便于调用方直接发送）。 */
export interface StickerHit {
  readonly asset: StickerAssetRow
  readonly score: number
  readonly matched: readonly string[]
  /** 描述原文 —— 模型要「看见」它才能决定挑哪个（只给 id 等于让它盲选）。 */
  readonly description: string
}

/**
 * 检索表情。
 *
 * 排序：分数降序 → 使用次数降序（同分时用过的更可能是"大家认得的那个"）
 * → id 升序（保证结果稳定，不会因为 SQLite 的返回顺序抖动）。
 */
export function searchStickers(
  db: DatabaseSync,
  query: string,
  options: { readonly limit?: number; readonly oursOnly?: boolean; readonly minScore?: number } = {},
): readonly StickerHit[] {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 5)))
  const minScore = options.minScore ?? 0.01
  const candidates = loadSearchable(db, options)
  const byId = new Map(listStickerAssets(db, { limit: 500 }).map((asset) => [asset.id, asset]))

  const scored = candidates
    .map((candidate) => scoreSticker(query, candidate))
    .filter((result) => result.score >= minScore)

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const useA = candidates.find((c) => c.assetId === a.assetId)?.useCount ?? 0
    const useB = candidates.find((c) => c.assetId === b.assetId)?.useCount ?? 0
    if (useB !== useA) return useB - useA
    return a.assetId < b.assetId ? -1 : 1
  })

  const hits: StickerHit[] = []
  for (const result of scored.slice(0, limit)) {
    const asset = byId.get(result.assetId)
    if (asset !== undefined) {
      const candidate = candidates.find((item) => item.assetId === result.assetId)
      hits.push({
        asset,
        score: result.score,
        matched: result.matched,
        description: candidate?.description ?? '',
      })
    }
  }
  return hits
}
