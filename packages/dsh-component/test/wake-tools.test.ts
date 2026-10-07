/**
 * 唤醒工具的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **不猜默认值**：缺时间参数时**直接拒绝**，而不是默认"1 分钟后"。
 *    猜错的话模型以为自己设了个 10 分钟后的提醒、实际 1 分钟就响了 ——
 *    而它**不会去核对**，因为工具返回了"成功"。
 * 2. **未装配的监督器要明确拒绝**：静默成功的话模型会以为监视在跑，而实际没有。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listWakeTriggers, openDatabase } from '@forlife/store'

import { buildWakeTools, describeTrigger, MIN_SCHEDULE_SECONDS, parseSchedule, WAKE_TOOL_NAMES } from '../src/wake-tools.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 收集工具定义（按名字索引），并造一个假的运行时。 */
function build(hostOver: Record<string, unknown> = {}): {
  tools: Map<string, { execute: (args: unknown) => Promise<unknown> }>
  db: ReturnType<typeof openDatabase>['db']
  fired: string[]
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const fired: string[] = []
  const tools = new Map<string, { execute: (args: unknown) => Promise<unknown> }>()
  const runtime = { db: opened.db, recordToolCall: () => {} } as never

  buildWakeTools(
    ((def: { name: string; execute: (args: unknown) => Promise<unknown> }) => {
      tools.set(def.name, def)
      return def
    }) as never,
    runtime,
    {
      fireNow: async (id: string) => {
        fired.push(id)
        return { decision: 'fired', reason: 'ok' }
      },
      ...hostOver,
    } as never,
  )
  return { tools, db: opened.db, fired, close: () => opened.db.close() }
}

/**
 * 取工具返回的 value。
 *
 * 宿主契约：`execute` **直接返回规范化 JSON 值**（展示文本由 `output.render` 投影出来）。
 * 以前这里写的是 `(r as {value}).value`，等于把"多包一层 `{content, value}`"这个错误
 * 约定固化进了测试 —— 单测全绿，真宿主却因 schema 不符把五个唤醒工具全部判失败。
 * 现在统一按"返回值本身就是 value"取。
 */
const valueOf = (r: unknown): Record<string, unknown> => r as Record<string, unknown>

test('工具名固定五个（测试与文档共用一份）', () => {
  assert.deepEqual([...WAKE_TOOL_NAMES], ['schedule_wake', 'register_watcher', 'list_wakes', 'cancel_wake', 'wake_now'])
})

test('parseSchedule：三种形态各自正确', () => {
  const d = parseSchedule({ delaySeconds: 120 }, AT)
  assert.equal(d.ok, true)
  if (d.ok) assert.equal(d.nextFireAt, '2026-10-06T12:02:00.000Z')

  const e = parseSchedule({ everySeconds: 300 }, AT)
  assert.equal(e.ok, true)
  if (e.ok) {
    assert.deepEqual(e.spec, { everyMs: 300_000 })
    assert.equal(e.nextFireAt, '2026-10-06T12:05:00.000Z')
  }

  const a = parseSchedule({ at: '2026-10-06T13:00:00.000Z' }, AT)
  assert.equal(a.ok, true)
  if (a.ok) assert.equal(a.nextFireAt, '2026-10-06T13:00:00.000Z')
})

test('★ 什么都不给 ⇒ 拒绝，**不猜默认值**', () => {
  const r = parseSchedule({}, AT)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /必须给 delaySeconds/)
})

test('★ 小于最小值 ⇒ 拒绝（不悄悄改成 60 秒）', () => {
  const r = parseSchedule({ delaySeconds: 10 }, AT)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.reason, /不能小于 60/)
    // 要告诉模型"想立刻做就用 wake_now"，否则它只会反复试更小的值
    assert.match(r.reason, /wake_now/)
  }
  assert.equal(parseSchedule({ everySeconds: 30 }, AT).ok, false)
  assert.equal(MIN_SCHEDULE_SECONDS, 60)
})

test('★ 两个都给了 ⇒ 拒绝（"第一次什么时候"说不清）', () => {
  const r = parseSchedule({ delaySeconds: 120, everySeconds: 300 }, AT)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /只能给一个/)
})

test('★ 过去的时间点 ⇒ 拒绝（不顺延，因为多半是算错了或时区理解错了）', () => {
  const r = parseSchedule({ at: '2026-10-06T11:00:00.000Z' }, AT)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /过去时间/)
})

test('非法 at / 非数字 delay 都给出明确原因', () => {
  assert.equal(parseSchedule({ at: '不是时间' }, AT).ok, false)
  assert.equal(parseSchedule({ delaySeconds: 'abc' }, AT).ok, false)
})

test('schedule_wake：成功入库，且 prompt 为空被拒', async () => {
  const s = build()
  try {
    const ok = valueOf(await s.tools.get('schedule_wake')!.execute({ title: '提醒', prompt: '提醒喝水', delaySeconds: 120 }))
    assert.equal(ok['ok'], true)
    assert.equal(listWakeTriggers(s.db).length, 1)

    const bad = valueOf(await s.tools.get('schedule_wake')!.execute({ title: '空提示', prompt: '', delaySeconds: 120 }))
    assert.equal(bad['ok'], false)
    // prompt 为空的话唤醒后模型不知道要做什么 —— 那次唤醒就是纯浪费
    assert.match(String(bad['message']), /prompt 不能为空/)
    assert.equal(listWakeTriggers(s.db).length, 1, '被拒的不该入库')
  } finally {
    s.close()
  }
})

test('schedule_wake：scope 缺省是 *（与具体会话无关）', async () => {
  const s = build()
  try {
    await s.tools.get('schedule_wake')!.execute({ title: 't', prompt: 'p', delaySeconds: 120 })
    assert.equal(listWakeTriggers(s.db)[0]?.scope, '*')
    await s.tools.get('schedule_wake')!.execute({ title: 't2', prompt: 'p', delaySeconds: 120, scope: 'onebot11:1' })
    assert.equal(listWakeTriggers(s.db, 'onebot11:1').length, 1)
  } finally {
    s.close()
  }
})

test('★ register_watcher：监督器未装配 ⇒ **明确拒绝**（不能静默成功）', async () => {
  const s = build()
  try {
    const r = valueOf(
      await s.tools.get('register_watcher')!.execute({
        name: 'w1', path: 'watch.mjs', contract: 'watcher', title: '盯文件', prompt: '看看',
      }),
    )
    assert.equal(r['ok'], false)
    assert.match(String(r['message']), /监督器未启用/)
    assert.equal(listWakeTriggers(s.db).length, 0, '未生效就不该留下触发器')
  } finally {
    s.close()
  }
})

test('register_watcher：契约非法 ⇒ 拒绝并列出合法值', async () => {
  const s = build({ registerProgram: () => ({ ok: true, reason: 'ok' }) })
  try {
    const r = valueOf(
      await s.tools.get('register_watcher')!.execute({
        name: 'w1', path: 'w.mjs', contract: '乱写', title: 't', prompt: 'p',
      }),
    )
    assert.equal(r['ok'], false)
    assert.match(String(r['message']), /probe \/ watcher \/ service/)
  } finally {
    s.close()
  }
})

test('register_watcher：装配了就建 watcher 触发器', async () => {
  const s = build({ registerProgram: () => ({ ok: true, reason: 'ok' }) })
  try {
    const r = valueOf(
      await s.tools.get('register_watcher')!.execute({
        name: 'w1', path: 'watch.mjs', contract: 'watcher', title: '盯文件', prompt: '看看',
      }),
    )
    assert.equal(r['ok'], true)
    const row = listWakeTriggers(s.db)[0]!
    assert.equal(row.kind, 'watcher')
    assert.match(row.spec, /watch\.mjs/)
  } finally {
    s.close()
  }
})

test('list_wakes：空时说清"还没有"，有条目时给可读摘要', async () => {
  const s = build()
  try {
    const empty = valueOf(await s.tools.get('list_wakes')!.execute({}))
    assert.deepEqual(empty['rows'], [])

    await s.tools.get('schedule_wake')!.execute({ title: '提醒吃药', prompt: 'p', delaySeconds: 120 })
    const rows = valueOf(await s.tools.get('list_wakes')!.execute({}))['rows'] as readonly Record<string, unknown>[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.['title'], '提醒吃药')
    // 工具用的是**真实时钟**，所以不能断言固定时间；只断言"非空且在未来"
    const next = String(rows[0]?.['nextFireAt'] ?? '')
    assert.notEqual(next, '')
    assert.ok(new Date(next).getTime() > Date.now(), `nextFireAt 应在未来，实际 ${next}`)
  } finally {
    s.close()
  }
})

test('cancel_wake：删掉；不存在的 id 给明确原因（不静默成功）', async () => {
  const s = build()
  try {
    const created = valueOf(await s.tools.get('schedule_wake')!.execute({ title: 't', prompt: 'p', delaySeconds: 120 }))
    const id = String(created['id'])
    assert.equal(valueOf(await s.tools.get('cancel_wake')!.execute({ id }))['ok'], true)
    assert.equal(listWakeTriggers(s.db).length, 0)

    const missing = valueOf(await s.tools.get('cancel_wake')!.execute({ id: 'wt_没有' }))
    assert.equal(missing['ok'], false)
    assert.match(String(missing['message']), /没有这条唤醒/)
  } finally {
    s.close()
  }
})

test('wake_now：调 fireNow；失败时如实回报', async () => {
  const s = build()
  try {
    const r = valueOf(await s.tools.get('wake_now')!.execute({ id: 'wt_1' }))
    assert.equal(r['ok'], true)
    assert.deepEqual(s.fired, ['wt_1'])
  } finally {
    s.close()
  }
})

test('五个 execute 都直接返回规范化值：不自己包 {content, value}（真宿主会判 schema 错）', async () => {
  const s = build()
  try {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['list_wakes', {}],
      ['schedule_wake', { title: 't', prompt: 'p', delaySeconds: 120 }],
      ['register_watcher', { name: 'w', path: 'w.ps1', contract: 'probe', title: 't', prompt: 'p' }],
      ['cancel_wake', { id: 'wt_没有' }],
      ['wake_now', { id: 'wt_1' }],
    ]
    for (const [name, args] of cases) {
      const r = (await s.tools.get(name)!.execute(args)) as Record<string, unknown>
      // 宿主拿 execute 的返回**原样**按 output.schema 校验，包一层就是"缺 value.ok"那个故障
      assert.ok(!('content' in r), `${name} 不该返回 content：包装是宿主的活`)
      assert.ok(!('value' in r), `${name} 不该返回 value 包装：execute 直接返回 value`)
      assert.equal(typeof r['ok'], 'boolean', `${name} 的返回值必须带 ok（schema 的必填项）`)
    }
  } finally {
    s.close()
  }
})

test('describeTrigger：停用的会标出来（否则列表里看不出它已经不响了）', async () => {
  const s = build()
  try {
    await s.tools.get('schedule_wake')!.execute({ title: '停了的', prompt: 'p', delaySeconds: 120 })
    const row = listWakeTriggers(s.db)[0]!
    assert.match(describeTrigger(row), /停了的/)
    assert.doesNotMatch(describeTrigger(row), /已停用/)
    assert.match(describeTrigger({ ...row, enabled: 0 }), /已停用/)
  } finally {
    s.close()
  }
})
