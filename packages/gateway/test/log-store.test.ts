/**
 * 日志落盘与保留的测试（用户 2026-10-10）。
 *
 * ## 这里最要紧的三条
 *
 * 1. **保留期裁剪必须只删过期的整天文件，不许碰别的** ——
 *    日志系统最不能接受的失败是"**把已经记下来的东西弄丢**"
 * 2. **默认除了 debug 都存**（用户那次更正）—— 落盘层不许自己再有一套判定
 * 3. **坏行/写失败/目录不可用都不许反杀调用方** —— 它在每条日志上跑
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { LogRecord } from '../src/admin/log.ts'
import {
  DEFAULT_LOG_RETENTION_DAYS,
  createLogStore,
  logFileName,
  logStoreStats,
  resolveLogDir,
  retentionDaysFromEnv,
} from '../src/admin/log-store.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'logstore-'))
}

/** 造一条记录（时间可控，好在"按天分文件"上做文章）。 */
function record(level: LogRecord['level'], text: string, day: string, module = 'demo'): LogRecord {
  return { level, module, text, at: `${day}T12:00:00.000Z` }
}

test('★★ 按天分文件；默认**除了 debug 都存**', () => {
  const dir = freshDir()
  try {
    const store = createLogStore({ dir })
    store.write(record('debug', '过程细节', '2026-10-10'))
    store.write(record('info', '起了', '2026-10-10'))
    store.write(record('fault', 'QQ 链路掉了', '2026-10-10'))

    const all = store.read()
    assert.deepEqual(
      all.map((r) => r.level),
      ['info', 'fault'],
      '★ 默认除了 debug 都存（这是用户更正过的那条规则，落盘层不许自己再有一套）',
    )
    assert.equal(logFileName(new Date('2026-10-10T23:59:59Z')), 'forlife-2026-10-10.jsonl')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 环境变量能点名关掉某等级（且**盖过**默认下限）', () => {
  const dir = freshDir()
  try {
    const store = createLogStore({ dir, disabledLevels: new Set(['info']) })
    store.write(record('info', '被关掉了', '2026-10-10'))
    store.write(record('warn', '留着', '2026-10-10'))
    assert.deepEqual(
      store.read().map((r) => r.text),
      ['留着'],
      '关掉的等级必须真的不落盘（否则"关掉"只是句空话）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 裁剪只删**过期的整天文件**，当天与其他文件一个都不许动', () => {
  const dir = freshDir()
  try {
    const now = new Date('2026-10-10T08:00:00.000Z')
    const store = createLogStore({ dir, retentionDays: 3, now: () => now })

    // 造几天的文件：10-01（早）、10-08（保留期内）、10-10（今天）
    for (const day of ['2026-10-01', '2026-10-08', '2026-10-10']) {
      store.write(record('info', `${day} 的事`, day))
    }
    // 一份**非日志**文件：绝不许被碰
    const stranger = join(dir, 'forlife-backup.txt')
    writeFileSync(stranger, '用户的东西', 'utf8')

    assert.equal(store.prune(), 1, '只该删 2026-10-01 那一天')
    const left = logStoreStats(dir).map((f) => f.name)
    assert.deepEqual(left, ['forlife-2026-10-08.jsonl', 'forlife-2026-10-10.jsonl'], '保留期内的一个都不许动')
    assert.equal(readFileSync(stranger, 'utf8'), '用户的东西', '★ 不是日志的文件绝不许碰')

    // ★ 当天那一份必须还在（cutoff 按天算，不然今天的会被误删 —— 那是"日志刚写就没了"）
    assert.ok(store.read().some((r) => r.text.includes('2026-10-10')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ `retentionDays = 0` ⇒ **不裁剪**（一直留着）；环境变量认不出就用默认', () => {
  const dir = freshDir()
  try {
    const store = createLogStore({ dir, retentionDays: 0, now: () => new Date('2030-01-01T00:00:00Z') })
    store.write(record('info', '很久以前', '2026-10-01'))
    assert.equal(store.prune(), 0, '0 = 不裁剪（一直留着）')
    assert.equal(store.read().length, 1, '一条都不许少')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // 坏的环境变量值 ⇒ 回到默认，**不静默变成 0**（那会让"保留"变成"永不删除"）
  assert.equal(retentionDaysFromEnv(undefined), DEFAULT_LOG_RETENTION_DAYS)
  assert.equal(retentionDaysFromEnv('  '), DEFAULT_LOG_RETENTION_DAYS)
  assert.equal(retentionDaysFromEnv('abc'), DEFAULT_LOG_RETENTION_DAYS)
  assert.equal(retentionDaysFromEnv('-5'), DEFAULT_LOG_RETENTION_DAYS)
  assert.equal(retentionDaysFromEnv('30'), 30)
  assert.equal(retentionDaysFromEnv('0'), 0, '显式的 0 是合法的')
})

test('★★ 坏行只跳过它自己，且读/写/裁剪**永不抛**', () => {
  const dir = freshDir()
  try {
    const store = createLogStore({ dir })
    store.write(record('info', '好行一', '2026-10-10'))
    // 手工塞几行坏的（写了一半 / 不是 JSON / 缺字段 / 等级不认识）
    const file = join(dir, logFileName(new Date('2026-10-10T00:00:00Z')))
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}{"level":"info","mod\n不是 JSON\n{"level":"nope","module":"m","text":"t","at":"2026-10-10T12:00:00.000Z"}\n{"level":"info","module":"m"}\n`,
      'utf8',
    )
    store.write(record('warn', '好行二', '2026-10-10'))

    const all = store.read()
    assert.deepEqual(
      all.map((r) => r.text),
      ['好行一', '好行二'],
      '★ 5 行坏数据只该被跳过，另外两条必须还在（一条写了一半的记录不该让整天的日志读不出来）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 目录不可用 ⇒ 不抛、不丢调用方（只在内存里少一条）', () => {
  // 用一个"看起来像目录但其实是文件"的路径制造失败
  const dir = freshDir()
  try {
    const fake = join(dir, 'not-a-dir')
    writeFileSync(fake, 'x', 'utf8')
    const errors: string[] = []
    const store = createLogStore({ dir: join(fake, 'sub'), onError: (m) => errors.push(m) })
    // 不抛 = 通过
    store.write(record('info', '写不进去也不许炸', '2026-10-10'))
    assert.ok(errors.length > 0, '而且**要报出来**（不假装成功）')
    assert.deepEqual(store.read(), [], '读不回来也当没有，不抛')
    assert.equal(store.prune(), 0, '裁剪也当没有，不抛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 面板筛选：等级 / 模块 / 文本 / 条数（用户要的"能筛选等级、模块等"）', () => {
  const dir = freshDir()
  try {
    const store = createLogStore({ dir })
    store.write(record('info', '启动了', '2026-10-10', 'boot'))
    store.write(record('note', '预算不够，没唤醒', '2026-10-10', 'wake-liveness'))
    store.write(record('fault', 'QQ 链路掉了', '2026-10-10', 'onebot'))
    store.write(record('info', '又一条启动信息', '2026-10-10', 'boot'))

    assert.deepEqual(
      store.read({ modules: ['boot'] }).map((r) => r.text),
      ['启动了', '又一条启动信息'],
      '按模块筛',
    )
    assert.deepEqual(store.read({ levels: ['fault'] }).map((r) => r.text), ['QQ 链路掉了'], '按等级筛')
    assert.deepEqual(
      store.read({ min: 'warn' }).map((r) => r.level),
      ['fault'],
      '按最低等级筛（warn 及以上）',
    )
    assert.deepEqual(store.read({ contains: '唤醒' }).map((r) => r.module), ['wake-liveness'], '按文本筛')
    assert.equal(store.read({ limit: 2 }).length, 2, '条数上限')
    // ★ 上限要取**最新的**那几条（面板要看"最近发生了什么"）
    assert.deepEqual(
      store.read({ limit: 2 }).map((r) => r.text),
      ['QQ 链路掉了', '又一条启动信息'],
      '★ limit 必须从**最新往回**取，再正序返回',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 可移植：日志目录只认显式的环境变量，绝不碰宿主 `~`', () => {
  assert.equal(resolveLogDir({ FORLIFE_LOG_DIR: '/x/logs' }), '/x/logs')
  assert.match(resolveLogDir({ FORLIFE_DB_PATH: '/data/forlife/db/forlife.sqlite' }), /logs$/)
  assert.ok(
    !resolveLogDir({}).includes('home'),
    `默认路径不该跑到宿主家目录去（实际：${resolveLogDir({})}）`,
  )
})
