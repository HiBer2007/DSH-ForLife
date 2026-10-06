/**
 * DSH 状态探测的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **未配置 ≠ 连不上** —— 合成一个 `false` 的话，用户会去查一个根本没配的东西。
 * 2. **短超时** —— DSH 挂掉时面板**不能跟着卡住**（那恰恰是最需要看面板的时候）。
 * 3. **缓存** —— 面板连续刷新不该反复打 DSH。
 * 4. **错误信息截断** —— 完整堆栈在面板上显示不下，也会泄露本机路径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDshStatusProbe, dshUrlFromEnv } from '../src/dsh-status.ts'

const NOW = new Date('2026-10-06T12:00:00.000Z')

/** 造一个可控的 fetch。 */
function fakeFetch(behaviour: { status?: number; throws?: string; delayMs?: number }): {
  calls: string[]
  impl: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>
} {
  const calls: string[] = []
  return {
    calls,
    impl: async (url) => {
      calls.push(url)
      if (behaviour.delayMs !== undefined) await new Promise((r) => setTimeout(r, behaviour.delayMs))
      if (behaviour.throws !== undefined) throw new Error(behaviour.throws)
      return { status: behaviour.status ?? 200 }
    },
  }
}

test('dshUrlFromEnv：显式配置优先', () => {
  assert.equal(dshUrlFromEnv({ FORLIFE_DSH_URL: 'http://a:1' }), 'http://a:1')
  assert.equal(dshUrlFromEnv({ FORLIFE_DSH_URL: '  http://a:1  ' }), 'http://a:1')
})

test('★ 没配 URL 时从**唤醒桥地址推导**（省一个配置项）', () => {
  assert.equal(dshUrlFromEnv({ FORLIFE_WAKE_BRIDGE_URL: 'http://127.0.0.1:3080/forlife/wake' }), 'http://127.0.0.1:3080')
  // 坏 URL 不抛，返回 undefined
  assert.equal(dshUrlFromEnv({ FORLIFE_WAKE_BRIDGE_URL: '不是URL' }), undefined)
  assert.equal(dshUrlFromEnv({}), undefined)
})

test('★ 未配置 ⇒ `reachable: undefined`，**不是 false**（说清是"没配"）', async () => {
  const probe = createDshStatusProbe({ env: {}, now: () => NOW, cacheMs: 0 })
  const s = await probe()
  assert.equal(s.reachable, undefined)
  assert.equal(s.url, undefined)
  // 界面要能看出"这是没配，不是坏了"
  assert.match(s.note, /未配置/)
})

test('可达 ⇒ reachable: true + 延迟', async () => {
  const f = fakeFetch({ status: 200 })
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://127.0.0.1:3080' },
    fetchImpl: f.impl,
    now: () => NOW,
    cacheMs: 0,
  })
  const s = await probe()
  assert.equal(s.reachable, true)
  assert.equal(s.status, 200)
  assert.ok(typeof s.latencyMs === 'number')
  assert.deepEqual(f.calls, ['http://127.0.0.1:3080'])
})

test('★ 连不上 ⇒ reachable: false，且提示要说清"面板仍正常，这是最难查的一种故障"', async () => {
  const f = fakeFetch({ throws: 'ECONNREFUSED' })
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://127.0.0.1:3080' },
    fetchImpl: f.impl,
    now: () => NOW,
    cacheMs: 0,
  })
  const s = await probe()
  assert.equal(s.reachable, false)
  assert.match(String(s.error), /ECONNREFUSED/)
  // 这条提示是给用户看的：QQ 与面板都正常，所以很容易误判成"模型不回我"
  assert.match(s.note, /模型那一侧/)
})

test('★ 错误信息**截断**（完整堆栈显示不下，也会泄露本机路径）', async () => {
  const long = 'x'.repeat(500)
  const f = fakeFetch({ throws: long })
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://x' },
    fetchImpl: f.impl,
    now: () => NOW,
    cacheMs: 0,
  })
  const s = await probe()
  assert.ok(String(s.error).length <= 165, `应当截断，实际 ${String(s.error).length}`)
})

test('★ 缓存：连续调用只探一次（面板刷新不该反复打 DSH）', async () => {
  const f = fakeFetch({ status: 200 })
  let clock = NOW.getTime()
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://x' },
    fetchImpl: f.impl,
    now: () => new Date(clock),
    cacheMs: 5000,
  })
  await probe()
  await probe()
  await probe()
  assert.equal(f.calls.length, 1, '5 秒内只该探一次')

  // 过了缓存期 ⇒ 再探
  clock += 6000
  await probe()
  assert.equal(f.calls.length, 2)
})

test('cacheMs=0 ⇒ 不缓存（每次真探）', async () => {
  const f = fakeFetch({ status: 200 })
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://x' },
    fetchImpl: f.impl,
    now: () => NOW,
    cacheMs: 0,
  })
  await probe()
  await probe()
  assert.equal(f.calls.length, 2)
})

test('唤醒桥配置状态独立上报（gateway 发唤醒的前提）', async () => {
  const probe = createDshStatusProbe({
    env: { FORLIFE_WAKE_BRIDGE_URL: 'http://127.0.0.1:3080/forlife/wake' },
    fetchImpl: fakeFetch({ status: 200 }).impl,
    now: () => NOW,
    cacheMs: 0,
  })
  const s = await probe()
  assert.equal(s.wakeBridgeConfigured, true)
  assert.equal(s.wakeBridgeUrl, 'http://127.0.0.1:3080/forlife/wake')
  // 从桥地址推导出的 DSH 地址
  assert.equal(s.url, 'http://127.0.0.1:3080')

  const noBridge = createDshStatusProbe({ env: {}, now: () => NOW, cacheMs: 0 })
  assert.equal((await noBridge()).wakeBridgeConfigured, false)
})

test('★ 短超时：DSH 挂住时探测自己会超时，不会把面板拖死', async () => {
  // 用一个永不 resolve 的 fetch 模拟"DSH 卡住"
  const probe = createDshStatusProbe({
    env: { FORLIFE_DSH_URL: 'http://x' },
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        // 只认 signal 的中止（模拟真实 fetch 的行为）
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      }),
    timeoutMs: 60,
    now: () => NOW,
    cacheMs: 0,
  })
  const started = Date.now()
  const s = await probe()
  const elapsed = Date.now() - started
  assert.equal(s.reachable, false, '超时应当算连不上')
  assert.ok(elapsed < 2000, `应当很快返回，实际 ${String(elapsed)}ms`)
})
