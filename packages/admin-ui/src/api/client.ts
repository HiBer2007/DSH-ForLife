/**
 * 与 gateway 的 `/api/admin/*` 说话的唯一入口。
 *
 * 规矩（都是踩过的坑）：
 *  - **同源相对路径**：面板挂在 `/admin/` 下，接口在同源 `/api/admin/`，不写绝对域名，
 *    这样局域网直连与 Caddy 反代两种部署都不用改配置；
 *  - **cookie 会话**：`credentials: 'same-origin'`，不把令牌放进 URL 或 localStorage；
 *  - **401 统一出口**：任何接口返回 401 就抛 `UnauthorizedError`，由外壳统一跳登录页，
 *    避免每个页面各写一遍"没登录怎么办"。
 */

/** 接口基础前缀。 */
const BASE = '/api/admin'

/** 未登录（或会话过期）。 */
export class UnauthorizedError extends Error {
  constructor() {
    super('未登录或会话已过期')
    this.name = 'UnauthorizedError'
  }
}

/** 接口返回了非 2xx 且不是 401。 */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly body?: unknown
  /** 查询参数（值为 undefined 的会被丢掉）。 */
  readonly query?: Record<string, string | number | boolean | undefined>
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = new URL(BASE + path, location.origin)
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  // 返回相对路径，避免部署在子路径/反代后面时把 origin 写死
  return url.pathname + url.search
}

/** 发一个 JSON 请求。 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    // 服务端的错误体统一是 { error: string }；拿不到就用状态码兜底
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: string }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
    } catch {
      // 非 JSON 响应，保留状态码
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** 便捷方法。 */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query']): Promise<T> => apiRequest<T>(path, { query }),
  post: <T>(path: string, body?: unknown): Promise<T> => apiRequest<T>(path, { method: 'POST', body }),
}
