/**
 * ★★ 存活判定的**结构化日志**（`FIX_PLAN.md` §57 待办⑤）。
 *
 * ## 为什么要有这一组
 *
 * 判定结果原来只经 `log(message)` 出去 ⇒ 落到日志库里是**猜出来的等级 + 通用模块**
 * （`server.ts` 那条 legacy 路径的 `guessLevel`）⇒
 * ① 面板**按模块筛不到**"QQ 存活"这一类；
 * ② ★★ **"QQ 静默离线（假活）"会以 `info` 混在噪音里** —— 而它恰恰是最该跳出来的那一条
 *    （§57 记的那次 **35 小时假活**：WS 一直 ESTABLISHED、QQ 早被静默踢下线，
 *    而没有任何一条日志能让人看出来）。
 *
 * ⇒ 现在判定走 `createLogger('qq-liveness')`：模块名固定、**等级由判定自己给**：
 *
 * | 结论 | 等级 | 为什么 |
 * |---|---|---|
 * | 判不了（没收到过心跳） | `warn` | ★ 它意味着"我们检测不到假活"——是**能力缺口**，不是噪音 |
 * | 静默离线（假活） | **`fault`** | 进程还活着、QQ 通道死了 —— 正是 `fault` 的定义 |
 * | 恢复 | `note` | 值得留痕的判断（不报恢复，模型会一直以为它是坏的） |
 * | 矩阵不放行 | `note` | 同上，且要能回答"为什么这次没叫我" |
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createLogger, installLogSink, type LogRecord } from '../src/admin/log.ts'
import { setWakeRule } from '../src/wake.ts'
import { createLivenessMonitor, startLivenessWatch } from '../src/wake-liveness.ts'

const T0 = new Date('2026-10-12T00:00:00.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

/** 造一个临时库 + 播种唤醒规则。 */
function freshDb(): ReturnType<typeof openDatabase>['db'] {
  const opened = openDatabase({ file: ':memory:' })
  return opened.db
}

/** 收结构化日志（装一个落点）。 */
function capture(): { readonly records: LogRecord[]; readonly restore: () => void } {
  const records: LogRecord[] = []
  const restore = installLogSink((record) => records.push(record))
  return { records, restore }
}

test('★★★ 判不了 ⇒ `warn` + 模块 `qq-liveness`（★ 能力缺口必须跳出噪音）', () => {
  const db = freshDb()
  const cap = capture()
  try {
    const monitor = createLivenessMonitor({ now: () => T0, log: () => {} })
    const watch = startLivenessWatch({
      db,
      monitor,
      log: () => {},
      logger: createLogger('qq-liveness'),
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick(T0)
    const row = cap.records.find((r) => r.text.includes('判不了') || r.text.includes('存活状态'))
    assert.ok(row !== undefined, `必须有一条存活日志（现在：${JSON.stringify(cap.records)}）`)
    assert.equal(row.module, 'qq-liveness', '★ 模块名固定 ⇒ 面板按模块筛得到')
    assert.equal(row.level, 'warn', '★★ 判不了 = 能力缺口 ⇒ `warn`（不是 info）')
    // ★ §57 待办⑤：理由的措辞改过（删掉了"onebot.ts 丢弃 meta_event"那半句旧账）⇒ 中英文都算
    assert.match(row.text, /heartbeat|心跳/, '要说清缺的是心跳（否则"判不了"三个字没法排查）')
  } finally {
    cap.restore()
  }
})

test('★★★ 静默离线（假活）⇒ **`fault`**（进程活着、通道死了）', () => {
  const db = freshDb()
  setWakeRule(db, '*', 'bot_offline', { enabled: true, probability: 100 }, 'admin')
  const cap = capture()
  try {
    const monitor = createLivenessMonitor({ now: () => T0, log: () => {} })
    const watch = startLivenessWatch({
      db,
      monitor,
      log: () => {},
      logger: createLogger('qq-liveness'),
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    // 先来一次心跳（这样判据才"见过"它），再让它沉默过阈值（3×30s，且不低于 90s）
    monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
    watch.tick(T0)
    const later = at(400)
    watch.tick(later)
    const offline = cap.records.find((r) => r.text.includes('静默离线'))
    assert.ok(offline !== undefined, `必须有一条"静默离线"（现在：${JSON.stringify(cap.records)}）`)
    assert.equal(offline.module, 'qq-liveness')
    assert.equal(offline.level, 'fault', '★★ 假活是**一个子系统坏了** ⇒ `fault`（35 小时假活那次就是没人看见）')
  } finally {
    cap.restore()
  }
})

test('★★ 没给 `logger` 时退回 `log(message)`（老调用方与测试不受影响）', () => {
  const db = freshDb()
  const lines: string[] = []
  const monitor = createLivenessMonitor({ now: () => T0, log: () => {} })
  const watch = startLivenessWatch({
    db,
    monitor,
    log: (message) => lines.push(message),
    now: () => T0,
    setIntervalImpl: () => ({ unref: () => {} }),
    clearIntervalImpl: () => {},
  })
  watch.tick(T0)
  assert.ok(lines.length > 0, '退回路径仍然要出话（否则等于把日志弄丢了）')
  assert.ok(lines.some((line) => line.includes('存活状态')), `实际：${lines.join('｜')}`)
})

// ════════════════════════════════════════════════════════════════════════════
// 源码级：生产路径真的把专用 logger 接上了
// ════════════════════════════════════════════════════════════════════════════

test('★★ `wake-runtime.ts` 真的把 `createLogger(\'qq-liveness\')` 传给了存活循环', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/wake-runtime.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(source, /createLogger\('qq-liveness'\)/, '★ 要造一个**专用模块**的 logger')
  const at = source.indexOf('startLivenessWatch({')
  assert.ok(at >= 0, '要调 `startLivenessWatch`')
  const call = source.slice(at, at + 600)
  assert.match(
    call,
    /logger: livenessLog/,
    '★★ 必须传进那个调用里 —— ★ 只造 logger 不传 = 一行结构化日志都不会有（本仓栽过 20+ 次的形状）',
  )
})
