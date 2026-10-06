/**
 * `/api/admin/*` —— 主管理后台的接口。
 *
 * ## 统一规矩（每条都对应一个具体的坑）
 *
 * - **所有接口都过同一道鉴权**，没有"某个前缀免检"（AstrBot 的双轨鉴权是明确要避开的）。
 * - **状态变更必须带 `content-type: application/json`**，且 `Origin`（若有）必须同源 ——
 *   SameSite=Lax 已经挡掉大部分 CSRF，这两条是纵深防御，成本几乎为零。
 * - **口令绝不回显、绝不进 URL**；错误信息不区分"口令错"与"用户不存在"（这里只有单口令，
 *   所以统一回"口令不正确"），避免给出可枚举的信息。
 * - **失败也要审计**（含被限流），安全事件没有证据等于没有安全。
 *
 * @module @forlife/gateway/admin/api
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import {
  audit,
  createSession,
  deleteAllSessions,
  deleteSession,
  hasCredential,
  LoginRateLimiter,
  MIN_PASSWORD_LENGTH,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  setPassword,
  verifyPassword,
} from './auth.ts'
import { buildOverview } from './overview.ts'
import { queryCompaction, queryMemory } from './queries-memory.ts'
import { queryConversations, queryWake } from './queries-qq.ts'
import { queryPrompts, queryRouting } from './queries-model.ts'
import { buildSeries } from './series.ts'

/** 路由上下文。 */
export interface AdminApiOptions {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly startedAt: number
  readonly log?: (message: string) => void
  /** 由服务进程提供：是否已接管 QQ 连接（没接管就别猜）。 */
  readonly transportConnected?: (() => boolean | undefined) | undefined
  /** 会话时长（测试可缩短）。 */
  readonly sessionTtlMs?: number
}

/** 请求体大小上限：面板只发小 JSON，超过就是有人在试探。 */
const MAX_BODY_BYTES = 64 * 1024

/** 统一的 JSON 响应。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 从 cookie 头里取一个值。 */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** 客户端 IP（优先取反代头，Caddy 会带 X-Forwarded-For）。 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw !== '') return raw.split(',')[0]!.trim()
  return req.socket.remoteAddress ?? 'unknown'
}

/** 请求是否走的是 https（决定 cookie 要不要带 Secure）。 */
function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  const value = Array.isArray(proto) ? proto[0] : proto
  return value === 'https'
}

/** 写会话 cookie。 */
function setSessionCookie(req: IncomingMessage, res: ServerResponse, id: string, ttlMs: number): void {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ]
  // 本地 http 调试时不能带 Secure，否则浏览器直接不存 —— 这是最容易被自己坑到的一条
  if (isHttps(req)) parts.push('Secure')
  res.setHeader('set-cookie', parts.join('; '))
}

/** 清 cookie。 */
function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** 读 JSON 请求体（带大小上限）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 取字符串字段。 */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

/**
 * CSRF 纵深防御：状态变更请求要求 JSON 内容类型，且 `Origin`（若存在）与 Host 同源。
 *
 * 为什么不是"只靠 SameSite"：SameSite=Lax 对同站子域仍然放行；
 * 而面板将来可能挂在多域名下。两条独立检查一起用，漏一条还有另一条。
 */
function checkStateChange(req: IncomingMessage): string | undefined {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('application/json')) return '状态变更请求必须使用 application/json'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = req.headers.host
    try {
      if (host !== undefined && new URL(origin).host !== host) return 'Origin 与 Host 不一致'
    } catch {
      return 'Origin 非法'
    }
  }
  return undefined
}

/**
 * 创建 API 处理器。返回值：是否已处理该请求（false = 不是 `/api/admin/*`）。
 */
export function createAdminApi(options: AdminApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { db, dbPath, startedAt, log } = options
  const limiter = new LoginRateLimiter()
  const ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS

  const sessionOf = (req: IncomingMessage): { id: string; expiresAt: string } | undefined =>
    readSession(db, readCookie(req, SESSION_COOKIE))

  /**
   * 数据页路由表：路径 → 查询函数。
   *
   * 做成表而不是一串 if：新增页面时只加一行，且"哪些页面存在"一眼可见
   * （不会出现"实现了查询却忘了接线"这种沉默的漏）。
   */
  const DATA_ROUTES: Record<string, ((database: DatabaseSync) => unknown) | undefined> = {
    '/memory': (database) => queryMemory(database),
    '/compaction': (database) => queryCompaction(database),
    '/conversations': (database) => queryConversations(database),
    '/wake': (database) => queryWake(database),
    '/prompts': (database) => queryPrompts(database),
    '/routing': (database) => queryRouting(database),
  }

  /** 需要登录的接口统一在这里挡。 */
  function requireSession(req: IncomingMessage, res: ServerResponse, path: string): { id: string; expiresAt: string } | undefined {
    const session = sessionOf(req)
    if (session === undefined) {
      audit(db, { action: 'api', ok: false, ip: clientIp(req), path, detail: '未登录' })
      json(res, 401, { error: '未登录或会话已过期' })
      return undefined
    }
    return session
  }

  return async function handle(req, res): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return false
    const route = path.slice('/api/admin'.length) || '/'
    const method = req.method ?? 'GET'
    const ip = clientIp(req)

    try {
      // ── 会话状态：前端首屏就靠它决定显示登录页还是外壳 ──────────────
      if (route === '/session' && method === 'GET') {
        const needsSetup = !hasCredential(db)
        const session = sessionOf(req)
        json(res, 200, {
          authenticated: session !== undefined,
          needsSetup,
          ...(session === undefined ? {} : { expiresAt: session.expiresAt }),
        })
        return true
      }

      // ── 首次设置口令：只在**还没有口令**时可用 ──────────────────────
      if (route === '/setup' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        if (hasCredential(db)) {
          audit(db, { action: 'setup', ok: false, ip, path, detail: '已有口令，拒绝重复设置' })
          json(res, 409, { error: '口令已设置过，请直接登录' })
          return true
        }
        const body = await readJsonBody(req)
        const password = stringField(body, 'password')
        if (password.length < MIN_PASSWORD_LENGTH) {
          json(res, 400, { error: `口令至少 ${MIN_PASSWORD_LENGTH} 位` })
          return true
        }
        await setPassword(db, password)
        const session = createSession(db, { ip, userAgent: req.headers['user-agent'], ttlMs })
        setSessionCookie(req, res, session.id, ttlMs)
        audit(db, { action: 'setup', ok: true, actor: session.id.slice(0, 8), ip, path })
        log?.('[admin] 已设置管理口令并创建首个会话')
        json(res, 200, { authenticated: true, needsSetup: false, expiresAt: session.expiresAt })
        return true
      }

      // ── 登录 ────────────────────────────────────────────────────────
      if (route === '/login' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const locked = limiter.lockedFor(ip)
        if (locked > 0) {
          audit(db, { action: 'rate_limited', ok: false, ip, path, detail: `锁定 ${locked}s` })
          json(res, 429, { error: `尝试过于频繁，请 ${locked} 秒后再试` })
          return true
        }
        const body = await readJsonBody(req)
        const password = stringField(body, 'password')
        const ok = password !== '' && (await verifyPassword(db, password))
        if (!ok) {
          limiter.fail(ip)
          audit(db, { action: 'login_failed', ok: false, ip, path })
          json(res, 401, { error: '口令不正确' })
          return true
        }
        limiter.succeed(ip)
        const session = createSession(db, { ip, userAgent: req.headers['user-agent'], ttlMs })
        setSessionCookie(req, res, session.id, ttlMs)
        audit(db, { action: 'login', ok: true, actor: session.id.slice(0, 8), ip, path })
        json(res, 200, { authenticated: true, needsSetup: false, expiresAt: session.expiresAt })
        return true
      }

      // ── 登出 ────────────────────────────────────────────────────────
      if (route === '/logout' && method === 'POST') {
        const session = sessionOf(req)
        if (session !== undefined) {
          deleteSession(db, session.id)
          audit(db, { action: 'logout', ok: true, actor: session.id.slice(0, 8), ip, path })
        }
        clearSessionCookie(res)
        json(res, 200, { ok: true })
        return true
      }

      // ── 改口令：需要登录 + 当前口令 ─────────────────────────────────
      if (route === '/password' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const current = stringField(body, 'current')
        const next = stringField(body, 'next')
        if (!(await verifyPassword(db, current))) {
          audit(db, { action: 'password', ok: false, actor: session.id.slice(0, 8), ip, path, detail: '当前口令不正确' })
          json(res, 401, { error: '当前口令不正确' })
          return true
        }
        if (next.length < MIN_PASSWORD_LENGTH) {
          json(res, 400, { error: `新口令至少 ${MIN_PASSWORD_LENGTH} 位` })
          return true
        }
        await setPassword(db, next)
        // 改口令必须让**其它设备**立即掉线：这是"口令泄露后改密码"这个动作的全部意义
        const removed = deleteAllSessions(db)
        clearSessionCookie(res)
        audit(db, { action: 'password', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `注销 ${removed} 个会话` })
        json(res, 200, { ok: true, sessionsRemoved: removed })
        return true
      }

      // ── 运行总览 ────────────────────────────────────────────────────
      if (route === '/overview' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(
          res,
          200,
          buildOverview(db, {
            dbPath,
            startedAt,
            transportConnected: options.transportConnected?.(),
          }),
        )
        return true
      }

      // ── 运行图表：按小时分桶的时序 ──────────────────────────────────
      if (route === '/series' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const hoursParam = Number(url.searchParams.get('hours') ?? '24')
        json(res, 200, buildSeries(db, { hours: Number.isFinite(hoursParam) ? hoursParam : 24 }))
        return true
      }

      // ── 数据页：记忆 / 压缩 / 会话与队列 / 唤醒 / 提示词 / 路由与端点 ──────
      // 这些页面与 DSH 内嵌面板读**同一份库、同一套语义**（计划 §2.12：无第二真源）
      if (method === 'GET' && DATA_ROUTES[route] !== undefined) {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(res, 200, DATA_ROUTES[route]!(db))
        return true
      }

      json(res, 404, { error: `未知接口：${method} ${path}` })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log?.(`[admin] 接口异常 ${method} ${path}: ${message}`)
      json(res, 500, { error: message })
      return true
    }
  }
}
