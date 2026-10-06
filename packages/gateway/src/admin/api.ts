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
import { setWakeRule, type WakeCondition } from '../wake.ts'
import { activePrompt, deleteModelRoute, listModelRoutes, PROMPT_SLUGS, rollbackPrompt, savePromptRevision, setConversationClock, setConversationImpression, setConversationNote, upsertModelRoute, type PromptSlug, deleteWakeTrigger, getWakeTrigger, setWakePaused, updateWakeTrigger } from '@forlife/store'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { FLAG_QQ_TAKEOVER, getFlag, setFlag } from '@forlife/store'

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
import { queryMedia } from './queries-media.ts'
import { queryConversation } from './queries-conversation.ts'
import { queryWakes } from './queries-wakes.ts'
import { archiveLongMemory, restoreLongMemory, updateLongMemory } from './memory-write.ts'
import { backupNow } from './storage-write.ts'
import { setState } from '@forlife/store'
import { deleteStickerAsset, updateStickerDescription } from './sticker-write.ts'
import { queryStickers, readStickerBytes } from './queries-stickers.ts'
import { queryStorage } from './queries-storage.ts'
import type { LogBuffer } from './log-buffer.ts'
import type { PortService } from '../port-service.ts'
import { enqueueOutbound } from '../outbox.ts'
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
  /**
   * NapCat 的 WebUI 位置（用于面板里的「NapCat」页）。
   *
   * 为什么由服务端告诉前端，而不是前端写死：前端不知道"用户是从哪台机器访问的"。
   * 手机访问时 `127.0.0.1:6099` 指的是**手机自己**，必然打不开 ——
   * 所以只回端口与 token，主机名由前端按当前地址栏推导。
   */
  readonly napcat?: { readonly webuiPort: number; readonly token?: string | undefined } | undefined
  /** 内存日志缓冲（没给则日志页显示空，不报错）。 */
  readonly logBuffer?: LogBuffer | undefined
  /** 端口出口（未配置时为 undefined ⇒ 界面显示原因并禁用按钮）。 */
  readonly ports?:
    | {
        readonly service?: PortService | undefined
        readonly disabledReason?: string | undefined
        readonly whitelist: readonly { readonly from: number; readonly to: number }[]
      }
    | undefined
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

      // ── NapCat 面板页所需的信息（同源策略下前端自己拼不出正确主机名）──────
      if (route === '/napcat' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const status = options.transportConnected?.()
        json(res, 200, {
          webuiPort: options.napcat?.webuiPort ?? 6099,
          ...(options.napcat?.token === undefined ? {} : { token: options.napcat.token }),
          // 真实连接状态：undefined = 本服务没接管，前端显示"未知"而不是"离线"
          ...(status === undefined ? {} : { connected: status }),
        })
        return true
      }

      // ── 手动发消息（接管模式下运维自己回复，也是"用 QQ 通知人"的通路）──────
      if (route === '/send' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const conversationKey = stringField(body, 'conversationKey').trim()
        const text = stringField(body, 'text')
        if (conversationKey === '' || text.trim() === '') {
          json(res, 400, { error: 'conversationKey 与 text 都必填' })
          return true
        }
        // 会话类型从会话表读（出站表那一列 NOT NULL，猜错会让平台侧行为不对）
        const known = db.prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?').get(conversationKey) as
          | { kind: string }
          | undefined
        const kind = known?.kind ?? (conversationKey.includes(':group') ? 'group' : 'private')
        const id = enqueueOutbound(db, {
          conversationKey,
          kind: 'text',
          payload: { segments: [{ kind: 'text', text }] },
          conversationKind: kind === 'group' ? 'group' : 'private',
          source: 'admin',
        })
        // 手动发过消息 ⇒ 这个会话里积压的消息就算"处理过了"。
        // 不做这一步的话，接管模式下运维回完了消息、面板上却永远显示"待处理 N 条" ——
        // 那个数字会变成一个没人相信的计数器（正是之前踩过的坑的另一种形态）。
        const handled = db
          .prepare('UPDATE qq_inbox SET processed = 1 WHERE conversation_key = ? AND processed = 0')
          .run(conversationKey)
        audit(db, {
          action: 'api',
          ok: true,
          actor: session.id.slice(0, 8),
          ip,
          path,
          detail: `手动发送到 ${conversationKey}；顺带标记 ${String(Number(handled.changes))} 条为已处理`,
        })
        json(res, 200, { ok: true, id, handled: Number(handled.changes) })
        return true
      }

      // ── 接管模式：消息只入库、不路由给模型（运维手动处理）──────────────
      if (route === '/takeover' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const changedAt = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(`${FLAG_QQ_TAKEOVER}_changed_at`) as
          | { value?: string }
          | undefined
        json(res, 200, {
          on: getFlag(db, FLAG_QQ_TAKEOVER),
          ...(changedAt?.value === undefined ? {} : { changedAt: changedAt.value }),
        })
        return true
      }

      if (route === '/takeover' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        if (typeof body['on'] !== 'boolean') {
          json(res, 400, { error: 'on 必须是布尔值' })
          return true
        }
        setFlag(db, FLAG_QQ_TAKEOVER, body['on'], `by ${session.id.slice(0, 8)}`)
        audit(db, {
          action: 'api',
          ok: true,
          actor: session.id.slice(0, 8),
          ip,
          path,
          detail: `接管模式 → ${body['on'] ? '开' : '关'}`,
        })
        log?.(`[admin] 接管模式 ${body['on'] ? '已开启' : '已关闭'}`)
        json(res, 200, { on: body['on'] })
        return true
      }

      // ── 会话详情（子窗口的读接口）──────────────────────────────────
      // 一次给全：基础信息 + 时区 + 备注 + 画像 + 唤醒规则 + 留痕。
      // 分成多个接口的话，面板会出现"一半有数据一半转圈"的中间态，
      // 而那恰恰是用户判断"这个会话到底怎么了"时看的。
      if (route === '/conversation' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const key = url.searchParams.get('id') ?? ''
        if (key === '') {
          json(res, 400, { error: '缺少 id（会话键）' })
          return true
        }
        const detail = queryConversation(db, key)
        if (detail === undefined) {
          // 明确 404 而不是返回空壳 —— 空壳会让面板显示一个"什么都是 0"的会话，
          // 让人以为是数据丢了
          json(res, 404, { error: `没有这个会话：${key}` })
          return true
        }
        json(res, 200, detail)
        return true
      }

      // ── 会话备注（写；**只有人能写**）──────────────────────────────
      // 刻意不提供"模型写备注"的接口：备注是用户的权威说明，
      // 模型能写的话，它一次自动总结就会覆盖掉，而用户不会收到任何提示。
      if (route === '/conversation-note' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const key = typeof body['conversationKey'] === 'string' ? body['conversationKey'] : ''
        if (key === '') {
          json(res, 400, { error: 'conversationKey 必填' })
          return true
        }
        const note = typeof body['note'] === 'string' ? body['note'] : null
        setConversationNote(db, { conversationKey: key, note, updatedBy: session.id.slice(0, 8) })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `备注 ${key} → ${note === null ? '(清空)' : `${String(note.length)} 字`}` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 唤醒引擎（PLAN 阶段 8 交付物 7）──────────────────────────
      if (route === '/wakes' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(res, 200, queryWakes(db))
        return true
      }

      if (route === '/wake-pause' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const paused = body['paused'] === true
        setWakePaused(db, paused)
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: paused ? '唤醒引擎：全局暂停' : '唤醒引擎：恢复' })
        json(res, 200, { ok: true, paused })
        return true
      }

      if (route === '/wake-toggle' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const enabled = body['enabled'] === true
        if (getWakeTrigger(db, id) === undefined) { json(res, 404, { error: `没有这条触发器：${id}` }); return true }
        updateWakeTrigger(db, id, { enabled })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `触发器 ${id} ${enabled ? '启用' : '停用'}` })
        json(res, 200, { ok: true })
        return true
      }

      if (route === '/wake-cancel' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const row = getWakeTrigger(db, id)
        if (row === undefined) { json(res, 404, { error: `没有这条触发器：${id}` }); return true }
        deleteWakeTrigger(db, id)
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `取消触发器「${row.title}」` })
        json(res, 200, { ok: true })
        return true
      }

      if (route === '/wake-now' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const row = getWakeTrigger(db, id)
        if (row === undefined) { json(res, 404, { error: `没有这条触发器：${id}` }); return true }
        // 与工具侧同一条通道：设成"现在"⇒ 下一次 tick 就扫到（对**所有类型**有效）
        updateWakeTrigger(db, id, { nextFireAt: new Date().toISOString() })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `立刻执行触发器「${row.title}」` })
        json(res, 200, { ok: true, note: '已请求立刻执行，gateway 侧下一次 tick（≤1 秒）处理' })
        return true
      }

      // ── 端口出口：列表 / 发布 / 取消 ───────────────────────────────
      if (route === '/ports' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const ports = options.ports
        // **未启用回 200**（不是 4xx）：没配 Caddy 是部署状态、不是请求错误。
        // 回 4xx 会让面板显示成"操作失败"，而用户会反复重试一个不可能成功的操作。
        json(res, 200, {
          enabled: ports?.service !== undefined,
          ...(ports?.disabledReason === undefined ? {} : { disabledReason: ports.disabledReason }),
          whitelist: ports?.whitelist ?? [],
          rows: ports?.service?.list() ?? [],
        })
        return true
      }

      if (route === '/port-publish' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const service = options.ports?.service
        if (service === undefined) {
          json(res, 400, { error: options.ports?.disabledReason ?? '端口出口未启用' })
          return true
        }
        const body = await readJsonBody(req)
        const name = typeof body['name'] === 'string' ? body['name'] : ''
        const targetPort = Number(body['targetPort'])
        const ttlRaw = body['ttlSeconds']
        const ttlSeconds = ttlRaw === null || ttlRaw === undefined ? null : Number(ttlRaw)
        const protocol = body['protocol'] === 'tcp' ? ('tcp' as const) : ('http' as const)
        const listenRaw = body['listenPort']
        const listenPort = listenRaw === null || listenRaw === undefined ? null : Number(listenRaw)

        const result = await service.publish({
          name,
          targetPort,
          protocol,
          listenPort,
          ttlSeconds,
          approvedBy: `admin:${session.id.slice(0, 8)}`,
          ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
        })
        // **被拒的也要审计**："有人试图暴露一个非白名单端口"本身就是需要知道的事
        audit(db, {
          action: 'api', ok: result.ok, actor: session.id.slice(0, 8), ip, path,
          detail: result.ok ? `发布端口 ${name} → ${String(targetPort)}` : `发布端口被拒（${name}/${String(targetPort)}）：${result.reason}`,
        })
        json(res, result.ok ? 200 : 400, result.ok ? { ok: true, url: service.urlFor(result.row!) } : { error: result.reason })
        return true
      }

      if (route === '/port-unpublish' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const service = options.ports?.service
        if (service === undefined) {
          json(res, 400, { error: options.ports?.disabledReason ?? '端口出口未启用' })
          return true
        }
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const result = await service.unpublish(id)
        audit(db, {
          action: 'api', ok: result.ok, actor: session.id.slice(0, 8), ip, path,
          detail: result.ok ? `取消端口发布 ${id}` : `取消端口发布失败（${id}）：${result.reason}`,
        })
        json(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.reason })
        return true
      }

      // ── 压缩：写一条"请求压缩"（**执行在 DSH 侧**）────────────────
      // 压缩引擎深度依赖 DSH 框架，网关跑不了它；而压缩需要模型调用，那也只在 DSH 侧有。
      // 所以面板只写请求，DSH 侧读到后执行 —— **压缩逻辑只有一份**，
      // 不会出现"面板点的压缩和自动压缩效果不一样"。
      if (route === '/compaction-request' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const at = new Date().toISOString()
        setState(db, 'compaction_request_at', at)
        setState(db, 'compaction_request_by', `admin:${session.id.slice(0, 8)}`)
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `请求压缩 @ ${at}` })
        json(res, 200, { ok: true, requestedAt: at, note: '已记录请求；DSH 侧会在下一轮或下次启动时执行' })
        return true
      }

      // ── 存储：立即备份（**非破坏性**）──────────────────────────────
      // 为什么加的是备份而不是清理：清理是破坏性动作，该走明确流程（先备份、再确认、可回滚），
      // 不该是顺手一点的界面按钮 —— 存储页原本「刻意没有按钮」的理由仍然成立。
      // 但"能看见备份清单、却不能在面板里做一份备份"正是用户抱怨的那类问题，
      // 而流程第一步就是"先备份"。所以补这个安全动作。
      if (route === '/backup-now' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const result = backupNow(db, { dbPath })
        audit(db, {
          action: 'api', ok: result.ok, actor: session.id.slice(0, 8), ip, path,
          detail: result.ok ? `立即备份 → ${result.path ?? ''}` : `立即备份失败：${result.reason}`,
        })
        if (!result.ok) { json(res, 500, { error: result.reason }); return true }
        json(res, 200, { ok: true, path: result.path, sizeBytes: result.sizeBytes })
        return true
      }

      // ── 日志：清空缓冲（危险操作，必须留痕）──────────────────────
      if (route === '/logs-clear' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const removed = options.logBuffer?.clear() ?? 0
        // 日志是排障依据，清空会**销毁证据** ⇒ 必须落审计（谁、何时、清了多少）
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `清空日志缓冲（${String(removed)} 条）` })
        json(res, 200, { ok: true, removed })
        return true
      }

      // ── 提示词：取某个槽位的**全文**（编辑前必须拿全文，不能拿预览）──
      if (route === '/prompt-text' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const slug = url.searchParams.get('slug') ?? ''
        if (!(PROMPT_SLUGS as readonly string[]).includes(slug)) {
          json(res, 400, { error: `未知槽位：${slug}` })
          return true
        }
        const active = activePrompt(db, slug as PromptSlug)
        // 没有版本时返回空串而不是 404：**"还没写过"是一种正常状态**，
        // 404 会让面板显示成错误，而用户其实只是还没编辑过
        json(res, 200, { slug, text: active?.text ?? '', revisionId: active?.id ?? null })
        return true
      }

      // ── 提示词：保存新版本 ─────────────────────────────────────────
      if (route === '/prompt-revision' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)

        const slug = typeof body['slug'] === 'string' ? body['slug'] : ''
        if (!(PROMPT_SLUGS as readonly string[]).includes(slug)) {
          json(res, 400, { error: `未知槽位：${slug}（只允许 ${PROMPT_SLUGS.join(' / ')}）` })
          return true
        }
        const text = typeof body['text'] === 'string' ? body['text'] : ''

        // 校验交给 savePromptRevision —— 它内部做 validatePromptText + 规范化 + 指纹。
        // 在这里再写一套变量名检查，两套规则迟早分叉，
        // 而分叉的表现是"面板说保存成功了，实际被拒了"。
        const result = savePromptRevision(db, {
          slug: slug as PromptSlug,
          text,
          createdBy: `admin:${session.id.slice(0, 8)}`,
          ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
        })
        if (!result.ok) {
          // 校验失败要把**每一条**错误都返回：只回第一条的话，
          // 用户改完一条又冒出下一条，来回好几轮
          json(res, 400, { error: result.errors.join('；'), errors: result.errors })
          return true
        }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `提示词 ${slug} 保存（${result.changed ? '新版本' : '内容未变，未造新版本'}）` })
        json(res, 200, { ok: true, changed: result.changed, revisionId: result.revision.id })
        return true
      }

      // ── 提示词：回滚到某个版本 ─────────────────────────────────────
      if (route === '/prompt-rollback' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const revisionId = typeof body['revisionId'] === 'string' ? body['revisionId'] : ''
        if (revisionId === '') { json(res, 400, { error: 'revisionId 必填' }); return true }

        const revision = rollbackPrompt(db, revisionId)
        if (revision === undefined) {
          // 版本不存在要**明确报错**，而不是静默返回成功 ——
          // 静默成功会让用户以为回滚生效了，实际提示词一个字都没变
          json(res, 404, { error: `没有这个版本：${revisionId}` })
          return true
        }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `提示词回滚 → ${revisionId}` })
        json(res, 200, { ok: true, revisionId: revision.id })
        return true
      }

      // ── 记忆条目：编辑正文与摘要 ───────────────────────────────────
      if (route === '/memory-entry' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const content = typeof body['content'] === 'string' ? body['content'] : ''
        const summary = typeof body['summary'] === 'string' ? body['summary'] : ''
        const entities = Array.isArray(body['entities'])
          ? body['entities'].filter((e): e is string => typeof e === 'string' && e.trim() !== '')
          : []
        if (id === '') { json(res, 400, { error: 'id 必填' }); return true }

        const result = updateLongMemory(db, { id, content, summary, entities })
        if (!result.ok) { json(res, 400, { error: result.reason }); return true }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `记忆 ${id} 已编辑（${String(content.length)} 字）` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 记忆条目：归档 / 恢复（**不是真删**）────────────────────────
      if (route === '/memory-archive' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        if (id === '') { json(res, 400, { error: 'id 必填' }); return true }

        // restore=true 走恢复；默认归档。用一个接口而不是两个：
        // 它们是同一个动作的两个方向，分成两个接口会让前端要判断该调哪个。
        const result = body['restore'] === true ? restoreLongMemory(db, id) : archiveLongMemory(db, id)
        if (!result.ok) { json(res, 400, { error: result.reason }); return true }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `记忆 ${id} ${body['restore'] === true ? '恢复' : '归档'}` })
        json(res, 200, { ok: true, message: result.reason })
        return true
      }

      // ── 表情库：改描述/标签 ────────────────────────────────────────
      if (route === '/sticker-description' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const assetId = typeof body['assetId'] === 'string' ? body['assetId'] : ''
        const description = typeof body['description'] === 'string' ? body['description'] : ''
        const tags = Array.isArray(body['emotionTags'])
          ? body['emotionTags'].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          : []
        if (assetId === '') { json(res, 400, { error: 'assetId 必填' }); return true }

        const result = updateStickerDescription(db, { assetId, description, emotionTags: tags, updatedBy: session.id.slice(0, 8) })
        if (!result.ok) { json(res, 400, { error: result.reason }); return true }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `表情描述 ${assetId} → ${String(description.length)} 字 / ${String(tags.length)} 标签` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 表情库：删除（标记为 rejected，保留指纹与判定）──────────────
      if (route === '/sticker-delete' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) { json(res, 400, { error: guard }); return true }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const assetId = typeof body['assetId'] === 'string' ? body['assetId'] : ''
        if (assetId === '') { json(res, 400, { error: 'assetId 必填' }); return true }

        const result = deleteStickerAsset(db, { assetId, reason: `by ${session.id.slice(0, 8)}` })
        if (!result.ok) { json(res, 400, { error: result.reason }); return true }
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `删除表情 ${assetId}` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 路由行（增 / 改）──────────────────────────────────────────
      if (route === '/model-route' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)

        const role = typeof body['role'] === 'string' ? body['role'].trim() : ''
        const provider = typeof body['provider'] === 'string' ? body['provider'].trim() : ''
        const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
        const rank = typeof body['rank'] === 'number' && Number.isFinite(body['rank']) ? Math.max(0, Math.floor(body['rank'])) : 0
        if (role === '' || provider === '' || model === '') {
          json(res, 400, { error: 'role / provider / model 都必填' })
          return true
        }

        // effort 允许 null（表示"不指定"，各端点用自己的默认值）——
        // 传空串进来会写成一个空值，面板显示的和实际生效的就不一致了
        const effort = typeof body['effort'] === 'string' && body['effort'].trim() !== '' ? body['effort'].trim() : null

        const id = upsertModelRoute(db, {
          role,
          rank,
          provider,
          model,
          reasoningEffort: effort,
          enabled: body['enabled'] !== false,
          note: typeof body['note'] === 'string' ? body['note'] : null,
          updatedBy: session.id.slice(0, 8),
        })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `路由 ${role}#${String(rank)} → ${provider}/${model}（effort=${effort ?? '不指定'}）` })
        json(res, 200, { ok: true, id })
        return true
      }

      // ── 路由行（删）────────────────────────────────────────────────
      if (route === '/model-route-delete' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const role = typeof body['role'] === 'string' ? body['role'] : ''
        const rank = typeof body['rank'] === 'number' ? body['rank'] : -1
        if (role === '' || rank < 0) {
          json(res, 400, { error: 'role 与 rank 必填' })
          return true
        }
        const removed = deleteModelRoute(db, role, rank)
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `删除路由 ${role}#${String(rank)}（${String(removed)} 行）` })
        json(res, 200, { ok: true, removed })
        return true
      }

      // ── 路由行（上下移）─────────────────────────────────────────────
      if (route === '/model-route-move' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const role = typeof body['role'] === 'string' ? body['role'] : ''
        const rank = typeof body['rank'] === 'number' ? body['rank'] : -1
        const direction = body['direction'] === 'up' ? 'up' : body['direction'] === 'down' ? 'down' : ''
        if (role === '' || rank < 0 || direction === '') {
          json(res, 400, { error: 'role / rank / direction(up|down) 必填' })
          return true
        }

        const rows = listModelRoutes(db, role)
        const target = rank + (direction === 'up' ? -1 : 1)
        if (target < 0 || target >= rows.length) {
          json(res, 400, { error: `已经在${direction === 'up' ? '最前' : '最后'}了` })
          return true
        }
        const a = rows[rank]
        const b = rows[target]
        if (a === undefined || b === undefined) {
          json(res, 400, { error: '找不到要交换的两行' })
          return true
        }

        // UNIQUE(role, rank)：直接交换会在中间那步撞唯一约束（先写 a=target 时 b 还是 target）。
        // 所以先把 a 挪到临时高位，再落位 —— 这是唯一安全的顺序。
        const TEMP = 9000
        db.prepare('UPDATE model_routes SET rank = ? WHERE id = ?').run(TEMP, a.id)
        db.prepare('UPDATE model_routes SET rank = ? WHERE id = ?').run(rank, b.id)
        db.prepare('UPDATE model_routes SET rank = ? WHERE id = ?').run(target, a.id)

        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `路由 ${role}：${String(rank)} ↔ ${String(target)}` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 会话时区（写；**人工设置**，标 user_set）────────────────────
      if (route === '/conversation-timezone' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const key = typeof body['conversationKey'] === 'string' ? body['conversationKey'] : ''
        const timezone = typeof body['timezone'] === 'string' ? body['timezone'].trim() : ''
        if (key === '' || timezone === '') {
          json(res, 400, { error: 'conversationKey 与 timezone 都必填' })
          return true
        }
        // 校验时区名：写进去一个拼错的名字，之后这个会话的**所有时间表述都会错**，
        // 而且不会报错（只是算出来的时间不对）—— 这是最难发现的一类问题。
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: timezone })
        } catch {
          json(res, 400, { error: `不是合法时区名：${timezone}（应形如 Asia/Shanghai）` })
          return true
        }
        // 复用 store 里既有的 setConversationClock（它带来源分级与校验），
        // 不重写一套 —— 两套校验迟早分叉。
        // 来源固定 user_set：面板上改是**人明确做的决定**，优先级最高；
        // 不这么标的话，模型/小模型之后的自动判断会按优先级把它覆盖掉。
        setConversationClock(db, {
          scope: key,
          timezone,
          hour24: body['hour24'] !== false,
          source: 'user_set',
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
          updatedBy: session.id.slice(0, 8),
        })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `时区 ${key} → ${timezone}` })
        json(res, 200, { ok: true })
        return true
      }

      // ── 会话画像（写；模型与人都能改，但人改过之后模型不该覆盖）────
      if (route === '/conversation-impression' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)
        const key = typeof body['conversationKey'] === 'string' ? body['conversationKey'] : ''
        if (key === '') {
          json(res, 400, { error: 'conversationKey 必填' })
          return true
        }
        const impression = typeof body['impression'] === 'string' ? body['impression'] : null
        // 从面板改的 ⇒ source='user'，此后模型自动更新不会覆盖它
        const written = setConversationImpression(db, {
          conversationKey: key,
          impression,
          source: 'user',
          updatedBy: session.id.slice(0, 8),
        })
        audit(db, { action: 'api', ok: true, actor: session.id.slice(0, 8), ip, path, detail: `画像 ${key} → ${written ? '已保存（标记为用户修正）' : '未写入'}` })
        json(res, 200, { ok: true, written })
        return true
      }

      // ── 唤醒规则（写）──────────────────────────────────────────────
      // 用户硬要求：「整个后台只准我看、没有写编辑入口，这个必须要补充」。
      // 作用域传 '*' 就是改**全局默认**（wake_rules 里 scope='*' 的那些行）。
      if (route === '/wake-rule' && method === 'POST') {
        const guard = checkStateChange(req)
        if (guard !== undefined) {
          json(res, 400, { error: guard })
          return true
        }
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const body = await readJsonBody(req)

        const scope = typeof body['scope'] === 'string' && body['scope'] !== '' ? body['scope'] : '*'
        const condition = body['condition']
        if (typeof condition !== 'string' || condition === '') {
          json(res, 400, { error: 'condition 必须是非空字符串' })
          return true
        }

        // 只接受已知字段，**不接受任意键** —— 否则前端一个拼写错误会被静默忽略，
        // 表现为"点了保存但没生效"，最难查。
        const patch: Record<string, unknown> = {}
        for (const key of ['enabled', 'probability', 'minIntervalMs', 'dailyLimit', 'quietUntil'] as const) {
          if (body[key] !== undefined) patch[key] = body[key]
        }
        if (Object.keys(patch).length === 0) {
          json(res, 400, { error: '没有要改的字段（enabled / probability / minIntervalMs / dailyLimit / quietUntil）' })
          return true
        }
        // 类型校验：数字字段必须是有限数，布尔字段必须是布尔 ——
        // 传字符串 '50' 进来如果被 SQLite 收下，面板显示的和实际生效的就会不一致
        for (const key of ['probability', 'minIntervalMs', 'dailyLimit'] as const) {
          const value = patch[key]
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
            json(res, 400, { error: `${key} 必须是数字` })
            return true
          }
        }
        if (patch['enabled'] !== undefined && typeof patch['enabled'] !== 'boolean') {
          json(res, 400, { error: 'enabled 必须是布尔值' })
          return true
        }
        if (patch['quietUntil'] !== undefined && patch['quietUntil'] !== null && typeof patch['quietUntil'] !== 'string') {
          json(res, 400, { error: 'quietUntil 必须是字符串或 null' })
          return true
        }

        const updated = setWakeRule(
          db,
          scope,
          condition as WakeCondition,
          patch as Parameters<typeof setWakeRule>[3],
          'admin',
        )
        audit(db, {
          action: 'api',
          ok: true,
          actor: session.id.slice(0, 8),
          ip,
          path,
          detail: `唤醒规则 ${scope}/${condition} → ${JSON.stringify(patch)}`,
        })
        log?.(`[admin] 唤醒规则 ${scope}/${condition} 已更新`)
        json(res, 200, { rule: updated })
        return true
      }

      // 存储页要 dbPath，所以不能进上面那张纯函数表
      if (route === '/storage' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(res, 200, queryStorage(db, { dbPath }))
        return true
      }

      // ── 表情与媒体 ─────────────────────────────────────────────────
      if (route === '/media' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(res, 200, queryMedia(db))
        return true
      }

      // ── 实时日志（内存缓冲；since 用于增量拉取）────────────────────────
      if (route === '/logs' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const buffer = options.logBuffer
        if (buffer === undefined) {
          json(res, 200, { lines: [], sequence: 0, size: 0, capacity: 0 })
          return true
        }
        const since = Number(url.searchParams.get('since') ?? '0')
        const limit = Number(url.searchParams.get('limit') ?? '200')
        const lines = Number.isFinite(since) && since > 0 ? buffer.since(since, limit) : buffer.tail(limit)
        json(res, 200, { lines, sequence: buffer.sequence, size: buffer.size, capacity: buffer.capacity })
        return true
      }

      // ── 表情库 ──────────────────────────────────────────────────────
      if (route === '/stickers' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        json(res, 200, queryStickers(db))
        return true
      }

      // 图片字节。**只按 id 取库里登记过的路径** ——
      // 若允许调用方传路径，这个接口就是"按路径读服务器任意文件"的洞。
      if (route === '/sticker-file' && method === 'GET') {
        const session = requireSession(req, res, path)
        if (session === undefined) return true
        const id = url.searchParams.get('id') ?? ''
        const found = readStickerBytes(db, id)
        if (!found.ok) {
          json(res, 404, { error: found.reason })
          return true
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.bytes.length,
          // 内容按 sha256 命名 ⇒ 同一个 id 的字节不会变，可以长缓存；
          // 但必须是 private（这是登录后才能看的东西，不能被共享缓存留存）
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        })
        res.end(found.bytes)
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
