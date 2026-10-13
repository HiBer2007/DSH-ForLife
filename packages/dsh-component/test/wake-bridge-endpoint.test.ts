/**
 * 唤醒桥端点的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **密钥 fail-closed**：`ctx.webServer` 自身无认证，而这个端点的作用是
 *    "叫醒模型并让它执行提示词" —— 没有认证就是**提权入口**。
 * 2. **不用 `sessionController.prompt()`**：它把 source 写成 `'user'`，
 *    会让系统唤醒在会话里**看起来像用户发言**。测试断言 source 是自定义的。
 * 3. **忙就如实回报"忙"**，不静默成功 —— 否则 gateway 以为已经唤醒了。
 * 4. **flush 失败要回报失败** —— 不 flush 的话那一轮可能没落盘，
 *    重启后历史没了而 gateway 以为"已经唤醒过了"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handleWakeRequest, registerWakeEndpoint, type WakeHost } from '../src/wake-bridge-endpoint.ts'

const SECRET = 's3cret'

/** 一个可观察的假宿主。 */
function fakeHost(options: { status?: string; flushOk?: boolean; missing?: boolean } = {}): {
  host: WakeHost
  injected: unknown[]
  flushed: unknown[]
  sources: string[]
} {
  const injected: unknown[] = []
  const flushed: unknown[] = []
  const sources: string[] = []
  const session = { id: 'sess-1' }
  const host: WakeHost = {
    resolveAgent: async (sessionId) =>
      options.missing === true
        ? undefined
        : {
            agent: {
              status: options.status ?? 'idle',
              followup: (message) => injected.push(message),
              session,
            },
          },
    flush: async (s) => {
      flushed.push(s)
      return options.flushOk ?? true
    },
    createMessage: ({ text, sourceKind, summary }) => {
      sources.push(sourceKind)
      return { text, sourceKind, summary }
    },
    withoutInitiator: async (fn) => fn(),
  }
  return { host, injected, flushed, sources }
}

const req = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ sessionId: 'onebot11:123', text: '叫醒', sourceKind: 'wake-timer', summary: '定时到点', ...over })

test('★ 密钥不对 ⇒ 401，且不区分"没给"与"给错了"（不给爆破提供信息）', async () => {
  const { host, injected } = fakeHost()
  for (const header of [undefined, '', 'wrong']) {
    const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': header }, req())
    assert.equal(r.status, 401, `header=${String(header)}`)
    assert.equal(r.body['ok'], false)
  }
  assert.equal(injected.length, 0, '密钥不对时绝不能注入')
})

test('★ 未配置密钥 ⇒ 503 且整个端点禁用（空密钥等于没有认证）', async () => {
  const { host, injected } = fakeHost()
  const r = await handleWakeRequest({ secret: '  ', host }, { 'x-forlife-wake-secret': '' }, req())
  assert.equal(r.status, 503)
  assert.match(String(r.body['reason']), /未配置密钥/)
  assert.equal(injected.length, 0)
})

test('成功路径：注入 + flush + 回报"模型做了什么"', async () => {
  const { host, injected, flushed, sources } = fakeHost()
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req())
  assert.equal(r.status, 200)
  assert.equal(r.body['ok'], true)
  assert.equal(injected.length, 1)
  assert.equal(flushed.length, 1, '必须 flush')
  // **source 必须是自定义的，不能是 'user'** —— 否则系统唤醒会看起来像用户发言
  assert.deepEqual(sources, ['wake-timer'])
  assert.notEqual(sources[0], 'user')
})

test('★ 会话忙 ⇒ 如实回报"忙"，不打断也不静默成功', async () => {
  const { host, injected, flushed } = fakeHost({ status: 'running' })
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req())
  assert.equal(r.status, 200)
  assert.equal(r.body['ok'], false, '**不能**回 ok=true —— gateway 会以为已经唤醒了')
  assert.match(String(r.body['reason']), /正忙/)
  assert.equal(injected.length, 0, '忙的时候不该注入')
  assert.equal(flushed.length, 0)
})

test('★ flush 失败 ⇒ 500 并说明后果（重启后这一轮可能丢失）', async () => {
  const { host, injected } = fakeHost({ flushOk: false })
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req())
  assert.equal(r.status, 500)
  assert.equal(r.body['ok'], false)
  assert.match(String(r.body['reason']), /落盘失败/)
  assert.match(String(r.body['reason']), /重启后/)
  assert.equal(injected.length, 1, '注入已经发生了（无法撤销），但结果要如实说是失败')
})

test('找不到会话 ⇒ 404（不是静默成功）', async () => {
  const { host } = fakeHost({ missing: true })
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req())
  assert.equal(r.status, 404)
  assert.match(String(r.body['reason']), /找不到会话/)
})

test('缺字段 / 坏 JSON 都给出明确 400', async () => {
  const { host } = fakeHost()
  const h = { 'x-forlife-wake-secret': SECRET }
  assert.equal((await handleWakeRequest({ secret: SECRET, host }, h, '不是 JSON')).status, 400)
  assert.equal((await handleWakeRequest({ secret: SECRET, host }, h, req({ sessionId: '' }))).status, 400)
  assert.equal((await handleWakeRequest({ secret: SECRET, host }, h, req({ text: '   ' }))).status, 400)
})

test('sourceKind 缺省时用 "wake"（而不是 "user"）', async () => {
  const { host, sources } = fakeHost()
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req({ sourceKind: '' }))
  assert.equal(r.status, 200)
  assert.deepEqual(sources, ['wake'])
})

test('dryRun：不注入但回报成功（排障用）', async () => {
  const { host, injected } = fakeHost()
  const r = await handleWakeRequest({ secret: SECRET, host }, { 'x-forlife-wake-secret': SECRET }, req({ dryRun: true }))
  assert.equal(r.status, 200)
  assert.equal(r.body['ok'], true)
  assert.match(String(r.body['modelDid']), /演练/)
  assert.equal(injected.length, 0, '演练不该真的注入')
})

test('registerWakeEndpoint：挂到指定路径，并能注销', () => {
  const registered: string[] = []
  let unregistered = false
  const dispose = registerWakeEndpoint(
    {
      register: (route) => {
        registered.push(route.path)
        return () => {
          unregistered = true
        }
      },
    },
    { secret: SECRET, host: fakeHost().host },
  )
  assert.deepEqual(registered, ['/forlife/wake'], '默认路径')
  dispose()
  assert.equal(unregistered, true)
})
