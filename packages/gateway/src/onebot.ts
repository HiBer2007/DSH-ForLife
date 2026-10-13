/**
 * OneBot v11 适配器（反向 WebSocket）。
 *
 * ## 拓扑
 *
 * QQ 客户端（NapCat / SnowLuma）主动连到**我们**的 WS 服务端，所以我们监听、它拨号。
 * 这是反向 WS 的标准形态，好处是容器网络里不需要我们主动发现它。
 *
 * ## 协议要点（全局实测与研究得出）
 *
 * | 项 | 事实 |
 * | :--- | :--- |
 * | 动作调用 | 发 `{"action":"send_msg","params":{...},"echo":"<id>"}`，响应里带同一个 `echo` ⇒ 用它做请求-响应关联 |
 * | 事件 | 以 `post_type` 区分：`message` / `message_sent` / `notice` / `request` / `meta_event` |
 * | 鉴权 | `Authorization: Bearer <token>` 头（可选；**必须校验**，否则同网段任何人都能冒充 QQ 端） |
 * | `set_input_status` | **仅 C2C（私聊）有效**，群聊必须返回失败而不是假装成功 |
 * | 群消息免打扰 | **没有任何 API**（EXECUTION_PLAN §2.17 已记录为协议级能力缺口） |
 *
 * ## 安全边界（§2.17.8 的红线）
 *
 * 本适配器**不实现** `send_packet` / 凭据类动作 —— 不是"实现了不给工具"，而是根本不建方法。
 * 见同目录测试里的红线断言。
 *
 * @module @forlife/gateway/onebot
 */
import { extractForwardMessages, forwardPlaceholder, parseForwardMessages } from './forward.ts'
import type { MentionQuotaSnapshot } from './mention-quota.ts'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  conversationKey,
  type ConversationRef,
  type FileInfo,
  type ForwardContent,
  type FriendBrief,
  type GroupBrief,
  type GroupMemberBrief,
  type InboundEvent,
  type InboundFileRef,
  type InboundImageRef,
  type InboundMessage,
  type OutboundSegment,
  type PttTextResult,
  type QqTransport,
  type SendResult,
  type TransportStatus,
} from './transport.ts'

/**
 * ★ P2-a：从**卡片类段**里抽出人能读的那几行。
 *
 * ## 为什么值得单独写一个函数
 *
 * `json` / `xml` / `markdown` 三种段里装的是 QQ 的分享卡片（音乐、小程序、
 * 群公告、接龙、投票…）。它们是**最常见的一类"看起来有内容、对我们却是空白"**：
 * 旧行为只加一个 `[引用]`/没有分支，模型看到的是一段空白。
 * 而卡片里其实有标题、摘要、来源 —— 那正是判断"要不要理它"所需要的全部信息。
 *
 * ## 为什么只抽字段，不做完整解析
 *
 * 卡片的原始 JSON/XML 可能几十 KB（含样式、跳转参数、埋点），
 * 整段倒进上下文等于把窗口交给协议端支配。所以：
 *  - **只找已知的标题/摘要字段**（递归找 `title` / `desc` / `summary` / `text` / `content`）；
 *  - **每个字段截断**、**最多几段**；
 *  - 找不到就返回空串 —— 调用方会退回 `[未解析:json]`，
 *    也就是"**内容没抽到**"仍然是**看得见的**，不是空白。
 *
 * @param type - 段类型（`json` / `xml` / `markdown`）。
 * @param data - 段的 `data`。
 * @returns 抽出来的一行可读文本（找不到时为空串）。
 */
function extractCardText(type: string, data: Record<string, unknown>): string {
  const MAX_FIELD = 120
  const MAX_FIELDS = 3
  const found: string[] = []

  /** 递归找"像标题/摘要"的字符串字段。 */
  const walk = (value: unknown, depth: number): void => {
    if (found.length >= MAX_FIELDS || depth > 6) return
    if (typeof value === 'string') {
      // `xml` / `markdown` 的正文直接就是一段字符串：抽取标签之间的内容
      const stripped = value
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (stripped.length >= 2) found.push(stripped.slice(0, MAX_FIELD))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    // 优先看已知的"人读字段"，再看别的（顺序决定了摘要质量）
    const preferred = ['title', 'desc', 'description', 'summary', 'text', 'content', 'prompt', 'name']
    for (const key of preferred) {
      if (record[key] !== undefined) walk(record[key], depth + 1)
      if (found.length >= MAX_FIELDS) return
    }
    // 卡片内容常常整段塞在 `data` 字段里（是**字符串形式的 JSON**）
    for (const key of ['data', 'meta', 'extra', 'detail']) {
      const nested = record[key]
      if (typeof nested === 'string') {
        try {
          walk(JSON.parse(nested), depth + 1)
        } catch {
          walk(nested, depth + 1)
        }
      } else if (nested !== undefined) {
        walk(nested, depth + 1)
      }
      if (found.length >= MAX_FIELDS) return
    }
  }

  const raw = type === 'markdown' ? data['content'] : (data['data'] ?? data['content'])
  walk(raw, 0)
  const unique = [...new Set(found.filter((item) => item !== ''))]
  return unique.slice(0, MAX_FIELDS).join('｜')
}

/** 把 NapCat 的 `file_size`（**字符串**）转成数字；不合法就返回 undefined。 */
function sizeOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * ★ 审计 §5d：**消息 id 的精度守卫**。
 *
 * `delete_msg` / `set_msg_emoji_like` 的入参在 OneBot 里是 Number，
 * 而我们把 id 存成字符串（`String(record['message_id'])`）。
 * 今天观测到的 id 是 10 位（远小于 2^53，**实测 12 个真实值**），
 * 但**失败形态是静默的**：一旦协议端开始回更大的 id（或字符串 id），
 * `Number()` 会悄悄取整，撤回/表情回应就打到**错的（或不存在的）消息**上，
 * 而调用方只看得到 `retcode != 0`。
 *
 * ⇒ 判据是"**不安全就报错，而不是截断**"：错的动作比失败的动作危险得多
 * （撤回别人的消息、给错误的消息贴表情，都收不回来）。
 *
 * @param messageId - 平台消息 id（字符串形态）。
 * @returns 安全整数，或 undefined（调用方必须报错）。
 */
function safeMessageId(messageId: string): number | undefined {
  const trimmed = messageId.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined
  const numeric = Number(trimmed)
  return Number.isSafeInteger(numeric) ? numeric : undefined
}

/** 适配器配置。 */export interface OneBotTransportOptions {
  /** 监听端口。 */
  readonly port: number
  /** 监听地址（默认仅回环；容器部署时才绑 0.0.0.0）。 */
  readonly host?: string
  /** 路径（OneBot 反向 WS 通常连到根路径或 /onebot）。 */
  readonly path?: string
  /** 共享密钥；设置后不匹配的连接一律拒绝。 */
  readonly accessToken?: string
  /** 单次动作调用超时（毫秒）。 */
  readonly actionTimeoutMs?: number
  /** 日志。 */
  readonly log?: (message: string) => void
  /**
   * 连接状态变化时的观察者回调（可选）。
   *
   * 给唤醒引擎用：QQ 掉线/恢复要能转成 system 触发。
   * **它是观察者，不是链路的一部分** —— 抛异常会被吞掉，不影响连接处理。
   */
  readonly onConnectionState?:
    | ((connected: boolean, detail?: string) => void)
    | undefined
  /**
   * ★★ **心跳观察者**（可选）：把 `meta_event.heartbeat` 原样交给存活判据。
   *
   * ## 为什么必须走回调，而不是当成事件往上传
   *
   * 心跳是**每 30 秒一条**的（`heartInterval: 30000`，实测）。当成事件上传的话，
   * `gateway.onEvent` 会把它写成 `effects` 行 ⇒ **2880 行/天**，
   * 而且每一条都会进"影响报告"的周期 —— 那不是信息，是噪音。
   *
   * 而它承载的恰恰是**唯一与"有没有人说话"无关的存活证据**：
   * `status.online`。实测事故（`research/napcat_issues.json`）里
   * "反向 WS 一直 ESTABLISHED、QQ 已被静默踢下线" **35 小时没人发现**，
   * 唯一能抓的就是这条心跳。所以：**不落库、直接喂判据**。
   *
   * `intervalMs` 用**心跳自带的** `interval`（换配置不用改代码）。
   */
  readonly onHeartbeat?:
    | ((heartbeat: { readonly online: boolean; readonly good?: boolean; readonly intervalMs?: number; readonly at: Date }) => void)
    | undefined
  /**
   * ★ **`notice_type: bot_offline` 观察者**（可选）：NapCat 明确告知"账号掉线了"。
   *
   * 与心跳是**两个独立证据**（心跳是"沉默"，这个是"明确通知"）：
   * 判据应该两个都吃，因为它们各自会漏（心跳可能停，通知可能不发）。
   */
  readonly onBotOffline?: ((reason: string, at: Date) => void) | undefined
}

/** 待响应的动作调用。 */
interface PendingAction {
  readonly resolve: (value: { status?: string; retcode?: number; data?: unknown; message?: string }) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly action: string
}

/**
 * OneBot v11 反向 WS 传输层。
 */
export class OneBotTransport implements QqTransport {
  private readonly options: Required<Pick<OneBotTransportOptions, 'port' | 'host' | 'path' | 'actionTimeoutMs'>> &
    Pick<OneBotTransportOptions, 'accessToken' | 'onConnectionState' | 'onHeartbeat' | 'onBotOffline'>
  private readonly log: (message: string) => void
  private server: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, PendingAction>()
  private readonly handlers = new Set<(event: InboundEvent) => void>()
  private readonly state: { connected: boolean; selfId?: string; since?: string; lastError?: string; qqOnline?: boolean } = { connected: false }

  constructor(options: OneBotTransportOptions) {
    this.options = {
      port: options.port,
      host: options.host ?? '127.0.0.1',
      path: options.path ?? '/',
      actionTimeoutMs: options.actionTimeoutMs ?? 10_000,
      ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
      // ★ **这一行曾经漏掉过**（真机 bug，2026-10-06）：
      // 构造函数是**逐字段重建** `this.options` 的，而 `onConnectionState`
      // 在 `Pick<>` 里是**可选**的 ⇒ TypeScript **不会**报"少传了"。
      //
      // 后果：`notifyConnection` 里 `callback === undefined` 直接 return，
      // **连接回调永远不触发**，而日志里只看到 `QQ 端已连接` / `QQ 端断开` ——
      // 完全看不出"观察者根本没被叫"。
      //
      // 这类"参数在两层之间掉了"的 bug，单测很容易漏（测试直接调函数时
      // 参数是显式传的，根本不经过构造函数）。所以守卫测试**必须走构造函数**。
      ...(options.onConnectionState === undefined ? {} : { onConnectionState: options.onConnectionState }),
      // ★ 同上：这两个观察者**也必须在这里逐字段带上** ——
      //   漏掉它们的症状是"心跳解析好了，但判据永远收不到"（静默的假接线）。
      ...(options.onHeartbeat === undefined ? {} : { onHeartbeat: options.onHeartbeat }),
      ...(options.onBotOffline === undefined ? {} : { onBotOffline: options.onBotOffline }),
    }
    this.log = options.log ?? ((): void => {})
  }

  /** 启动监听。 */
  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = new WebSocketServer({ port: this.options.port, host: this.options.host, path: this.options.path })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      server.once('error', (error) => reject(error))
    })
    server.on('connection', (socket, request) => this.adopt(socket, request.headers.authorization))
    this.log(`OneBot 反向 WS 监听中：ws://${this.options.host}:${String(this.options.port)}${this.options.path}`)
  }

  /** 收下一个连接。 */
  private adopt(socket: WebSocket, authorization: string | undefined): void {
    // 鉴权：配了 token 就必须匹配（否则同网段任何人都能冒充 QQ 端）
    const expected = this.options.accessToken
    if (expected !== undefined && expected !== '') {
      const provided = authorization?.replace(/^Bearer\s+/i, '') ?? ''
      if (provided !== expected) {
        this.log('拒绝一个鉴权失败的连接')
        socket.close(1008, 'unauthorized')
        return
      }
    }
    // 同一时刻只保留最新连接（OneBot 反向 WS 重连时会新建连接，旧的应当让位）
    if (this.socket !== undefined && this.socket !== socket) {
      this.log('已有连接，替换为新连接（旧连接关闭）')
      try {
        this.socket.close(1000, 'replaced by newer connection')
      } catch {
        // 关不掉也无所谓，下面会覆盖引用
      }
    }
    this.socket = socket
    this.state.connected = true
    this.state.since = new Date().toISOString()
    delete this.state.lastError
    this.log('QQ 端已连接')
    this.notifyConnection(true)

    socket.on('message', (data) => {
      try {
        this.handleFrame(data.toString())
      } catch (error) {
        // 单帧解析失败不该断开连接（协议端偶发脏帧是常态）
        this.log(`帧处理失败（已忽略）：${String(error)}`)
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined
        this.state.connected = false
        this.log('QQ 端断开')
    this.notifyConnection(false, 'socket closed')
      }
      // 断开时把挂起的动作全部失败掉，避免调用方永久等待
      for (const [echo, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`连接断开，动作 ${pending.action} 未完成`))
        this.pending.delete(echo)
      }
    })
    socket.on('error', (error) => {
      this.state.lastError = String(error)
      this.log(`连接错误：${String(error)}`)
    })
  }

  /** 处理一帧（事件或动作响应）。 */
  /**
   * 通知连接状态变化。
   *
   * **吞掉观察者的异常** —— 它是观察者，不是链路的一部分。
   * 让"上报断线"的失败带崩"真正的断线处理"（挂起动作不会被失败掉、
   * 调用方永久等待）是最不划算的一种耦合。
   */
  private notifyConnection(connected: boolean, detail?: string): void {
    const callback = this.options.onConnectionState
    if (callback === undefined) return
    try {
      callback(connected, detail)
    } catch (error) {
      this.log(`连接状态观察者抛异常（已忽略）：${String(error)}`)
    }
  }

  /**
   * 通知一次心跳（**吞掉观察者的异常**，与 `notifyConnection` 同一条理由）。
   *
   * @param heartbeat - 心跳里的存活信号。
   */
  private notifyHeartbeat(heartbeat: { online: boolean; good?: boolean; intervalMs?: number; at: Date }): void {
    const callback = this.options.onHeartbeat
    if (callback === undefined) return
    try {
      callback(heartbeat)
    } catch (error) {
      this.log(`心跳观察者抛异常（已忽略）：${String(error)}`)
    }
  }

  /** 通知"协议端明确说账号掉线了"。 */
  private notifyBotOffline(reason: string, at: Date): void {
    const callback = this.options.onBotOffline
    if (callback === undefined) return
    try {
      callback(reason, at)
    } catch (error) {
      this.log(`掉线观察者抛异常（已忽略）：${String(error)}`)
    }
  }

  private handleFrame(text: string): void {
    const payload: unknown = JSON.parse(text)
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as Record<string, unknown>

    // 动作响应：带 echo
    const echo = record['echo']
    if (typeof echo === 'string' && this.pending.has(echo)) {
      const pending = this.pending.get(echo)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(echo)
      pending.resolve({
        ...(typeof record['status'] === 'string' ? { status: record['status'] } : {}),
        ...(typeof record['retcode'] === 'number' ? { retcode: record['retcode'] } : {}),
        ...(record['data'] === undefined ? {} : { data: record['data'] }),
        ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
      })
      return
    }

    const event = this.normalizeEvent(record)
    if (event !== undefined) {
      for (const handler of this.handlers) handler(event)
    }
  }

  /** 把 OneBot 事件归一化成我们的语义事件。 */
  private normalizeEvent(record: Record<string, unknown>): InboundEvent | undefined {
    const postType = record['post_type']
    const at = typeof record['time'] === 'number' ? new Date(record['time'] * 1000).toISOString() : new Date().toISOString()

    if (postType === 'message' || postType === 'message_sent') {
      const message = this.normalizeMessage(record, at, postType === 'message_sent')
      if (message === undefined) return undefined
      return postType === 'message' ? { type: 'message', message } : { type: 'message_sent', message }
    }

    if (postType === 'notice') {
      const noticeType = record['notice_type']
      if (noticeType === 'friend_recall' || noticeType === 'group_recall') {
        const userId = String(record['user_id'] ?? '')
        const groupId = record['group_id'] === undefined ? undefined : String(record['group_id'])
        return {
          type: 'message_recalled',
          conversation:
            groupId === undefined
              ? { platform: 'onebot11', chatId: userId, kind: 'private' }
              : { platform: 'onebot11', chatId: groupId, kind: 'group' },
          messageId: String(record['message_id'] ?? ''),
          operatorId: String(record['operator_id'] ?? userId),
          at,
        }
      }
      if (noticeType === 'notify' && record['sub_type'] === 'poke') {
        const groupId = record['group_id'] === undefined ? undefined : String(record['group_id'])
        const userId = String(record['user_id'] ?? '')
        return {
          type: 'message',
          message: {
            messageId: `poke_${String(record['time'] ?? Date.now())}`,
            conversation:
              groupId === undefined
                ? { platform: 'onebot11', chatId: userId, kind: 'private' }
                : { platform: 'onebot11', chatId: groupId, kind: 'group' },
            senderId: String(record['operator_id'] ?? userId),
            senderName: '',
            text: '[拍一拍]',
            mentionedMe: true,
            mentionedAll: false,
            isPoke: true,
            isSelf: false,
            at,
            raw: record,
          },
        }
      }
      if (noticeType === 'group_decrease' || noticeType === 'group_increase') {
        const subType = String(record['sub_type'] ?? '')
        return {
          type: 'group_member_change',
          groupId: String(record['group_id'] ?? ''),
          userId: String(record['user_id'] ?? ''),
          change: noticeType === 'group_increase' ? 'increase' : subType === 'kick_me' ? 'kick_me' : subType === 'disband' ? 'disband' : 'decrease',
          at,
        }
      }
      // ★★ P1-4：以下四类以前**完全没有分支** ⇒ 原地丢弃。
      //    它们全都是"模型应该知道的外部事件"（谁在打字、谁被禁言、群里有人传了文件、
      //    哪条消息被贴了表情），丢掉之后模型对群里的动静是不可见的。
      //    接成事件之后，它们会经 `recordNonMessageEvent` 进 `effects`，
      //    再由系统监督循环（P0-2）报告给模型。
      if (noticeType === 'notify' && record['sub_type'] === 'input_status') {
        const groupId = record['group_id'] === undefined ? undefined : String(record['group_id'])
        const userId = String(record['user_id'] ?? '')
        return {
          type: 'peer_input_status',
          conversation:
            groupId === undefined
              ? { platform: 'onebot11', chatId: userId, kind: 'private' }
              : { platform: 'onebot11', chatId: groupId, kind: 'group' },
          userId,
          statusText: String(record['status_text'] ?? ''),
          eventType: typeof record['event_type'] === 'number' ? record['event_type'] : 0,
          at,
        }
      }
      if (noticeType === 'group_ban') {
        return {
          type: 'group_ban',
          groupId: String(record['group_id'] ?? ''),
          userId: String(record['user_id'] ?? ''),
          operatorId: String(record['operator_id'] ?? ''),
          durationSeconds: typeof record['duration'] === 'number' ? record['duration'] : 0,
          subType: String(record['sub_type'] ?? ''),
          at,
        }
      }
      if (noticeType === 'group_upload') {
        const file = (record['file'] ?? {}) as Record<string, unknown>
        return {
          type: 'group_upload',
          groupId: String(record['group_id'] ?? ''),
          userId: String(record['user_id'] ?? ''),
          fileId: String(file['id'] ?? ''),
          fileName: String(file['name'] ?? ''),
          fileSize: typeof file['size'] === 'number' ? file['size'] : 0,
          at,
        }
      }
      if (noticeType === 'group_msg_emoji_like') {
        const rawLikes = Array.isArray(record['likes']) ? record['likes'] : []
        return {
          type: 'group_msg_emoji_like',
          groupId: String(record['group_id'] ?? ''),
          messageId: String(record['message_id'] ?? ''),
          userId: String(record['user_id'] ?? ''),
          likes: rawLikes.map((item) => {
            const like = (item ?? {}) as Record<string, unknown>
            return { emojiId: String(like['emoji_id'] ?? ''), count: typeof like['count'] === 'number' ? like['count'] : 1 }
          }),
          at,
        }
      }
      if (noticeType === 'bot_offline') {
        // ★ 协议端**明确说**账号掉线了（与心跳的"沉默"是两个独立证据）。
        //   以前这里没有分支 ⇒ 直接丢掉（审计 §3.7 的第二道保险形同虚设）。
        //   ① 喂存活判据（**不落库**：判据只需要"发生过"）；
        //   ② 产出一次事件（进审计，让模型也知道）—— 这个通知是**边沿式**的
        //      （NapCat 在掉线那一刻发一条），不像心跳那样每 30 秒来一次。
        const reason = `协议端上报 bot_offline（${String(record['message'] ?? record['reason'] ?? '未给原因')}）`
        this.notifyBotOffline(reason, new Date(at))
        return { type: 'bot_offline', reason, at }
      }
      return undefined
    }

    if (postType === 'request') {
      const requestType = record['request_type']
      const subType = typeof record['sub_type'] === 'string' ? record['sub_type'] : undefined
      return {
        type: 'request',
        kind: requestType === 'group' ? 'group' : 'friend',
        userId: String(record['user_id'] ?? ''),
        ...(record['group_id'] === undefined ? {} : { groupId: String(record['group_id']) }),
        comment: String(record['comment'] ?? ''),
        flag: String(record['flag'] ?? ''),
        // 群请求的 `sub_type` 是 `add`（申请入群）/ `invite`（被邀请）——
        // 处理时用不上（NapCat 靠 flag 找 seq），但通知措辞要用。
        ...(subType === undefined ? {} : { subType }),
        at,
      }
    }

    if (postType === 'meta_event') {
      if (record['meta_event_type'] === 'lifecycle' && record['sub_type'] === 'connect') {
        this.state.connected = true
      }
      // ★★ P1-3：**心跳是唯一能发现"WS 连着但 QQ 已经静默离线"的信号。**
      //
      // 实测事故形态（`research/napcat_issues.json` 的 #2071）：
      // 账号被服务端静默断开、NapCat **不发 KickedOffLine 事件**、TCP 保持 ESTABLISHED，
      // 于是下游 **35 小时收不到任何事件**，而健康检查一路显示"已连接"。
      // 心跳每 30 秒一次，且带 `status.online` —— 不读它，我们就和那次事故一样瞎。
      if (record['meta_event_type'] === 'heartbeat') {
        const status = (record['status'] ?? {}) as Record<string, unknown>
        const online = status['online']
        // ★★ 心跳**只喂判据，不落库**：每 30 秒一条 ⇒ 落 `effects` 就是 2880 行/天，
        //    而且每一条都会进"影响报告"周期 —— 噪音会把真正的报告淹掉。
        //    `intervalMs` 用**心跳自带的** `interval`（换配置不用改代码）。
        const good = typeof status['good'] === 'boolean' ? status['good'] : undefined
        const intervalMs = typeof record['interval'] === 'number' && record['interval'] > 0 ? record['interval'] : undefined
        if (typeof online === 'boolean') {
          this.notifyHeartbeat({ online, ...(good === undefined ? {} : { good }), ...(intervalMs === undefined ? {} : { intervalMs }), at: new Date(at) })
        }
        if (typeof online === 'boolean') {
          const wasOnline = this.state.qqOnline
          if (online !== wasOnline) {
            this.log(`心跳报告的 QQ 在线状态变了：${String(wasOnline)} → ${String(online)}`)
          }
          this.state.qqOnline = online
          // ★ **只在上沿产出一次事件**（`wasOnline !== false`）：离线期间心跳仍然每 30 秒来一条，
          //   每条都产一个事件就是上面那个"2880 行/天"的另一种写法。
          //   "还离线着"由存活判据自己的定时 `check()` 负责（它不落审计行）。
          if (!online && wasOnline !== false) {
            return { type: 'bot_offline', reason: `心跳报告 online=false（good=${String(status['good'])}）—— 反向 WS 仍然连着，但 QQ 侧已经掉线`, at }
          }
        }
      }
      return undefined
    }
    return undefined
  }

  /** 归一化一条消息。 */
  private normalizeMessage(record: Record<string, unknown>, at: string, isSelfEcho: boolean): InboundMessage | undefined {
    const messageType = record['message_type']
    const userId = String(record['user_id'] ?? '')
    const groupId = record['group_id'] === undefined ? undefined : String(record['group_id'])
    const selfId = record['self_id'] === undefined ? this.state.selfId : String(record['self_id'])
    if (selfId !== undefined) this.state.selfId = selfId

    const kind: ConversationRef['kind'] =
      messageType === 'group' ? 'group' : messageType === 'private' && record['sub_type'] === 'group' ? 'temp' : 'private'
    const conversation: ConversationRef = {
      platform: 'onebot11',
      chatId: groupId ?? userId,
      kind,
    }

    const segments = Array.isArray(record['message']) ? (record['message'] as Record<string, unknown>[]) : []
    let text = ''
    let mentionedMe = false
    let mentionedAll = false
    let mediaKind: InboundMessage['mediaKind']
    let forwardId: string | undefined
    let forwardInline: unknown
    let replyToMessageId: string | undefined
    // ★ P1-1 / P1-2 / P2-b：把"这段媒体是什么"抽出来，交给网关在**真正要用之前**取回
    const images: InboundImageRef[] = []
    const files: InboundFileRef[] = []
    let hasVoice = false

    if (segments.length === 0 && typeof record['raw_message'] === 'string') {
      text = record['raw_message']
    }
    for (const segment of segments) {
      const type = segment['type']
      const data = (segment['data'] ?? {}) as Record<string, unknown>
      if (type === 'text') {
        text += typeof data['text'] === 'string' ? data['text'] : ''
      } else if (type === 'at') {
        const target = String(data['qq'] ?? '')
        if (target === 'all') mentionedAll = true
        else if (selfId !== undefined && target === selfId) mentionedMe = true
        text += '[@]'
      } else if (type === 'image') {
        // ★ P1-1：**只记引用，不在这里取内容**。
        //
        //   为什么不在这里下载/看图：`normalizeMessage` 是**同步**的，而下载 + 视觉调用
        //   要几百毫秒到几秒；更要紧的是**预算**（一批里十几张图不能各看各的）。
        //   所以适配器的职责到此为止：把 `data.url`（以及协议端免费给的
        //   `summary`/`sub_type`/`file_size` —— 它们是**便宜预筛**的全部输入）带出去，
        //   取内容由网关的 `resolveMedia` 做（见 `media-resolve.ts`）。
        //   ⚠️ 占位符**仍然要拼**：预筛跳过或取回失败时，模型看到的必须是
        //   "这里有一张图（以及为什么没看）"，而不是空白。
        mediaKind = 'image'
        images.push({
          url: typeof data['url'] === 'string' ? data['url'] : '',
          ...(typeof data['summary'] === 'string' && data['summary'] !== '' ? { summary: data['summary'] } : {}),
          ...(typeof data['sub_type'] === 'number' ? { subType: data['sub_type'] } : {}),
          ...(sizeOf(data['file_size']) === undefined ? {} : { fileSize: sizeOf(data['file_size']) as number }),
        })
        text += '[图片]'
      } else if (type === 'file') {
        // ★ P2-b：文件名/file_id 一起留下 —— `get_file` 两个都能吃
        //   （NapCat 的 `e.file ||= e.file_id`），多带一个就多一条能走的路。
        mediaKind = 'file'
        files.push({
          ...(typeof data['file'] === 'string' && data['file'] !== '' ? { fileName: data['file'] } : {}),
          ...(typeof data['file_id'] === 'string' && data['file_id'] !== '' ? { fileId: data['file_id'] } : {}),
          ...(sizeOf(data['file_size']) === undefined ? {} : { fileSize: sizeOf(data['file_size']) as number }),
        })
        text += '[文件]'
      } else if (type === 'record') {
        mediaKind = 'record'
        // ★ P1-2：只要一个布尔 —— 转写接口吃的是**消息 id**
        hasVoice = true
        text += '[语音]'
      } else if (type === 'video') {
        mediaKind = 'video'
        text += '[视频]'
      } else if (type === 'reply') {
        // ★ P0-4：**引用段的 id 以前读完就扔了** ⇒ `reply_to_me` 唤醒条件**永不触发**。
        //   这里把 id 带出去，由 `defaultConditionOf` 判"是不是在回我"。
        const replyId = data['id'] === undefined ? '' : String(data['id'])
        if (replyId !== '') replyToMessageId = replyId
        text += '[引用]'
      } else if (type === 'forward') {
        // ★★ 合并转发：**旧代码在这里什么都没有**（`forward` 不在任何一个分支里），
        //    于是 `text` 停在空串 —— 别人转来一段聊天记录，模型看到的是**一条空消息**。
        //    这是本项目"静默丢内容"的同一类事故（对照：115 个附件分片旧版完全不渲染）。
        //
        //    这里分两种情况，都要处理：
        //     ① 段里**已经带了** `content`（NapCat 打开 `parseMultMsg` 时才有）⇒ 就地摊平；
        //     ② 只有 `id`（**线上默认就是这种**，实测 `parseMultMsg: false`）⇒
        //        把 id 带出去，由网关在真正要用之前调 `get_forward_msg` 取回。
        //    两种都先放一个**占位文本**：内容取不回时也要看得见"这里本来有东西"。
        const id = typeof data['id'] === 'string' ? data['id'] : String(data['id'] ?? '')
        forwardId = id === '' ? undefined : id
        forwardInline = data['content']
        text += forwardPlaceholder(id === '' ? '未知' : id, Array.isArray(data['content']))
      } else if (type === 'json' || type === 'xml' || type === 'markdown') {
        // ★ P2-a：卡片类不能只留一个 `[未解析:json]`。
        //   分享卡片（音乐/小程序/公告/接龙）的**可读信息全在那段 JSON/XML 里**，
        //   而它是 QQ 上最常见的"看起来有内容、对我们却是空白"的一类。
        //   这里只**抽标题/摘要/正文**（不把整段 JSON 倒进上下文 —— 那可能几十 KB）。
        const extracted = extractCardText(type, data)
        text += extracted === '' ? `[未解析:${type}]` : `[${type === 'json' ? '卡片' : type === 'xml' ? 'XML卡片' : 'Markdown'}]${extracted}`
        mediaKind = mediaKind ?? undefined
      } else if (type === 'mface') {
        // 商城大表情：`data.summary` 常常就是它的名字（"猫猫震惊"），比 `[未解析:mface]` 有用得多
        const name = typeof data['summary'] === 'string' && data['summary'] !== '' ? data['summary'] : ''
        text += name === '' ? '[大表情]' : `[大表情:${name}]`
        mediaKind = mediaKind ?? 'image'
      } else if (type === 'onlinefile') {
        const name = typeof data['name'] === 'string' && data['name'] !== '' ? data['name'] : ''
        text += name === '' ? '[在线文件]' : `[在线文件:${name}]`
        mediaKind = mediaKind ?? 'file'
      } else if (type === 'face') {
        text += '[表情]'
      } else {
        // ★★ P0-1：**这一支以前不存在**，于是"没被解析的段"直接消失：
        //    纯 QQ 表情 / 商城大表情 / 分享卡片 / 在线文件 / 小程序 …
        //    `text` 停在空串 ⇒ 下游 `timing.ts` 的 `empty` 规则把它判成噪音
        //    ⇒ `turns.ts` **整批吞掉** ⇒ 我们看到的是 **0 条**，连一行日志都没有。
        //
        //    加一个 else 分支就把"整条静默消失"变成"看得见的占位符"：
        //    即使内容拿不到，至少"这里有一条消息"是可见的。
        const label = typeof type === 'string' && type !== '' ? type : '未知段'
        text += `[未解析:${label}]`
      }
    }

    // ★ 合并转发的**第二种情况**：段里已经带了 `content`
    //   （只有 NapCat 配置 `parseMultMsg: true` 时才有；线上默认是 false）。
    //   带了就地摊平 —— 能省一次 `get_forward_msg` 往返，而且离线重放时也拿得到内容。
    //   摊平结果**替换**掉占位符（而不是追加），否则模型会看到"占位符 + 正文"两份。
    if (Array.isArray(forwardInline)) {
      const parsed = parseForwardMessages(forwardInline)
      const body = parsed.notes.length === 0 ? parsed.text : `${parsed.text}${parsed.text === '' ? '' : '\n'}（注意：${parsed.notes.join('；')}）`
      text = text.replace(forwardPlaceholder(forwardId ?? '未知', true), body)
      // 内容已经在手上，就不必再让网关去取一次了
      if (parsed.nodeCount > 0) forwardId = undefined
    }

    // 私聊/临时会话里"被 @"恒真（对方就是在找我说话）
    if (kind !== 'group') mentionedMe = true

    // ★ P2-c：`sender.role`（**只有群消息有**，实测 `:73881`）与 `group_name`（`:73880`）。
    //   以前两者都不取 ⇒ `qq_sessions.title` 恒为 NULL、模型也分不清群主与路人。
    const senderRecord = (record['sender'] ?? {}) as Record<string, unknown>
    const senderRole = typeof senderRecord['role'] === 'string' && senderRecord['role'] !== '' ? senderRecord['role'] : undefined
    const groupName = typeof record['group_name'] === 'string' && record['group_name'] !== '' ? record['group_name'] : undefined

    return {
      messageId: String(record['message_id'] ?? randomUUID()),
      conversation,
      senderId: userId,
      senderName: String(senderRecord['card'] ?? senderRecord['nickname'] ?? ''),
      text: text.trim(),
      mentionedMe,
      mentionedAll,
      isPoke: false,
      ...(mediaKind === undefined ? {} : { mediaKind }),
      ...(images.length === 0 ? {} : { images }),
      ...(files.length === 0 ? {} : { files }),
      ...(hasVoice ? { hasVoice: true } : {}),
      ...(senderRole === undefined ? {} : { senderRole }),
      ...(groupName === undefined ? {} : { groupName }),
      ...(forwardId === undefined ? {} : { forwardId }),
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      isSelf: isSelfEcho || (selfId !== undefined && userId === selfId),
      at,
      raw: record,
    }
  }

  /** 调用一个动作并等它自己的响应（用 echo 关联）。 */
  private async callAction<T = unknown>(action: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: string }> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== socket.OPEN) {
      return { ok: false, error: 'QQ 端未连接' }
    }
    const echo = randomUUID()
    // 显式标注类型，避免 catch 分支推断出联合类型（会让后面的 retcode/data 访问报错）
    const response: { status?: string; retcode?: number; data?: unknown; message?: string } = await new Promise<{
      status?: string
      retcode?: number
      data?: unknown
      message?: string
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`动作 ${action} 超时（${String(this.options.actionTimeoutMs)}ms）`))
      }, this.options.actionTimeoutMs)
      this.pending.set(echo, { resolve, reject, timer, action })
      socket.send(JSON.stringify({ action, params, echo }))
    }).catch((error: unknown) => ({ status: 'failed', message: String(error) }))

    const retcode = response.retcode
    const ok = response.status === 'ok' || (retcode !== undefined && (retcode === 0 || retcode === 1))
    const data = response.data as T | undefined
    return ok ? { ok: true, ...(data === undefined ? {} : { data }) } : { ok: false, error: response.message ?? `retcode=${String(retcode)}` }
  }

  /** 把语义化消息段转成 OneBot 的 CQ 数组。 */
  private toOneBotSegments(segments: readonly OutboundSegment[]): Record<string, unknown>[] {
    return segments.map((segment) => {
      switch (segment.kind) {
        case 'text':
          return { type: 'text', data: { text: segment.text } }
        case 'image':
          return { type: 'image', data: { file: segment.file } }
        case 'file':
          return { type: 'file', data: { file: segment.file, ...(segment.name === undefined ? {} : { name: segment.name }) } }
        case 'sticker':
          return { type: 'image', data: { file: segment.file, sub_type: 1 } }
        case 'at':
          return { type: 'at', data: { qq: segment.userId } }
        case 'reply':
          return { type: 'reply', data: { id: segment.messageId } }
      }
    })
  }

  /** 发消息。 */
  async sendMessage(conversation: ConversationRef, segments: readonly OutboundSegment[]): Promise<SendResult> {
    const message = this.toOneBotSegments(segments)
    if (conversation.kind === 'group') {
      const result = await this.callAction<{ message_id?: number | string }>('send_group_msg', {
        group_id: Number(conversation.chatId),
        message,
      })
      return result.ok ? { ok: true, ...(result.data?.message_id === undefined ? {} : { messageId: String(result.data.message_id) }) } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
    }
    const result = await this.callAction<{ message_id?: number | string }>('send_private_msg', {
      user_id: Number(conversation.chatId),
      message,
    })
    return result.ok ? { ok: true, ...(result.data?.message_id === undefined ? {} : { messageId: String(result.data.message_id) }) } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /** 表情回应。 */
  async sendReaction(messageId: string, emoji: string): Promise<SendResult> {
    const numeric = safeMessageId(messageId)
    if (numeric === undefined) {
      return { ok: false, error: `消息 id 不是安全整数，拒绝发送以免打到错的消息上：${messageId}` }
    }
    const result = await this.callAction('set_msg_emoji_like', { message_id: numeric, emoji_id: emoji })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /**
   * 输入中状态。
   *
   * **实测事实**：`set_input_status` 只对 C2C（私聊）有效。
   * 群聊调它不会生效 —— 所以这里对群聊**直接返回失败**，而不是假装成功
   * （假装成功会让模型以为自己表达了"正在输入"，实际上对方什么也看不到）。
   */
  async setInputStatus(conversation: ConversationRef, typing: boolean): Promise<SendResult> {
    if (conversation.kind === 'group') {
      return { ok: false, error: '群聊没有"输入中"能力（set_input_status 仅 C2C 有效）' }
    }
    const result = await this.callAction('set_input_status', {
      user_id: Number(conversation.chatId),
      event_type: typing ? 1 : 0,
    })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /** 主动 @全体成员（额度由调用方保证）。 */
  async mentionAll(conversation: ConversationRef, segments: readonly OutboundSegment[]): Promise<SendResult> {
    if (conversation.kind !== 'group') {
      return { ok: false, error: '@全体成员只在群聊里有意义' }
    }
    const message = [{ type: 'at', data: { qq: 'all' } }, ...this.toOneBotSegments(segments)]
    const result = await this.callAction<{ message_id?: number | string }>('send_group_msg', {
      group_id: Number(conversation.chatId),
      message,
    })
    return result.ok ? { ok: true, ...(result.data?.message_id === undefined ? {} : { messageId: String(result.data.message_id) }) } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /** 取自身账号信息。 */
  async getSelfInfo(): Promise<{ userId: string; nickname: string } | undefined> {
    const result = await this.callAction<{ user_id?: number; nickname?: string }>('get_login_info', {})
    if (!result.ok || result.data?.user_id === undefined) return undefined
    this.state.selfId = String(result.data.user_id)
    return { userId: String(result.data.user_id), nickname: result.data.nickname ?? '' }
  }

  /**
   * 查 @全体 额度（**两个维度都要**）。
   *
   * 为什么不能只读群维度：NapCat 这个接口的返回值**与 group_id 不完全相关** ——
   * 除了群维度（`remain_at_all_count_for_group`）还有**账号维度**
   * （`remain_at_all_count_for_uin`，这个号整体还剩多少）。
   * 只看群维度会**高估**：群维度显示还剩 5 次、账号维度已经 0 次，
   * 我们就会以为能发，实际发不出去，而且表现为"偶尔不生效"，很难查。
   *
   * 判定交给 `decideMentionAll`（保守取最小值），这里只负责**如实取回原始数据**。
   */
  async getAtAllQuota(groupId: string): Promise<MentionQuotaSnapshot | undefined> {
    const result = await this.callAction<{
      can_at_all?: boolean
      remain_at_all_count_for_group?: number
      remain_at_all_count_for_uin?: number
    }>('get_group_at_all_remain', { group_id: Number(groupId) })
    if (!result.ok) return undefined
    return {
      ...(result.data?.can_at_all === undefined ? {} : { canAtAll: result.data.can_at_all }),
      ...(result.data?.remain_at_all_count_for_group === undefined
        ? {}
        : { remainGroup: result.data.remain_at_all_count_for_group }),
      ...(result.data?.remain_at_all_count_for_uin === undefined
        ? {}
        : { remainAccount: result.data.remain_at_all_count_for_uin }),
    }
  }

  /**
   * 发**群公告**（独立于 @全体，**不受 @全体额度影响**）。
   *
   * 用户明确要求两者是独立工具、模型能在同一轮里自主选择用哪个。
   * 所以这里**不做任何 @全体 额度检查** —— 群公告有自己的配额，
   * 拿 @全体 的额度去挡它会让"想发个公告"莫名其妙失败。
   */
  async groupNotice(groupId: string, content: string): Promise<SendResult> {
    const result = await this.callAction('_send_group_notice', {
      group_id: Number(groupId),
      content,
    })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /** 兼容旧调用：只要一个数字时用这个（内部仍走两维度判定）。 */
  async getAtAllRemain(groupId: string): Promise<number | undefined> {
    const snapshot = await this.getAtAllQuota(groupId)
    if (snapshot === undefined) return undefined
    if (snapshot.canAtAll === false) return 0
    const values = [snapshot.remainGroup, snapshot.remainAccount].filter((v): v is number => typeof v === 'number')
    return values.length === 0 ? undefined : Math.min(...values)
  }

  /** 撤回消息。 */
  async deleteMessage(messageId: string): Promise<SendResult> {
    // ⚠️ 精度守卫（审计 §5d）：观测到的值是 10 位（远小于 2^53），
    //   但**失败形态是静默的** —— `Number()` 一旦取整，撤回/表情回应会打到
    //   错的（或不存在的）消息上，而调用方只看得到 retcode != 0。
    //   所以不安全就**报错而不是截断**。
    const numeric = safeMessageId(messageId)
    if (numeric === undefined) {
      return { ok: false, error: `消息 id 不是安全整数，拒绝发送以免打到错的消息上：${messageId}` }
    }
    const result = await this.callAction('delete_msg', { message_id: numeric })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  // ── 入站媒体的取回（P1-2 语音 / P2-b 文件）──────────────────────────────

  /**
   * ★ P1-2：语音转文字（`fetch_ptt_text`）。
   *
   * 实测（容器内 `napcat.mjs` 的 `FetchPttText`，见 `transport.ts` 的说明）：
   * 入参 `{message_id}`（Number|String，必填），返回 `{text}`，
   * 失败是**明确报错**（`消息中不包含语音` / `消息不存在或已被撤回` / `获取语音转文字结果失败`）。
   * ⇒ 正好能渲染成"看得见的失败"，而不是让模型以为对方发了一条空语音。
   */
  async fetchPttText(messageId: string): Promise<PttTextResult> {
    const result = await this.callAction<{ text?: string }>('fetch_ptt_text', { message_id: messageId })
    if (!result.ok) {
      this.log(`语音转写失败（${messageId}）：${result.error ?? '未知原因'}`)
      return { ok: false, error: result.error ?? '未知原因' }
    }
    const text = typeof result.data?.text === 'string' ? result.data.text : ''
    if (text.trim() === '') {
      // ⚠️ **空串也要算失败**：NapCat 的 returnSchema 说 `text` 必填，
      //    真收到空串只可能是"转写引擎给了个空的"。把它当成功会让模型看到
      //    `[语音转写]`（后面什么都没有）—— 那正是本项目反复栽的"静默空白"。
      this.log(`语音转写返回空文本（${messageId}）—— 当失败处理`)
      return { ok: false, error: '协议端返回了空文本（可能是转写引擎没有结果）' }
    }
    return { ok: true, text }
  }

  /**
   * ★ P2-b：取文件信息（`get_file`）。
   *
   * 实测（`GetFile._handle`）三条路：
   *  1. `file` 是内部令牌（`Xt.decode` 命中，令牌在**解析消息时**登记，是个有上限的 LRU
   *     ⇒ **老消息可能已经不在表里**）⇒ 让协议端下载并回本地路径；
   *  2. `file` 是 modelId ⇒ 同上下载；
   *  3. 否则按**文件名搜索**（`searchForFile`）⇒ 命中就下载。
   * 三条都不中 ⇒ 抛 `file not found`。
   *
   * ⇒ 返回 `undefined` 表示"取不回"（调用方必须渲染成**看得见的**占位符）。
   */
  async getFileInfo(input: { readonly file?: string; readonly fileId?: string }): Promise<FileInfo | undefined> {
    const file = input.file ?? input.fileId ?? ''
    if (file === '') {
      this.log('取文件信息失败：既没有 file 也没有 file_id')
      return undefined
    }
    const result = await this.callAction<{ file?: string; url?: string; file_size?: string; file_name?: string }>('get_file', {
      file,
      ...(input.fileId === undefined ? {} : { file_id: input.fileId }),
    })
    if (!result.ok) {
      this.log(`取文件信息失败（${file}）：${result.error ?? '未知原因'}`)
      return undefined
    }
    return {
      ...(typeof result.data?.file === 'string' ? { file: result.data.file } : {}),
      ...(typeof result.data?.url === 'string' ? { url: result.data.url } : {}),
      ...(typeof result.data?.file_size === 'string' ? { fileSize: result.data.file_size } : {}),
      ...(typeof result.data?.file_name === 'string' ? { fileName: result.data.file_name } : {}),
    }
  }

  // ── 合并转发 ─────────────────────────────────────────────────────────────

  /**
   * 发**合并转发**。
   *
   * ## 为什么三个 action 要在这里分流（而不是交给协议端挑）
   *
   * NapCat 的 `send_forward_msg` 虽然也带 `group_id` / `user_id` 参数，
   * 但它的 `la`（会话类型枚举）在 `base_handle` 里是**按 message_type 覆盖**的：
   * 显式用 `send_group_forward_msg` / `send_private_forward_msg` 更直白，
   * 也避免"参数里带了 group_id 却被判成私聊"这类猜错目标的灾难
   * （与 `qq_reply` 必须显式给 conversation 是同一条理由）。
   *
   * ⚠️ **不允许把 node 和普通段混在一起**：NapCat 的 `check()` 会直接判非法，
   * 原话「转发消息不能和普通消息混在一起发送,转发需要保证message只有type为node的元素」。
   * 所以这里也不再拼接任何普通段 —— 想加一句说明就分两条消息发。
   */
  async sendForward(conversation: ConversationRef, nodes: readonly unknown[]): Promise<SendResult> {
    if (nodes.length === 0) return { ok: false, error: '合并转发至少要有一个节点' }
    const action = conversation.kind === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg'
    const params =
      conversation.kind === 'group'
        ? { group_id: Number(conversation.chatId), messages: nodes }
        : { user_id: Number(conversation.chatId), messages: nodes }
    const result = await this.callAction<{ message_id?: number | string; res_id?: string; forward_id?: string }>(action, params)
    return result.ok
      ? {
          ok: true,
          ...(result.data?.message_id === undefined ? {} : { messageId: String(result.data.message_id) }),
        }
      : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /**
   * 取**合并转发的内容**（`get_forward_msg`）。
   *
   * 这是"内容别丢"的关键一步。实测事实：
   *  - 入参 `{ message_id }`（NapCat 也接受 `{ id }`），两个都没有会抛 `message_id is required`；
   *  - 返回 `{ messages: [...] }`，元素是**完整消息对象**（`parseMultMsg` 打开时）
   *    或 node（其它实现）；两种都由 `parseForwardMessages` 认。
   *
   * ⚠️ 取不到时返回 `undefined`，**不返回空文本** ——
   * "取失败"与"里面真的没内容"必须能分开，否则模型会把取失败当成"这段是空的"。
   */
  async getForward(messageId: string): Promise<ForwardContent | undefined> {
    const result = await this.callAction<{ messages?: unknown }>('get_forward_msg', { message_id: messageId })
    if (!result.ok) {
      this.log(`取合并转发失败（${messageId}）：${result.error ?? '未知原因'}`)
      return undefined
    }
    const messages = extractForwardMessages(result.data)
    if (messages === undefined) {
      this.log(`取合并转发失败（${messageId}）：返回里没有 messages 数组`)
      return undefined
    }
    const parsed = parseForwardMessages(messages)
    return { messageId, text: parsed.text, nodeCount: parsed.nodeCount, notes: parsed.notes }
  }

  // ── 好友 / 群请求与列表 ──────────────────────────────────────────────────

  /**
   * 同意/拒绝**好友申请**。
   *
   * ⚠️ 实测事实：NapCat 的 `flag` 就是 `buddyReqs[].reqTime`
   * （`find((i) => i.reqTime === e.flag.toString())`），找不到会抛 `No such request`。
   * ⇒ flag **只能从上报里拿**，凭空构造一定失败。
   */
  async handleFriendRequest(flag: string, approve: boolean, remark?: string): Promise<SendResult> {
    const result = await this.callAction('set_friend_add_request', {
      flag,
      approve,
      ...(remark === undefined || remark === '' ? {} : { remark }),
    })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /**
   * 同意/拒绝**入群请求或邀请**。
   *
   * ⚠️ 实测事实：NapCat 的 `flag` 是群系统通知的 `seq`，它自己会先找"可疑申请"
   * 再找普通申请（`findNotify`）。**不需要** OneBot 文档里的 `sub_type` ——
   * 实读的 payload schema 里根本没有这一项。
   */
  async handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<SendResult> {
    const result = await this.callAction('set_group_add_request', {
      flag,
      approve,
      // 拒绝理由默认一个空格：NapCat 的 schema 默认就是 `' '`，
      // 传空串在 QQ 客户端上会显示成"无理由"，与默认行为不一致。
      ...(reason === undefined || reason === '' ? {} : { reason }),
    })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }

  /** 好友列表。 */
  async listFriends(): Promise<readonly FriendBrief[] | undefined> {
    const result = await this.callAction<unknown>('get_friend_list', {})
    if (!result.ok || !Array.isArray(result.data)) return undefined
    const out: FriendBrief[] = []
    for (const raw of result.data) {
      const item = raw as Record<string, unknown>
      const userId = item['user_id']
      if (userId === undefined) continue
      out.push({
        userId: String(userId),
        nickname: String(item['nickname'] ?? ''),
        ...(item['remark'] === undefined || item['remark'] === '' ? {} : { remark: String(item['remark']) }),
      })
    }
    return out
  }

  /** 群列表。 */
  async listGroups(): Promise<readonly GroupBrief[] | undefined> {
    const result = await this.callAction<unknown>('get_group_list', {})
    if (!result.ok || !Array.isArray(result.data)) return undefined
    const out: GroupBrief[] = []
    for (const raw of result.data) {
      const item = raw as Record<string, unknown>
      const groupId = item['group_id']
      if (groupId === undefined) continue
      out.push({
        groupId: String(groupId),
        groupName: String(item['group_name'] ?? ''),
        ...(typeof item['member_count'] === 'number' ? { memberCount: item['member_count'] } : {}),
        ...(typeof item['max_member_count'] === 'number' ? { maxMemberCount: item['max_member_count'] } : {}),
      })
    }
    return out
  }

  /** 群成员列表。 */
  async listGroupMembers(groupId: string): Promise<readonly GroupMemberBrief[] | undefined> {
    const result = await this.callAction<unknown>('get_group_member_list', { group_id: Number(groupId) })
    if (!result.ok || !Array.isArray(result.data)) return undefined
    const out: GroupMemberBrief[] = []
    for (const raw of result.data) {
      const item = raw as Record<string, unknown>
      const userId = item['user_id']
      if (userId === undefined) continue
      out.push({
        userId: String(userId),
        nickname: String(item['nickname'] ?? ''),
        ...(item['card'] === undefined || item['card'] === '' ? {} : { card: String(item['card']) }),
        ...(item['role'] === undefined ? {} : { role: String(item['role']) }),
      })
    }
    return out
  }

  /** 订阅事件。 */
  onEvent(handler: (event: InboundEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** 当前状态。 */
  status(): TransportStatus {
    return {
      connected: this.state.connected,
      // ★ P1-3：`connected` 只说"WS 通着"，`qqOnline` 才是"QQ 那头真的在线"。
      // 两者不一致（true / false）正是那次 35 小时事故的形态 —— 必须能分辨。
      ...(this.state.qqOnline === undefined ? {} : { qqOnline: this.state.qqOnline }),
      ...(this.state.selfId === undefined ? {} : { selfId: this.state.selfId }),
      ...(this.state.since === undefined ? {} : { since: this.state.since }),
      ...(this.state.lastError === undefined ? {} : { lastError: this.state.lastError }),
    }
  }

  /** 停止。 */
  async stop(): Promise<void> {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('传输层正在停止'))
      this.pending.delete(echo)
    }
    const socket = this.socket
    this.socket = undefined
    this.state.connected = false
    if (socket !== undefined) {
      try {
        socket.close(1001, 'server shutting down')
      } catch {
        // 忽略关闭失败
      }
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** 便捷：从配置构造（供 gateway 主流程用）。 */
export function createOneBotTransport(options: OneBotTransportOptions): OneBotTransport {
  return new OneBotTransport(options)
}

/** 会话键辅助（对外暴露，避免各处自己拼）。 */
export { conversationKey }

