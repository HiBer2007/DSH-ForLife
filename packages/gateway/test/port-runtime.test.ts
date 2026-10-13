/**
 * 端口出口装配的测试。
 *
 * 重点守一条：**没配 Caddy 时要明确禁用并说清缺什么**，
 * 而不是让 `publish` 一路走到"连不上 Caddy"再报错 ——
 * 那样用户看到的是"配置失败"，会去排查 Caddy，而其实是根本没配。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createPortRuntime, portConfigFromEnv } from '../src/port-runtime.ts'

test('★ 未配 Caddy 时：明确禁用 + 说清缺哪个变量（不假装可用）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const runtime = createPortRuntime({ db: opened.db, env: {}, log: () => {} })
    assert.equal(runtime.service, undefined, '没配就不能给出服务')
    assert.match(runtime.disabledReason ?? '', /未启用/)
    assert.match(runtime.disabledReason ?? '', /FORLIFE_CADDY_ADMIN/, '要说清缺哪个变量')
    assert.match(runtime.disabledReason ?? '', /FORLIFE_PUBLIC_HOST/)
  } finally {
    opened.db.close()
  }
})

test('★ 只配了一半：仍禁用，且只报缺的那一个', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const runtime = createPortRuntime({
      db: opened.db,
      env: { FORLIFE_CADDY_ADMIN: 'http://127.0.0.1:2019' },
      log: () => {},
    })
    assert.equal(runtime.service, undefined)
    assert.match(runtime.disabledReason ?? '', /FORLIFE_PUBLIC_HOST/)
    assert.doesNotMatch(runtime.disabledReason ?? '', /FORLIFE_CADDY_ADMIN/, '已配的不要再报')
  } finally {
    opened.db.close()
  }
})

test('配齐了：给出服务 + 起回收任务 + stop 能停掉', () => {
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  let started: (() => void) | undefined
  let cleared = false
  try {
    const runtime = createPortRuntime({
      db: opened.db,
      env: {
        FORLIFE_CADDY_ADMIN: 'http://127.0.0.1:2019',
        FORLIFE_PUBLIC_HOST: 'life.example',
        FORLIFE_PORT_RECLAIM_MS: '1234',
      },
      log: (m) => logs.push(m),
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      setIntervalImpl: (fn) => {
        started = fn
        return { unref: () => {} }
      },
      clearIntervalImpl: () => {
        cleared = true
      },
    })

    assert.ok(runtime.service !== undefined)
    assert.equal(runtime.disabledReason, undefined)
    assert.ok(started !== undefined, '要起回收任务')
    assert.match(logs.join('\n'), /端口出口已启用/)
    assert.match(logs.join('\n'), /https:\/\/life\.example\/svc\/<name>\//, '日志要说清对外形态')

    runtime.stop()
    assert.equal(cleared, true, 'stop 必须真的清掉定时器')
  } finally {
    opened.db.close()
  }
})

test('回收任务里抛异常不会杀死循环（自己接住并记日志）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  try {
    let tick: (() => void) | undefined
    createPortRuntime({
      db: opened.db,
      env: { FORLIFE_CADDY_ADMIN: 'http://caddy.test:2019', FORLIFE_PUBLIC_HOST: 'h.test' },
      log: (m) => logs.push(m),
      // 让 Caddy 调用抛异常
      fetchImpl: async () => {
        throw new Error('boom')
      },
      setIntervalImpl: (fn) => {
        tick = fn
        return { unref: () => {} }
      },
      clearIntervalImpl: () => {},
    })

    assert.ok(tick !== undefined)
    tick()
    // 等一拍（tick 是 async 的，但外层包了 void）
    await new Promise((resolve) => setTimeout(resolve, 30))
    // **不该抛出**：定时任务里抛异常会静默杀死整个循环
    assert.doesNotMatch(logs.join('\n'), /boom[\s\S]*Unhandled/)
  } finally {
    opened.db.close()
  }
})

test('白名单解析：正常解析；解析不出来退回默认（不变成空白名单）', () => {
  assert.deepEqual(portConfigFromEnv({ FORLIFE_PORT_WHITELIST: '7000-7099' }).whitelist, [{ from: 7000, to: 7099 }])
  assert.deepEqual(portConfigFromEnv({ FORLIFE_PORT_WHITELIST: '7000-7099, 9000-9001' }).whitelist, [
    { from: 7000, to: 7099 },
    { from: 9000, to: 9001 },
  ])

  // **解析不出来要退回默认**：空白名单会让所有发布都被拒，
  // 而用户只会以为"功能坏了"，不会想到是自己写错了这个变量
  const garbage = portConfigFromEnv({ FORLIFE_PORT_WHITELIST: 'abc,;;' }).whitelist
  assert.ok(garbage.length > 0, '解析失败不能变成空白名单')
  assert.ok(garbage.some((r) => r.from === 8000), '应退回默认段')
})

test('回收间隔：非法值退回 60 秒', () => {
  assert.equal(portConfigFromEnv({ FORLIFE_PORT_RECLAIM_MS: '5000' }).reclaimIntervalMs, 5000)
  assert.equal(portConfigFromEnv({ FORLIFE_PORT_RECLAIM_MS: '0' }).reclaimIntervalMs, 60000)
  assert.equal(portConfigFromEnv({ FORLIFE_PORT_RECLAIM_MS: '-1' }).reclaimIntervalMs, 60000)
  assert.equal(portConfigFromEnv({ FORLIFE_PORT_RECLAIM_MS: 'abc' }).reclaimIntervalMs, 60000)
})
