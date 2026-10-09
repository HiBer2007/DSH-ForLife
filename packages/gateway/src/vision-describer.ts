/**
 * ★ P1-1 的**视觉描述器**：把"一张图"变成"视觉模型的一段话"。
 *
 * ## 为什么它必须住在网关侧、并且要能按 attachmentId 自己找字节
 *
 * `VisionBridge.describeImage(attachmentId)` 只拿到一个**附件 id**
 * （`sha256:<64hex>`，内容寻址）—— 这是刻意的：桥接只负责"缓存 + 复核 + 降级"，
 * **不负责取字节**。取字节是装配层的事，而"图片从哪来"两条装配路径不同：
 *
 *  - **生产**（`gateway/src/runtime.ts`，独立容器）：图片是入站时我们**自己下载**
 *    并落在内容寻址目录里的 ⇒ 按下标就能读回来；
 *  - **开发**（`dsh-component/src/gateway-plugin.ts`）：同进程，同一份目录。
 *
 * ⇒ 两边都注入同一个 {@link createAttachmentReader}（读 `<root>/inbound/<hex>`），
 * 于是"缓存命中就不会再读盘、也不会再调模型"仍然成立。
 *
 * ## 为什么提示词按 `system` / `user` 两段传
 *
 * 桥接从 `@forlife/router` 的 `describePrompt()` 取模板（三段式：画面内容/文字/不确定之处），
 * 本模块只负责**把它和图片一起塞进一次 OpenAI 兼容请求**。这样"提示词怎么写得更好"
 * 与"怎么发请求"是两件独立可测的事（`vision.test.ts` 钉前者，本模块钉后者）。
 *
 * ## 失败形态（全部如实抛出，由桥接统一降级成占位文本）
 *
 *  - 附件读不到（下载失败/被清理）⇒ 抛错；
 *  - 没有视觉模型配置 ⇒ 装配层**根本不构造桥接**，于是桥接走"没有可用的视觉模型"占位文本；
 *  - HTTP 非 2xx / 超时 / 返回空内容 ⇒ 抛错（**空描述绝不入库**：那会让检索命中一个"什么都没说"的条目）。
 *
 * @module @forlife/gateway/vision-describer
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { VisionDescriber } from './vision-bridge.ts'

/** 视觉端点配置（与表情视觉**同一套环境变量**，见 `sticker-vision.ts`）。 */
export interface VisionEndpoint {
  readonly model: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly sessionId?: string
  readonly userAgent?: string
}

/** 能读回附件字节的读取器（读不到返回 undefined）。 */
export type AttachmentReader = (attachmentId: string) => { readonly bytes: Uint8Array; readonly mime: string } | undefined

/** 注入的 fetch（测试用；签名刻意收窄，避免依赖 DOM 类型）。 */
export type VisionFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/**
 * 附件目录的约定：`<root>/inbound/<64hex>`。
 *
 * 为什么用**内容**当文件名（而不是消息 id / 时间戳）：
 *  - 同一张图被转发/重复发送时**只存一份**（也就只描述一次，0 次额外视觉调用）；
 *  - `attachmentId` 是 `sha256:<hex>`，反过来能直接推出路径，不需要索引表。
 */
export function attachmentPathFor(storageRoot: string, attachmentId: string): string {
  const hex = attachmentId.replace(/^sha256:/, '')
  return join(storageRoot, 'inbound', hex)
}

/** 落盘（幂等：同一张图重复写只覆盖同样内容）。 */
export function writeAttachment(storageRoot: string, attachmentId: string, bytes: Uint8Array): string {
  const path = attachmentPathFor(storageRoot, attachmentId)
  mkdirSync(dirname(path), { recursive: true })
  // 已存在就不重写（内容寻址 ⇒ 同名同内容；省一次写盘，也避免并发写坏）
  try {
    readFileSync(path)
    return path
  } catch {
    // 不存在 ⇒ 正常写
  }
  writeFileSync(path, bytes)
  return path
}

/** 从魔数嗅探图片类型（不信任远端 content-type：它常常是 application/octet-stream）。 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const b = (i: number): number => bytes[i] ?? 0
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png'
  if (bytes.length >= 6 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif'
  if (bytes.length >= 12 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp'
  if (bytes.length >= 2 && b(0) === 0x42 && b(1) === 0x4d) return 'image/bmp'
  return undefined
}

/** 建一个"按 attachmentId 读字节"的读取器（路径约定见 {@link attachmentPathFor}）。 */
export function createAttachmentReader(storageRoot: string): AttachmentReader {
  return (attachmentId) => {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(attachmentPathFor(storageRoot, attachmentId)))
    } catch {
      return undefined
    }
    const mime = sniffImageMime(bytes)
    return mime === undefined ? undefined : { bytes, mime }
  }
}

/**
 * 构造 OpenAI 兼容的视觉请求体（**纯函数**，便于把"请求长什么样"钉死）。
 *
 * ⚠️ 图片必须是 **data URI**：直接塞 base64 会被服务端当成普通文本"描述"一遍 ——
 * 那种失败**不报错**，只是描述变成一堆乱码（与 `sticker-vision.ts` 同一条教训）。
 */
export function buildVisionRequest(input: {
  readonly model: string
  readonly system: string
  readonly user: string
  readonly imageBase64: string
  readonly mime: string
  readonly maxTokens?: number
}): Record<string, unknown> {
  // MIME 可能是 "image/png; charset=binary" ⇒ data URI 里不能带参数
  const mime = input.mime.split(';')[0]?.trim().toLowerCase() ?? 'image/png'
  return {
    model: input.model,
    // 视觉模型常常是推理模型：预算给小了会把额度全花在 reasoning 上、正文回空串（HTTP 仍 200）
    max_tokens: input.maxTokens ?? 2000,
    messages: [
      { role: 'system', content: input.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: input.user },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${input.imageBase64}` } },
        ],
      },
    ],
  }
}

/** 把 `content`（字符串或分段数组）拼成文本。 */
export function visionContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
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

/**
 * 建一个视觉描述器。
 *
 * @param input - 端点配置、附件读取器、可选注入。
 * @returns 描述器（失败一律抛错，由桥接降级成**看得见的**占位文本）。
 */
export function createHttpVisionDescriber(input: {
  readonly endpoint: VisionEndpoint
  readonly read: AttachmentReader
  readonly fetchImpl?: VisionFetchLike
  readonly timeoutMs?: number
  readonly maxTokens?: number
  readonly log?: (message: string) => void
}): VisionDescriber {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as VisionFetchLike)
  const timeoutMs = input.timeoutMs ?? 60_000

  return {
    describe: async ({ attachmentId, system, user }): Promise<string> => {
      const attachment = input.read(attachmentId)
      if (attachment === undefined) {
        throw new Error(`附件 ${attachmentId} 的字节读不到（下载失败、被清理，或不是图片）`)
      }
      const body = buildVisionRequest({
        model: input.endpoint.model,
        system,
        user,
        imageBase64: Buffer.from(attachment.bytes).toString('base64'),
        mime: attachment.mime,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      })
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${input.endpoint.apiKey}`,
        'user-agent': input.endpoint.userAgent ?? 'dsh-forlife/0.1',
      }
      // OpenCode Go 要求每个请求带 x-opencode-session（缺了会 400 MissingSessionID）
      if (input.endpoint.sessionId !== undefined) headers['x-opencode-session'] = input.endpoint.sessionId

      const response = await fetchImpl(`${input.endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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
      const choices = (payload as { choices?: unknown }).choices
      const first = Array.isArray(choices) && choices.length > 0 ? (choices[0] as { message?: { content?: unknown } }) : undefined
      const content = visionContentToText(first?.message?.content).trim()
      if (content === '') {
        // 空描述不能返回给桥接：它会被 parseDescription 变成"scene = 空"，
        // 而 renderDescriptionBlock 会照样拼出一个"有描述"的块 —— 那是最坏的一种假成功。
        throw new Error('视觉模型返回了空内容（多半是 max_tokens 被 reasoning 吃光，或该模型不支持图片输入）')
      }
      input.log?.(`视觉描述完成（${attachmentId.slice(0, 16)}…，${String(content.length)} 字）`)
      return content
    },
  }
}
