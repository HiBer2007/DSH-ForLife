/**
 * TCP 分支在**编排层**的测试。
 *
 * 守三件事：
 *  1. TCP 发布写的是 **layer4 server**（不是 HTTP 路由）；
 *  2. 库里记的是 **server 名**（回收/取消要按它删）—— 记错就删不掉，
 *     而 TCP 删不掉的后果比 HTTP 更重：那是一条**还在监听端口**的转发；
 *  3. 两个方向的顺序与 HTTP 一致：发布失败**回滚登记**、回收失败**保留记录**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import type { CaddyClient, CaddyResult } from '../src/caddy.ts'
import { createPortService } from '../src/port-service.ts'

const WL = [{ from: 18000, to: 18099 }]

/** 假 Caddy：分开记 HTTP 路由与 layer4 server，能看出"走的是哪条路"。 */
function fakeCaddy(options: { failWrite?: boolean; failDelete?: boolean } = {}): {
  client: CaddyClient
  routes: Map<string, unknown>
  layer4: Map<string, unknown>
} {
  const routes = new Map<string, unknown>()
  const layer4 = new Map<string, unknown>()
  const client: CaddyClient = {
    upsertRoute: async (id: string, route: unknown): Promise<CaddyResult> => {
      if (options.failWrite === true) return { ok: false, reason: 'Caddy 说不行' }
      routes.set(id, route)
      return { ok: true, reason: 'ok' }
    },
    deleteRoute: async (id: string): Promise<CaddyResult> => {
      if (options.failDelete === true) return { ok: false, reason: 'Caddy 删不掉' }
      routes.delete(id)
      return { ok: true, reason: 'ok' }
    },
    listRouteIds: async () => ({ ok: true, ids: [...routes.keys()], reason: 'ok' }),
    getConfig: async () => ({ ok: true, config: {}, reason: 'ok' }),
    upsertLayer4Server: async (serverName: string, server: unknown): Promise<CaddyResult> => {
      if (options.failWrite === true) return { ok: false, reason: 'Caddy 说不行' }
      layer4.set(serverName, server)
      return { ok: true, reason: 'ok' }
    },
    deleteLayer4Server: async (serverName: string): Promise<CaddyResult> => {
      if (options.failDelete === true) return { ok: false, reason: 'Caddy 删不掉' }
      layer4.delete(serverName)
      return { ok: true, reason: 'ok' }
    },
  }
  return { client, routes, layer4 }
}

function setup(options: { failWrite?: boolean; failDelete?: boolean } = {}): {
  db: ReturnType<typeof openDatabase>['db']
  caddy: ReturnType<typeof fakeCaddy>
  service: ReturnType<typeof createPortService>
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy(options)
  const service = createPortService({
    db: opened.db,
    caddy: caddy.client,
    host: 'life.example',
    whitelist: WL,
    upstreamHost: '127.0.0.1',
  })
  return { db: opened.db, caddy, service, close: () => opened.db.close() }
}

test('★ TCP 发布走 layer4（不碰 HTTP 路由）', async () => {
  const { caddy, service, close } = setup()
  try {
    const result = await service.publish({
      name: 'db',
      targetPort: 18001,
      listenPort: 18050,
      protocol: 'tcp',
      approvedBy: 'a',
    })
    assert.equal(result.ok, true, result.reason)

    assert.equal(caddy.layer4.size, 1, 'layer4 里要有一个 server')
    assert.equal(caddy.routes.size, 0, '**不该**碰 HTTP 路由')
    assert.ok(caddy.layer4.has('forlife-l4-18050'), `server 名要带对外端口，实际：${[...caddy.layer4.keys()].join(',')}`)

    const server = caddy.layer4.get('forlife-l4-18050') as { listen: string[] }
    assert.deepEqual(server.listen, [':18050'], 'listen 必须是**对外端口**')
  } finally {
    close()
  }
})

test('★ 库里记的是 server 名（记错就删不掉，而 TCP 删不掉 = 端口还开着）', async () => {
  const { db, service, close } = setup()
  try {
    const result = await service.publish({
      name: 'db', targetPort: 18001, listenPort: 18050, protocol: 'tcp', approvedBy: 'a',
    })
    assert.equal(result.ok, true)
    const row = db.prepare('SELECT caddy_route_id FROM published_ports WHERE name = ?').get('db') as {
      caddy_route_id: string
    }
    assert.equal(row.caddy_route_id, 'forlife-l4-18050', '要记 server 名（不是 forlife-tcp-db）')
  } finally {
    close()
  }
})

test('★ TCP 取消：删 layer4 server + 删记录', async () => {
  const { db, caddy, service, close } = setup()
  try {
    const published = await service.publish({
      name: 'db', targetPort: 18001, listenPort: 18050, protocol: 'tcp', approvedBy: 'a',
    })
    assert.ok(published.row !== undefined)
    const result = await service.unpublish(published.row.id)
    assert.equal(result.ok, true, result.reason)
    assert.equal(caddy.layer4.size, 0, 'layer4 server 必须删掉（否则端口还开着）')
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
  } finally {
    close()
  }
})

test('★ TCP 发布失败 ⇒ 回滚登记（与 HTTP 同一条纪律）', async () => {
  const { db, caddy, service, close } = setup({ failWrite: true })
  try {
    const result = await service.publish({
      name: 'db', targetPort: 18001, listenPort: 18050, protocol: 'tcp', approvedBy: 'a',
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /已回滚/)
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
    assert.equal(caddy.layer4.size, 0)
  } finally {
    close()
  }
})

test('★ TCP 回收：TTL 到期删 layer4 server + 删记录', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy()
  let clock = new Date('2026-10-06T00:00:00.000Z')
  const service = createPortService({
    db: opened.db, caddy: caddy.client, host: 'h', whitelist: WL, now: () => clock,
  })
  try {
    await service.publish({ name: 'db', targetPort: 18001, listenPort: 18050, protocol: 'tcp', ttlSeconds: 60, approvedBy: 'a' })
    assert.equal(caddy.layer4.size, 1)

    clock = new Date('2026-10-06T00:02:00.000Z')
    const result = await service.reclaimExpired()
    assert.deepEqual(result.reclaimed, ['db'])
    assert.equal(caddy.layer4.size, 0, '到期必须删掉 layer4 server')
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
  } finally {
    opened.db.close()
  }
})

test('★ TCP 回收失败 ⇒ 保留记录（否则端口一直开着且没人知道）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy({ failDelete: true })
  const clock = new Date('2026-10-06T02:00:00.000Z')
  const service = createPortService({
    db: opened.db, caddy: caddy.client, host: 'h', whitelist: WL, now: () => clock,
  })
  try {
    opened.db
      .prepare(
        `INSERT INTO published_ports (id, name, target_port, listen_port, protocol, caddy_route_id, ttl_seconds, expires_at, approved_by, note, created_at)
         VALUES ('pp_1', 'db', 18001, 18050, 'tcp', 'forlife-l4-18050', 60, '2026-10-06T00:01:00.000Z', 'a', NULL, '2026-10-06T00:00:00.000Z')`,
      )
      .run()

    const result = await service.reclaimExpired()
    assert.deepEqual(result.reclaimed, [])
    assert.equal(result.failed.length, 1)
    // 记录还在 ⇒ 下次还会被扫到。删了的话，那条 layer4 server 会**永远开着**而没人知道。
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 1)
  } finally {
    opened.db.close()
  }
})

test('HTTP 与 TCP 可以并存（互不干扰）', async () => {
  const { caddy, service, close } = setup()
  try {
    const http = await service.publish({ name: 'web', targetPort: 18001, approvedBy: 'a' })
    const tcp = await service.publish({ name: 'db', targetPort: 18002, listenPort: 18050, protocol: 'tcp', approvedBy: 'a' })
    assert.equal(http.ok, true)
    assert.equal(tcp.ok, true)
    assert.equal(caddy.routes.size, 1, 'HTTP 走 routes')
    assert.equal(caddy.layer4.size, 1, 'TCP 走 layer4')
  } finally {
    close()
  }
})
