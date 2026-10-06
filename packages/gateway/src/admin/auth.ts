/**
 * 管理后台的鉴权 —— 口令、会话、审计、限流。
 *
 * ## 设计取舍（对着计划 §1.3「我们避这 5 条」逐条落地）
 *
 * 1. **不搞双轨鉴权**：所有 `/api/admin/*` 走同一套检查，没有"某个前缀跳过"的例外。
 * 2. **口令用 scrypt 加盐哈希**（N=16384, r=8, p=1, keylen=64），参数一并入库以便日后调参；
 *    绝不存明文，也不用 MD5/SHA1。
 * 3. **令牌只在 HttpOnly cookie 里**，不进 URL、不进 localStorage；服务端只存会话 id，
 *    不存口令也不存其派生值。
 * 4. **比较用 `timingSafeEqual`**，避免用比较耗时泄露信息。
 * 5. **失败也留痕**：登录失败、被限流都写审计 —— 安全事件没有证据等于没有安全。
 *
 * @module @forlife/gateway/admin/auth
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

/** scrypt 参数。存进库里，所以将来调参不会让旧口令失效。 */
export interface ScryptParams {
  readonly n: number
  readonly r: number
  readonly p: number
  readonly keyLength: number
}

/** 默认参数：约 80–120ms 一次校验，足够挡住暴力破解，又不至于让登录卡顿。 */
export const DEFAULT_SCRYPT: ScryptParams = { n: 16_384, r: 8, p: 1, keyLength: 64 }

/** 口令最小长度（前端也提示同一个值）。 */
export const MIN_PASSWORD_LENGTH = 8

/** 会话默认有效期：7 天。手机上长期免登录，但不算永久。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** cookie 名。 */
export const SESSION_COOKIE = 'forlife_admin'

/** 会话记录。 */
export interface SessionRow {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
}

/** 审计动作。 */
export type AuditAction = 'setup' | 'login' | 'login_failed' | 'logout' | 'password' | 'rate_limited' | 'api'

/** scrypt 的 Promise 包装（回调版写起来太啰嗦，且要在 await 之间做别的检查）。 */
function scryptKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      params.keyLength,
      { N: params.n, r: params.r, p: params.p, maxmem: 128 * params.n * params.r * 2 },
      (error, derived) => {
        if (error !== null) reject(error)
        else resolve(derived)
      },
    )
  })
}

/** 库里是否已经有口令（没有 ⇒ 前端走"首次设置"流程）。 */
export function hasCredential(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM admin_credential WHERE id = 1').get() as { ok?: number } | undefined
  return row !== undefined
}

/** 设置/修改口令。长度不足直接抛（服务端是最后一道校验，不能只靠前端）。 */
export async function setPassword(db: DatabaseSync, password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少 ${MIN_PASSWORD_LENGTH} 位`)
  }
  const salt = randomBytes(16)
  const key = await scryptKey(password, salt, params)
  db.prepare(
    `INSERT INTO admin_credential (id, algo, salt, hash, cost_n, block_size, parallel, key_length, updated_at)
     VALUES (1, 'scrypt', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       salt = excluded.salt, hash = excluded.hash,
       cost_n = excluded.cost_n, block_size = excluded.block_size, parallel = excluded.parallel,
       key_length = excluded.key_length, updated_at = excluded.updated_at`,
  ).run(
    salt.toString('hex'),
    key.toString('hex'),
    params.n,
    params.r,
    params.p,
    params.keyLength,
    nowIso(),
  )
}

/**
 * 校验口令。
 *
 * 注意：**没设置口令时返回 false**，而不是"通过"—— 否则首次运行等于没有门。
 * （首次设置走 `/api/admin/setup`，那条路只在没有口令时可用。）
 */
export async function verifyPassword(db: DatabaseSync, password: string): Promise<boolean> {
  const row = db
    .prepare('SELECT salt, hash, cost_n, block_size, parallel, key_length FROM admin_credential WHERE id = 1')
    .get() as
    | { salt: string; hash: string; cost_n: number; block_size: number; parallel: number; key_length: number }
    | undefined
  if (row === undefined) return false

  const params: ScryptParams = {
    n: row.cost_n,
    r: row.block_size,
    p: row.parallel,
    keyLength: row.key_length,
  }
  const expected = Buffer.from(row.hash, 'hex')
  const actual = await scryptKey(password, Buffer.from(row.salt, 'hex'), params)
  // 长度不一致时 timingSafeEqual 会抛，先挡一下
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** 新建会话，返回会话 id（写进 cookie）与过期时间。 */
export function createSession(
  db: DatabaseSync,
  options: { readonly ip?: string | undefined; readonly userAgent?: string | undefined; readonly ttlMs?: number },
): SessionRow {
  const id = randomBytes(32).toString('base64url')
  const now = Date.now()
  const ttl = options.ttlMs ?? SESSION_TTL_MS
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + ttl).toISOString()
  db.prepare(
    'INSERT INTO admin_sessions (id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, createdAt, expiresAt, createdAt, options.ip ?? null, options.userAgent?.slice(0, 300) ?? null)
  // 顺手清掉过期会话：省一个定时任务，且不会让表无界增长
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(createdAt)
  return { id, createdAt, expiresAt }
}

/**
 * 读会话。过期即删除并返回 undefined。
 *
 * `last_seen_at` 每 60 秒才写一次：面板会频繁轮询，每次都写库纯属浪费
 * （而且 SQLite 是单写者，写多了会拖慢别处）。
 */
export function readSession(db: DatabaseSync, id: string | undefined): SessionRow | undefined {
  if (id === undefined || id === '') return undefined
  const row = db
    .prepare('SELECT id, created_at, expires_at, last_seen_at FROM admin_sessions WHERE id = ?')
    .get(id) as { id: string; created_at: string; expires_at: string; last_seen_at: string } | undefined
  if (row === undefined) return undefined

  const now = Date.now()
  if (Date.parse(row.expires_at) <= now) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id)
    return undefined
  }
  if (now - Date.parse(row.last_seen_at) > 60_000) {
    db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), id)
  }
  return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at }
}

/** 删除一个会话（登出）。 */
export function deleteSession(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id)
}

/** 删除全部会话（改口令后必须做：其它设备立即掉线）。 */
export function deleteAllSessions(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM admin_sessions').run()
  return Number(result.changes)
}

/** 写一条审计。审计失败**不能**让业务失败，所以这里吞掉异常。 */
export function audit(
  db: DatabaseSync,
  entry: {
    readonly action: AuditAction
    readonly ok: boolean
    readonly actor?: string | undefined
    readonly ip?: string | undefined
    readonly path?: string | undefined
    readonly detail?: string | undefined
  },
): void {
  try {
    db.prepare('INSERT INTO admin_audit (id, at, action, ok, actor, ip, path, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      nowIso(),
      entry.action,
      entry.ok ? 1 : 0,
      entry.actor ?? null,
      entry.ip ?? null,
      entry.path ?? null,
      entry.detail?.slice(0, 500) ?? null,
    )
  } catch {
    // 审计表写不进去（磁盘满/表被删）不该把登录也搞崩，静默即可
  }
}

/** 限流策略：窗口内失败多少次就锁多久。 */
export interface RateLimitPolicy {
  readonly maxFailures: number
  readonly windowMs: number
  readonly lockMs: number
}

/** 默认：15 分钟内失败 5 次 → 锁 15 分钟。 */
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
}

interface Attempt {
  failures: number
  windowStart: number
  lockedUntil: number
}

/**
 * 登录限流（**内存态**）。
 *
 * 为什么不入库：这是短时高频的防护，重启后清零可以接受；
 * 入库反而会被攻击者用来放大写入。真正的长期证据在审计表里。
 */
export class LoginRateLimiter {
  readonly #attempts = new Map<string, Attempt>()
  readonly #policy: RateLimitPolicy

  constructor(policy: RateLimitPolicy = DEFAULT_RATE_LIMIT) {
    this.#policy = policy
  }

  /** 还能不能试。返回剩余锁定秒数（0 表示可以试）。 */
  lockedFor(key: string): number {
    const attempt = this.#attempts.get(key)
    if (attempt === undefined) return 0
    const now = Date.now()
    if (attempt.lockedUntil > now) return Math.ceil((attempt.lockedUntil - now) / 1000)
    return 0
  }

  /** 记一次失败；达到阈值就锁定。 */
  fail(key: string): void {
    const now = Date.now()
    const attempt = this.#attempts.get(key)
    if (attempt === undefined || now - attempt.windowStart > this.#policy.windowMs) {
      this.#attempts.set(key, { failures: 1, windowStart: now, lockedUntil: 0 })
      return
    }
    attempt.failures += 1
    if (attempt.failures >= this.#policy.maxFailures) {
      attempt.lockedUntil = now + this.#policy.lockMs
      attempt.failures = 0
      attempt.windowStart = now
    }
  }

  /** 成功后清空该来源的失败记录。 */
  succeed(key: string): void {
    this.#attempts.delete(key)
  }

  /** 仅供测试/运维观察。 */
  snapshot(): readonly { readonly key: string; readonly failures: number; readonly lockedSeconds: number }[] {
    const now = Date.now()
    return [...this.#attempts.entries()].map(([key, attempt]) => ({
      key,
      failures: attempt.failures,
      lockedSeconds: attempt.lockedUntil > now ? Math.ceil((attempt.lockedUntil - now) / 1000) : 0,
    }))
  }
}
