/**
 * 模型路由接线层的测试。
 *
 * ## 重点
 *
 * ① **默认必须是 `off`** —— 不能让一个没验证过的接线在用户不知情时开始改模型
 * ② **`observe` 只订阅、不打日志之外的事**（不许改任何东西）
 * ③ **一个监听器都没装上时要喊出来** —— 那等于路由根本没生效（今晚栽过 18 次这个）
 * ④ **订阅失败不抛**（路由是旁路，它挂掉不该带走主流程）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installModelRouter, resolveRouterMode } from '../src/model-router.ts'

/** 造一个假 ctx：只实现 `on`，并记下订阅了什么。 */
function fakeCtx(): { readonly ctx: never; readonly events: string[]; readonly listeners: number } {
  const events: string[] = []
  const ctx = {
    on(name: string, _fn: (p: unknown) => void): () => void {
      events.push(name)
      return () => {
        /* 拆 */
      }
    },
  }
  return {
    ctx: ctx as never,
    events,
    get listeners() {
      return events.length
    },
  }
}

test('模式解析：默认 off', () => {
  assert.equal(resolveRouterMode({}), 'off')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: '' }), 'off')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'off' }), 'off')
})

test('模式解析：只认 observe / apply，别的都当 off（**宁可不生效，也不要乱生效**）', () => {
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'observe' }), 'observe')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'APPLY' }), 'apply')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: '  apply  ' }), 'apply')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'yes' }), 'off')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'on' }), 'off')
  assert.equal(resolveRouterMode({ FORLIFE_ROUTER_MODE: 'true' }), 'off')
})

test('★ off 模式：一个监听器都不装', () => {
  const f = fakeCtx()
  const logs: string[] = []
  const handle = installModelRouter(f.ctx, { log: (m) => logs.push(m), env: {} })
  assert.equal(handle.mode, 'off')
  assert.equal(handle.listeners, 0)
  assert.deepEqual(f.events, [], 'off 模式不该订阅任何事件')
})

test('★ observe 模式：订阅三个事件（created / pre-step / turn-stopping）', () => {
  const f = fakeCtx()
  const handle = installModelRouter(f.ctx, { log: () => {}, env: { FORLIFE_ROUTER_MODE: 'observe' } })
  assert.equal(handle.mode, 'observe')
  assert.equal(handle.listeners, 3)
  assert.deepEqual(f.events, ['agent/created', 'agent/pre-step', 'agent/turn-stopping'])
})

test('★★ 一个监听器都没装上时要喊出来（那等于路由没生效）', () => {
  // 造一个 on() 抛异常的 ctx —— 模拟事件名与宿主对不上
  const ctx = {
    on(): () => void {
      throw new Error('no such event')
    },
  } as never
  const logs: string[] = []
  const handle = installModelRouter(ctx, { log: (m) => logs.push(m), env: { FORLIFE_ROUTER_MODE: 'observe' } })
  assert.equal(handle.listeners, 0)
  assert.ok(
    logs.some((l) => /只装上了 0 个监听器|事件名可能与宿主对不上/.test(l)),
    '装不上监听器时必须喊出来 —— 静默就等于第 19 次"接线断了"',
  )
})

test('★ 订阅失败不抛（路由是旁路，不该带走主流程）', () => {
  const ctx = {
    on(): () => void {
      throw new Error('炸了')
    },
  } as never
  assert.doesNotThrow(() => {
    installModelRouter(ctx, { log: () => {}, env: { FORLIFE_ROUTER_MODE: 'observe' } })
  })
})

test('★ observe 模式：事件来了只打日志，不许改任何东西', () => {
  const handlers = new Map<string, (p: unknown) => void>()
  const ctx = {
    on(name: string, fn: (p: unknown) => void): () => void {
      handlers.set(name, fn)
      return () => {}
    },
  } as never
  const logs: string[] = []
  installModelRouter(ctx, { log: (m) => logs.push(m), env: { FORLIFE_ROUTER_MODE: 'observe' } })

  // 模拟宿主发事件
  const agent = { session: { id: 'sess-1' } }
  handlers.get('agent/created')?.({ agent })
  handlers.get('agent/pre-step')?.({ agent, messages: [{}, {}], turn: 1, step: 1 })
  handlers.get('agent/turn-stopping')?.({ agent, turn: 1 })

  assert.ok(logs.some((l) => l.includes('agent/created') && l.includes('sess-1')), '要能看到 created')
  assert.ok(logs.some((l) => l.includes('agent/pre-step') && l.includes('messages=2 条')), '要能看到 pre-step 的输入条数')
  assert.ok(logs.some((l) => l.includes('agent/turn-stopping')), '要能看到 turn-stopping')
})

test('★ 事件载荷缺字段时不崩（宿主可能给不全）', () => {
  const handlers = new Map<string, (p: unknown) => void>()
  const ctx = {
    on(name: string, fn: (p: unknown) => void): () => void {
      handlers.set(name, fn)
      return () => {}
    },
  } as never
  installModelRouter(ctx, { log: () => {}, env: { FORLIFE_ROUTER_MODE: 'observe' } })
  assert.doesNotThrow(() => {
    handlers.get('agent/created')?.(undefined)
    handlers.get('agent/pre-step')?.({})
    handlers.get('agent/pre-step')?.({ agent: null })
    handlers.get('agent/turn-stopping')?.({ agent: '不是对象' })
  })
})

test('dispose 之后不再持有监听器', () => {
  const f = fakeCtx()
  const handle = installModelRouter(f.ctx, { log: () => {}, env: { FORLIFE_ROUTER_MODE: 'observe' } })
  assert.equal(handle.listeners, 3)
  handle.dispose()
  assert.doesNotThrow(() => { handle.dispose() }) // 幂等
})
