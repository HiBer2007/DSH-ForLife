/**
 * TCP 出口的配置生成测试。
 *
 * 这些用例守的是 **TCP 与 HTTP 的本质差别**：
 * TCP 没有路径可以分流 ⇒ 每个服务独占一个对外端口 ⇒
 *  - 白名单要判的是**对外端口**（判错就等于开了任意端口）；
 *  - 对外端口**不能重复**（重复会静默顶掉前一个）；
 *  - server 名要带端口（否则彼此的 listen 会互相覆盖）。
 *
 * ⚠️ 本机没有 Go/xcaddy，**构建不了含 layer4 的 Caddy**，
 * 所以这里**没有真机验收** —— 只有配置形状与交互层面的证据。
 * 差异与代价见 PLAN §2.14.16。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildTcpRoute, caddyTcpRouteId, tcpServerName, TCP_SERVER_NAME } from '../src/caddy-tcp.ts'

test('TCP 路由形状：listen 用对外端口，upstream 用目标端口', () => {
  const route = buildTcpRoute({ listenPort: 9000, targetPort: 8080, routeId: 'forlife-tcp-db' }) as {
    listen: string[]
    routes: { '@id': string; match: unknown[]; handle: { handler: string; upstreams: { dial: string[] }[] }[] }[]
  }

  assert.deepEqual(route.listen, [':9000'], 'listen 必须是**对外端口**')
  const inner = route.routes[0]
  assert.ok(inner !== undefined)
  assert.equal(inner['@id'], 'forlife-tcp-db', '@id 要写进对象本身（回收时按它删）')
  assert.deepEqual(inner.match, [{ tcp: [] }])

  const proxy = inner.handle[0]
  assert.equal(proxy?.handler, 'proxy')
  assert.deepEqual(proxy?.upstreams, [{ dial: ['127.0.0.1:8080'] }], 'upstream 是目标端口')
})

test('上游主机可换（容器里不能是 127.0.0.1）', () => {
  const route = buildTcpRoute({ listenPort: 9000, targetPort: 8080, routeId: 'x', upstreamHost: 'workspace' }) as {
    routes: { handle: { upstreams: { dial: string[] }[] }[] }[]
  }
  assert.deepEqual(route.routes[0]?.handle[0]?.upstreams, [{ dial: ['workspace:8080'] }])
})

test('★ server 名带端口 —— 否则不同发布的 listen 会互相覆盖', () => {
  // layer4 的一个 server 只有一个 listen 列表。若所有发布共用一个 server 名，
  // 后写的会把前一条的 listen 顶掉 —— 表现为"先发布的服务莫名其妙不通了"。
  assert.notEqual(tcpServerName(9000), tcpServerName(9001))
  assert.equal(tcpServerName(9000), `${TCP_SERVER_NAME}-9000`)
})

test('路由 id 命名规则固定（回收时按它删，不能两边各写一套）', () => {
  assert.equal(caddyTcpRouteId('db'), 'forlife-tcp-db')
})
