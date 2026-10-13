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
  /**
   * ★ P1-1：这条消息里的**图片引用**（`image` 段的 url 与协议端给的元信息）。
   *
   * 为什么要在适配器里就抽出来、而不是让下游去翻 `raw`：
   *  - `raw` 是**协议端的原始形状**，字段名是本项目不该到处复制的知识（NapCat 实测：
   *    `data.url` / `data.summary` / `data.sub_type` / `data.file_size`）；
   *  - 抽出来之后，"要不要看这张图"的判定可以被**纯函数单测**钉住（见 `media-resolve.ts`）。
   *
   * ⚠️ 抽出来**不等于**看了它：真正的下载与视觉调用在 `gateway.ts` 的 `resolveMedia`
   * 里做（异步、有预算、失败降级成看得见的占位符）。
   */
  readonly images?: readonly InboundImageRef[]
  /**
   * ★ P2-b：这条消息里的**文件引用**（`file` 段）。
   *
   * `fileName` 是 NapCat 给的 `data.file`（就是文件名，同时也是它内部 `Xt` 令牌表里的键），
   * `fileId` 是 `data.file_id`（`fileUuid`）—— 两个都能喂给 `get_file`。
   */
  readonly files?: readonly InboundFileRef[]
  /**
   * ★ P1-2：这条消息里**有没有语音**（有 ⇒ 值得花一次 `fetch_ptt_text`）。
   *
   * 只要一个布尔：转写接口（`fetch_ptt_text`）吃的是**消息 id**，不是段本身 ——
   * 带与不带具体段信息，对结果没有影响。
   */
  readonly hasVoice?: boolean
  /**
   * ★ P2-c：发送者在群里的**身份**（`owner` / `admin` / `member`；只有群消息有）。
   *
   * 以前只取了 `card`/`nickname` ⇒ 模型分不清"群主发话"与"路人发话"，
   * 而同一个群里这两者的分量完全不同。
   */
  readonly senderRole?: string
  /**
   * ★ P2-c：群名（NapCat 实测在群消息里给了 `group_name`）。
   *
   * 以前丢掉 ⇒ `qq_sessions.title` **恒为 NULL**，面板上只能看到裸群号。
   */
  readonly groupName?: string
  /**
   * ★ 这条消息里带了一个**合并转发**时，它的 id。
   *
   * **为什么必须单独一个字段**（而不是塞在 `text` 里）：
   * 合并转发的内容**不在事件里**（NapCat 的 `parseMultMsg` 默认 false，
   * 见 `forward.ts` 的模块头），只有一个 id。
   * 要把内容取回来必须**再调一次 `get_forward_msg`**，
   * 而那是个异步动作 —— 所以适配器只负责"把 id 带出来"，
   * 取内容由网关在**真正要用之前**做（见 `gateway.ts` 的 `resolveForwards`）。
   *
   * 旧行为是对 `forward` 段**完全不认**，`text` 停在空串 ⇒
   * 别人转来一段聊天记录，模型看到的是**一条空消息**（内容静默丢失）。
   */
  readonly forwardId?: string
  /**
   * ★ P0-4：这条消息**引用了**哪一条消息（`reply` 段的 `data.id`）。
   *
   * 以前这个 id 读完就扔（只加一个 `[引用]` 占位符），后果是
   * **`reply_to_me` 唤醒条件永远不可能触发** —— 那条件在基线与面板上都在，
   * 却因为上游没把 id 传下来而形同虚设。
   */
  readonly replyToMessageId?: string
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
  | {
      readonly type: 'request'
      readonly kind: 'friend' | 'group'
      readonly userId: string
      readonly groupId?: string
      readonly comment: string
      readonly flag: string
      /**
       * 群请求的子类型：`add`（自己申请入群）/ `invite`（被邀请入群）。
       *
       * ⚠️ 它对**处理**没用（实读 NapCat 的 `set_group_add_request` schema 里根本没有 `sub_type`，
       * 它是靠 flag 去群系统通知里找 `seq`），但对**判断**很有用 ——
       * "有人要进我的群" 和 "有人邀请我进群" 是完全不同的两件事，措辞也该不一样。
       */
      readonly subType?: string
      readonly at: string
    }
  | { readonly type: 'group_member_change'; readonly groupId: string; readonly userId: string; readonly change: 'increase' | 'decrease' | 'kick_me' | 'disband'; readonly at: string }
  /**
   * ★ P1-4：对方**正在输入**。
   *
   * 它以前**完全没有被解析**（`normalizeEvent` 只认 recall / poke / 群成员变动），
   * 于是协议端每几十毫秒发一次的这个事件全部原地丢弃 ——
   * 而 `wake.ts` 里那个 `peer_input_status` 条件因此**永远不可能触发**。
   * 这里把它接成事件（进审计、可被报告）；**要不要据此唤醒**是唤醒矩阵的事。
   */
  | { readonly type: 'peer_input_status'; readonly conversation: ConversationRef; readonly userId: string; readonly statusText: string; readonly eventType: number; readonly at: string }
  /** ★ P1-4：群禁言（谁被禁了 / 谁被解禁 / 全员禁言开关）。 */
  | {
      readonly type: 'group_ban'
      readonly groupId: string
      readonly userId: string
      readonly operatorId: string
      readonly durationSeconds: number
      readonly subType: string
      readonly at: string
    }
  /** ★ P1-4：群文件上传（`fileId` 是取文件内容要用的东西，见 `qq_contacts` 之外的 `get_file`）。 */
  | {
      readonly type: 'group_upload'
      readonly groupId: string
      readonly userId: string
      readonly fileId: string
      readonly fileName: string
      readonly fileSize: number
      readonly at: string
    }
  /** ★ P1-4：群消息被贴表情（谁给哪条消息贴了什么）。 */
  | {
      readonly type: 'group_msg_emoji_like'
      readonly groupId: string
      readonly messageId: string
      readonly userId: string
      readonly likes: readonly { readonly emojiId: string; readonly count: number }[]
      readonly at: string
    }

/** 发送结果。 */
export interface SendResult {
  /** 平台侧消息 id（送达确认要用）。 */
  readonly messageId?: string
  /** 是否收到平台确认。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly error?: string
}

/**
 * 一条**收到**的合并转发的内容（`get_forward_msg` 的结果，已摊平成文本）。
 *
 * `notes` 是**如实告警**（截断/未渲染的段/嵌套未展开）—— 不允许静默丢。
 */
export interface ForwardContent {
  /** 被取的那条消息 id。 */
  readonly messageId: string
  /** 摊平后的可读文本（每行 `发送者：内容`）。 */
  readonly text: string
  /** 还原出几条消息。 */
  readonly nodeCount: number
  /** 解析告警（空数组 = 完整还原）。 */
  readonly notes: readonly string[]
}

/** 好友列表里的一项（只保留我们真的会用的字段）。 */
export interface FriendBrief {
  readonly userId: string
  readonly nickname: string
  readonly remark?: string
}

/** 群列表里的一项。 */
export interface GroupBrief {
  readonly groupId: string
  readonly groupName: string
  readonly memberCount?: number
  readonly maxMemberCount?: number
}

/** 群成员里的一项。 */
export interface GroupMemberBrief {
  readonly userId: string
  readonly nickname: string
  /** 群名片（可能为空）。 */
  readonly card?: string
  /** `owner` / `admin` / `member`。 */
  readonly role?: string
}

/**
 * ★ P1-1：入站消息里一张图的**引用**（不看内容，只记"它在哪、它是什么"）。
 *
 * 字段名与 NapCat 实测的 `picElement` 转换结果一一对应（不是照 OneBot 文档猜的）：
 * `data.url` / `data.summary` / `data.sub_type` / `data.file_size`。
 */
export interface InboundImageRef {
  /** 协议端给的地址。**可能是 CDN 直链（需 rkey、会过期），也可能是协议端本地路径**。 */
  readonly url: string
  /** NapCat 给的 `summary`（普通图是 `[图片]`，表情是 `[动画表情]`）。 */
  readonly summary?: string
  /** NapCat 给的 `sub_type`（**1 = 动画表情/表情包** —— 免费的预筛判据）。 */
  readonly subType?: number
  /** 声明大小（字节；NapCat 给的是字符串，适配器已转成数字）。 */
  readonly fileSize?: number
}

/** ★ P2-b：入站消息里一个文件的**引用**。 */
export interface InboundFileRef {
  /** 文件名（NapCat 的 `data.file`）。 */
  readonly fileName?: string
  /** 文件 id（NapCat 的 `data.file_id` = `fileUuid`）。 */
  readonly fileId?: string
  /** 声明大小（字节）。 */
  readonly fileSize?: number
}

/** ★ P1-2：语音转写的结果（NapCat `fetch_ptt_text` 的语义化形状）。 */
export interface PttTextResult {
  readonly ok: boolean
  /** 转写文本（`ok` 为 true 时才有）。 */
  readonly text?: string
  /** 失败原因（**协议端是明确报错的**：不包含语音 / 消息不存在 / 转写超时）。 */
  readonly error?: string
}

/** ★ P2-b：`get_file` 的结果（已语义化）。 */
export interface FileInfo {
  /** 协议端**容器内的本地路径**（我们能拿到字符串，但读不到那个文件）。 */
  readonly file?: string
  /** 可下载的 URL（**只有图片类元素才会是 http(s)**；普通文件回的就是本地路径）。 */
  readonly url?: string
  readonly fileSize?: string
  readonly fileName?: string
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
  /** **WebSocket 通着**（这只说明链路活着，不说明 QQ 在线）。 */
  readonly connected: boolean
  /**
   * ★ P1-3：**QQ 那头真的在线**（来自心跳的 `status.online`）。
   *
   * 为什么必须与 `connected` 分开：实测事故里两者长期是
   * `connected: true` + `qqOnline: false`（账号被静默踢下线、TCP 仍 ESTABLISHED），
   * 下游 **35 小时收不到任何事件**而健康检查一路绿灯。
   * 合成一个字段就永远分不出"链路断了"和"链路通着但账号掉线了"。
   */
  readonly qqOnline?: boolean
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
  /**
   * 查 @全体 额度（**两个维度都要**：群维度 + 账号维度）。
   *
   * 为什么不能只读群维度：NapCat 该接口返回值**与 group_id 不完全相关**，
   * 只看群维度会高估（群还剩 5 次、账号已 0 次 ⇒ 实际发不出去）。
   */
  getAtAllQuota(groupId: string): Promise<import("./mention-quota.ts").MentionQuotaSnapshot | undefined>
  /**
   * 发**群公告**（独立于 @全体，**不受 @全体额度影响**）。
   *
   * 与 @全体 是两个独立工具：群公告有自己的配额，
   * 拿 @全体 的额度去挡它会让"想发个公告"莫名其妙失败。
   */
  groupNotice(groupId: string, content: string): Promise<SendResult>
  getAtAllRemain(groupId: string): Promise<number | undefined>
  /** 撤回消息（需要审批的动作，调用方负责放行判断）。 */
  deleteMessage(messageId: string): Promise<SendResult>

  // ── 合并转发（聊天记录打包）────────────────────────────────────────────
  /**
   * 发一段**合并转发**（QQ 原生"聊天记录"卡片）。
   *
   * `nodes` 是**已经构造好的** OneBot node 数组（见 `forward.ts` 的 `buildForwardNodes`）——
   * 这一层不做语义转换，理由是 NapCat 的约束很硬（`messages` 里**只许**有 `type:'node'`），
   * 把"构造"放在纯逻辑层才能被单测钉住。
   */
  sendForward(conversation: ConversationRef, nodes: readonly unknown[]): Promise<SendResult>
  /**
   * 取一条合并转发的**内容**（`get_forward_msg`）。
   *
   * 这是"内容别丢"的关键：入站事件里只有一个 id，内容必须再取一次。
   * 取不到时返回 `undefined`（**不是**空文本）—— 让调用方能把"取失败"与"里面真的没内容"分开。
   */
  getForward(messageId: string): Promise<ForwardContent | undefined>

  // ── 好友 / 群请求与列表（阶段 3 补齐）──────────────────────────────────
  /** 同意/拒绝好友申请。`flag` 必须来自上报（NapCat 里它就是 `reqTime`）。 */
  handleFriendRequest(flag: string, approve: boolean, remark?: string): Promise<SendResult>
  /** 同意/拒绝入群请求或邀请。`flag` 必须来自上报（NapCat 里它是群系统通知的 `seq`）。 */
  handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<SendResult>
  /** 好友列表。 */
  listFriends(): Promise<readonly FriendBrief[] | undefined>
  /** 群列表。 */
  listGroups(): Promise<readonly GroupBrief[] | undefined>
  /** 群成员列表。 */
  listGroupMembers(groupId: string): Promise<readonly GroupMemberBrief[] | undefined>

  // ── 入站媒体的取回（P1-2 语音 / P2-b 文件）────────────────────────────
  /**
   * ★ P1-2：**语音转文字**（NapCat 的 `fetch_ptt_text`）。
   *
   * ## 为什么是它（而不是"下载语音喂语音模型"）
   *
   * 实测源码（`napcat.mjs` 的 `FetchPttText`）：入参只有 `{message_id}`，
   * 返回 `{text}`；失败**全是明确报错**（`消息中不包含语音` / `消息不存在或已被撤回` /
   * `获取语音转文字结果失败`）。它**不依赖** `record.data.url` ——
   * 而那个 url 需要 packet 后端健康，是 NapCat 的已知静默失败面（审计 §5c）。
   *
   * @param messageId - 那条**语音消息**的消息 id（不是文件 id）。
   * @returns 转写结果或失败原因（**不抛**：调用方要把它渲染成看得见的占位符）。
   */
  fetchPttText(messageId: string): Promise<PttTextResult>
  /**
   * ★ P2-b：取**文件信息**（NapCat 的 `get_file`）。
   *
   * ⚠️ 实测事实（`npm` bundle 的 `GetFile._handle`）：它会**让协议端真的去下载**这个文件
   * （`FileApi.downloadMedia` / `downloadFileById`），所以调用方必须**按大小与预算**筛；
   * 返回的 `file` 是**协议端容器里的路径**（不是我们能下载的 URL）。
   *
   * @param input - `file`（文件名，NapCat 内部令牌表的键）或 `fileId`。至少给一个。
   * @returns 文件信息；协议端取不回时 `undefined`。
   */
  getFileInfo(input: { readonly file?: string; readonly fileId?: string }): Promise<FileInfo | undefined>
}
