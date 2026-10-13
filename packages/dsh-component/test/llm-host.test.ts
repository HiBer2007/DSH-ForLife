/**
 * 取数层的测试。
 *
 * ## 重点测什么
 *
 * **容错**。这一层的全部价值就是"**别把宿主的不正常变成我的崩溃**"：
 * - 没有 `llm` 服务 ⇒ 安静地返回空目录
 * - `listProviders()` 抛 ⇒ 同上
 * - **某一个 provider 的 `listModels()` 抛 ⇒ 别的 provider 照常**
 *   ★ 这条最关键：某个接入点抖动时，路由**必须还能看见别的接入点**
 *
 * ## 怎么造宿主
 *
 * 用一个**只实现 `get()` 的假 ctx** —— `ctx.get('llm')` 返回我们的替身。
 * 替身只实现 `listProviders()` / `listModels()`，**别的什么都没有**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fetchHostCatalog } from '../src/llm-host.ts'

/** 造一个最小的假 ctx（只有 `get`）。 */
function fakeCtx(services: Record<string, unknown>): never {
  return { get: (name: string) => services[name] } as never
}

test('★ 没有 llm 服务 ⇒ 安静返回空目录，不抛', async () => {
  const result = await fetchHostCatalog(fakeCtx({}))
  assert.equal(result.catalog.entries.length, 0)
  assert.ok(result.unavailableReason !== undefined)
  assert.match(result.unavailableReason, /拿不到 llm 服务/)
})

test('llm 服务存在但没有 listProviders ⇒ 说明原因', async () => {
  const result = await fetchHostCatalog(fakeCtx({ llm: {} }))
  assert.equal(result.catalog.entries.length, 0)
  assert.match(result.unavailableReason ?? '', /没有 listProviders/)
})

test('listProviders() 抛异常 ⇒ 抓住并说明', async () => {
  const result = await fetchHostCatalog(
    fakeCtx({
      llm: {
        listProviders(): unknown {
          throw new Error('远端炸了')
        },
      },
    }),
  )
  assert.equal(result.catalog.entries.length, 0)
  assert.match(result.unavailableReason ?? '', /listProviders\(\) 抛异常/)
  assert.match(result.unavailableReason ?? '', /远端炸了/)
})

test('正常路径：两个 provider、各自的模型都进目录', async () => {
  const result = await fetchHostCatalog(
    fakeCtx({
      llm: {
        listProviders: () => [
          { id: 'opencode-go', name: 'OpenCode Go' },
          { id: 'deepseek-official', name: 'DS 官方' },
        ],
        listModels: (provider: string) => {
          if (provider === 'opencode-go') {
            return Promise.resolve([
              { provider, id: 'glm-5.3-flash', name: 'GLM', inputModalities: ['text', 'image'] },
            ])
          }
          return Promise.resolve([{ provider, id: 'deepseek-flash', name: 'Flash', description: '自带' }])
        },
      },
    }),
  )
  assert.equal(result.providers.length, 2)
  assert.equal(result.catalog.entries.length, 2)
  assert.equal(result.unavailableReason, undefined)

  const glm = result.catalog.entries.find((e) => e.model === 'glm-5.3-flash')
  assert.ok(glm?.marks.includes('vision'), '宿主的 inputModalities 要转成 vision 标记')
  assert.ok(glm?.marks.includes('ours'), 'opencode-go 要带「自建」标记')
  assert.equal(result.catalog.entries.find((e) => e.model === 'deepseek-flash')?.description, '自带')
})

test('★★ 一个 provider 的 listModels 抛 ⇒ 别的照常（这条最关键）', async () => {
  const result = await fetchHostCatalog(
    fakeCtx({
      llm: {
        listProviders: () => [{ id: 'bad' }, { id: 'good' }],
        listModels: (provider: string) => {
          if (provider === 'bad') return Promise.reject(new Error('这个接入点挂了'))
          return Promise.resolve([{ provider, id: 'm1', name: 'M1' }])
        },
      },
    }),
  )

  // good 的模型必须还在
  assert.ok(
    result.catalog.entries.some((e) => e.provider === 'good' && e.model === 'm1'),
    '一个接入点挂了不该让整张表空掉',
  )
  // bad 要留一行并标原因
  const bad = result.catalog.entries.find((e) => e.provider === 'bad')
  assert.ok(bad !== undefined, '挂掉的接入点也要留一行')
  assert.equal(bad.reachable, false)
  // 错误原因要能追溯到取数层
  const badFetch = result.providers.find((p) => p.id === 'bad')
  assert.match(badFetch?.error ?? '', /这个接入点挂了/)
})

test('listModels() 返回非数组 ⇒ 当成空（不崩）', async () => {
  const result = await fetchHostCatalog(
    fakeCtx({
      llm: {
        listProviders: () => [{ id: 'p' }],
        listModels: () => Promise.resolve({ 不是: '数组' }),
      },
    }),
  )
  assert.equal(result.providers.length, 1)
  assert.equal(result.providers[0]?.models.length, 0)
})

test('没有 id 的 provider / 模型被跳过', async () => {
  const result = await fetchHostCatalog(
    fakeCtx({
      llm: {
        listProviders: () => [{ id: '' }, { name: '没有 id' }, { id: 'ok' }],
        listModels: () => Promise.resolve([{ id: '' }, { name: '没有 id' }, { provider: 'ok', id: 'real' }]),
      },
    }),
  )
  assert.equal(result.providers.length, 1)
  assert.equal(result.providers[0]?.id, 'ok')
  assert.equal(result.catalog.entries.filter((e) => e.model === 'real').length, 1)
})
