/**
 * 「把喜欢的图片存为表情包」（用户明确指出的**主要来源**）。
 *
 * ## 为什么单列一个工具，而不是复用 sticker_import
 *
 * 两者的**意图不同**，因此默认值也不同：
 *  - `sticker_import(url)`：模型自己搜来的图 ⇒ 默认也是"我们的"（它主动选的）
 *  - `sticker_save(message_id)`：**用户或模型在某条消息里看中的图** ⇒ 语义是"收藏这张"
 *
 * 后者要处理一件前者没有的事：**从消息里把图片 URL 挖出来**。
 * QQ 的消息段结构有多个变体（`url` / `file` / 不同字段名），挖错的表现是
 * "工具说存好了但库里没有图"，所以这里把挖掘逻辑写得宽松且**失败时明确报错**。
 *
 * ## 白名单照样生效
 *
 * 存的是别人发的图，所以来源是 QQ 的 CDN —— 它在默认白名单里。
 * 如果哪天 QQ 换了域名，这个工具会**明确拒绝并说明**，而不是悄悄失败。
 *
 * @module forlife-memory/sticker-save-tool
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createStickerService, createStickerVisionDescriber, visionConfigFromEnv, type StickerService } from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名。 */
export const STICKER_SAVE_TOOL_NAME = 'sticker_save'

/** 把文本包成内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 从消息的原始 payload 里挖出第一个图片 URL。 */
export function extractImageUrl(payload: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown): string | undefined => {
    if (node === null || typeof node !== 'object') return undefined
    if (seen.has(node)) return undefined
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item)
        if (found !== undefined) return found
      }
      return undefined
    }

    const record = node as Record<string, unknown>
    // 形状一：{ type: 'image', data: { url | file } }
    if (record['type'] === 'image') {
      const data = record['data']
      if (data !== null && typeof data === 'object') {
        const inner = data as Record<string, unknown>
        const candidate = inner['url'] ?? inner['file']
        if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate
      }
    }
    // 形状二：直接给了 image/url 字段
    for (const key of ['image', 'imageUrl', 'image_url', 'url', 'file']) {
      const value = record[key]
      if (typeof value === 'string' && /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(value)) return value
    }
    // 递归
    for (const value of Object.values(record)) {
      const found = walk(value)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(payload)
}

/**
 * 构造「存为表情包」工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时。
 * @returns 工具定义。
 */
export function buildStickerSaveTool(defineTool: DefineToolLike, runtime: MemoryRuntime): unknown {
  let service: StickerService | undefined
  const stickers = (): StickerService => {
    if (service === undefined) {
      const vision = visionConfigFromEnv()
      service = createStickerService({
        db: runtime.db,
        storageRoot: joinStickerRoot(runtime),
        ...(vision === undefined ? {} : { describer: createStickerVisionDescriber(vision) }),
      })
    }
    return service
  }

  return defineTool({
    name: STICKER_SAVE_TOOL_NAME,
    description:
      '把某条消息里的图片存为表情包（"收藏这张"）。这是表情库最主要的来源之一。' +
      '给 message_id（入站消息 id）或直接给图片 url。存好后可以用 qq_send_sticker 发出去。',
    parameters: {
      message_id: { type: 'string', description: '要收藏的消息 id（与 url 二选一）。' },
      url: { type: 'string', description: '图片直链（与 message_id 二选一）。' },
      note: { type: 'string', description: '为什么收藏它（可选，便于日后检索）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          assetId: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string; description: string }
        if (!v.ok) return text(`没能收藏：${v.message}`)
        return text(`已收藏为表情包。${v.description === '' ? '' : `它的样子：${v.description}`}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { message_id?: string; url?: string; note?: string }
      runtime.recordToolCall()

      let url = a.url
      if (url === undefined && a.message_id !== undefined) {
        const row = runtime.db.prepare('SELECT payload FROM qq_inbox WHERE id = ?').get(a.message_id) as
          | { payload: string }
          | undefined
        if (row === undefined) {
          return { ok: false, message: `库里没有这条消息：${a.message_id}`, assetId: '', description: '' }
        }
        try {
          url = extractImageUrl(JSON.parse(row.payload))
        } catch {
          url = undefined
        }
        if (url === undefined) {
          // 明确报"没找到图"，而不是让调用方以为存成功了
          return { ok: false, message: '这条消息里没有找到图片链接（可能是纯文本，或图片字段结构与预期不同）', assetId: '', description: '' }
        }
      }
      if (url === undefined) {
        return { ok: false, message: '必须给 message_id 或 url 之一', assetId: '', description: '' }
      }

      const result = await stickers().importFromUrl({ url, ours: true })
      return {
        ok: result.status !== 'rejected',
        message: a.note === undefined ? result.reason : `${result.reason}（备注：${a.note}）`,
        assetId: result.assetId ?? '',
        description: result.description ?? '',
      }
    },
  })
}

/** 表情目录（与 sticker-tools 保持一致：<库目录>/stickers）。 */
function joinStickerRoot(runtime: MemoryRuntime): string {
  const dbPath = runtime.dbPath
  const cut = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'))
  return `${cut === -1 ? '.' : dbPath.slice(0, cut)}${require_sep()}stickers`
}

/** 路径分隔符（Windows 与 POSIX 都取库路径里出现过的那个）。 */
function require_sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}
