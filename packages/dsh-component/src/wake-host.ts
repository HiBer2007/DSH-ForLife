/**
 * 唤醒桥的**自建宿主**（`FIX_PLAN.md` D7，用户裁定 **D-B**）。
 *
 * ## 为什么需要它（一句话）
 *
 * DSH 自己的 `webServer` **只绑回环**：它的作者在代码里硬禁了 `--host 0.0.0.0`，
 * 理由是「`/api` 一旦被网络上任何东西碰到就等于交出 RCE」——
 * 所以**同在一个 docker 网络里的 gateway 也够不到它**。
 *
 * ⇒ 我们不跟那堵墙较劲（那是 DSH 的边界，该尊重），而是**自己起一个只服务唤醒端点的
 * http 监听**，绑容器网卡。
 *
 * ## ★ 它**不是**"webServer 的降级方案"
 *
 * 两条路**并行**、互不影响：
 *
 * | 谁 | 服务谁 | 绑哪 |
 * | :--- | :--- | :--- |
 * | DSH 的 `webServer`（原样保留） | DSH 自己的 UI 面板（`/api/forlife/{state,entries,…}`） | 回环 |
 * | **本模块** | gateway 的唤醒请求 | `0.0.0.0`（容器网卡） |
 *
 * ⇒ `index.ts` 里那三条失败分支（没 inject / 没 webServer / 缺服务）
 *   **一句都不改** —— 它们继续如实报告面板那一侧的状态。
 *
 * ## ★ 为什么不重写鉴权与唤醒逻辑
 *
 * `registerWakeEndpoint()`（`wake-bridge-endpoint.ts:166`）**早就把端点与宿主解耦了**：
 * 它要的宿主能力**只有一个方法** ——
 *
 * ```ts
 * register(route: { kind: 'exact'; path; handler: (req: {headers, body?}) => Promise<{status, body}> }): () => void
 * ```
 *
 * 所以这里只需把 `node:http` 适配成那个形状，**鉴权、幂等、`WakeHost` 适配、
 * `handleWakeRequest` 全部原样复用**。
 * ⚠️ **绝不许在这儿写出第二套鉴权** —— 两套鉴权必然漂移，而漂移的那一套会变成后门。
 *
 * @module forlife-memory/wake-host
 */
import { createServer, type Server } from 'node:http'

/**
 * 路由形状 —— 与 `registerWakeEndpoint` 的第一个参数**逐字对应**。
 *
 * ⚠️ 刻意**不 import 那边的类型**去 `extends`：那边的入参是**内联字面量类型**，
 * 不是导出名。这里用同一份结构（并由接线守卫测试钉住"两边形状一致"），
 * 比强行 `as never` 更能在编译期挡住漂移。
 */
export interface WakeHttpRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: {
    readonly headers: Record<string, string | undefined>
    readonly body?: string
  }) => Promise<{ readonly status: number; readonly body: unknown }>
}

/** 自建宿主的对外形状（`register` 对齐 DSH webServer 的那一个方法）。 */
export interface WakeHttpHost {
  readonly register: (route: WakeHttpRoute) => () => void
  readonly close: () => Promise<void>
  readonly port: number
}

/** 起监听时的选项。 */
export interface StartWakeHostOptions {
  /** 监听端口。**必须有出处**（基线键 / 环境变量），不许在调用点写 magic number。 */
  readonly port: number
  /** 绑定的地址。默认 `0.0.0.0` —— 那正是"容器网络可达"的意思。 */
  readonly host?: string
  readonly log?: (message: string) => void
}

/**
 * 起一个**只服务已注册精确路径**的 http 宿主。
 *
 * 行为刻意做窄（这是一个"提权入口"，不是通用 web 框架）：
 *  - **只有精确路径**（没有前缀匹配、没有通配、没有目录遍历面）
 *  - **只有已经 `register` 过的路径**，其余一律 404
 *  - 请求体**有上限**（见 `MAX_BODY_BYTES`）：没有上限的 POST 就是一个内存放大器
 */
export function startWakeHost(options: StartWakeHostOptions): WakeHttpHost {
  const routes = new Map<string, WakeHttpRoute['handler']>()
  const host = options.host ?? '0.0.0.0'

  const server: Server = createServer((req, res) => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }

    // 只认精确路径。`new URL` 会顺手把 `?query` 摘掉，也会把 `..` 归一化 ——
    // 但即便归一化出一个"已注册路径"，那也只是打到同一个端点，没有额外暴露面。
    const pathname = new URL(req.url ?? '/', 'http://wake.invalid').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      // **不列出有哪些路径** —— 那等于给探测者送一份端点清单。
      json(404, { ok: false, error: '没有这个端点' })
      return
    }

    let body = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (tooLarge) return
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true
        json(413, { ok: false, error: `请求体超过 ${String(MAX_BODY_BYTES)} 字节` })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      void handler({ headers: req.headers as Record<string, string | undefined>, body })
        .then((result) => {
          json(result.status, result.body)
        })
        .catch((error: unknown) => {
          // 端点内部炸了也要**回一个规范的 JSON**：gateway 那边据此判断，
          // 而不是收到一个空响应然后猜"是不是桥不通"。
          json(500, { ok: false, error: `唤醒端点内部错误：${String(error).slice(0, 200)}` })
        })
    })
  })

  server.listen(options.port, host, () => {
    options.log?.(
      `✅ 唤醒桥**自建监听**已起：${host}:${String(options.port)}` +
        '（DSH 自己的 webServer 只绑回环，容器网络够不到它 —— 这条是给 gateway 用的）',
    )
  })

  return {
    port: options.port,
    register(route) {
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

/**
 * 请求体上限。
 *
 * 唤醒请求的形状是「一句话 + 会话 id」，几 KB 足够；这个值给得很宽（见下），
 * 只为挡住"无限大 POST 把内存吃光"这一类，不参与任何业务判断。
 */
export const MAX_BODY_BYTES = 256 * 1024
