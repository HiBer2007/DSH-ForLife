/**
 * @全体 与 群公告 —— **两个独立工具**（用户 2026-10-06 明确要求）。
 *
 * ## 为什么必须分开，而不是一个工具加个 flag
 *
 * 用户原话：「两者是独立工具；`group_notice` **不受 @全体额度影响**；
 * 模型能在同一轮里**自主选择**用哪个。」
 *
 * 合并成一个工具的坏处是具体的：
 *  - 额度检查会**顺手也挡掉群公告** —— 群公告有自己的配额，
 *    拿 @全体 的额度去挡它，会让"想发个公告"莫名其妙失败；
 *  - 模型看到的是一个带 `is_notice` 开关的工具，**它得先理解那个开关的含义**才知道
 *    自己还有另一条路。分成两个工具后，工具列表本身就是"你有两种办法"的提示。
 *
 * ## 额度闸门不在这一层
 *
 * 闸门在**出站消费者**里（transport 只在那里可见，而且 `mentionAll()` 的注释
 * 明确写着「额度由调用方保证」）。工具这边只负责**如实入队**，
 * 被拦下时会在出站记录里留下"额度闸门拦截：…"的原因。
 *
 * @module forlife-memory/mention-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { enqueueOutbound } from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名（测试与文档共用一份）。 */
export const MENTION_TOOL_NAMES = ['qq_mention_all', 'qq_group_notice'] as const

/** 把文本包成内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * 构造 @全体 与群公告工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时。
 * @returns 工具定义数组。
 */
export function buildMentionTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  /** 解析群会话键（两个工具都只对群有意义）。 */
  const parseGroup = (conversation: string): { ok: true; chatId: string } | { ok: false; message: string } => {
    const row = runtime.db.prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?').get(conversation) as
      | { kind: string }
      | undefined
    if (row?.kind !== 'group') {
      return { ok: false, message: `${conversation} 不是群会话（@全体 与群公告只在群里有意义）` }
    }
    const chatId = conversation.split(':')[1] ?? ''
    if (chatId === '') return { ok: false, message: `会话键里取不到群号：${conversation}` }
    return { ok: true, chatId }
  }

  const mentionAllTool = defineTool({
    name: 'qq_mention_all',
    description:
      '在群里 @全体成员。**很打扰人**，只在确实需要所有人都看到时用（如紧急通知）。' +
      '额度有限且用完会失败；只是想公告一件事的话，用 qq_group_notice 更合适（它不受这个额度限制）。',
    parameters: {
      conversation: { type: 'string', required: true, description: '群会话键，如 onebot11:88888。' },
      text: { type: 'string', required: true, description: '要发的内容。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          outboxId: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.ok ? '已交给发送队列（额度闸门会在发送前再确认一次）。' : `没能发送：${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; text: string }
      runtime.recordToolCall()
      const target = parseGroup(a.conversation)
      if (!target.ok) return { ok: false, message: target.message, outboxId: '' }

      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: a.conversation,
        conversationKind: 'group',
        kind: 'mention_all',
        payload: { segments: [{ kind: 'text', text: a.text }] },
        source: 'model',
      })
      return { ok: true, message: '已入队', outboxId }
    },
  })

  const groupNoticeTool = defineTool({
    name: 'qq_group_notice',
    description:
      '发一条**群公告**（会出现在群公告栏，比 @全体 温和，不打扰每个人）。' +
      '**不受 @全体 额度限制**，也不消耗那个额度。想让大家知道一件事时，优先用它。',
    parameters: {
      conversation: { type: 'string', required: true, description: '群会话键，如 onebot11:88888。' },
      text: { type: 'string', required: true, description: '公告内容。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          outboxId: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.ok ? '群公告已交给发送队列。' : `没能发送：${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; text: string }
      runtime.recordToolCall()
      const target = parseGroup(a.conversation)
      if (!target.ok) return { ok: false, message: target.message, outboxId: '' }

      // 刻意**不做任何 @全体 额度检查** —— 群公告有自己的配额，
      // 拿 @全体 的额度挡它会让"想发个公告"莫名其妙失败。
      const outboxId = enqueueOutbound(runtime.db, {
        conversationKey: a.conversation,
        conversationKind: 'group',
        kind: 'notice',
        payload: { content: a.text },
        source: 'model',
      })
      return { ok: true, message: '已入队', outboxId }
    },
  })

  return [mentionAllTool, groupNoticeTool]
}
