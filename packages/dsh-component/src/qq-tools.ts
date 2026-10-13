/**
 * QQ 侧工具集（阶段 3 交付物 5 + 唤醒矩阵与状态通道的工具面）。
 *
 * ## 这些工具为什么"只入队、不直接发送"
 *
 * 工具在 **DSH 进程**里执行，而 QQ 连接在**网关进程**里。两者共享同一个 SQLite：
 * 工具把动作写进 `qq_outbox`，网关认领后发送、回填平台消息 id。
 * 于是"送达确认"就是等那一行的状态变化（§2.17.9 的 3 秒窗口）——
 * 这也是为什么发送类工具**必须**带确认语义：跨进程的"我以为发出去了"最危险。
 *
 * ## 多会话单窗口的硬约束
 *
 * 用户要求：一个模型窗口同时处理多个会话，且 `qq_reply` **必须**指定目标会话。
 * 所以 `conversation` 是**必填**参数，没有隐式默认 —— 猜错目标在群里是灾难性的。
 *
 * @module forlife-memory/qq-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { defaultFor } from '@forlife/contracts'
import {
  BACKLOG_WAKE_CONDITION,
  backlogNotice,
  backlogReadQuota,
  buildForwardNodes,
  buildForwardNodesFromIds,
  clearProbeResult,
  consumeBacklogRead,
  decideSendQuota,
  enqueueOutbound,
  listBacklogWakeRule,
  listPendingRequests,
  listWakeRules,
  markRequestHandled,
  parseConversationKey,
  readBacklog,
  readProbeResult,
  renderBacklogNotice,
  seedBacklogWakeRule,
  setModelStatus,
  setWakeRule,
  // ★ 2026-10-11：`peer_status` 工具要用它（`typingConversations` 是批量版，单个会话用它更直接）
  isPeerTyping,
  typingConversations,
  WAKE_CONDITIONS,
  waitForConfirmation,
  type OutboundSegment,
  type ProbeAction,
  type ProbeResult,
  type WakeCondition,
} from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import { buildMentionTools, MENTION_TOOL_NAMES } from './mention-tools.ts'
import { buildStickerTools, STICKER_TOOL_NAMES } from './sticker-tools.ts'
import { withToolResultSpill } from './tool-spill.ts'
import type { DefineToolLike } from './tools.ts'

/** 文本结果。 */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** QQ 工具名（测试与文档共用一份）。 */
export const QQ_TOOL_NAMES = [
  'qq_reply',
  'qq_react',
  'qq_typing',
  // ★ P2-d：出站补齐（以前 `kind:'image' | 'file' | 'delete'` **全仓零入队点** ⇒
  //   发不出图片、发不出文件、撤回不了消息）
  'qq_send_image',
  'qq_send_file',
  'qq_recall',
  'qq_forward',
  'qq_requests',
  'qq_handle_request',
  'qq_contacts',
  'defer_turn',
  'read_pending',
  // ★★ 2026-10-11（用户裁定）：`peer_input_status` **不再是唤醒条件**，改成这个工具。
  //   见 `peerStatusTool` 的说明与 `FIX_PLAN.md` §60 ① / §64。
  'peer_status',
  'list_wake_rules',
  'set_wake_rule',
  'set_status',
  'clear_system_status',
  ...STICKER_TOOL_NAMES,
  ...MENTION_TOOL_NAMES,
] as const

/**
 * ★ 唤醒条件的**工具面**取值：已知条件 + 离线积压那一条。
 *
 * 为什么要在这里补：`pending_backlog`（用户要的"单独一组参数"）**没有**进
 * `WAKE_CONDITIONS` —— 那个文件本轮属于另一个在跑的改动，按纪律没动它。
 * 但它已经在 `wake_rules` 表里注册（`seedBacklogWakeRule`）并参与完整判定，
 * 所以**工具面必须能配它**，否则用户"让模型能忽略离线群消息"就无从落地。
 *
 * 等 `wake.ts` 腾出来后，把 `pending_backlog` 加进 `WAKE_CONDITIONS`，
 * 这里就可以退回成 `[...WAKE_CONDITIONS]`。
 */
export const QQ_WAKE_CONDITIONS: readonly string[] = [...WAKE_CONDITIONS, BACKLOG_WAKE_CONDITION]

/**
 * 构造 QQ 侧工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时（提供共享数据库句柄）。
 * @param options - 确认窗口等可调项。
 * @returns 工具定义数组。
 */
export function buildQqTools(
  defineTool: DefineToolLike,
  runtime: MemoryRuntime,
  options: { readonly confirmTimeoutMs?: number } = {},
): readonly unknown[] {
  const confirmTimeoutMs = options.confirmTimeoutMs ?? defaultFor<number>('delivery.confirmTimeoutMs')
  // ★ PLAN §3.2 分层降噪：`read_pending` 这类工具会把积压消息整批吐出来（可能很长），
  //   超过基线阈值就落 spill、只留 head + id（模型用 recall_full 取回）。
  const defineSpillingTool = withToolResultSpill(defineTool, runtime)

  /** 把会话键字符串解析成 Ref，并校验。 */
  const parseTarget = (conversation: string): { ok: true; key: string; kind: 'private' | 'group' | 'temp' } | { ok: false; message: string } => {
    const parsed = parseConversationKey(conversation)
    if (parsed === undefined) {
      return { ok: false, message: `bad conversation key: ${conversation} (expected platform:chat_id[:thread_id], e.g. onebot11:88888)` }
    }
    const row = runtime.db.prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?').get(conversation) as { kind: string } | undefined
    const kind = row?.kind === 'group' || row?.kind === 'temp' || row?.kind === 'private' ? row.kind : 'private'
    return { ok: true, key: conversation, kind }
  }

  /**
   * ★ **发消息方向的限制①**：入队前的速率闸门。
   *
   * 为什么放在**入队之前**（而不是网关投递时）：入队之后消息就已经在队列里了，
   * 那时再拦只能"不发"，而模型已经以为发出去了（它等的是送达确认，会看到超时）。
   * 在入队前拦，模型拿到的是**一句明确的话**："被限流了，等 N 毫秒"。
   *
   * ⚠️ 这里**不**管"两条之间的最小间隔" —— 那是投递侧的事（`deliverPacing`），
   * 因为 `qq_reply` 的设计就是"多次调用实现分段回复"，三段回复天然在同一毫秒入队。
   *
   * @returns 放行时返回 `undefined`；被限流时返回给模型看的失败对象。
   */
  const sendGate = (): { readonly throttled: true; readonly hint: string; readonly retryAfterMs: number } | undefined => {
    const decision = decideSendQuota(runtime.db)
    if (decision.allowed) return undefined
    return { throttled: true, hint: decision.reason, retryAfterMs: decision.retryAfterMs }
  }

  /**
   * 跑一次**跨进程只读查询**（`get_forward_msg` / 各种列表）。
   *
   * 工具在 DSH 进程、QQ 连接在网关进程，所以查询要写一行 `qq_outbox`（`kind='probe'`）
   * 让网关去执行，结果放在 `forlife_state` 里等我们读（见 `probe.ts`）。
   *
   * @param action - 白名单里的查询动作。
   * @param args - 参数。
   * @returns 结果（失败的 `error` 是给模型看的人话）。
   */
  const runProbe = async (action: ProbeAction, args: Record<string, unknown>): Promise<ProbeResult> => {
    const outboxId = enqueueOutbound(runtime.db, {
      conversationKey: 'onebot11:0',
      conversationKind: 'private',
      kind: 'probe',
      payload: { probeAction: action, probeArgs: args },
      source: 'model',
    })
    const confirmed = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
    const result = readProbeResult(runtime.db, outboxId)
    clearProbeResult(runtime.db, outboxId)
    if (result !== undefined) return result
    // 没结果：可能是网关没在跑、或者超时。如实说，别编一个空结果。
    return {
      ok: false,
      error: confirmed.confirmed
        ? 'the query finished but its result could not be read (it may have been cleaned up concurrently); please retry'
        : `the query did not finish within ${String(confirmTimeoutMs)}ms: ${confirmed.error ?? 'unknown reason'} (the QQ side may be disconnected, or the QQ gateway is not running)`,
    }
  }

  const qqReply = defineSpillingTool({
    name: 'qq_reply',
    description: [
      // ★ **工具调用限制**（用户明确要求写进描述）：
      // QQ 消息是碎片化的 —— 上下几条常常是同一个意思。
      // 发送之前必须先取回所有消息，否则会对着半句话回复，
      // 而用户看到的是「你怎么答非所问」。
      '**You must call `read_pending` to fetch all messages before sending** - that order is mandatory, not a suggestion.',
      'QQ messages are **fragmented**: several consecutive ones often talk about the same thing. Replying after seeing only one is very likely to miss the point.',
      'After fetching you will see **all** pending messages, and only then decide how to reply.',
      // ⚠️ 这里曾经写着"取回结果里带 `typing: true`" —— 而当时 `read_pending` 的输出里
      //    根本没有这个字段（`pending_messages` 表也不存它）⇒ **那句话永远兑现不了**。
      //    上一轮把它改成了"拿不到"，而**这一轮真的接上了**：
      //    协议端的 `notify/input_status` 事件（P1-4 已归一为 `peer_input_status`）
      //    被记进 `forlife_state`（自带过期时刻），`read_pending` 的每一条会带 `typing`。
      //    ⇒ 描述回到"能兑现"的状态，但**如实说明它的时效**：
      //    它是"最近十几秒内有过输入事件"，不是"此刻正在打字"的实时快照。
      '`typing: true` in the result means the other side had a typing event **within the last dozen seconds or so** (the "typing" the protocol side reports);',
      'it is a **hint that expires**, not live state - to check whether the other side is still there, waiting one beat with `defer_turn` is more reliable than staring at it.',
      'Send a message to a given QQ conversation. Call it several times to reply in parts (each call is one separate message; the order is the call order).',
      '**conversation is required** - you may be handling several conversations at once, and guessing the target wrong in a group is disastrous.',
      `After sending it waits ${String(confirmTimeoutMs)}ms for delivery confirmation: on success you get messageId; otherwise you are told plainly "submitted but unconfirmed", and you can check later or resend.`,
      // ★ 发消息方向的限制（用户要求"在发消息的位置做出限制"）——写进描述，
      //   否则模型会以为可以连着刷几十条，撞上限流后以为工具坏了。
      `**There is a send rate limit**: at most ${String(defaultFor<number>('qq.send.perMinuteMax'))} per minute,` +
        `at most ${String(defaultFor<number>('qq.send.burstMax'))} within ${String(defaultFor<number>('qq.send.burstWindowMs') / 1000)} seconds.` +
        'When throttled you are told exactly how long to wait - **do not** try to get around it by retrying; that is exactly the behaviour it blocks.',
      'To send a longer piece of content as a "chat record" card, use `qq_forward` (better than flooding several messages).',
      'To alert the whole group do not use this; use the separate @all tool (it has its own quota).',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key, e.g. onebot11:88888 (group) or onebot11:10001 (private).' },
      text: { type: 'string', required: true, description: 'Text to send.' },
      reply_to: { type: 'string', description: 'Optional: id of the message to quote.' },
      at: { type: 'array', items: { type: 'string' }, description: 'Optional: QQ numbers to @ (an empty array means no @).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true, description: 'Whether delivery was confirmed.' },
          messageId: { type: 'string', description: 'Platform message id (present only after confirmation).' },
          outboxId: { type: 'string', required: true, description: 'Queue id (useful for checking later).' },
          /** 是否被发送速率闸门拦下（拦下时**队列里没有这一条**，所以没有 outboxId）。 */
          throttled: { type: 'boolean', description: 'Blocked by the send rate limit (the message was not queued).' },
          hint: { type: 'string', description: 'Self-help hint when unconfirmed or throttled.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; messageId?: string; hint?: string; throttled?: boolean }
        if (v.throttled === true) return text(`**This one was not sent (blocked by the rate limit)**: ${v.hint ?? ''}`)
        if (v.confirmed) return text(`Delivered (message_id=${v.messageId ?? 'unknown'})`)
        return text(`Submitted but no delivery confirmation was received. ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; text: string; reply_to?: string; at?: string[] }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }

      // ── 死循环监控（用户要求：重复输出 ⇒ 停本轮 + 重启）────────────────
      //
      // **放在入队之前** —— 一旦入队，那条重复消息就会**真的发出去**，
      // 而"发出去的收不回来"（与备份那条纪律同源）。
      const verdict = runtime.loopGuard.feed(a.text)
      if (verdict.action === 'stop-and-restart') {
        runtime.log(`**检测到死循环，已拦下本条消息**：${verdict.reason}`)
        return {
          ok: false,
          confirmed: false,
          outboxId: '',
          // **要把理由告诉模型** —— 悄悄丢掉的话，它不知道发生了什么，
          // 只会换个说法**接着循环**。
          hint:
            `**You are repeating yourself; this turn was stopped.** Reason: ${verdict.reason}.` +
            'Please **do not repeat again** - take a completely different approach, or say where you are stuck and what information you need.',
        }
      }

      const segments: OutboundSegment[] = []
      if (a.reply_to !== undefined && a.reply_to !== '') segments.push({ kind: 'reply', messageId: a.reply_to })
      for (const userId of a.at ?? []) segments.push({ kind: 'at', userId })
      segments.push({ kind: 'text', text: a.text })

      // ★ 发消息方向的限制①：入队前的速率闸门（超了**不写队列**，如实告诉模型）
      const gate = sendGate()
      if (gate !== undefined) {
        return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint} (you can send again in about ${String(gate.retryAfterMs)}ms)` }
      }

      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'text',
        payload: { segments },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return {
        ok: true,
        confirmed: result.confirmed,
        outboxId,
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
        ...(result.confirmed
          ? {}
          : { hint: `${result.error ?? ''}. You can resend with qq_reply, or watch for a while before deciding (queue id: ${outboxId}).` }),
      }
    },
  })

  const qqReact = defineSpillingTool({
    name: 'qq_react',
    description: 'Add an emoji reaction to a message (lighter than replying "haha"; good for acknowledging or agreeing).',
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key.' },
      message_id: { type: 'string', required: true, description: 'Id of the message to react to.' },
      emoji: { type: 'string', required: true, description: 'Emoji id (e.g. 128077 is a thumbs-up).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
          outboxId: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean }
        return text(v.confirmed ? 'Reaction delivered' : 'Reaction submitted, no confirmation received')
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; message_id: string; emoji: string }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '' }
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'reaction',
        payload: { messageId: a.message_id, emoji: a.emoji },
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return { ok: true, confirmed: result.confirmed, outboxId }
    },
  })

  const qqTyping = defineSpillingTool({
    name: 'qq_typing',
    description: [
      'Turn the "typing" indicator on or off. **Private chats only** - groups do not have this capability and the call tells you plainly that it failed.',
      'Good to turn on before you spend a few seconds thinking or calling tools, so the other side knows you are typing.',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key.' },
      on: { type: 'boolean', required: true, description: 'true turns it on, false turns it off.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          supported: { type: 'boolean', required: true, description: 'Whether this conversation supports the capability.' },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; supported: boolean; note?: string }
        if (!v.supported) return text(v.note ?? 'this conversation does not support the typing indicator')
        return text(v.ok ? 'Typing state set' : 'Failed to set the typing state')
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; on: boolean }
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, supported: false, note: target.message }
      if (target.kind === 'group') {
        // 如实告知：群聊没有这个能力（不假装成功）
        return { ok: false, supported: false, note: 'groups have no typing indicator (the protocol supports it only for private chats), so nothing was sent.' }
      }
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'input_status',
        payload: { typing: a.on },
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return { ok: result.confirmed, supported: true }
    },
  })

  const deferTurn = defineSpillingTool({
    name: 'defer_turn',
    description: [
      'Suspend the current turn: use it when you must wait for a long task (an external process, a download, someone replying) and cannot conclude yet.',
      'While suspended **no mid-term memory is committed**; the turn resumes from the same state once the task finishes.',
      'Do not use it to stall or dodge an answer - answer when you can, and say so plainly when you cannot.',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: 'Why you are suspending (recorded in the turn and the logs).' },
      expected_duration_ms: { type: 'integer', description: 'Expected duration in milliseconds, so the gateway knows when to check back.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          deferred: { type: 'boolean', required: true },
          turnId: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { deferred: boolean; note?: string }
        return text(v.deferred ? 'Turn suspended; it resumes when the task finishes' : (v.note ?? 'there is no turn in progress to suspend'))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string; expected_duration_ms?: number }
      // 找当前 running 的轮次（跨进程共享库 ⇒ 直接改表，网关与驱动都能看到）
      const turn = runtime.db
        .prepare("SELECT id FROM qq_turns WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
        .get() as { id: string } | undefined
      if (turn === undefined) {
        return { ok: true, deferred: false, note: 'no turn is in progress (you may not be inside a QQ turn); ignored.' }
      }
      const until = a.expected_duration_ms === undefined ? null : new Date(Date.now() + a.expected_duration_ms).toISOString()
      runtime.db
        .prepare("UPDATE qq_turns SET status = 'deferred', defer_reason = ?, defer_until = ? WHERE id = ?")
        .run(a.reason, until, turn.id)
      return { ok: true, deferred: true, turnId: turn.id }
    },
  })

  const readPendingTool = defineSpillingTool({
    name: 'read_pending',
    description: [
      // ★ 它不只是「看看有什么」—— 它是**发送前的必经步骤**。
      '**This is a required step before sending** (`qq_reply` expects you to call it first):',
      'QQ messages are fragmented; several consecutive ones are often the same thing, so replying after seeing one is very likely to miss the point.',
      'Fetch the messages you missed while woken but which did not disturb you (chit-chat in groups where nobody @-ed you lives there).',
      'What you read is marked read and will not come back. Use it when you want to know what a group or a person has been talking about.',
      '',
      // ★ 取消息方向的限制（用户要求"在取消息的位置做出限制"）——**必须写进描述**，
      //   否则模型会以为可以随便一次抓 500 条，然后撞上限流、以为工具坏了。
      `**Fetching has a quota**: at most ${String(defaultFor<number>('qq.backlog.readBatchMax'))} per call,` +
        `at most ${String(defaultFor<number>('qq.backlog.readPerTurnBatches'))} batches per turn /` +
        `${String(defaultFor<number>('qq.backlog.readPerTurnMax'))} in total. Going over tells you exactly how much is left.`,
      '**You can filter by source**: pass `scope` for one conversation, or `kind` for a whole class (`group` = all groups).',
      'To skip group chit-chat for now, pass `kind: "private"`; to clear groups specifically, pass `kind: "group"`.',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', description: 'Optional: only this source, e.g. group:88888 or private:10001.' },
      kind: { type: 'string', enum: ['group', 'private'], description: 'Optional: only this class of source (group = every group; private = every private chat, including temporary ones).' },
      conversation: { type: 'string', description: 'Optional: only this conversation key (e.g. onebot11:88888).' },
      limit: { type: 'integer', description: 'How many to read at most (the per-call and per-turn ceilings still apply; the result says what happened).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string' },
                sender: { type: 'string' },
                summary: { type: 'string' },
                at: { type: 'string' },
                /** ★ 对方最近有没有在打字（**会过期的提示**，见工具描述）。 */
                typing: { type: 'boolean', description: 'The other side had a typing event within the last dozen seconds or so (it expires; not live state).' },
              },
            },
          },
          /** 取完（按同一筛选口径）还剩多少条未读。 */
          remaining: { type: 'integer', description: 'How many unread messages remain under this filter.' },
          /** 本轮还剩多少额度 —— 让模型自己规划"要不要分几次取"。 */
          quota: { type: 'string', description: 'Plain-language note about the fetch quota for this turn.' },
          hint: { type: 'string', description: 'When throttled, explains why and what to do.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { count: number; remaining?: number; quota?: string; hint?: string; items: { conversation: string; sender?: string; summary: string }[] }
        if (v.hint !== undefined) return text(v.hint)
        if (v.count === 0) return text(v.remaining === undefined || v.remaining === 0 ? 'No unread messages to read.' : `Nothing matched this filter (${String(v.remaining)} remain; try another filter).`)
        return text(
          [
            `Fetched ${String(v.count)} (${String(v.remaining ?? 0)} still unread):`,
            ...v.items.map((i) => `- [${i.conversation}] ${i.sender ?? ''}：${i.summary}`),
            v.quota === undefined ? '' : `[quota] ${v.quota}`,
          ]
            .filter((line) => line !== '')
            .join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { scope?: string; kind?: 'group' | 'private'; conversation?: string; limit?: number }
      // ★ 先问额度（**先判定、后取、再记账**：反过来的话"取失败"也会吃掉额度）
      const quota = backlogReadQuota(runtime.db, { ...(a.limit === undefined ? {} : { requested: a.limit }) })
      if (!quota.allowed) return { ok: false, count: 0, items: [], remaining: backlogNotice(runtime.db).unread, hint: quota.reason }
      const read = readBacklog(runtime.db, {
        ...(a.scope === undefined ? {} : { scope: a.scope }),
        ...(a.kind === undefined ? {} : { kind: a.kind }),
        ...(a.conversation === undefined ? {} : { conversationKey: a.conversation }),
        limit: quota.granted,
      })
      consumeBacklogRead(runtime.db, read.items.length)
      // ★ 一次问一批（而不是每条一次查询）：同一批往往十几条，逐条 `getState` 是 N 次 IO。
      const typing = typingConversations(
        runtime.db,
        read.items.map((item) => item.conversationKey),
      )
      return {
        ok: true,
        count: read.items.length,
        remaining: read.remaining,
        quota: quota.reason,
        items: read.items.map((i) => ({
          conversation: i.conversationKey,
          sender: i.senderName ?? '',
          summary: i.summary,
          at: i.at,
          // `typing` **恒给**（不给的话"没有这个字段"和"没有人在打字"就分不出来了）
          typing: typing.has(i.conversationKey),
        })),
      }
    },
  })

  const listWakeRulesTool = defineSpillingTool({
    name: 'list_wake_rules',
    description: [
      'Show your current wake rules: which conditions wake you, with what probability, and whether limits or quiet hours apply.',
      'Every condition is **independent** (e.g. "@all" and "@me" are counted separately), so changing one does not affect another.',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', description: 'Optional: look at one scope (group:88888 / private:10001); omit it for the global default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          scope: { type: 'string', required: true },
          rules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                condition: { type: 'string' },
                enabled: { type: 'boolean' },
                probability: { type: 'integer' },
                dailyLimit: { type: 'integer' },
                minIntervalMs: { type: 'integer' },
                updatedBy: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { scope: string; rules: { condition: string; enabled: boolean; probability: number }[] }
        return text(
          [`Wake rules for ${v.scope}:`, ...v.rules.map((r) => `- ${r.condition}: ${r.enabled ? `${String(r.probability)}%` : 'off'}`)].join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { scope?: string }
      const scope = a.scope ?? '*'
      const rules = listWakeRules(runtime.db, scope)
      // ★ 离线积压那一条是**单独一组**（不在 `WAKE_CONDITIONS` 里，见 QQ_WAKE_CONDITIONS 的说明），
      //   所以列表要把它也带上 —— 否则模型看不到它、也就没法"选择忽略掉线期间的群消息"。
      const backlog = listBacklogWakeRule(runtime.db, scope)
      return {
        ok: true,
        scope,
        rules: [
          ...rules.map((r) => ({
            condition: r.condition,
            enabled: r.enabled,
            probability: r.probability,
            dailyLimit: r.dailyLimit,
            minIntervalMs: r.minIntervalMs,
            updatedBy: r.updatedBy,
          })),
          {
            condition: backlog.condition,
            enabled: backlog.enabled,
            probability: backlog.probability,
            dailyLimit: backlog.dailyLimit,
            minIntervalMs: backlog.minIntervalMs,
            updatedBy: backlog.updatedBy,
          },
        ],
      }
    },
  })

  const setWakeRuleTool = defineSpillingTool({
    name: 'set_wake_rule',
    description: [
      'Tune your own wake rules (this is where you decide "when I get woken").',
      'Conditions are independent: you can turn off chit-chat wakes for one group while keeping @me.',
      'Think before changing: turning off @me means you may miss someone asking you for help explicitly.',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', required: true, description: 'Scope: group:88888 / private:10001, or * for the global default.' },
      condition: { type: 'string', required: true, enum: [...QQ_WAKE_CONDITIONS], description: 'The condition to change (including pending_backlog, which is its own group for offline backlog).' },
      enabled: { type: 'boolean', description: 'Whether the condition is enabled.' },
      probability: { type: 'integer', description: 'Wake probability, 0-100.' },
      daily_limit: { type: 'integer', description: 'Maximum wakes per day (0 = unlimited).' },
      min_interval_ms: { type: 'integer', description: 'Minimum interval between wakes in milliseconds (0 = unlimited).' },
      quiet_until: { type: 'string', description: 'Stay quiet until this moment (UTC ISO time); no wakes before it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          condition: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          probability: { type: 'integer', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { condition: string; enabled: boolean; probability: number; note?: string }
        return text(`Updated ${v.condition}: ${v.enabled ? `enabled, ${String(v.probability)}%` : 'off'}${v.note === undefined ? '' : ` (${v.note})`}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as {
        scope: string
        condition: string
        enabled?: boolean
        probability?: number
        daily_limit?: number
        min_interval_ms?: number
        quiet_until?: string
      }
      // ⚠️ 离线积压那一条要先**播种**再改。
      //   不播种的话 `setWakeRule` 内部的 `resolveWakeRule` 会给出一套硬编码兜底
      //   （minIntervalMs = 0），upsert 时就把基线里的最小间隔**覆盖成 0** ——
      //   那会让积压唤醒每一轮都触发（正是"参数写在基线里、生效的是别的数字"那类事故）。
      if (a.condition === BACKLOG_WAKE_CONDITION) seedBacklogWakeRule(runtime.db)
      const rule = setWakeRule(
        runtime.db,
        a.scope,
        // 条件来自 `QQ_WAKE_CONDITIONS`（含 `pending_backlog`），比 `WakeCondition` 宽一点：
        // 那个枚举里暂时没有积压那一条（理由见 QQ_WAKE_CONDITIONS 的注释）。
        a.condition as WakeCondition,
        {
          ...(a.enabled === undefined ? {} : { enabled: a.enabled }),
          ...(a.probability === undefined ? {} : { probability: a.probability }),
          ...(a.daily_limit === undefined ? {} : { dailyLimit: a.daily_limit }),
          ...(a.min_interval_ms === undefined ? {} : { minIntervalMs: a.min_interval_ms }),
          ...(a.quiet_until === undefined ? {} : { quietUntil: a.quiet_until }),
        },
        'model',
      )
      // 唤醒规则是"影响模型自己"的配置，按铁律要留痕（走 effects 审计）
      runtime.db
        .prepare(
          `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
           VALUES (?, 'wake_rule', 'model', ?, ?, 1, 1, ?)`,
        )
        .run(`eff_wake_${String(Date.now())}_${Math.random().toString(36).slice(2, 6)}`, `${a.scope}:${a.condition}`, JSON.stringify(rule), new Date().toISOString())
      return { ok: true, condition: rule.condition, enabled: rule.enabled, probability: rule.probability }
    },
  })

  const setStatusTool = defineSpillingTool({
    name: 'set_status',
    description: [
      'Set your own presence (visible to others, to express your situation: online / away / busy / custom text).',
      'If the current state is a **system** fault state set because you could not be woken, this call **does not take effect** - it tells you why,',
      'because quietly turning "I cannot respond right now" into "online" makes you look healthy while you are not.',
    ].join('\n'),
    parameters: {
      state: { type: 'string', required: true, enum: ['online', 'away', 'busy', 'custom'], description: 'The presence value.' },
      text: { type: 'string', description: 'Custom text (used when state=custom).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          source: { type: 'string', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; state: string; message?: string }
        return text(v.ok ? `Presence set to ${v.state}` : (v.message ?? 'the presence change did not take effect'))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { state: 'online' | 'away' | 'busy' | 'custom'; text?: string }
      const result = setModelStatus(runtime.db, { state: a.state, ...(a.text === undefined ? {} : { text: a.text }) })
      if (!result.ok) {
        return { ok: false, state: result.status.state, source: result.status.source, message: result.message }
      }
      return { ok: true, state: result.status.state, source: result.status.source }
    },
  })

  const clearSystemStatusTool = defineSpillingTool({
    name: 'clear_system_status',
    description: [
      'Clear a system-set fault state (use it once you have confirmed the problem is solved).',
      'A reason is required - the clear is recorded, so operators can see who decided the problem was solved and when.',
      'If you have not actually solved it, do not clear it: that makes others think you are fine when you are not.',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: 'Why you believe the problem is solved.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          cleared: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { cleared: boolean; note?: string }
        return text(v.cleared ? 'System fault state cleared' : (v.note ?? 'no system-set state is in effect; nothing to clear'))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string }
      const cleared = runtime.db
        .prepare("SELECT source FROM status_state WHERE id = 1")
        .get() as { source: string } | undefined
      if (cleared?.source !== 'system') {
        return { ok: true, cleared: false, note: 'the current state was not set by the system (it may simply be healthy); nothing to clear.' }
      }
      const { clearSystemStatus } = await import('@forlife/gateway')
      const done = clearSystemStatus(runtime.db, { clearedBy: 'model', reason: a.reason })
      if (done) {
        runtime.db
          .prepare(
            `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
             VALUES (?, 'status_cleared', 'model', 'status', ?, 1, 1, ?)`,
          )
          .run(`eff_status_${String(Date.now())}`, JSON.stringify({ reason: a.reason }), new Date().toISOString())
      }
      return { ok: true, cleared: done }
    },
  })

  /**
   * ★ 任务①：**合并转发**（QQ 原生"聊天记录"卡片）。
   *
   * 两种用法（同一个工具，因为它们是同一件事的两面）：
   *  - **发**：给 `conversation` + `nodes`（自己组织内容），或用 `message_ids`
   *    原样转发已有消息（图片/语音/表情都能保留，比"解析成文字再重打包"好得多）；
   *  - **收**：给 `read`（一个合并转发的 id）取回它的内容。
   *
   * ⚠️ 关于"收"：**别人转给我们的聊天记录，网关已经自动展开**（`gateway.ts` 的
   * `resolveForwards`，NapCat 默认 `parseMultMsg: false` ⇒ 入站只有一个 id）。
   * 所以这个 `read` 模式是给**别的场合**用的：内容取回失败后的重试、
   * 或者模型从历史里看到一个 forward id 想单独看它。
   */
  const qqForward = defineSpillingTool({
    name: 'qq_forward',
    description: [
      '**Merged forward**: pack several pieces of content into one "chat record" card (far more decent than flooding N messages, and less likely to trip anti-spam).',
      '',
      '**Send** (pass `conversation`):',
      '- build it yourself with `nodes`: [{name?, user_id?, text, image?}, ...], one entry per record item;',
      '- or forward existing messages as-is with `message_ids` (**recommended**: images/voice/emoji survive, while repacking keeps text only).',
      '- Warning: a merged forward may contain **only** record nodes - send any explanation separately with `qq_reply` (the protocol side rejects mixing outright).',
      '',
      '**Receive** (pass `read`): fetch the contents of one merged forward.',
      '- Usually unnecessary: chat records forwarded to you are expanded into text by the gateway automatically;',
      '- when the content says "(could not be fetched)", use this to retry by id.',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', description: 'Where to send (conversation key, e.g. onebot11:88888). Required in send mode.' },
      nodes: {
        type: 'array',
        description: 'Each record item: {name?, user_id?, text, image?}. Pass either this or message_ids.',
        // ⚠️ `additionalProperties` **必须显式写**：宿主的 JSON Schema 编译器
        // 不接受"没声明 additionalProperties 的对象"（会直接报 UNSUPPORTED_SCHEMA，
        // 而那个错误会让**整个 buildQqTools 抛异常** ⇒ 35 个工具全部注册不上）。
        items: { type: 'object', additionalProperties: true },
      },
      message_ids: { type: 'array', items: { type: 'string' }, description: 'Message ids to forward as-is. Pass either this or nodes.' },
      read: { type: 'string', description: 'Receive mode: id of the merged forward whose contents to fetch.' },
      summary: { type: 'string', description: 'Optional: summary text shown on the card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, description: 'send or read.' },
          confirmed: { type: 'boolean', description: 'Send mode: whether delivery was confirmed.' },
          messageId: { type: 'string', description: 'Send mode: platform message id.' },
          outboxId: { type: 'string', description: 'Send mode: queue id.' },
          text: { type: 'string', description: 'Receive mode: the flattened content.' },
          nodeCount: { type: 'integer', description: 'Receive mode: how many items were reconstructed.' },
          notes: { type: 'array', items: { type: 'string' }, description: 'Receive mode: parse warnings (truncated / unrendered segments).' },
          hint: { type: 'string', description: 'Failure reason or self-help hint.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; mode: string; confirmed?: boolean; nodeCount?: number; notes?: string[]; text?: string; hint?: string; messageId?: string }
        if (v.mode === 'read') {
          if (!v.ok) return text(v.hint ?? 'the fetch failed')
          const warn = v.notes === undefined || v.notes.length === 0 ? '' : `\n(note: ${v.notes.join('; ')})`
          return text(`Chat record contents (${String(v.nodeCount ?? 0)} items):\n${v.text ?? ''}${warn}`)
        }
        if (!v.ok) return text(`the merged forward was not sent: ${v.hint ?? ''}`)
        return text(v.confirmed === true ? `Merged forward delivered (message_id=${v.messageId ?? 'unknown'})` : `Merged forward submitted but no delivery confirmation was received. ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as {
        conversation?: string
        nodes?: { name?: string; user_id?: string; text?: string; image?: string }[]
        message_ids?: string[]
        read?: string
        summary?: string
      }
      runtime.recordToolCall()

      // ── 收：按 id 取回内容 ──────────────────────────────────────────
      if (a.read !== undefined && a.read !== '') {
        const probed = await runProbe('get_forward_msg', { message_id: a.read })
        if (!probed.ok) return { ok: false, mode: 'read', hint: probed.error ?? 'the fetch failed' }
        const data = probed.data as { text?: string; nodeCount?: number; notes?: string[] } | undefined
        return { ok: true, mode: 'read', text: data?.text ?? '', nodeCount: data?.nodeCount ?? 0, notes: data?.notes ?? [] }
      }

      // ── 发 ────────────────────────────────────────────────────────
      if (a.conversation === undefined || a.conversation === '') {
        return { ok: false, mode: 'send', hint: 'pass either conversation (send) or read (receive); neither was given.' }
      }
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, mode: 'send', hint: target.message }

      const hasNodes = Array.isArray(a.nodes) && a.nodes.length > 0
      const hasIds = Array.isArray(a.message_ids) && a.message_ids.length > 0
      if (hasNodes === hasIds) {
        return { ok: false, mode: 'send', hint: 'nodes and message_ids: pass **exactly one** of them (either build the content yourself, or forward existing messages as-is).' }
      }
      const built = hasIds
        ? buildForwardNodesFromIds(a.message_ids ?? [])
        : buildForwardNodes(
            (a.nodes ?? []).map((node) => ({
              text: node.text ?? '',
              ...(node.name === undefined ? {} : { name: node.name }),
              ...(node.user_id === undefined ? {} : { userId: node.user_id }),
              ...(node.image === undefined ? {} : { image: node.image }),
            })),
          )
      if (!built.ok) return { ok: false, mode: 'send', hint: built.error }

      // 合并转发是**发送类动作** ⇒ 同样受发消息方向的速率限制（用户要求一并纳入）
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, mode: 'send', hint: `${gate.hint} (you can send again in about ${String(gate.retryAfterMs)}ms)` }

      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'forward',
        payload: { nodes: built.nodes, ...(a.summary === undefined ? {} : { summary: a.summary }) },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return {
        ok: true,
        mode: 'send',
        confirmed: result.confirmed,
        outboxId,
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}. Queue id: ${outboxId}; you can check later.` }),
      }
    },
  })

  /** ★ 任务③：待处理的好友/群请求（让模型能主动问"有没有人加我"）。 */
  const qqRequests = defineSpillingTool({
    name: 'qq_requests',
    description: [
      'See **pending** friend requests and group join requests (handled ones no longer appear).',
      'When someone adds you or invites you to a group, the system tells you in a notification; this tool is for "let me check for myself".',
      'Acting on one needs `qq_handle_request`, which needs a `flag` - **flags can only be taken from here** (or copied from a notification).',
      'Inventing a flag always fails: in NapCat a friend request flag is really its `reqTime`, and a group request flag is the notification `seq`.',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', enum: ['friend', 'group'], description: 'Optional: only friend requests, or only group requests.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pending: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                flag: { type: 'string' },
                kind: { type: 'string' },
                userId: { type: 'string' },
                groupId: { type: 'string' },
                comment: { type: 'string' },
                subType: { type: 'string' },
                at: { type: 'string' },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { pending: number; items: { kind: string; userId: string; groupId?: string; comment: string; flag: string }[] }
        if (v.pending === 0) return text('No pending friend/group requests.')
        return text(
          [
            `${String(v.pending)} pending: `,
            ...v.items.map(
              (i) =>
                `- ${i.kind === 'friend' ? 'friend request' : `group join request (group ${i.groupId ?? '?'})`} from ${i.userId}` +
                `${i.comment === '' ? '' : `, comment: "${i.comment}"`}, flag=${i.flag}`,
            ),
            'To act on one with qq_handle_request, pass that flag string back unchanged.',
          ].join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { kind?: 'friend' | 'group' }
      runtime.recordToolCall()
      const items = listPendingRequests(runtime.db, { ...(a.kind === undefined ? {} : { kind: a.kind }), limit: 100 })
      return {
        ok: true,
        pending: items.length,
        items: items.map((i) => ({
          flag: i.flag,
          kind: i.kind,
          userId: i.userId,
          ...(i.groupId === undefined ? {} : { groupId: i.groupId }),
          comment: i.comment,
          ...(i.subType === undefined ? {} : { subType: i.subType }),
          at: i.at,
        })),
      }
    },
  })

  /** ★ 任务③：同意/拒绝好友申请与入群请求。 */
  const qqHandleRequest = defineSpillingTool({
    name: 'qq_handle_request',
    description: [
      'Approve or reject a friend request / group join request.',
      '',
      'Warning: **this action has security implications**:',
      '- approving a friend = they can **message you directly** from then on, and they see your activity and presence;',
      '- approving a group = you enter that group\'s conversation scope (its messages may wake you);',
      '- for strangers, or comments that look like ads/traffic-farming, **the default should be reject**; when unsure, leave it (leaving it beats adding carelessly).',
      '',
      '`flag` must come from `qq_requests` (or a system notification) - inventing one always fails.',
      `**Rate limited**: at most ${String(defaultFor<number>('qq.requests.handlePerHourMax'))} requests per hour (protection against request floods).`,
      'The outcome is recorded (who approved whom, and when), so write `reason` clearly.',
    ].join('\n'),
    parameters: {
      flag: { type: 'string', required: true, description: 'The request flag (from qq_requests).' },
      kind: { type: 'string', required: true, enum: ['friend', 'group'], description: 'Whether this is a friend request or a group request.' },
      approve: { type: 'boolean', required: true, description: 'true = approve, false = reject.' },
      reason: { type: 'string', description: 'Note when approving / reason when rejecting (recorded).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
          outboxId: { type: 'string' },
          throttled: { type: 'boolean' },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; confirmed: boolean; throttled?: boolean; hint?: string }
        if (v.throttled === true) return text(`**Not handled** (blocked by the rate limit): ${v.hint ?? ''}`)
        if (!v.ok) return text(`handling failed: ${v.hint ?? 'unknown reason'}`)
        return text(v.confirmed ? 'Handled (confirmed by the protocol side)' : `Submitted but no confirmation was received. ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { flag: string; kind: 'friend' | 'group'; approve: boolean; reason?: string }
      runtime.recordToolCall()
      if (a.flag.trim() === '') return { ok: false, confirmed: false, hint: 'flag cannot be empty - it must come from qq_requests.' }

      // ★ 也是一种"发送类动作"（会触发 QQ 侧动作）⇒ 一并纳入限流（用户要求）。
      //   用**独立的**小时额度：处理请求与发消息是两件事，
      //   拿发消息的额度挡它会让"好友申请积压时连话都不能回"。
      const perHourMax = defaultFor<number>('qq.requests.handlePerHourMax')
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
      const used = (
        runtime.db
          .prepare("SELECT count(*) AS n FROM qq_outbox WHERE kind IN ('friend_request','group_request') AND sent_at >= ?")
          .get(hourAgo) as { n: number }
      ).n
      if (used >= perHourMax) {
        return {
          ok: false,
          confirmed: false,
          throttled: true,
          hint: `${String(used)} requests were already handled in the last hour (limit ${String(perHourMax)}, baseline qq.requests.handlePerHourMax). Wait a while, or handle only the most important ones first.`,
        }
      }

      const outboxId = enqueueOutbound(runtime.db, {
        // 请求处理没有"会话"概念（还没有会话），用申请人的会话键占位：
        // 这样面板上能看出"这条动作跟谁有关"。
        conversationKey: a.kind === 'friend' ? `onebot11:${a.flag}` : 'onebot11:0',
        conversationKind: 'private',
        kind: a.kind === 'friend' ? 'friend_request' : 'group_request',
        payload: { flag: a.flag, approve: a.approve, ...(a.reason === undefined ? {} : { reason: a.reason }) },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      if (result.confirmed) {
        // 处理成功 ⇒ 写"已处理"标记，它从此不再出现在待处理列表里
        markRequestHandled(runtime.db, {
          flag: a.flag,
          kind: a.kind,
          approve: a.approve,
          ...(a.reason === undefined ? {} : { reason: a.reason }),
          actor: 'model',
        })
      }
      return {
        ok: true,
        confirmed: result.confirmed,
        outboxId,
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''} (possible causes: the flag expired / someone else handled it / the QQ side is disconnected)` }),
      }
    },
  })

  /** ★ 任务③：列表查询（好友 / 群 / 群成员）。 */
  const qqContacts = defineSpillingTool({
    name: 'qq_contacts',
    description: [
      'Look up your contacts: friend list, group list, or the member list of one group.',
      'Use it to answer "do I know this person", "which groups am I in", "who is in this group".',
      'To see **who is asking to add you**, use `qq_requests` (those are pending requests, not existing contacts).',
      'Warning: a member list can be long (hundreds in big groups); the result is bounded by `limit` and tells you when it was truncated.',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, enum: ['friends', 'groups', 'members'], description: 'What to look up: friends / groups / group members.' },
      group_id: { type: 'string', description: 'Required when kind=members: which group.' },
      query: { type: 'string', description: 'Optional: filter by nickname/remark/group name (case-insensitive substring match).' },
      limit: { type: 'integer', description: `How many to return at most (default ${String(defaultFor<number>('qq.contacts.listMaxItems'))}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true, description: 'Total after filtering (may exceed count).' },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; kind: string; count: number; total: number; items: Record<string, unknown>[]; hint?: string }
        if (!v.ok) return text(v.hint ?? 'the lookup failed')
        if (v.total === 0) return text('No matching entries.')
        const label = v.kind === 'friends' ? 'friends' : v.kind === 'groups' ? 'groups' : 'group members'
        const lines = v.items.map((item) => `- ${String(item['label'] ?? '')}`)
        const tail = v.total > v.count ? `\n(${String(v.total)} in total; only the first ${String(v.count)} are listed - filter with query or raise limit)` : ''
        return text([`${label}: ${String(v.total)}`, ...lines].join('\n') + tail)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { kind: 'friends' | 'groups' | 'members'; group_id?: string; query?: string; limit?: number }
      runtime.recordToolCall()
      const limit = a.limit ?? defaultFor<number>('qq.contacts.listMaxItems')
      if (a.kind === 'members' && (a.group_id === undefined || a.group_id === '')) {
        return { ok: false, kind: a.kind, count: 0, total: 0, items: [], hint: 'group_id is required when kind=members.' }
      }
      const action: ProbeAction = a.kind === 'friends' ? 'get_friend_list' : a.kind === 'groups' ? 'get_group_list' : 'get_group_member_list'
      const probed = await runProbe(action, a.kind === 'members' ? { group_id: a.group_id } : {})
      if (!probed.ok) return { ok: false, kind: a.kind, count: 0, total: 0, items: [], hint: probed.error ?? 'the lookup failed' }

      const needle = (a.query ?? '').trim().toLowerCase()
      const all: { label: string }[] = []
      if (a.kind === 'friends') {
        for (const f of (probed.data ?? []) as { userId: string; nickname: string; remark?: string }[]) {
          all.push({ label: `${f.userId} ${f.remark === undefined ? f.nickname : `${f.remark}（${f.nickname}）`}` })
        }
      } else if (a.kind === 'groups') {
        for (const g of (probed.data ?? []) as { groupId: string; groupName: string; memberCount?: number }[]) {
          all.push({ label: `${g.groupId} ${g.groupName}${g.memberCount === undefined ? '' : ` (${String(g.memberCount)} members)`}` })
        }
      } else {
        for (const m of (probed.data ?? []) as { userId: string; nickname: string; card?: string; role?: string }[]) {
          all.push({ label: `${m.userId} ${m.card === undefined ? m.nickname : `${m.card}（${m.nickname}）`}${m.role === undefined ? '' : ` [${m.role}]`}` })
        }
      }
      const filtered = needle === '' ? all : all.filter((item) => item.label.toLowerCase().includes(needle))
      return { ok: true, kind: a.kind, count: Math.min(filtered.length, limit), total: filtered.length, items: filtered.slice(0, limit) }
    },
  })

  /**
   * ★ P2-d：**发图片**。
   *
   * ## 为什么以前发不出图
   *
   * `OutboundSegment` 早就有 `image`，`toOneBotSegments` 也早就映射好了 ——
   * **缺的只是入队点**（`kind:'image'` 全仓零入队点）。于是模型只能发文字/@/引用/表情包，
   * 而"给她回一张图"这件事在能力上不存在。
   *
   * ## 为什么 `file` 允许三种形态
   *
   * 实测 NapCat 的出站转换器 `[ze.image] → handleOb11FileLikeMessage`：
   * `data.file` 可以是 **URL / base64 / 本地路径**（它自己判断 `isLocal`）。
   * ⚠️ 但"本地路径"是**协议端容器里**的路径 —— 工具进程写的文件它看不到，
   * 所以描述里明确推荐 **URL 或 base64**。
   */
  const qqSendImage = defineSpillingTool({
    name: 'qq_send_image',
    description: [
      '**Send an image** to a given QQ conversation.',
      '`file` can be: a **direct http(s) image URL** (recommended), `base64://...`, or a local path on the protocol side.',
      'Warning: a local path means a path **inside the protocol side (the NapCat container)** - it cannot see files you wrote, so prefer a URL.',
      'The image **gets downloaded**: large files are slow; check that the link works first when in doubt.',
      `**Send rate limit applies**: it shares the same quota as messages (at most ${String(defaultFor<number>('qq.send.perMinuteMax'))} per minute,` +
        `${String(defaultFor<number>('qq.send.burstMax'))} within ${String(defaultFor<number>('qq.send.burstWindowMs') / 1000)} seconds).`,
      'Sending an image **cannot** carry text along: send the explanation separately with `qq_reply` (the protocol side accepts one segment sequence per message, and keeping the order explicit is simpler).',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key, e.g. onebot11:88888 (group) or onebot11:10001 (private).' },
      file: { type: 'string', required: true, description: 'Image address (http/https URL recommended), base64://... or a local path on the protocol side.' },
      summary: { type: 'string', description: 'Optional: image summary (some clients display it).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true, description: 'Whether delivery was confirmed.' },
          outboxId: { type: 'string', required: true, description: 'Queue id (useful for checking later).' },
          messageId: { type: 'string', description: 'Platform message id (present only after confirmation).' },
          throttled: { type: 'boolean', description: 'Blocked by the send rate limit (the image was not queued).' },
          hint: { type: 'string', description: 'Self-help hint when unconfirmed or throttled.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; throttled?: boolean; hint?: string; messageId?: string }
        if (v.throttled === true) return text(`**The image was not sent (blocked by the rate limit)**: ${v.hint ?? ''}`)
        return text(v.confirmed ? `Image delivered (message_id=${v.messageId ?? 'unknown'})` : `Image submitted but no delivery confirmation was received. ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; file: string; summary?: string }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }
      if (a.file.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'file cannot be empty (pass a URL or base64://...).' }
      // 发送类动作 ⇒ 与 qq_reply 走**同一个**入队前速率闸门（不另开一条绕过它的路）
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint} (you can send again in about ${String(gate.retryAfterMs)}ms)` }
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'image',
        payload: { segments: [{ kind: 'image', file: a.file }], ...(a.summary === undefined ? {} : { summary: a.summary }) },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return {
        ok: true,
        confirmed: result.confirmed,
        outboxId,
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}. Queue id: ${outboxId}; you can check later.` }),
      }
    },
  })

  /**
   * ★ P2-d：**发文件**。
   *
   * 实测确认这条路可用（不是照 OneBot 文档猜的）：NapCat 的 `ob11ToRawConverters`
   * **有** `[ze.file]` 分支 ⇒ `send_group_msg` / `send_private_msg` 带 `file` 段是合法的
   * （它内部会把文件**上传**到群文件/私聊文件，`createValidSendFileElement`）。
   */
  const qqSendFile = defineSpillingTool({
    name: 'qq_send_file',
    description: [
      '**Send a file** to a given QQ conversation (in a group it uploads as a group file).',
      '`file` can be: a **direct http(s) URL** (recommended), `base64://...`, or a local path on the protocol side.',
      '`name` is the file name the recipient sees (omitted, the name from the URL is used).',
      'Warning: large files are **uploaded first and then sent**, which can be slow (minutes). Think about whether it really must be sent.',
      `**Send rate limit applies**: it shares the same quota as messages (at most ${String(defaultFor<number>('qq.send.perMinuteMax'))} per minute).`,
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key, e.g. onebot11:88888 (group) or onebot11:10001 (private).' },
      file: { type: 'string', required: true, description: 'File address (http/https URL recommended), base64://... or a local path on the protocol side.' },
      name: { type: 'string', description: 'Optional: the file name the recipient sees.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
          outboxId: { type: 'string', required: true },
          messageId: { type: 'string' },
          throttled: { type: 'boolean' },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; throttled?: boolean; hint?: string; messageId?: string }
        if (v.throttled === true) return text(`**The file was not sent (blocked by the rate limit)**: ${v.hint ?? ''}`)
        return text(v.confirmed ? `File sent (message_id=${v.messageId ?? 'unknown'})` : `File submitted but no delivery confirmation was received (a large upload may still be running). ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; file: string; name?: string }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }
      if (a.file.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'file cannot be empty (pass a URL or base64://...).' }
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint} (you can send again in about ${String(gate.retryAfterMs)}ms)` }
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: target.key,
        conversationKind: target.kind,
        kind: 'file',
        payload: {
          segments: [{ kind: 'file', file: a.file, ...(a.name === undefined ? {} : { name: a.name }) }],
        },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return {
        ok: true,
        confirmed: result.confirmed,
        outboxId,
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}. Queue id: ${outboxId}; you can check later.` }),
      }
    },
  })

  /**
   * ★ P2-d：**撤回消息**（`delete_msg`）。
   *
   * ## 为什么接上而不是删掉死代码
   *
   * `onebot.ts` 的 `deleteMessage` 一直是死代码（零入队点）—— 两条路：
   * 删掉它，或者给它一个入口。**选接上**，理由（用户裁定"没做的点得做"）：
   *  - "发错话却收不回来"是真实会发生的事故，而 QQ 侧**本来就有这个能力**，
   *    我们自己把它锁死在代码里没有任何收益；
   *  - 死代码留在那里，下一个读代码的人会以为"这个功能已经有了"。
   *
   * ## 为什么 `conversation` 是可选的（与 `qq_reply` 的硬要求不同）
   *
   * `qq_reply` 必须给会话是因为**目标不可推断**（猜错就把私聊的话发到群里）。
   * 撤回的目标是**消息 id**，它本身就唯一确定了那条消息 ——
   * 再强制要一个会话键只是让模型多抄一遍，且**抄错也不会改变实际行为**
   * （反而制造"参数看着对、行为却按 id 走"的错觉）。所以这里只把它当**记账信息**。
   */
  const qqRecall = defineSpillingTool({
    name: 'qq_recall',
    description: [
      '**Recall** a message.',
      'Warning: QQ\'s rules (not our limits): a bot can normally recall only **its own** messages, and usually within **two minutes**;' +
        'group admins can recall other people\'s. When it times out or you lack permission the protocol side reports an error - do not retry repeatedly then.',
      '`message_id` must be the **real platform message id** (the send result carries it, or take it from an inbound message).',
      `**Send rate limit applies**: it shares the same quota as messages (at most ${String(defaultFor<number>('qq.send.perMinuteMax'))} per minute).`,
      'A recall is **irreversible**: think first, and do not use it to "clean up traces".',
    ].join('\n'),
    parameters: {
      message_id: { type: 'string', required: true, description: 'Id of the message to recall.' },
      conversation: { type: 'string', description: 'Optional: the conversation this message belongs to (for bookkeeping only; the recall goes by message_id).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
          outboxId: { type: 'string', required: true },
          throttled: { type: 'boolean' },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; throttled?: boolean; hint?: string }
        if (v.throttled === true) return text(`**Not recalled** (blocked by the rate limit): ${v.hint ?? ''}`)
        return text(v.confirmed ? 'Recalled' : `Recall submitted but no confirmation was received. ${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { message_id: string; conversation?: string }
      runtime.recordToolCall()
      if (a.message_id.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'message_id cannot be empty.' }
      // 会话键只做记账：给了就解析（解析不了也照撤 —— 目标由 message_id 唯一确定）
      let key = 'onebot11:0'
      let kind: 'private' | 'group' | 'temp' = 'private'
      if (a.conversation !== undefined && a.conversation !== '') {
        const target = parseTarget(a.conversation)
        if (target.ok) {
          key = target.key
          kind = target.kind
        }
      }
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint} (you can try again in about ${String(gate.retryAfterMs)}ms)` }
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: key,
        conversationKind: kind,
        kind: 'delete',
        payload: { messageId: a.message_id },
        source: 'model',
      })
      const result = await waitForConfirmation(runtime.db, outboxId, { timeoutMs: confirmTimeoutMs })
      return {
        ok: true,
        confirmed: result.confirmed,
        outboxId,
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''} (possible causes: more than two minutes passed / it was not yours / the message id is wrong)` }),
      }
    },
  })

  /**
   * ★★ 2026-10-11（用户裁定，见 `FIX_PLAN.md` §60 ① / §64）：
   * `peer_input_status` **不再是唤醒条件**，改成**模型可以主动问的工具**。
   *
   * ## 用户原话
   * 「**不再成为唤醒条件**，而是成为一个**模型可以用来查询的工具**，用来确认对方的状态；
   *  同时**如果他试图对群聊使用，工具返回报错并且提醒不能查询群聊的状态**。」
   *
   * ## 为什么这正是原始设计的形状
   * `gateway.ts:231-246` 那段注释写着：正在输入是**瞬时信号**，由 `read_pending` **现问现答**。
   * ★ 事实上 `read_pending` 的每一条**已经**带 `typing` —— 但那要**先拉一整批消息**才能问一句状态。
   * ★ 本工具给的是**只问状态**的入口：不取消息、不消耗取回额度。
   *
   * ## ★ 为什么"不认识 ⇒ 报错"，而不是像 `parseTarget()` 那样兜成私聊
   * 同文件的 `parseTarget()` 兜底是 `'private'` —— 在**发消息**那里是合理的（总得有个目标）。
   * ★ 这里**不能**那么兜：对一个**还没进 `qq_sessions` 的群**答一句"对方没在打字"，
   * 是一句**看起来像答案的错话**，比报错坏得多。
   * ⇒ 三种结果分开：**群 ⇒ 报错** · **私聊/临时 ⇒ 回答** · **不认识 ⇒ 报错**。
   */
  const peerStatusTool = defineSpillingTool({
    name: 'peer_status',
    description: [
      'Ask "is the other side still there / were they just typing".',
      '**Private chats only** - groups have no typing signal, and **asking about a group errors out**.',
      'The answer says whether a typing event happened **within the last dozen seconds or so** (the "typing" the protocol side reports):',
      'It is a **hint that expires**, not a live snapshot. To check whether the other side is still there, waiting one beat with `defer_turn` is usually more reliable.',
      'Unlike `read_pending`, this **only asks about state**: it fetches no messages and consumes no fetch quota.',
    ].join('\n'),
    parameters: {
      conversation: {
        type: 'string',
        description: 'The conversation to ask about; it must be a **private chat** (e.g. onebot11:10001). A group errors out.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          conversation: { type: 'string', description: 'Echoes which conversation was asked about.' },
          kind: { type: 'string', enum: ['private', 'temp'], description: 'Conversation type (only these two can be asked about).' },
          /** ★ 会过期的提示，不是实时状态。 */
          typing: { type: 'boolean', description: 'The other side had a typing event within the last dozen seconds or so (it expires; not live state).' },
          error: { type: 'string', description: 'Failure reason (a group / unknown conversation / malformed key).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; conversation?: string; typing?: boolean; error?: string }
        if (!v.ok) return text(`**Cannot ask**: ${v.error ?? 'unknown reason'}`)
        return text(
          v.typing === true
            ? `${v.conversation ?? ''}: the other side had a typing event **within the last dozen seconds or so** (it expires; not live state).`
            : `${v.conversation ?? ''}: **no** recent typing event (it may simply mean they were not typing).`,
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation?: string }
      const conversation = (a.conversation ?? '').trim()
      if (conversation === '') {
        return { ok: false, error: '`conversation` is required (e.g. onebot11:10001).' }
      }
      if (parseConversationKey(conversation) === undefined) {
        return {
          ok: false,
          error: `bad conversation key: ${conversation} (expected platform:chat_id, e.g. onebot11:10001).`,
        }
      }
      // ★ 自己查 `qq_sessions`，**不**用 `parseTarget()` —— 它的兜底是 'private'（理由见方法头）
      const row = runtime.db
        .prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?')
        .get(conversation) as { kind: string } | undefined
      if (row === undefined) {
        return {
          ok: false,
          error:
            `unknown conversation ${conversation} - it has not appeared in the conversation table yet (no message from it has arrived).` +
            'Do not guess: answering "nobody is typing" about a group would be **a wrong answer that looks like an answer**.',
        }
      }
      if (row.kind === 'group') {
        return {
          ok: false,
          error:
            '**Group status cannot be queried** - groups have no typing signal (the protocol side reports typing events for private chats only).' +
            'To find out what a group is talking about, use `read_pending` with `kind: "group"`.',
        }
      }
      if (row.kind !== 'private' && row.kind !== 'temp') {
        return { ok: false, error: `unknown conversation kind: ${row.kind} (only private / temp are supported).` }
      }
      return {
        ok: true,
        conversation,
        kind: row.kind,
        typing: isPeerTyping(runtime.db, conversation),
      }
    },
  })

  return [qqReply, qqReact, qqTyping, qqSendImage, qqSendFile, qqRecall, qqForward, qqRequests, qqHandleRequest, qqContacts, deferTurn, readPendingTool, peerStatusTool, listWakeRulesTool, setWakeRuleTool, setStatusTool, clearSystemStatusTool, ...buildStickerTools(defineTool, runtime), ...buildMentionTools(defineTool, runtime)]
}

