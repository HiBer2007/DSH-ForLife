/**
 * ★★ 合并落库（D8 第 4 步）：**写留痕 · 换粗 hint · 标 archived · 可恢复**。
 *
 * 用户 2026-10-13 裁定"落库形态 = B：新表、多对一、可回溯"，这一组测试钉住四件事：
 *
 * 1. ★★ 保留的那条**换成粗 hint**、被并的**标 `archived`（不是删）**、留痕**记全**；
 * 2. ★★ **可恢复**：`restoreFragmentMerge()` 把被并的改回 `fragmented` 并撤掉留痕；
 * 3. ★ **幂等**：同一组重复执行不灌水、不重复计数；
 * 4. ★★ **同生共死**：留痕与状态在**一条事务**里（这里用"留痕写不进去就整体回滚"来验）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { applyFragmentMerge, listFragmentMerges, listMergeCandidates, restoreFragmentMerge } from '../src/fragment-merges.ts'

/** 造一条碎片。 */
function seedFragment(db: ReturnType<typeof openDatabase>['db'], id: string, hint: string): void {
  db.prepare(
    `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status,
       fragment_hint, created_at, storage_tier, revision)
     VALUES (?, 'fragment', ?, '正文', '["e1","e2"]', 10, 0, 'fragmented', ?, '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
  ).run(id, hint, hint)
}

/** 读一条的状态与 hint。 */
function read(db: ReturnType<typeof openDatabase>['db'], id: string): { status: string; hint: string | null } {
  const row = db.prepare('SELECT status, fragment_hint AS hint FROM mid_memory_entries WHERE id = ?').get(id) as
    | { status: string; hint: string | null }
    | undefined
  assert.ok(row !== undefined, `条目 ${id} 应当存在`)
  return row
}

test('★★★ 落一次合并：保留的换粗 hint · 被并的标 archived（★ 不是删）· 留痕记全', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedFragment(opened.db, 'frag_a', '甲')
  seedFragment(opened.db, 'frag_b', '乙')
  seedFragment(opened.db, 'frag_c', '丙')

  const result = applyFragmentMerge(opened.db, {
    mergedId: 'frag_a',
    sourceIds: ['frag_b', 'frag_c'],
    hint: '甲；乙；丙',
    rule: 'intersection(minShared=2)',
  })
  assert.deepEqual(result, { hinted: 1, archived: 2, recorded: 2 })

  // ★ 逐字段比（不整对象 `deepEqual`：SQLite 回来的是 **null 原型对象**，整对象比会因原型不同而红）
  const kept = read(opened.db, 'frag_a')
  assert.equal(kept.status, 'fragmented', '★ 保留的那条仍在渲染集合里')
  assert.equal(kept.hint, '甲；乙；丙', '★ 保留的那条要换成粗 hint')
  assert.equal(read(opened.db, 'frag_b').status, 'archived', '★ 被并的是 archived（不是删）')
  assert.equal(read(opened.db, 'frag_c').status, 'archived')
  const rows = listFragmentMerges(opened.db, 'frag_a')
  assert.deepEqual(
    rows.map((r) => r.sourceId),
    ['frag_b', 'frag_c'],
    '★ 留痕要能回答"这条粗 hint 是由哪几条合出来的"',
  )
  assert.equal(rows[0]?.rule, 'intersection(minShared=2)', '★ 规则与参数要记下来')
  opened.close?.()
})

test('★★★ 可恢复：撤掉一次合并 ⇒ 被并的改回 fragmented、留痕撤掉（★ 合并改变模型看到的文本，做错了要能退）', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedFragment(opened.db, 'frag_a', '甲')
  seedFragment(opened.db, 'frag_b', '乙')
  applyFragmentMerge(opened.db, { mergedId: 'frag_a', sourceIds: ['frag_b'], hint: '甲；乙', rule: 'jaccard(>=0.5)' })

  const back = restoreFragmentMerge(opened.db, 'frag_a')
  assert.deepEqual(back, { restored: 1, removed: 1 })
  assert.equal(read(opened.db, 'frag_b').status, 'fragmented', '★ 恢复成可渲染的碎片')
  assert.deepEqual(listFragmentMerges(opened.db, 'frag_a'), [], '★ 留痕要撤掉（否则"恢复过"这件事查不清）')
  opened.close?.()
})

test('★★ 幂等：同一组再落一次 ⇒ 不灌水、不重复计数', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedFragment(opened.db, 'frag_a', '甲')
  seedFragment(opened.db, 'frag_b', '乙')
  const input = { mergedId: 'frag_a', sourceIds: ['frag_b'], hint: '甲；乙', rule: 'intersection(minShared=2)' }
  applyFragmentMerge(opened.db, input)
  const again = applyFragmentMerge(opened.db, input)
  assert.deepEqual(again, { hinted: 1, archived: 0, recorded: 0 }, '★ 第二次：hint 照写（幂等）、archived 与留痕都不再变')
  assert.equal(listFragmentMerges(opened.db, 'frag_a').length, 1, '★ 留痕只有一行')
  opened.close?.()
})

test('★ 只动 `fragmented` 的条目（active 是原始记忆，★ 删错就没救）', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedFragment(opened.db, 'frag_a', '甲')
  // 一条 active（不是碎片）：即使被点名也不该被改
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status, created_at, storage_tier, revision)
       VALUES ('mid_active', 'semantic', '活跃', '正文', '[]', 10, 0, 'active', '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
    )
    .run()
  const result = applyFragmentMerge(opened.db, {
    mergedId: 'frag_a',
    sourceIds: ['mid_active'],
    hint: '甲；活跃',
    rule: 'intersection(minShared=2)',
  })
  assert.equal(result.archived, 0, '★ active 不许被归档')
  assert.equal(read(opened.db, 'mid_active').status, 'active')
  opened.close?.()
})

test('★★★ 候选读取（D8 的输入）：只取 `fragmented` · 按创建时间升序 · entities 坏数据不炸', () => {
  const opened = openDatabase({ file: ':memory:' })
  seedFragment(opened.db, 'frag_b', '乙')
  seedFragment(opened.db, 'frag_a', '甲')
  // ★ active 不许进候选（§5.3-3 说的是"碎片合并"）
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status, created_at, storage_tier, revision)
       VALUES ('mid_active', 'semantic', '活跃', '正文', '["e9"]', 10, 0, 'active', '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
    )
    .run()
  // ★ 一条 entities 是坏 JSON 的碎片（不该让整轮维护停摆）
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status, fragment_hint, created_at, storage_tier, revision)
       VALUES ('frag_bad', 'fragment', '坏的', '正文', '{不是 JSON', 10, 0, 'fragmented', '坏的', '2026-10-12T00:00:00.000Z', 'ssd', 1)`,
    )
    .run()

  const rows = listMergeCandidates(opened.db)
  assert.deepEqual(
    rows.map((r) => r.id),
    ['frag_bad', 'frag_a', 'frag_b'],
    '★ 只取 fragmented，且按 created_at 升序（顺序必须由数据决定 ⇒ 分组可复现）',
  )
  assert.ok(!rows.some((r) => r.id === 'mid_active'), '★ active 不进候选')
  const bad = rows.find((r) => r.id === 'frag_bad')
  assert.deepEqual(bad?.entities, [], '★ 坏 JSON ⇒ 空数组（不抛：一条坏数据不该让整轮维护停摆）')
  assert.equal(rows.find((r) => r.id === 'frag_a')?.entities.length, 2, '★ 正常 entities 要读出来')
  opened.close?.()
})