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
import { decideWithLedger, newMentionLedger } from './mention-quota.ts'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { markEffectsReported, recordEffect, nowIso } from '@forlife/store'

import { ADMIN_CHAT_KEY, appendModelReply, buildAdminPrompt, markHandled, takePendingHumanMessages } from './admin-chat.ts'
import { backlogNotice, decideBacklogWake, renderBacklogNotice } from './backlog.ts'
import { deliverPacing, decideSendQuota } from './limits.ts'
import { defaultAttachmentRoot, resolveMediaBatch, type ImageVisionPort } from './media-resolve.ts'
import type { BinaryFetchLike } from './media-resolve.ts'
import { claimPendingOutbound, confirmOutbound, failOutbound, reclaimStaleOutbound, type OutboxRow } from './outbox.ts'
import { collectReportable, isAwake, markReported, renderReport } from './reports.ts'
import { isProbeAction, runProbe, writeProbeResult } from './probe.ts'
import { listPendingRequests, recordInboundRequest, renderRequestNotice, requestNotice } from './requests.ts'
import { TurnScheduler } from './scheduler.ts'
import { Debouncer, KeyedMutex } from './timing.ts'
import { conversationKey, type ConversationRef, type InboundEvent, type InboundMessage, type OutboundSegment, type QqTransport } from './transport.ts'
import { TurnRunner, type TurnRunResult } from './turns.ts'
import { recordTyping } from './typing-state.ts'

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
  /** 后台对话轮次用哪个"会话"（默认 panel:admin，与 QQ 会话区分开）。 */
  readonly adminConversationKey?: string
  /**
   * 接管模式的读取器（每次入站都问一次，所以开关改动**立即生效**，不需要重启）。
   *
   * 不传 = 永远不接管（默认行为不变）。
   */
  readonly takeover?: (() => boolean) | undefined
  /**
   * ★ P1-1：**视觉桥接**（`VisionBridge`）。
   *
   * 为什么是一个"端口"而不是让网关自己 new 一个：网关**不该知道**视觉模型在哪
   * （生产是环境变量配的 HTTP 端点、开发可能挂在宿主的 llm 服务上），
   * 而它必须知道"这张图有没有被看懂、失败时给模型看什么"。
   *
   * **不传 ⇒ 图片仍然是一个带原因的占位符**（`[图片（未看：…）]` 或桥接的
   * "没有可用的视觉模型"），**不是空白** —— 这条是本项目反复栽过的坑。
   */
  readonly imageVision?: ImageVisionPort | undefined
  /** 入站媒体落盘根目录（默认 `defaultAttachmentRoot()`，内容寻址）。 */
  readonly imageStorageRoot?: string | undefined
  /** 注入下载器（测试用；不传走真实 fetch）。 */
  readonly mediaFetch?: BinaryFetchLike | undefined
  /**
   * ★ **系统监督循环**（默认**关**）。
   *
   * 它一轮做三件事，全都是"把已经存在但没人读的信息交给模型"：
   *
   *  1. **P0-2：接通 `runReportCycle`** —— `reports.ts` 那套（铁律 1"后台任何影响模型的操作
   *     都要报告"）**写好了但生产零调用**，于是好友申请/群邀请/被撤回/被踢/群文件到了
   *     这些"记进 `effects` 了就再没人看"的事件**永远到不了模型**。这一条把它接上。
   *  2. **待处理请求提醒**（谁在加它、附言是什么）—— 与 1 同源，但用更清楚的措辞渲染。
   *  3. **离线积压提醒**（任务②的 (a)(b)）—— 只报"有 N 条没读"，
   *     并且**用单独的那组参数**（`pending_backlog`）决定要不要为它开口。
   *
   * ## 为什么走 `runDirect`（一个独立的系统轮次）而不是往提示词里塞一行
   *
   * 本来最自然的做法是在 `buildTurnPrompt` 里加一段 —— **但那属于 `turns.ts`，
   * 本轮有另一个改动正在改它**，按纪律不能动。走 `runDirect` 反而有个额外好处：
   * 积压提醒是一个**议程只有积压的独立轮次**，不会被"这轮正在回别人"挤掉。
   *
   * ⚠️ 代价（已如实记在交付报告里）：**它不在"回复别人"那一轮的提示词里出现**。
   * 等 `turns.ts` 腾出来后，应当在 `buildTurnPrompt` 里也加一段（同样只报计数）。
   *
   * ## 为什么要"没有 running 轮次"才跑
   *
   * 单窗口模型：并发两个轮次会互相抢上下文。而且模型**已经醒着**时它自己就会
   * 调 `read_pending`（`qq_reply` 的描述里要求了），不必再插一轮。
   */
  readonly supervisor?: {
    readonly enabled: boolean
    /** 检查间隔（默认读基线 `qq.supervisor.intervalMs`）。 */
    readonly intervalMs?: number
    /** 系统轮次用的会话键（默认 `forlife:system`，符合铁律 2 的允许来源）。 */
    readonly conversationKey?: string
  }
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
  private adminTimer: ReturnType<typeof setInterval> | undefined
  private supervisorTimer: ReturnType<typeof setInterval> | undefined
  /** 监督循环是否有一轮在跑（防重入：一轮可能跑几百毫秒）。 */
  private supervising = false
  /** 后台对话是否有一轮在跑（避免并发回答同一个人）。 */
  private adminBusy = false
  private running = false
  /** @全体 的本地账本（只做减法，防 Napke 额度接口滞后导致连发超限）。 */
  private readonly mentionLedger = newMentionLedger()

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
    // 后台对话：与 QQ 分开的循环 —— 它的消息来自运维本人，**不走唤醒判定**
    this.adminTimer = setInterval(() => void this.consumeAdminChat(), Math.max(100, this.options.outboxPollMs))
    // 系统监督：报告 / 待处理请求 / 离线积压（默认关，只有显式开启才跑）
    if (this.options.supervisor?.enabled === true) {
      const intervalMs = this.options.supervisor.intervalMs ?? defaultFor<number>('qq.supervisor.intervalMs')
      this.supervisorTimer = setInterval(() => void this.supervise(), Math.max(1000, intervalMs))
      this.log(`系统监督已开启（每 ${String(Math.max(1000, intervalMs))}ms 检查一次报告/请求/积压）`)
    }
    this.log('网关已启动')
  }

  /** 停止（幂等）。 */
  async stop(): Promise<void> {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.outboxTimer !== undefined) clearInterval(this.outboxTimer)
    if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer)
    if (this.adminTimer !== undefined) clearInterval(this.adminTimer)
    if (this.supervisorTimer !== undefined) clearInterval(this.supervisorTimer)
    this.outboxTimer = undefined
    this.schedulerTimer = undefined
    this.adminTimer = undefined
    this.supervisorTimer = undefined
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
      // ★ 「对方正在输入」是**瞬时信号**：它不该进待办队列（会让"还剩几条"失真），
      //   也不该靠 `effects` 报告（那种时效性到模型手里已经过期了）。
      //   ⇒ 记进 `forlife_state`（**自带过期时刻**），由 `read_pending` 现问现答。
      //   ⚠️ 落 `effects` 的那一行仍然保留（它是一致的审计轨迹）。
      if (event.type === 'peer_input_status') {
        recordTyping(this.options.db, {
          conversationKey: conversationKey(event.conversation),
          eventType: event.eventType,
          statusText: event.statusText,
        })
      }
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
      // 接管模式（qq_takeover）：消息**照常入库**（运维要看得到），但**不进模型** ——
      // 也不推给防抖器，于是不会产生轮次、`processed` 保持 0。
      // 这样面板上的"待处理入站"正好变成运维的待办箱，而不是一个只增不减的计数器。
      if (this.options.takeover?.() === true) {
        this.log(`接管模式：${key} 的消息只入库、不路由给模型（等人工处理）`)
        return
      }
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
      // ★ P0-3：**在真正要用之前**把合并转发的内容取回来。
      //
      //   为什么插在这里（而不是 `onEvent` 里）：`onEvent` 是**同步**的，而取内容要
      //   一次 WS 往返；而这里是 async 的、且是"马上要交给模型"的那一步 ——
      //   位置对了，取回来的东西就一定进得了提示词与待读池。
      const enriched = await this.resolveForwards(messages)
      // ★ P1-1 / P1-2 / P2-b：**同一位置**把图片/语音/文件变成文字。
      //   顺序在合并转发之后：合转里面也可能有图（摊平后的文本里是 `[图片]`），
      //   而摊平发生在 resolveForwards 里 —— 放前面就会漏掉那些。
      const withMedia = await this.resolveMedia(enriched)
      void this.mutex
        .run(item.conversationKey, async () => this.options.runner.handleBatch(withMedia, controller.signal))
        .then((result) => this.onTurnDone(item.conversationKey, result))
        .catch((error: unknown) => {
          this.stats.turnsFailed += 1
          this.stats.lastError = String(error)
          this.log(`轮次异常：${String(error)}`)
        })
    }
  }

  /**
   * ★ P0-3：把带 `forwardId` 的消息的**合并转发内容**取回来，替换掉占位符。
   *
   * ## 为什么必须做（这是"内容别丢"的关键一步）
   *
   * 实测（容器内 `/app/napcat/napcat.mjs` + 线上 `onebot11_<uin>.json`）：
   * 配置项 **`parseMultMsg` 默认 false**，线上就是 false
   * ⇒ 入站事件里的合并转发段**只有 `data.id`，没有 `content`**。
   * 不调 `get_forward_msg` 的话，那段聊天记录的内容**一个字都拿不到**。
   *
   * ## 取不到时**保留占位符**
   *
   * 保留 `[合并转发 id=…（内容未能取回）]` 而不是置空 ——
   * 让"取失败"是**看得见的**（模型能说"我看到有一段记录但取不回来"，
   * 而不是以为对方发了个空白）。
   *
   * ## 每次最多取几条
   *
   * `qq.forward.resolvePerBatch`：一次 WS 往返要几百毫秒，
   * 一批里若有十几条合并转发，串行取会把这一轮拖到超时。
   * 超出的那些**保留占位符**（模型可以之后用工具按 id 单独取）。
   *
   * @param messages - 本批消息。
   * @returns 内容已补上的消息（顺序与原批一致）。
   */
  private async resolveForwards(messages: readonly InboundMessage[]): Promise<readonly InboundMessage[]> {
    if (!messages.some((message) => message.forwardId !== undefined)) return messages
    let budget = defaultFor<number>('qq.forward.resolvePerBatch')
    const out: InboundMessage[] = []
    for (const message of messages) {
      const forwardId = message.forwardId
      if (forwardId === undefined || budget <= 0) {
        out.push(message)
        continue
      }
      budget -= 1
      let content
      try {
        content = await this.options.transport.getForward(forwardId)
      } catch (error) {
        this.log(`取合并转发异常（${forwardId}）：${String(error)}`)
        content = undefined
      }
      if (content === undefined || content.text === '') {
        this.log(`合并转发取回为空（${forwardId}）—— 保留占位符，不假装它是空消息`)
        out.push(message)
        continue
      }
      const notes = content.notes.length === 0 ? '' : `\n（注意：${content.notes.join('；')}）`
      // 用正则替换占位符：占位符的两种变体（已展开/未取回）都能命中，
      // 也不必让这里知道 `onbot.ts` 当初拼的是哪一种。
      const text = message.text.replace(/\[合并转发[^\]]*\]/, `${content.text}${notes}`)
      const patched: InboundMessage = { ...message, text }
      this.log(`合并转发已展开（${forwardId}）：${String(content.nodeCount)} 条`)
      // 顺手把库里的那一行也补上：面板、复盘、以及**待读池的摘要**都读它。
      // 只改内存的话，"没唤醒 ⇒ 进待读池"那条路看到的仍然是占位符。
      try {
        this.options.db.prepare('UPDATE qq_inbox SET text = ? WHERE id = ?').run(text, message.messageId)
      } catch (error) {
        this.log(`回填合并转发文本失败（${message.messageId}）：${String(error)}`)
      }
      out.push(patched)
    }
    return out
  }

  /** 轮次收尾统计。 */  private onTurnDone(key: string, result: TurnRunResult): void {    if (result.woken) {
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

  /**
   * ★ P1-1 / P1-2 / P2-b：把一批消息里的**图片 / 语音 / 文件**尽力变成文字。
   *
   * ## 为什么和 `resolveForwards` 分开（而不是合成一个方法）
   *
   * 两者的**成本形态**不同：合并转发是"一个 id 换一段文本"（几乎一定成功）；
   * 媒体是"下载 + 视觉调用 / 转写 / 协议端下载"（**会花钱、会超时、会失败**）。
   * 合成一个方法会让"合转取不回"和"图片看不清"共用一套降级策略 ——
   * 而它们的正确降级完全不同（前者保留 id 让模型重试，后者要说明为什么没看）。
   *
   * ## 失败**绝不吞掉整批**
   *
   * `resolveMediaBatch` 自称永不抛；这里再包一层 try ——
   * 这条链的位置决定了"抛出去"等于把用户的消息一起丢掉（本项目最贵的一类事故）。
   *
   * @param messages - 本批消息（合转已展开）。
   * @returns 文本已补上的消息（顺序不变）。
   */
  private async resolveMedia(messages: readonly InboundMessage[]): Promise<readonly InboundMessage[]> {
    const relevant = messages.some(
      (message) => (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0 || message.hasVoice === true,
    )
    if (!relevant) return messages
    try {
      const result = await resolveMediaBatch(messages, {
        db: this.options.db,
        transport: this.options.transport,
        vision: this.options.imageVision,
        storageRoot: this.options.imageStorageRoot ?? defaultAttachmentRoot(),
        log: (message) => this.log(message),
        ...(this.options.mediaFetch === undefined ? {} : { fetchImpl: this.options.mediaFetch }),
      })
      // 回填库里的那一行（与 `resolveForwards` 同一条理由）：
      // 面板、复盘、以及**待读池的摘要**读的都是 `qq_inbox.text`；
      // 只改内存的话，"没唤醒 ⇒ 进待读池"那条路看到的仍然是 `[图片]`。
      for (const message of result.patched) {
        try {
          this.options.db.prepare('UPDATE qq_inbox SET text = ? WHERE id = ?').run(message.text, message.messageId)
        } catch (error) {
          this.log(`回填媒体文本失败（${message.messageId}）：${String(error)}`)
        }
      }
      return result.messages
    } catch (error) {
      this.log(`入站媒体处理异常（整批保留占位符，不丢消息）：${String(error)}`)
      return messages
    }
  }

  /** 出站消费者：认领 → 发送 → 确认/失败。 */
  private async drainOutbox(): Promise<void> {
    if (!this.running) return
    try {
      // 自愈：卡在 sending 超过 30 秒的（多半是上次崩溃留下的）
      reclaimStaleOutbound(this.options.db, 30_000)
      // ★ 投递节拍（**发消息方向的第二道限制**）：
      //   与工具侧的速率闸门分工不同 —— 那个防"模型一口气刷 N 条"，
      //   这个防"我们以机器速度连调 QQ API"。放在**认领之前**，
      //   这样"还没到点"的行仍旧留在 pending（不会被认领后卡在 sending）。
      const pacing = deliverPacing(this.options.db)
      if (pacing.waitMs > 0) {
        this.log(`投递节拍：再等 ${String(pacing.waitMs)}ms（两条之间至少 ${String(pacing.minIntervalMs)}ms）`)
        return
      }
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
    const payload = JSON.parse(row.payload) as {
      segments?: OutboundSegment[]
      messageId?: string
      emoji?: string
      typing?: boolean
      content?: string
      /** `kind='forward'`：已构造好的 OneBot node 数组（见 `forward.ts`）。 */
      nodes?: unknown[]
      /** `kind='friend_request' | 'group_request'`：是否同意。 */
      approve?: boolean
      /** 处理请求时的理由/备注。 */
      reason?: string
      /** 请求的 flag（**必须来自上报**，凭空构造一定失败）。 */
      flag?: string
      /** `kind='probe'`：白名单里的只读查询动作与参数。 */
      probeAction?: string
      probeArgs?: Record<string, unknown>
    }

    // ★ @全体 的额度闸门。放在这里（而不是工具侧）是因为：
    //   ① transport 只在这一侧可见；
    //   ② `mentionAll()` 的注释写着「额度由调用方保证」—— 消费者就是那个调用方。
    //   不挡的话，额度用尽时 QQ 侧会拒绝，表现为"偶尔不生效"，极难查。
    if (row.kind === 'mention_all') {
      const snapshot = await this.options.transport.getAtAllQuota(parsed.chatId)
      const decision = decideWithLedger(snapshot ?? {}, this.mentionLedger)
      if (!decision.allowed) {
        // **平台侧没有拒绝，是我们自己拦下的** —— 所以要记成"策略拦截"而不是"发送失败"，
        // 否则统计里会把它算成 QQ 的问题，排障时会往错的方向查。
        failOutbound(this.options.db, row.id, `额度闸门拦截：${decision.reason}`)
        this.stats.outboundFailed += 1
        this.options.log?.(`[gateway] @全体 被额度闸门拦下：${decision.reason}`)
        return
      }
    }

    try {
      // ★ 只读查询走单独一条路：它**不能**用下面的 `transport.*` 三元链，
      //   因为结果要写回 `forlife_state` 让工具进程读到（见 probe.ts）。
      if (row.kind === 'probe') {
        const action = payload.probeAction
        if (!isProbeAction(action)) {
          failOutbound(this.options.db, row.id, `未知的查询动作：${String(action)}`)
          this.stats.outboundFailed += 1
          return
        }
        const probed = await runProbe(this.options.transport, action, payload.probeArgs ?? {})
        writeProbeResult(this.options.db, row.id, probed)
        if (probed.ok) {
          confirmOutbound(this.options.db, row.id)
          this.stats.outboundSent += 1
        } else {
          failOutbound(this.options.db, row.id, probed.error ?? '查询失败')
          this.stats.outboundFailed += 1
        }
        return
      }
      const result =
        row.kind === 'reaction'
          ? await this.options.transport.sendReaction(payload.messageId ?? '', payload.emoji ?? '')
          : row.kind === 'input_status'
            ? await this.options.transport.setInputStatus(parsed, payload.typing === true)
            : row.kind === 'delete'
              ? await this.options.transport.deleteMessage(payload.messageId ?? '')
              : row.kind === 'mention_all'
                ? await this.options.transport.mentionAll(parsed, payload.segments ?? [])
                : row.kind === 'notice'
                  ? await this.options.transport.groupNotice(parsed.chatId, payload.content ?? '')
                  : row.kind === 'forward'
                    ? await this.options.transport.sendForward(parsed, payload.nodes ?? [])
                    : row.kind === 'friend_request'
                      ? await this.options.transport.handleFriendRequest(payload.flag ?? '', payload.approve === true, payload.reason)
                      : row.kind === 'group_request'
                        ? await this.options.transport.handleGroupRequest(payload.flag ?? '', payload.approve === true, payload.reason)
                        : await this.options.transport.sendMessage(parsed, payload.segments ?? [])

      if (result.ok) {
        confirmOutbound(this.options.db, row.id, result.messageId)
        this.stats.outboundSent += 1
        // 成功发出 @全体 ⇒ 本地账本 +1。
        // 为什么要本地记：NapCat 的额度接口有延迟，连续两次 @全体 之间可能读到同一个旧值，
        // 于是"还剩 1 次"会被连用两次。账本只做减法，专防这种滞后。
        if (row.kind === 'mention_all') {
          this.mentionLedger.sent += 1
          recordEffect(this.options.db, {
            id: `eff_${row.id}`,
            kind: 'mention_all',
            actor: 'system',
            subject: parsed.chatId,
            detail: `@全体 已发送（本进程第 ${String(this.mentionLedger.sent)} 次）`,
          })
        }
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

  /**
   * ★ 系统监督循环：把"已经存在但没人读"的信息交给模型（P0-2 + 任务②(a)(b)）。
   *
   * ## 为什么合并成**一个**轮次而不是三轮
   *
   * 三件事都是"系统有事要告诉它"，各开一轮会让模型在几分钟内被叫三次，
   * 而每一轮都要花一次完整的模型调用。合成一段提示词是**省钱的正确做法**，
   * 也让模型能一次看到全貌（"有人加我 + 还有 40 条没读"本来就是一回事的两面）。
   *
   * ## 提交顺序：**先投递成功，再标记已报告**
   *
   * 反过来的话，投递失败（模型挂了、超时）会让这些事件**永远消失** ——
   * 那正是"记了但没人看"的另一种写法。所以 `markReported` 只在 `runDirect` 没报错时调。
   *
   * @returns 这一轮做了什么（供日志与测试断言）。
   */
  async supervise(): Promise<{ readonly delivered: boolean; readonly prompt: string }> {
    const empty = { delivered: false, prompt: '' }
    if (!this.running || this.supervising) return empty
    // 单窗口：已经有轮次在跑就等它（模型醒着时会自己 read_pending）
    if (isAwake(this.options.db)) return empty

    const db = this.options.db
    // ① 铁律 1 的报告批次（合并窗口内安静下来才给）
    const batch = collectReportable(db)
    // ② 待处理请求：与报告同源（都写在 `effects` 里），但措辞更清楚，所以单独渲染
    const requests = requestNotice(db)
    const pendingRequestIds = new Set(listPendingRequests(db, { limit: 200 }).map((item) => item.id))
    // ⚠️ 请求通知**按事件触发、按状态渲染**（这个区分很重要）：
    //   - **触发**：只在这批报告里**真的有**请求时才开口（`reported` 标记由它管）——
    //     否则一个没人处理的老申请会让监督循环**每一轮都唠叨一遍**；
    //   - **渲染**：列的是**全部待处理**（模型要看到完整待办，而不是"这一条"）。
    const freshRequestIds = batch.effects.filter((effect) => pendingRequestIds.has(effect.id)).map((effect) => effect.id)
    // 报告批次里属于"请求"的那些**不重复渲染**（否则同一件事在提示词里出现两遍）
    const others = batch.effects.filter((effect) => !pendingRequestIds.has(effect.id))
    // ③ 离线积压：★ 用**单独那一组参数**（pending_backlog）决定要不要为它开口
    const backlog = backlogNotice(db)
    const backlogDecision = decideBacklogWake(db, { notice: backlog })

    const parts: string[] = []
    if (requests.pending > 0 && freshRequestIds.length > 0) parts.push(renderRequestNotice(requests))
    if (others.length > 0) parts.push(renderReport(others))
    if (backlogDecision !== undefined && backlogDecision.verdict.decision === 'wake') {
      parts.push(renderBacklogNotice(backlog))
    } else if (backlogDecision !== undefined) {
      // 没唤醒也要留痕（面板与排障要能回答"为什么这次没叫它"）
      this.log(`积压未唤醒（${backlogDecision.verdict.reason}）：${String(backlog.unread)} 条未读`)
    }
    if (parts.length === 0) return empty

    const prompt = parts.join('\n\n')
    this.supervising = true
    const turnId = `turn_sys_${Math.random().toString(36).slice(2, 10)}`
    try {
      const conversation: ConversationRef = { platform: 'forlife', chatId: 'system', kind: 'private' }
      const outcome = await this.options.runner.runDirect({
        turnId,
        conversation,
        prompt,
        // 铁律 2：来源只能是 `forlife:system` / `forlife:qq` / `forlife:admin` 三种之一
        conversationKey: this.options.supervisor?.conversationKey ?? 'forlife:system',
        messages: [],
      })
      if (outcome.error !== undefined) {
        // 投递失败 ⇒ **不标记已报告**，下一轮还会再试（事件不会消失）
        this.log(`系统监督轮次失败（报告未提交，下轮重试）：${outcome.error}`)
        return { delivered: false, prompt }
      }
      // 投递成功 ⇒ 现在才可以标记
      if (others.length > 0) markReported(db, others)
      if (freshRequestIds.length > 0) markEffectsReported(db, freshRequestIds)
      this.stats.turnsHandled += 1
      this.log(`系统监督已投递（待处理请求 ${String(requests.pending)} 条、本次新请求 ${String(freshRequestIds.length)} 条、报告 ${String(others.length)} 条、未读积压 ${String(backlog.unread)} 条）`)
      return { delivered: true, prompt }
    } catch (error) {
      this.log(`系统监督异常（报告未提交，下轮重试）：${String(error)}`)
      return { delivered: false, prompt }
    } finally {
      this.supervising = false
    }
  }

  /**
   * 消费后台对话（铁律 2 的唯一人类入口）。
   * 刻意**不经过唤醒判定与调度器**：
   *  - 唤醒矩阵管的是"QQ 上要不要吵醒它"，而面板里有人打字就是在直接跟它说话；
   *  - 调度器的冷却/配额是为了防话痨群，不该让运维的提问排队。
   */
  private async consumeAdminChat(): Promise<void> {
    if (!this.running || this.adminBusy) return
    const pending = takePendingHumanMessages(this.options.db, 10)
    if (pending.length === 0) return
    this.adminBusy = true
    const turnId = `turn_admin_${Math.random().toString(36).slice(2, 10)}`
    try {
      const conversation = { platform: 'panel', chatId: 'admin', kind: 'private' as const }
      const outcome = await this.options.runner.runDirect({
        turnId,
        conversation,
        prompt: buildAdminPrompt(pending),
        conversationKey: this.options.adminConversationKey ?? ADMIN_CHAT_KEY,
        messages: pending.map((m) => m.text),
      })
      if (outcome.error !== undefined) {
        markHandled(this.options.db, pending.map((m) => m.id), { turnId, error: outcome.error })
        appendModelReply(this.options.db, { text: `（这一轮没能回答：${outcome.error}）`, turnId, error: outcome.error })
        this.stats.turnsFailed += 1
      } else {
        markHandled(this.options.db, pending.map((m) => m.id), { turnId })
        const text = (outcome.segments ?? []).join('\n').trim()
        appendModelReply(this.options.db, { text: text === '' ? '（模型没有输出文本）' : text, turnId })
        this.stats.turnsHandled += 1
      }
    } catch (error) {
      markHandled(this.options.db, pending.map((m) => m.id), { turnId, error: String(error) })
      appendModelReply(this.options.db, { text: `（这一轮异常：${String(error)}）`, turnId, error: String(error) })
      this.stats.turnsFailed += 1
    } finally {
      this.adminBusy = false
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
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET
           last_message_at = excluded.last_message_at,
           -- ★ P2-c：**只在有值时更新标题**。
           --   入站事件里 group_name 时有时无（临时会话/部分事件就没有），
           --   用 NULL 直接覆盖会把已经攒下来的标题擦掉（面板上会从群名变回裸群号）。
           title = COALESCE(excluded.title, qq_sessions.title)`,
      )
      .run(
        conversationKey(message.conversation),
        message.conversation.platform,
        message.conversation.chatId,
        message.conversation.kind,
        sessionTitleOf(message),
        message.at,
        nowIso(),
      )
  }

  /**
   * 记录"自己在别处发的消息"（多端一致性：要进记忆，但不唤醒自己）。
   *
   * ## ★ P3：为什么这里要**先去重**
   *
   * `message_sent` 会把**本账号发出的一切**回执给我们，包括**我们自己通过工具发的**
   * （`qq_reply` / `qq_send_image` / 转发…）—— 那些消息我们已经有了权威记录
   * （`qq_outbox` 那一行，带平台 `message_id`）。
   *
   * 不去重的话，一旦部署把 `reportSelfMessage` 打开（NapCat 侧一行配置），
   * **每一条回复都会多写两行**（`qq_inbox` + `effects`），而 `effects` 还会进
   * "影响报告"的周期 ⇒ 模型每轮都会读到"我刚发了某句话"——那是它自己刚做的事，
   * 却要再花一次上下文，而且会把真正需要它知道的事（别人发的）挤掉。
   *
   * ⇒ 判据是 **"这条 id 在 `qq_outbox` 里已经确认过吗"**：
   *   - 是 ⇒ 我们自己发的，已经有权威记录，**不再写第二份**；
   *   - 否 ⇒ 主人用手机/别的客户端发的，**这才是多端一致性的正确来源**，记下来。
   *
   * 这也是"为什么建议**开** `reportSelfMessage`"的前提：开了之后噪声是有界的
   * （只剩真实的外部发送），而不是"每条回复都回声一次"。
   *
   * @param message - 归一化后的自发送消息。
   */
  private recordSelfMessage(message: InboundMessage): void {
    const known = this.options.db
      .prepare("SELECT 1 AS x FROM qq_outbox WHERE platform_msg_id = ? AND status = 'sent' LIMIT 1")
      .get(message.messageId) as { x?: number } | undefined
    if (known !== undefined) {
      this.log(`自己在别处发的消息里有一条是我们自己发的（id=${message.messageId}）⇒ 已有权威记录，不重复入库`)
      return
    }
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
    // ★ 好友申请 / 群邀请**单独走结构化落库**（而不是塞进 `detail` 原始 JSON）。
    //
    //   为什么要分开：处理请求需要**原样回传 `flag`**（NapCat 里它是 `reqTime` / 通知 `seq`），
    //   而 `flag` 埋在原始 JSON 里没人取得到 ⇒ 就算知道有人申请也**处理不了**。
    //   结构化之后 `listPendingRequests()` 能把它取出来，工具才能用。
    if (event.type === 'request') {
      recordInboundRequest(this.options.db, {
        kind: event.kind,
        userId: event.userId,
        ...(event.groupId === undefined ? {} : { groupId: event.groupId }),
        comment: event.comment,
        flag: event.flag,
        ...(event.subType === undefined ? {} : { subType: event.subType }),
        at: event.at,
      })
      this.log(`收到${event.kind === 'group' ? '群' : '好友'}请求（来自 ${event.userId}）—— 已记入待处理，等模型决定`)
      return
    }
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
 * ★ P2-c：`qq_sessions.title` 该填什么（这是一个**判断**，理由写在这里）。
 *
 * 两种会话的 title 语义不同：
 *
 *  - **群会话 ⇒ 群名**。理由：title 是"这个会话叫什么"，
 *    而群里每一条消息的发送者都不同 —— 把**说话人**写进群会话的标题，
 *    会让它随最后说话的人来回跳（那是 bug，不是功能）。
 *    群名是唯一且稳定的（NapCat 实测在群消息里带 `group_name`）。
 *  - **私聊/临时会话 ⇒ 对方的名字**（群名片优先、回退昵称）。
 *    理由：私聊的 title 回答的是"我在跟谁说话"，
 *    而这正是我们从 `sender.card ?? sender.nickname` 已经拿到的东西。
 *
 * 取不到 ⇒ `null`（**不编**）：`COALESCE` 会保住上一次的好值。
 *
 * @param message - 入站消息。
 * @returns 标题或 null。
 */
function sessionTitleOf(message: InboundMessage): string | null {
  const groupName = message.groupName?.trim() ?? ''
  if (message.conversation.kind === 'group') return groupName === '' ? null : groupName
  const sender = message.senderName.trim()
  return sender === '' ? null : sender
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





