/**
 * ★★ D8 渲染层：**只出粗 hint**（`FIX_PLAN.md` §78.59）。
 *
 * ## ★ 结论先写：这一层**不需要改代码**，但必须**被测试钉住**
 *
 * `repository.ts:259` 的 `listRenderableMidEntries()` 定义是
 * `status IN ('active','fragmented')` ⇒ ★ **`archived` 本来就不参与渲染**。
 * 而合并做的事正好是：保留项换成粗 hint、被并的标 `archived`。
 * ⇒ ★★ 两者**天然对接**："渲染只出粗 hint"是**由构造保证的**，不是靠新写的过滤。
 *
 * ★ 那为什么还要这一组测试：**"碰巧对"和"保证对"是两回事** ——
 *   哪天有人把渲染视图改成 `status != 'deleted'`，合并的语义就**静默失效**了
 *   （被并的碎片会**重新出现在上下文里**，而模型看到的文本就变了）。
 *   这正是本仓最该防的那类"沉默的失效"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { listRenderableMidEntries, openDatabase } from '@forlife/store'

import { renderMidMemory } from '../src/render.ts'
import type { MergeSettings } from '../src/fragment-merge-policy.ts'
import { runFragmentMerge } from '../src/fragment-merge-run.ts'

/** 造一条碎片。 */
function seed(db: ReturnType<typeof openDatabase>['db'], id: string, entities: readonly string[], hint: string): void {
  db.prepare(
    `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status,
       fragment_hint, created_at, storage_tier, revision)
     VALUES (?, 'fragment', ?, '正文', ?, 10, 0, 'fragmented', ?, '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
  ).run(id, hint, JSON.stringify(entities), hint)
}

const BY_B: MergeSettings = { criterion: 'intersection', minShared: 2, jaccard: 0.5, hintMode: 'mechanical', mode: 'apply' }

test('★★★ 渲染视图的定义里**必须排除 `archived`**（★ 合并的语义就架在这条上）', () => {
  const source = readFileSync(new URL('../../store/src/repository.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /WHERE status IN \('active','fragmented'\)/,
    '★★ 渲染视图只含 active + fragmented —— ★ 改成别的写法（例如 status != deleted）会让"被并的碎片"重新进上下文',
  )
  const opened = openDatabase({ file: ':memory:' })
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status, created_at, storage_tier, revision)
       VALUES ('mid_arch', 'fragment', '归档的', '正文', '[]', 10, 0, 'archived', '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
    )
    .run()
  assert.deepEqual(
    listRenderableMidEntries(opened.db).map((r) => r.id),
    [],
    '★ archived 不进渲染（行为级也要验，不能只看源码字符串）',
  )
  opened.close?.()
})

test('★★★ 合并之后渲染出来的**只有粗 hint**（被并的碎片不再单独出现）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2', 'e3'], '甲的提示')
  seed(opened.db, 'frag_b', ['e1', 'e2', 'e4'], '乙的提示')
  const before = renderMidMemory(listRenderableMidEntries(opened.db), { countTokens: (text: string) => text.length })
  assert.match(before.text, /甲的提示/)
  assert.match(before.text, /乙的提示/, '合并前：两条都在（前提成立）')

  const run = await runFragmentMerge(opened.db, { settings: BY_B })
  assert.equal(run.archived, 1, '前提：合并真的归档了一条')

  const after = renderMidMemory(listRenderableMidEntries(opened.db), { countTokens: (text: string) => text.length })
  assert.match(after.text, /甲的提示；乙的提示/, '★ 保留项渲染的是**粗 hint**（机械拼接）')
  // ★ 判据是「碎片**行数**」而不是「文本里有没有那个词」：
  //   粗 hint 里当然含「乙的提示」（它就是拼接来的）—— 我第一版写成
  //   `!includes('乙的提示（')`，必然失败（粗 hint 尾巴 + 渲染后缀正好拼出它）。
  assert.equal(
    (after.text.match(/\[F\d+→\]/g) ?? []).length,
    1,
    '★ 只该有 1 行碎片（被并的已 archived ⇒ 不再单独出现）',
  )
  // ★ 粗 hint 只出现一次（不是"粗 hint + 原来那条"两份）
  assert.equal((after.text.match(/甲的提示/g) ?? []).length, 1, '★ 粗 hint 不许重复出现')
  opened.close?.()
})

test('★★ `shadow` 模式下渲染**什么都不变**（只算不写 ⇒ 上下文不该动）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2'], '甲的提示')
  seed(opened.db, 'frag_b', ['e1', 'e2'], '乙的提示')
  const before = renderMidMemory(listRenderableMidEntries(opened.db), { countTokens: (text: string) => text.length }).text
  await runFragmentMerge(opened.db, { settings: { ...BY_B, mode: 'shadow' } })
  const after = renderMidMemory(listRenderableMidEntries(opened.db), { countTokens: (text: string) => text.length }).text
  assert.equal(after, before, '★ shadow 模式下模型看到的东西必须一字不变')
  opened.close?.()
})
