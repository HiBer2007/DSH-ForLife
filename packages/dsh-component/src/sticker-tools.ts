/**
 * 表情库的模型侧工具（PLAN 阶段六）。
 *
 * ## 为什么单独一个文件，而不是塞进 `qq-tools.ts`
 *
 * 那个文件已经 500 多行、装着会话/唤醒/状态三类工具。表情是**第四类**，
 * 而且它自己带着一套依赖（存储层、视觉描述器、检索）。
 * 混进去会让那个文件继续膨胀，也会让"表情这块坏了"这件事淹没在别的问题里。
 *
 * ## 两个工具的分工
 *
 * - `sticker_search`：**只读**，把候选连**描述原文**一起给模型。
 *   只给 id 等于让它盲选 —— 它必须"看见"这张图是什么才能挑对。
 * - `qq_send_sticker`：给 `asset_id` 或 `query` 都能发（query 时取最匹配的一个）。
 *
 * ## 服务是惰性创建的
 *
 * 没配视觉描述器时它照样能用（检索靠标签与已有描述），所以创建本身不会失败，
 * 不需要 try/catch 包起来 —— 少一层嵌套，排障时也少一层要剥的壳。
 *
 * @module forlife-memory/sticker-tools
 */
import { dirname, join } from 'node:path'

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createStickerService, createStickerVisionDescriber, visionConfigFromEnv, type StickerService } from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名（测试与文档共用一份）。 */
export const STICKER_TOOL_NAMES = ['sticker_search', 'qq_send_sticker'] as const

/** 把文本包成内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * 构造表情工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时（提供数据库句柄与路径）。
 * @returns 工具定义数组。
 */
export function buildStickerTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  // 表情文件与库放一起：<库目录>/stickers
  const storageRoot = join(dirname(runtime.dbPath), 'stickers')

  let service: StickerService | undefined
  const stickers = (): StickerService => {
    if (service === undefined) {
      const vision = visionConfigFromEnv()
      service = createStickerService({
        db: runtime.db,
        storageRoot,
        ...(vision === undefined ? {} : { describer: createStickerVisionDescriber(vision) }),
      })
    }
    return service
  }

  const stickerSearch = defineTool({
    name: 'sticker_search',
    description:
      '按自然语言查找表情库里的表情，返回候选与匹配分数（含描述原文，你要看着描述挑）。' +
      '如果一条都没找到，说明库里没有合适的 —— 可以换个说法再试，或直接回文字。',
    parameters: {
      query: { type: 'string', required: true, description: '自然语言描述，例如「猫在睡觉」「无语」「点赞」。' },
      limit: { type: 'number', required: false, description: '返回条数，默认 5。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                assetId: { type: 'string', required: true },
                description: { type: 'string', required: true },
                score: { type: 'number', required: true },
                ours: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { count: number; hits: { description: string; score: number; ours: boolean }[] }
        if (v.count === 0) return text('表情库里没有匹配的表情。')
        return text(
          v.hits
            .map((hit, index) => `${String(index + 1)}. ${hit.description}（匹配 ${hit.score.toFixed(2)}${hit.ours ? '' : '，学来的，默认不发'}）`)
            .join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { query: string; limit?: number }
      runtime.recordToolCall()
      const hits = stickers().find(a.query, { limit: a.limit ?? 5 })
      return {
        count: hits.length,
        hits: hits.map((hit) => ({
          assetId: hit.asset.id,
          description: hit.description === '' ? '（这张还没有描述）' : hit.description,
          score: Number(hit.score.toFixed(3)),
          ours: hit.asset.ours === 1,
        })),
      }
    },
  })

  const sendSticker = defineTool({
    name: 'qq_send_sticker',
    description:
      '发一个表情到指定会话。给 asset_id（先用 sticker_search 拿到）最准；也可以只给 query，系统会挑最匹配的一个。' +
      '注意：「学来的」表情（别人发的、不是我们收藏的）默认不发，除非确实合适。',
    parameters: {
      conversation: { type: 'string', required: true, description: '目标会话键，如 onebot11:88888。' },
      asset_id: { type: 'string', required: false, description: '表情 id（sticker_search 的返回里有）。' },
      query: { type: 'string', required: false, description: '自然语言描述（不给 asset_id 时用它挑）。' },
      reply_to: { type: 'string', required: false, description: '要回复的消息 id（可选）。' },
      allow_learned: { type: 'boolean', required: false, description: '是否允许发「学来的」表情，默认否。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          assetId: { type: 'string', required: true },
          outboxId: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.ok ? `表情已交给发送队列。${v.message}` : `没能发送：${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as {
        conversation: string
        asset_id?: string
        query?: string
        reply_to?: string
        allow_learned?: boolean
      }
      runtime.recordToolCall()

      const session = runtime.db.prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?').get(a.conversation) as
        | { kind: string }
        | undefined
      const kind = session?.kind === 'group' ? 'group' : 'private'

      const result = stickers().send({
        to: a.conversation,
        ...(a.asset_id === undefined ? {} : { assetId: a.asset_id }),
        ...(a.query === undefined ? {} : { query: a.query }),
        ...(a.reply_to === undefined ? {} : { replyTo: a.reply_to }),
        conversationKind: kind,
        ...(a.allow_learned === true ? { allowLearned: true } : {}),
      })

      return {
        ok: result.ok,
        message: result.reason,
        assetId: result.assetId ?? '',
        outboxId: result.outboundId ?? '',
      }
    },
  })

  return [stickerSearch, sendSticker]
}
