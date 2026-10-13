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

import { buildStickerSaveTool, STICKER_SAVE_TOOL_NAME } from './sticker-save-tool.ts'
import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名（测试与文档共用一份）。 */
export const STICKER_TOOL_NAMES = ['sticker_search', 'qq_send_sticker', 'sticker_import', STICKER_SAVE_TOOL_NAME] as const

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
      'Find stickers in the library by natural-language description; returns candidates with match scores (including their descriptions, so you can pick by reading them).' +
      'If nothing matches, the library has nothing suitable - try different wording, or just reply with text.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language description, e.g. "a cat sleeping", "speechless", "thumbs up".' },
      limit: { type: 'number', description: 'How many results to return; defaults to 5.' },
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
        if (v.count === 0) return text('No sticker in the library matches.')
        return text(
          v.hits
            .map((hit, index) => `${String(index + 1)}. ${hit.description} (match ${hit.score.toFixed(2)}${hit.ours ? '' : ', learned, not sent by default'})`)
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
          description: hit.description === '' ? '(no description yet)' : hit.description,
          score: Number(hit.score.toFixed(3)),
          ours: hit.asset.ours === 1,
        })),
      }
    },
  })

  const sendSticker = defineTool({
    name: 'qq_send_sticker',
    description:
      'Send a sticker to a conversation. Passing asset_id (get it from sticker_search first) is the most precise; you may also pass only query and the system picks the best match.' +
      'Note: "learned" stickers (sent by others, not collected by us) are not sent by default unless they really fit.',
    parameters: {
      conversation: { type: 'string', required: true, description: 'Target conversation key, e.g. onebot11:88888.' },
      asset_id: { type: 'string', description: 'Sticker id (returned by sticker_search).' },
      query: { type: 'string', description: 'Natural-language description (used to pick when asset_id is omitted).' },
      reply_to: { type: 'string', description: 'Message id to reply to (optional).' },
      allow_learned: { type: 'boolean', description: 'Whether learned stickers may be sent; defaults to no.' },
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
        return text(v.ok ? `Sticker queued for sending. ${v.message}` : `send failed: ${v.message}`)
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

  const importSticker = defineTool({
    name: 'sticker_import',
    description:
      'Import a web image into the sticker library (download + source check + description), returning an assetId you can then send with qq_send_sticker.' +
      'You have search tools: use them to find the image URL first, then call this tool - do not fetch it yourself, because the source whitelist, type/size checks and deduplication all live on this side.',
    parameters: {
      url: { type: 'string', required: true, description: 'Direct image URL (http/https).' },
      conversation: { type: 'string', description: 'Also record which conversation it appeared in (optional).' },
      allow_learned: { type: 'boolean', description: 'Whether to mark it as ours (default yes; learned ones are not forwarded on their own).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          assetId: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.ok ? `Imported into the sticker library: ${v.message}` : `import failed: ${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { url: string; conversation?: string; allow_learned?: boolean }
      runtime.recordToolCall()
      const result = await stickers().importFromUrl({
        url: a.url,
        ...(a.conversation === undefined ? {} : { scope: a.conversation }),
        ...(a.allow_learned === false ? { ours: false } : {}),
      })
      return { ok: result.status !== 'rejected', message: result.reason, assetId: result.assetId ?? '' }
    },
  })

  return [stickerSearch, sendSticker, importSticker, buildStickerSaveTool(defineTool, runtime)]
}
