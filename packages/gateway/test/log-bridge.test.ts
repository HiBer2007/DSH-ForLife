/**
 * 「带级别的 logger vs 普通函数」这个**迁移桥**的测试。
 *
 * ## 为什么值得单独测
 *
 * 本仓有大量"日志靠注入"的函数（`createWakeLiveness({ log })` 这种），
 * 测试就靠注入捕获具体的行。**若把注入类型直接改成 `Logger`，所有只传
 * `(m) => …` 的调用方与测试全部编译不过** —— 那就又变成"不改完就不能跑"。
 *
 * ⇒ `atLevel(log, level)` 让两边都能跑：
 *   带级别的走真级别；普通函数退化成调它自己（**功能不变，只是丢了级别**）。
 *
 * 这个桥是"127 处可以**分批**迁移"的全部依据，所以它错了会让整条迁移路走歪。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { atLevel, createLogger, installLogSink, type LogRecord, type LoggerLike } from '../src/admin/log.ts'

test('★★ 传普通函数 ⇒ 退化成调它自己（**功能不变**，只是丢了级别）', () => {
  const got: string[] = []
  const plain: LoggerLike = (message: string) => {
    got.push(message)
  }
  atLevel(plain, 'fault')('反向 WS 已断开')
  assert.deepEqual(got, ['反向 WS 已断开'], '只注入普通函数的调用方必须照旧能跑（这是"分批迁移"的前提）')
})

test('★★ 传 `createLogger()` 的结果 ⇒ 走**真级别**', () => {
  const got: LogRecord[] = []
  const uninstall = installLogSink((record) => got.push(record))
  try {
    const log = createLogger('wake-liveness')
    atLevel(log, 'fault')('反向 WS 已断开')
    atLevel(log, 'info')('反向 WS 已连接')
    assert.deepEqual(
      got.map((record) => `${record.level}:${record.module}`),
      ['fault:wake-liveness', 'info:wake-liveness'],
      '★ 级别必须是**真的** —— 这正是这个桥存在的意义',
    )
  } finally {
    uninstall()
  }
})

test('★ 某个级别的方法缺失时不许炸（退化而不是抛）', () => {
  // 一个"只有 info 没有 fault"的怪物对象：实际迁移期可能真的出现
  const got: string[] = []
  const partial = Object.assign((message: string) => got.push(`裸:${message}`), {
    info: (message: string) => got.push(`info:${message}`),
  }) as LoggerLike
  atLevel(partial, 'info')('有 info')
  atLevel(partial, 'fault')('没有 fault') // 不许抛
  assert.deepEqual(got, ['info:有 info', '裸:没有 fault'], '缺哪一级就退化成裸调用，不抛')
})

test('★★ 那个桥真的被用在了 `wake-liveness` 的断线判定上（源码级、去注释）', async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../src/wake-liveness.ts', import.meta.url), 'utf8')
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  assert.match(src, /atLevel\(log, connected \? 'info' : 'fault'\)/, '★ 断线必须记成 fault（一个子系统不可用）')
  assert.match(src, /atLevel\(log, 'fault'\)\(`收到 bot_offline/, '协议端报掉线同样是 fault')
  // 反面：那两处**不许**再走裸调用（裸调用一律被当成 info，面板上就筛不出子系统故障）
  assert.ok(
    !/^\s*log\(`反向 WS/m.test(src),
    '★ 断线那行不许再是裸 `log(...)` —— 裸调用会被当成 info，面板筛 fault 时看不到它',
  )
  assert.ok(!/^\s*log\(`收到 bot_offline/m.test(src), 'bot_offline 那行同样不许再是裸调用')
})
