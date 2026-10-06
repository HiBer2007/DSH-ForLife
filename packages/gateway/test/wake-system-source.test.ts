/**
 * 系统事件源的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **边沿检测贯通到触发器**：断线 10 分钟里每次重连失败都观察一次，
 *    但**只该标记一次** —— 这是验收③"重连后不重复唤醒"的最后一环。
 * 2. **"没有匹配的触发器"要如实回报** —— 用户看到"QQ 掉线了"却什么都没发生时，
 *    第一个疑问是"我明明设了触发器"。静默地什么都不做的话，他只能猜。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, listWakeTriggers, openDatabase } from '@forlife/store'

import { createSystemWakeSource, eventOfSpec, systemTriggerPayload } from '../src/wake-system-source.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 建一条 system 触发器。 */
function mkSystem(
  db: ReturnType<typeof openDatabase>['db'],
  event: string,
  over: { scope?: string; enabled?: boolean; title?: string } = {},
): string {
  const r = createWakeTrigger(db, {
    kind: 'system',
    scope: over.scope ?? 'onebot11:123',
    title: over.title ?? `当 ${event}`,
    prompt: '看看发生了什么',
    spec: { event },
    createdBy: 'test',
    now: AT,
  })
  assert.equal(r.ok, true, r.reason)
  if (over.enabled === false) {
    db.prepare('UPDATE wake_triggers SET enabled = 0 WHERE id = ?').run(r.row!.id)
  }
  return r.row!.id
}

function setup(): { db: ReturnType<typeof openDatabase>['db']; source: ReturnType<typeof createSystemWakeSource>; close: () => void } {
  const opened = openDatabase({ file: ':memory:' })
  const source = createSystemWakeSource({ db: opened.db, now: () => AT })
  return { db: opened.db, source, close: () => opened.db.close() }
}

test('eventOfSpec：坏 JSON / 缺字段都返回 undefined（不抛）', () => {
  assert.equal(eventOfSpec('{"event":"qq.disconnected"}'), 'qq.disconnected')
  assert.equal(eventOfSpec('{}'), undefined)
  assert.equal(eventOfSpec('{"event":""}'), undefined)
  assert.equal(eventOfSpec('不是 JSON'), undefined)
})

test('★ 事件发生 ⇒ 匹配的触发器被标成"到点"（数据库即通道）', () => {
  const s = setup()
  try {
    const id = mkSystem(s.db, 'qq.disconnected')
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, null, '初始没有下次时间')

    const out = s.source.observe('qq.disconnected', 'onebot11', 'down', 'ECONNRESET')
    assert.equal(out.changed, true)
    assert.deepEqual(out.triggered, [id])
    // 被标成"现在"⇒ 引擎下一次 tick 就会扫到
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, AT.toISOString())
  } finally {
    s.close()
  }
})

test('★ 边沿检测贯通：断线期间观察 100 次，只标记**一次**（验收③的最后一环）', () => {
  const s = setup()
  try {
    const id = mkSystem(s.db, 'qq.disconnected')
    const first = s.source.observe('qq.disconnected', 'onebot11', 'down')
    assert.deepEqual(first.triggered, [id])

    // 把它复位（模拟引擎已经处理过了）
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL WHERE id = ?').run(id)

    for (let i = 0; i < 100; i += 1) {
      const again = s.source.observe('qq.disconnected', 'onebot11', 'down')
      assert.equal(again.changed, false, `第 ${String(i + 2)} 次观察不该有变化`)
      assert.deepEqual(again.triggered, [], '不该再标记')
      assert.match(again.reason, /去重/)
    }
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, null, '复位后不该被再次标记')
  } finally {
    s.close()
  }
})

test('★ 恢复也要触发（不发的话模型会以为服务一直不可用）', () => {
  const s = setup()
  try {
    const down = mkSystem(s.db, 'qq.disconnected', { title: '断线' })
    const up = mkSystem(s.db, 'qq.reconnected', { title: '恢复' })

    s.source.observe('qq.disconnected', '', 'down')
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()

    const out = s.source.observe('qq.disconnected', '', 'up')
    assert.deepEqual(out.triggered, [down], 'up 是 down 这个事件的状态变化 ⇒ 触发的是 down 的触发器')
    assert.equal(getWakeTrigger(s.db, up)?.next_fire_at, null, 'reconnected 是**另一个事件名**，不该被它触发')
  } finally {
    s.close()
  }
})

test('★ 没有匹配的触发器 ⇒ **如实回报**（用户否则只能猜）', () => {
  const s = setup()
  try {
    const out = s.source.observe('disk.high', '/data', 'high')
    assert.equal(out.changed, true)
    assert.deepEqual(out.triggered, [])
    assert.match(out.reason, /没有匹配/)
    assert.match(out.reason, /disk\.high/)
    // 说清"事件已记录，未唤醒" —— 而不是让人以为整个机制坏了
    assert.match(out.reason, /未唤醒/)
  } finally {
    s.close()
  }
})

test('停用的触发器被跳过，且原因明确（不是静默忽略）', () => {
  const s = setup()
  try {
    const id = mkSystem(s.db, 'qq.disconnected', { enabled: false, title: '停了的' })
    const out = s.source.observe('qq.disconnected', '', 'down')
    assert.deepEqual(out.triggered, [])
    assert.equal(out.skipped.length, 1)
    assert.equal(out.skipped[0]?.id, id)
    assert.match(out.skipped[0]?.reason ?? '', /已停用/)
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, null, '停用的不该被标记')
  } finally {
    s.close()
  }
})

test('★ scope=* 的触发器被跳过（提前拦掉，免得引擎里多一条无意义的失败记录）', () => {
  const s = setup()
  try {
    mkSystem(s.db, 'qq.disconnected', { scope: '*', title: '没绑会话' })
    const out = s.source.observe('qq.disconnected', '', 'down')
    assert.deepEqual(out.triggered, [])
    assert.match(out.skipped[0]?.reason ?? '', /没有绑定会话/)
  } finally {
    s.close()
  }
})

test('只匹配**同名事件**的触发器（不同事件互不干扰）', () => {
  const s = setup()
  try {
    const qq = mkSystem(s.db, 'qq.disconnected', { title: 'QQ' })
    const disk = mkSystem(s.db, 'disk.high', { title: '磁盘' })

    const out = s.source.observe('qq.disconnected', '', 'down')
    assert.deepEqual(out.triggered, [qq])
    assert.equal(getWakeTrigger(s.db, disk)?.next_fire_at, null, '磁盘触发器不该被 QQ 事件触发')
  } finally {
    s.close()
  }
})

test('一次事件可以匹配多条触发器（逐条回报，不只说"处理完了"）', () => {
  const s = setup()
  try {
    const a = mkSystem(s.db, 'qq.disconnected', { title: '给用户' })
    const b = mkSystem(s.db, 'qq.disconnected', { title: '只记账' })
    const out = s.source.observe('qq.disconnected', '', 'down')
    assert.equal(out.triggered.length, 2)
    assert.ok(out.triggered.includes(a) && out.triggered.includes(b))
  } finally {
    s.close()
  }
})

test('不认识的事件名：不标记任何东西，原因里列出白名单', () => {
  const s = setup()
  try {
    mkSystem(s.db, 'qq.disconnected')
    const out = s.source.observe('qq.掉线', '', 'down')
    assert.deepEqual(out.triggered, [])
    assert.match(out.reason, /不认识的事件名/)
    assert.equal(listWakeTriggers(s.db).every((r) => r.next_fire_at === null), true)
  } finally {
    s.close()
  }
})

test('systemTriggerPayload：只放事实（会被拼进提示词的"数据"段）', () => {
  const p = systemTriggerPayload('qq.disconnected', 'onebot11', 'down', AT, 'ECONNRESET')
  assert.deepEqual(p, { event: 'qq.disconnected', source: 'onebot11', state: 'down', at: AT.toISOString(), detail: 'ECONNRESET' })
})
