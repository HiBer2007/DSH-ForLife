/**
 * 表情库的线上契约（镜像 gateway 的 `admin/queries-stickers.ts`）。
 *
 * 注意 `previewable`：有些格式浏览器不认，面板要**如实标出来**而不是给一个破图 ——
 * "显示不了"和"这张图坏了"是两件事。
 */
export interface StickerCard {
  readonly id: string
  readonly sha256: string
  readonly mime: string
  readonly sizeBytes: number
  readonly source: string
  readonly sourceUrl?: string
  /** false = 学来的（默认不主动转发）。 */
  readonly ours: boolean
  readonly scopes: readonly string[]
  readonly useCount: number
  readonly lastUsedAt?: string
  readonly createdAt: string
  /** 缺席 = 还没有描述（不是空描述）。 */
  readonly description?: string
  readonly emotionTags: readonly string[]
  readonly describedBy?: string
  readonly previewable: boolean
}

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
    readonly vision: string
  }
}
