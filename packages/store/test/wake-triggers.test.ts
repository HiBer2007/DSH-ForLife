/**
 * 唤醒引擎存储层 + 六道闸的守卫测试。
 *
 * ## 六道闸的边界是最值得测的东西
 *
 * "恰好等于日限算不算超"、"级联深度 3 是切断还是允许"这类**差一错误**，
 * 在真机上表现为"偶尔多醒一次"—— **几乎不可能靠观察发现**。
 * 所以边界必须在这里钉死。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/index.ts'
import {
  countFiredToday,
  createWakeTrigger,
  decideWake,
  deleteWakeTrigger,
  getWakeTrigger,
  isWakePaused,
  listDueTriggers,
  listWakeEvents,
  listWakeTriggers,
  markFired,
  MAX_CASCADE_DEPTH,
  recordWakeEvent,
  setWakePaused,
  updateWakeTrigger,
  type GateInput,
} from '../src/wake-triggers.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 一个"什么都不拦"的基准输入 —— 每个用例只改它关心的一两项。 */
function base(overrides: Partial<GateInput> = {}): GateInput {
  return {
    paused: false,
    quietUntil: null,
    firedToday: 0,
    dailyLimit: 0,
    spentTokens: 0,
    budgetTokens: 0,
    lastFiredAt: null,
    minIntervalMs: 0,
    depth: 0,
    now: AT,
    pendingInWindow: 1,
    mergeWindowMs: 0,
    ...overrides,
  }
}

test('基准：什么都不拦时允许唤醒', () => {
  const d = decideWake(base())
  assert.equal(d.allow, true)
  assert.equal(d.decision, 'fired')
})

test('★ 全局暂停优先于一切（用户按了暂停就是不想被打扰）', () => {
  // 即使同时满足其它所有"会拦"的条件，也应当报 paused
  const d = decideWake(base({ paused: true, quietUntil: '2027-01-01T00:00:00.000Z', depth: 99, dailyLimit: 1, firedToday: 9 }))
  assert.equal(d.allow, false)
  assert.equal(d.decision, 'paused')
})

test('★ 级联深度：**恰好等于 3 就切断**（PLAN 验收明确要求"在级联深度 3 处被切断"）', () => {
  assert.equal(MAX_CASCADE_DEPTH, 3)
  assert.equal(decideWake(base({ depth: 2 })).allow, true, '深度 2 应当允许')
  const d = decideWake(base({ depth: 3 }))
  assert.equal(d.allow, false, '深度 3 必须切断')
  assert.equal(d.decision, 'depth')
  // 原因要说清"疑似自激循环" —— 这是用户最需要知道的一个
  assert.match(d.reason, /自激循环/)
})

test('★ 级联深度排在静默期之前（自激是系统问题，比"现在不该吵"更严重）', () => {
  const d = decideWake(base({ depth: 3, quietUntil: '2027-01-01T00:00:00.000Z' }))
  assert.equal(d.decision, 'depth', '两个都命中时应当报 depth')
})

test('静默期：未到点则拦，到点后放行', () => {
  assert.equal(decideWake(base({ quietUntil: '2026-10-06T13:00:00.000Z' })).decision, 'quiet')
  // **恰好等于**静默期截止时刻 ⇒ 放行（静默期"到"了就该结束）
  assert.equal(decideWake(base({ quietUntil: '2026-10-06T12:00:00.000Z' })).allow, true)
  assert.equal(decideWake(base({ quietUntil: '2026-10-06T11:00:00.000Z' })).allow, true)
})

test('最小间隔：太近则合并（不是丢弃）', () => {
  const d = decideWake(base({ lastFiredAt: '2026-10-06T11:59:30.000Z', minIntervalMs: 60_000 }))
  assert.equal(d.allow, false)
  assert.equal(d.decision, 'merged', '间隔不够算"合并"，不算"丢弃"')
  // 恰好等于间隔 ⇒ 放行
  assert.equal(decideWake(base({ lastFiredAt: '2026-10-06T11:59:00.000Z', minIntervalMs: 60_000 })).allow, true)
})

test('★ 合并窗口：窗口内多次触发合并为一次', () => {
  assert.equal(decideWake(base({ pendingInWindow: 1, mergeWindowMs: 60_000 })).allow, true, '只有一次不用合并')
  const d = decideWake(base({ pendingInWindow: 7, mergeWindowMs: 60_000 }))
  assert.equal(d.allow, false)
  assert.equal(d.decision, 'merged')
  assert.match(d.reason, /7 次/, '原因里要说清攒了几次')
})

test('★ 日限边界：**恰好等于上限算超**（写成 > 的话"每天 3 次"会醒 4 次）', () => {
  assert.equal(decideWake(base({ dailyLimit: 3, firedToday: 2 })).allow, true, '第 3 次应当允许')
  const d = decideWake(base({ dailyLimit: 3, firedToday: 3 }))
  assert.equal(d.allow, false, '第 4 次必须拒（firedToday 已经 3 = 上限）')
  assert.equal(d.decision, 'budget')
})

test('token 预算：超了则拒', () => {
  assert.equal(decideWake(base({ budgetTokens: 1000, spentTokens: 999 })).allow, true)
  assert.equal(decideWake(base({ budgetTokens: 1000, spentTokens: 1000 })).decision, 'budget')
})

test('0 表示不限（而不是"一律拒绝"）', () => {
  // 这是最容易写反的地方：0 被当成"预算 0"的话，所有唤醒都会被拒
  assert.equal(decideWake(base({ dailyLimit: 0, firedToday: 999 })).allow, true)
  assert.equal(decideWake(base({ budgetTokens: 0, spentTokens: 999_999 })).allow, true)
  assert.equal(decideWake(base({ minIntervalMs: 0, lastFiredAt: '2026-10-06T11:59:59.999Z' })).allow, true)
})

test('触发器 CRUD：建 / 取 / 列 / 改 / 删', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const created = createWakeTrigger(opened.db, {
      kind: 'timer',
      scope: 'onebot11:123',
      title: '两分钟后提醒',
      prompt: '提醒我喝水',
      spec: { after: 120 },
      createdBy: 'model',
      nextFireAt: '2026-10-06T12:02:00.000Z',
      now: AT,
    })
    assert.equal(created.ok, true, created.reason)
    const id = created.row!.id

    assert.equal(getWakeTrigger(opened.db, id)?.title, '两分钟后提醒')
    assert.equal(listWakeTriggers(opened.db).length, 1)
    assert.equal(listWakeTriggers(opened.db, 'onebot11:123').length, 1)
    assert.equal(listWakeTriggers(opened.db, '别的会话').length, 0)

    assert.equal(updateWakeTrigger(opened.db, id, { title: '改过了', dailyLimit: 5 }, AT), true)
    const after = getWakeTrigger(opened.db, id)!
    assert.equal(after.title, '改过了')
    assert.equal(after.daily_limit, 5)
    assert.equal(after.updated_at, AT.toISOString())

    assert.equal(deleteWakeTrigger(opened.db, id), true)
    assert.equal(getWakeTrigger(opened.db, id), undefined)
  } finally {
    opened.db.close()
  }
})

test('创建时的三条必填校验（都不猜默认值）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const mk = (over: Record<string, unknown>) =>
      createWakeTrigger(opened.db, {
        kind: 'timer',
        scope: 's',
        title: 't',
        prompt: 'p',
        spec: {},
        createdBy: 'x',
        nextFireAt: '2026-10-06T12:02:00.000Z',
        now: AT,
        ...over,
      } as never)

    assert.match(mk({ title: '  ' }).reason, /标题不能为空/)
    // prompt 为空的话，唤醒后模型不知道要做什么 —— 那次唤醒就是纯浪费
    assert.match(mk({ prompt: '' }).reason, /prompt 不能为空/)
    assert.match(mk({ nextFireAt: null }).reason, /必须给 nextFireAt/)
  } finally {
    opened.db.close()
  }
})

test('负数配置被夹到 0（负数会让"是否超限"的比较全部反过来）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const created = createWakeTrigger(opened.db, {
      kind: 'timer',
      scope: 's',
      title: 't',
      prompt: 'p',
      spec: {},
      createdBy: 'x',
      nextFireAt: '2026-10-06T12:02:00.000Z',
      dailyLimit: -5,
      budgetTokens: -100,
      minIntervalMs: -1000,
      depth: -1,
      now: AT,
    })
    const row = created.row!
    assert.equal(row.daily_limit, 0)
    assert.equal(row.budget_tokens, 0)
    assert.equal(row.min_interval_ms, 0)
    assert.equal(row.depth, 0)
  } finally {
    opened.db.close()
  }
})

test('listDueTriggers：只给到点的、且只给 enabled 的', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const mk = (title: string, nextFireAt: string) =>
      createWakeTrigger(opened.db, {
        kind: 'timer', scope: 's', title, prompt: 'p', spec: {}, createdBy: 'x', nextFireAt, now: AT,
      })

    mk('已到点', '2026-10-06T11:00:00.000Z')
    mk('还没到', '2026-10-06T13:00:00.000Z')
    const disabled = mk('已到点但停用', '2026-10-06T11:00:00.000Z')
    updateWakeTrigger(opened.db, disabled.row!.id, { enabled: false }, AT)

    const due = listDueTriggers(opened.db, AT)
    assert.deepEqual(due.map((r) => r.title), ['已到点'])
  } finally {
    opened.db.close()
  }
})

test('markFired：更新 last_fired_at / fire_count / next_fire_at', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const created = createWakeTrigger(opened.db, {
      kind: 'timer', scope: 's', title: 't', prompt: 'p', spec: {}, createdBy: 'x',
      nextFireAt: '2026-10-06T12:00:00.000Z', now: AT,
    })
    const id = created.row!.id
    markFired(opened.db, id, '2026-10-06T13:00:00.000Z', AT)

    const row = getWakeTrigger(opened.db, id)!
    assert.equal(row.fire_count, 1)
    assert.equal(row.last_fired_at, AT.toISOString())
    assert.equal(row.next_fire_at, '2026-10-06T13:00:00.000Z', '周期任务要推进到下一次')
  } finally {
    opened.db.close()
  }
})

test('★ countFiredToday 只数"真的醒了"的（被拦下的不算进日限）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const created = createWakeTrigger(opened.db, {
      kind: 'timer', scope: 's', title: 't', prompt: 'p', spec: {}, createdBy: 'x',
      nextFireAt: '2026-10-06T12:00:00.000Z', now: AT,
    })
    const id = created.row!.id

    recordWakeEvent(opened.db, { triggerId: id, kind: 'timer', decision: 'fired', now: AT })
    recordWakeEvent(opened.db, { triggerId: id, kind: 'timer', decision: 'fired', now: AT })
    recordWakeEvent(opened.db, { triggerId: id, kind: 'timer', decision: 'quiet', now: AT })
    recordWakeEvent(opened.db, { triggerId: id, kind: 'timer', decision: 'budget', now: AT })

    // 被静默期/预算拦下的**不该**消耗日限 —— 否则"今天被拦了几次"会挤掉明天真正该醒的机会
    assert.equal(countFiredToday(opened.db, id, AT), 2)
    // 昨天的也不算
    assert.equal(countFiredToday(opened.db, id, new Date('2026-10-07T12:00:00.000Z')), 0)
  } finally {
    opened.db.close()
  }
})

test('唤醒事件：记录"模型做了什么"与花费（面板要显示）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    recordWakeEvent(opened.db, {
      triggerId: 'wt_x',
      kind: 'timer',
      decision: 'fired',
      sessionId: 'onebot11:123',
      turnOk: true,
      costTokens: 1234,
      modelDid: '查了天气并回了用户',
      now: AT,
    })
    const events = listWakeEvents(opened.db, 10)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.['model_did'], '查了天气并回了用户')
    assert.equal(events[0]?.['cost_tokens'], 1234)
    assert.equal(events[0]?.['turn_ok'], 1)
  } finally {
    opened.db.close()
  }
})

test('全局暂停开关：读写一致', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    assert.equal(isWakePaused(opened.db), false, '默认不暂停')
    setWakePaused(opened.db, true)
    assert.equal(isWakePaused(opened.db), true)
    setWakePaused(opened.db, false)
    assert.equal(isWakePaused(opened.db), false)
  } finally {
    opened.db.close()
  }
})
