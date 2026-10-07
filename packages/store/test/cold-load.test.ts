/**
 * 冷数据加载的守卫测试（验收标准 #3）。
 *
 * ## 最值得守的五条
 *
 * 1. **归档读不出来时绝不回落到库内副本** —— 那会掩盖"归档坏了"，
 *    而归档坏了正是最该被发现的事（它是"很久以后才回来读"的东西）。
 * 2. **失败也记延迟** —— 失败的那次往往最慢（磁盘坏了会超时重试），
 *    只记成功会把最坏情况藏起来。
 * 3. **`source` 要如实** —— 正文在库里就必须报 `db`，
 *    不能让人以为"从 HDD 按需加载"了。
 * 4. **max 要取较大者**（不是累加）—— 只累加的话"最慢的那次"会被平均掉。
 * 5. **平均要现算** —— 存平均值的话增量更新会算错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadLongEntry, loadStats, recordLoad, SLOW_LOAD_MS } from '../src/cold-load.ts'
import { openDatabase } from '../src/db.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

function setup(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

function addLong(
  opened: ReturnType<typeof openDatabase>,
  id: string,
  opts: { tier: string; archivePath: string | null; content?: string },
): void {
  opened.db
    .prepare(
      `INSERT INTO long_memory_entries (id, content, summary, entities, source_mid_ids, storage_tier, archive_path, status, created_at)
       VALUES (?, ?, '摘要', '[]', '[]', ?, ?, 'active', ?)`,
    )
    .run(id, opts.content ?? `正文 ${id}`, opts.tier, opts.archivePath, AT.toISOString())
}

/** 假时钟：每次调用前进固定毫秒。 */
function fakeClock(stepMs: number): () => number {
  let t = 0
  return (): number => {
    const v = t
    t += stepMs
    return v
  }
}

test('★ 冷层 + 有归档 ⇒ **从归档按需加载**，并记延迟', async () => {
  const opened = setup()
  try {
    addLong(opened, 'L1', { tier: 'cold', archivePath: 'D:\\archives\\L1.txt' })
    const r = await loadLongEntry({
      db: opened.db,
      id: 'L1',
      readFile: async () => '归档里的正文',
      now: fakeClock(40),
      slowMs: 1000,
    })
    assert.equal(r.found, true)
    assert.equal(r.content, '归档里的正文')
    assert.equal(r.source, 'archive', '**有归档就必须从归档读**')
    assert.equal(r.tier, 'cold')

    const stats = loadStats(opened.db)
    assert.equal(stats.length, 1)
    assert.equal(stats[0]?.tier, 'cold')
    assert.equal(stats[0]?.loads, 1)
    assert.ok((stats[0]?.avgMs ?? 0) > 0, '延迟要记下来')
  } finally {
    opened.db.close()
  }
})

test('★★ 归档读不出来 ⇒ **绝不回落到库内副本**', async () => {
  const opened = setup()
  try {
    // 库里有正文，但归档文件坏了
    addLong(opened, 'L1', { tier: 'cold', archivePath: 'D:\\archives\\gone.txt', content: '库里的副本' })
    const r = await loadLongEntry({
      db: opened.db,
      id: 'L1',
      readFile: async () => {
        throw new Error('ENOENT')
      },
      now: fakeClock(5),
    })
    assert.equal(r.found, false, '**必须报失败**')
    assert.equal(r.content, undefined, '**绝不能把库里的副本当成功返回**')
    assert.match(r.note, /没有回落到库内副本/)
    assert.equal(r.source, 'archive', '如实报"试的是归档那条路"')
  } finally {
    opened.db.close()
  }
})

test('★ 没有归档 ⇒ 从库里读，且 **source 如实报 db**', async () => {
  const opened = setup()
  try {
    addLong(opened, 'L1', { tier: 'cold', archivePath: null, content: '库里的正文' })
    const r = await loadLongEntry({ db: opened.db, id: 'L1', now: fakeClock(3) })
    assert.equal(r.found, true)
    assert.equal(r.content, '库里的正文')
    assert.equal(r.source, 'db', '**正文在库里就必须报 db** —— 不能让人以为从 HDD 加载了')
    assert.match(r.note, /不算"从 HDD 按需加载"/)
  } finally {
    opened.db.close()
  }
})

test('★ 失败**也记延迟**（失败的那次往往最慢）', async () => {
  const opened = setup()
  try {
    await loadLongEntry({ db: opened.db, id: '不存在', now: fakeClock(7) })
    const stats = loadStats(opened.db)
    const none = stats.find((s) => s.tier === 'none')
    assert.ok(none !== undefined, '找不到的也要记一行（tier=none）')
    assert.equal(none?.loads, 1)
  } finally {
    opened.db.close()
  }
})

test('★ max 取**较大者**（不是累加）—— 只累加的话"最慢的那次"会被平均掉', () => {
  const opened = setup()
  try {
    recordLoad(opened.db, 'cold', 100, 1000, () => AT.getTime())
    recordLoad(opened.db, 'cold', 30, 1000, () => AT.getTime())
    const s = loadStats(opened.db).find((x) => x.tier === 'cold')
    assert.equal(s?.loads, 2)
    assert.equal(s?.maxMs, 100, 'max 要留 100（不能被 30 覆盖，也不能变成 130）')
    assert.equal(s?.lastMs, 30, 'last 要是最后一次')
    assert.equal(s?.avgMs, 65, '平均要现算：(100+30)/2')
  } finally {
    opened.db.close()
  }
})

test('★ 超过阈值记进 slow_loads（让"可接受"这句话可查）', () => {
  const opened = setup()
  try {
    recordLoad(opened.db, 'cold', SLOW_LOAD_MS + 1, SLOW_LOAD_MS, () => AT.getTime())
    recordLoad(opened.db, 'cold', 10, SLOW_LOAD_MS, () => AT.getTime())
    const s = loadStats(opened.db).find((x) => x.tier === 'cold')
    assert.equal(s?.slowLoads, 1, '只该记那一次慢的')
  } finally {
    opened.db.close()
  }
})

test('★ 按 tier 分行 —— 只有 hot 与 cold 放在一起比，"可接受"才有依据', async () => {
  const opened = setup()
  try {
    addLong(opened, 'H1', { tier: 'hot', archivePath: null })
    addLong(opened, 'C1', { tier: 'cold', archivePath: 'D:\\a.txt' })
    await loadLongEntry({ db: opened.db, id: 'H1', now: fakeClock(1) })
    await loadLongEntry({ db: opened.db, id: 'C1', readFile: async () => 'x', now: fakeClock(50) })
    const stats = loadStats(opened.db)
    assert.equal(stats.length, 2)
    const hot = stats.find((s) => s.tier === 'hot')
    const cold = stats.find((s) => s.tier === 'cold')
    assert.ok((cold?.avgMs ?? 0) > (hot?.avgMs ?? 0), '冷层该更慢（这就是"对比"的意义）')
  } finally {
    opened.db.close()
  }
})

test('找不到的条目 ⇒ found:false 且说清', async () => {
  const opened = setup()
  try {
    const r = await loadLongEntry({ db: opened.db, id: 'nope', now: fakeClock(2) })
    assert.equal(r.found, false)
    assert.equal(r.source, 'none')
    assert.match(r.note, /没有这条长期记忆/)
  } finally {
    opened.db.close()
  }
})

test('空库 ⇒ 统计为空，不是报错', () => {
  const opened = setup()
  try {
    assert.deepEqual(loadStats(opened.db), [])
  } finally {
    opened.db.close()
  }
})
