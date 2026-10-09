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
      return { ok: false, message: `会话键格式不对：${conversation}（应为 platform:chat_id[:thread_id]，例如 onebot11:88888）` }
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
        ? '查询已完成但结果没读到（可能被并发清理了），请重试'
        : `查询没有在 ${String(confirmTimeoutMs)}ms 内完成：${confirmed.error ?? '未知原因'}（QQ 端可能未连接，或 QQ 网关没在跑）`,
    }
  }

  const qqReply = defineSpillingTool({
    name: 'qq_reply',
    description: [
      // ★ **工具调用限制**（用户明确要求写进描述）：
      // QQ 消息是碎片化的 —— 上下几条常常是同一个意思。
      // 发送之前必须先取回所有消息，否则会对着半句话回复，
      // 而用户看到的是「你怎么答非所问」。
      '**发送前必须先调用 `read_pending` 取回所有消息** —— 这是硬性顺序要求，不是建议。',
      'QQ 消息是**碎片化**的：上下几条常常在说同一件事。只看到一条就回复，极可能答非所问。',
      '取回后你会看到**全部**待处理消息，再决定怎么回。',
      // ⚠️ 这里曾经写着"取回结果里带 `typing: true`" —— 而当时 `read_pending` 的输出里
      //    根本没有这个字段（`pending_messages` 表也不存它）⇒ **那句话永远兑现不了**。
      //    上一轮把它改成了"拿不到"，而**这一轮真的接上了**：
      //    协议端的 `notify/input_status` 事件（P1-4 已归一为 `peer_input_status`）
      //    被记进 `forlife_state`（自带过期时刻），`read_pending` 的每一条会带 `typing`。
      //    ⇒ 描述回到"能兑现"的状态，但**如实说明它的时效**：
      //    它是"最近十几秒内有过输入事件"，不是"此刻正在打字"的实时快照。
      '取回结果里的 `typing: true` 表示**最近十几秒内**对方有过输入事件（协议端上报的"正在输入"）；',
      '它是**会过期的提示**，不是实时状态 —— 想确认对方还在不在，用 `defer_turn` 等一拍比盯着它更靠谱。',
      '给指定的 QQ 会话发消息。可以多次调用实现分段回复（每次调用是一条独立消息，顺序即调用顺序）。',
      '**必须指定 conversation** —— 你可能同时在处理多个会话，猜错目标在群里是灾难性的。',
      `发送后会等 ${String(confirmTimeoutMs)}ms 的送达确认：确认到就返回 messageId；没确认到会明确告诉你"已提交但未确认"，你可以稍后自查或重发。`,
      // ★ 发消息方向的限制（用户要求"在发消息的位置做出限制"）——写进描述，
      //   否则模型会以为可以连着刷几十条，撞上限流后以为工具坏了。
      `**有发送速率限制**：每分钟最多 ${String(defaultFor<number>('qq.send.perMinuteMax'))} 条、` +
        `${String(defaultFor<number>('qq.send.burstWindowMs') / 1000)} 秒内最多 ${String(defaultFor<number>('qq.send.burstMax'))} 条。` +
        '被限流时会明确告诉你还要等多久 —— **不要**靠反复重试绕过它，那正是要被挡掉的行为。',
      '想把一段较长的内容打包成"聊天记录"卡片发出去，用 `qq_forward`（它比连刷多条更合适）。',
      '想让全群都收到提醒时别用它，用 @全体成员的独立工具（它有限额）。',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键，如 onebot11:88888（群）或 onebot11:10001（私聊）。' },
      text: { type: 'string', required: true, description: '要发送的文本。' },
      reply_to: { type: 'string', description: '可选：要引用的消息 id。' },
      at: { type: 'array', items: { type: 'string' }, description: '可选：要 @ 的 QQ 号列表（空数组表示不 @）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true, description: '是否收到送达确认。' },
          messageId: { type: 'string', description: '平台消息 id（确认后才有）。' },
          outboxId: { type: 'string', required: true, description: '队列 id（可用于自查）。' },
          /** 是否被发送速率闸门拦下（拦下时**队列里没有这一条**，所以没有 outboxId）。 */
          throttled: { type: 'boolean', description: '被发送速率限制拦下（消息没有入队）。' },
          hint: { type: 'string', description: '未确认或被限流时的自助提示。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; messageId?: string; hint?: string; throttled?: boolean }
        if (v.throttled === true) return text(`**这一条没有发出去（被速率限制拦下）**：${v.hint ?? ''}`)
        if (v.confirmed) return text(`已送达（message_id=${v.messageId ?? '未知'}）`)
        return text(`已提交但未收到送达确认。${v.hint ?? ''}`)
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
            `**检测到你在重复输出，这一轮被中止了。** 理由：${verdict.reason}。` +
            '请**不要再重复**——换一个完全不同的做法，或者说明你卡在哪里、需要什么信息。',
        }
      }

      const segments: OutboundSegment[] = []
      if (a.reply_to !== undefined && a.reply_to !== '') segments.push({ kind: 'reply', messageId: a.reply_to })
      for (const userId of a.at ?? []) segments.push({ kind: 'at', userId })
      segments.push({ kind: 'text', text: a.text })

      // ★ 发消息方向的限制①：入队前的速率闸门（超了**不写队列**，如实告诉模型）
      const gate = sendGate()
      if (gate !== undefined) {
        return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint}（约 ${String(gate.retryAfterMs)}ms 后可以再发）` }
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
          : { hint: `${result.error ?? ''}。你可以用 qq_reply 重发，或先观察一会儿再决定（队列 id：${outboxId}）。` }),
      }
    },
  })

  const qqReact = defineSpillingTool({
    name: 'qq_react',
    description: '给一条消息加表情回应（比回一条"哈哈"更轻，适合表示收到/认同）。',
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键。' },
      message_id: { type: 'string', required: true, description: '要回应的消息 id。' },
      emoji: { type: 'string', required: true, description: '表情 id（如 128077 表示 👍）。' },
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
        return text(v.confirmed ? '表情回应已送达' : '表情回应已提交，未收到确认')
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
      '打开/关闭"正在输入"状态。**只对私聊有效** —— 群聊没有这个能力，调用会明确告诉你失败。',
      '适合在你要花几秒思考或调工具前先打开，让对方知道你在打字。',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键。' },
      on: { type: 'boolean', required: true, description: 'true 打开，false 关闭。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          supported: { type: 'boolean', required: true, description: '该会话是否支持这个能力。' },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; supported: boolean; note?: string }
        if (!v.supported) return text(v.note ?? '该会话不支持"正在输入"')
        return text(v.ok ? '已设置输入状态' : '设置输入状态失败')
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; on: boolean }
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, supported: false, note: target.message }
      if (target.kind === 'group') {
        // 如实告知：群聊没有这个能力（不假装成功）
        return { ok: false, supported: false, note: '群聊没有"正在输入"能力（协议层仅私聊支持），所以没有发送。' }
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
      '挂起当前轮次：你需要等一个长任务（外部进程、下载、别人回复）而暂时无法给出结论时用。',
      '挂起期间**不会提交中期记忆**，等任务完成后从原状态恢复。',
      '不要用它来"拖时间"或回避回答 —— 能答就答，答不了就说答不了。',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: '为什么要挂起（会记进轮次与日志）。' },
      expected_duration_ms: { type: 'integer', description: '预计需要多久（毫秒），用于让网关知道什么时候该来看。' },
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
        return text(v.deferred ? '已挂起本轮，等任务完成后恢复' : (v.note ?? '当前没有进行中的轮次可挂起'))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string; expected_duration_ms?: number }
      // 找当前 running 的轮次（跨进程共享库 ⇒ 直接改表，网关与驱动都能看到）
      const turn = runtime.db
        .prepare("SELECT id FROM qq_turns WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
        .get() as { id: string } | undefined
      if (turn === undefined) {
        return { ok: true, deferred: false, note: '当前没有进行中的轮次（可能不在 QQ 轮次里），已忽略。' }
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
      '**这是发送消息前的必经步骤**（`qq_reply` 要求你先调用它）：',
      'QQ 消息碎片化，上下几条常是同一件事，只看到一条就回复极可能答非所问。',
      '取回"你被唤醒期间错过、但没吵醒你"的消息（群里没人 @ 你的闲聊就在那里）。',
      '读过的会被标记已读，不会重复出现。想了解某个群/某个人最近在聊什么时用它。',
      '',
      // ★ 取消息方向的限制（用户要求"在取消息的位置做出限制"）——**必须写进描述**，
      //   否则模型会以为可以随便一次抓 500 条，然后撞上限流、以为工具坏了。
      `**取回有额度**：单次最多 ${String(defaultFor<number>('qq.backlog.readBatchMax'))} 条、` +
        `本轮最多 ${String(defaultFor<number>('qq.backlog.readPerTurnBatches'))} 批 / ` +
        `${String(defaultFor<number>('qq.backlog.readPerTurnMax'))} 条。超了会明确告诉你还剩多少。`,
      '**可以按来源筛**：给 `scope` 精确到一个会话，给 `kind` 只要某一类（`group` = 所有群）。',
      '想"先不看群里的闲聊"就给 `kind: "private"`；想专门清群就给 `kind: "group"`。',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', description: '可选：只看某个来源，如 group:88888 或 private:10001。' },
      kind: { type: 'string', enum: ['group', 'private'], description: '可选：只看某一类来源（group = 所有群；private = 所有私聊含临时会话）。' },
      conversation: { type: 'string', description: '可选：只看某个会话键（如 onebot11:88888）。' },
      limit: { type: 'integer', description: '最多读多少条（会被单次与单轮上限压下来，返回值里会说明）。' },
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
                typing: { type: 'boolean', description: '最近十几秒内对方有过输入事件（会过期，不是实时状态）。' },
              },
            },
          },
          /** 取完（按同一筛选口径）还剩多少条未读。 */
          remaining: { type: 'integer', description: '按本次筛选口径还剩多少条未读。' },
          /** 本轮还剩多少额度 —— 让模型自己规划"要不要分几次取"。 */
          quota: { type: 'string', description: '本轮取回额度的人话说明。' },
          hint: { type: 'string', description: '被限流时告诉你为什么、以及怎么办。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { count: number; remaining?: number; quota?: string; hint?: string; items: { conversation: string; sender?: string; summary: string }[] }
        if (v.hint !== undefined) return text(v.hint)
        if (v.count === 0) return text(v.remaining === undefined || v.remaining === 0 ? '没有未读的待读消息。' : `本次筛选没有可取的（还剩 ${String(v.remaining)} 条，换个筛选条件再试）。`)
        return text(
          [
            `取回 ${String(v.count)} 条（还剩 ${String(v.remaining ?? 0)} 条未读）：`,
            ...v.items.map((i) => `- [${i.conversation}] ${i.sender ?? ''}：${i.summary}`),
            v.quota === undefined ? '' : `【额度】${v.quota}`,
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
      '看你当前的唤醒规则：哪些条件会叫醒你、概率多少、有没有限额或静默期。',
      '每个条件都是**独立**的（例如"@全体成员"与"@我"分开算），改一个不影响另一个。',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', description: '可选：看某个范围（group:88888 / private:10001）；不填看全局默认。' },
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
          [`${v.scope} 的唤醒规则：`, ...v.rules.map((r) => `- ${r.condition}：${r.enabled ? `${String(r.probability)}%` : '关闭'}`)].join('\n'),
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
      '调你自己的唤醒规则（这是你能自己决定"什么时候被叫醒"的地方）。',
      '每个条件独立：可以只关掉某个群的闲聊唤醒，同时保留 @我。',
      '改之前先想清楚 —— 关掉 @我 意味着你可能错过别人明确的求助。',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', required: true, description: '作用范围：group:88888 / private:10001，或 * 表示全局默认。' },
      condition: { type: 'string', required: true, enum: [...QQ_WAKE_CONDITIONS], description: '要改的条件（含 pending_backlog —— 离线积压那单独一组）。' },
      enabled: { type: 'boolean', description: '是否启用该条件。' },
      probability: { type: 'integer', description: '唤醒概率 0-100。' },
      daily_limit: { type: 'integer', description: '每天最多唤醒几次（0 = 不限）。' },
      min_interval_ms: { type: 'integer', description: '两次唤醒之间的最小间隔（毫秒，0 = 不限）。' },
      quiet_until: { type: 'string', description: '静默到这个时刻（UTC ISO 时间）之前不唤醒。' },
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
        return text(`已更新 ${v.condition}：${v.enabled ? `启用，${String(v.probability)}%` : '关闭'}${v.note === undefined ? '' : `（${v.note}）`}`)
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
      '设置你自己的在线状态（对外可见，用来表达你的处境：在线/离开/忙碌/自定义文案）。',
      '如果当前是**系统**因为唤不醒你而设置的故障状态，这次设置**不会生效** —— 会明确告诉你原因，',
      '因为把"我暂时无法响应"悄悄改成"在线"会让你看起来正常、实际是坏的。',
    ].join('\n'),
    parameters: {
      state: { type: 'string', required: true, enum: ['online', 'away', 'busy', 'custom'], description: '状态值。' },
      text: { type: 'string', description: '自定义文案（state=custom 时用）。' },
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
        return text(v.ok ? `状态已设为 ${v.state}` : (v.message ?? '状态设置未生效'))
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
      '清除系统设置的故障状态（当你确认问题已经解决时用）。',
      '必须说明原因 —— 这次清除会留痕，运维要能看到"是谁在什么时候认为问题解决了"。',
      '如果你其实没解决问题，不要清：那会让外界以为你好了，而你没有。',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: '为什么认为问题已解决。' },
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
        return text(v.cleared ? '系统故障状态已清除' : (v.note ?? '当前没有系统设置的状态，无需清除'))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string }
      const cleared = runtime.db
        .prepare("SELECT source FROM status_state WHERE id = 1")
        .get() as { source: string } | undefined
      if (cleared?.source !== 'system') {
        return { ok: true, cleared: false, note: '当前不是系统设置的状态（可能本来就正常），无需清除。' }
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
      '**合并转发**：把多条内容打包成一张"聊天记录"卡片发出去（比连刷 N 条消息体面得多，也不容易触发风控）。',
      '',
      '**发**（给 `conversation`）：',
      '- 用 `nodes` 自己组织：[{name?, user_id?, text, image?}, …]，每项是聊天记录里的一条；',
      '- 或用 `message_ids` 原样转发已有消息（**推荐**：图片/语音/表情都能保留，而我们重新打包只能保留文字）。',
      '- ⚠️ 合并转发里**只能**放聊天记录节点 —— 想附带一句说明请单独用 `qq_reply` 发（协议端明确拒绝混合）。',
      '',
      '**收**（给 `read`）：取回一个合并转发的具体内容。',
      '- 一般不需要：别人转给你的聊天记录，网关会自动展开成文字给你；',
      '- 当内容里写着"（内容未能取回）"时，可以用它按 id 重试。',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', description: '发到哪里（会话键，如 onebot11:88888）。发模式必填。' },
      nodes: {
        type: 'array',
        description: '聊天记录里的每一条：{name?, user_id?, text, image?}。与 message_ids 二选一。',
        // ⚠️ `additionalProperties` **必须显式写**：宿主的 JSON Schema 编译器
        // 不接受"没声明 additionalProperties 的对象"（会直接报 UNSUPPORTED_SCHEMA，
        // 而那个错误会让**整个 buildQqTools 抛异常** ⇒ 35 个工具全部注册不上）。
        items: { type: 'object', additionalProperties: true },
      },
      message_ids: { type: 'array', items: { type: 'string' }, description: '原样转发的消息 id 列表。与 nodes 二选一。' },
      read: { type: 'string', description: '收模式：要取回内容的合并转发 id。' },
      summary: { type: 'string', description: '可选：卡片上的摘要文字。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, description: 'send 或 read。' },
          confirmed: { type: 'boolean', description: '发模式：是否收到送达确认。' },
          messageId: { type: 'string', description: '发模式：平台消息 id。' },
          outboxId: { type: 'string', description: '发模式：队列 id。' },
          text: { type: 'string', description: '收模式：摊平后的内容。' },
          nodeCount: { type: 'integer', description: '收模式：还原出几条。' },
          notes: { type: 'array', items: { type: 'string' }, description: '收模式：解析告警（截断/未渲染的段）。' },
          hint: { type: 'string', description: '失败原因或自助提示。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; mode: string; confirmed?: boolean; nodeCount?: number; notes?: string[]; text?: string; hint?: string; messageId?: string }
        if (v.mode === 'read') {
          if (!v.ok) return text(v.hint ?? '取回失败')
          const warn = v.notes === undefined || v.notes.length === 0 ? '' : `\n（注意：${v.notes.join('；')}）`
          return text(`聊天记录内容（${String(v.nodeCount ?? 0)} 条）：\n${v.text ?? ''}${warn}`)
        }
        if (!v.ok) return text(`合并转发没有发出去：${v.hint ?? ''}`)
        return text(v.confirmed === true ? `合并转发已送达（message_id=${v.messageId ?? '未知'}）` : `合并转发已提交但未收到送达确认。${v.hint ?? ''}`)
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
        if (!probed.ok) return { ok: false, mode: 'read', hint: probed.error ?? '取回失败' }
        const data = probed.data as { text?: string; nodeCount?: number; notes?: string[] } | undefined
        return { ok: true, mode: 'read', text: data?.text ?? '', nodeCount: data?.nodeCount ?? 0, notes: data?.notes ?? [] }
      }

      // ── 发 ────────────────────────────────────────────────────────
      if (a.conversation === undefined || a.conversation === '') {
        return { ok: false, mode: 'send', hint: '要么给 conversation（发），要么给 read（收）。两个都没给。' }
      }
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, mode: 'send', hint: target.message }

      const hasNodes = Array.isArray(a.nodes) && a.nodes.length > 0
      const hasIds = Array.isArray(a.message_ids) && a.message_ids.length > 0
      if (hasNodes === hasIds) {
        return { ok: false, mode: 'send', hint: 'nodes 与 message_ids 必须**给且只给一个**（要么自己组织内容，要么原样转发已有消息）。' }
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
      if (gate !== undefined) return { ok: false, mode: 'send', hint: `${gate.hint}（约 ${String(gate.retryAfterMs)}ms 后可以再发）` }

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
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}。队列 id：${outboxId}，可以稍后自查。` }),
      }
    },
  })

  /** ★ 任务③：待处理的好友/群请求（让模型能主动问"有没有人加我"）。 */
  const qqRequests = defineSpillingTool({
    name: 'qq_requests',
    description: [
      '看**待处理**的好友申请与入群请求（已经处理过的不再出现）。',
      '别人加你/邀请你进群时，系统会在通知里告诉你；这个工具是"我想主动查一遍"用的。',
      '⭐ 处理要用 `qq_handle_request`，而它需要 `flag` —— **flag 只能从这里取**（或从通知里抄）。',
      '凭空构造 flag 一定失败：NapCat 里好友申请的 flag 其实是 `reqTime`、群请求是通知的 `seq`。',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', enum: ['friend', 'group'], description: '可选：只看好友申请或只看群请求。' },
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
        if (v.pending === 0) return text('没有待处理的好友/群请求。')
        return text(
          [
            `有 ${String(v.pending)} 条待处理：`,
            ...v.items.map(
              (i) =>
                `- ${i.kind === 'friend' ? '好友申请' : `入群请求（群 ${i.groupId ?? '?'}）`} 来自 ${i.userId}` +
                `${i.comment === '' ? '' : `，附言：「${i.comment}」`}，flag=${i.flag}`,
            ),
            '要用 qq_handle_request 处理时，把上面那串 flag 原样传回去。',
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
      '同意或拒绝一个好友申请 / 入群请求。',
      '',
      '⚠️ **这是有安全含义的动作**：',
      '- 同意好友 = 对方从此**能直接给你发消息**、也会看到你的动态与在线状态；',
      '- 同意入群 = 你会进入那个群的会话范围（群里的消息可能触发你的唤醒）；',
      '- 陌生人、附言看起来像广告/引流的，**默认应该拒绝**；拿不准就先不处理（留着比乱加好）。',
      '',
      '`flag` 必须来自 `qq_requests`（或系统通知）—— 凭空构造一定失败。',
      `**有速率限制**：每小时最多处理 ${String(defaultFor<number>('qq.requests.handlePerHourMax'))} 个请求（防被"疯狂发申请"刷）。`,
      '处理结果会留痕（谁在什么时候同意了谁），所以 `reason` 请写清楚。',
    ].join('\n'),
    parameters: {
      flag: { type: 'string', required: true, description: '请求的 flag（从 qq_requests 取）。' },
      kind: { type: 'string', required: true, enum: ['friend', 'group'], description: '这是好友申请还是群请求。' },
      approve: { type: 'boolean', required: true, description: 'true = 同意，false = 拒绝。' },
      reason: { type: 'string', description: '同意时的备注 / 拒绝时的理由（会留痕）。' },
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
        if (v.throttled === true) return text(`**没有处理**（被速率限制拦下）：${v.hint ?? ''}`)
        if (!v.ok) return text(`处理失败：${v.hint ?? '未知原因'}`)
        return text(v.confirmed ? '已处理（协议端确认）' : `已提交但未收到确认。${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { flag: string; kind: 'friend' | 'group'; approve: boolean; reason?: string }
      runtime.recordToolCall()
      if (a.flag.trim() === '') return { ok: false, confirmed: false, hint: 'flag 不能为空 —— 它必须来自 qq_requests。' }

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
          hint: `最近一小时已经处理了 ${String(used)} 个请求（上限 ${String(perHourMax)}，基线 qq.requests.handlePerHourMax）。等一会儿再处理，或先只处理最要紧的。`,
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
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}（可能原因：flag 已失效 / 该请求已被别人处理 / QQ 端未连接）` }),
      }
    },
  })

  /** ★ 任务③：列表查询（好友 / 群 / 群成员）。 */
  const qqContacts = defineSpillingTool({
    name: 'qq_contacts',
    description: [
      '查你的联系人：好友列表、群列表、某个群的成员列表。',
      '用途：判断"这个人我认识吗"、"我在哪些群里"、"这个群里都有谁"。',
      '⭐ 想看**谁在申请加你**用 `qq_requests`（那是待处理请求，不是已通过的联系人）。',
      '⚠️ 群成员列表可能很长（大群几百人），返回值受 `limit` 限制并会告诉你被截断了。',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, enum: ['friends', 'groups', 'members'], description: '查什么：好友 / 群 / 群成员。' },
      group_id: { type: 'string', description: 'kind=members 时必填：查哪个群。' },
      query: { type: 'string', description: '可选：按昵称/备注/群名过滤（不区分大小写的子串匹配）。' },
      limit: { type: 'integer', description: `最多返回多少条（默认 ${String(defaultFor<number>('qq.contacts.listMaxItems'))}）。` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true, description: '过滤后一共有多少条（可能大于 count）。' },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          hint: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; kind: string; count: number; total: number; items: Record<string, unknown>[]; hint?: string }
        if (!v.ok) return text(v.hint ?? '查询失败')
        if (v.total === 0) return text('没有匹配的条目。')
        const label = v.kind === 'friends' ? '好友' : v.kind === 'groups' ? '群' : '群成员'
        const lines = v.items.map((item) => `- ${String(item['label'] ?? '')}`)
        const tail = v.total > v.count ? `\n（共 ${String(v.total)} 条，只列了前 ${String(v.count)} 条 —— 用 query 过滤或调大 limit）` : ''
        return text([`${label} ${String(v.total)} 条：`, ...lines].join('\n') + tail)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { kind: 'friends' | 'groups' | 'members'; group_id?: string; query?: string; limit?: number }
      runtime.recordToolCall()
      const limit = a.limit ?? defaultFor<number>('qq.contacts.listMaxItems')
      if (a.kind === 'members' && (a.group_id === undefined || a.group_id === '')) {
        return { ok: false, kind: a.kind, count: 0, total: 0, items: [], hint: 'kind=members 时必须给 group_id。' }
      }
      const action: ProbeAction = a.kind === 'friends' ? 'get_friend_list' : a.kind === 'groups' ? 'get_group_list' : 'get_group_member_list'
      const probed = await runProbe(action, a.kind === 'members' ? { group_id: a.group_id } : {})
      if (!probed.ok) return { ok: false, kind: a.kind, count: 0, total: 0, items: [], hint: probed.error ?? '查询失败' }

      const needle = (a.query ?? '').trim().toLowerCase()
      const all: { label: string }[] = []
      if (a.kind === 'friends') {
        for (const f of (probed.data ?? []) as { userId: string; nickname: string; remark?: string }[]) {
          all.push({ label: `${f.userId} ${f.remark === undefined ? f.nickname : `${f.remark}（${f.nickname}）`}` })
        }
      } else if (a.kind === 'groups') {
        for (const g of (probed.data ?? []) as { groupId: string; groupName: string; memberCount?: number }[]) {
          all.push({ label: `${g.groupId} ${g.groupName}${g.memberCount === undefined ? '' : `（${String(g.memberCount)} 人）`}` })
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
      '给指定的 QQ 会话**发一张图片**。',
      '`file` 可以是：**http(s) 图片直链**（推荐）、`base64://…`、或协议端本地路径。',
      '⚠️ 本地路径指的是**协议端（NapCat 容器）里**的路径 —— 你写的文件它看不到，所以优先用 URL。',
      '图片会**被下载**：大文件会慢，必要时先确认链接可用。',
      `**有发送速率限制**：与发消息共用同一套额度（每分钟 ${String(defaultFor<number>('qq.send.perMinuteMax'))} 条、` +
        `${String(defaultFor<number>('qq.send.burstWindowMs') / 1000)} 秒内 ${String(defaultFor<number>('qq.send.burstMax'))} 条）。`,
      '发图片**不能**顺带带文字：把说明单独用 `qq_reply` 发（协议端一次只认一条消息里的段序列，但要保证顺序正确更省事）。',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键，如 onebot11:88888（群）或 onebot11:10001（私聊）。' },
      file: { type: 'string', required: true, description: '图片地址（http/https URL，推荐）或 base64://… 或协议端本地路径。' },
      summary: { type: 'string', description: '可选：图片摘要（部分客户端会显示）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true, description: '是否收到送达确认。' },
          outboxId: { type: 'string', required: true, description: '队列 id（可用于自查）。' },
          messageId: { type: 'string', description: '平台消息 id（确认后才有）。' },
          throttled: { type: 'boolean', description: '被发送速率限制拦下（图片没有入队）。' },
          hint: { type: 'string', description: '未确认或被限流时的自助提示。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; throttled?: boolean; hint?: string; messageId?: string }
        if (v.throttled === true) return text(`**图片没有发出去（被速率限制拦下）**：${v.hint ?? ''}`)
        return text(v.confirmed ? `图片已送达（message_id=${v.messageId ?? '未知'}）` : `图片已提交但未收到送达确认。${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; file: string; summary?: string }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }
      if (a.file.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'file 不能为空（给 URL 或 base64://…）。' }
      // 发送类动作 ⇒ 与 qq_reply 走**同一个**入队前速率闸门（不另开一条绕过它的路）
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint}（约 ${String(gate.retryAfterMs)}ms 后可以再发）` }
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
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}。队列 id：${outboxId}，可以稍后自查。` }),
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
      '给指定的 QQ 会话**发一个文件**（群聊会作为群文件上传）。',
      '`file` 可以是：**http(s) 直链**（推荐）、`base64://…`、或协议端本地路径。',
      '`name` 是收件人看到的文件名（不给就用 URL 里的名字）。',
      '⚠️ 大文件会**先上传再发送**，可能很慢（几分钟）。发送前想清楚是不是非发不可。',
      `**有发送速率限制**：与发消息共用同一套额度（每分钟 ${String(defaultFor<number>('qq.send.perMinuteMax'))} 条）。`,
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键，如 onebot11:88888（群）或 onebot11:10001（私聊）。' },
      file: { type: 'string', required: true, description: '文件地址（http/https URL，推荐）或 base64://… 或协议端本地路径。' },
      name: { type: 'string', description: '可选：收件人看到的文件名。' },
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
        if (v.throttled === true) return text(`**文件没有发出去（被速率限制拦下）**：${v.hint ?? ''}`)
        return text(v.confirmed ? `文件已发送（message_id=${v.messageId ?? '未知'}）` : `文件已提交但未收到送达确认（大文件上传可能仍在进行）。${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; file: string; name?: string }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }
      if (a.file.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'file 不能为空（给 URL 或 base64://…）。' }
      const gate = sendGate()
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint}（约 ${String(gate.retryAfterMs)}ms 后可以再发）` }
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
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}。队列 id：${outboxId}，可以稍后自查。` }),
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
      '**撤回**一条消息。',
      '⚠️ QQ 的规则（不是我们的限制）：机器人一般只能撤回**自己发的**消息，且通常在**两分钟内**；' +
        '群里管理员可以撤回别人的。超时或没权限时协议端会明确报错 —— 那时不要反复重试。',
      '`message_id` 必须是**平台的真实消息 id**（发消息的返回值里有，或从入站消息里拿）。',
      `**有发送速率限制**：与发消息共用同一套额度（每分钟 ${String(defaultFor<number>('qq.send.perMinuteMax'))} 条）。`,
      '撤回是**不可逆**的：想清楚再调，别用它来"清理痕迹"。',
    ].join('\n'),
    parameters: {
      message_id: { type: 'string', required: true, description: '要撤回的消息 id。' },
      conversation: { type: 'string', description: '可选：这条消息所在的会话键（只用于记账，撤回按 message_id 生效）。' },
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
        if (v.throttled === true) return text(`**没有撤回**（被速率限制拦下）：${v.hint ?? ''}`)
        return text(v.confirmed ? '已撤回' : `撤回已提交但未收到确认。${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { message_id: string; conversation?: string }
      runtime.recordToolCall()
      if (a.message_id.trim() === '') return { ok: false, confirmed: false, outboxId: '', hint: 'message_id 不能为空。' }
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
      if (gate !== undefined) return { ok: false, confirmed: false, outboxId: '', throttled: true, hint: `${gate.hint}（约 ${String(gate.retryAfterMs)}ms 后可以再试）` }
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
        ...(result.confirmed ? {} : { hint: `${result.error ?? ''}（可能原因：超过两分钟 / 不是自己发的 / 消息 id 不对）` }),
      }
    },
  })

  return [qqReply, qqReact, qqTyping, qqSendImage, qqSendFile, qqRecall, qqForward, qqRequests, qqHandleRequest, qqContacts, deferTurn, readPendingTool, listWakeRulesTool, setWakeRuleTool, setStatusTool, clearSystemStatusTool, ...buildStickerTools(defineTool, runtime), ...buildMentionTools(defineTool, runtime)]
}

