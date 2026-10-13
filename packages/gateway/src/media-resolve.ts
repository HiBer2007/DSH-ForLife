/**
 * ★ 入站媒体的**取回与降级**：图片 → 视觉描述、语音 → 转写、文件 → 真取信息。
 *
 * ## 为什么三件事放一个模块
 *
 * 它们的形状完全一样：**"消息里有一段我们看不懂的东西 ⇒ 花一次外部调用把它变成文字
 * ⇒ 把结果替换进 `message.text`"**。差别只在"调谁"：
 *
 * | 段 | 取回方式 | 失败时的占位符 |
 * | :--- | :--- | :--- |
 * | `image` | 下载 CDN 直链 → sha256 → `VisionBridge` | `[图片（没能取回：原因）]` |
 * | `record` | `fetch_ptt_text`（NapCat 自带转写） | `[语音（转写失败：原因）]` |
 * | `file` | `get_file`（**真的去协议端取**） | `[文件：名字（协议端取不回：原因）]` |
 *
 * 放一起的第二个理由：它们**共用同一个预算**（时间 + 次数）。分成三个模块的话，
 * 一批消息里"3 张图 + 2 条语音 + 2 个文件"会各自以为自己有额度 —— 轮次被拖死。
 *
 * ## ★ 三条硬规则（这一层存在的全部意义）
 *
 * ① **失败必须看得见**：取不回时产出**带原因的占位符**，绝不留空白 ——
 *    "她发的健康截图"变成三个字 `[图片]` 是这个项目栽过的坑（审计 §3.2）。
 * ② **先预筛，再花钱**（{@link decideLookAtImage}）：每张图都调视觉模型会把成本打爆，
 *    而群里刷的图/表情包/二维码大多数与我们无关。
 * ③ **内容寻址做缓存**：图片按 `sha256` 命名 ⇒ 同一张图（哪怕被转发、哪怕 URL 过期）
 *    第二次**零额外视觉调用**（`VisionBridge` 的验收项）。
 *
 * ## ⚠️ 关于 `image.url` 的可得性（本轮实测结论，见交付报告）
 *
 * 真机源码核对：入站路径 `parseMessageV2(e, parseMultMsg)` **不传** `disableGetUrl`
 * ⇒ 取默认 `false` ⇒ `url = await FileApi.getImageUrl(e)`，
 * **与线上配置 `enableLocalFile2Url:false` 无关**（那一项只影响 `get_file` 的 `base64` 分支）。
 * 但 `getImageUrl` 有两条路：`originImageUrl` 带 appid 1406/1407+fileid 时拼 **rkey 下载链**
 * （**会过期**），否则拼 `https://gchat.qpic.cn/gchatpic_new/0/0-0-<MD5>/0`。
 * ⇒ 所以这里**不假设 URL 一定可用**：下载失败就是一条明确的失败路径（规则①）。
 *
 * @module @forlife/gateway/media-resolve
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import { placeholderText } from './vision-bridge.ts'
import type { InboundFileRef, InboundImageRef, InboundMessage } from './transport.ts'
import { sniffImageMime, writeAttachment } from './vision-describer.ts'

/** 图片占位符（由 `onebot.ts` 拼出来；这里靠它做定位替换）。 */
export const IMAGE_PLACEHOLDER = '[图片]'
/** 语音占位符。 */
export const VOICE_PLACEHOLDER = '[语音]'
/** 文件占位符。 */
export const FILE_PLACEHOLDER = '[文件]'

/** 视觉桥接的**最小端口**（`VisionBridge` 满足它；测试用假的）。 */
export interface ImageVisionPort {
  describe: (attachmentId: string) => Promise<{
    readonly text: string
    readonly reused: boolean
    readonly calls: number
    readonly ok: boolean
  }>
}

/** 只读取回能力（`QqTransport` 的子集；收窄是为了让本模块可以脱离整个传输层被测试）。 */
export interface MediaTransport {
  /** 语音转文字（NapCat 的 `fetch_ptt_text`）。 */
  fetchPttText: (messageId: string) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>
  /** 取文件信息（NapCat 的 `get_file`）。 */
  getFileInfo: (
    input: { readonly file?: string; readonly fileId?: string },
  ) => Promise<{ readonly file?: string; readonly url?: string; readonly fileSize?: string; readonly fileName?: string } | undefined>
}

/** 一次取回的统计（测试与日志要看"到底看了几张、省了几次"）。 */
export interface MediaResolveStats {
  readonly imagesLooked: number
  readonly imagesReused: number
  readonly imagesSkipped: number
  readonly imagesFailed: number
  readonly voiceTranscribed: number
  readonly voiceFailed: number
  readonly filesFetched: number
  readonly filesFailed: number
  /** 是否触到了时间预算（触到 ⇒ 后面的段保留了占位符）。 */
  readonly budgetExhausted: boolean
}

/** 结果。 */
export interface MediaResolveResult {
  /** 文本已补上的消息（顺序与原批一致）。 */
  readonly messages: readonly InboundMessage[]
  /** 真的有变化的那些消息（**调用方据此回填 `qq_inbox.text`**）。 */
  readonly patched: readonly InboundMessage[]
  readonly stats: MediaResolveStats
  /** 人话告警（进日志）。 */
  readonly notes: readonly string[]
}

/** 预筛判定。 */
export interface ImageScreenDecision {
  readonly look: boolean
  readonly reason: string
}

/**
 * ★ **便宜的预筛**：这张图该不该花一次视觉调用。
 *
 * 顺序即优先级（越前面越便宜、越确定）：
 *
 *  1. **总开关**（`qq.image.enabled`）—— 关掉它等于回到旧行为（只有 `[图片]`），
 *     但**占位符仍在**（不是空白）；
 *  2. **URL 形状**：不是 `http(s)` 就不看 —— 协议端可能给的是**它自己容器里的本地路径**
 *     （`enableLocalFile2Url` 打开时的形态），我们取不到，硬试只会白等一次超时；
 *  3. **NapCat 自己标的"动画表情"**：`image.data.sub_type === 1`（或 `summary` 写着动画表情）
 *     ⇒ 那是表情包，不是内容。这是**协议端免费给**的判据，比按大小猜准得多；
 *  4. **群里没 @ 我**：大群刷图是主要成本来源。私聊/临时会话的图 = 对方专门发给你的 ⇒ 看；
 *  5. **声明大小**：超过上限（取回来也喂不进视觉模型）或小于下限（多半是图标/二维码）
 *     都不看。⚠️ 阈值是**猜的**（真机流量缺失），写在基线里可调。
 *
 * @param input - 图、会话上下文与阈值。
 * @returns 判定 + 人话原因（原因会进占位符，让模型知道"我们没看，而不是图是空的"）。
 */
export function decideLookAtImage(input: {
  readonly image: InboundImageRef
  readonly isGroup: boolean
  readonly mentioned: boolean
  readonly enabled: boolean
  readonly minBytes: number
  readonly maxBytes: number
  readonly groupNeedsMention: boolean
}): ImageScreenDecision {
  if (!input.enabled) return { look: false, reason: '图片理解被关掉了（基线 qq.image.enabled）' }
  const url = input.image.url.trim()
  if (url === '') return { look: false, reason: '协议端没有给出图片地址' }
  if (!/^https?:\/\//i.test(url)) return { look: false, reason: '地址不是 http(s)（看起来是协议端容器内的本地路径，我们取不到）' }
  if (input.image.subType === 1) return { look: false, reason: '这是动画表情/表情包（协议端标了 sub_type=1）' }
  if (typeof input.image.summary === 'string' && input.image.summary.includes('动画表情')) {
    return { look: false, reason: '这是动画表情（summary 写着「动画表情」）' }
  }
  if (input.isGroup && input.groupNeedsMention && !input.mentioned) {
    return { look: false, reason: '群里的图，而这条没有 @ 我（大群里刷图不该花视觉调用）' }
  }
  const size = typeof input.image.fileSize === 'number' && Number.isFinite(input.image.fileSize) ? input.image.fileSize : undefined
  if (size !== undefined && size > input.maxBytes) {
    return { look: false, reason: `这张图 ${String(Math.round(size / 1024))}KB，超过上限 ${String(Math.round(input.maxBytes / 1024))}KB` }
  }
  if (size !== undefined && size > 0 && size < input.minBytes) {
    return { look: false, reason: `这张图只有 ${String(size)} 字节，太小（多半是表情/图标）` }
  }
  return { look: true, reason: '值得看' }
}

/** 没看的占位符（**带原因**：模型要知道"我们没看"，而不是以为图是空的）。 */
export function skippedImagePlaceholder(reason: string): string {
  return `[图片（未看：${reason}）]`
}

/** 取回文本里的第 n 个占位符（按顺序替换；多余的占位符保持原样）。 */
export function splicePlaceholders(text: string, needle: string, values: readonly string[]): string {
  const parts = text.split(needle)
  if (parts.length <= 1) return text
  let out = parts[0] ?? ''
  for (let index = 0; index < parts.length - 1; index += 1) {
    out += (index < values.length ? (values[index] ?? needle) : needle) + (parts[index + 1] ?? '')
  }
  return out
}

/** 一次下载的结果。 */
export interface ImageFetchOutcome {
  readonly ok: boolean
  readonly bytes?: Uint8Array
  readonly error?: string
}

/**
 * 下载一张图（**流式 + 上限 + 超时**）。
 *
 * 为什么不 `await response.arrayBuffer()` 直接读：那时整个响应**已经进内存了** ——
 * 一张 200MB 的图会把网关拖垮，而上限只有几 MB。所以先看 `content-length`（挡掉绝大多数），
 * 再逐块累加、超限立刻中断（与 `sticker-service.ts` 的默认下载器同款纪律）。
 *
 * ⚠️ **不能用 `response.text()` 拿图片字节**：真实 fetch 按 UTF-8 解码，
 * 任意二进制会被替换字符破坏（而且不报错）—— 那会让 sha256 变掉、缓存永不命中、
 * 视觉模型收到一张坏图。所以这里走 `arrayBuffer()` / `body.getReader()`（**字节**）。
 */
export function createImageDownloader(options: {
  readonly fetchImpl?: BinaryFetchLike
  readonly timeoutMs: number
  readonly maxBytes: number
}): (url: string) => Promise<ImageFetchOutcome> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as BinaryFetchLike)
  return async (url: string): Promise<ImageFetchOutcome> => {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': 'dsh-forlife/0.1' },
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` }
      const declared = Number(response.headers?.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        return { ok: false, error: `声明大小超限（${String(declared)} 字节）` }
      }
      const reader = response.body?.getReader()
      if (reader === undefined) {
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.byteLength === 0) return { ok: false, error: '响应是空的' }
        if (buffer.byteLength > options.maxBytes) return { ok: false, error: `超过上限（读到 ${String(buffer.byteLength)} 字节）` }
        return { ok: true, bytes: buffer }
      }
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        total += value.byteLength
        if (total > options.maxBytes) {
          await reader.cancel()
          return { ok: false, error: `超过上限（读到 ${String(total)} 字节即中断）` }
        }
        chunks.push(value)
      }
      if (total === 0) return { ok: false, error: '响应是空的' }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { ok: true, bytes }
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 120) }
    }
  }
}

/**
 * 下载用的 fetch 形状（**收窄到真的需要的那几样**，测试可以只实现 `arrayBuffer`）。
 *
 * 刻意不写 `Response`：那会把 DOM 类型拖进来，而网关跑在 node 上。
 */
export type BinaryFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  headers?: { get: (name: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } } | null
}>

/** 解析 `file_size`（NapCat 给的是**字符串**）。 */
function parseSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 人话大小。 */
function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return '大小未知'
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 入站媒体的默认落盘根目录。
 *
 * 沿用部署里既有的约定（`forlife-data:/data # db / vectors / **attachments** / workspace / models`）：
 * `FORLIFE_DATA_DIR`（生产容器里是 `/data`）优先，其次热层根，最后退回 `DSH_HOME`。
 * 三个都没配 ⇒ 相对路径 `.runtime/attachments`（本地开发）。
 *
 * @param env - 环境变量（测试可注入）。
 * @returns 目录（**不保证存在**，写入时会 mkdir）。
 */
export function defaultAttachmentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['FORLIFE_DATA_DIR'] ?? env['FORLIFE_ROOT_HOT'] ?? env['DSH_HOME'] ?? '.runtime'
  return join(base, 'attachments')
}

/** 取回选项。 */
export interface MediaResolveOptions {
  readonly db: DatabaseSync
  readonly transport: MediaTransport
  /** 视觉桥接；不配 ⇒ 图片走桥接的"没有可用的视觉模型"占位文本（**仍然可见**）。 */
  readonly vision?: ImageVisionPort | undefined
  /** 附件落盘根目录（内容寻址）。 */
  readonly storageRoot: string
  readonly log?: (message: string) => void
  readonly fetchImpl?: BinaryFetchLike
  /** 注入时钟（测试用）。 */
  readonly now?: () => number
  /** 覆盖基线（测试用）。 */
  readonly overrides?: Partial<{
    readonly enabled: boolean
    readonly perBatch: number
    readonly minBytes: number
    readonly maxBytes: number
    readonly downloadTimeoutMs: number
    readonly budgetMs: number
    readonly groupNeedsMention: boolean
    readonly voicePerBatch: number
    readonly filePerBatch: number
    readonly fileMaxBytes: number
  }>
}

/**
 * 把一批消息里的图片/语音/文件**尽力**变成文字。
 *
 * **永不抛异常**：任何一段失败都只是让那一段保留/换成带原因的占位符 ——
 * 这条链跑在"消息刚要交给模型"的位置上，抛错会把整轮连同用户的消息一起丢掉。
 *
 * @param messages - 本批消息。
 * @param options - 依赖与预算。
 * @returns 补过文本的消息 + 统计 + 告警。
 */
export async function resolveMediaBatch(
  messages: readonly InboundMessage[],
  options: MediaResolveOptions,
): Promise<MediaResolveResult> {
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): number => Date.now())
  const over = options.overrides ?? {}
  const enabled = over.enabled ?? defaultFor<boolean>('qq.image.enabled')
  const perBatch = over.perBatch ?? defaultFor<number>('qq.image.resolvePerBatch')
  const minBytes = over.minBytes ?? defaultFor<number>('qq.image.minBytes')
  const maxBytes = over.maxBytes ?? defaultFor<number>('qq.image.maxBytes')
  const downloadTimeoutMs = over.downloadTimeoutMs ?? defaultFor<number>('qq.image.downloadTimeoutMs')
  const budgetMs = over.budgetMs ?? defaultFor<number>('qq.image.budgetMs')
  const groupNeedsMention = over.groupNeedsMention ?? defaultFor<boolean>('qq.image.groupNeedsMention')
  const voicePerBatch = over.voicePerBatch ?? defaultFor<number>('qq.voice.resolvePerBatch')
  const filePerBatch = over.filePerBatch ?? defaultFor<number>('qq.file.resolvePerBatch')
  const fileMaxBytes = over.fileMaxBytes ?? defaultFor<number>('qq.file.fetchMaxBytes')

  const download = createImageDownloader({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: downloadTimeoutMs,
    maxBytes,
  })

  const deadline = now() + budgetMs
  let imageBudget = perBatch
  let voiceBudget = voicePerBatch
  let fileBudget = filePerBatch
  const notes: string[] = []
  let budgetExhausted = false
  const counter = { imagesLooked: 0, imagesReused: 0, imagesSkipped: 0, imagesFailed: 0, voiceTranscribed: 0, voiceFailed: 0, filesFetched: 0, filesFailed: 0 }
  const patched: InboundMessage[] = []
  const out: InboundMessage[] = []

  for (const message of messages) {
    const isGroup = message.conversation.kind === 'group'
    const mentioned = message.mentionedMe || message.mentionedAll
    let text = message.text

    // ── ① 图片 ────────────────────────────────────────────────────────────
    const images = message.images ?? []
    if (images.length > 0 && text.includes(IMAGE_PLACEHOLDER)) {
      const rendered: string[] = []
      for (const image of images) {
        const decision = decideLookAtImage({ image, isGroup, mentioned, enabled, minBytes, maxBytes, groupNeedsMention })
        if (!decision.look) {
          counter.imagesSkipped += 1
          rendered.push(skippedImagePlaceholder(decision.reason))
          continue
        }
        // 时间预算先于次数预算判：**已超时就把剩下的留成占位符**，
        // 否则一串慢图会把这一轮拖到模型超时（那时用户看到的是"没反应"）。
        if (now() >= deadline) {
          budgetExhausted = true
          counter.imagesSkipped += 1
          rendered.push(skippedImagePlaceholder('本批时间预算用完了（基线 qq.image.budgetMs）'))
          continue
        }
        if (imageBudget <= 0) {
          counter.imagesSkipped += 1
          rendered.push(skippedImagePlaceholder('本批看图数量用完了（基线 qq.image.resolvePerBatch）'))
          continue
        }
        imageBudget -= 1
        try {
          const fetched = await download(image.url)
          if (!fetched.ok || fetched.bytes === undefined) {
            counter.imagesFailed += 1
            notes.push(`图片取回失败：${fetched.error ?? '未知原因'}`)
            rendered.push(`[图片（没能取回：${fetched.error ?? '未知原因'}）]`)
            continue
          }
          const mime = sniffImageMime(fetched.bytes)
          const attachmentId = `sha256:${createHash('sha256').update(fetched.bytes).digest('hex')}`
          if (mime === undefined) {
            counter.imagesFailed += 1
            notes.push('取回的字节不是已知图片格式（多半是一段 HTML 错误页）')
            rendered.push(`[图片（取回的不是图片：${attachmentId}）]`)
            continue
          }
          // 落盘（内容寻址 ⇒ 同图只存一份），视觉描述器按同一个约定读回来
          writeAttachment(options.storageRoot, attachmentId, fetched.bytes)
          if (options.vision === undefined) {
            counter.imagesFailed += 1
            rendered.push(placeholderText(attachmentId, '没有可用的视觉模型（该 provider 未声明 image 能力，或视觉角色未配置）'))
            continue
          }
          const described = await options.vision.describe(attachmentId)
          if (described.reused) counter.imagesReused += 1
          else if (described.ok) counter.imagesLooked += 1
          else counter.imagesFailed += 1
          rendered.push(described.text)
        } catch (error) {
          // 桥接自称永不抛，但**这一层也不许抛**（双重保险：链路的成败不该压在一个承诺上）
          counter.imagesFailed += 1
          notes.push(`图片处理异常（已降级为占位符）：${String(error).slice(0, 120)}`)
          rendered.push(`[图片（处理失败：${String(error).slice(0, 80)}）]`)
        }
      }
      text = splicePlaceholders(text, IMAGE_PLACEHOLDER, rendered)
    }

    // ── ② 语音（`fetch_ptt_text`）────────────────────────────────────────
    //
    // ⚠️ 转写**不依赖** `record.data.url`（审计 §5c：那个 URL 要 packet 后端健康，
    //    是 NapCat 的已知静默失败面）。`fetch_ptt_text` 只要 **message_id**，
    //    所以它比"下载语音再喂给语音模型"划算得多，失败也是**明确报错**。
    if (message.hasVoice === true && text.includes(VOICE_PLACEHOLDER)) {
      if (now() >= deadline || voiceBudget <= 0) {
        budgetExhausted = budgetExhausted || now() >= deadline
        counter.voiceFailed += 1
        text = splicePlaceholders(text, VOICE_PLACEHOLDER, [
          now() >= deadline ? '[语音（未转写：本批时间预算用完了）]' : '[语音（未转写：本批额度用完了）]',
        ])
      } else {
        voiceBudget -= 1
        let transcribed: string | undefined
        let reason: string | undefined
        try {
          const result = await options.transport.fetchPttText(message.messageId)
          if (result.ok && result.text !== undefined && result.text.trim() !== '') transcribed = result.text.trim()
          else reason = result.error ?? '协议端没有返回文本'
        } catch (error) {
          reason = String(error).slice(0, 120)
        }
        if (transcribed === undefined) {
          counter.voiceFailed += 1
          notes.push(`语音转写失败：${reason ?? '未知原因'}`)
          text = splicePlaceholders(text, VOICE_PLACEHOLDER, [`[语音（转写失败：${reason ?? '未知原因'}）]`])
        } else {
          counter.voiceTranscribed += 1
          text = splicePlaceholders(text, VOICE_PLACEHOLDER, [`[语音转写]${transcribed}`])
        }
      }
    }

    // ── ③ 文件（`get_file` 真调用，P2-b）─────────────────────────────────
    const files = message.files ?? []
    if (files.length > 0 && text.includes(FILE_PLACEHOLDER)) {
      const rendered: string[] = []
      for (const file of files) {
        const size = parseSize(file.fileSize)
        const name = file.fileName ?? '(未命名)'
        if (now() >= deadline) {
          budgetExhausted = true
          rendered.push(`[文件：${name}（${humanSize(size)}，未取信息：本批时间预算用完了）]`)
          continue
        }
        if (fileBudget <= 0) {
          rendered.push(`[文件：${name}（${humanSize(size)}，未取信息：本批额度用完了）]`)
          continue
        }
        // 大文件不主动取：`get_file` 会**让协议端真的去下载**（实测源码：
        // `FileApi.downloadMedia`），几百 MB 的文件会把那边拖住，而我们要的只是元信息。
        if (size !== undefined && size > fileMaxBytes) {
          rendered.push(`[文件：${name}（${humanSize(size)}，太大不自动取：基线 qq.file.fetchMaxBytes）]`)
          continue
        }
        fileBudget -= 1
        try {
          const info = await options.transport.getFileInfo({
            ...(file.fileName === undefined ? {} : { file: file.fileName }),
            ...(file.fileId === undefined ? {} : { fileId: file.fileId }),
          })
          if (info === undefined) {
            counter.filesFailed += 1
            rendered.push(`[文件：${name}（${humanSize(size)}，协议端取不回：可能已过期或不在缓存里）]`)
            continue
          }
          counter.filesFetched += 1
          const realName = info.fileName !== undefined && info.fileName !== '' ? info.fileName : name
          const realSize = parseSize(info.fileSize) ?? size
          // ⚠️ 如实说清"我们能拿到什么"：`get_file` 返回的 `file` 是**协议端容器里的本地路径**，
          //    不是我们能下载的 URL ⇒ 模型不该以为"文件内容已经读到了"。
          const where = info.url !== undefined && /^https?:\/\//i.test(info.url) ? `可下载：${info.url}` : '内容在协议端本地（我们读不到内容，只能看到名字与大小）'
          rendered.push(`[文件：${realName}（${humanSize(realSize)}，${where}）]`)
        } catch (error) {
          counter.filesFailed += 1
          notes.push(`取文件信息异常：${String(error).slice(0, 120)}`)
          rendered.push(`[文件：${name}（${humanSize(size)}，取信息失败：${String(error).slice(0, 60)}）]`)
        }
      }
      text = splicePlaceholders(text, FILE_PLACEHOLDER, rendered)
    }

    const next: InboundMessage = text === message.text ? message : { ...message, text }
    if (text !== message.text) patched.push(next)
    out.push(next)
  }

  const stats: MediaResolveStats = {
    imagesLooked: counter.imagesLooked,
    imagesReused: counter.imagesReused,
    imagesSkipped: counter.imagesSkipped,
    imagesFailed: counter.imagesFailed,
    voiceTranscribed: counter.voiceTranscribed,
    voiceFailed: counter.voiceFailed,
    filesFetched: counter.filesFetched,
    filesFailed: counter.filesFailed,
    budgetExhausted,
  }
  if (patched.length > 0) {
    log(
      `入站媒体：看图 ${String(stats.imagesLooked)}（复用缓存 ${String(stats.imagesReused)}）/跳过 ${String(stats.imagesSkipped)}/失败 ${String(stats.imagesFailed)}；` +
        `语音转写 ${String(stats.voiceTranscribed)}/失败 ${String(stats.voiceFailed)}；文件取信息 ${String(stats.filesFetched)}/失败 ${String(stats.filesFailed)}`,
    )
  }
  for (const note of notes) log(`入站媒体告警：${note}`)
  return { messages: out, patched, stats, notes }
}

/** 供 `onebot.ts` 构造图片引用时复用（保持"段里有什么"与"我们看什么"在同一处定义）。 */
export type { InboundFileRef, InboundImageRef }
