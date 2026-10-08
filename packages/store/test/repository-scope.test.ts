/**
 * `listLongEntriesByScope` 的测试 —— 手动喂食记忆资料的"来源追踪"支点。
 *
 * 这条查询要回答的是「**这个来源**上次喂进去了哪几条」，所以三件事必须钉死：
 *  ① 只返回**该来源**的条目（别的来源、以及没有来源的行都不能混进来）；
 *  ② 顺序**确定**（`created_at, id` 升序）—— 重导要按上次的顺序逐条对应，
 *     顺序不确定会静默配错条目（比报错难查得多）；
 *  ③ **归档的条目也要返回**：喂食的"重导变短了"要把上一版多出来的段落归档，
 *     而已经归档过的那几条得能被看见（否则每次重导都会重复报"归档了 N 条"）。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { insertLongEntry, listLongEntriesByScope, openDatabase } from '../src/index.ts'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

test('按来源取条目：只返回该来源、且顺序确定', () => {
  const db = freshDb()
  insertLongEntry(db, { id: 'b2', content: '第二段', summary: '第二段', sourceScope: 'feed:notes.md' })
  insertLongEntry(db, { id: 'b1', content: '第一段', summary: '第一段', sourceScope: 'feed:notes.md' })
  insertLongEntry(db, { id: 'other', content: '别的来源', summary: '别的来源', sourceScope: 'group:88888' })
  insertLongEntry(db, { id: 'none', content: '没有来源', summary: '没有来源' })

  const rows = listLongEntriesByScope(db, 'feed:notes.md')
  assert.deepEqual(
    [...rows.map((row) => row.id)].sort(),
    ['b1', 'b2'],
    '只能返回该来源的两条（别的来源与 NULL 都不能混进来）',
  )
  // 顺序**确定**：两次调用的顺序必须一模一样。
  // 刻意不断言"等于插入顺序" —— 同一毫秒内写入的两行 created_at 相同，
  // 那时靠 `id` 兜底排序（这是有意的 tie-break，不是 bug）。
  assert.deepEqual(
    listLongEntriesByScope(db, 'feed:notes.md').map((row) => row.id),
    rows.map((row) => row.id),
    '同样的数据两次查询必须给出同样的顺序（重导要按上次的顺序逐条对应）',
  )
  assert.equal(listLongEntriesByScope(db, 'feed:missing.md').length, 0)
  assert.equal(listLongEntriesByScope(db, 'group:88888').length, 1)
})

test('按来源取条目：归档过的行也要返回（否则重导会重复报"归档了 N 条"）', () => {
  const db = freshDb()
  insertLongEntry(db, { id: 's1', content: '第一段', summary: '第一段', sourceScope: 'feed:notes.md' })
  insertLongEntry(db, { id: 's2', content: '第二段', summary: '第二段', sourceScope: 'feed:notes.md' })
  db.prepare("UPDATE long_memory_entries SET status = 'archived' WHERE id = 's2'").run()

  const rows = listLongEntriesByScope(db, 'feed:notes.md')
  assert.equal(rows.length, 2, '归档不等于不存在：调用方要靠 status 自己判断该不该再归档一次')
  assert.equal(rows.find((row) => row.id === 's2')?.status, 'archived')
})
