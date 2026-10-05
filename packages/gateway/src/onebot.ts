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
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  conversationKey,
  type ConversationRef,
  type InboundEvent,
  type InboundMessage,
  type OutboundSegment,
  type QqTransport,
  type SendResult,
  type TransportStatus,
} from './transport.ts'

/** 适配器配置。 */
export interface OneBotTransportOptions {
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
    Pick<OneBotTransportOptions, 'accessToken'>
  private readonly log: (message: string) => void
  private server: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, PendingAction>()
  private readonly handlers = new Set<(event: InboundEvent) => void>()
  private readonly state: { connected: boolean; selfId?: string; since?: string; lastError?: string } = { connected: false }

  constructor(options: OneBotTransportOptions) {
    this.options = {
      port: options.port,
      host: options.host ?? '127.0.0.1',
      path: options.path ?? '/',
      actionTimeoutMs: options.actionTimeoutMs ?? 10_000,
      ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
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
      return undefined
    }

    if (postType === 'request') {
      const requestType = record['request_type']
      return {
        type: 'request',
        kind: requestType === 'group' ? 'group' : 'friend',
        userId: String(record['user_id'] ?? ''),
        ...(record['group_id'] === undefined ? {} : { groupId: String(record['group_id']) }),
        comment: String(record['comment'] ?? ''),
        flag: String(record['flag'] ?? ''),
        at,
      }
    }

    if (postType === 'meta_event') {
      if (record['meta_event_type'] === 'lifecycle' && record['sub_type'] === 'connect') {
        this.state.connected = true
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
        mediaKind = 'image'
        text += '[图片]'
      } else if (type === 'file') {
        mediaKind = 'file'
        text += '[文件]'
      } else if (type === 'record') {
        mediaKind = 'record'
        text += '[语音]'
      } else if (type === 'video') {
        mediaKind = 'video'
        text += '[视频]'
      } else if (type === 'reply') {
        text += '[引用]'
      }
    }

    // 私聊/临时会话里"被 @"恒真（对方就是在找我说话）
    if (kind !== 'group') mentionedMe = true

    return {
      messageId: String(record['message_id'] ?? randomUUID()),
      conversation,
      senderId: userId,
      senderName: String((record['sender'] as Record<string, unknown> | undefined)?.['card'] ?? (record['sender'] as Record<string, unknown> | undefined)?.['nickname'] ?? ''),
      text: text.trim(),
      mentionedMe,
      mentionedAll,
      isPoke: false,
      ...(mediaKind === undefined ? {} : { mediaKind }),
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
    const result = await this.callAction('set_msg_emoji_like', { message_id: Number(messageId), emoji_id: emoji })
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

  /** 查群 @全体剩余次数。 */
  async getAtAllRemain(groupId: string): Promise<number | undefined> {
    const result = await this.callAction<{ can_at_all?: boolean; remain_at_all_count_for_group?: number }>('get_group_at_all_remain', {
      group_id: Number(groupId),
    })
    if (!result.ok) return undefined
    if (result.data?.can_at_all === false) return 0
    return result.data?.remain_at_all_count_for_group
  }

  /** 撤回消息。 */
  async deleteMessage(messageId: string): Promise<SendResult> {
    const result = await this.callAction('delete_msg', { message_id: Number(messageId) })
    return result.ok ? { ok: true } : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
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

