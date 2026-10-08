/**
 * 「喂食记忆」页的数据结构（与 gateway `POST /api/admin/feed` 的响应一一对应）。
 *
 * 与 `packages/gateway/src/feed.ts` 的 `FeedResult` 保持一致；这里只声明**前端会用到**的字段，
 * 不做全量镜像 —— 多声明一个字段就多一处"看着像契约、其实没人用"的噪音。
 */

/** 喂食目标：知识进长期记忆，经历进中期记忆。 */
export type FeedKind = 'knowledge' | 'experience'

/** 一段资料的处理动作（与核心的 `FeedAction` 同名同义）。 */
export type FeedAction = 'inserted' | 'updated' | 'unchanged' | 'duplicate' | 'archived' | 'planned'

/** 单段明细。 */
export interface FeedChunkRow {
  /** 该段在这次输入里的序号（-1 = "上一版多出来的段落"）。 */
  readonly index: number
  readonly id: string
  readonly action: FeedAction
  readonly reason: string
  readonly tokenCount: number
  readonly similarity?: number
  readonly matchedId?: string
  /** `action === 'planned'`（dry-run）时本来会做什么。 */
  readonly wouldBe?: FeedAction
}

/** 一次喂食的结果。 */
export interface FeedResultView {
  readonly ok: boolean
  readonly error?: string
  readonly as: FeedKind
  readonly source: string
  readonly scope: string
  readonly dryRun: boolean
  readonly chunkCount: number
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  readonly duplicates: number
  readonly archived: number
  readonly tokens: number
  readonly revision?: number
  readonly details: readonly FeedChunkRow[]
  /** 怎么删（指向既有记忆管理，不是新接口）。 */
  readonly hint: string
}

/** 接口响应外壳。 */
export interface FeedResponse {
  readonly ok: boolean
  readonly result: FeedResultView
}
