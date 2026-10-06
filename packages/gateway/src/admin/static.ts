/**
 * 静态文件服务 —— 把 `admin-ui/dist` 挂在 `/admin` 下。
 *
 * 三条要求：
 *  1. **不许越界**：请求路径必须落在 root 之内（`..` 与符号链接都要挡住）——
 *     这是公网入口，路径穿越是最基本的一条线。
 *  2. **缓存策略分两类**：带内容哈希的产物（`/assets/xxx-HASH.js`）可以 immutable 长缓存；
 *     `index.html` 必须 no-cache，否则发新版后客户端还在跑旧的。
 *  3. **SPA 回落**：`/admin/anything`（不是文件）都回 index.html，
 *     这样前端路由刷新不会 404。注意只在 `/admin` 前缀内回落，绝不碰 `/api`。
 *
 * @module @forlife/gateway/admin/static
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** 扩展名 → Content-Type。够用即可，不引入 mime 依赖。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 静态服务选项。 */
export interface StaticOptions {
  /** 产物根目录（`packages/admin-ui/dist` 的绝对路径）。 */
  readonly root: string
  /** URL 前缀，默认 `/admin`。 */
  readonly prefix?: string
}

/** 把 URL 路径安全地映射到磁盘路径；越界返回 undefined。 */
function resolveSafe(root: string, urlPath: string): string | undefined {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath)
    } catch {
      return undefined
    }
  })()
  if (decoded === undefined) return undefined
  // 去掉开头的斜杠后再 normalize：`..` 会被消解，之后必须仍落在 root 内
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const target = resolve(root, relative)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) return undefined
  return target
}

/** 文件是否存在且是普通文件。 */
async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 发一个文件（含缓存头）。 */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, immutable: boolean): void {
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    // 带哈希的产物长缓存；其余（index.html）每次都问一次，保证发版即时生效
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(path)
  stream.on('error', () => {
    // 头已经发出去了，只能截断连接
    res.destroy()
  })
  stream.pipe(res)
}

/**
 * 处理一个静态请求。返回 true 表示已处理（调用方不要再走 API 路由）。
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticOptions,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  const url = new URL(req.url ?? '/', 'http://localhost')
  const prefix = options.prefix ?? '/admin'
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false

  const rest = url.pathname.slice(prefix.length)
  const wantsIndex = rest === '' || rest === '/'

  const candidate = resolveSafe(options.root, wantsIndex ? 'index.html' : rest)
  if (candidate === undefined) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad path')
    return true
  }

  if (!wantsIndex && (await isFile(candidate))) {
    // `/assets/xxx-HASH.js` 这种带哈希的产物才能 immutable
    const immutable = candidate.includes(`${sep}assets${sep}`)
    sendFile(req, res, candidate, immutable)
    return true
  }

  // SPA 回落。注意：只在前缀内回落，且**不含点**的路径才回落（
  // 否则一个不存在的 .js 会被当成 HTML 返回，浏览器报错更难查）
  const looksLikeAsset = rest.includes('.')
  if (looksLikeAsset) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return true
  }

  const indexPath = join(options.root, 'index.html')
  if (!(await isFile(indexPath))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('admin-ui 未构建：请在 packages/admin-ui 执行 pnpm build')
    return true
  }
  sendFile(req, res, indexPath, false)
  return true
}
