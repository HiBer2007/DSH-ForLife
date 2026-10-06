/**
 * TCP 出口（layer4）—— PLAN 阶段 7 交付物 4 的第二条出口。
 *
 * ## ⚠️ TCP 与 HTTP 有一个**本质**差别：没有路径可以分流
 *
 * HTTP 出口靠**路径**分流（`/svc/<name>/`），所以几十个服务可以共用一个对外端口。
 * **TCP 没有这层信息** —— 连接进来时还不知道对端要说什么，
 * 所以每个 TCP 服务**必须独占一个对外端口**。
 *
 * 这带来三个必须处理的后果：
 *  1. **白名单要判的是"对外端口"**，不是目标端口 —— 判错了就等于开了一个任意端口；
 *  2. **对外端口不能重复**：两个发布用同一个对外端口时，后一个必须被拒
 *     （否则它会**静默顶掉**前一个，而前一个的使用者只会觉得"服务挂了"）；
 *  3. 端口是稀缺资源 —— 这也是为什么 PLAN 把 TCP 放在"需要自建镜像"的那一档。
 *
 * ## 需要自建 Caddy 镜像
 *
 * `layer4` 不是 Caddy 内置模块，要用 `xcaddy` 把它编进去：
 *   `xcaddy build --with github.com/mholt/caddy-l4`
 * 见 `deploy/caddy/Dockerfile.forlife`。
 *
 * 本机没有 Go/xcaddy，所以**这条出口的"真机验收"没有做** ——
 * 已有的证据是"配置生成的形状正确 + 与假 Caddy 交互正确"。
 * 差异与代价见 PLAN §2.14.16。
 *
 * @module @forlife/gateway/caddy-tcp
 */

/** 一条 layer4 路由（Caddy 的 `apps.layer4` 结构）。 */
export interface TcpRouteInput {
  /** 对外监听端口（**白名单要判的就是它**）。 */
  readonly listenPort: number
  /** 工作区里的服务端口。 */
  readonly targetPort: number
  /** 路由 id（回收时按它删）。 */
  readonly routeId: string
  /** 上游主机（默认 127.0.0.1）。 */
  readonly upstreamHost?: string
}

/**
 * 拼一条 layer4 的 TCP 代理路由。
 *
 * 形状（Caddy `apps.layer4`）：
 * ```json
 * { "listen": [":9000"],
 *   "routes": [{ "@id": "…", "match": [{"tcp": []}],
 *                "handle": [{"handler": "proxy", "upstreams": [{"dial": ["127.0.0.1:8080"]}]}] }] }
 * ```
 */
export function buildTcpRoute(input: TcpRouteInput): unknown {
  const upstreamHost = input.upstreamHost ?? '127.0.0.1'
  return {
    listen: [`:${String(input.listenPort)}`],
    routes: [
      {
        '@id': input.routeId,
        // `tcp: []` 表示"匹配所有 TCP 连接"。这里不需要更细的匹配 ——
        // 对外端口本身就是唯一入口，再筛反而容易漏掉非首包场景。
        match: [{ tcp: [] }],
        handle: [
          {
            handler: 'proxy',
            upstreams: [{ dial: [`${upstreamHost}:${String(input.targetPort)}`] }],
          },
        ],
      },
    ],
  }
}

/** layer4 server 的名字（所有 TCP 发布共用一个 server，各自一条路由）。 */
export const TCP_SERVER_NAME = 'forlife-l4'

/**
 * 把一条 TCP 路由写进 layer4 的 servers 下。
 *
 * 与 HTTP 那边不同，这里**整条 server 一起 PUT**：
 * layer4 的一个 server 只有一个 `listen` 列表，而每条路由的 listen 由自己的
 * 对外端口决定 —— 所以"一个对外端口 = 一个 server"更贴合它的结构。
 * 把 server 名带上端口（`forlife-l4-<port>`），彼此就不会互相覆盖。
 */
export function tcpServerName(listenPort: number): string {
  return `${TCP_SERVER_NAME}-${String(listenPort)}`
}

/** 从一条 TCP 发布推出 Caddy 里的路由 id。 */
export function caddyTcpRouteId(name: string): string {
  return `forlife-tcp-${name}`
}
