/**
 * QQ 传输层的**抽象接口**。
 *
 * 为什么要有这层：NapCat 是主选、SnowLuma 是备选（EXECUTION_PLAN §1.2），
 * 两者都是 OneBot v11，但**生命周期与登录方式不同**（一个容器内扫码 WebUI、一个要 Xvfb+VNC）。
 * 把"怎么连"和"说什么"分开，换实现只改配置。
 *
 * 接口刻意只暴露**语义**，不暴露 OneBot 的动作名 —— 否则"换实现只改配置"就是空话。
 *
 * @module @forlife/gateway/transport
 */

/** 会话种类（PLAN §8.4 的会话键里 kind 的取值）。 */
export type ConversationKind = 'private' | 'group' | 'temp'

/** 会话键的三段（§8.4：`(platform, chat_id, thread_id?)`）。 */
export interface ConversationRef {
  readonly platform: string
  readonly chatId: string
  readonly threadId?: string
  readonly kind: ConversationKind
}

/**
 * 规范化会话键。
 *
 * @param ref - 会话三段。
 * @returns `platform:chatId[:threadId]`。
 */
export function conversationKey(ref: ConversationRef): string {
  const base = `${ref.platform}:${ref.chatId}`
  return ref.threadId === undefined || ref.threadId === '' ? base : `${base}:${ref.threadId}`
}

/** 解析会话键。 */
export function parseConversationKey(key: string): { platform: string; chatId: string; threadId?: string } | undefined {
  const parts = key.split(':')
  const platform = parts[0]
  const chatId = parts[1]
  if (platform === undefined || chatId === undefined || platform === '' || chatId === '') return undefined
  const threadId = parts.slice(2).join(':')
  return threadId === '' ? { platform, chatId } : { platform, chatId, threadId }
}

/** 一条入站消息（已从平台事件归一化）。 */
export interface InboundMessage {
  /** 平台侧消息 id（撤回/引用要用）。 */
  readonly messageId: string
  readonly conversation: ConversationRef
  readonly senderId: string
  readonly senderName: string
  /** 纯文本（CQ 码已剥离；图片/文件等以占位符表示）。 */
  readonly text: string
  /** 是否 @ 了我。 */
  readonly mentionedMe: boolean
  /** 是否 @ 全体成员（独立条件，不派生）。 */
  readonly mentionedAll: boolean
  /** 是否拍一拍。 */
  readonly isPoke: boolean
  /** 媒体类型（有媒体时非空）。 */
  readonly mediaKind?: 'image' | 'file' | 'record' | 'video'
  /** 是否是机器人自己发的（多端一致性要用）。 */
  readonly isSelf: boolean
  /** 事件时间（UTC ISO）。 */
  readonly at: string
  /** 原始事件（保真留档，便于事后排查解析问题）。 */
  readonly raw: unknown
}

/** 其它需要模型知道的事件（§2.17.8 的能力面）。 */
export type InboundEvent =
  | { readonly type: 'message'; readonly message: InboundMessage }
  | { readonly type: 'message_sent'; readonly message: InboundMessage }
  | { readonly type: 'message_recalled'; readonly conversation: ConversationRef; readonly messageId: string; readonly operatorId: string; readonly at: string }
  | { readonly type: 'bot_offline'; readonly reason: string; readonly at: string }
  | { readonly type: 'peer_status'; readonly userId: string; readonly status: string; readonly at: string }
  | { readonly type: 'request'; readonly kind: 'friend' | 'group'; readonly userId: string; readonly groupId?: string; readonly comment: string; readonly flag: string; readonly at: string }
  | { readonly type: 'group_member_change'; readonly groupId: string; readonly userId: string; readonly change: 'increase' | 'decrease' | 'kick_me' | 'disband'; readonly at: string }

/** 发送结果。 */
export interface SendResult {
  /** 平台侧消息 id（送达确认要用）。 */
  readonly messageId?: string
  /** 是否收到平台确认。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly error?: string
}

/** 出站消息段（与平台无关的描述）。 */
export type OutboundSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly file: string }
  | { readonly kind: 'file'; readonly file: string; readonly name?: string }
  | { readonly kind: 'sticker'; readonly file: string }
  | { readonly kind: 'at'; readonly userId: string }
  | { readonly kind: 'reply'; readonly messageId: string }

/** 传输层状态。 */
export interface TransportStatus {
  readonly connected: boolean
  readonly selfId?: string
  readonly since?: string
  readonly lastError?: string
}

/**
 * QQ 传输层。
 *
 * 实现者只需保证语义正确；动作名、鉴权、重连策略都在实现内部。
 */
export interface QqTransport {
  /** 启动（监听或拨号，取决于实现）。 */
  start(): Promise<void>
  /** 停止并释放资源。 */
  stop(): Promise<void>
  /** 订阅入站事件；返回退订函数。 */
  onEvent(handler: (event: InboundEvent) => void): () => void
  /** 当前状态（供健康检查与面板）。 */
  status(): TransportStatus
  /** 发消息（可分段）。 */
  sendMessage(conversation: ConversationRef, segments: readonly OutboundSegment[], options?: { readonly autoEscape?: boolean }): Promise<SendResult>
  /** 表情回应。 */
  sendReaction(messageId: string, emoji: string): Promise<SendResult>
  /** 输入中状态（仅私聊有效；群聊无此能力，实现应返回 ok=false 并说明）。 */
  setInputStatus(conversation: ConversationRef, typing: boolean): Promise<SendResult>
  /** 主动 @全体成员（额度由调用方保证；这里只负责发）。 */
  mentionAll(conversation: ConversationRef, segments: readonly OutboundSegment[]): Promise<SendResult>
  /** 取自己的账号信息（探活用）。 */
  getSelfInfo(): Promise<{ readonly userId: string; readonly nickname: string } | undefined>
  /** 取群 @全体剩余次数（额度查询）。 */
  getAtAllRemain(groupId: string): Promise<number | undefined>
  /** 撤回消息（需要审批的动作，调用方负责放行判断）。 */
  deleteMessage(messageId: string): Promise<SendResult>
}
