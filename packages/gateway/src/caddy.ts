/**
 * Caddy Admin API 客户端（PLAN 阶段 7 交付物 3）。
 *
 * ## ⚠️ 一次真实的纠错（靠读官方文档发现的）
 *
 * 最初我把 upsert 写成一句 `PUT /id/<id>`，以为它能"存在则替换、不存在则创建"。
 * **这是错的。** 官方文档（https://caddyserver.com/docs/api）写得很清楚：
 *
 * > **Using `@id` in JSON** — make a request to the `/id/` API endpoint
 * > **in the same way you would to the corresponding `/config/` endpoint**.
 *
 * 也就是说 `/id/<id>` 只是**配置路径的快捷方式**，用来访问**已经存在**的对象 ——
 * 它**不能创建**新对象。而创建要用：
 *
 * > **PUT /config/[path]** — *Creates new object; inserts into array*
 *
 * 所以正确做法是两步（但语义仍然是幂等的）：
 *   1. `GET /id/<id>` —— 存在 ⇒ `PATCH /id/<id>` 替换；
 *   2. 不存在（404）⇒ `PUT /config/apps/http/servers/<server>/routes/0` 插入（对象里带 `@id`）。
 *
 * **这个错误只有两种方式能发现：真跑一次 Caddy，或者读文档。**
 * 我这次是因为 Docker Hub 拉不动镜像才去读的文档 —— 否则它会一直躺在代码里，
 * 直到部署当天表现为"发布成功但访问不通"。
 *
 * ## 删除为什么要"确认删干净"
 *
 * 验收有一条是「`GET /config/` 无残留路由」。DELETE 返回 200 **不代表**路由真的没了。
 * 所以删完**再查一次**，查得到就判失败 —— 否则会出现"库里说取消了，实际还公开着"，
 * 而那是最危险的状态（**没人知道它还在**）。
 *
 * @module @forlife/gateway/caddy
 */
import type { FetchLike } from './sticker-vision.ts'

/** 一次 HTTP 调用的结果。 */
export interface CaddyResult {
  readonly ok: boolean
  readonly reason: string
  readonly status?: number
}

/** 客户端配置。 */
export interface CaddyClientOptions {
  /** Admin API 地址，如 `http://127.0.0.1:2019`。 */
  readonly adminUrl: string
  /**
   * 路由要插进哪个 HTTP server 的 `routes`。
   *
   * 必须能配：`PUT /config/…` 需要**完整路径**，而 server 名由部署方的
   * Caddyfile/JSON 决定（Caddyfile 适配出来的通常叫 `srv0`）。
   * 猜错的表现是"发布返回成功但访问不通"。
   */
  readonly serverName?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}

/** Caddy 客户端。 */
export interface CaddyClient {
  /** 幂等 upsert 一条路由。 */
  readonly upsertRoute: (routeId: string, route: unknown) => Promise<CaddyResult>
  /** 按 id 删除一条路由，并**确认删干净**。 */
  readonly deleteRoute: (routeId: string) => Promise<CaddyResult>
  /** 列出配置里所有 `@id`（验收要"无残留路由"时用它核对）。 */
  readonly listRouteIds: () => Promise<{ readonly ok: boolean; readonly ids: readonly string[]; readonly reason: string }>
  /** 原始配置（排障用）。 */
  readonly getConfig: () => Promise<{ readonly ok: boolean; readonly config: unknown; readonly reason: string }>
}

/** 造一个 Caddy 客户端。 */
export function createCaddyClient(options: CaddyClientOptions): CaddyClient {
  const base = options.adminUrl.replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const timeout = options.timeoutMs ?? 5000
  const serverName = options.serverName ?? 'srv0'

  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; text: string }> => {
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      } as never)
      return { ok: response.ok, status: response.status, text: await response.text() }
    } catch (error) {
      // 连不上要如实报（"Caddy 没起来"与"配置被拒"是完全不同的问题）
      return { ok: false, status: 0, text: `无法连接 Caddy Admin API（${base}）：${String(error).slice(0, 140)}` }
    }
  }

  const upsertRoute = async (routeId: string, route: unknown): Promise<CaddyResult> => {
    if (routeId.trim() === '') return { ok: false, reason: 'routeId 不能为空' }

    // `@id` 必须写进**对象本身**：否则按 id 再查查不到 —— 表现为"删不掉自己那条"
    const withId = { ...(route as Record<string, unknown>), '@id': routeId }
    const encoded = encodeURIComponent(routeId)

    // ① 先看它是不是已经存在
    const existing = await call('GET', `/id/${encoded}`)
    if (existing.ok) {
      // ② 存在 ⇒ 替换（PATCH 严格替换已存在的值）
      const patched = await call('PATCH', `/id/${encoded}`, withId)
      if (!patched.ok) {
        return { ok: false, reason: `Caddy 拒绝更新（HTTP ${String(patched.status)}）：${patched.text.slice(0, 200)}`, status: patched.status }
      }
      return { ok: true, reason: '已更新', status: patched.status }
    }

    // ③ 不存在 ⇒ **插入到 routes 数组最前面**（PUT 到下标 0 = 插入）。
    //    放最前是有意的：我们发布的路由应当**优先于**部署方自己的兜底路由
    //    （否则会被一条 `handle` 全接走，表现为"发布成功但访问到的是别的东西"）。
    const insertPath = `/config/apps/http/servers/${encodeURIComponent(serverName)}/routes/0`
    const inserted = await call('PUT', insertPath, withId)
    if (!inserted.ok) {
      return {
        ok: false,
        reason:
          `Caddy 拒绝插入（HTTP ${String(inserted.status)}）：${inserted.text.slice(0, 200)}` +
          `　—— 若提示找不到路径，多半是 server 名不对（当前用「${serverName}」，可用 FORLIFE_CADDY_SERVER 覆盖）`,
        status: inserted.status,
      }
    }
    return { ok: true, reason: '已插入', status: inserted.status }
  }

  const listRouteIds = async (): Promise<{ readonly ok: boolean; readonly ids: readonly string[]; readonly reason: string }> => {
    const result = await call('GET', '/config/')
    if (!result.ok) return { ok: false, ids: [], reason: `读取配置失败（HTTP ${String(result.status)}）：${result.text.slice(0, 160)}` }
    try {
      const ids: string[] = []
      const walk = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) {
          for (const item of node) walk(item)
          return
        }
        const record = node as Record<string, unknown>
        if (typeof record['@id'] === 'string') ids.push(record['@id'])
        for (const value of Object.values(record)) walk(value)
      }
      walk(JSON.parse(result.text))
      return { ok: true, ids, reason: `共 ${String(ids.length)} 个 @id` }
    } catch {
      return { ok: false, ids: [], reason: `配置不是 JSON：${result.text.slice(0, 120)}` }
    }
  }

  const deleteRoute = async (routeId: string): Promise<CaddyResult> => {
    if (routeId.trim() === '') return { ok: false, reason: 'routeId 不能为空' }
    const result = await call('DELETE', `/id/${encodeURIComponent(routeId)}`)
    // 404 也算成功：目标就是"它不存在"。把它当失败会让人反复重试一个已经达成的目标。
    if (!result.ok && result.status !== 404) {
      return { ok: false, reason: `删除失败（HTTP ${String(result.status)}）：${result.text.slice(0, 200)}`, status: result.status }
    }

    // **删完再查一次**：DELETE 返回 200 不代表真的没了。
    // 验收有一条是「GET /config/ 无残留路由」—— 不确认的话会出现
    // "库里说取消了，实际还公开着"，而那是最危险的状态（没人知道它还在）。
    const after = await listRouteIds()
    if (after.ok && after.ids.includes(routeId)) {
      return { ok: false, reason: `删除后 ${routeId} 仍在配置里 —— 视为失败（否则会留下一条公开路由）` }
    }
    return { ok: true, reason: '已删除', status: result.status }
  }

  const getConfig = async (): Promise<{ readonly ok: boolean; readonly config: unknown; readonly reason: string }> => {
    const result = await call('GET', '/config/')
    if (!result.ok) return { ok: false, config: undefined, reason: `HTTP ${String(result.status)}：${result.text.slice(0, 160)}` }
    try {
      return { ok: true, config: JSON.parse(result.text), reason: 'ok' }
    } catch {
      return { ok: false, config: undefined, reason: '配置不是 JSON' }
    }
  }

  return { upsertRoute, deleteRoute, listRouteIds, getConfig }
}

/** 拼一条 HTTP 映射路由：`https://<host>/svc/<name>/*` → 工作区里的 `<targetPort>`。 */
export function buildHttpRoute(input: {
  readonly host: string
  readonly name: string
  readonly targetPort: number
  /** 上游地址（默认 127.0.0.1；容器里要换成服务名）。 */
  readonly upstreamHost?: string
}): unknown {
  const upstreamHost = input.upstreamHost ?? '127.0.0.1'
  const prefix = `/svc/${input.name}`
  return {
    match: [{ host: [input.host], path: [`${prefix}/*`] }],
    handle: [
      {
        handler: 'rewrite',
        // 去掉前缀：工作区里的服务通常以为自己在根路径上。
        // 不去的话，它会收到 `/svc/name/...` 而 404 —— 表现为"映射配好了但打不开"。
        strip_path_prefix: prefix,
      },
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${upstreamHost}:${String(input.targetPort)}` }],
      },
    ],
    terminal: true,
  }
}

/** 路由 id 的命名规则（回收时按它删）。 */
export function caddyRouteId(name: string): string {
  return `forlife-svc-${name}`
}
