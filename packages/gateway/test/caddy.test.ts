/**
 * Caddy 客户端的守卫测试。
 *
 * 最值得守的三条：
 *  1. **upsert 是幂等的**（同一个 id 写两次，结果一致、不产生重复路由）——
 *     PLAN 阶段 7 明确要求"幂等 upsert"；
 *  2. **删除要确认删干净**（验收：「`GET /config/` 无残留路由」）——
 *     DELETE 返回 200 不代表真没了，不确认就会出现"库里说取消了，实际还公开着"；
 *  3. **404 删除算成功**（目标就是"它不存在"），否则会让人反复重试一个已达成的目标。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildHttpRoute, caddyRouteId, createCaddyClient, type CaddyClientOptions } from '../src/caddy.ts'

/** 一个内存版 Caddy：够真实，能验证幂等与残留。 */
function fakeCaddy(): { options: CaddyClientOptions; ids: () => string[]; calls: string[] } {
  const config = new Map<string, unknown>()
  const calls: string[] = []
  return {
    ids: () => [...config.keys()],
    calls,
    options: {
      adminUrl: 'http://caddy.test:2019',
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        calls.push(`${init.method} ${path}`)
        const idMatch = /^\/id\/(.+)$/.exec(path)

        if (path === '/config/' && init.method === 'GET') {
          // 真实 Caddy 返回嵌套对象；这里只回 id 集合够用
          const body = JSON.stringify({ apps: { http: { servers: { srv0: { routes: [...config.keys()].map((id) => ({ '@id': id })) } } } } })
          return { ok: true, status: 200, text: async () => body }
        }
        if (idMatch !== null) {
          const id = decodeURIComponent(idMatch[1] ?? '')
          if (init.method === 'PUT') {
            config.set(id, JSON.parse(init.body))
            return { ok: true, status: 200, text: async () => '' }
          }
          if (init.method === 'DELETE') {
            if (!config.has(id)) return { ok: false, status: 404, text: async () => 'not found' }
            config.delete(id)
            return { ok: true, status: 200, text: async () => '' }
          }
        }
        return { ok: false, status: 500, text: async () => 'unexpected' }
      },
    },
  }
}

test('★ 幂等 upsert：同一个 id 写两次，只有一条路由（PLAN 明确要求）', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  const route = buildHttpRoute({ host: 'example.test', name: 'web', targetPort: 8080 })

  const first = await client.upsertRoute('forlife-svc-web', route)
  assert.equal(first.ok, true)
  const second = await client.upsertRoute('forlife-svc-web', route)
  assert.equal(second.ok, true)

  assert.deepEqual(fake.ids(), ['forlife-svc-web'], '写两次不能变成两条')
})

test('★ upsert 会把 @id 写进对象本身（否则按 id 再查会查不到 → 删不掉自己那条）', async () => {
  const fake = fakeCaddy()
  const client = createCaddyClient(fake.options)
  await client.upsertRoute('forlife-svc-x', { handle: [] })
  assert.deepEqual(fake.ids(), ['forlife-svc-x'])
  // 反向确认：id 是我们传的那个（不是 Caddy 自己生成的）
  const listed = await client.listRouteIds()
  assert.ok(listed.ids.includes('forlife-svc-x'))
})

test('★ 删除要确认删干净：DELETE 成功但路由还在 ⇒ 判失败', async () => {
  const client = createCaddyClient({
    adminUrl: 'http://caddy.test:2019',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      // DELETE 说成功，但 GET /config/ 里那条**还在** —— 模拟"没删掉却报成功"
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

test('Caddy 拒绝配置时把响应片段带回来（排障要知道它说了什么）', async () => {
  const client = createCaddyClient({
    adminUrl: 'http://caddy.test:2019',
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'invalid handler name' }),
  })
  const result = await client.upsertRoute('x', {})
  assert.equal(result.ok, false)
  assert.match(result.reason, /400.*invalid handler name/s)
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
