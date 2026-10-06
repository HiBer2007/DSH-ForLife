/**
 * 表情与媒体的线上契约（镜像 gateway 的 `admin/queries-media.ts`）。
 *
 * 注意 `DynamicTable`：这两张表的 schema 归视觉层所有，面板**不写死列名**，
 * 而是按实际存在的列渲染。所以这里没有逐字段的接口，只有一个"列名 + 行"的结构。
 */
export interface DynamicTable {
  readonly name: string
  readonly label: string
  readonly columns: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
  readonly total: number
  /** 表不存在（与"表是空的"是两件事）。 */
  readonly missing: boolean
}

export interface MediaInbound {
  readonly id: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly mediaKind: string
  readonly text: string
  readonly at: string
  readonly isGroup: boolean
}

export interface MediaOverview {
  readonly inbound: readonly MediaInbound[]
  readonly inboundStats: { readonly images: number; readonly files: number; readonly total: number }
  readonly tables: readonly DynamicTable[]
  readonly stickers: { readonly supported: boolean; readonly note: string }
}
