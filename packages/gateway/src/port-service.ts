/**
 * 端口出口的编排层：把"登记"与"配 Caddy"接起来（PLAN 阶段 7 交付物 4+5）。
 *
 * ## 两个方向的顺序是**刻意相反**的
 *
 * | 动作 | 顺序 | 为什么 |
 * |---|---|---|
 * | **发布** | 先登记，再配 Caddy；**Caddy 失败则撤销登记** | 失败时不能留下"看起来发布了"的记录 —— 那比不发布更误导人（用户会去排查服务，而问题在配置根本没生效） |
 * | **回收** | **先删 Caddy 路由，再删记录**；Caddy 失败则**保留记录** | 反过来的话，记录删了而路由还在 ⇒ 一条**没人知道的公开路由**。这是最危险的状态：面板上看不到它，所以永远不会有人去清理 |
 *
 * 一句话：**发布时"宁可没记录也不留假记录"，回收时"宁可留记录也不留孤儿路由"。**
 * 两个方向的取舍标准都是"哪种失败更危险"，而不是"哪种代码更顺"。
 *
 * ## 为什么回收要能被反复调用
 *
 * 定时任务可能失败、进程可能重启。所以 `reclaimExpired` 必须是**幂等**的：
 * 它按库里的过期记录逐条处理，每条成功才删记录；失败的下次还会被扫到。
 *
 * @module @forlife/gateway/port-service
 */
import type { DatabaseSync } from 'node:sqlite'

import { buildHttpRoute, caddyRouteId, type CaddyClient } from './caddy.ts'
import { listExpiredPorts, listActivePorts, publishPort, removePort, setCaddyRouteId, type PublishedPortRow } from './ports.ts'

/** 一次操作的结果。 */
export interface PortOpResult {
  readonly ok: boolean
  readonly reason: string
  readonly row?: PublishedPortRow
}

/** 服务配置。 */
export interface PortServiceOptions {
  readonly db: DatabaseSync
  readonly caddy: CaddyClient
  /** 对外主机名（拼进 Caddy 的 host 匹配）。 */
  readonly host: string
  /** 上游主机（容器里是服务名，默认 127.0.0.1）。 */
  readonly upstreamHost?: string
  readonly log?: (message: string) => void
  readonly now?: () => Date
}

/** 端口服务。 */
export interface PortService {
  readonly publish: (input: {
    readonly name: string
    readonly targetPort: number
    readonly protocol?: 'http' | 'tcp'
    readonly ttlSeconds?: number | null
    readonly approvedBy: string
    readonly note?: string | undefined
  }) => Promise<PortOpResult>
  readonly unpublish: (id: string) => Promise<PortOpResult>
  readonly reclaimExpired: () => Promise<{ readonly reclaimed: readonly string[]; readonly failed: readonly string[] }>
  readonly list: () => readonly PublishedPortRow[]
  /** 对外可访问的 URL（界面要显示给人点）。 */
  readonly urlFor: (row: PublishedPortRow) => string
}

/** 造一个端口服务。 */
export function createPortService(options: PortServiceOptions): PortService {
  const { db, caddy } = options
  const now = options.now ?? ((): Date => new Date())
  const upstreamHost = options.upstreamHost ?? '127.0.0.1'
  const log = options.log ?? ((): void => {})

  const urlFor = (row: PublishedPortRow): string => `https://${options.host}/svc/${row.name}/`

  const publish: PortService['publish'] = async (input) => {
    // ① 登记（含白名单与重名校验）
    const registered = publishPort(db, {
      name: input.name,
      targetPort: input.targetPort,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ttlSeconds: input.ttlSeconds ?? null,
      approvedBy: input.approvedBy,
      ...(input.note === undefined ? {} : { note: input.note }),
      now: now(),
    })
    if (!registered.ok || registered.row === undefined) return { ok: false, reason: registered.reason }
    const row = registered.row

    // ② 配 Caddy
    const routeId = caddyRouteId(row.name)
    const written = await caddy.upsertRoute(
      routeId,
      buildHttpRoute({ host: options.host, name: row.name, targetPort: row.target_port, upstreamHost }),
    )

    if (!written.ok) {
      // ③ **回滚登记**：失败时不能留下"看起来发布了"的记录。
      //    留着的话用户会去排查他的服务，而问题其实是配置根本没生效 ——
      //    这类误导比"发布失败"本身更难查。
      removePort(db, row.id)
      log(`发布 ${row.name} 失败，已回滚登记：${written.reason}`)
      return { ok: false, reason: `Caddy 配置失败，已回滚：${written.reason}` }
    }

    setCaddyRouteId(db, row.id, routeId)
    log(`已发布 ${row.name} → ${String(row.target_port)}（路由 ${routeId}）`)
    return { ok: true, reason: `已发布：${urlFor(row)}`, row: { ...row, caddy_route_id: routeId } }
  }

  const unpublish: PortService['unpublish'] = async (id) => {
    const row = db.prepare('SELECT * FROM published_ports WHERE id = ?').get(id) as unknown as PublishedPortRow | undefined
    if (row === undefined) return { ok: false, reason: `没有这条发布：${id}` }

    // 删 Caddy 路由。**必须成功**才删记录 —— 否则会留下一条孤儿公开路由
    // （面板上看不到它，所以永远不会有人去清理）。
    const routeId = row.caddy_route_id ?? caddyRouteId(row.name)
    const deleted = await caddy.deleteRoute(routeId)
    if (!deleted.ok) {
      log(`取消 ${row.name} 失败，**保留记录**以便重试：${deleted.reason}`)
      return { ok: false, reason: `Caddy 路由删除失败，已保留记录以便重试：${deleted.reason}` }
    }

    removePort(db, id)
    log(`已取消 ${row.name}`)
    return { ok: true, reason: `已取消：${row.name}`, row }
  }

  const reclaimExpired: PortService['reclaimExpired'] = async () => {
    const reclaimed: string[] = []
    const failed: string[] = []
    for (const row of listExpiredPorts(db, now())) {
      const routeId = row.caddy_route_id ?? caddyRouteId(row.name)
      const deleted = await caddy.deleteRoute(routeId)
      if (!deleted.ok) {
        // **保留记录**：下次还会被扫到。删了的话就永远不知道还有条路由在外面。
        failed.push(`${row.name}：${deleted.reason}`)
        log(`回收 ${row.name} 失败，保留记录以便重试：${deleted.reason}`)
        continue
      }
      removePort(db, row.id)
      reclaimed.push(row.name)
      log(`已回收过期发布 ${row.name}`)
    }
    return { reclaimed, failed }
  }

  return {
    publish,
    unpublish,
    reclaimExpired,
    list: () => listActivePorts(db, now()),
    urlFor,
  }
}
