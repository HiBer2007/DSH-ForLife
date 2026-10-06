/**
 * 端口出口：白名单、TTL、以及 `published_ports` 的读写。
 *
 * ## 为什么白名单必须在这一层
 *
 * PLAN 阶段 7 的验收是「**非白名单端口被拒绝并留下审计记录**」。
 * 如果白名单检查散在工具/接口/清理任务里，那么"某一条路径少写一句检查"
 * 就是一个**能把任意端口暴露到公网**的洞 —— 而且它不报错，只是默默地开了。
 * 所以检查只有一个入口 `checkPortAllowed`，所有路径都走它。
 *
 * ## 为什么"过期"要在读取时也算一遍
 *
 * 定时回收任务可能因为进程重启、异常而漏跑。只依赖定时任务的话，
 * **漏跑一次就等于一条永不过期的公开路由** —— 而这恰恰是最危险的状态
 * （没人记得它还在）。所以 `listActive` 每次都按 `expires_at` 过滤，
 * 定时任务只是"顺手清理"，不是"唯一保障"。
 *
 * @module @forlife/gateway/ports
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 默认允许发布的端口段。 */
export const DEFAULT_PORT_WHITELIST: readonly { readonly from: number; readonly to: number }[] = [
  { from: 8000, to: 8099 },
  { from: 3000, to: 3099 },
  { from: 5000, to: 5099 },
]

/** 端口检查结果。 */
export interface PortCheck {
  readonly ok: boolean
  readonly reason: string
}

/**
 * 检查端口是否在白名单内。
 *
 * 拒绝的理由要**具体**（说清允许哪些段），否则调用方只能猜。
 */
export function checkPortAllowed(
  port: number,
  whitelist: readonly { readonly from: number; readonly to: number }[] = DEFAULT_PORT_WHITELIST,
): PortCheck {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `端口必须是 1–65535 的整数，实际是 ${String(port)}` }
  }
  // 特权端口（<1024）单独拒：即使白名单被配错，也不该让工作区里的服务占系统端口
  if (port < 1024) {
    return { ok: false, reason: `不接受特权端口（<1024）：${String(port)}` }
  }
  const allowed = whitelist.some((range) => port >= range.from && port <= range.to)
  if (!allowed) {
    const shown = whitelist.map((r) => `${String(r.from)}–${String(r.to)}`).join('、')
    return { ok: false, reason: `端口 ${String(port)} 不在白名单内（允许：${shown || '（空）'}）` }
  }
  return { ok: true, reason: '在白名单内' }
}

/** 路由名检查：它会被拼进 URL（`/svc/<name>/`），所以必须严格。 */
export function checkRouteName(name: string): PortCheck {
  if (name.trim() === '') return { ok: false, reason: '名字不能为空' }
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    return {
      ok: false,
      reason: `名字只能是小写字母/数字/连字符，且以字母或数字开头（1–31 位）：${name}`,
    }
  }
  // 保留名：它们会和面板自己的路径打架
  if (['admin', 'api', 'svc', 'health'].includes(name)) {
    return { ok: false, reason: `「${name}」是保留名（会和面板自己的路径冲突）` }
  }
  return { ok: true, reason: '合法' }
}

/** 一条发布记录。 */
export interface PublishedPortRow {
  readonly id: string
  readonly name: string
  readonly target_port: number
  readonly protocol: string
  readonly caddy_route_id: string | null
  readonly ttl_seconds: number | null
  readonly expires_at: string | null
  readonly approved_by: string
  readonly note: string | null
  readonly created_at: string
}

/** 发布输入。 */
export interface PublishPortInput {
  readonly name: string
  readonly targetPort: number
  readonly protocol?: 'http' | 'tcp'
  readonly ttlSeconds?: number | null
  readonly approvedBy: string
  readonly note?: string | undefined
  readonly whitelist?: readonly { readonly from: number; readonly to: number }[]
  readonly now?: Date
}

/** 发布结果。 */
export interface PublishPortResult {
  readonly ok: boolean
  readonly reason: string
  readonly row?: PublishedPortRow
}

/**
 * 登记一条发布（**只写库，不碰 Caddy**）。
 *
 * 把"登记"与"配置 Caddy"分开：Caddy 可能失败，而失败时我们要能**明确回滚登记**
 * （否则库里有一条"看起来发布了"但实际不通的记录，比不发布更误导人）。
 * 编排那一层负责"登记 → 配 Caddy → 失败则撤销登记"。
 */
export function publishPort(db: DatabaseSync, input: PublishPortInput): PublishPortResult {
  const nameCheck = checkRouteName(input.name)
  if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason }

  const portCheck = checkPortAllowed(input.targetPort, input.whitelist ?? DEFAULT_PORT_WHITELIST)
  if (!portCheck.ok) return { ok: false, reason: portCheck.reason }

  const existing = db.prepare('SELECT id FROM published_ports WHERE name = ?').get(input.name) as { id: string } | undefined
  if (existing !== undefined) {
    return { ok: false, reason: `名字「${input.name}」已被占用（换一个，或先取消原来那条）` }
  }

  const now = (input.now ?? new Date()).toISOString()
  const ttl = input.ttlSeconds ?? null
  if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0)) {
    return { ok: false, reason: `TTL 必须是正数秒（或不给表示不过期），实际是 ${String(input.ttlSeconds)}` }
  }
  const expiresAt = ttl === null ? null : new Date((input.now ?? new Date()).getTime() + ttl * 1000).toISOString()

  const id = `pp_${randomUUID()}`
  db.prepare(
    `INSERT INTO published_ports
       (id, name, target_port, protocol, caddy_route_id, ttl_seconds, expires_at, approved_by, note, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.targetPort, input.protocol ?? 'http', ttl, expiresAt, input.approvedBy, input.note ?? null, now)

  const row = db.prepare('SELECT * FROM published_ports WHERE id = ?').get(id) as unknown as PublishedPortRow
  return { ok: true, reason: '已登记', row }
}

/** 记下 Caddy 的路由 id（回收时要按它删）。 */
export function setCaddyRouteId(db: DatabaseSync, id: string, routeId: string): void {
  db.prepare('UPDATE published_ports SET caddy_route_id = ? WHERE id = ?').run(routeId, id)
}

/** 列出**仍然有效**的发布（按 `expires_at` 过滤，不依赖定时任务）。 */
export function listActivePorts(db: DatabaseSync, now: Date = new Date()): readonly PublishedPortRow[] {
  const at = now.toISOString()
  return db
    .prepare('SELECT * FROM published_ports WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC')
    .all(at) as unknown as PublishedPortRow[]
}

/** 列出**已过期**的发布（回收任务用）。 */
export function listExpiredPorts(db: DatabaseSync, now: Date = new Date()): readonly PublishedPortRow[] {
  return db
    .prepare('SELECT * FROM published_ports WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at')
    .all(now.toISOString()) as unknown as PublishedPortRow[]
}

/** 删除一条发布记录（Caddy 侧删除由调用方负责）。 */
export function removePort(db: DatabaseSync, id: string): PublishedPortRow | undefined {
  const row = db.prepare('SELECT * FROM published_ports WHERE id = ?').get(id) as unknown as PublishedPortRow | undefined
  if (row === undefined) return undefined
  db.prepare('DELETE FROM published_ports WHERE id = ?').run(id)
  return row
}
