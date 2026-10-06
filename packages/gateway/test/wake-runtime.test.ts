/**
 * 唤醒运行时装配的守卫测试。
 *
 * 守两条：
 *  1. **没配就明确禁用**（不假装能唤醒）；
 *  2. **`scope='*'` 的触发器要说清"无处唤醒"**，而不是发空 sessionId 让桥去 404。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, listWakeEvents, openDatabase } from '@forlife/store'

import { createWakeRuntime, wakeConfigFromEnv } from '../src/wake-runtime.ts'

const ENV = { FORLIFE_WAKE_BRIDGE_URL: 'http://127.0.0.1:3080/forlife/wake', FORLIFE_WAKE_BRIDGE_SECRET: 's3cret' }
const T0 = new Date('2026-10-06T12:00:00.000Z')

test('★ 未配桥 ⇒ 明确禁用并说清缺哪个变量（不假装能唤醒）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const r = createWakeRuntime({ db: opened.db, env: {}, log: () => {} })
    assert.equal(r.engine, undefined)
    assert.match(r.disabledReason ?? '', /未启用/)
    assert.match(r.disabledReason ?? '', /FORLIFE_WAKE_BRIDGE_URL/)
    assert.match(r.disabledReason ?? '', /FORLIFE_WAKE_BRIDGE_SECRET/)
  } finally {
    opened.db.close()
  }
})

test('只配了一半：仍禁用，且只报缺的那一个', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const r = createWakeRuntime({ db: opened.db, env: { FORLIFE_WAKE_BRIDGE_URL: 'http://x/y' }, log: () => {} })
    assert.equal(r.engine, undefined)
    assert.match(r.disabledReason ?? '', /FORLIFE_WAKE_BRIDGE_SECRET/)
    assert.doesNotMatch(r.disabledReason ?? '', /FORLIFE_WAKE_BRIDGE_URL/)
  } finally {
    opened.db.close()
  }
})

test('wakeConfigFromEnv：tick 非法值退回 1000ms', () => {
  assert.equal(wakeConfigFromEnv({}).tickMs, 1000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WAKE_TICK_MS: '2000' }).tickMs, 2000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WAKE_TICK_MS: '0' }).tickMs, 1000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WAKE_TICK_MS: 'abc' }).tickMs, 1000)
})

test('配齐了：到点会真的调桥，并把提示词发过去', async () => {
  const opened = openDatabase({ file: ':memory:' })
  let sentBody = ''
  try {
    const r = createWakeRuntime({
      db: opened.db,
      env: ENV,
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async (_url, init) => {
        sentBody = String(init.body)
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, modelDid: '回了用户' }) }
      },
    })
    assert.ok(r.engine !== undefined)

    createWakeTrigger(opened.db, {
      kind: 'timer',
      scope: 'onebot11:123',
      title: '提醒吃药',
      prompt: '提醒用户吃药',
      spec: { delaySeconds: 120 },
      createdBy: 'model',
      nextFireAt: '2026-10-06T11:59:00.000Z',
      now: T0,
    })

    const outcomes = await r.engine.tick()
    assert.equal(outcomes[0]?.decision, 'fired')

    const body = JSON.parse(sentBody) as Record<string, unknown>
    assert.equal(body['sessionId'], 'onebot11:123')
    // sourceKind 要区分来源 —— 不能是 'user'
    assert.equal(body['sourceKind'], 'wake-timer')
    // 提示词要带上防注入框定
    assert.match(String(body['text']), /不是用户的新指令/)
    assert.match(String(body['text']), /提醒用户吃药/)
  } finally {
    opened.db.close()
  }
})

test('★ scope=* 的触发器：说清"无处唤醒"，而不是发空 sessionId 让桥去 404', async () => {
  const opened = openDatabase({ file: ':memory:' })
  let called = false
  try {
    const r = createWakeRuntime({
      db: opened.db,
      env: ENV,
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async () => {
        called = true
        return { ok: true, status: 200, text: async () => '{}' }
      },
    })
    createWakeTrigger(opened.db, {
      kind: 'timer', scope: '*', title: '只记账', prompt: 'p', spec: {}, createdBy: 'x',
      nextFireAt: '2026-10-06T11:59:00.000Z', now: T0,
    })

    const outcomes = await r.engine!.tick()
    assert.equal(outcomes[0]?.decision, 'failed')
    assert.match(outcomes[0]?.reason ?? '', /没有绑定会话/)
    assert.equal(called, false, '不该去调桥（那样只会得到一个 404）')

    // 失败也要留痕
    const events = listWakeEvents(opened.db, 10)
    assert.equal(events[0]?.['decision'], 'failed')
  } finally {
    opened.db.close()
  }
})

test('★ 桥不通 ⇒ 记成 failed（不能记成 fired，否则面板显示"已唤醒"而模型没动）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const r = createWakeRuntime({
      db: opened.db,
      env: ENV,
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    createWakeTrigger(opened.db, {
      kind: 'timer', scope: 'onebot11:123', title: 't', prompt: 'p', spec: {}, createdBy: 'x',
      nextFireAt: '2026-10-06T11:59:00.000Z', now: T0,
    })

    const outcomes = await r.engine!.tick()
    assert.equal(outcomes[0]?.decision, 'failed')
    assert.match(outcomes[0]?.reason ?? '', /连不上唤醒桥/)

    const events = listWakeEvents(opened.db, 10)
    assert.equal(events[0]?.['decision'], 'failed', '必须记成 failed')
  } finally {
    opened.db.close()
  }
})

test('提示词里带上"上次行动"（否则模型会重复劳动）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  let sentBody = ''
  try {
    const r = createWakeRuntime({
      db: opened.db,
      env: ENV,
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async (_url, init) => {
        sentBody = String(init.body)
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
      },
    })
    const created = createWakeTrigger(opened.db, {
      kind: 'timer', scope: 'onebot11:123', title: 't', prompt: 'p', spec: {}, createdBy: 'x',
      nextFireAt: '2026-10-06T11:59:00.000Z', now: T0,
    })
    // 造一条历史事件（上次行动）
    opened.db
      .prepare(
        `INSERT INTO wake_trigger_events (id, trigger_id, kind, fired_at, decision, model_did, created_at)
         VALUES ('we_1', ?, 'timer', '2026-10-06T11:00:00.000Z', 'fired', '上次查了天气', '2026-10-06T11:00:00.000Z')`,
      )
      .run(created.row!.id)

    await r.engine!.tick()
    const body = JSON.parse(sentBody) as Record<string, unknown>
    assert.match(String(body['text']), /## 上次醒来时你做了什么/)
    assert.match(String(body['text']), /上次查了天气/)
  } finally {
    opened.db.close()
  }
})
