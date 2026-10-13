/**
 * `LogStreamFallback` 的测试 —— **SSE 优先、失败回退、还能回来**。
 *
 * ## 最值得守的四条
 *
 * 1. ★★ **SSE 失败 ⇒ 降级到轮询** —— 不回退的话"日志完全不更新"，
 *    用户会以为**系统没日志**，而真相是**面板瞎了**；
 * 2. ★★ **降级后还会再试 SSE** —— 只降级不重试的话，
 *    一次瞬时抖动就把这个标签页**永久锁在轮询上**（而用户不知道）；
 * 3. ★ **退避有上限**（避免"一直失败一直重连"的风暴）；
 * 4. ★ **状态要能描述出来**（"当前用 SSE 还是轮询"必须能显示）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LogStreamFallback } from '../src/log-stream.ts'

test('★ 初始状态是 SSE（**优先用实时推送**）', () => {
  const f = new LogStreamFallback()
  assert.equal(f.transport, 'sse')
  assert.equal(f.lastReason, null)
})

test('★★ **SSE 失败 ⇒ 降级到轮询**', () => {
  const f = new LogStreamFallback()
  f.report({ ok: false, reason: '反代不支持流式' })
  assert.equal(f.transport, 'poll', '**必须降级** —— 不降的话日志完全不更新')
  assert.equal(f.lastReason, '反代不支持流式', '**原因要留下**（否则没人知道为什么降级了）')
})

test('★★ **降级后还会再试 SSE**（不然一次抖动就永久锁在轮询上）', () => {
  const f = new LogStreamFallback({ retryBaseMs: 1000 })
  f.report({ ok: false, reason: '抖了一下' })
  assert.equal(f.transport, 'poll')
  // 冷却期内不该重试
  assert.equal(f.tick(500), false, '冷却期内不重试')
  // 冷却结束后应当可以重试
  assert.equal(f.tick(600), true, '**冷却结束后要能重试**')
})

test('★★ 重试成功 ⇒ **回到 SSE**，并清掉失败计数与原因', () => {
  const f = new LogStreamFallback({ retryBaseMs: 1000 })
  f.report({ ok: false, reason: '抖了一下' })
  f.tick(1000)
  f.report({ ok: true })
  assert.equal(f.transport, 'sse', '**要能回到实时推送**')
  assert.equal(f.failures, 0, '失败计数要清零')
  assert.equal(f.lastReason, null, '原因要清掉')
})

test('★ 退避**逐次变长**（避免一直失败一直重连的风暴）', () => {
  const f = new LogStreamFallback({ retryBaseMs: 1000 })
  f.report({ ok: false })
  const first = f.cooldownMs
  f.report({ ok: false })
  const second = f.cooldownMs
  f.report({ ok: false })
  const third = f.cooldownMs
  assert.ok(second > first, `第二次该比第一次长：${String(first)} → ${String(second)}`)
  assert.ok(third > second, `第三次该比第二次长：${String(second)} → ${String(third)}`)
})

test('★ 退避**有上限**（不能无限涨）', () => {
  const f = new LogStreamFallback({ retryBaseMs: 1000, retryMaxMs: 4000 })
  for (let i = 0; i < 20; i += 1) f.report({ ok: false })
  assert.ok(f.cooldownMs <= 4000, `退避要封顶，实际 ${String(f.cooldownMs)}`)
})

test('★ `describe()` 要**说清当前用什么**（排障时靠它）', () => {
  const f = new LogStreamFallback()
  assert.match(f.describe(), /SSE/, 'SSE 时要说 SSE')
  f.report({ ok: false, reason: '连接被拒' })
  const d = f.describe()
  assert.match(d, /轮询/, '**降级后要说清是轮询**')
  assert.match(d, /连接被拒/, '要说清原因')
  assert.match(d, /重试/, '要说清会重试')
})

test('★ 没有失败原因时也要能描述（不能崩）', () => {
  const f = new LogStreamFallback()
  f.report({ ok: false })
  assert.doesNotThrow(() => f.describe())
  assert.match(f.describe(), /未知原因/, '没有原因时要说"未知"')
})

test('★ `tick` 在 SSE 正常时返回 true（不用等冷却）', () => {
  const f = new LogStreamFallback()
  assert.equal(f.tick(0), true, 'SSE 正常时随时可用')
})

test('★ 冷却不会因为反复 `tick` 而变成负数（幂等）', () => {
  const f = new LogStreamFallback({ retryBaseMs: 1000 })
  f.report({ ok: false })
  f.tick(5000)
  assert.equal(f.cooldownMs, 0)
  f.tick(5000)
  assert.equal(f.cooldownMs, 0, '不能变成负数')
})
