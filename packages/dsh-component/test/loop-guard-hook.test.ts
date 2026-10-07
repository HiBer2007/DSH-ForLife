/**
 * 死循环监控（宿主钩子版）的测试。
 *
 * ## 最值得守的四条
 *
 * 1. ★ **累积后才判定** —— `text-delta` 是碎片，每帧都喂的话
 *    **检测器看到的全是碎片，永远判不出重复**；
 * 2. ★ **判定越线时真的中止**（调 `agent.cancel`，且用 `kind:'hook'` 那一档）；
 * 3. ★ **按 agent 隔离** —— 两个会话交替发言**不能被算成重复**
 *    （那是最冤的误杀：两个正常会话被对方的正常内容判成循环）；
 * 4. ★ **正常输出不能触发中止**（误杀比漏判更糟 —— 前者让系统不可用）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LoopGuard } from '@forlife/store'

import { createLoopGuardHook } from '../src/loop-guard-hook.ts'

/** 造一个假 agent，记下它被 cancel 了几次、用的什么 cause。 */
function fakeAgent(): { agent: { cancel: (c: { kind: string; reason: string }) => void }; cancels: string[] } {
  const cancels: string[] = []
  return {
    cancels,
    agent: {
      cancel: (c: { kind: string; reason: string }): void => {
        cancels.push(`${c.kind}:${c.reason}`)
      },
    },
  }
}

/** 把一段文本按 `text-delta` 帧喂进去（模拟真实的流式）。 */
function feedText(
  hook: ReturnType<typeof createLoopGuardHook>,
  agent: { cancel: (c: { kind: string; reason: string }) => void },
  text: string,
  chunkSize = 7,
): void {
  hook.onFrame(agent, { type: 'start' })
  for (let i = 0; i < text.length; i += chunkSize) {
    hook.onFrame(agent, { type: 'chunk', chunk: { type: 'text-delta', text: text.slice(i, i + chunkSize) } })
  }
  hook.onFrame(agent, { type: 'end' })
}

test('★★ 碎片要**累积**后才判定（每帧都喂的话永远判不出重复）', () => {
  const hook = createLoopGuardHook()
  const { agent } = fakeAgent()
  hook.onFrame(agent, { type: 'start' })
  // 一帧一帧地喂**同一句话**的碎片 —— 每帧只有几个字
  const verdicts = []
  for (let i = 0; i < 60; i += 1) {
    const v = hook.onFrame(agent, { type: 'chunk', chunk: { type: 'text-delta', text: '我先看看这个文件' } })
    if (v !== null) verdicts.push(v)
  }
  // 因为要累积到 flushAt 才判定，所以**前几帧不该有判定**
  assert.ok(verdicts.length > 0, '累积到阈值后应当开始判定')
  assert.ok(
    verdicts.some((v) => v.action === 'stop-and-restart'),
    '**同一句话反复出现必须判停**',
  )
})

test('★★ 判定越线时**真的中止本轮**（且用 hook 那一档）', () => {
  const hook = createLoopGuardHook()
  const { agent, cancels } = fakeAgent()
  for (let i = 0; i < 14; i += 1) feedText(hook, agent, '我先看看这个文件的内容对不对')
  assert.ok(cancels.length > 0, '**必须真的调了 cancel**')
  assert.match(cancels[0] ?? '', /^hook:/, '**要用 `kind:hook` 那一档**（那是给插件用的）')
})

test('★★ **按 agent 隔离**：两个会话交替发言不能算成重复', () => {
  const hook = createLoopGuardHook()
  const a = fakeAgent()
  const b = fakeAgent()
  // A 说一句、B 说一句，交替 —— **各自的内容都不重复**
  const linesA = ['甲这边在看配置文件', '甲这边在跑测试', '甲这边在写文档', '甲这边在查日志', '甲这边在改代码']
  const linesB = ['乙这边在读需求', '乙这边在设计表', '乙这边在写迁移', '乙这边在测接口', '乙这边在发版本']
  for (let i = 0; i < 5; i += 1) {
    feedText(hook, a.agent, linesA[i] ?? '')
    feedText(hook, b.agent, linesB[i] ?? '')
  }
  assert.equal(a.cancels.length, 0, '**A 不该被中止**（它没有重复）')
  assert.equal(b.cancels.length, 0, '**B 不该被中止**（它没有重复）')
})

test('★★ **正常输出不能触发中止**（误杀比漏判更糟）', () => {
  const hook = createLoopGuardHook()
  const { agent, cancels } = fakeAgent()
  const normal = [
    '先看配置文件，里面写着端口和数据库路径。',
    '然后检查数据库文件是否存在，不存在就初始化。',
    '接着跑一遍迁移，把表结构建起来。',
    '最后启动服务，确认端口在监听。',
    '如果端口被占用，就换一个端口重试。',
  ]
  for (const line of normal) feedText(hook, agent, line)
  assert.equal(cancels.length, 0, `**正常输出被误杀了**：${cancels.join(' | ')}`)
})

test('★ 判定结果**要能解释**（带理由）', () => {
  const hook = createLoopGuardHook()
  const { agent } = fakeAgent()
  let last = null
  for (let i = 0; i < 14; i += 1) {
    last = hook.onFrame(agent, { type: 'start' }) ?? last
    hook.onFrame(agent, { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话反复出现' } })
    last = hook.onFrame(agent, { type: 'end' }) ?? last
  }
  assert.ok(last !== null, '应当有判定')
  assert.ok(String(last.reason).length > 0, '**要有理由** —— 否则线上没人知道为什么被停')
})

test('★ 非 text-delta 的帧不喂（reasoning / tool-call 增量不算"输出文字"）', () => {
  const hook = createLoopGuardHook()
  const { agent, cancels } = fakeAgent()
  for (let i = 0; i < 30; i += 1) {
    hook.onFrame(agent, { type: 'chunk', chunk: { type: 'reasoning-delta', text: '反复的思考内容' } })
    hook.onFrame(agent, { type: 'chunk', chunk: { type: 'tool-call-delta', text: '反复的工具调用' } })
  }
  assert.equal(cancels.length, 0, '这些不是"输出文字"，不该由这里判')
})

test('★ `flushAt` 暴露出来（阈值可查，便于排障）', () => {
  const hook = createLoopGuardHook()
  assert.ok(hook.flushAt > 0, '阈值要能查到')
})

test('★ 可以注入检测器（测试与调参用）', () => {
  const guard = new LoopGuard()
  const hook = createLoopGuardHook({ guard })
  const { agent } = fakeAgent()
  hook.onFrame(agent, { type: 'start' })
  hook.onFrame(agent, { type: 'chunk', chunk: { type: 'text-delta', text: '一句话' } })
  hook.onFrame(agent, { type: 'end' })
  assert.ok(guard.judge().signals.samples > 0, '注入的检测器**真的被用了**')
})
