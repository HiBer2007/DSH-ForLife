/**
 * 用视觉模型给表情/图片生成描述 —— 供 `describeStickerOnce` 调用。
 *
 * ## 为什么请求构造与响应解析要单独拆出来、并单独测试
 *
 * 这两处是**实践中真正会坏的地方**，而且坏起来很难查：
 *
 * - **请求构造**：图片要以 data URI 塞进 `image_url`，MIME 写错、base64 前缀漏掉
 *   `data:` 头、或者把 base64 当成普通文本 —— 服务端要么 400、要么把 base64 当文字描述一遍，
 *   **后者不会报错**，只是描述变成一堆乱码。
 * - **响应解析**：不同 provider 的 `content` 可能是字符串、也可能是分段数组；
 *   模型还可能把 JSON 包在 ```json 代码块里、或者在 JSON 前后加一句废话。
 *   解析失败的表现是"描述是空的"，而不是异常 —— 于是库里留下一堆空描述。
 *
 * 所以这里把两者做成**纯函数**（不发网络请求），可以离线把各种脏输入钉死。
 *
 * ## fail-closed
 *
 * 没配置视觉模型时**抛错**，而不是返回一句编造的描述。
 * 表情库的价值全在描述上，编造描述比没有描述更糟（检索会命中错的东西）。
 *
 * @module @forlife/gateway/sticker-vision
 */
import type { DatabaseSync } from 'node:sqlite'

/** 描述结果。 */
export interface StickerVisionResult {
  readonly description: string
  readonly emotionTags: readonly string[]
  readonly model: string
  readonly tokenCount: number
}

/** 注入的 fetch（测试用）。 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

/** 给模型的指令。要求 JSON 输出，并**明确禁止**编造画面里没有的东西。 */
export const STICKER_VISION_PROMPT = [
  '请描述这张图片，用于建立一个可检索的表情库。',
  '要求：',
  '1. 用一句中文说清画面里**实际有**的东西（主体、动作、配文）。',
  '2. 只描述你确实看到的，不要推测情绪之外的信息，不要编造。',
  '3. 再给 2–5 个中文情绪/用途标签。',
  '只输出 JSON，形如 {"description":"…","tags":["…"]}，不要输出其它内容。',
].join('\n')

/** 构造 OpenAI 兼容的视觉请求体（纯函数，便于测试）。 */
export function buildStickerVisionRequest(input: {
  readonly model: string
  readonly imageBase64: string
  readonly mime: string
  readonly maxTokens?: number
}): Record<string, unknown> {
  // MIME 可能是 "image/png; charset=binary"，data URI 里不能带参数
  const mime = input.mime.split(';')[0]?.trim().toLowerCase() ?? 'image/png'
  return {
    model: input.model,
        // 默认给足预算：这个模型是**推理模型**，max_tokens 给小了会把预算全花在 reasoning 上，
    // 正文返回**空字符串**（HTTP 仍是 200，不是报错）。300 时实测必空，2000 才稳。
    max_tokens: input.maxTokens ?? 2000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: STICKER_VISION_PROMPT },
          // 必须是 data URI：直接塞 base64 会被当成文本
          { type: 'image_url', image_url: { url: `data:${mime};base64,${input.imageBase64}` } },
        ],
      },
    ],
  }
}

/** 把 `content` 归一成字符串（兼容字符串 / 分段数组两种形态）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  return ''
}

/** 从一段文本里挖出第一个 JSON 对象（容忍 ```json 代码块与前后废话）。 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 试下一个候选
    }
  }
  return undefined
}

/** 解析标签数组（兼容 `tags` / `emotion_tags` / 字符串）。 */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((t) => t.trim())
  if (typeof raw === 'string') {
    return raw
      .split(/[，,、\s]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }
  return []
}

/**
 * 解析视觉模型的响应。
 *
 * 三种情况都要能活：标准 JSON、被代码块包住的 JSON、以及**模型只回了一句人话**
 * （那时把整句话当描述、标签留空 —— 有描述总比丢掉整次调用好）。
 */
export function parseStickerVisionResponse(payload: unknown): { description: string; emotionTags: string[] } {
  const root = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const choices = Array.isArray(root['choices']) ? root['choices'] : []
  const first = choices[0] !== undefined && choices[0] !== null && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : {}
  const message = first['message'] !== undefined && first['message'] !== null && typeof first['message'] === 'object' ? (first['message'] as Record<string, unknown>) : {}
  const text = contentToText(message['content']).trim()

  if (text === '') return { description: '', emotionTags: [] }

  const json = extractJsonObject(text)
  if (json !== undefined) {
    const description = typeof json['description'] === 'string' ? json['description'].trim() : ''
    const tags = parseTags(json['tags'] ?? json['emotion_tags'] ?? json['emotionTags'])
    if (description !== '') return { description, emotionTags: tags }
    // JSON 里没有 description ⇒ 退回到"把整段文本当描述"
    return { description: text, emotionTags: tags }
  }

  return { description: text, emotionTags: [] }
}

/** 视觉描述器配置。 */
export interface StickerVisionOptions {
  /** 视觉模型 id（如 `deepseek-v4-flash-vision-exp`）。**必填**：没有它就不该描述。 */
  readonly model: string
  readonly baseUrl: string
  readonly apiKey: string
  /** 会话 id（OpenCode Go 要求每会话带，影响路由与缓存）。 */
  readonly sessionId?: string
  readonly userAgent?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}

/** 一个把图片字节变成描述的调用器。 */
export type StickerVisionDescriber = (bytes: Uint8Array, mime: string) => Promise<StickerVisionResult>

/**
 * 创建视觉描述器。
 *
 * 没给 `model` 时**抛错**（fail-closed）：表情库的价值全在描述上，
 * 编造描述比没有描述更糟 —— 检索会命中错的东西，而且没人会发现。
 */
export function createStickerVisionDescriber(options: StickerVisionOptions): StickerVisionDescriber {
  if (options.model.trim() === '') {
    throw new Error('没有配置视觉模型 ⇒ 拒绝生成描述（fail-closed）。请授权一个带 image 能力的模型后再启用。')
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  return async (bytes: Uint8Array, mime: string): Promise<StickerVisionResult> => {
    const body = buildStickerVisionRequest({
      model: options.model,
      imageBase64: Buffer.from(bytes).toString('base64'),
      mime,
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      'user-agent': options.userAgent ?? 'dsh-forlife/0.1',
    }
    if (options.sessionId !== undefined) headers['x-opencode-session'] = options.sessionId

    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`视觉调用失败 HTTP ${String(response.status)}：${text.slice(0, 200)}`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`视觉调用返回的不是 JSON：${text.slice(0, 120)}`)
    }
    const parsed = parseStickerVisionResponse(payload)
    if (parsed.description === '') {
      // 空描述不能入库：它会让检索命中一个"什么都没说"的条目
      throw new Error('视觉模型没有返回可用描述（空内容）⇒ 不入库')
    }
    const usage = (payload as { usage?: { total_tokens?: number } }).usage
    return {
      description: parsed.description,
      emotionTags: parsed.emotionTags,
      model: options.model,
      tokenCount: usage?.total_tokens ?? 0,
    }
  }
}

/** 从环境变量读视觉配置（没配就返回 undefined，调用方据此跳过描述）。 */
export function visionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StickerVisionOptions | undefined {
  const model = env['FORLIFE_VISION_MODEL']
  const apiKey = env['FORLIFE_OPENCODE_GO_KEY'] ?? env['FORLIFE_VISION_KEY']
  if (model === undefined || model.trim() === '' || apiKey === undefined || apiKey === '') return undefined
  return {
    model,
    apiKey,
    baseUrl: env['FORLIFE_VISION_BASE_URL'] ?? 'https://opencode.ai/zen/go/v1',
    // OpenCode Go **要求**每个请求带 x-opencode-session（真实调用会 400 MissingSessionID）。
    // 所以这里给一个**默认的稳定标识**而不是"没配就不发" ——
    // 会话 id 的作用是让它做路由与提示词缓存，缺了它请求会被直接拒掉。
    sessionId: env['FORLIFE_VISION_SESSION'] ?? 'dsh-forlife-vision',
  }
}

/** 便捷：把描述写进库里（包一层 `describeStickerOnce` 的写法见调用方）。 */
export type { DatabaseSync }
