/**
 * 「会话与队列」的接口契约 —— `packages/gateway/src/admin/queries-qq.ts` 的**镜像**。
 *
 * ## 为什么要抄一份而不是直接 import 服务端类型
 *
 * 同 `types-memory.ts`：两个包、两套 tsconfig、两个运行环境（`node:sqlite` vs 浏览器），
 * 跨包引源码会把服务端依赖扯进前端构建。抄一份 = 前端自己的契约：服务端多给字段无所谓，
 * 少给或改了可空性必须在这里编译失败，而不是等到页面上某个格子悄悄空掉。
 *
 * ## 可空字段：`?:`（整个键缺席）而不是 `| null`
 *
 * 服务端对可空**文本**列的规矩是"NULL ⇒ 整个键省略"（`optionalText`），
 * 0/1 的布尔列一律转成真 `boolean`（否则模板会渲染出 1/0）。镜像过来就是：
 *  - `title` / `lastMessageAt` / `senderName` / `error` / `mediaKind` / `endedAt` / `model` …
 *    缺席 = 库里是 NULL；
 *  - `processed` / `confirmed` / `read` 是 `boolean`，**不是** 0/1。
 *
 * ## 计数是"全库口径"，列表是"一页"
 *
 * `queueStats` / `turnStats` / `outboxStats` 都是 SQL 聚合出来的**全库**数字，
 * 而 `sessions` / `queue` / `turns` / `outbox` / `pending` 是有限页（默认 50，出站 30，服务端上限 200）。
 * 两者不能混着用：拿数组长度当"总数"显示，会在数据变多时给出一个偏小的假数字。
 */

/** 一个会话（`qq_sessions` 一行 + 该会话未处理的入站条数）。 */
export interface ConversationSession {
  readonly conversationKey: string
  readonly platform: string
  readonly chatId: string
  /** `private` | `group` | `temp`；列不是枚举，保住 `string`。 */
  readonly kind: string
  readonly title?: string
  readonly lastMessageAt?: string
  /** 该会话在 `qq_inbox` 里 `processed = 0` 的条数（全库口径，不受本页页大小影响）。 */
  readonly unread: number
}

/** 入站队列里的一条消息（`qq_inbox` 一行）。 */
export interface InboxItem {
  readonly id: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly text: string
  /** 事件时间（平台侧）。 */
  readonly at: string
  /** 落库时间（本地侧）；与 `at` 的差就是"消息在路上花了多久"。 */
  readonly receivedAt: string
  readonly processed: boolean
  readonly attempt: number
  readonly error?: string
  /** `image` | `file`；纯文本消息没有这个键（不是空串）。 */
  readonly mediaKind?: string
}

/** 入站队列计数（全库口径）。 */
export interface QueueStats {
  readonly pending: number
  readonly total: number
  /** 有 `error` 的行数——含重试中仍留有错误文本的。 */
  readonly failed: number
}

/** 一轮（`qq_turns` 一行）。 */
export interface TurnItem {
  readonly id: string
  readonly conversationKey: string
  /** 取值域由迁移 5 的列注释钉死。 */
  readonly status: 'running' | 'done' | 'failed' | 'deferred'
  readonly startedAt: string
  readonly endedAt?: string
  readonly model?: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly toolCalls: number
  readonly deferReason?: string
  readonly error?: string
}

/** 轮次计数（全库口径）。 */
export interface TurnStats {
  readonly running: number
  readonly done: number
  readonly failed: number
  readonly deferred: number
  /**
   * 平均时长（毫秒），**只统计有 `ended_at` 的轮次**。
   *
   * 一条都没有时是整个键缺席，而不是 0：0 会被读成"跑得飞快"，
   * 缺席才是"还没有跑完过任何一轮"。
   */
  readonly avgDurationMs?: number
}

/** 出站记录（`qq_outbox` 一行）。 */
export interface OutboxItem {
  readonly id: string
  readonly conversationKey: string
  /** `text` | `image` | `file` | `sticker` | `notice` | `mention_all` | … 开放集合。 */
  readonly kind: string
  /** `pending`（等认领）| `sending` | `sent` | `failed`，见迁移 6。 */
  readonly status: 'pending' | 'sending' | 'sent' | 'failed'
  readonly attempt: number
  readonly sentAt: string
  readonly confirmed: boolean
  readonly error?: string
}

/** 出站计数（全库口径）。 */
export interface OutboxStats {
  readonly pending: number
  /** 只看终态 `status = 'failed'`；重试中的行不算，否则一条最终成功的消息会永远躺在"失败"里。 */
  readonly failed: number
  readonly confirmed: number
}

/** 有界待读池里的一条（`pending_messages` 一行）。 */
export interface PendingItem {
  readonly id: string
  /** `'*'` 或具体会话；决定这条待读给谁看。 */
  readonly scope: string
  readonly conversationKey: string
  readonly senderName?: string
  readonly summary: string
  readonly at: string
  readonly read: boolean
}

/** `GET /api/admin/conversations` 的响应（= 服务端 `ConversationsOverview`，一一对应）。 */
export interface ConversationsOverview {
  readonly sessions: readonly ConversationSession[]
  readonly queue: readonly InboxItem[]
  readonly queueStats: QueueStats
  readonly turns: readonly TurnItem[]
  readonly turnStats: TurnStats
  readonly outbox: readonly OutboxItem[]
  readonly outboxStats: OutboxStats
  readonly pending: readonly PendingItem[]
}
