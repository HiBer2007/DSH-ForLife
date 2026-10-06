/**
 * 唤醒桥端点的**正确注册方式**（PLAN 阶段 8）。
 *
 * ## 我踩了两个坑，这里都记下来
 *
 * ### 坑一：`ctx.get('webServer')` 拿不到
 *
 * 实测 `ctx.get('webServer')` 在 forlife-web profile 里返回 `undefined` ——
 * 因为 `ctx.get()` 只能拿到**已经加载好**的服务，而 webServer 在插件
 * `apply()` 时还没就绪。症状：gateway 发唤醒得到 **HTTP 405**。
 *
 * ### 坑二：`ctx.inject(['webServer'], cb)` **静默不触发**
 *
 * 改成运行时注入回调之后，**回调既不执行也不报错**（这正是
 * `panel-plugin.ts` 文件头第 14 行记载的那条实测结论）。
 * 症状：路由看似注册了（405 变成超时），但处理器永远不返回。
 *
 * ### 正确的做法：用 `panel-plugin.ts` 那条**已经有 `inject` 的独立插件行**
 *
 * 那里 `ctx.connection.fetch` 是注册表，形状是：
 *
 * ```ts
 * registry.register({
 *   path: '/forlife/wake',        // `/api` 之下的绝对路径 ⇒ 实际是 /api/forlife/wake
 *   methods: ['POST'],
 *   requestBody: 'buffered',
 *   fetch: (request: Request) => Promise<Response>,   // ← **Web Fetch API**
 * })
 * ```
 *
 * 注意 `fetch` 是 **Web Fetch API**，不是我原先假设的
 * `handler({ headers, body })` —— 后者会让处理器**永远挂住**。
 *
 * @module forlife-memory/wake-route
 */
import { handleWakeRequest, type WakeHost } from './wake-bridge-endpoint.ts'
import type { FetchRegistryLike } from './api.ts'

/** 端点路径（`/api` 之下）。 */
export const WAKE_ROUTE_PATH = '/forlife/wake'

/**
 * 注册唤醒桥端点。
 *
 * @returns 反注册函数；未配置密钥时返回 undefined（**fail-closed**）。
 */
export function registerWakeRoute(
  registry: FetchRegistryLike,
  options: {
    readonly secret: string | undefined
    readonly host: WakeHost
    readonly log?: (message: string) => void
  },
): (() => Promise<void>) | undefined {
  const log = options.log ?? ((): void => {})
  const secret = options.secret
  if (secret === undefined || secret.trim() === '') {
    // **没有密钥的唤醒端点 = 本机提权入口**（ctx.webServer 自身无 TLS、无认证）
    log('⚠️ 未配置 FORLIFE_WAKE_BRIDGE_SECRET：唤醒桥端点未注册。')
    return undefined
  }

  const dispose = registry.register({
    path: WAKE_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      try {
        // **body 是第 3 个位置参数**，不在 options 里（handleWakeRequest(options, headers, rawBody)）
        // ★ **必须用 `request.json()`，不能用 `request.text()`**
        //
        // 实测：`await request.text()` 在这个宿主里**永远挂住**（客户端只看到超时）。
        // 本仓库里所有能用的路由（api.ts）用的都是 `await request.json()` ——
        // 那才是这个 `requestBody: 'buffered'` 实现支持的读法。
        //
        // 这个坑的症状很有迷惑性：路由**注册成功了**（不再是 404/405），
        // 但请求超时 —— 完全看不出是服务端卡住。
        let parsed: Record<string, unknown> = {}
        try {
          parsed = (await request.json()) as Record<string, unknown>
        } catch {
          // 坏 JSON / 空体：交给处理器判（它会回 400 并说清），不在这里吞掉
          parsed = {}
        }
        // 把头**转成普通对象**（处理器要的是 Record<string, string|undefined>）
        const headers: Record<string, string | undefined> = {}
        request.headers.forEach((value, key) => {
          headers[key] = value
        })
        // **body 是第 3 个位置参数**（handleWakeRequest(options, headers, rawBody)）
        const result = await handleWakeRequest({ host: options.host, secret }, headers, JSON.stringify(parsed))
        return Response.json(result.body as Record<string, unknown>, { status: result.status })
      } catch (error) {
        // 处理器抛异常也要**回一个明确的 500** —— 否则客户端只会看到超时，
        // 而超时完全看不出是"服务端炸了"还是"网络不通"
        log(`唤醒桥处理异常：${String(error).slice(0, 200)}`)
        return Response.json({ ok: false, reason: '唤醒桥内部错误' }, { status: 500 })
      }
    },
  })

  log(`✅ 唤醒桥端点已注册：${WAKE_ROUTE_PATH}`)
  return dispose
}
