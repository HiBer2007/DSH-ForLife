/**
 * 监视程序监督器策略的守卫测试。
 *
 * ## 最值得守的三条
 *
 * 1. **probe 正常退出不该重启** —— 它本来就是"跑一次就退"。
 *    当成"该重启"的话，每次检查都会重启一遍，日志里全是重启记录。
 * 2. **退避必须有上限** —— 不夹上限的话 attempt=20 时是 1000×2^19 ≈ 6 天，
 *    而"等 6 天再重启"实际上等于**永不重启**（那不是退避，是静默放弃）。
 * 3. **超上限要自动停用**（验收明确要求）—— 而不是无限重启。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canTransition,
  checkLimits,
  checkScriptUnchanged,
  computeBackoff,
  decideAfterExit,
  DEFAULT_LIMITS,
  type ExitDecisionInput,
  type ProgramLimits,
} from '../src/wake-supervisor.ts'

const OK = { exitOk: true, durationMs: 100, outputBytes: 10 }
const BAD = { exitOk: false, durationMs: 100, outputBytes: 10 }

function input(over: Partial<ExitDecisionInput> = {}): ExitDecisionInput {
  return { contract: 'watcher', observation: BAD, restartCount: 0, limits: DEFAULT_LIMITS, killed: false, ...over }
}

test('★ probe 正常退出 ⇒ 停（它本来就是跑一次就退，不该重启）', () => {
  const d = decideAfterExit(input({ contract: 'probe', observation: OK }))
  assert.equal(d.action, 'stop')
  assert.match(d.reason, /跑一次就退/)
})

test('★ probe 异常退出 ⇒ 仍要重启（那不是"正常结束"）', () => {
  const d = decideAfterExit(input({ contract: 'probe', observation: BAD }))
  assert.equal(d.action, 'restart')
})

test('★ watcher / service 正常退出也算异常 ⇒ 重启（它们本该常驻）', () => {
  for (const contract of ['watcher', 'service'] as const) {
    const d = decideAfterExit(input({ contract, observation: OK }))
    assert.equal(d.action, 'restart', `${contract} 正常退出也该重启`)
    assert.match(d.reason, /不该自己退出/)
  }
})

test('★ kill 开关优先于一切（用户意图最高）', () => {
  const d = decideAfterExit(input({ killed: true, contract: 'watcher', observation: BAD, restartCount: 99 }))
  assert.equal(d.action, 'stop')
  assert.match(d.reason, /kill/)
})

test('★ 退避：指数增长且**夹住上限**', () => {
  const l: ProgramLimits = { ...DEFAULT_LIMITS, backoffBaseMs: 1000, backoffMaxMs: 10_000 }
  assert.equal(computeBackoff(1, l), 1000)
  assert.equal(computeBackoff(2, l), 2000)
  assert.equal(computeBackoff(3, l), 4000)
  assert.equal(computeBackoff(4, l), 8000)
  // 夹上限：不夹的话 1000 * 2^19 ≈ 6 天，那等于永不重启
  assert.equal(computeBackoff(5, l), 10_000)
  assert.equal(computeBackoff(20, l), 10_000, '再多次也要夹住')
  assert.equal(computeBackoff(0, l), 0)
})

test('★ 超过重启上限 ⇒ **自动停用并告警**（验收明确要求）', () => {
  const limits: ProgramLimits = { ...DEFAULT_LIMITS, maxRestarts: 3 }
  assert.equal(decideAfterExit(input({ limits, restartCount: 2 })).action, 'restart', '第 3 次还能重启')
  const d = decideAfterExit(input({ limits, restartCount: 3 }))
  assert.equal(d.action, 'disable', '第 4 次必须停用')
  assert.match(d.reason, /超过上限 3/)
  assert.match(d.reason, /自动停用/)
})

test('maxRestarts=0 表示不限（不会因为 0 就立刻停用）', () => {
  const limits: ProgramLimits = { ...DEFAULT_LIMITS, maxRestarts: 0 }
  assert.equal(decideAfterExit(input({ limits, restartCount: 999 })).action, 'restart')
})

test('★ 超时与超输出：都算超限，但**原因要分开**（措施不同）', () => {
  const limits: ProgramLimits = { ...DEFAULT_LIMITS, maxRuntimeMs: 1000, maxOutputBytes: 100 }

  const slow = checkLimits({ exitOk: true, durationMs: 5000, outputBytes: 10 }, limits)
  assert.equal(slow.exceeded, true)
  assert.match(slow.reason, /超时/)

  const chatty = checkLimits({ exitOk: true, durationMs: 10, outputBytes: 5000 }, limits)
  assert.equal(chatty.exceeded, true)
  assert.match(chatty.reason, /输出超限/)

  assert.equal(checkLimits({ exitOk: true, durationMs: 10, outputBytes: 10 }, limits).exceeded, false)
})

test('限额 0 表示不限（不会因为 0 就判超限）', () => {
  const limits: ProgramLimits = { ...DEFAULT_LIMITS, maxRuntimeMs: 0, maxOutputBytes: 0 }
  assert.equal(checkLimits({ exitOk: true, durationMs: 999_999, outputBytes: 999_999 }, limits).exceeded, false)
})

test('超限的运行会走重启逻辑，且原因里带上"为什么"', () => {
  const limits: ProgramLimits = { ...DEFAULT_LIMITS, maxRuntimeMs: 1000 }
  const d = decideAfterExit(input({ limits, observation: { exitOk: true, durationMs: 5000, outputBytes: 0 } }))
  assert.equal(d.action, 'restart')
  assert.match(d.reason, /超时/)
})

test('★ 脚本变更 ⇒ 需重新登记（不能自动接受）', () => {
  const changed = checkScriptUnchanged('aaa111', 'bbb222')
  assert.equal(changed.changed, true)
  assert.match(changed.reason, /已变更/)
  assert.match(changed.reason, /需重新登记/)

  assert.equal(checkScriptUnchanged('aaa111', 'aaa111').changed, false)
})

test('★ 空指纹算"变更"（登记时没记指纹是登记流程的问题，不能当"没变"）', () => {
  const r = checkScriptUnchanged('', 'bbb222')
  assert.equal(r.changed, true)
  assert.match(r.reason, /没有记录脚本指纹/)
})

test('★ disabled 不能被自动转移出去（否则"自动停用"会被下一次重启悄悄推翻）', () => {
  assert.equal(canTransition('disabled', 'running'), false)
  assert.equal(canTransition('disabled', 'stopped'), false, '只能由用户显式启用')
  assert.equal(canTransition('running', 'failed'), true)
  assert.equal(canTransition('failed', 'running'), true)
  assert.equal(canTransition('stopped', 'running'), true)
})
