/**
 * 网关主循环：把运输层、队列、调度、轮次串成一台能跑起来的机器。
 *
 * ## 循环形状
 *
 * ```
 * transport.onEvent ──► 落库(qq_inbox) ──► 防抖 ──► 调度器入队
 *                                                     │
 *                        调度器.next() ◄───────────────┘
 *                             │
 *              同会话串行(KeyedMutex) ──► TurnRunner.handleBatch
 *                             │
 *                        驱动模型 ──► 出站动作入队
 *                             │
 *              出站消费者：认领 ──► transport.send ──► 确认/失败
 * ```
 *
 * 三个"必须"：
 *  - **同会话串行**：否则回复会交叉错乱；
 *  - **跨会话并行**：否则一个慢会话会拖死所有人；
 *  - **出站与入站解耦**：模型说了什么 ≠ 平台收到什么，各自可重试。
 *
 * @module @forlife/gateway/gateway
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

import { claimPendingOutbound, confirmOutbound, failOutbound, reclaimStaleOutbound, type OutboxRow } from './outbox.ts'
import { TurnScheduler } from './scheduler.ts'
import { Debouncer, KeyedMutex } from './timing.ts'
import { conversationKey, type ConversationRef, type InboundEvent, type InboundMessage, type OutboundSegment, type QqTransport } from './transport.ts'
import { TurnRunner, type TurnRunResult } from './turns.ts'

/** 网关配置。 */
export interface GatewayOptions {
  readonly db: DatabaseSync
  readonly transport: QqTransport
  readonly runner: TurnRunner
  /** 防抖窗口（毫秒，PLAN §8.4：2–3 秒）。 */
  readonly debounceMs?: number
  /** 出站消费者轮询间隔。 */
  readonly outboxPollMs?: number
  /** 单次认领的出站动作上限。 */
  readonly outboxBatch?: number
  readonly log?: (message: string) => void
  /** 注入时钟（测试用）。 */
  readonly now?: () => number
}

/** 网关状态（面板用）。 */
export interface GatewayState {
  readonly running: boolean
  readonly queuedConversations: number
  readonly pendingInbound: number
  readonly turnsHandled: number
  readonly turnsFailed: number
  /** 判定为不唤醒（没花模型资源）的批次数。 */
  readonly skipped: number
  readonly outboundSent: number
  readonly outboundFailed: number
  readonly lastError?: string
}

/**
 * 网关。
 */
export class Gateway {
  private readonly options: Required<Pick<GatewayOptions, 'debounceMs' | 'outboxPollMs' | 'outboxBatch'>> & GatewayOptions
  private readonly log: (message: string) => void
  private readonly scheduler: TurnScheduler
  private readonly mutex = new KeyedMutex()
  private readonly debouncer: Debouncer
  /** 防抖窗口内正在累积的消息（按会话键）。 */
  private readonly buffered = new Map<string, InboundMessage[]>()
  /**
   * 防抖窗口已关闭、但轮次还没开始的消息（按会话键）。
   *
   * **必须有这一层**：结算与执行是异步的两步（要等调度器按优先级/冷却放行）。
   * 早期版本在结算时就把消息从 buffered 里删了，执行时取到空数组 ——
   * 消息被静默丢掉，而且日志上看起来"防抖结算成功"。这类 bug 必须靠端到端测试抓。
   */
  private readonly ready = new Map<string, InboundMessage[]>()
  private unsubscribe: (() => void) | undefined
  private outboxTimer: ReturnType<typeof setInterval> | undefined
  private schedulerTimer: ReturnType<typeof setInterval> | undefined
  private running = false
  private stats = { turnsHandled: 0, turnsFailed: 0, skipped: 0, outboundSent: 0, outboundFailed: 0, lastError: undefined as string | undefined }

  constructor(options: GatewayOptions) {
    this.options = { debounceMs: options.debounceMs ?? 3000, outboxPollMs: options.outboxPollMs ?? 500, outboxBatch: options.outboxBatch ?? 20, ...options }
    this.log = options.log ?? ((): void => {})
    this.scheduler = new TurnScheduler({
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.debouncer = new Debouncer({
      windowMs: this.options.debounceMs,
      ...(options.now === undefined ? {} : { now: options.now }),
      onFlush: (key, ids) => this.onDebounceFlush(key, ids),
    })
  }

  /** 启动：订阅入站事件并开启出站/调度循环。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.unsubscribe = this.options.transport.onEvent((event) => this.onEvent(event))
    this.outboxTimer = setInterval(() => void this.drainOutbox(), this.options.outboxPollMs)
    this.schedulerTimer = setInterval(() => void this.pumpScheduler(), Math.max(50, Math.floor(this.options.outboxPollMs / 2)))
    this.log('网关已启动')
  }

  /** 停止（幂等）。 */
  async stop(): Promise<void> {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.outboxTimer !== undefined) clearInterval(this.outboxTimer)
    if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer)
    this.outboxTimer = undefined
    this.schedulerTimer = undefined
    this.debouncer.flushAll()
    this.log('网关已停止')
  }

  /** 当前状态。 */
  state(): GatewayState {
    const base = {
      running: this.running,
      queuedConversations: this.scheduler.size(),
      pendingInbound: this.buffered.size,
      turnsHandled: this.stats.turnsHandled,
      turnsFailed: this.stats.turnsFailed,
      skipped: this.stats.skipped,
      outboundSent: this.stats.outboundSent,
      outboundFailed: this.stats.outboundFailed,
    }
    // exactOptionalPropertyTypes：lastError 只在真的有错时才带
    return this.stats.lastError === undefined ? base : { ...base, lastError: this.stats.lastError }
  }

  /** 处理一个入站事件。 */
  private onEvent(event: InboundEvent): void {
    if (event.type !== 'message' && event.type !== 'message_sent') {
      // 其它事件（撤回/掉线/入群申请…）落到各自的处理路径；当前先记审计，避免静默丢弃
      this.recordNonMessageEvent(event)
      return
    }
    const message = event.message
    if (message.isSelf) {
      // 多端一致性：自己在别处发的消息要记录，但不唤醒自己
      this.recordSelfMessage(message)
      return
    }
    this.persistInbound(message)
    const key = conversationKey(message.conversation)
    const list = this.buffered.get(key)
    if (list === undefined) this.buffered.set(key, [message])
    else list.push(message)
    this.debouncer.push(key, message.messageId)
  }

  /** 防抖窗口关闭：把该会话的消息移交到"待执行"并交给调度器。 */
  private onDebounceFlush(key: string, ids: readonly string[]): void {
    const messages = this.buffered.get(key) ?? []
    this.buffered.delete(key)
    if (messages.length === 0) return

    // 移交（而不是丢弃）：如果上一批还没被调度走，就并进去
    const existing = this.ready.get(key)
    this.ready.set(key, existing === undefined ? messages : [...existing, ...messages])

    // 条件由轮次执行器判定（它拿得到消息特征），这里只按会话入队 —— 合并是关键：
    // 话痨群刷再多条也只占一个排队位。
    this.scheduler.enqueue({ conversationKey: key, condition: 'group_message_any' })
    this.log(`防抖结算 ${key}：${String(messages.length)} 条（${ids.length} 个 id）`)
    void this.pumpScheduler()
  }

  /** 调度循环：取下一个可服务的会话并处理（同会话串行）。 */
  private async pumpScheduler(): Promise<void> {
    if (!this.running) return
    for (;;) {
      const item = this.scheduler.next()
      if (item === undefined) return
      // 先 release 再执行：否则同一会话会被反复取出。
      // **记账推迟到轮次跑完**：只有真的唤醒（花了模型资源）才该进入冷却与配额，
      // 否则群里闲聊会不断刷新冷却，等真有人 @ 我时反而要排队。
      this.scheduler.release(item.conversationKey)
      // 取待执行的消息；若防抖窗口还没关（没有 ready），就看 buffered 里已攒下的
      const messages = this.ready.get(item.conversationKey) ?? this.buffered.get(item.conversationKey) ?? []
      this.ready.delete(item.conversationKey)
      this.buffered.delete(item.conversationKey)
      if (messages.length === 0) continue
      const controller = new AbortController()
      void this.mutex
        .run(item.conversationKey, async () => this.options.runner.handleBatch(messages, controller.signal))
        .then((result) => this.onTurnDone(item.conversationKey, result))
        .catch((error: unknown) => {
          this.stats.turnsFailed += 1
          this.stats.lastError = String(error)
          this.log(`轮次异常：${String(error)}`)
        })
    }
  }

  /** 轮次收尾统计。 */
  private onTurnDone(key: string, result: TurnRunResult): void {
    if (result.woken) {
      this.stats.turnsHandled += 1
      this.scheduler.charge(key) // 花了模型资源 ⇒ 才记冷却与配额
    } else {
      // 没花资源：不进冷却，但把结果记下来（面板与排障要看"哪些批次被跳过了、为什么"）
      this.stats.skipped += 1
      this.log(`未唤醒（${result.reason}）：${key}`)
    }
    // 可能还有等待中的会话（冷却刚结束/配额刚重置）
    void this.pumpScheduler()
  }

  /** 出站消费者：认领 → 发送 → 确认/失败。 */
  private async drainOutbox(): Promise<void> {
    if (!this.running) return
    try {
      // 自愈：卡在 sending 超过 30 秒的（多半是上次崩溃留下的）
      reclaimStaleOutbound(this.options.db, 30_000)
      const claimed = claimPendingOutbound(this.options.db, { limit: this.options.outboxBatch })
      for (const row of claimed) {
        await this.deliver(row)
      }
    } catch (error) {
      this.stats.lastError = String(error)
      this.log(`出站消费异常：${String(error)}`)
    }
  }

  /** 送一条出站动作。 */
  private async deliver(row: OutboxRow): Promise<void> {
    // kind 取自队列行（会话键里没有 kind —— 靠猜会把群消息发成私聊）
    const parsed = parseConversationKeySafe(row.conversation_key, row.conversation_kind)
    if (parsed === undefined) {
      failOutbound(this.options.db, row.id, `会话键无法解析：${row.conversation_key}`)
      this.stats.outboundFailed += 1
      return
    }
    const payload = JSON.parse(row.payload) as { segments?: OutboundSegment[]; messageId?: string; emoji?: string; typing?: boolean }
    try {
      const result =
        row.kind === 'reaction'
          ? await this.options.transport.sendReaction(payload.messageId ?? '', payload.emoji ?? '')
          : row.kind === 'input_status'
            ? await this.options.transport.setInputStatus(parsed, payload.typing === true)
            : row.kind === 'delete'
              ? await this.options.transport.deleteMessage(payload.messageId ?? '')
              : row.kind === 'mention_all'
                ? await this.options.transport.mentionAll(parsed, payload.segments ?? [])
                : await this.options.transport.sendMessage(parsed, payload.segments ?? [])

      if (result.ok) {
        confirmOutbound(this.options.db, row.id, result.messageId)
        this.stats.outboundSent += 1
      } else {
        // 平台明确拒绝 ⇒ 不重试（反复撞只会加重风控）
        failOutbound(this.options.db, row.id, result.error ?? '平台拒绝')
        this.stats.outboundFailed += 1
      }
    } catch (error) {
      // 网络类异常 ⇒ 可重试
      failOutbound(this.options.db, row.id, String(error), { retryable: true })
      this.stats.outboundFailed += 1
    }
  }

  /** 入站落库（先落库再处理：崩溃可恢复）。 */
  private persistInbound(message: InboundMessage): void {
    this.options.db
      .prepare(
        `INSERT INTO qq_inbox (id, conversation_key, platform_msg_id, sender_id, sender_name, is_group, is_self,
                               mentioned_me, mentioned_all, is_poke, media_kind, text, payload, at, received_at,
                               processed, merged_into, attempt, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        message.messageId,
        conversationKey(message.conversation),
        message.messageId,
        message.senderId,
        message.senderName,
        message.conversation.kind === 'group' ? 1 : 0,
        0,
        message.mentionedMe ? 1 : 0,
        message.mentionedAll ? 1 : 0,
        message.isPoke ? 1 : 0,
        message.mediaKind ?? null,
        message.text,
        JSON.stringify(message.raw ?? {}),
        message.at,
        nowIso(),
      )
    this.options.db
      .prepare(
        `INSERT INTO qq_sessions (conversation_key, platform, chat_id, thread_id, kind, title, last_message_at, last_read_at, created_at)
         VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET last_message_at = excluded.last_message_at`,
      )
      .run(
        conversationKey(message.conversation),
        message.conversation.platform,
        message.conversation.chatId,
        message.conversation.kind,
        message.at,
        nowIso(),
      )
  }

  /** 记录"自己在别处发的消息"（多端一致性：要进记忆，但不唤醒自己）。 */
  private recordSelfMessage(message: InboundMessage): void {
    this.persistInbound({ ...message, isSelf: true })
    this.options.db
      .prepare(
        `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
         VALUES (?, 'self_message', 'system', ?, ?, 1, 0, ?)`,
      )
      .run(`eff_self_${message.messageId}`, conversationKey(message.conversation), JSON.stringify({ text: message.text }), nowIso())
  }

  /** 非消息事件：先落审计，避免"事件来了但没人管"这种静默丢失。 */
  private recordNonMessageEvent(event: InboundEvent): void {
    this.options.db
      .prepare(
        `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
         VALUES (?, ?, 'system', NULL, ?, 1, 0, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(`eff_evt_${Math.random().toString(36).slice(2, 10)}`, `qq_event:${event.type}`, JSON.stringify(event), nowIso())
  }
}

/**
 * 解析队列行里的会话键。
 *
 * kind **必须由调用方从行上取**：会话键（§8.4）只有 platform:chat_id[:thread_id]，
 * 不含会话类型。早期版本在这里写死 'private'，于是群消息被当成私聊发出去 ——
 * 这是那种"测试全绿、线上没人收到"的典型错误。
 *
 * @param key - 会话键。
 * @param kind - 行上记录的会话类型。
 * @returns 会话引用，或 undefined（键不合法）。
 */
function parseConversationKeySafe(key: string, kind: 'group' | 'private' | 'temp'): ConversationRef | undefined {
  const [platform, chatId, ...rest] = key.split(':')
  if (platform === undefined || chatId === undefined || platform === '' || chatId === '') return undefined
  const threadId = rest.join(':')
  return threadId === '' ? { platform, chatId, kind } : { platform, chatId, threadId, kind }
}




