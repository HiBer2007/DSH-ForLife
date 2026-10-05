/**
 * 轮次驱动器：把"一批入站消息"变成"一次模型轮次"，再变成"若干出站动作"。
 *
 * ## 与 DSH 的两种接法（PLAN §八 + EXECUTION_PLAN 阶段 3 交付物 4）
 *
 * | 驱动 | 怎么调 | 适用 |
 * | :--- | :--- | :--- |
 * | `headless` | 起 `dsh --profile X headless --json "<提示词>"`，逐行读 NDJSON 事件 | 默认；进程隔离好、崩溃不互相影响 |
 * | `longconnection` | 复用常驻会话（若 U2 的长连接方案通过） | 省掉每次冷启动 |
 * 两者实现同一个 `TurnDriver` 接口，**配置切换**（`driver.kind`）。
 *
 * ## 这一层负责的时序（PLAN §8.2 的完整生命周期）
 *
 * ```
 * 防抖结算 → 唤醒判定 → 建轮次(running) → 组装提示词 → driver.run()
 *   → 模型通过工具产出出站动作（走 outbox 队列）
 *   → 轮次结束：done / deferred / failed
 * ```
 *
 * 刻意**不在这里**做发送：发送归网关的 outbox 消费者（见 `outbox.ts`）。
 * 这样"模型说了什么"与"平台收到什么"是两件事，各自可测、各自可重试。
 *
 * @module @forlife/gateway/turns
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

import { decideInjection, renderTimeBlock } from '@forlife/memory-core'

import { classifyNoise, type NoiseFilterOptions, type NoiseVerdict } from './timing.ts'
import { decideWake, type WakeRequest } from './wake.ts'
import type { ConversationRef, InboundMessage } from './transport.ts'
import { conversationKey } from './transport.ts'

/** 一次模型轮次的结果。 */
export interface TurnOutcome {
  /** 模型产出的文本（多段 ⇒ 多次 qq_reply，这里只是汇总供日志）。 */
  readonly segments?: readonly string[]
  /** token 用量（有就记）。 */
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly toolCalls?: number
  /** 模型要求挂起（§8.3）。 */
  readonly deferred?: { readonly reason: string; readonly expectedMs?: number }
  /** 失败原因。 */
  readonly error?: string
}

/** 轮次驱动接口。 */
export interface TurnDriver {
  /** 驱动名（日志与面板用）。 */
  readonly kind: 'headless' | 'longconnection' | 'fake'
  /**
   * 跑一轮。
   *
   * @param request - 本轮输入。
   * @returns 轮次结果。
   */
  run(request: TurnRequest): Promise<TurnOutcome>
  /** 关闭（释放进程/连接）。 */
  close?(): Promise<void>
}

/** 一轮的输入。 */
export interface TurnRequest {
  readonly turnId: string
  readonly conversation: ConversationRef
  /** 本轮包含的入站消息（防抖合并后的全部）。 */
  readonly messages: readonly InboundMessage[]
  /** 组装好的提示词（带上会话标签 —— 多会话单窗口的关键）。 */
  readonly prompt: string
  /** 取消信号。 */
  readonly signal: AbortSignal
}

/**
 * 组装提示词（多会话单窗口的关键：**每条消息都带会话标签**）。
 *
 * 为什么必须有标签：一个模型窗口同时处理多个会话（§2.17.1），
 * 如果消息不带来源，模型无法知道该回给谁 —— 那样"`conversation` 指路正确率 100%"就不可能。
 *
 * @param messages - 本轮入站消息（可按会话分组）。
 * @param options - 额外上下文。
 * @returns 提示词文本。
 */
export function buildTurnPrompt(
  messages: readonly InboundMessage[],
  options: {
    readonly unreadSummary?: string
    readonly lastInteractionAt?: string
    /** 时间读数块（由调用方按 §2.15.2 P2 的事件驱动规则决定要不要给）。 */
    readonly timeBlock?: string
    readonly now?: Date
  } = {},
): string {
  const now = options.now ?? new Date()
  const lines: string[] = [
    '【来自 QQ 的消息】',
    `时间：${now.toISOString()}（UTC）`,
  ]
  if (options.lastInteractionAt !== undefined) {
    const idleMs = now.getTime() - Date.parse(options.lastInteractionAt)
    lines.push(`距上次与该会话交互：${formatDuration(idleMs)}`)
  }
  lines.push('')

  // 按会话分组，组内保持到达顺序
  const byConversation = new Map<string, InboundMessage[]>()
  for (const message of messages) {
    const key = conversationKey(message.conversation)
    const list = byConversation.get(key)
    if (list === undefined) byConversation.set(key, [message])
    else list.push(message)
  }

  for (const [key, group] of byConversation) {
    const first = group[0]
    if (first === undefined) continue
    const kindLabel = first.conversation.kind === 'group' ? '群' : first.conversation.kind === 'temp' ? '临时会话' : '私聊'
    lines.push(`### 会话 ${key}（${kindLabel}，chat_id=${first.conversation.chatId}）`)
    for (const message of group) {
      const flags: string[] = []
      if (message.mentionedMe) flags.push('@我')
      if (message.mentionedAll) flags.push('@全体')
      if (message.isPoke) flags.push('拍一拍')
      if (message.mediaKind !== undefined) flags.push(message.mediaKind)
      const suffix = flags.length === 0 ? '' : `（${flags.join('、')}）`
      lines.push(`- [${message.at}] ${message.senderName || message.senderId}${suffix}：${message.text}`)
    }
    lines.push('')
  }

  if (options.unreadSummary !== undefined && options.unreadSummary !== '') {
    lines.push('### 你被唤醒期间错过的消息（摘要）', options.unreadSummary, '')
  }

  // 时间读数：**放尾部**，绝不进稳定前缀（§2.15.2 P2 第 6 条：读数进前缀 = 每轮破缓存）。
  // 措辞是权威式的，并写死"不要依据训练数据/历史消息推断现在"这条裁决规则。
  if (options.timeBlock !== undefined && options.timeBlock !== '') {
    lines.push(options.timeBlock, '')
  }

  lines.push('回复时请用 qq_reply 指定目标会话（conversation 参数必填）。')
  return lines.join('\n')
}

/** 人话时长。 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${String(Math.max(0, Math.round(ms / 1000)))} 秒`
  if (ms < 3600_000) return `${String(Math.round(ms / 60_000))} 分钟`
  if (ms < 86_400_000) return `${String(Math.round(ms / 3600_000))} 小时`
  return `${String(Math.round(ms / 86_400_000))} 天`
}

/** 轮次执行器的依赖。 */
export interface TurnRunnerOptions {
  readonly db: DatabaseSync
  readonly driver: TurnDriver
  /** 唤醒判定作用域解析（群/私聊各自的 scope）。 */
  readonly scopeOf: (conversation: ConversationRef) => string
  /** 唤醒条件解析（由调用方按消息特征判断：@我 / @全体 / 拍一拍 / 普通消息）。 */
  readonly conditionOf: (messages: readonly InboundMessage[]) => WakeRequest['condition']
  /** 日志。 */
  readonly log?: (message: string) => void
  /** 随机数（测试注入）。 */
  readonly random?: () => number
  /** 未读摘要提供者（唤醒提示里带上"你错过了什么"）。 */
  readonly unreadSummaryOf?: (scope: string) => string | undefined
  /** 噪音过滤选项（§8.5：不值得回复的消息，也不值得进记忆系统）。 */
  readonly noise?: NoiseFilterOptions
  /** 关掉噪音过滤（默认开启；关掉只用于排障）。 */
  readonly disableNoiseFilter?: boolean
  /**
   * 时间感知钩子（阶段 4）。不给则本轮不注入时间读数。
   *
   * 刻意做成一组小回调而不是直接依赖 store/clock：
   * 网关包不该反向依赖组件的存储层，而这一层只关心"要不要给、给什么文本"。
   */
  readonly timeHooks?: {
    readonly lastReadingAt: (conversationKey: string) => Date | undefined
    readonly lastInteractionAt: (conversationKey: string) => Date | undefined
    readonly lastActionAt: () => Date | undefined
    readonly compactedSince: (conversationKey: string, since?: Date) => boolean
    readonly wokeSince: (conversationKey: string, since?: Date) => boolean
    readonly clockSettings: (conversationKey: string) => { readonly conversationTimezone: string; readonly hour24: boolean }
    readonly record: (conversationKey: string, at: Date, reason: string, timezone: string, text: string) => void
    readonly intervalMs?: number
    readonly idleThresholdMs?: number
  }
}

/** 一轮的处理结果。 */
export interface TurnRunResult {
  readonly turnId?: string
  readonly woken: boolean
  readonly reason: string
  readonly outcome?: TurnOutcome
}

/**
 * 轮次执行器：把一批消息走完"唤醒判定 → 建轮次 → 调驱动 → 收尾"。
 */
export class TurnRunner {
  private readonly options: TurnRunnerOptions
  private readonly log: (message: string) => void
  /** 最近一批被过滤掉的噪音条数（诊断用）。 */
  private lastNoiseCount = 0

  constructor(options: TurnRunnerOptions) {
    this.options = options
    this.log = options.log ?? ((): void => {})
  }

  /**
   * 处理一批（已防抖合并的）消息。
   *
   * @param messages - 本批消息（同一会话，按到达顺序）。
   * @param signal - 取消信号。
   * @returns 处理结果。
   */
  async handleBatch(messages: readonly InboundMessage[], signal: AbortSignal): Promise<TurnRunResult> {
    const first = messages[0]
    if (first === undefined) return { woken: false, reason: 'empty-batch' }

    // ① 噪音过滤（§8.5）：在**队列层**就把纯闲聊挡在 DSH 之外 ——
    //    "不值得回复的消息，也不值得进记忆系统"。被过滤掉的不进提示词、也不进待读池。
    const survivors: InboundMessage[] = []
    const filtered: { message: InboundMessage; verdict: NoiseVerdict }[] = []
    for (const message of messages) {
      const verdict =
        this.options.disableNoiseFilter === true
          ? ({ noise: false } as NoiseVerdict)
          : classifyNoise(
              {
                text: message.text,
                isGroup: message.conversation.kind === 'group',
                mentionedMe: message.mentionedMe,
                mentionedAll: message.mentionedAll,
                isPoke: message.isPoke,
                mediaKind: message.mediaKind ?? null,
                senderId: message.senderId,
              },
              this.options.noise ?? {},
            )
      if (verdict.noise) filtered.push({ message, verdict })
      else survivors.push(message)
    }
    this.lastNoiseCount = filtered.length
    if (survivors.length === 0) {
      this.log(`整批都是噪音（${filtered.map((f) => f.verdict.rule ?? '?').join(',')}），不进记忆也不占待读池`)
      return { woken: false, reason: 'noise' }
    }
    const effective = survivors

    const scope = this.options.scopeOf(first.conversation)
    const condition = this.options.conditionOf(effective)
    const key = conversationKey(first.conversation)
    const summary = effective.map((m) => `${m.senderName || m.senderId}: ${m.text}`).join(' / ')

    const verdict = decideWake(
      this.options.db,
      { scope, condition, conversationKey: key, summary, ...(first.senderName === '' ? {} : { senderName: first.senderName }) },
      this.options.random === undefined ? {} : { random: this.options.random },
    )
    if (verdict.decision === 'skip') {
      this.log(`未唤醒（${verdict.reason}）：${key} ${String(messages.length)} 条已进待读池`)
      return { woken: false, reason: verdict.reason }
    }

    const turnId = `turn_${randomUUID()}`
    const startedAt = nowIso()
    this.options.db
      .prepare(
        `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
         VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?, 0, 0, 0, NULL, NULL, NULL)`,
      )
      .run(turnId, key, startedAt, JSON.stringify(effective.map((m) => m.messageId)))

    // 时间读数（§2.15.2 P2 的事件驱动判定）：先决定要不要给，再生成文本。
    // 判定顺序由 memory-core/clock.ts 保证"强事件优先于间隔"。
    const timeBlock = this.buildTimeBlockIfNeeded(scope, key)

    const prompt = buildTurnPrompt(effective, {
      ...(this.options.unreadSummaryOf?.(scope) === undefined ? {} : { unreadSummary: this.options.unreadSummaryOf?.(scope) as string }),
      ...(latestAt(effective) === undefined ? {} : { lastInteractionAt: latestAt(effective) as string }),
      ...(timeBlock === undefined ? {} : { timeBlock }),
    })

    try {
      const outcome = await this.options.driver.run({ turnId, conversation: first.conversation, messages: effective, prompt, signal })
      this.finishTurn(turnId, outcome)
      return { turnId, woken: true, reason: 'matched', outcome }
    } catch (error) {
      const message = String(error)
      this.options.db
        .prepare("UPDATE qq_turns SET status = 'failed', ended_at = ?, error = ? WHERE id = ?")
        .run(nowIso(), message, turnId)
      this.log(`轮次失败：${message}`)
      return { turnId, woken: true, reason: 'matched', outcome: { error: message } }
    }
  }

  /**
   * 直接跑一轮（**不做唤醒判定**）。
   *
   * 用途：后台对话 —— 面板里有人打字就是在直接跟它说话，没有"要不要吵醒它"的问题。
   * 仍然会落一条轮次记录（可追溯：这次回答对应哪条输入、花了多少 token）。
   *
   * @param request - 轮次输入（提示词由调用方组装）。
   * @returns 轮次结果。
   */
  async runDirect(request: {
    readonly turnId: string
    readonly conversation: ConversationRef
    readonly prompt: string
    readonly conversationKey: string
    readonly messages: readonly string[]
  }): Promise<TurnOutcome> {
    const startedAt = nowIso()
    this.options.db
      .prepare(
        `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
         VALUES (?, ?, 'running', ?, NULL, NULL, NULL, ?, 0, 0, 0, NULL, NULL, NULL)`,
      )
      .run(request.turnId, request.conversationKey, startedAt, JSON.stringify([]))

    try {
      const outcome = await this.options.driver.run({
        turnId: request.turnId,
        conversation: request.conversation,
        messages: [],
        prompt: request.prompt,
        signal: new AbortController().signal,
      })
      this.finishTurn(request.turnId, outcome)
      return outcome
    } catch (error) {
      const message = String(error)
      this.options.db.prepare("UPDATE qq_turns SET status = 'failed', ended_at = ?, error = ? WHERE id = ?").run(nowIso(), message, request.turnId)
      return { error: message }
    }
  }

  /**
   * 按事件驱动规则决定并生成时间读数块（§2.15.2 P2）。
   *
   * 落库是必须的：验收要断言"压缩后/唤醒后/长空闲后存在一条新鲜读数（年龄 < 30s）"，
   * 不落库就只能靠日志肉眼看。
   *
   * @param scope - 会话作用域。
   * @param conversationKey - 会话键。
   * @returns 时间块文本，或 undefined（这一步不需要注入）。
   */
  private buildTimeBlockIfNeeded(scope: string, conversationKey: string): string | undefined {
    const hooks = this.options.timeHooks
    if (hooks === undefined) return undefined
    const now = new Date()
    const lastReading = hooks.lastReadingAt(conversationKey)
    const decision = decideInjection({
      now,
      ...(lastReading === undefined ? {} : { lastReadingAt: lastReading }),
      ...(hooks.lastInteractionAt(conversationKey) === undefined ? {} : { lastInteractionAt: hooks.lastInteractionAt(conversationKey) as Date }),
      isTurnFirstStep: true, // QQ 轮次天然是"这一轮的第一步"
      ...(hooks.compactedSince(conversationKey, lastReading) ? { compactedSinceLastReading: true } : {}),
      ...(hooks.wokeSince(conversationKey, lastReading) ? { wokeSinceLastReading: true } : {}),
      ...(hooks.intervalMs === undefined ? {} : { intervalMs: hooks.intervalMs }),
      ...(hooks.idleThresholdMs === undefined ? {} : { idleThresholdMs: hooks.idleThresholdMs }),
    })
    if (!decision.inject || decision.reason === undefined) {
      this.log(`本轮不注入时间读数：${decision.skipReason ?? ''}`)
      return undefined
    }
    const settings = hooks.clockSettings(conversationKey)
    const block = renderTimeBlock({
      now,
      timezone: settings.conversationTimezone,
      hour24: settings.hour24,
      reason: decision.reason,
      ...(lastReading === undefined ? {} : { lastReadingAt: lastReading }),
      ...(hooks.lastInteractionAt(conversationKey) === undefined ? {} : { lastInteractionAt: hooks.lastInteractionAt(conversationKey) as Date }),
      ...(hooks.lastActionAt() === undefined ? {} : { lastActionAt: hooks.lastActionAt() as Date }),
    })
    hooks.record(conversationKey, now, decision.reason, settings.conversationTimezone, block)
    this.log(`已注入时间读数（原因：${decision.reason}）`)
    void scope
    return block
  }

  /** 收尾：写状态与计量。 */
  private finishTurn(turnId: string, outcome: TurnOutcome): void {
    if (outcome.deferred !== undefined) {
      // §8.3：挂起时**不提交、不追加中期记忆**，等任务完成后恢复
      const until = outcome.deferred.expectedMs === undefined ? null : new Date(Date.now() + outcome.deferred.expectedMs).toISOString()
      this.options.db
        .prepare("UPDATE qq_turns SET status = 'deferred', defer_reason = ?, defer_until = ? WHERE id = ?")
        .run(outcome.deferred.reason, until, turnId)
      return
    }
    this.options.db
      .prepare(
        "UPDATE qq_turns SET status = 'done', ended_at = ?, tokens_in = ?, tokens_out = ?, tool_calls = ? WHERE id = ?",
      )
      .run(nowIso(), outcome.tokensIn ?? 0, outcome.tokensOut ?? 0, outcome.toolCalls ?? 0, turnId)
  }
}

/** 批内最新一条的时间。 */
function latestAt(messages: readonly InboundMessage[]): string | undefined {
  let latest: string | undefined
  for (const message of messages) {
    if (latest === undefined || message.at > latest) latest = message.at
  }
  return latest
}

/**
 * 按消息特征判定唤醒条件（**条件互不派生**，这里只做"输入是什么"的映射）。
 *
 * @param messages - 本批消息。
 * @returns 唤醒条件。
 */
export function defaultConditionOf(messages: readonly InboundMessage[]): WakeRequest['condition'] {
  const first = messages[0]
  if (first === undefined) return 'group_message_any'
  // 只要有一条 @我，就按 @我（最明确的信号优先）
  if (messages.some((m) => m.isPoke)) return first.conversation.kind === 'group' ? 'group_poke' : 'private_message'
  if (messages.some((m) => m.mentionedMe)) {
    if (first.conversation.kind === 'group') return 'group_mention'
    return first.conversation.kind === 'temp' ? 'temp_message' : 'private_message'
  }
  if (messages.some((m) => m.mentionedAll)) return 'group_mention_all'
  if (messages.some((m) => m.mediaKind === 'file')) return 'file_received'
  if (messages.some((m) => m.mediaKind !== undefined)) return 'media_received'
  if (first.conversation.kind === 'group') return 'group_message_any'
  return first.conversation.kind === 'temp' ? 'temp_message' : 'private_message'
}

/** 默认的作用域解析。 */
export function defaultScopeOf(conversation: ConversationRef): string {
  if (conversation.kind === 'group') return `group:${conversation.chatId}`
  return `private:${conversation.chatId}`
}




