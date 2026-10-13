/**
 * 系统监视循环的守卫测试。
 *
 * ## 最值得守的三条
 *
 * 1. **取不到使用率不算"健康"** —— 那会让人以为一切正常。
 * 2. **没配挂载点就不启动循环**（而不是空转）—— 与端口出口同一纪律。
 * 3. **tick 自己接住异常** —— 定时器里抛异常会静默杀死整个循环。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, openDatabase } from '@forlife/store'

import { createSystemEventHooks } from '../src/wake-system-hooks.ts'
import { createSystemWakeSource } from '../src/wake-system-source.ts'
import { checkDisk, monitorConfigFromEnv, startSystemMonitor, type DiskCheck } from '../src/wake-system-monitor.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 建一条听 disk.high 的触发器。 */
function mkDiskTrigger(db: ReturnType<typeof openDatabase>['db']): string {
  const r = createWakeTrigger(db, {
    kind: 'system', scope: 'onebot11:123', title: '磁盘告警', prompt: '清理',
    spec: { event: 'disk.high' }, createdBy: 'test', now: AT,
  })
  return r.row!.id
}

/** 造一套（db + hooks）。 */
function setup(): {
  db: ReturnType<typeof openDatabase>['db']
  hooks: ReturnType<typeof createSystemEventHooks>
  logs: string[]
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  const logs: string[] = []
  const source = createSystemWakeSource({ db: opened.db, now: () => AT })
  return {
    db: opened.db,
    hooks: createSystemEventHooks({ source, log: (m) => logs.push(m) }),
    logs,
    close: () => opened.db.close(),
  }
}

test('★ 取不到使用率 ⇒ **不算健康也不告警**，但 detail 说清"没查到"', () => {
  const result = checkDisk('Z:\\不存在的盘符', 0.9)
  assert.equal(result.usedRatio, undefined)
  assert.equal(result.high, false, '查不到不该去唤醒模型')
  // **关键**：说清是"没查到"，而不是假装一切正常
  assert.match(result.detail, /查不到/)
})

test('checkDisk：真实盘符能算出比例（跑在本机临时目录上）', () => {
  const result = checkDisk(process.cwd(), 0.99)
  assert.ok(result.usedRatio !== undefined, `应当能拿到比例：${result.detail}`)
  assert.ok(result.usedRatio >= 0 && result.usedRatio <= 1)
  // 阈值 99% ⇒ 本机几乎不可能超
  assert.equal(result.high, false)
  assert.match(result.detail, /已用 \d+%/)
})

test('checkDisk：阈值判定是 `>=`（等于阈值也算超）', () => {
  // 用一个极低阈值让它必然触发
  const result = checkDisk(process.cwd(), 0.000001)
  assert.equal(result.high, true, `阈值极低时应当算超：${result.detail}`)
})

test('★ 水位超阈值 ⇒ 触发 system 触发器', () => {
  const s = setup()
  try {
    const id = mkDiskTrigger(s.db)
    const monitor = startSystemMonitor({
      hooks: s.hooks,
      mounts: ['/data'],
      checkDiskImpl: () => ({ usedRatio: 0.95, high: true, detail: '/data：已用 95%（阈值 90%）' }),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const results = monitor.tick()
    assert.equal(results[0]?.high, true)
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, AT.toISOString(), '应当被标记为到点')
  } finally {
    s.close()
  }
})

test('★ 幂等：水位持续超阈值，tick 100 次只触发 1 次', () => {
  const s = setup()
  try {
    const id = mkDiskTrigger(s.db)
    const monitor = startSystemMonitor({
      hooks: s.hooks,
      mounts: ['/data'],
      checkDiskImpl: () => ({ usedRatio: 0.95, high: true, detail: '满了' }),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    monitor.tick()
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    for (let i = 0; i < 100; i += 1) {
      monitor.tick()
      assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, null, `第 ${String(i + 2)} 次 tick 不该再触发`)
    }
  } finally {
    s.close()
  }
})

test('★ 水位回落 ⇒ 也能触发（不发的话模型会以为盘一直满着）', () => {
  const s = setup()
  try {
    const id = mkDiskTrigger(s.db)
    let high = true
    const monitor = startSystemMonitor({
      hooks: s.hooks,
      mounts: ['/data'],
      checkDiskImpl: () => ({ usedRatio: high ? 0.95 : 0.5, high, detail: high ? '满了' : '回落了' }),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    monitor.tick()
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    high = false
    monitor.tick()
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, AT.toISOString(), '回落也该发（那是状态变化）')
  } finally {
    s.close()
  }
})

test('★ 没配挂载点 ⇒ 不启动循环（而不是空转）', () => {
  const s = setup()
  try {
    const logs: string[] = []
    let started = false
    const monitor = startSystemMonitor({
      hooks: s.hooks,
      mounts: [],
      log: (m) => logs.push(m),
      setIntervalImpl: () => {
        started = true
        return { unref: () => {} }
      },
      clearIntervalImpl: () => {},
    })
    assert.equal(started, false, '不该注册定时器')
    assert.match(logs.join('\n'), /未启用/)
    assert.deepEqual(monitor.tick(), [])
  } finally {
    s.close()
  }
})

test('★ tick 抛异常不会杀死循环（自己接住并记日志）', () => {
  const s = setup()
  try {
    const logs: string[] = []
    let tickFn: (() => void) | undefined
    startSystemMonitor({
      hooks: s.hooks,
      mounts: ['/data'],
      log: (m) => logs.push(m),
      checkDiskImpl: () => {
        throw new Error('查盘炸了')
      },
      setIntervalImpl: (fn) => {
        tickFn = fn
        return { unref: () => {} }
      },
      clearIntervalImpl: () => {},
    })
    assert.ok(tickFn !== undefined)
    assert.doesNotThrow(() => tickFn?.())
    assert.ok(logs.some((l) => l.includes('tick 异常')), `应当记日志：${JSON.stringify(logs)}`)
  } finally {
    s.close()
  }
})

test('monitorConfigFromEnv：解析挂载点与阈值，非法值退回默认', () => {
  assert.deepEqual(monitorConfigFromEnv({}).mounts, [])
  assert.deepEqual(monitorConfigFromEnv({ FORLIFE_DISK_MOUNTS: '/a, /b ,' }).mounts, ['/a', '/b'])
  assert.equal(monitorConfigFromEnv({ FORLIFE_DISK_THRESHOLD: '0.8' }).thresholdRatio, 0.8)
  // 非法阈值（0 / 1 / 非数字）退回 0.9
  assert.equal(monitorConfigFromEnv({ FORLIFE_DISK_THRESHOLD: '0' }).thresholdRatio, 0.9)
  assert.equal(monitorConfigFromEnv({ FORLIFE_DISK_THRESHOLD: '1' }).thresholdRatio, 0.9)
  assert.equal(monitorConfigFromEnv({ FORLIFE_DISK_THRESHOLD: 'abc' }).thresholdRatio, 0.9)
  // 间隔下限 30 秒
  assert.equal(monitorConfigFromEnv({ FORLIFE_DISK_CHECK_MS: '1000' }).intervalMs, 300_000)
})

test('多个挂载点各自独立判（一个满了不影响另一个）', () => {
  const s = setup()
  try {
    const id = mkDiskTrigger(s.db)
    const monitor = startSystemMonitor({
      hooks: s.hooks,
      mounts: ['/full', '/ok'],
      checkDiskImpl: (m): DiskCheck => ({ usedRatio: m === '/full' ? 0.95 : 0.1, high: m === '/full', detail: m }),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const results = monitor.tick()
    assert.equal(results.length, 2)
    assert.equal(results[0]?.high, true)
    assert.equal(results[1]?.high, false)
    // 只有 /full 触发；/ok 第一次观察不算变化
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, AT.toISOString())
  } finally {
    s.close()
  }
})
