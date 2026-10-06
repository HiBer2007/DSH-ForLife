/**
 * 编排层的守卫测试 —— 重点守**两个方向相反**的顺序。
 *
 * 这是整个端口出口里最容易写错、也最难发现的地方：
 *
 * | 动作 | 正确顺序 | 写反了的后果 |
 * |---|---|---|
 * | 发布 | 先登记 → 配 Caddy → **失败回滚登记** | 留下"看起来发布了"的记录，用户去排查自己的服务，而问题在配置根本没生效 |
 * | 回收 | **先删 Caddy → 再删记录** → 失败**保留记录** | 留下**孤儿公开路由**：面板上看不到，所以永远不会有人去清理 |
 *
 * 两个方向的取舍标准都是"**哪种失败更危险**"，而不是"哪种代码更顺"。
 * 所以这两条必须有测试守着 —— 它们是"顺序"的正确性，靠读代码很容易看漏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import type { CaddyClient, CaddyResult } from '../src/caddy.ts'
import { createPortService } from '../src/port-service.ts'
import type { PublishedPortRow } from '../src/ports.ts'

/** 可控的假 Caddy：能指定某个操作失败。 */
function fakeCaddy(options: { failUpsert?: boolean; failDelete?: boolean } = {}): {
  client: CaddyClient
  routes: Map<string, unknown>
  layer4: Map<string, boolean>
  deleted: string[]
} {
  const routes = new Map<string, unknown>()
  const layer4 = new Map<string, boolean>()
  const deleted: string[] = []
  const client: CaddyClient = {
    upsertRoute: async (id: string, route: unknown): Promise<CaddyResult> => {
      if (options.failUpsert === true) return { ok: false, reason: 'Caddy 说不行' }
      routes.set(id, route)
      return { ok: true, reason: 'ok' }
    },
    deleteRoute: async (id: string): Promise<CaddyResult> => {
      if (options.failDelete === true) return { ok: false, reason: 'Caddy 删不掉' }
      routes.delete(id)
      deleted.push(id)
      return { ok: true, reason: 'ok' }
    },
    listRouteIds: async () => ({ ok: true, ids: [...routes.keys()], reason: 'ok' }),
    getConfig: async () => ({ ok: true, config: {}, reason: 'ok' }),
    // 替身**必须跟上真实接口** —— 这个坑已经踩过 4 次了：
    // 给 CaddyClient 加方法时，忘了同步替身，编译就红。
    // （换个角度说，这其实是好事：它逼着替身与真实接口保持一致。）
    upsertLayer4Server: async (serverName: string): Promise<CaddyResult> => {
      if (options.failUpsert === true) return { ok: false, reason: 'Caddy 说不行' }
      layer4.set(serverName, true)
      return { ok: true, reason: 'ok' }
    },
    deleteLayer4Server: async (serverName: string): Promise<CaddyResult> => {
      if (options.failDelete === true) return { ok: false, reason: 'Caddy 删不掉' }
      layer4.delete(serverName)
      return { ok: true, reason: 'ok' }
    },
  }
  return { client, routes, layer4, deleted }
}

function setup(caddyOptions: { failUpsert?: boolean; failDelete?: boolean } = {}): {
  db: ReturnType<typeof openDatabase>['db']
  caddy: ReturnType<typeof fakeCaddy>
  service: ReturnType<typeof createPortService>
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy(caddyOptions)
  const service = createPortService({ db: opened.db, caddy: caddy.client, host: 'life.example' })
  return { db: opened.db, caddy, service, close: () => opened.db.close() }
}

test('发布成功：登记 + Caddy 路由都到位，并给出可点的 URL', async () => {
  const { db, caddy, service, close } = setup()
  try {
    const result = await service.publish({ name: 'web', targetPort: 8080, approvedBy: 'admin:abcd' })
    assert.equal(result.ok, true)
    assert.equal(result.reason, '已发布：https://life.example/svc/web/')
    assert.ok(caddy.routes.has('forlife-svc-web'), 'Caddy 里要有路由')

    const row = db.prepare('SELECT caddy_route_id FROM published_ports WHERE name = ?').get('web') as { caddy_route_id: string }
    assert.equal(row.caddy_route_id, 'forlife-svc-web', '路由 id 要回写进库（回收时按它删）')
  } finally {
    close()
  }
})

test('★ 发布时 Caddy 失败 ⇒ **回滚登记**（不留"看起来发布了"的记录）', async () => {
  const { db, caddy, service, close } = setup({ failUpsert: true })
  try {
    const result = await service.publish({ name: 'web', targetPort: 8080, approvedBy: 'admin:abcd' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /已回滚/)

    // **关键断言**：库里不能留下这条 —— 留着的话用户会去排查自己的服务，
    // 而问题其实是配置根本没生效，这类误导比"发布失败"本身更难查。
    const count = (db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v
    assert.equal(count, 0, 'Caddy 失败必须回滚登记')
    assert.equal(caddy.routes.size, 0)
  } finally {
    close()
  }
})

test('非白名单端口：连登记都不会发生，更不会碰 Caddy', async () => {
  const { db, caddy, service, close } = setup()
  try {
    const result = await service.publish({ name: 'evil', targetPort: 9000, approvedBy: 'admin:abcd' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /不在白名单/)
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
    assert.equal(caddy.routes.size, 0, '被拒的不能碰到 Caddy')
  } finally {
    close()
  }
})

test('取消：删 Caddy 路由 + 删记录', async () => {
  const { db, caddy, service, close } = setup()
  try {
    const published = await service.publish({ name: 'web', targetPort: 8080, approvedBy: 'a' })
    assert.ok(published.row !== undefined)

    const result = await service.unpublish(published.row.id)
    assert.equal(result.ok, true)
    assert.equal(caddy.routes.size, 0, 'Caddy 路由必须删掉')
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
  } finally {
    close()
  }
})

test('★ 取消时 Caddy 删不掉 ⇒ **保留记录**（否则留下孤儿公开路由）', async () => {
  const { db, caddy, service, close } = setup({ failDelete: true })
  try {
    const published = await service.publish({ name: 'web', targetPort: 8080, approvedBy: 'a' })
    assert.ok(published.row !== undefined)

    const result = await service.unpublish(published.row.id)
    assert.equal(result.ok, false)
    assert.match(result.reason, /保留记录以便重试/)

    // **关键断言**：记录必须还在 —— 删了的话就永远不知道还有条路由在外面公开着
    const count = (db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v
    assert.equal(count, 1, 'Caddy 删失败必须保留记录以便重试')
    assert.equal(caddy.routes.size, 1, '路由确实还在（模拟真实情况）')
  } finally {
    close()
  }
})

test('★ TTL 到期回收：删路由 + 删记录', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy()
  let clock = new Date('2026-10-06T00:00:00.000Z')
  const service = createPortService({ db: opened.db, caddy: caddy.client, host: 'life.example', now: () => clock })
  try {
    await service.publish({ name: 'tmp', targetPort: 8080, ttlSeconds: 60, approvedBy: 'a' })
    assert.equal(caddy.routes.size, 1)

    // 还没到期：不该被回收
    clock = new Date('2026-10-06T00:00:30.000Z')
    assert.deepEqual((await service.reclaimExpired()).reclaimed, [])
    assert.equal(caddy.routes.size, 1, '没到期不能删')

    // 到期了
    clock = new Date('2026-10-06T00:02:00.000Z')
    const result = await service.reclaimExpired()
    assert.deepEqual(result.reclaimed, ['tmp'])
    assert.equal(caddy.routes.size, 0, '到期必须删掉 Caddy 路由（验收：GET /config/ 无残留路由）')
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
  } finally {
    opened.db.close()
  }
})

test('★ 回收时 Caddy 失败 ⇒ **保留记录**，下次还会被扫到（回收必须可反复调用）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy({ failDelete: true })
  const clock = new Date('2026-10-06T02:00:00.000Z')
  const service = createPortService({ db: opened.db, caddy: caddy.client, host: 'life.example', now: () => clock })
  try {
    // 直接写一条已过期的记录
    opened.db
      .prepare(
        `INSERT INTO published_ports (id, name, target_port, protocol, caddy_route_id, ttl_seconds, expires_at, approved_by, note, created_at)
         VALUES ('pp_1', 'tmp', 8080, 'http', 'forlife-svc-tmp', 60, '2026-10-06T00:01:00.000Z', 'a', NULL, '2026-10-06T00:00:00.000Z')`,
      )
      .run()

    const first = await service.reclaimExpired()
    assert.deepEqual(first.reclaimed, [])
    assert.equal(first.failed.length, 1, '失败要如实报告')

    // 记录还在 ⇒ 下一次还会被扫到（幂等、可反复调用）
    const count = (opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v
    assert.equal(count, 1, '回收失败必须保留记录，否则孤儿路由永远没人清理')

    const second = await service.reclaimExpired()
    assert.equal(second.failed.length, 1, '再调一次仍会尝试')
  } finally {
    opened.db.close()
  }
})

test('list 只给仍然有效的（过期的即使没回收也不出现）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const caddy = fakeCaddy()
  let clock = new Date('2026-10-06T00:00:00.000Z')
  const service = createPortService({ db: opened.db, caddy: caddy.client, host: 'life.example', now: () => clock })
  try {
    await service.publish({ name: 'short', targetPort: 8080, ttlSeconds: 60, approvedBy: 'a' })
    await service.publish({ name: 'long', targetPort: 8081, ttlSeconds: 3600, approvedBy: 'a' })

    clock = new Date('2026-10-06T00:02:00.000Z')
    // **即使回收任务一次都没跑过**，过期的也不能出现在"有效"列表里
    assert.deepEqual(
      service.list().map((r: PublishedPortRow) => r.name),
      ['long'],
    )
  } finally {
    opened.db.close()
  }
})
