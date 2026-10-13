/**
 * 可续传下载与 SHA-256 校验（§2.13.3 第 4 步）。
 *
 * ## 三条硬要求
 *
 * ① **大文件必须可续传**：模型权重动辄几个 GB，网络中断不能从头再来；
 * ② **SHA-256 必须校验**：权重文件损坏的表现是"模型答非所问"，那种 bug 极难查；
 * ③ **幂等**：已经下好且校验通过的文件直接跳过（重跑部署不该重下几个 GB）。
 *
 * ## 为什么续传用 `.part` 而不是直接写目标文件
 *
 * 目标文件一旦存在，上层就可能以为"权重已就绪"。所以下载中一律写 `<dest>.part`，
 * **校验通过后才原子改名**。这样任何时刻"目标文件存在"都等于"它已校验通过"。
 *
 * @module @forlife/router/download
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs'

/** 下载进度回调。 */
export interface DownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes?: number
  readonly resumedFromBytes: number
}

/** 下载结果。 */
export interface DownloadResult {
  readonly ok: boolean
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** 是否复用了已完成的文件（幂等跳过）。 */
  readonly skipped: boolean
  /** 是否用了续传。 */
  readonly resumed: boolean
  /** 重试了几次（SHA 校验失败会重下一次）。 */
  readonly attempts: number
  readonly error?: string
}

/** 下载选项。 */
export interface DownloadOptions {
  readonly url: string
  readonly dest: string
  /** 期望的 SHA-256（十六进制，大小写不敏感）。 */
  readonly sha256: string
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
  /** 校验失败时的最大重下次数（默认 1，即最多下两次）。 */
  readonly maxAttempts?: number
  readonly onProgress?: (progress: DownloadProgress) => void
}

/** 计算文件 SHA-256。 */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 比较两个 SHA-256（大小写不敏感、容忍 `sha256:` 前缀）。 */
export function sameSha256(a: string, b: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/^sha256:/, '')
  return normalize(a) === normalize(b)
}

/**
 * 可续传下载 + SHA-256 校验。
 *
 * @param options - 下载参数。
 * @returns 结果（**不抛异常** —— 部署流水线要拿到结果再决定回滚）。
 */
export async function resumableDownload(options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = (options.maxAttempts ?? 1) + 1
  const partPath = `${options.dest}.part`

  // 幂等：已下好且校验通过 ⇒ 直接跳过（重跑部署不该重下几个 GB）
  if (existsSync(options.dest)) {
    const existing = await fileSha256(options.dest)
    if (sameSha256(existing, options.sha256)) {
      return { ok: true, path: options.dest, bytes: statSync(options.dest).size, sha256: existing, skipped: true, resumed: false, attempts: 0 }
    }
    // 存在但校验不过 ⇒ 删掉重下（半截文件或损坏文件）
    rmSync(options.dest, { force: true })
  }

  let lastError: string | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resumedFrom = existsSync(partPath) ? statSync(partPath).size : 0
      const headers: Record<string, string> = {}
      if (resumedFrom > 0) headers['range'] = `bytes=${String(resumedFrom)}-`

      const response = await fetchImpl(options.url, { headers })
      if (!response.ok && response.status !== 206) {
        return {
          ok: false,
          path: options.dest,
          bytes: resumedFrom,
          sha256: '',
          skipped: false,
          resumed: resumedFrom > 0,
          attempts: attempt,
          error: `HTTP ${String(response.status)}`,
        }
      }

      // 服务端不支持 Range（回 200 而不是 206）⇒ 从头下，避免把两段拼成坏文件
      const serverIgnoredRange = resumedFrom > 0 && response.status === 200
      const mode = serverIgnoredRange ? 'w' : resumedFrom > 0 ? 'a' : 'w'
      if (serverIgnoredRange) rmSync(partPath, { force: true })

      const started = serverIgnoredRange ? 0 : resumedFrom
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      const totalBytes = contentLength > 0 ? started + contentLength : undefined

      await writeBody(response, partPath, mode, (received) => {
        options.onProgress?.({ receivedBytes: started + received, ...(totalBytes === undefined ? {} : { totalBytes }), resumedFromBytes: started })
      })

      const actual = await fileSha256(partPath)
      if (!sameSha256(actual, options.sha256)) {
        // 校验失败：删掉半截文件再重下一次（**不保留**坏的 .part，否则会一直续传坏数据）
        rmSync(partPath, { force: true })
        lastError = `SHA-256 不匹配（期望 ${options.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`
        continue
      }

      // 校验通过才原子改名：这样"目标文件存在"永远等于"它已校验通过"
      renameSync(partPath, options.dest)
      return {
        ok: true,
        path: options.dest,
        bytes: statSync(options.dest).size,
        sha256: actual,
        skipped: false,
        resumed: started > 0,
        attempts: attempt,
      }
    } catch (error) {
      lastError = String(error)
    }
  }

  return {
    ok: false,
    path: options.dest,
    bytes: existsSync(partPath) ? statSync(partPath).size : 0,
    sha256: '',
    skipped: false,
    resumed: existsSync(partPath),
    attempts: maxAttempts,
    ...(lastError === undefined ? {} : { error: lastError }),
  }
}

/** 把响应体写进文件（分块写入以便报进度）。 */
async function writeBody(
  response: Response,
  path: string,
  mode: 'w' | 'a',
  onChunk: (receivedBytes: number) => void,
): Promise<void> {
  const body = response.body
  if (body === null) {
    const buffer = Buffer.from(await response.arrayBuffer())
    const stream = createWriteStream(path, { flags: mode })
    stream.write(buffer)
    await new Promise<void>((resolve) => stream.end(resolve))
    onChunk(buffer.length)
    return
  }
  const stream = createWriteStream(path, { flags: mode })
  let received = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      received += value.length
      stream.write(Buffer.from(value))
      onChunk(received)
    }
  }
  await new Promise<void>((resolve) => stream.end(resolve))
}
