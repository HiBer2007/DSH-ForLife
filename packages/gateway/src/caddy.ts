/**
 * Caddy Admin API 客户端（PLAN 阶段 7 交付物 3）。
 *
 * ## 幂等怎么做：靠 `@id`，不靠"先查再决定"
 *
 * Caddy 支持给配置对象打 `@id` 标记，并提供 `/id/<id>` 端点。
 * 于是 upsert 就是一句 **`PUT /id/<id>`** —— 存在则替换、不存在则创建，
 * **同一个请求同时覆盖两种情况**。
 *
 * 为什么不用"先 GET 看有没有，再 POST 或 PATCH"：
 * 那是**两次请求之间的竞态**（并发发布同名服务时，两边都看到"不存在"，
 * 于是都去创建，最后一条覆盖另一条，而两边都以为成功了）。
 * 而且它有两种失败模式要处理，代码量更大。
 *
 * ## 为什么删除也要能按 id
 *
 * 回收/取消时若不能**精确删掉自己那条**，就只能"重建整个 config" ——
 * 那会把别人的路由一起卷进来（多个人同时发布时互相踩）。
 *
 * ## 为什么要"确认删除干净"
 *
 * Caddy 的 DELETE 返回 200 不代表路由真的没了（可能 id 拼错、或它本来就不存在）。
 * 验收里有一条是「`GET /config/` 无残留路由」，所以这里删完**再查一次**，
 * 查得到就算失败 —— 否则会出现"库里说取消了，实际还公开着"。
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
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}

/** Caddy 客户端。 */
export interface CaddyClient {
  /** 幂等 upsert 一条路由（`PUT /id/<id>`）。 */
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
    // 把 @id 写进对象本身：Caddy 的 /id/<id> 端点要求对象里也带 @id，
    // 否则 PATCH/PUT 之后按 id 再查会查不到（表现为"删不掉自己那条"）
    const withId = { ...(route as Record<string, unknown>), '@id': routeId }
    const result = await call('PUT', `/id/${encodeURIComponent(routeId)}`, withId)
    if (!result.ok) {
      return { ok: false, reason: `Caddy 拒绝配置（HTTP ${String(result.status)}）：${result.text.slice(0, 200)}`, status: result.status }
    }
    return { ok: true, reason: '已写入', status: result.status }
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
