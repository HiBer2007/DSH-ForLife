/**
 * `installLoopGuard`（**把监控挂到宿主上**）的测试 —— 最后一步的守卫。
 *
 * ## 最值得守的六条
 *
 * 1. ★★ **两条腿都要挂上** —— 文字（`agent/assistant-stream`）与
 *    工具（`session/event` 的 `tool/call`）。**只挂一条腿时行为看起来一样**
 *    （另一条腿永远不判定），而那正是本项目反复踩的那类坑；
 * 2. ★★ **两种调用约定都要认** —— `agent/assistant-stream` 的类型签名是
 *    **一个 payload** `{agent, frame}`，而本项目里 `session/event` 的实测约定是
 *    **两个参数**。**猜错的话监控会静默失效**（拿不到 frame ⇒ 永远不判定）；
 * 3. ★★ **工具腿要真的中止本轮** —— 迁移前它**只记日志**，而且**挂在
 *    `forlife-memory` 的 `catch` 里**（用量采集失败才跑）⇒ 名义上在跑、实际从不执行。
 *    这条测试就是那个缺陷的守卫：宿主给 `session/event` 的是 **session**（不是 agent），
 *    所以要靠 `Agent.id === SessionId` 把两条腿接起来；
 * 4. ★ **拿不到钩子要明说**（`⚠️`）—— 静默的话，
 *    "监控在跑"和"监控没挂上"**从日志上看一模一样**；
 * 5. ★ **必须能反注册** —— 否则热重载会**重复挂载** ⇒
 *    一次输出被喂两遍 ⇒ **正常内容被判成重复**（最冤的误杀）；
 * 6. ★ **单帧处理绝不抛异常** —— 这个 handler 跑在**每一次模型输出/每次工具调用**上，
 *    抛错会**毁掉整轮**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installLoopGuard } from '../src/install.ts'

/** 造一个假 ctx：**每个事件各存一个 handler**（真的挂两个钩子时要能分别驱动）。 */
function fakeCtx(): {
  ctx: unknown
  events: string[]
  fire: (event: string, ...args: unknown[]) => void
  disposed: () => number
} {
  const events: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  let disposeCount = 0
  return {
    events,
    disposed: () => disposeCount,
    fire: (event, ...args) => handlers.get(event)?.(...args),
    ctx: {
      on: (event: string, h: (...args: unknown[]) => void) => {
        events.push(event)
        handlers.set(event, h)
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

/** 假 agent：记下每次 cancel 的 cause。`id` 就是会话 id（宿主如此）。 */
function fakeAgent(id: string): { agent: { id: string; cancel: (c: { kind: string; reason: string }) => void }; cancels: string[] } {
  const cancels: string[] = []
  return {
    cancels,
    agent: {
      id,
      cancel: (c: { kind: string; reason: string }): void => {
        cancels.push(`${c.kind}:${c.reason}`)
      },
    },
  }
}

const call = (name: string, args: unknown): unknown => ({ type: 'tool/call', name, arguments: JSON.stringify(args) })

test('★★ 两条腿都挂上（文字 + 工具）', () => {
  const c = fakeCtx()
  const o = opts()
  const r = installLoopGuard(c.ctx, o)
  assert.deepEqual(c.events, ['agent/assistant-stream', 'session/event'], '**两条腿各一条订阅**')
  assert.deepEqual(
    { mounted: r.mounted, text: r.text, tool: r.tool },
    { mounted: true, text: true, tool: true },
    '返回值要如实报告两条腿',
  )
  assert.ok(o.logs.some((m) => m.includes('死循环监控')), '文字腿要有"已订阅"日志')
  assert.ok(o.logs.some((m) => m.includes('工具调用事件')), '工具腿也要有"已订阅"日志')
})

test('★★ 约定 A：**一个 payload** `{agent, frame}` —— 要认', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  const { agent, cancels } = fakeAgent('s1')
  // 反复喂**同一句话**（走 payload 形式）
  for (let i = 0; i < 14; i += 1) {
    c.fire('agent/assistant-stream', { agent, frame: { type: 'start' } })
    c.fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话反复出现' } } })
    c.fire('agent/assistant-stream', { agent, frame: { type: 'end' } })
  }
  assert.ok(cancels.length > 0, '**约定 A 下必须能判定并中止**')
})

test('★★ 约定 B：**两个参数** `(agent, frame)` —— 也要认', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  const { agent, cancels } = fakeAgent('s1')
  for (let i = 0; i < 14; i += 1) {
    c.fire('agent/assistant-stream', agent, { type: 'start' })
    c.fire('agent/assistant-stream', agent, { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话反复出现' } })
    c.fire('agent/assistant-stream', agent, { type: 'end' })
  }
  assert.ok(cancels.length > 0, '**约定 B 下也必须能判定并中止**')
})

test('★★★ 工具腿：反复调同一个工具 ⇒ **真的中止本轮**（这是此前坏掉的那条）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  const { agent, cancels } = fakeAgent('session-1')

  // ① 先让这个会话的 agent 进表（真实时序就是这样：模型先说话/或先有输出流）
  c.fire('agent/assistant-stream', { agent, frame: { type: 'start' } })

  // ② 再喂同一个工具调用 12 次（`session/event` 的约定是 `(session, event)`）
  for (let i = 0; i < 12; i += 1) {
    c.fire('session/event', { id: 'session-1' }, call('read_file', { path: 'a.ts' }))
  }

  assert.ok(cancels.length > 0, '**工具侧死循环必须中止本轮**（此前只记日志、且从不执行）')
  assert.match(cancels[0] ?? '', /^hook:/, '**要用 `kind:hook` 那一档**')
  assert.ok(
    o.alerts.some((m) => m.includes('工具调用死循环')),
    '要有一条**看得见**的告警',
  )
})

test('★★ 工具腿：判出来了但**没挂上 agent** ⇒ 要报警，不能静默', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  for (let i = 0; i < 12; i += 1) {
    c.fire('session/event', { id: '没有见过的会话' }, call('read_file', { path: 'a.ts' }))
  }
  assert.ok(
    o.alerts.some((m) => m.includes('还没有挂上 agent')),
    '**判出来了却下不了手必须让人看见**（否则这条腿等于没接）',
  )
})

test('★ 工具腿：`tool/result` 不喂（它的重复可能只是那个工具返回固定内容）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  const { agent, cancels } = fakeAgent('s1')
  c.fire('agent/assistant-stream', { agent, frame: { type: 'start' } })
  for (let i = 0; i < 20; i += 1) {
    c.fire('session/event', { id: 's1' }, { type: 'tool/result', name: 'read_file', arguments: '{}' })
  }
  assert.equal(cancels.length, 0, '**结果重复不该判成循环**')
})

test('★ 认不出的形状**静默跳过**（不抛、不误判）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  c.fire('agent/assistant-stream', '这不是一个帧')
  c.fire('agent/assistant-stream', null)
  c.fire('agent/assistant-stream', undefined, undefined)
  c.fire('agent/assistant-stream', { 无关字段: 1 })
  assert.equal(o.alerts.length, 0, '认不出不该报警（那是正常情况）')
})

test('★★ **拿不到钩子要明说**（静默的话"在跑"和"没挂上"看不出来）', () => {
  const o = opts()
  const r = installLoopGuard({}, o)
  assert.equal(r.mounted, false, '没有 ctx.on ⇒ 没挂上')
  assert.equal(r.reason, 'no-ctx-on')
  assert.ok(o.alerts.length > 0, '**必须报警**')
  assert.match(o.alerts[0] ?? '', /死循环监控未挂载/, '要说清是什么没挂上')
})

test('★★ 工具腿：agent 拿到了但**没有 `cancel` 接口** ⇒ 也要报警，不能静默', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  // ★ 与"没挂上 agent"是**两种不同的成因**：这一条里 agent 在表里，只是它没有 cancel。
  const agent = { id: 's-no-cancel' }
  c.fire('agent/assistant-stream', { agent, frame: { type: 'start' } })
  for (let i = 0; i < 12; i += 1) {
    c.fire('session/event', { id: 's-no-cancel' }, call('read_file', { path: 'a.ts' }))
  }
  assert.ok(
    o.alerts.some((m) => m.includes('没有 cancel 接口')),
    '**"判出来了却下不了手"必须让人看见**（两种成因各有一条告警）',
  )
})

test('★ `ctx.on` 抛异常时不致命，但**要报警**', () => {
  const o = opts()
  const ctx = {
    on: () => {
      throw new Error('宿主拒绝了')
    },
  }
  const r = installLoopGuard(ctx, o)
  assert.equal(r.mounted, false)
  assert.ok(o.alerts.length > 0, '要报警')
  assert.ok(
    o.alerts.some((m) => m.includes('一条腿都没挂上')) || o.alerts.some((m) => m.includes('不可用')),
    '要说清两条腿都没挂上',
  )
})

test('★★ 注册返回的反注册器**进了 disposers**（否则热重载会重复挂）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  assert.equal(o.disposers.length, 2, '**两条腿各一个反注册器**')
  o.disposers[0]?.()
  o.disposers[1]?.()
  assert.equal(c.disposed(), 2, '反注册器要真的能反注册')
})

test('★ 挂上时**要留一条日志**（否则不知道它在不在跑）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  assert.ok(o.logs.some((m) => m.includes('死循环监控')), '要有"已订阅"的日志')
})

test('★ 单帧处理**绝不抛异常**（它跑在每一次模型输出上）', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  // 喂一个会让内部炸的形状（agent 上没有 cancel）
  assert.doesNotThrow(() => {
    for (let i = 0; i < 20; i += 1) {
      c.fire('agent/assistant-stream', { agent: {}, frame: { type: 'start' } })
      c.fire('agent/assistant-stream', { agent: {}, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '重复内容在这里' } } })
      c.fire('agent/assistant-stream', { agent: {}, frame: { type: 'end' } })
    }
  }, '**绝不能让监控毁掉整轮**')
})

test('★ 工具事件里的怪形状**绝不抛异常**', () => {
  const c = fakeCtx()
  const o = opts()
  installLoopGuard(c.ctx, o)
  assert.doesNotThrow(() => {
    c.fire('session/event')
    c.fire('session/event', null, null)
    c.fire('session/event', {}, { type: 'tool/call', name: '', arguments: {} })
    c.fire('session/event', { id: 123 }, { type: 'tool/call', name: 'x', arguments: undefined })
  })
})

test('★ 环境开关 `FORLIFE_LOOP_GUARD=off` ⇒ 不挂，而且要**说出来**', () => {
  const c = fakeCtx()
  const o = opts()
  const r = installLoopGuard(c.ctx, { ...o, env: { FORLIFE_LOOP_GUARD: 'off' } })
  assert.equal(r.mounted, false)
  assert.equal(r.reason, 'env-disabled')
  assert.deepEqual(c.events, [], '**一个钩子都不该挂**')
  assert.ok(o.logs.some((m) => m.includes('FORLIFE_LOOP_GUARD')), '关掉了也要留一行（不能静默不干活）')
})

test('★★ 同一个 ctx 重复 install ⇒ 第二次跳过（否则一次输出被喂两遍）', () => {
  const c = fakeCtx()
  const o1 = opts()
  const o2 = opts()
  installLoopGuard(c.ctx, o1)
  const second = installLoopGuard(c.ctx, o2)
  assert.equal(second.reason, 'already-mounted')
  assert.equal(c.events.length, 2, '**只有第一次的那两条订阅**')
  assert.equal(o2.disposers.length, 0, '第二次不该再往 disposers 里塞东西')
})

test('★ 只挂上一条腿时**不登记**（下一次调用还要能补挂另一条）', () => {
  // 让工具腿失败：第二次 `on` 抛异常
  const events: string[] = []
  let calls = 0
  const ctx = {
    on: (event: string, h: (...args: unknown[]) => void) => {
      events.push(event)
      calls += 1
      if (calls > 1) throw new Error('宿主拒绝了第二条订阅')
      return () => {}
    },
  }
  const o = opts()
  const first = installLoopGuard(ctx, o)
  assert.deepEqual({ text: first.text, tool: first.tool }, { text: true, tool: false }, '第一条腿应挂上')
  // 第二次（宿主恢复）应该**真的再试**，而不是被"已挂过"挡掉
  const ctx2 = { on: (event: string) => { events.push(event); return () => {} } }
  void ctx2
  const again = installLoopGuard(ctx, opts())
  assert.notEqual(again.reason, 'already-mounted', '**部分挂上不等于挂好了**')
})
