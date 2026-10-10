/**
 * 投喂游标的测试（用户 2026-10-10 指定：**断点续传**）。
 *
 * ## 这个文件在钉什么
 *
 * 用户原话：「给我们的输入资料打上**哪些已经投喂哪些暂未投喂**，以支持**断点续传**」。
 *
 * 四条最容易被写错、且错了**不会立刻炸**的性质：
 *
 * 1. **游标必须活过会话结束** —— 这正是它与 `feed_session` 的关键区别
 *    （那条是瞬时状态、一行覆盖；游标若也一行覆盖，"上次喂到哪"会被下次抹掉）
 * 2. **只许往前，不许回退** —— 中途打断后旧批次的收尾可能后到；允许回退就会重喂
 * 3. **坏数据当没有，且永不抛** —— 它在投喂流程与面板上被调
 * 4. **★ 没有陈旧判定** —— 加一个"太旧就当没有"，**断点续传就永远失效**
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  FEED_CURSOR_PREFIX,
  advanceFeedCursor,
  clearFeedCursor,
  feedCursorKey,
  listFeedCursors,
  readFeedCursor,
  writeFeedCursor,
} from '../src/feed-cursor.ts'

/** 一个只有 `forlife_state` 的临时库（游标只依赖这一张表 —— 这正是"不加表"的兑现）。 */
function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'feed-cursor-'))
  const db = new DatabaseSync(join(dir, 't.sqlite'))
  db.exec('CREATE TABLE forlife_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, dir }
}

test('★ 写读往返：来源 → 喂到第几段，且带总段数', () => {
  const { db, dir } = freshDb()
  try {
    assert.equal(readFeedCursor(db, 'chat/seg1'), undefined, '没写过就该是 undefined（不是 0）')

    writeFeedCursor(db, 'chat/seg1', { fedThrough: 40, total: 77 })
    const cursor = readFeedCursor(db, 'chat/seg1')
    assert.equal(cursor?.fedThrough, 40)
    assert.equal(cursor?.total, 77)
    assert.ok((cursor?.updatedAt.length ?? 0) > 0, '要记时间 —— 面板要显示"上次喂到什么时候"')

    // 键名形状（面板与测试必须用同一份拼法）
    assert.equal(feedCursorKey('chat/seg1'), `${FEED_CURSOR_PREFIX}chat/seg1`)
    assert.ok(
      (FEED_CURSOR_PREFIX as string) !== 'feed_session',
      '★ 不许与 feed_session 撞键（那是瞬时状态、一行覆盖；游标必须活过会话结束）',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 游标**活过会话结束**：没有陈旧判定（这就是断点续传的前提）', () => {
  const { db, dir } = freshDb()
  try {
    // 写一条**很久以前**的游标（一年前）
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    writeFeedCursor(db, 'chat/old', { fedThrough: 200, now: longAgo })

    // ★ 一年前写的游标**必须仍然读得到** —— 若这里返回 undefined，
    //   说明有人抄了 `feed_session` 的陈旧判定，那样断点续传**永远失效**
    const cursor = readFeedCursor(db, 'chat/old')
    assert.equal(
      cursor?.fedThrough,
      200,
      '游标不许有陈旧判定 —— 它本来就是要长期留着的（"太旧就当没有"会让断点续传永远失效）',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 只许往前：`advance` 遇到更小的值不许回退（旧批次的收尾可能后到）', () => {
  const { db, dir } = freshDb()
  try {
    advanceFeedCursor(db, 's', { fedThrough: 50, total: 100 })
    // 模拟"一个更旧的批次收尾动作后到"
    const after = advanceFeedCursor(db, 's', { fedThrough: 20 })
    assert.equal(after.fedThrough, 50, '游标不许回退 —— 回退就会重喂已喂过的部分（幂等但白干）')

    // 往前是允许的
    assert.equal(advanceFeedCursor(db, 's', { fedThrough: 80 }).fedThrough, 80)

    // ★ 总段数：本次没给就沿用上一次的（"投喂中途才知道总数"很常见）
    assert.equal(readFeedCursor(db, 's')?.total, 100, '没给 total 时要沿用旧值，而不是丢掉')
    // 给了就用新的
    assert.equal(advanceFeedCursor(db, 's', { fedThrough: 90, total: 120 }).total, 120)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 坏数据当没有，且**永不抛**（它在投喂流程与面板上被调）', () => {
  const { db, dir } = freshDb()
  try {
    const good = '{"fedThrough":40,"updatedAt":"2026-10-10T00:00:00.000Z"}'
    const cases = ['', '   ', '{不是 JSON', '[]', 'null', '{"fedThrough":"40"}', '{"fedThrough":-1}', good]
    for (const raw of cases) {
      db.prepare('DELETE FROM forlife_state WHERE key LIKE ?').run(`${FEED_CURSOR_PREFIX}%`)
      db.prepare('INSERT INTO forlife_state (key, value) VALUES (?, ?)').run(feedCursorKey('x'), raw)
      const cursor = readFeedCursor(db, 'x')
      if (raw === good) {
        assert.equal(cursor?.fedThrough, 40, '合法的要读出来')
      } else {
        assert.equal(cursor, undefined, `坏数据「${raw}」必须当成"没有游标"，而不是抛异常`)
      }
    }

    // 表都不存在时也不许抛（渲染/面板路径的兜底）
    const bare = new DatabaseSync(join(dir, 'bare.sqlite'))
    try {
      assert.equal(readFeedCursor(bare, 'x'), undefined)
      assert.deepEqual(listFeedCursors(bare), [])
    } finally {
      bare.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 列全部：面板要能回答"哪些已投喂哪些暂未投喂"，且坏记录只跳过它自己', () => {
  const { db, dir } = freshDb()
  try {
    advanceFeedCursor(db, 'a', { fedThrough: 10, total: 10 })
    advanceFeedCursor(db, 'b', { fedThrough: 3, total: 50 })
    // 一条坏记录：它只该被跳过，**不该让另外两个来源的进度也看不见**
    db.prepare('INSERT INTO forlife_state (key, value) VALUES (?, ?)').run(feedCursorKey('broken'), '{坏')

    const all = listFeedCursors(db)
    assert.deepEqual(
      all.map((row) => row.source),
      ['a', 'b'],
      '坏记录只跳过它自己 —— 一条坏数据不该让面板上看不到其余来源的进度',
    )
    assert.equal(all.find((row) => row.source === 'b')?.cursor.fedThrough, 3)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 清游标只清那一个来源（不提供"清全部"—— 那该由"清空重导"承担）', () => {
  const { db, dir } = freshDb()
  try {
    advanceFeedCursor(db, 'a', { fedThrough: 10 })
    advanceFeedCursor(db, 'b', { fedThrough: 20 })
    clearFeedCursor(db, 'a')
    assert.equal(readFeedCursor(db, 'a'), undefined)
    assert.equal(readFeedCursor(db, 'b')?.fedThrough, 20, '清 a 不许动 b')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
