/**
 * 系统事件闸门的守卫测试。
 *
 * ## 最值得守的一条：**边沿检测**
 *
 * PLAN 验收明确要求：「拔掉 QQ 连接 → 产生 `system` 触发并唤醒；
 * **重连后不重复唤醒（幂等）**」。
 *
 * 而 gateway 看到的不是"事件"，是**反复观察到的状态**：
 * QQ 断线期间每次重连尝试失败都会产生一条观察。直接转发的话，
 * 断线 10 分钟会唤醒**几百次** —— 而那 10 分钟里模型能做的事是零。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSystemPayload,
  createSystemEventGate,
  describeSystemEvent,
  isBadState,
  SYSTEM_EVENT_NAMES,
} from '../src/wake-events.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

test('★ 边沿检测：同一状态观察 100 次只发 1 次（防唤醒风暴）', () => {
  const gate = createSystemEventGate()
  const first = gate.observe('qq.disconnected', 'onebot11', 'down')
  assert.equal(first.emit, true, '第一次要发')
  assert.equal(first.reason, '首次观察到 down')

  for (let i = 0; i < 100; i += 1) {
    const again = gate.observe('qq.disconnected', 'onebot11', 'down')
    assert.equal(again.emit, false, `第 ${String(i + 2)} 次不该再发`)
    assert.match(again.reason, /去重/)
  }
})

test('★ 恢复也要发（不发的话模型会以为服务一直不可用）', () => {
  const gate = createSystemEventGate()
  gate.observe('qq.disconnected', '', 'down')
  const recovered = gate.observe('qq.disconnected', '', 'up')
  assert.equal(recovered.emit, true)
  assert.equal(recovered.reason, '状态变化 down → up')
})

test('★ 恢复之后再次故障 ⇒ **再发一次**（那是新故障，不是同一个的重复观察）', () => {
  const gate = createSystemEventGate()
  gate.observe('qq.disconnected', '', 'down') // 第一次故障
  gate.observe('qq.disconnected', '', 'up') // 恢复
  const second = gate.observe('qq.disconnected', '', 'down') // 又断了
  assert.equal(second.emit, true, '新的一次故障必须发')
  assert.match(second.reason, /up → down/)
})

test('★ 不同来源互不干扰（两个端点各断各的）', () => {
  const gate = createSystemEventGate()
  assert.equal(gate.observe('endpoint.unavailable', 'ep-a', 'down').emit, true)
  // 另一个端点第一次断 —— **不该**被 a 的状态去重掉
  assert.equal(gate.observe('endpoint.unavailable', 'ep-b', 'down').emit, true)
  // 同一个端点再观察 —— 去重
  assert.equal(gate.observe('endpoint.unavailable', 'ep-a', 'down').emit, false)
})

test('★ 不认识的事件名 ⇒ 明确拒绝并列出白名单（不静默忽略）', () => {
  const gate = createSystemEventGate()
  const r = gate.observe('qq.掉线了', '', 'down')
  assert.equal(r.emit, false)
  // 静默忽略的话，"我明明订阅了却没反应"会变成一个查很久的问题
  assert.match(r.reason, /不认识的事件名/)
  assert.match(r.reason, /qq\.disconnected/)
})

test('白名单固定九个（测试与文档共用一份）', () => {
  assert.equal(SYSTEM_EVENT_NAMES.length, 9)
  for (const n of ['qq.disconnected', 'qq.reconnected', 'endpoint.unavailable', 'disk.high', 'migration.failed', 'compaction.failed', 'contract.mismatch', 'job.failed', 'budget.exceeded']) {
    assert.ok((SYSTEM_EVENT_NAMES as readonly string[]).includes(n), `缺 ${n}`)
  }
})

test('snapshot / forget', () => {
  const gate = createSystemEventGate()
  gate.observe('disk.high', '/data', 'high')
  assert.deepEqual(gate.snapshot(), [{ name: 'disk.high', key: '/data', state: 'high' }])

  gate.forget('disk.high', '/data')
  assert.deepEqual(gate.snapshot(), [])
  // forget 之后下一次观察会当成"第一次"
  assert.equal(gate.observe('disk.high', '/data', 'high').emit, true)
})

test('isBadState：区分"坏消息"与"好消息"', () => {
  assert.equal(isBadState('qq.disconnected', 'down'), true)
  assert.equal(isBadState('qq.disconnected', 'up'), false)
  assert.equal(isBadState('disk.high', 'high'), true)
  assert.equal(isBadState('disk.high', 'ok'), false)
  // reconnected 本身就是好消息 —— 不管状态叫什么
  assert.equal(isBadState('qq.reconnected', 'up'), false)
})

test('payload 只放事实（它会被拼进提示词的"数据"段）', () => {
  const p = buildSystemPayload({ name: 'qq.disconnected', key: '', state: 'down', detail: 'ECONNRESET', at: AT })
  assert.deepEqual(p, {
    event: 'qq.disconnected',
    source: '(默认)',
    state: 'down',
    at: AT.toISOString(),
    detail: 'ECONNRESET',
  })
  // 不该有任何像"指令"的字段名
  assert.equal(Object.keys(p).some((k) => /instruct|command|do_/i.test(k)), false)
})

test('describeSystemEvent：每个事件都有一句人话（面板与提示词都用它）', () => {
  for (const name of SYSTEM_EVENT_NAMES) {
    const text = describeSystemEvent(name, 'down')
    assert.ok(text.length > 4, `${name} 缺少描述`)
    assert.doesNotMatch(text, /系统事件 .*（down）。$/, `${name} 落到了兜底分支`)
  }
  // QQ 断线要说清"你现在发不出也收不到"
  assert.match(describeSystemEvent('qq.disconnected', 'down'), /发不出消息/)
  // 恢复要说清"之前没做成的事现在可以做了"
  assert.match(describeSystemEvent('qq.reconnected', 'up'), /现在可以做了/)
})
