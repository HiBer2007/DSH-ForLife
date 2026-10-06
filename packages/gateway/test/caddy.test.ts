/**
 * Caddy 客户端的守卫测试。
 *
 * ## 这里的假 Caddy 是照**官方文档的语义**写的，不是照我的实现写的
 *
 * 这很关键：如果假 Caddy 按"我以为的"行为来写，那它只会证明
 * "我的实现符合我的假设" —— 而这次出问题的恰恰是**假设本身**
 * （`PUT /id/<新id>` 创建不了对象）。
 *
 * 所以假 Caddy 严格实现文档里的四条：
 *   - `GET /id/<id>`：**只对已存在的对象**返回 200，否则 404；
 *   - `PATCH /id/<id>`：严格替换**已存在**的值；
 *   - `PUT /config/apps/http/servers/<srv>/routes/0`：**创建并插入**到数组首位；
 *   - `DELETE /id/<id>`：删除；不存在则 404。
 *
 * 最值得守的三条：
 *  1. **upsert 幂等**（同一个 id 写两次，结果只有一条路由）；
 *  2. **删除要确认删干净**（验收：「GET /config/ 无残留路由」）；
 *  3. **404 删除算成功**（目标就是"它不存在"）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildHttpRoute, caddyRouteId, createCaddyClient, type CaddyClientOptions } from '../src/caddy.ts'

/**
 * 一个**照文档语义**实现的内存版 Caddy。
 *
 * @param options.failInsert - 模拟"server 名不对"（插入路径 404）。
 */
function fakeCaddy(options: { failInsert?: boolean } = {}): {
  options: CaddyClientOptions
  ids: () => string[]
  routes: () => unknown[]
  calls: string[]
} {
  const config = new Map<string, unknown>()
  const calls: string[] = []

  return {
    ids: () => [...config.keys()],
    routes: () => [...config.values()],
    calls,
    options: {
      adminUrl: 'http://caddy.test:2019',
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        calls.push(`${init.method} ${path}`)

        // GET /config/ —— 返回整棵树（含 routes 数组，顺序有意义）
        if (path === '/config/' && init.method === 'GET') {
          const body = JSON.stringify({
            apps: {
              http: {
                servers: {
                  srv0: { routes: [...config.values()].map((r) => r) },
                },
              },
            },
          })
          return { ok: true, status: 200, text: async () => body }
        }

        // PUT /config/apps/http/servers/<srv>/routes/0 —— **创建并插入**
        const insertMatch = /^\/config\/apps\/http\/servers\/([^/]+)\/routes\/0$/.exec(path)
        if (insertMatch !== null && init.method === 'PUT') {
          if (insertMatch[1] !== 'srv0' || options.failInsert === true) {
            // 真实 Caddy 对不存在的路径返回 404
            return { ok: false, status: 404, text: async () => 'not found' }
          }
          const route = JSON.parse(init.body) as { '@id'?: string }
          const id = route['@id']
          if (id === undefined) return { ok: false, status: 400, text: async () => 'missing @id' }
          if (config.has(id)) return { ok: false, status: 409, text: async () => 'duplicate @id' }
          config.set(id, route)
          return { ok: true, status: 200, text: async () => '' }
        }

        // /id/<id>
        const idMatch = /^\/id\/(.+)$/.exec(path)
        if (idMatch !== null) {
          const id = decodeURIComponent(idMatch[1] ?? '')
          const exists = config.has(id)

          if (init.method === 'GET') {
            // **关键**：只对已存在的对象返回 200 —— 这正是原实现栽掉的地方
            return exists
              ? { ok: true, status: 200, text: async () => JSON.stringify(config.get(id)) }
              : { ok: false, status: 404, text: async () => 'not found' }
          }
          if (init.method === 'PATCH') {
            if (!exists) return { ok: false, status: 404, text: async () => 'not found' }
            config.set(id, JSON.parse(init.body))
            return { ok: true, status: 200, text: async () => '' }
          }
          if (init.method === 'DELETE') {
            if (!exists) return { ok: false, status: 404, text: async () => 'not found' }
            config.delete(id)
            return { ok: true, status: 200, text: async () => '' }
          }
        }

        return { ok: false, status: 500, text: async () => 'unexpected' }
      },
    },
  }
}

test('★ 首次发布走"插入"路径（不是 PUT /id —— 那创建不了对象）', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  const result = await client.upsertRoute('forlife-svc-web', buildHttpRoute({ host: 'h.test', name: 'web', targetPort: 8080 }))

  assert.equal(result.ok, true)
  assert.equal(result.reason, '已插入')
  assert.deepEqual(fake.ids(), ['forlife-svc-web'])
  // **明确断言走的是 config 路径**：这是这次纠错的核心
  assert.ok(
    fake.calls.some((c) => c === 'PUT /config/apps/http/servers/srv0/routes/0'),
    `首次发布必须走 PUT /config/.../routes/0，实际调用：${fake.calls.join(' | ')}`,
  )
})

test('★ 幂等 upsert：第二次走"更新"路径，仍然只有一条路由', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  const route = buildHttpRoute({ host: 'h.test', name: 'web', targetPort: 8080 })

  await client.upsertRoute('forlife-svc-web', route)
  const second = await client.upsertRoute('forlife-svc-web', route)

  assert.equal(second.ok, true)
  assert.equal(second.reason, '已更新', '第二次应当走 PATCH 更新')
  assert.deepEqual(fake.ids(), ['forlife-svc-web'], '写两次不能变成两条')
  assert.ok(fake.calls.some((c) => c.startsWith('PATCH /id/forlife-svc-web')))
})

test('★ @id 必须写进对象本身（否则按 id 再查查不到 → 删不掉自己那条）', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  await client.upsertRoute('forlife-svc-x', { handle: [] })

  const stored = fake.routes()[0] as { '@id'?: string }
  assert.equal(stored['@id'], 'forlife-svc-x', '对象里必须带 @id')
})

test('server 名不对时：给出**可操作**的提示（而不是一句"配置失败"）', async () => {
  const fake = fakeCaddy({ failInsert: true })
  const client = createCaddyClient(fake.options)
  const result = await client.upsertRoute('forlife-svc-web', {})

  assert.equal(result.ok, false)
  assert.match(result.reason, /拒绝插入/)
  // 提示里要说明"多半是 server 名不对"并给出覆盖方式 ——
  // 否则用户只能看到一个 404，无从下手
  assert.match(result.reason, /server 名不对/)
  assert.match(result.reason, /FORLIFE_CADDY_SERVER/)
})

test('★ 删除要确认删干净：DELETE 成功但路由还在 ⇒ 判失败', async () => {
  const client = createCaddyClient({
    adminUrl: 'http://caddy.test:2019',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      if (init.method === 'DELETE') return { ok: true, status: 200, text: async () => '' }
      if (path === '/config/') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ '@id': 'ghost' }] }) }
      }
      return { ok: false, status: 500, text: async () => '' }
    },
  })

  const result = await client.deleteRoute('ghost')
  assert.equal(result.ok, false, '没删干净必须判失败 —— 否则会留下一条公开路由')
  assert.match(result.reason, /仍在配置里/)
})

test('★ 删除不存在的东西算成功（目标就是"它不存在"）', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  const result = await client.deleteRoute('never-existed')
  assert.equal(result.ok, true, '404 算成功 —— 否则会让人反复重试一个已达成的目标')
})

test('连不上 Caddy 时如实报错（与"配置被拒"区分开）', async () => {
  const client = createCaddyClient({
    adminUrl: 'http://127.0.0.1:2019',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const result = await client.upsertRoute('x', {})
  assert.equal(result.ok, false)
  assert.match(result.reason, /无法连接/)
})

test('路由构造：前缀要被 strip（否则工作区里的服务会收到 /svc/… 而 404）', () => {
  const route = buildHttpRoute({ host: 'h.test', name: 'app', targetPort: 3000 }) as {
    match: { host: string[]; path: string[] }[]
    handle: Record<string, unknown>[]
  }
  assert.deepEqual(route.match[0]?.host, ['h.test'])
  assert.deepEqual(route.match[0]?.path, ['/svc/app/*'])

  const rewrite = route.handle.find((h) => h['handler'] === 'rewrite')
  assert.equal(rewrite?.['strip_path_prefix'], '/svc/app', '必须去掉前缀')

  const proxy = route.handle.find((h) => h['handler'] === 'reverse_proxy')
  assert.deepEqual(proxy?.['upstreams'], [{ dial: '127.0.0.1:3000' }])

  // 上游主机可换（容器里要用服务名，不能是 127.0.0.1）
  const inContainer = buildHttpRoute({ host: 'h', name: 'a', targetPort: 80, upstreamHost: 'workspace' }) as {
    handle: Record<string, unknown>[]
  }
  const proxy2 = inContainer.handle.find((h) => h['handler'] === 'reverse_proxy')
  assert.deepEqual(proxy2?.['upstreams'], [{ dial: 'workspace:80' }])
})

test('路由 id 命名规则固定（回收时按它删，不能两边各写一套）', () => {
  assert.equal(caddyRouteId('web'), 'forlife-svc-web')
})
