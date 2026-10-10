/**
 * 「开始投喂」入口的测试（`FIX_PLAN.md` §23 那个洞）。
 *
 * ## 这个文件在钉什么
 *
 * 1. **★★★ 自然序，不是字典序** —— 字典序下 `seg2-10.md` < `seg2-9.md`，
 *    而**投喂顺序就是"记忆形成的先后"**。错乱之后很难发现（数字看起来都连续）。
 *    素材若恰好零填充（`006`/`010`）两种排法一样 ⇒ **不能靠"看起来对"来验**，
 *    必须用**不零填充**的清单来钉。
 * 2. **★★ 空清单必须抛** —— 开一次"零段的运行"会让钩子以为在投喂，
 *    于是**收窄她的工具却没有任何东西可喂**。
 * 3. **★★ 不重置游标** —— 这是断点续传能成立的**前提**：
 *    重新登记素材**不该**让"上次喂到第 58 段"丢掉。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { advanceFeedCursor, readFeedCursor } from '../src/feed-cursor.ts'
import { readFeedRun } from '../src/feed-run.ts'
import { planSegmentsFromFiles, startFeedRunFromFiles } from '../src/feed-run-start.ts'

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'feed-start-'))
  const db = new DatabaseSync(join(dir, 't.sqlite'))
  db.exec('CREATE TABLE forlife_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, dir }
}

test('★★★ 自然序：`seg-9` 必须排在 `seg-10` **前面**（字典序会排反）', () => {
  // ★ 故意用**不零填充**的名字 —— 零填充的话两种排法一样，测不出问题
  const files = ['/m/seg-10.md', '/m/seg-9.md', '/m/seg-2.md', '/m/seg-1.md']
  const segments = planSegmentsFromFiles(files)

  assert.deepEqual(
    segments.map((s) => s.label),
    ['seg-1.md', 'seg-2.md', 'seg-9.md', 'seg-10.md'],
    '★ 必须按**数字**排 —— 投喂顺序就是"记忆形成的先后"，排反了很难发现',
  )
  assert.deepEqual(
    segments.map((s) => s.index),
    [1, 2, 3, 4],
    '编号必须是排完之后的位置（1..N），`feed-plan` 靠它排产',
  )
  // 反面：若谁把它改回 `.sort()`（字典序），上一条会红 —— 这里再明确一遍
  assert.notDeepEqual(
    segments.map((s) => s.label),
    [...files].sort().map((p) => p.split('/').pop()),
    '不许是字典序',
  )
})

test('★★ `label` 取文件名（全路径会把面板一行撑爆）', () => {
  const segments = planSegmentsFromFiles(['/very/long/path/to/seg2-006.md'])
  assert.equal(segments[0]?.label, 'seg2-006.md')
  assert.equal(segments[0]?.path, '/very/long/path/to/seg2-006.md', '★ 而 `path` 必须是**完整路径**（模型靠它 read）')
})

test('★★ 空清单 / 全是空白 ⇒ 抛错，**不许**开一次"零段的运行"', () => {
  const { db, dir } = freshDb()
  try {
    assert.throws(
      () => startFeedRunFromFiles(db, { source: 's', kind: 'knowledge', perTurn: 5, files: [] }),
      /清单是空的/,
      '★ 空运行会让钩子以为在投喂 ⇒ **收窄她的工具却没有任何东西可喂**（她既不能正常用工具、又没活干）',
    )
    assert.throws(
      () => startFeedRunFromFiles(db, { source: 's', kind: 'knowledge', perTurn: 5, files: ['', '  '] }),
      /清单是空的/,
    )
    assert.equal(readFeedRun(db), undefined, '抛了就不许留下半条登记')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 每轮段数必须是 ≥1 的整数（0 会让排产原地踏步）', () => {
  const { db, dir } = freshDb()
  try {
    assert.throws(
      () => startFeedRunFromFiles(db, { source: 's', kind: 'knowledge', perTurn: 0, files: ['/a.md'] }),
      /每轮段数/,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 不重置游标 —— 这是断点续传能成立的前提', () => {
  const { db, dir } = freshDb()
  try {
    const files = ['/m/seg-1.md', '/m/seg-2.md', '/m/seg-3.md']

    // 第一次：喂到第 2 段
    startFeedRunFromFiles(db, { source: 'chat/a', kind: 'experience', perTurn: 2, files })
    advanceFeedCursor(db, 'chat/a', { fedThrough: 2, total: 3 })
    assert.equal(readFeedCursor(db, 'chat/a')?.fedThrough, 2)

    // 第二次：**重新登记同一份素材**（例如进程重启后又点了一次"开始投喂"）
    startFeedRunFromFiles(db, { source: 'chat/a', kind: 'experience', perTurn: 2, files })

    assert.equal(
      readFeedCursor(db, 'chat/a')?.fedThrough,
      2,
      '★ 重新登记素材**不该**让"上次喂到第 2 段"丢掉 —— 那正是断点续传；' +
        '想从头喂要显式 clearFeedCursor()',
    )
    const run = readFeedRun(db)
    assert.equal(run?.segments.length, 3, '素材清单本身要按新的这份登记')
    assert.equal(run?.perTurn, 2)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 登记的内容能被钩子读到（端到端：入口 → 运行登记 → 排产依据）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRunFromFiles(db, {
      source: 'chat/seg2',
      kind: 'knowledge',
      perTurn: 10,
      files: ['/m/seg2-006.md', '/m/seg2-007.md'],
    })
    const run = readFeedRun(db)
    assert.ok(run !== undefined, '★★ 这一步正是 §23 那个洞：以前**没人**会写它')
    assert.equal(run.source, 'chat/seg2')
    assert.equal(run.kind, 'knowledge')
    assert.equal(run.perTurn, 10)
    assert.deepEqual(
      run.segments.map((s) => s.path),
      ['/m/seg2-006.md', '/m/seg2-007.md'],
      '路径要完整（模型靠它 read）',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
