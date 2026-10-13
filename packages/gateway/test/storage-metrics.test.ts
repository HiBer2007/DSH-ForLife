/**
 * ★★ 存储指标进日志（`FIX_PLAN.md` §57 待办⑥）。
 *
 * ## 为什么需要
 *
 * 库大小 / WAL / 空闲页**面板上本来就有**（`queries-storage.ts`），
 * ★ 但那要**有人去打开面板**才看得见。于是：
 * WAL 一直涨（checkpoint 没跟上）没人知道，空闲页越积越多没人知道，
 * 直到**磁盘满**或某个页面慢到没法用。
 *
 * ## 钉三件事
 *
 * 1. ★ 第一次 tick 记**基线**（没有基线，"库变大了"没有参照）；
 * 2. ★★ **边沿检测**：WAL 大就一直大 ⇒ 每轮都写会把日志库灌满（只在跨阈值时写一条，
 *    回落到阈值一半以下再写"恢复"）；
 * 3. ★★ 指标读失败**不许反杀循环**（定时器里抛异常会静默杀死整个监视）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createLogger, installLogSink, type LogRecord } from '../src/admin/log.ts'
import { describeStorageMetrics, freeRatio, readStorageMetrics, startStorageWatch } from '../src/admin/storage-metrics.ts'

/** 造一个真文件库（内存库没有 `-wal` 文件）。 */
function tempDb(): { readonly dir: string; readonly path: string; readonly db: ReturnType<typeof openDatabase>['db']; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-storage-metrics-'))
  const path = join(dir, 'forlife.sqlite')
  const opened = openDatabase({ file: path })
  return {
    dir,
    path,
    db: opened.db,
    cleanup: () => {
      try {
        opened.close()
      } catch {
        // Windows 上可能还开着
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 同上
      }
    },
  }
}

/** 收结构化日志。 */
function capture(): { readonly records: LogRecord[]; readonly restore: () => void } {
  const records: LogRecord[] = []
  const restore = installLogSink((record) => records.push(record))
  return { records, restore }
}

test('★★ 读出来的指标是真的（WAL 模式、页大小、库文件大小）', () => {
  const fixture = tempDb()
  try {
    const metrics = readStorageMetrics(fixture.db, fixture.path)
    assert.equal(metrics.journalMode, 'wal', '★ 多进程同机安全靠的就是 WAL（`db.ts` 里设的）')
    assert.ok(metrics.pageSize > 0, `页大小要读得到：${String(metrics.pageSize)}`)
    assert.ok(metrics.pageCount > 0, '页数要读得到')
    assert.ok(metrics.dbBytes > 0, '库文件大小要读得到（真文件库）')
    assert.ok(metrics.walBytes >= 0, 'WAL 可能刚被 checkpoint 掉（0 是正常的）')
    assert.equal(metrics.busyTimeoutMs, 5000, '★ busy_timeout 是"锁等待能忍多久"，要能看到它')
    assert.match(describeStorageMetrics(metrics), /journal=wal/)
  } finally {
    fixture.cleanup()
  }
})

test('★ 内存库不许崩（没有 `-wal` 文件、没有路径）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const metrics = readStorageMetrics(opened.db, ':memory:')
    assert.equal(metrics.dbBytes, 0, '内存库没有文件大小')
    assert.equal(metrics.walBytes, 0)
    assert.equal(freeRatio(metrics), 0, '★ 页数为 0 时不许造出 NaN')
  } finally {
    opened.close()
  }
})

test('★★★ 第一次 tick 记基线，且**只记一次**（没有基线就没有"变大了"）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    // ★★ 启动时**立刻**就要有基线（真机第一次部署就踩到：库里一条 `storage` 都没有，
    //    因为原来只有周期 tick —— 要等 5 分钟，中间一重启就永远没有基线）
    const immediate = cap.records.filter((r) => r.text.includes('存储基线'))
    assert.equal(immediate.length, 1, `启动时就要记基线（实际 ${String(immediate.length)} 条）`)
    watch.tick()
    watch.tick()
    const baselines = cap.records.filter((r) => r.text.includes('存储基线'))
    assert.equal(baselines.length, 1, `基线只记一次（实际 ${String(baselines.length)} 次）`)
    assert.equal(baselines[0]?.module, 'storage', '★ 模块名固定 ⇒ 面板按模块筛得到')
    assert.equal(baselines[0]?.level, 'note')
    assert.match(baselines[0]?.text ?? '', /journal=wal/, '基线要把关键指标写出来')
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★★ WAL 跨阈值 ⇒ **一条** `warn`；再 tick 不许重复（边沿检测，否则刷屏）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    // 阈值压到 1 字节 ⇒ 只要 WAL 文件存在就一定超
    writeFileSync(`${fixture.path}-wal`, Buffer.alloc(2048))
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { walWarnBytes: 1 },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    watch.tick()
    watch.tick()
    const warns = cap.records.filter((r) => r.level === 'warn' && r.text.includes('WAL 涨到'))
    assert.equal(warns.length, 1, `★ 跨阈值只写一条（实际 ${String(warns.length)} 条）`)
    assert.equal(warns[0]?.module, 'storage')
    assert.match(warns[0]?.text ?? '', /checkpoint 没跟上/, '要说清**为什么**要管它')
    assert.equal(watch.walWarned(), true)
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★ WAL 回落到阈值一半以下 ⇒ 报"恢复"（不然人以为它一直坏着）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    const walPath = `${fixture.path}-wal`
    writeFileSync(walPath, Buffer.alloc(4096))
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { walWarnBytes: 1024 },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    assert.equal(watch.walWarned(), true)
    // 缩到阈值一半以下（512 < 1024/2）
    writeFileSync(walPath, Buffer.alloc(100))
    watch.tick()
    assert.equal(watch.walWarned(), false, '★ 要复位（否则下一次真涨起来不会再报）')
    assert.ok(
      cap.records.some((r) => r.text.includes('WAL 回落到')),
      `恢复也要留一条（现在：${cap.records.map((r) => r.text).join('｜')}）`,
    )
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★ 空闲页多 ⇒ `note` 说清"可以考虑 VACUUM"（这是删行留下的洞）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    // 造一堆空闲页：建表 → 塞很多行 → 全删
    fixture.db.exec('CREATE TABLE bloat (id INTEGER PRIMARY KEY, payload TEXT)')
    const insert = fixture.db.prepare('INSERT INTO bloat (payload) VALUES (?)')
    for (let i = 0; i < 2000; i += 1) insert.run('x'.repeat(200))
    fixture.db.exec('DELETE FROM bloat')
    const metrics = readStorageMetrics(fixture.db, fixture.path)
    assert.ok(metrics.freelistCount > 0, `删完应当有空闲页（实际 ${String(metrics.freelistCount)}）`)

    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { freeRatioWarn: 0.01 },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    assert.ok(
      cap.records.some((r) => r.text.includes('空闲页占比') && r.text.includes('VACUUM')),
      `要说清这是 VACUUM 的判据（现在：${cap.records.map((r) => r.text).join('｜')}）`,
    )
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★ 指标读失败**不许反杀循环**（定时器里抛异常会静默杀死监视）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { walWarnBytes: 1 },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    // 把库关掉 ⇒ 后面的 PRAGMA 会抛
    fixture.db.close()
    assert.doesNotThrow(() => watch.tick(), '★ tick 不许把异常抛出去（那会杀掉整个循环）')
    assert.ok(
      cap.records.some((r) => r.level === 'warn' && r.text.includes('存储指标读取失败')),
      `要如实说读失败了（现在：${cap.records.map((r) => r.text).join('｜')}）`,
    )
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★ 没给 `logger` 时退回 `log(message)`（老调用方不受影响）', () => {
  const fixture = tempDb()
  const lines: string[] = []
  try {
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      log: (message) => lines.push(message),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    assert.ok(lines.some((line) => line.includes('存储基线')), `退回路径仍要出话：${lines.join('｜')}`)
  } finally {
    fixture.cleanup()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ★★ 剩余空间：§70 的活教训（`tiering.warnFreeBytes` 在契约里躺着，**没有任何代码读它**）
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 剩余空间低于警戒线 ⇒ **一条** `warn`，并说清警戒线来自哪（边沿检测）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    // ★ 把警戒线抬到天上 ⇒ 必然"低于警戒线"（测试里没法把磁盘写满，这是等价的做法）
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { freeWarnBytes: Number.MAX_SAFE_INTEGER },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const warns = cap.records.filter((r) => r.level === 'warn' && r.text.includes('剩余空间'))
    assert.equal(warns.length, 1, `启动时就要有且只有一条（实际 ${String(warns.length)}）`)
    assert.equal(warns[0]?.module, 'storage')
    assert.match(warns[0]?.text ?? '', /tiering\.warnFreeBytes/, '★ 要说清警戒线是**哪个配置键**来的')
    watch.tick()
    watch.tick()
    assert.equal(
      cap.records.filter((r) => r.text.includes('剩余空间') && r.level === 'warn').length,
      1,
      '★★ 边沿检测：跨阈值只写一条（空间小就一直小，每轮都写会把日志灌满）',
    )
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★★ 剩余空间低于**危险线** ⇒ `fault`（写盘随时会失败）', () => {
  const fixture = tempDb()
  const cap = capture()
  try {
    const watch = startStorageWatch({
      db: fixture.db,
      dbPath: fixture.path,
      logger: createLogger('storage'),
      thresholds: { freeWarnBytes: Number.MAX_SAFE_INTEGER, freeFaultBytes: Number.MAX_SAFE_INTEGER },
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const faults = cap.records.filter((r) => r.level === 'fault')
    assert.equal(faults.length, 1, `要有一条 fault（实际 ${JSON.stringify(cap.records.map((r) => r.text))}）`)
    assert.match(faults[0]?.text ?? '', /危险线/, '要说清这是危险线')
    assert.match(faults[0]?.text ?? '', /先清冷层\/日志/, '★ 要给出**下一步做什么**（否则告警只是噪音）')
    assert.equal(
      cap.records.filter((r) => r.level === 'warn' && r.text.includes('低于警戒线')).length,
      0,
      '★ 已经在 fault 里，不该再报一条 warn（两个阈值是**分级**，不是叠加）',
    )
  } finally {
    cap.restore()
    fixture.cleanup()
  }
})

test('★★ 取不到剩余空间（内存库）⇒ **不报**，但基线里要写"没查到"（不许当成健康、也不许当成坏了）', () => {
  const opened = openDatabase({ file: ':memory:' })
  const cap = capture()
  try {
    const watch = startStorageWatch({
      db: opened.db,
      dbPath: ':memory:',
      logger: createLogger('storage'),
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    watch.tick()
    assert.deepEqual(
      cap.records.filter((r) => r.text.includes('剩余空间') && r.level !== 'note'),
      [],
      '取不到时不许报空间告警（那会是误报）',
    )
    assert.match(
      cap.records[0]?.text ?? '',
      /剩余空间=没查到/,
      '★ 但基线要如实写"没查到"（省略会让人以为没这项指标）',
    )
  } finally {
    cap.restore()
    opened.close()
  }
})

test('★★ 源码级：`server.ts` **真的把契约里那个键读进来**（§70 的根因就是没人读它）', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(
    source,
    /freeWarnBytes: defaultFor<number>\('tiering\.warnFreeBytes'\)/,
    '★★ 警戒线必须来自契约键 `tiering.warnFreeBytes` —— ★ 在代码里写死一个 5GB 就等于又一次"没人读那个键"',
  )
})
