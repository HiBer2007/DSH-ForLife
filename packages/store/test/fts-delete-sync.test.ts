/**
 * ★★ 删条目要**连带删 FTS 行**（`FIX_PLAN.md` §78.48 / §78.50）。
 *
 * ## 为什么（2026-10-13 查出来的真事）
 *
 * `mid_memory_fts` / `long_memory_fts` 是**手工同步的独立 FTS 表**（`repository.ts` 里先删后插、按 `rowid` 对齐），
 * ⇒ **每个删除条目的地方都得自己记得删 FTS 行**。而查出来两处忘了：
 * `compaction-runs.ts` 的回滚路径 · `fragment-maintenance.ts` 的淘汰路径。
 *
 * ★ 后果是**孤儿索引行**：检索靠 `rowid` JOIN（`repository.ts` 的 `searchMid`/`searchLong`），
 * 所以**不会返回假结果** ⇒ ★ **看不出错**；但索引会一直涨（空间 + `MATCH` 扫描成本），
 * 而且**没有任何告警** —— 典型的"沉默的泄漏"。
 *
 * ## 这一组钉三件事
 *
 * 1. ★★ 删条目之后，**FTS 里那一行也没了**（两张表都验）；
 * 2. ★ 不存在的 id 不炸（回滚是幂等的 —— `compaction-runs` 的模块注释里承诺过）；
 * 3. ★ 三处删除点**都用同一个助手**（源码级，防"以后又有人直接写 DELETE"）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { deleteLongEntry, deleteMidEntry } from '../src/repository.ts'

/** 造一条中期条目 + 它的 FTS 行（与 `repository.ts` 的同步写法一致：按 rowid 对齐）。 */
function seedMid(db: ReturnType<typeof openDatabase>['db'], id: string, text: string): void {
  const info = db
    .prepare(
      `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status, created_at, storage_tier, revision)
       VALUES (?, 'semantic', ?, ?, '[]', 1, 0, 'active', '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
    )
    .run(id, text, text)
  const rowid = Number(info.lastInsertRowid)
  db.prepare('DELETE FROM mid_memory_fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO mid_memory_fts (rowid, summary, content, entities) VALUES (?, ?, ?, ?)').run(rowid, text, text, '')
}

/** 造一条长期条目 + 它的 FTS 行。 */
function seedLong(db: ReturnType<typeof openDatabase>['db'], id: string, text: string): void {
  const info = db
    .prepare(
      `INSERT INTO long_memory_entries (id, content, summary, entities, embedding_id, source_mid_ids, storage_tier, status)
       VALUES (?, ?, ?, '[]', NULL, '[]', 'ssd', 'active')`,
    )
    .run(id, text, text)
  const rowid = Number(info.lastInsertRowid)
  db.prepare('DELETE FROM long_memory_fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO long_memory_fts (rowid, summary, content, entities) VALUES (?, ?, ?, ?)').run(rowid, text, text, '')
}

test('★★★ 删中期条目 ⇒ FTS 行也没了（★ 否则留孤儿索引行，而且没有任何告警）', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedMid(opened.db, 'mid_a', '第一条记忆')
  seedMid(opened.db, 'mid_b', '第二条记忆')
  assert.equal(Number((opened.db.prepare('SELECT COUNT(*) n FROM mid_memory_fts').get() as { n: number } | undefined)?.n ?? 0), 2, '前提：FTS 有两行')

  assert.equal(deleteMidEntry(opened.db, 'mid_a'), 1, '要报告删掉了 1 条')
  assert.equal(Number((opened.db.prepare('SELECT COUNT(*) n FROM mid_memory_entries').get() as { n: number } | undefined)?.n ?? 0), 1, '条目剩 1 条')
  assert.equal(Number((opened.db.prepare('SELECT COUNT(*) n FROM mid_memory_fts').get() as { n: number } | undefined)?.n ?? 0), 1, '★ FTS 也必须剩 1 行（不是 2）')
  // ★ 用 rowid JOIN 而不是 MATCH：FTS 的 unicode61 分词器把中文整串当一个 token，
  //   查子串命不中（我第一版就是这么写错的，被这条测试当场抓住）。
  //   这里要验的是"索引行仍然对得上一条活着的条目"，JOIN 正好是这个意思。
  const hit = opened.db
    .prepare('SELECT m.id FROM mid_memory_fts f JOIN mid_memory_entries m ON m.rowid = f.rowid')
    .all()
  assert.deepEqual(hit.map((r) => r.id), ['mid_b'], '★ 活着的那个条目的索引行还在（别把别人的删了）')
})

test('★★★ 删长期条目 ⇒ FTS 行也没了（同一件事的另一半）', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedLong(opened.db, 'long_a', '长期记忆甲')
  seedLong(opened.db, 'long_b', '长期记忆乙')
  assert.equal(deleteLongEntry(opened.db, 'long_a'), 1)
  assert.equal(Number((opened.db.prepare('SELECT COUNT(*) n FROM long_memory_entries').get() as { n: number } | undefined)?.n ?? 0), 1)
  assert.equal(Number((opened.db.prepare('SELECT COUNT(*) n FROM long_memory_fts').get() as { n: number } | undefined)?.n ?? 0), 1, '★ FTS 也要跟着少一行')
})

test('★ 不存在的 id 不炸（回滚是幂等的 —— `compaction-runs` 承诺过）', () => {
  const opened = openDatabase({ file: ':memory:' })
  assert.equal(deleteMidEntry(opened.db, 'mid_不存在'), 0, '删不到就报 0，不许抛')
  assert.equal(deleteLongEntry(opened.db, 'long_不存在'), 0)
})

test('★★ 三处删除点都用同一个助手（防"以后又有人直接写 DELETE FROM …_entries"）', () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
  const runs = read('../src/compaction-runs.ts')
  const maintenance = read('../src/fragment-maintenance.ts')
  assert.match(runs, /deleteMidEntry\(db, id\)/, '★ 回滚路径要走助手')
  assert.match(runs, /deleteLongEntry\(db, id\)/, '★ 回滚路径要走助手')
  assert.match(maintenance, /deleteMidEntry\(db, id\)/, '★ 淘汰路径要走助手')
  // ★ 反向断言：这两处不许再出现"裸删条目"
  assert.ok(!/DELETE FROM mid_memory_entries WHERE id = \?/.test(runs), '★ 回滚路径不许裸删')
  assert.ok(!/DELETE FROM long_memory_entries WHERE id = \?/.test(runs), '★ 回滚路径不许裸删')
  assert.ok(!/DELETE FROM mid_memory_entries WHERE id = \?/.test(maintenance), '★ 淘汰路径不许裸删')
})
