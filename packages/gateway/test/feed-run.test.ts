/**
 * 投喂运行的测试。
 *
 * ## 这个文件在钉什么
 *
 * 投喂运行存在的理由只有一个：**告诉模型"这一轮该读哪个文件"**
 * （模型驱动路径里素材是它自己去 `read` 的）。所以三条最要紧的性质是：
 *
 * 1. **★ 序号必须与位置严格一致** —— 段清单是**连续**的，序号就是它的位置。
 *    若容忍"中间少一段"，`feed-plan` 会按剩下的段数排产 ⇒ **后面所有段错位**
 *    ⇒ 模型会被指到**错误的文件**上。宁可整份作废（投喂幂等），也不要错位。
 * 2. **越界宁可什么都不给** —— 给错的文件比给不出文件坏得多。
 * 3. **坏数据当没有，且永不抛** —— 它在每次 `turn/start` 上被读。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { describeFeedRunBatch, endFeedRun, readFeedRun, sliceSegments, startFeedRun } from '../src/feed-run.ts'

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'feed-run-'))
  const db = new DatabaseSync(join(dir, 't.sqlite'))
  db.exec('CREATE TABLE forlife_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, dir }
}

/** 造 n 段（序号从 1 开始，路径形如 `/material/seg-001.md`）。 */
function segments(n: number): { index: number; path: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    path: `/material/seg-${String(i + 1).padStart(3, '0')}.md`,
  }))
}

test('★ 开一次运行 → 读得回来（来源 / 知识还是经历 / 每轮几段 / 段清单）', () => {
  const { db, dir } = freshDb()
  try {
    assert.equal(readFeedRun(db), undefined, '没开运行就该是 undefined')
    startFeedRun(db, { source: 'chat/seg2-006', kind: 'experience', perTurn: 50, segments: segments(283) })
    const run = readFeedRun(db)
    assert.equal(run?.source, 'chat/seg2-006')
    assert.equal(run?.kind, 'experience')
    assert.equal(run?.perTurn, 50)
    assert.equal(run?.segments.length, 283)
    assert.equal(run?.segments[0]?.path, '/material/seg-001.md')
    assert.ok((run?.startedAt.length ?? 0) > 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 序号必须与位置严格一致 —— 错位会让模型读**错误的文件**', () => {
  const { db, dir } = freshDb()
  try {
    // 序号对不上（第 2 段写成了 index: 3）
    const misnumbered = [
      { index: 1, path: '/a.md' },
      { index: 3, path: '/b.md' },
      { index: 4, path: '/c.md' },
    ]
    startFeedRun(db, { source: 's', kind: 'knowledge', perTurn: 2, segments: misnumbered })
    assert.equal(
      readFeedRun(db),
      undefined,
      '★ 序号与位置不一致 ⇒ **整份当没有** —— 容忍它会让后面所有段错位，模型就被指到错误的文件上',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 各类坏数据都当"没有这次运行"，且永不抛', () => {
  const { db, dir } = freshDb()
  try {
    const cases: readonly [string, string][] = [
      ['不是 JSON', '{坏'],
      ['不是对象', '[]'],
      ['缺来源', '{"kind":"knowledge","perTurn":5,"startedAt":"x","segments":[{"index":1,"path":"/a"}]}'],
      ['kind 不认识', '{"source":"s","kind":"nope","perTurn":5,"startedAt":"x","segments":[{"index":1,"path":"/a"}]}'],
      ['perTurn 是 0', '{"source":"s","kind":"knowledge","perTurn":0,"startedAt":"x","segments":[{"index":1,"path":"/a"}]}'],
      ['段清单是空的', '{"source":"s","kind":"knowledge","perTurn":5,"startedAt":"x","segments":[]}'],
      ['段没有路径', '{"source":"s","kind":"knowledge","perTurn":5,"startedAt":"x","segments":[{"index":1}]}'],
      ['路径是空白', '{"source":"s","kind":"knowledge","perTurn":5,"startedAt":"x","segments":[{"index":1,"path":"  "}]}'],
    ]
    for (const [what, raw] of cases) {
      db.prepare('DELETE FROM forlife_state').run()
      db.prepare('INSERT INTO forlife_state (key, value) VALUES (?, ?)').run('feed_run', raw)
      assert.equal(readFeedRun(db), undefined, `「${what}」必须当成"没有这次运行"，而不是抛异常`)
    }

    // 表都不存在时也不许抛（它跑在每次 turn/start 上）
    const bare = new DatabaseSync(join(dir, 'bare.sqlite'))
    try {
      assert.equal(readFeedRun(bare), undefined)
    } finally {
      bare.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 取本轮那几段：正常切、**越界宁可什么都不给**', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 's', kind: 'knowledge', perTurn: 3, segments: segments(10) })
    const run = readFeedRun(db)
    assert.ok(run !== undefined)

    const batch = sliceSegments(run, 4, 6)
    assert.deepEqual(
      batch.map((segment) => segment.index),
      [4, 5, 6],
    )
    assert.equal(batch[0]?.path, '/material/seg-004.md', '★ 切出来的路径必须与序号对得上')

    // 越界 / 荒唐区间 ⇒ 空数组（给错的文件比给不出文件坏得多）
    assert.deepEqual(sliceSegments(run, 0, 2), [])
    assert.deepEqual(sliceSegments(run, 5, 4), [])
    assert.deepEqual(sliceSegments(run, 9, 11), [], 'to 越过总数 ⇒ 什么都不给')
    assert.deepEqual(sliceSegments(run, 11, 12), [])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 给模型的那句话：有路径就列路径；没有就**明说没有**（不留空）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 's', kind: 'knowledge', perTurn: 3, segments: segments(4) })
    const run = readFeedRun(db)
    assert.ok(run !== undefined)

    assert.equal(describeFeedRunBatch(sliceSegments(run, 1, 1)), '/material/seg-001.md', '一段就直接给路径')
    assert.equal(
      describeFeedRunBatch(sliceSegments(run, 1, 3)),
      '/material/seg-001.md、/material/seg-002.md、/material/seg-003.md',
      '多段用顿号连起来 —— 它照着 read 就行',
    )
    // ★ 空的时候必须**明说**：留空会让它去猜，而猜出来的路径是读不到的
    const empty = describeFeedRunBatch([])
    assert.ok(empty.includes('没有可读的素材'), `空批次要说清楚：${empty}`)
    assert.ok(empty.length > 0, '不许是空串')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 结束运行 = 删掉（边界要干净，"已结束的运行"留着只会误导）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 's', kind: 'knowledge', perTurn: 2, segments: segments(2) })
    assert.ok(readFeedRun(db) !== undefined)
    endFeedRun(db)
    assert.equal(readFeedRun(db), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
