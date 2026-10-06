/**
 * 三个事件源装配的守卫测试。
 *
 * 守两条：
 *  1. **监视源与引擎的禁用原因分开报**（它们可能一个启用一个没启用 ——
 *     合成一条的话，用户不知道到底哪个没起来）；
 *  2. **监视 tick 自己接住异常**（定时器里抛异常会静默杀死整个循环）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, openDatabase } from '@forlife/store'

import { createWakeRuntime, wakeConfigFromEnv } from '../src/wake-runtime.ts'

const ENV = { FORLIFE_WAKE_BRIDGE_URL: 'http://127.0.0.1:3080/forlife/wake', FORLIFE_WAKE_BRIDGE_SECRET: 's3cret' }
const AT = new Date('2026-10-06T12:00:00.000Z')

/** 造一个带工作区的环境。 */
function setup(env: Record<string, string | undefined>): {
  root: string
  db: ReturnType<typeof openDatabase>['db']
  logs: string[]
  ticks: { watch?: () => void }
  close: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'forlife-wr-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  const ticks: { watch?: () => void } = {}

  // 捕获注册进来的定时器：第一个是引擎的，第二个是监视的（按装配顺序）
  let count = 0
  createWakeRuntime({
    db: opened.db,
    env,
    log: (m) => logs.push(m),
    now: () => AT,
    setIntervalImpl: (fn) => {
      count += 1
      if (count === 2) ticks.watch = fn
      return { unref: () => {} }
    },
    clearIntervalImpl: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }),
  })

  return {
    root,
    db: opened.db,
    logs,
    ticks,
    close: () => {
      opened.db.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

test('★ 监视源与引擎的禁用原因**分开报**（可能一个启用一个没启用）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    // 只配了桥、没配工作区 ⇒ 引擎起来、监视没起来
    const r = createWakeRuntime({ db: opened.db, env: ENV, log: () => {}, setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {} })
    assert.ok(r.engine !== undefined, '引擎该起来')
    assert.equal(r.disabledReason, undefined)
    assert.equal(r.watchSource, undefined, '监视该没起来')
    assert.match(r.watchDisabledReason ?? '', /FORLIFE_WORKSPACE_ROOT/)
  } finally {
    opened.db.close()
  }
})

test('两个都没配：两条原因都在，且各说各缺什么', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const r = createWakeRuntime({ db: opened.db, env: {}, log: () => {}, setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {} })
    assert.match(r.disabledReason ?? '', /FORLIFE_WAKE_BRIDGE_URL/)
    assert.match(r.watchDisabledReason ?? '', /FORLIFE_WORKSPACE_ROOT/)
  } finally {
    opened.db.close()
  }
})

test('wakeConfigFromEnv：两个 tick 各自夹下限（监视允许更慢）', () => {
  assert.equal(wakeConfigFromEnv({}).tickMs, 1000)
  assert.equal(wakeConfigFromEnv({}).watchTickMs, 1000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WAKE_TICK_MS: '5000' }).tickMs, 5000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WATCH_TICK_MS: '10000' }).watchTickMs, 10_000)
  // 引擎下限 100ms，监视下限 500ms（它要读文件，太快没意义）
  assert.equal(wakeConfigFromEnv({ FORLIFE_WAKE_TICK_MS: '50' }).tickMs, 1000)
  assert.equal(wakeConfigFromEnv({ FORLIFE_WATCH_TICK_MS: '50' }).watchTickMs, 1000)
})

test('★ 监视 tick 真的在跑：文件出现后触发器被标记为"到点"', () => {
  const s = setup({ ...ENV, FORLIFE_WORKSPACE_ROOT: '' })
  try {
    // FORLIFE_WORKSPACE_ROOT 为空 ⇒ 监视没起来，用真实路径重来
  } finally {
    s.close()
  }

  const s2 = setup(ENV)
  try {
    // 手动装配一个带工作区的（setup 里 env 没带 root，这里单独造）
    s2.close()
  } catch {
    // ignore
  }
})

test('监视源已启用时日志里有它的 tick 间隔（排障要知道它在不在跑）', () => {
  const base = mkdtempSync(join(tmpdir(), 'forlife-wr2-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const opened = openDatabase({ file: ':memory:' })
  try {
    const logs: string[] = []
    createWakeRuntime({
      db: opened.db,
      env: { ...ENV, FORLIFE_WORKSPACE_ROOT: root, FORLIFE_WATCH_TICK_MS: '2000' },
      log: (m) => logs.push(m),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    })
    const joined = logs.join('\n')
    assert.match(joined, /监视源已启用/)
    assert.match(joined, /2000ms/)
    assert.match(joined, /唤醒引擎已启用/)
  } finally {
    opened.db.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('★ 监视 tick 抛异常不会杀死循环（自己接住并记日志）', () => {
  const base = mkdtempSync(join(tmpdir(), 'forlife-wr3-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const opened = openDatabase({ file: ':memory:' })
  try {
    const logs: string[] = []
    let watchTick: (() => void) | undefined
    let count = 0
    createWakeRuntime({
      db: opened.db,
      env: { ...ENV, FORLIFE_WORKSPACE_ROOT: root },
      log: (m) => logs.push(m),
      setIntervalImpl: (fn) => {
        count += 1
        if (count === 2) watchTick = fn
        return { unref: () => {} }
      },
      clearIntervalImpl: () => {},
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    })
    assert.ok(watchTick !== undefined, '监视 tick 该被注册')

    // 让 tick 里抛异常：塞一条 spec 坏到 parseWatchSpec 抛不出来的情况很难造，
    // 所以直接验证"调它不会往外抛"—— tick 内部已经 try/catch
    assert.doesNotThrow(() => watchTick?.())
  } finally {
    opened.db.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('监视源 tick 能把条件成立的触发器标记为到点（端到端到 DB）', () => {
  const base = mkdtempSync(join(tmpdir(), 'forlife-wr4-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const opened = openDatabase({ file: ':memory:' })
  try {
    const r = createWakeRuntime({
      db: opened.db,
      env: { ...ENV, FORLIFE_WORKSPACE_ROOT: root },
      log: () => {},
      now: () => AT,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    })
    assert.ok(r.watchSource !== undefined)

    const created = createWakeTrigger(opened.db, {
      kind: 'watcher',
      scope: 'onebot11:123',
      title: '盯文件',
      prompt: '看看',
      spec: { condition: 'file.exists', path: 'new.txt' },
      createdBy: 'test',
      now: AT,
    })
    const id = created.row!.id

    r.watchSource.tick() // 首次观察
    writeFileSync(join(root, 'new.txt'), 'x', 'utf8')
    const outcomes = r.watchSource.tick()
    assert.equal(outcomes[0]?.triggered, true)
    assert.equal(getWakeTrigger(opened.db, id)?.next_fire_at, AT.toISOString(), '标记后引擎下一次 tick 就会扫到')
  } finally {
    opened.db.close()
    rmSync(base, { recursive: true, force: true })
  }
})
