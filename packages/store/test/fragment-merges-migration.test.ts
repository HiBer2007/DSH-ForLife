/**
 * ★★ 迁移 31：`fragment_merges`（D8；用户 2026-10-13 裁定"落库形态 = B：新表、多对一、可回溯"）。
 *
 * ## 为什么要一条专门的守卫
 *
 * ★ 我加这条迁移时**把数组条目插到了 `MIGRATIONS` 的**开头**（不是末尾）⇒
 *   顺序变成 `[0031, 0001, 0002, …]` ⇒ **store 的测试当场红了一片**。
 *   本仓的铁律是"迁移**升序**应用"，而这件事**光看代码不容易发现** ——
 *   所以这里直接断言"**最后一条就是 0031**"。
 *
 * 另外钉住表形状：**多对一 + 可回溯**（主键 `(merged_id, source_id)` + `source_id` 索引）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIGRATIONS } from '../src/migrations.ts'
import { openDatabase } from '../src/db.ts'

test('★★★ 迁移顺序：0031 必须在**最后**（我把它插到开头时，store 测试红了一片）', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(
    [...versions].sort((a, b) => a - b),
    versions,
    '★ `MIGRATIONS` 必须**升序**（数组顺序就是应用顺序）',
  )
  assert.equal(versions[versions.length - 1], 31, '★ 最后一条是 0031')
  assert.equal(MIGRATIONS.find((m) => m.version === 31)?.name, '0031_fragment_merges')
})

test('★★ `fragment_merges` 表形状：多对一 + 可回溯（主键 + source 索引）', () => {
  const opened = openDatabase({ file: ':memory:' })
  const cols = opened.db.prepare('PRAGMA table_info(fragment_merges)').all() as unknown as { name: string; pk: number }[]
  const names = cols.map((c) => c.name)
  assert.deepEqual(names.sort(), ['merged_at', 'merged_id', 'rule', 'source_id'], '★ 四列，一个不多一个不少')
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name)
  assert.deepEqual(pk, ['merged_id', 'source_id'], '★ 主键是（保留的, 被并的）⇒ 同一对只记一次')
  const idx = opened.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fragment_merges'")
    .all() as unknown as { name: string }[]
  assert.ok(
    idx.some((r) => r.name === 'idx_fragment_merges_source'),
    '★ 要有 source_id 索引（恢复时要反查"这条碎片被并到哪去了"）',
  )
  opened.close?.()
})

test('★★ `rule` 列是**必填**（没有它，事后只能猜这批碎片是按哪套判据合的）', () => {
  const opened = openDatabase({ file: ':memory:' })
  assert.throws(
    () =>
      opened.db
        .prepare('INSERT INTO fragment_merges (merged_id, source_id, merged_at) VALUES (?, ?, ?)')
        .run('m1', 's1', '2026-10-13T00:00:00.000Z'),
    /NOT NULL/,
    '★ rule 不许为空 —— 它是"可回溯"的核心',
  )
  // ★ 正常写入要能成功，并且同一对重复写要被主键挡住
  opened.db
    .prepare('INSERT INTO fragment_merges (merged_id, source_id, merged_at, rule) VALUES (?, ?, ?, ?)')
    .run('m1', 's1', '2026-10-13T00:00:00.000Z', 'intersection(minShared=2)')
  assert.throws(
    () =>
      opened.db
        .prepare('INSERT INTO fragment_merges (merged_id, source_id, merged_at, rule) VALUES (?, ?, ?, ?)')
        .run('m1', 's1', '2026-10-13T00:01:00.000Z', 'intersection(minShared=2)'),
    /UNIQUE|PRIMARY/,
    '★ 同一对不许记两次（重复执行不灌水）',
  )
  opened.close?.()
})
