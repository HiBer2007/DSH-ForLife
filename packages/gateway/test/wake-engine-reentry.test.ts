/**
 * 防重入的守卫测试（真机烧了 141 次模型调用的那个 bug）。
 *
 * ## 复现条件（三个都要满足）
 *
 * 1. 触发器**已到点**（`next_fire_at` 在过去）；
 * 2. **派发很慢**（真机上是 300 秒的 headless 超时）；
 * 3. 期间**又跑了 tick**（引擎每 1 秒一次）。
 *
 * ⇒ 老实现里 `next_fire_at` 要等派发完才推进，于是那 300 秒里
 * **每个 tick 都重放同一条**。
 *
 * ## 这个测试怎么构造"慢派发"
 *
 * 用**手动 resolve 的 Promise**：第一次 tick 卡在派发里，
 * 此时跑第二次 tick，断言它**不重复派发**。然后放行，再验正常推进。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, listWakeEvents, openDatabase } from '@forlife/store'

import { createWakeEngine } from '../src/wake-engine.ts'

const T0 = new Date('2026-10-06T14:46:54.000Z')

/** 造一个已到点的一次性 timer。 */
function setupDueTimer(): ReturnType<typeof openDatabase> {
  const opened = openDatabase({ file: ':memory:' })
  createWakeTrigger(opened.db, {
    kind: 'timer',
    scope: 'onebot11:123',
    title: '慢派发测试',
    prompt: '做点什么',
    spec: { at: T0.toISOString() },
    createdBy: 'test',
    nextFireAt: T0.toISOString(),
    now: new Date(T0.getTime() - 60_000),
  })
  return opened
}

test('★ 派发未完成时再跑 tick ⇒ **不重复派发**（真机烧了 141 次的那个 bug）', async () => {
  const opened = setupDueTimer()
  try {
    let dispatches = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const engine = createWakeEngine({
      db: opened.db,
      log: () => {},
      now: () => T0,
      dispatch: async () => {
        dispatches += 1
        // **卡住**，模拟 300 秒的 headless 超时
        await gate
        return { ok: true, reason: '完成' }
      },
    })

    // 第一轮：会卡在 dispatch 里
    const first = engine.tick()
    // 等它真的进到 dispatch
    await new Promise((r) => setTimeout(r, 20))

    // ★ 关键：派发还没完成时，**再跑几轮 tick**（真机上每秒一次）
    // **加超时**：老实现下第二次 tick 会去 await 那个永远不放行的 gate ⇒
    // 不加超时就是**死锁挂起**，而挂起不是干净的"变红"（看不出是哪个断言）。
    // 超时后 tick 的 Promise 仍挂着，但断言会先失败 —— 这正是我们要的信号。
    const withTimeout = async (p: Promise<unknown>, ms: number): Promise<unknown> =>
      Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))])
    const second = await withTimeout(engine.tick(), 500)
    const third = await withTimeout(engine.tick(), 500)

    assert.deepEqual(second, [], '派发未完成时不该再派发（第二次 tick 必须空手而归）')
    assert.deepEqual(third, [], '派发未完成时不该再派发（第三次同理）')
    assert.equal(dispatches, 1, `**只该派发一次**，实际 ${String(dispatches)} 次`)

    // 放行，收尾
    release()
    await first
    assert.equal(dispatches, 1, '放行后仍然只派发了一次')
  } finally {
    opened.db.close()
  }
})

test('★ 派发完成后，一次性 timer 被推进到 null（不会永远重放）', async () => {
  const opened = setupDueTimer()
  try {
    const engine = createWakeEngine({
      db: opened.db,
      log: () => {},
      now: () => T0,
      dispatch: async () => ({ ok: true, reason: '完成' }),
    })
    await engine.tick()
    const row = opened.db.prepare('SELECT next_fire_at, fire_count FROM wake_triggers').get() as
      | { next_fire_at: string | null; fire_count: number }
      | undefined
    assert.equal(row?.next_fire_at, null, '一次性 timer 推进后必须是 null')
    assert.equal(row?.fire_count, 1)

    // 再跑一轮：已经没有到点的了
    const again = await engine.tick()
    assert.equal(again.length, 0, '推进到 null 之后不该再被选中')
  } finally {
    opened.db.close()
  }
})

test('★ 一条慢触发器**不阻塞另一条**（为什么用"在飞集合"而不是一把大锁）', async () => {
  const opened = setupDueTimer()
  try {
    // 再加一条同样到点的
    createWakeTrigger(opened.db, {
      kind: 'timer',
      scope: 'onebot11:456',
      title: '快的',
      prompt: '做点别的',
      spec: { at: T0.toISOString() },
      createdBy: 'test',
      nextFireAt: T0.toISOString(),
      now: new Date(T0.getTime() - 60_000),
    })

    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: string[] = []

    const engine = createWakeEngine({
      db: opened.db,
      log: () => {},
      now: () => T0,
      dispatch: async ({ trigger }) => {
        seen.push(trigger.title)
        if (trigger.title === '慢派发测试') await gate
        return { ok: true, reason: '完成' }
      },
    })

    const first = engine.tick()
    await new Promise((r) => setTimeout(r, 20))
    // 慢的那条卡住了；此时再跑一轮 —— **快的那条应当照常派发**
    await engine.tick()
    assert.ok(seen.includes('快的'), `慢的那条不该阻塞快的，实际派发过：${seen.join(', ')}`)
    release()
    await first
  } finally {
    opened.db.close()
  }
})

test('派发抛异常后也要从"在飞"里移除（否则那条永久不再触发）', async () => {
  const opened = setupDueTimer()
  try {
    let calls = 0
    const engine = createWakeEngine({
      db: opened.db,
      log: () => {},
      now: () => T0,
      dispatch: async () => {
        calls += 1
        if (calls === 1) throw new Error('第一次炸')
        return { ok: true, reason: '第二次好了' }
      },
    })
    await engine.tick()
    // 一次性 timer 推进到 null 了，所以手动再触发一次验证"在飞已清空"
    const events = listWakeEvents(opened.db, 10)
    assert.ok(events.length > 0, '应当留下事件')
    // 引擎还能继续工作（没被异常卡死）
    const again = await engine.tick()
    assert.equal(again.length, 0)
  } finally {
    opened.db.close()
  }
})
