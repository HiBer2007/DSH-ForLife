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
  enqueueOutbound,
  listWakeRules,
  parseConversationKey,
  readPending,
  setModelStatus,
  setWakeRule,
  WAKE_CONDITIONS,
  waitForConfirmation,
  type OutboundSegment,
  type WakeCondition,
} from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import { buildMentionTools, MENTION_TOOL_NAMES } from './mention-tools.ts'
import { buildStickerTools, STICKER_TOOL_NAMES } from './sticker-tools.ts'
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

  const qqReply = defineTool({
    name: 'qq_reply',
    description: [
      '给指定的 QQ 会话发消息。可以多次调用实现分段回复（每次调用是一条独立消息，顺序即调用顺序）。',
      '**必须指定 conversation** —— 你可能同时在处理多个会话，猜错目标在群里是灾难性的。',
      `发送后会等 ${String(confirmTimeoutMs)}ms 的送达确认：确认到就返回 messageId；没确认到会明确告诉你"已提交但未确认"，你可以稍后自查或重发。`,
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
          hint: { type: 'string', description: '未确认时的自助提示。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { confirmed: boolean; messageId?: string; hint?: string }
        if (v.confirmed) return text(`已送达（message_id=${v.messageId ?? '未知'}）`)
        return text(`已提交但未收到送达确认。${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; text: string; reply_to?: string; at?: string[] }
      runtime.recordToolCall()
      const target = parseTarget(a.conversation)
      if (!target.ok) return { ok: false, confirmed: false, outboxId: '', hint: target.message }

      const segments: OutboundSegment[] = []
      if (a.reply_to !== undefined && a.reply_to !== '') segments.push({ kind: 'reply', messageId: a.reply_to })
      for (const userId of a.at ?? []) segments.push({ kind: 'at', userId })
      segments.push({ kind: 'text', text: a.text })

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

  const qqReact = defineTool({
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

  const qqTyping = defineTool({
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

  const deferTurn = defineTool({
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

  const readPendingTool = defineTool({
    name: 'read_pending',
    description: [
      '主动读"你被唤醒期间错过、但没吵醒你"的消息摘要（群里没人 @ 你的闲聊就在那里）。',
      '读过的会被标记已读，不会重复出现。想了解某个群/某个人最近在聊什么时用它。',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', description: '可选：只看某个范围，如 group:88888 或 private:10001。' },
      limit: { type: 'integer', description: '最多读多少条（默认 20）。' },
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
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { count: number; items: { conversation: string; sender?: string; summary: string }[] }
        if (v.count === 0) return text('没有未读的待读消息。')
        return text(
          [`共 ${String(v.count)} 条未读：`, ...v.items.map((i) => `- [${i.conversation}] ${i.sender ?? ''}：${i.summary}`)].join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { scope?: string; limit?: number }
      const items = readPending(runtime.db, { ...(a.scope === undefined ? {} : { scope: a.scope }), ...(a.limit === undefined ? {} : { limit: a.limit }) })
      return {
        ok: true,
        count: items.length,
        items: items.map((i) => ({
          conversation: i.conversationKey,
          sender: i.senderName ?? '',
          summary: i.summary,
          at: i.at,
        })),
      }
    },
  })

  const listWakeRulesTool = defineTool({
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
      return {
        ok: true,
        scope,
        rules: rules.map((r) => ({
          condition: r.condition,
          enabled: r.enabled,
          probability: r.probability,
          dailyLimit: r.dailyLimit,
          minIntervalMs: r.minIntervalMs,
          updatedBy: r.updatedBy,
        })),
      }
    },
  })

  const setWakeRuleTool = defineTool({
    name: 'set_wake_rule',
    description: [
      '调你自己的唤醒规则（这是你能自己决定"什么时候被叫醒"的地方）。',
      '每个条件独立：可以只关掉某个群的闲聊唤醒，同时保留 @我。',
      '改之前先想清楚 —— 关掉 @我 意味着你可能错过别人明确的求助。',
    ].join('\n'),
    parameters: {
      scope: { type: 'string', required: true, description: '作用范围：group:88888 / private:10001，或 * 表示全局默认。' },
      condition: { type: 'string', required: true, enum: [...WAKE_CONDITIONS], description: '要改的条件。' },
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
        condition: WakeCondition
        enabled?: boolean
        probability?: number
        daily_limit?: number
        min_interval_ms?: number
        quiet_until?: string
      }
      const rule = setWakeRule(
        runtime.db,
        a.scope,
        a.condition,
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

  const setStatusTool = defineTool({
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

  const clearSystemStatusTool = defineTool({
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

  return [qqReply, qqReact, qqTyping, deferTurn, readPendingTool, listWakeRulesTool, setWakeRuleTool, setStatusTool, clearSystemStatusTool, ...buildStickerTools(defineTool, runtime), ...buildMentionTools(defineTool, runtime)]
}

