/** 会话详情的线上契约（镜像 gateway 的 `admin/queries-conversation.ts`）。 */
export interface ConversationWakeRule {
  readonly scope: string
  readonly condition: string
  readonly enabled: boolean
  readonly probability: number
  readonly minIntervalMs: number
  readonly dailyLimit: number
  /** true = 这个会话**自己配的**；false = 继承全局默认。 */
  readonly own: boolean
}

export interface ConversationDetail {
  readonly conversationKey: string
  readonly platform: string
  readonly chatId: string
  readonly kind: string
  readonly title?: string
  readonly lastMessageAt?: string
  readonly createdAt?: string
  readonly counts: {
    readonly inbound: number
    readonly outbound: number
    readonly turns: number
    readonly pendingInbound: number
  }
  readonly clock?: {
    readonly timezone: string
    readonly hour24: boolean
    readonly source: string
    readonly reason?: string
    readonly updatedAt: string
  }
  readonly note?: string
  readonly impression?: string
  /** `model` = 模型总结的（可能有误）；`user` = 主人修正过（模型不会再覆盖）。 */
  readonly impressionSource?: string
  readonly profileUpdatedAt?: string
  readonly wakeRules: readonly ConversationWakeRule[]
  readonly recentWakeEvents: readonly {
    readonly at: string
    readonly condition: string
    readonly decision: string
    readonly reason?: string
  }[]
}
