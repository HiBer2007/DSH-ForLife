/**
 * Trigger Engine 的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **错过触发只补一次**（不是 N 次）—— 停机两小时后重启，
 *    补醒 10 次会把用户砸懵，而"全丢掉"会让"每天 9 点提醒吃药"在重启那天静默失效。
 * 2. **被拦下的 timer 也要推进 next_fire_at** —— 否则它会**卡在过去**，
 *    每个 tick 都重试一次，日志被刷满而唤醒一次都没成功。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, listWakeEvents, openDatabase, setWakePaused, updateWakeTrigger } from '@forlife/store'

import { createWakeEngine, nextFireAt, periodOf, type DispatchResult } from '../src/wake-engine.ts'

const T0 = new Date('2026-10-06T12:00:00.000Z')

/** 一个可控时钟 + 可注入的派发器。 */
function setup(options: { dispatch?: () => Promise<DispatchResult> } = {}): {
  db: ReturnType<typeof openDatabase>['db']
  clock: { at: Date }
  dispatched: string[]
  engine: ReturnType<typeof createWakeEngine>
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const clock = { at: T0 }
  const dispatched: string[] = []
  const engine = createWakeEngine({
    db: opened.db,
    now: () => clock.at,
    setIntervalImpl: () => ({ unref: () => {} }),
    clearIntervalImpl: () => {},
    dispatch: async ({ trigger }) => {
      dispatched.push(trigger.title)
      return options.dispatch === undefined ? { ok: true, reason: 'ok', costTokens: 100, modelDid: '做了点什么' } : options.dispatch()
    },
  })
  return { db: opened.db, clock, dispatched, engine, close: () => opened.db.close() }
}

/** 建一条 timer。 */
function mkTimer(db: ReturnType<typeof openDatabase>['db'], title: string, nextFireAtIso: string, spec: unknown = {}) {
  const r = createWakeTrigger(db, {
    kind: 'timer',
    scope: 'onebot11:123',
    title,
    prompt: '做点什么',
    spec,
    createdBy: 'test',
    nextFireAt: nextFireAtIso,
    now: T0,
  })
  assert.equal(r.ok, true, r.reason)
  return r.row!
}

test('periodOf / nextFireAt：一次性没有下一次；周期性的从**现在**往后推', () => {
  assert.equal(periodOf({}), null)
  assert.equal(periodOf({ everyMs: 500 }), null, '小于 1 秒的周期不算（防刷屏）')
  assert.equal(periodOf({ everyMs: 60_000 }), 60_000)

  assert.equal(nextFireAt({}, T0), null, '一次性触发器没有下一次')
  assert.equal(nextFireAt({ everyMs: 60_000 }, T0), '2026-10-06T12:01:00.000Z')
  // **关键**：从"现在"推，而不是从"上次该触发"推 ——
  // 后者会把停机期间攒下的每一次都算出来，于是补醒 N 次
  const later = new Date('2026-10-06T15:00:00.000Z')
  assert.equal(nextFireAt({ everyMs: 60_000 }, later), '2026-10-06T15:01:00.000Z')
})

test('到点则派发，并记账（含"模型做了什么"与花费）', async () => {
  const s = setup()
  try {
    mkTimer(s.db, '到点了', '2026-10-06T11:59:00.000Z')
    const outcomes = await s.engine.tick()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]?.decision, 'fired')
    assert.deepEqual(s.dispatched, ['到点了'])

    const events = listWakeEvents(s.db, 10)
    assert.equal(events[0]?.['decision'], 'fired')
    assert.equal(events[0]?.['cost_tokens'], 100)
    assert.equal(events[0]?.['model_did'], '做了点什么')
  } finally {
    s.close()
  }
})

test('★ 错过触发**只补一次**（停机两小时，不是补醒 N 次）', async () => {
  const s = setup()
  try {
    // 周期 1 分钟、原定 2 小时前 ⇒ 停机期间"本该"触发 120 次
    mkTimer(s.db, '每分钟的活', '2026-10-06T10:00:00.000Z', { everyMs: 60_000 })

    const outcomes = await s.engine.tick()
    assert.equal(outcomes.length, 1, '只该醒一次')
    assert.equal(s.dispatched.length, 1, '派发也只该有一次')

    // 再 tick 一次**不该**再醒（next_fire_at 已推进到未来）
    const again = await s.engine.tick()
    assert.equal(again.length, 0, '推进到未来后不该再触发')

    // payload 里要说清"迟到了" —— 用户能看出这不是准点提醒
    const events = listWakeEvents(s.db, 10)
    assert.match(String(events[0]?.['payload'] ?? ''), /lateByMs/, 'payload 要带迟到信息')
    assert.match(String(events[0]?.['reason'] ?? ''), /顺延/)
  } finally {
    s.close()
  }
})

test('准点触发不带"迟到"标记', async () => {
  const s = setup()
  try {
    mkTimer(s.db, '刚到的', '2026-10-06T11:59:59.000Z')
    await s.engine.tick()
    const events = listWakeEvents(s.db, 10)
    assert.doesNotMatch(String(events[0]?.['payload'] ?? ''), /lateByMs/)
    assert.match(String(events[0]?.['reason'] ?? ''), /定时到点/)
  } finally {
    s.close()
  }
})

test('★ 被拦下的 timer 也要**推进 next_fire_at**（否则卡在过去、每个 tick 都重试）', async () => {
  const s = setup()
  try {
    mkTimer(s.db, '被静默的', '2026-10-06T11:59:00.000Z', { everyMs: 60_000 })
    setWakePaused(s.db, true)

    const first = await s.engine.tick()
    assert.equal(first[0]?.decision, 'paused')
    assert.equal(s.dispatched.length, 0, '暂停时不该派发')

    // 关键：第二次 tick **不该**再看到它（它已经被推进到未来了）
    const second = await s.engine.tick()
    assert.equal(second.length, 0, '被拦下的也必须推进，否则会卡在过去反复重试')

    // 解除暂停后，要等到**下一个**周期点才会醒（而不是立刻补醒）
    setWakePaused(s.db, false)
    assert.equal((await s.engine.tick()).length, 0)
  } finally {
    s.close()
  }
})

test('★ 派发抛异常被接住（否则一次失败会杀掉整个 tick 循环）', async () => {
  const s = setup({
    dispatch: async () => {
      throw new Error('桥断了')
    },
  })
  try {
    mkTimer(s.db, '会炸的', '2026-10-06T11:59:00.000Z')
    const outcomes = await s.engine.tick()
    assert.equal(outcomes.length, 1, 'tick 本身不该抛')
    assert.equal(outcomes[0]?.decision, 'failed')
    assert.match(outcomes[0]?.reason ?? '', /派发异常/)

    // 失败也要留痕
    const events = listWakeEvents(s.db, 10)
    assert.equal(events[0]?.['decision'], 'failed')
  } finally {
    s.close()
  }
})

test('fireNow：立刻触发（wake_now / system / external 走它）', async () => {
  const s = setup()
  try {
    const row = mkTimer(s.db, '手动唤醒', '2027-01-01T00:00:00.000Z')
    const outcome = await s.engine.fireNow(row.id, '用户手动唤醒')
    assert.equal(outcome.decision, 'fired')
    assert.deepEqual(s.dispatched, ['手动唤醒'])
  } finally {
    s.close()
  }
})

test('fireNow：不存在的触发器给出明确结果（不是静默成功）', async () => {
  const s = setup()
  try {
    const outcome = await s.engine.fireNow('wt_不存在', '手动')
    assert.equal(outcome.decision, 'failed')
    assert.match(outcome.reason, /没有这条触发器/)
  } finally {
    s.close()
  }
})

test('fireNow 不推进 next_fire_at（手动触发不该打乱周期）', async () => {
  const s = setup()
  try {
    const row = mkTimer(s.db, '周期活', '2026-10-06T12:01:00.000Z', { everyMs: 60_000 })
    await s.engine.fireNow(row.id, '手动')
    const after = (await import('@forlife/store')).getWakeTrigger(s.db, row.id)!
    assert.equal(after.next_fire_at, '2026-10-06T12:01:00.000Z', '手动触发不该改周期点')
  } finally {
    s.close()
  }
})

test('停用的触发器不会被 tick 扫到', async () => {
  const s = setup()
  try {
    const row = mkTimer(s.db, '停用的', '2026-10-06T11:59:00.000Z')
    updateWakeTrigger(s.db, row.id, { enabled: false }, T0)
    assert.equal((await s.engine.tick()).length, 0)
  } finally {
    s.close()
  }
})

test('坏 spec 不抛（一条坏数据不该让引擎停摆）', () => {
  assert.deepEqual(periodOf('不是对象'), null)
  assert.deepEqual(periodOf(null), null)
})
