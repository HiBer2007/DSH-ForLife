/**
 * 系统事件钩子的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **未启用时返回 undefined，而不是假装成功** —— 调用方要靠这个返回值
 *    决定"要不要记日志"，假装成功会让日志说"已触发"而实际没有。
 * 2. **观察者抛异常不能带崩业务链路** —— 一次"上报端点挂了"的失败
 *    不该让探测循环本身崩掉（那样面板会永久停在旧值上，且没人知道）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, openDatabase } from '@forlife/store'

import { createSystemEventHooks } from '../src/wake-system-hooks.ts'
import { createSystemWakeSource } from '../src/wake-system-source.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 建一条听某事件的 system 触发器。 */
function mkSys(db: ReturnType<typeof openDatabase>['db'], event: string, title: string): string {
  const r = createWakeTrigger(db, {
    kind: 'system', scope: 'onebot11:123', title, prompt: 'p',
    spec: { event }, createdBy: 'test', now: AT,
  })
  return r.row!.id
}

/** 造一套。 */
function setup(): {
  db: ReturnType<typeof openDatabase>['db']
  hooks: ReturnType<typeof createSystemEventHooks>
  logs: string[]
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  const source = createSystemWakeSource({ db: opened.db, now: () => AT })
  const hooks = createSystemEventHooks({ source, log: (m) => logs.push(m) })
  return { db: opened.db, hooks, logs, close: () => opened.db.close() }
}

test('★ 未启用（source 为 undefined）⇒ 返回 undefined，不假装成功', () => {
  const hooks = createSystemEventHooks({ source: undefined })
  assert.equal(hooks.endpointUnavailable('ep', false), undefined)
  assert.equal(hooks.diskHigh('/data', true), undefined)
  assert.equal(hooks.migrationFailed('x'), undefined)
  assert.equal(hooks.compactionFailed('x'), undefined)
  assert.equal(hooks.contractMismatch('x'), undefined)
  assert.equal(hooks.jobFailed('j'), undefined)
  assert.equal(hooks.budgetExceeded('s'), undefined)
})

test('七个钩子都能触发对应的 system 触发器', () => {
  const s = setup()
  try {
    const cases: [string, () => ReturnType<typeof s.hooks.endpointUnavailable>][] = [
      ['endpoint.unavailable', () => s.hooks.endpointUnavailable('ep-a', false, 'ECONNREFUSED')],
      ['disk.high', () => s.hooks.diskHigh('/data', true, '92%')],
      ['migration.failed', () => s.hooks.migrationFailed('0023 失败')],
      ['compaction.failed', () => s.hooks.compactionFailed('事务回滚')],
      ['contract.mismatch', () => s.hooks.contractMismatch('tools.register 签名变了')],
      ['job.failed', () => s.hooks.jobFailed('nightly', 'exit 1')],
      ['budget.exceeded', () => s.hooks.budgetExceeded('daily', '用了 120%')],
    ]
    for (const [event, call] of cases) {
      const id = mkSys(s.db, event, `当 ${event}`)
      const out = call()
      assert.deepEqual(out?.triggered, [id], `${event} 应当触发`)
      // 复位
      s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    }
  } finally {
    s.close()
  }
})

test('★ 端点恢复（ok=true）也能触发（不发的话模型会以为服务一直不可用）', () => {
  const s = setup()
  try {
    const id = mkSys(s.db, 'endpoint.unavailable', '端点')
    assert.deepEqual(s.hooks.endpointUnavailable('ep-a', false)?.triggered, [id])
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    // 恢复：**同一个事件名**换状态（因为端点的"坏"就是同一个量的两种取值）
    assert.deepEqual(s.hooks.endpointUnavailable('ep-a', true)?.triggered, [id])
  } finally {
    s.close()
  }
})

test('★ 幂等：同一个端点连续上报"不可用" 50 次只触发 1 次', () => {
  const s = setup()
  try {
    const id = mkSys(s.db, 'endpoint.unavailable', '端点')
    assert.deepEqual(s.hooks.endpointUnavailable('ep-a', false)?.triggered, [id])
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    for (let i = 0; i < 50; i += 1) {
      const out = s.hooks.endpointUnavailable('ep-a', false)
      assert.deepEqual(out?.triggered, [], `第 ${String(i + 2)} 次不该触发`)
    }
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, null)
  } finally {
    s.close()
  }
})

test('★ 不同端点互不干扰（两个端点各断各的）', () => {
  const s = setup()
  try {
    const id = mkSys(s.db, 'endpoint.unavailable', '端点')
    assert.deepEqual(s.hooks.endpointUnavailable('ep-a', false)?.triggered, [id])
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    // **另一个端点第一次断** —— 不该被 a 的状态去重掉
    assert.deepEqual(s.hooks.endpointUnavailable('ep-b', false)?.triggered, [id])
  } finally {
    s.close()
  }
})

test('★ 观察者抛异常 ⇒ 吞掉并记日志（不能带崩业务链路）', () => {
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  try {
    const source = createSystemWakeSource({ db: opened.db, now: () => AT })
    const hooks = createSystemEventHooks({ source, log: (m) => logs.push(m) })
    // 造一个会抛的 source
    const broken = createSystemEventHooks({
      source: {
        observe: () => {
          throw new Error('上报炸了')
        },
        observeConnection: () => {
          throw new Error('上报炸了')
        },
        gate: source.gate,
      },
      log: (m) => logs.push(m),
    })
    // **关键**：不往外抛
    assert.doesNotThrow(() => broken.endpointUnavailable('ep', false))
    assert.equal(broken.endpointUnavailable('ep', false), undefined)
    assert.ok(logs.some((l) => l.includes('已忽略')), `应当记日志，实际：${JSON.stringify(logs)}`)
    // 正常的那个仍然能用
    assert.doesNotThrow(() => hooks.jobFailed('j'))
  } finally {
    opened.db.close()
  }
})

test('触发成功时记日志（排障要知道"有没有真的唤醒"）', () => {
  const s = setup()
  try {
    mkSys(s.db, 'disk.high', '磁盘')
    s.hooks.diskHigh('/data', true, '92%')
    assert.ok(s.logs.some((l) => l.includes('已触发 1 条唤醒')), `实际：${JSON.stringify(s.logs)}`)
  } finally {
    s.close()
  }
})

test('没有匹配触发器时不报"已触发"（日志不能说谎）', () => {
  const s = setup()
  try {
    s.hooks.jobFailed('没人听的任务')
    assert.equal(s.logs.some((l) => l.includes('已触发')), false, `实际：${JSON.stringify(s.logs)}`)
  } finally {
    s.close()
  }
})
