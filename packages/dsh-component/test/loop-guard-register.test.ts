/**
 * 死循环监控**注册**的测试（最后一步的守卫）。
 *
 * ## 最值得守的四条
 *
 * 1. ★★ **两种调用约定都要认** —— `agent/assistant-stream` 的类型签名是
 *    **一个 payload** `{agent, frame}`，而本项目里 `session/event` 的实测约定是
 *    **两个参数**。**猜错的话监控会静默失效**（拿不到 frame ⇒ 永远不判定），
 *    而那正是本项目反复踩的那类坑；
 * 2. ★ **拿不到钩子要明说**（`⚠️`）—— 静默的话，
 *    "监控在跑"和"监控没挂上"**从日志上看一模一样**；
 * 3. ★ **必须能反注册** —— 否则热重载会**重复挂载** ⇒
 *    一次输出被喂两遍 ⇒ **正常内容被判成重复**（最冤的误杀）；
 * 4. ★ **单帧处理绝不抛异常** —— 这个 handler 跑在**每一次模型输出**上，
 *    抛错会**毁掉整轮**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerLoopGuard } from '../src/loop-guard-register.ts'

/** 造一个假 ctx，记下注册了什么、能不能反注册。 */
function fakeCtx(): {
  ctx: unknown
  events: string[]
  fire: (...args: unknown[]) => void
  disposed: () => number
} {
  const events: string[] = []
  let handler: ((...args: unknown[]) => void) | null = null
  let disposeCount = 0
  return {
    events,
    disposed: () => disposeCount,
    fire: (...args: unknown[]) => handler?.(...args),
    ctx: {
      on: (event: string, h: (...args: unknown[]) => void) => {
        events.push(event)
        handler = h
        return () => {
          disposeCount += 1
        }
      },
    },
  }
}

function opts(): {
  logs: string[]
  alerts: string[]
  disposers: (() => void)[]
  log: (m: string) => void
  always: (m: string) => void
} {
  const logs: string[] = []
  const alerts: string[] = []
  return {
    logs,
    alerts,
    disposers: [],
    log: (m: string) => logs.push(m),
    always: (m: string) => alerts.push(m),
  }
}

test('★ 注册到 `agent/assistant-stream`（那是能看到原文的钩子）', () => {
  const c = fakeCtx()
  const o = opts()
  assert.equal(registerLoopGuard(c.ctx, o), true)
  assert.deepEqual(c.events, ['agent/assistant-stream'])
})

test('★★ 约定 A：**一个 payload** `{agent, frame}` —— 要认', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  const cancels: string[] = []
  const agent = { cancel: (x: { reason: string }): void => void cancels.push(x.reason) }
  // 反复喂**同一句话**（走 payload 形式）
  for (let i = 0; i < 14; i += 1) {
    c.fire({ agent, frame: { type: 'start' } })
    c.fire({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话反复出现' } } })
    c.fire({ agent, frame: { type: 'end' } })
  }
  assert.ok(cancels.length > 0, '**约定 A 下必须能判定并中止**')
})

test('★★ 约定 B：**两个参数** `(agent, frame)` —— 也要认', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  const cancels: string[] = []
  const agent = { cancel: (x: { reason: string }): void => void cancels.push(x.reason) }
  for (let i = 0; i < 14; i += 1) {
    c.fire(agent, { type: 'start' })
    c.fire(agent, { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话反复出现' } })
    c.fire(agent, { type: 'end' })
  }
  assert.ok(cancels.length > 0, '**约定 B 下也必须能判定并中止**')
})

test('★ 认不出的形状**静默跳过**（不抛、不误判）', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  c.fire('这不是一个帧')
  c.fire(null)
  c.fire(undefined, undefined)
  c.fire({ 无关字段: 1 })
  assert.equal(o.alerts.length, 0, '认不出不该报警（那是正常情况）')
})

test('★★ **拿不到钩子要明说**（静默的话"在跑"和"没挂上"看不出来）', () => {
  const o = opts()
  assert.equal(registerLoopGuard({}, o), false, '没有 ctx.on ⇒ 返回 false')
  assert.ok(o.alerts.length > 0, '**必须报警**')
  assert.match(o.alerts[0] ?? '', /死循环监控未挂载/, '要说清是什么没挂上')
})

test('★ `ctx.on` 抛异常时不致命，但**要报警**', () => {
  const o = opts()
  const ctx = {
    on: () => {
      throw new Error('宿主拒绝了')
    },
  }
  assert.equal(registerLoopGuard(ctx, o), false)
  assert.ok(o.alerts.length > 0, '要报警')
})

test('★★ 注册返回的反注册器**进了 disposers**（否则热重载会重复挂）', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  assert.equal(o.disposers.length, 1, '**必须收进 disposers**')
  o.disposers[0]?.()
  assert.equal(c.disposed(), 1, '反注册器要真的能反注册')
})

test('★ 挂上时**要留一条日志**（否则不知道它在不在跑）', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  assert.ok(o.logs.some((m) => m.includes('死循环监控')), '要有"已订阅"的日志')
})

test('★ 单帧处理**绝不抛异常**（它跑在每一次模型输出上）', () => {
  const c = fakeCtx()
  const o = opts()
  registerLoopGuard(c.ctx, o)
  // 喂一个会让内部炸的形状（agent 上没有 cancel）
  assert.doesNotThrow(() => {
    for (let i = 0; i < 20; i += 1) {
      c.fire({ agent: {}, frame: { type: 'start' } })
      c.fire({ agent: {}, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '重复内容在这里' } } })
      c.fire({ agent: {}, frame: { type: 'end' } })
    }
  }, '**绝不能让监控毁掉整轮**')
})
