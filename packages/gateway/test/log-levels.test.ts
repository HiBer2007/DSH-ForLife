/**
 * 日志**分级制度**与**模块 logger** 的测试。
 *
 * ## 这个文件在钉什么
 *
 * 用户 2026-10-10 指定的规则，逐条钉住：
 *
 * 1. **七级、且顺序固定**：`DEBUG INFO NOTE WARN ERROR FAULT CRASH`
 * 2. **默认除了 `debug` 都存储**（用户原话，先写成"除了 debug 都不存储"、随后更正为
 *    "除了 debug 都存储"—— 这条断言就是把那次更正钉住，免得日后又反了）
 * 3. **环境变量可以点名关掉某些等级**，且**关掉能盖过下限**
 * 4. 环境变量里**拼错的级别名必须被报出来**，不许静默忽略
 *    （"日志没落盘"这类最难查的故障，经典成因就是"我明明关/开了它呀"）
 * 5. 旧签名 `log('一句话')` ⇒ `info`（127 处调用点能分批迁移的前提）
 * 6. 落点抛错**不许反杀调用方**（一次日志写失败不该让业务崩掉）
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_STORE_LEVEL,
  LOG_LEVELS,
  LOG_LEVEL_RANK,
  atLeast,
  disabledLevelsFromEnv,
  isLogLevel,
  shouldStore,
} from '../src/admin/log-levels.ts'
import { createLogger, installLogSink, logSinkCount, type LogRecord } from '../src/admin/log.ts'

test('★★ 七级且顺序固定（顺序即严重度，代码里不许有第二份）', () => {
  assert.deepEqual(
    [...LOG_LEVELS],
    ['debug', 'info', 'note', 'warn', 'error', 'fault', 'crash'],
    '七级的名字与顺序由用户 2026-10-10 指定 —— 改名/换序会让所有调用点的含义变味',
  )
  // 序必须与数组一致（两处不一致 ⇒ "≥ 某级"的判断会在某个界上错一格）
  LOG_LEVELS.forEach((level, index) => {
    assert.equal(LOG_LEVEL_RANK[level], index, `${level} 的序应当是 ${String(index)}`)
  })
  assert.ok(isLogLevel('fault'))
  assert.ok(!isLogLevel('FATAL'), '不在七级里的名字不许被当成合法级别')
  assert.ok(!isLogLevel(undefined))
})

test('★★ 默认：**除了 debug 都存储**（用户指定）', () => {
  assert.equal(DEFAULT_STORE_LEVEL, 'info', '默认下限是 info ⇒ 只有 debug 落在它下面')
  assert.equal(shouldStore('debug'), false, 'debug 默认**不**落盘')
  for (const level of ['info', 'note', 'warn', 'error', 'fault', 'crash'] as const) {
    assert.equal(shouldStore(level), true, `${level} 默认必须落盘 —— 规则是"除了 debug 都存储"`)
  }
})

test('★★ 环境变量可以关掉等级，且**关掉能盖过下限**', () => {
  const { disabled, unknown } = disabledLevelsFromEnv('debug, Note , typo')
  assert.deepEqual([...disabled].sort(), ['debug', 'note'], '大小写与空格都要容忍')
  assert.deepEqual(unknown, ['typo'], '★ 拼错的级别名必须报出来，不许静默忽略')

  // "关掉"若不能盖过下限，那它就只是句空话（用户原话：「除非在环境变量中关闭了某些等级」）
  assert.equal(shouldStore('info', { disabled: new Set(['info']) }), false)
  assert.equal(shouldStore('warn', { disabled: new Set(['info']) }), true)

  // 抬高下限是另一件事，两者叠加
  assert.equal(shouldStore('info', { min: 'fault' }), false)
  assert.equal(shouldStore('fault', { min: 'fault' }), true)

  // 空串 / 未设 ⇒ 关掉空集
  assert.equal(disabledLevelsFromEnv(undefined).disabled.size, 0)
  assert.equal(disabledLevelsFromEnv('  ,  ').disabled.size, 0)
})

test('★ `atLeast`：比较只有一处实现（`<` 写成 `<=` 是经典失误）', () => {
  assert.equal(atLeast('note', 'info'), true)
  assert.equal(atLeast('info', 'info'), true, '等于算"到"')
  assert.equal(atLeast('debug', 'info'), false)
  assert.equal(atLeast('crash', 'debug'), true)
})

test('★★ 模块 logger：旧签名 ⇒ info，七个方法各归其级，且带模块名', () => {
  const got: LogRecord[] = []
  const before = logSinkCount()
  const uninstall = installLogSink((record) => got.push(record))
  try {
    assert.equal(logSinkCount(), before + 1, '落点是**扇出**的（集合），装上就是多一个')
    const log = createLogger('demo-module')
    assert.equal(log.module, 'demo-module', '模块名要挂在 logger 上（面板按它筛）')

    log('旧签名一句话') // ★ 127 处调用点能分批迁移的前提
    log.debug('d')
    log.info('i')
    log.note('n')
    log.warn('w')
    log.error('e')
    log.fault('f')
    log.crash('c')

    assert.deepEqual(
      got.map((record) => record.level),
      ['info', 'debug', 'info', 'note', 'warn', 'error', 'fault', 'crash'],
      '旧签名必须落到 info；其余七个别名各归其级',
    )
    // 每一条都要带模块名与时间 —— 少了任何一个，面板的筛选/排序就没得用
    for (const record of got) {
      assert.equal(record.module, 'demo-module')
      assert.ok(record.at.length > 0, '每条都要有时间戳')
    }
    assert.deepEqual(
      got.map((record) => record.text),
      ['旧签名一句话', 'd', 'i', 'n', 'w', 'e', 'f', 'c'],
      '文本要原样传下去（脱敏是汇聚点的事，不是 logger 的事）',
    )
  } finally {
    uninstall()
  }
  // ★ 卸载只摘掉**自己那一个**，不许把别人的也摘了 ——
  //   测试共用进程（`--experimental-test-isolation=none`），
  //   别的用例可能正装着落点（例如 `createAdminServer`）。
  assert.equal(logSinkCount(), before, '卸载必须精确摘掉自己那一个')
})

test('★★ 落点抛错**不许反杀调用方**（一次日志写失败不该让业务崩掉）', () => {
  const uninstall = installLogSink(() => {
    throw new Error('落点炸了')
  })
  try {
    const log = createLogger('boom')
    // 不抛 = 通过。抛了的话这条测试会红，而那正是"日志把业务搞死"的形状。
    log.error('这条应当被兜底吞掉')
    log.crash('这条也是')
  } finally {
    uninstall()
  }
})
