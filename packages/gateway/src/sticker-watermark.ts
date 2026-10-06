/**
 * 水印检查 —— 用户的**硬要求**：「绝对不允许我们使用的表情带有水印」。
 *
 * ## 为什么必须用视觉模型，而不是图像启发式
 *
 * 水印的形态太多：角标 logo、半透明平铺、底部文字条、中心大字、
 * 平台昵称（"@某某"）、时间戳…… 启发式规则（找边缘高频、找固定位置色块）
 * **一定会漏**，而漏掉的后果正是用户明确不允许的那件事。
 * 我们已经有能看图的模型，用它判最可靠。
 *
 * ## fail-closed：查不了就不许用
 *
 * 没配视觉模型时**拒绝导入**，而不是"查不了就放行"。
 * 理由：这条要求是"绝对不允许"，放行的代价是把带水印的表情发到群里 ——
 * 那是一次**对外**的错误，比"暂时存不进表情"严重得多。
 *
 * ## 代价与缓解
 *
 * 每张新图多一次视觉调用。但**指纹复用**（sha256）会让同一张图只判一次 ——
 * 这正是那套机制存在的意义。所以这笔开销是"每张图一次"，不是"每次使用一次"。
 *
 * @module @forlife/gateway/sticker-watermark
 */
import { buildStickerVisionRequest, parseStickerVisionResponse, type FetchLike } from './sticker-vision.ts'

/** 检查结果。 */
export interface WatermarkVerdict {
  readonly hasWatermark: boolean
  /** 判断依据（模型说了什么）——留证据，便于人工复核误判。 */
  readonly evidence: string
  /** 是否真的调用了模型。 */
  readonly calledModel: boolean
}

/** 检查器。 */
export type WatermarkChecker = (bytes: Uint8Array, mime: string) => Promise<WatermarkVerdict>

/** 给模型的指令。要求它**只报看得见的证据**，不要推测。 */
export const WATERMARK_PROMPT = [
  '这是一个表情包图片。请判断它是否**带有水印**。',
  '水印包括：角标 logo、半透明平铺图案、底部或侧边文字条、平台昵称（如 @某某）、',
  '网站域名、时间戳、二维码、以及任何明显的后期叠加标记。',
  '注意：图片**本身的内容**（比如画面里出现的招牌文字、字幕风格的字）不算水印，',
  '只有**后期叠加的归属标记**才算。',
  '只输出 JSON：{"watermark": true|false, "evidence": "你看到的依据（没有就写 none）"}',
].join('\n')

/** 检查器配置。 */
export interface WatermarkCheckerOptions {
  /** 视觉模型 id。**必填** —— 没有它就不该放行（见文件头）。 */
  readonly model: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly sessionId?: string
  readonly userAgent?: string
  readonly fetchImpl?: FetchLike
}

/** 构造水印检查器。 */
export function createWatermarkChecker(options: WatermarkCheckerOptions): WatermarkChecker {
  if (options.model.trim() === '') {
    throw new Error('没有配置视觉模型 ⇒ 无法检查水印（fail-closed：绝对不允许带水印的表情）')
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  return async (bytes, mime): Promise<WatermarkVerdict> => {
    const body = buildStickerVisionRequest({ model: options.model, imageBase64: Buffer.from(bytes).toString('base64'), mime, maxTokens: 2000 })
    // 用同一个请求构造器，但把提示词换成水印判断（避免重复实现 data URI 那套易错逻辑）
    const messages = body['messages'] as { content: { type: string; text?: string }[] }[]
    const first = messages[0]
    if (first !== undefined) {
      const textPart = first.content.find((part) => part.type === 'text')
      if (textPart !== undefined) textPart.text = WATERMARK_PROMPT
    }

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
    if (!response.ok) throw new Error(`水印检查失败 HTTP ${String(response.status)}：${text.slice(0, 200)}`)

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`水印检查返回的不是 JSON：${text.slice(0, 120)}`)
    }

    const parsed = parseStickerVisionResponse(payload)
    const raw = parsed.description
    // 解析 `{"watermark":…}`：容忍代码块与前后废话（复用已有的解析思路）
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        const json = JSON.parse(raw.slice(start, end + 1)) as { watermark?: unknown; evidence?: unknown }
        const hasWatermark = json.watermark === true || json.watermark === 'true'
        return {
          hasWatermark,
          evidence: typeof json.evidence === 'string' ? json.evidence : hasWatermark ? '模型报告有水印' : 'none',
          calledModel: true,
        }
      } catch {
        // 落到下面的保守分支
      }
    }

    // **解析不了时保守处理**：判为"有水印"并说明，而不是当没事发生。
    // 因为漏判的代价是把带水印的表情发出去（对外错误），误判只是少存一张表情。
    return {
      hasWatermark: true,
      evidence: `模型输出无法解析为判定结果，按"有水印"保守处理：${raw.slice(0, 120)}`,
      calledModel: true,
    }
  }
}

/** 从环境变量读水印检查配置（没配就返回 undefined ⇒ 调用方应拒绝导入）。 */
export function watermarkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatermarkCheckerOptions | undefined {
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
