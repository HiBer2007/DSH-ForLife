/**
 * 工具调用侧死循环监控的测试。
 *
 * ## 最值得守的四条
 *
 * 1. ★★ **反复调同一个工具（同样参数）要抓到** —— 那是"不发言的循环"，
 *    `assistant-stream` 那一层**完全拦不到**；
 * 2. ★★ **正常交替不能误判** —— 一轮里"说一句 → 调工具 → 再说一句"是**正常的**，
 *    而且 `name(args)` 每次不同时**不该**被判成重复；
 * 3. ★ **`offset` 递增这类"确实在推进"的不算循环** ——
 *    相似度规则要求"公共前后缀 ≥ 0.8"，尾部每次在变时相似度会掉下来；
 * 4. ★ **只认 `tool/call`**（`tool/result` 的重复可能只是那个工具返回固定内容）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createToolLoopGuard } from '../src/tool-loop-guard.ts'

const call = (name: string, args: unknown): unknown => ({ type: 'tool/call', name, arguments: JSON.stringify(args) })

test('★★ 反复调同一个工具（同样参数）⇒ 判停', () => {
  const g = createToolLoopGuard()
  let v = null
  for (let i = 0; i < 14; i += 1) v = g.feed(call('read_file', { path: 'a.ts' }))
  assert.ok(v !== null, '应当有判定')
  assert.equal(v.action, 'stop-and-restart', `**不发言的循环必须抓到**：${v.reason}`)
})

test('★★ 正常交替（工具名/参数每次都不同）**不能**判停', () => {
  const g = createToolLoopGuard()
  let v = null
  const normal = [
    call('read_file', { path: 'a.ts' }),
    call('read_file', { path: 'b.ts' }),
    call('grep', { pattern: 'foo', path: 'src' }),
    call('read_file', { path: 'c.ts' }),
    call('edit_file', { path: 'c.ts', old: 'x', new: 'y' }),
    call('run_tests', { filter: 'unit' }),
    call('read_file', { path: 'd.ts' }),
    call('grep', { pattern: 'bar', path: 'test' }),
    call('write_file', { path: 'e.ts', content: '...' }),
    call('run_tests', { filter: 'e2e' }),
  ]
  for (const e of normal) v = g.feed(e)
  assert.notEqual(v?.action, 'stop-and-restart', `**正常工具序列被误杀**：${v?.reason ?? ''}`)
})

test('★ `offset` 递增（**确实在推进**）不算循环', () => {
  const g = createToolLoopGuard()
  let v = null
  // 一页一页往后读 —— **尾部每次都在变**
  for (let i = 0; i < 14; i += 1) v = g.feed(call('read_file', { path: 'big.ts', offset: i * 100, limit: 100 }))
  assert.notEqual(v?.action, 'stop-and-restart', `**推进被误判成循环**：${v?.reason ?? ''}`)
})

test('⚠️ **已知限制**：参数每次都变（哪怕只改无关字段）⇒ **工具侧判不出来**', () => {
  const g = createToolLoopGuard()
  let v = null
  // 每次改一个**不影响语义**的字段（加个时间戳）——
  // 那**是**"看起来在变、其实在原地打转"，但**工具侧判不出来**。
  for (let i = 0; i < 14; i += 1) {
    v = g.feed(call('read_file', { path: 'same.ts', _ts: i }))
  }
  // ★ **这条测的是"已知限制"，不是"正确行为"。**
  //
  // 要判出这种情形，必须**理解参数语义**
  // （`_ts` 是无关字段，而 `offset` 是推进）——
  // 那正是本模块**明确决定不做的事**（模块头写着"把判断留给一处，
  // 而不是在两个地方各写一半"）。
  //
  // ⇒ **精确重复能抓**（那是绝大多数真实循环的样子），
  //   **"每次参数都不同"抓不到** —— **如实记在这里，不假装没有。**
  //
  // **写成断言而不是删掉这条测试**：这样"限制"是**被记录且有测试守着**的，
  // 哪天要补这个能力，这条测试会提醒改它。
  assert.equal(v?.action, 'ok', '当前实现**确实判不出来** —— 这是已知限制（见模块头）')
})

test('★ 只认 `tool/call`（`tool/result` 不喂）', () => {
  const g = createToolLoopGuard()
  const r = g.feed({ type: 'tool/result', name: 'read_file', arguments: '{}' })
  assert.equal(r, null, '不是 tool/call ⇒ 返回 null')
  assert.equal(g.count(), 0, '**不该被计数**')
})

test('★ 形状不对时静默跳过（不抛）', () => {
  const g = createToolLoopGuard()
  assert.doesNotThrow(() => {
    g.feed(null)
    g.feed(undefined)
    g.feed('字符串')
    g.feed({ type: 'tool/call' }) // 没有 name
    g.feed({ type: 'tool/call', name: '' })
  })
  assert.equal(g.count(), 0, '没有 name 的不计数')
})

test('★ `arguments` 是对象时也能收（不假设它一定是字符串）', () => {
  const g = createToolLoopGuard()
  let v = null
  for (let i = 0; i < 14; i += 1) v = g.feed({ type: 'tool/call', name: 'read_file', arguments: { path: 'a.ts' } })
  assert.equal(v?.action, 'stop-and-restart', '对象形式的参数也要能判')
})

test('★ 计数可查（排障用）', () => {
  const g = createToolLoopGuard()
  for (let i = 0; i < 5; i += 1) g.feed(call('x', { i }))
  assert.equal(g.count(), 5)
})
