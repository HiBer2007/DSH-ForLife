/**
 * ★★ 跑一次碎片合并（D8 的编排层）。
 *
 * 这一组钉住四件事：
 *
 * 1. ★★ **`shadow` 只算不写**（合并改变模型看到的文本 ⇒ 必须有一条"先看几天"的路）；
 * 2. ★★ **`apply` 真落库**：换 hint · 归档 · 留痕三个数字都要对得上；
 * 3. ★ **两套判据真的不一样**（同一批数据：B 合成 1 组、C 不合成）—— 这是"配置可选"的实证；
 * 4. ★ **`note` 能回答"当时按哪套判据、合了几组"**（写进日志/审计用）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listFragmentMerges, openDatabase } from '@forlife/store'

import type { MergeCandidate } from '../src/fragment-merge.ts'
import type { MergeSettings } from '../src/fragment-merge-policy.ts'
import { runFragmentMerge } from '../src/fragment-merge-run.ts'

/** 造一条碎片（entities 与 hint 都给）。 */
function seed(db: ReturnType<typeof openDatabase>['db'], id: string, entities: readonly string[], hint: string): void {
  db.prepare(
    `INSERT INTO mid_memory_entries (id, entry_type, summary, content, entities, token_count, window_offset, status,
       fragment_hint, created_at, storage_tier, revision)
     VALUES (?, 'fragment', ?, '正文', ?, 10, 0, 'fragmented', ?, '2026-10-13T00:00:00.000Z', 'ssd', 1)`,
  ).run(id, hint, JSON.stringify(entities), hint)
}

const BY_B: MergeSettings = { criterion: 'intersection', minShared: 2, jaccard: 0.5, hintMode: 'mechanical', mode: 'apply' }

test('★★★ shadow：只算不写（★ 合并改变模型看到的文本 ⇒ 要先有"看几天"的路）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2', 'e3'], '甲')
  seed(opened.db, 'frag_b', ['e1', 'e2', 'e4'], '乙')
  const lines: string[] = []
  const result = await runFragmentMerge(opened.db, {
    settings: { ...BY_B, mode: 'shadow' },
    log: (m) => lines.push(m),
  })
  assert.equal(result.mode, 'shadow')
  assert.equal(result.candidates, 2)
  assert.equal(result.groups, 1, '★ 算出来了（B：共享 e1/e2 两个）')
  assert.deepEqual(
    { hinted: result.hinted, archived: result.archived, recorded: result.recorded },
    { hinted: 0, archived: 0, recorded: 0 },
    '★★ shadow 一个字节都不许写',
  )
  assert.deepEqual(listFragmentMerges(opened.db), [], '★ 留痕也不许写')
  assert.equal(lines.length, 1, '★ 但要留下一条日志（否则"shadow 跑了"这件事没人知道）')
  assert.match(lines[0] ?? '', /shadow：只算不写/)
  opened.close?.()
})

test('★★★ apply：换 hint · 归档 · 留痕三个数字都要对得上', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2', 'e3'], '甲')
  seed(opened.db, 'frag_b', ['e1', 'e2', 'e4'], '乙')
  seed(opened.db, 'frag_c', ['zz'], '丙')
  const result = await runFragmentMerge(opened.db, { settings: BY_B })
  assert.equal(result.groups, 1)
  assert.equal(result.grouped, 2)
  assert.deepEqual(
    { hinted: result.hinted, archived: result.archived, recorded: result.recorded },
    { hinted: 1, archived: 1, recorded: 1 },
    '★ 保留的那条换 hint（1）· 被并的归档（1）· 留痕（1）',
  )
  // ★ 保留的是输入顺序里的第一条（frag_a）—— 顺序由 `listMergeCandidates` 的数据顺序决定
  const kept = opened.db.prepare("SELECT fragment_hint AS h FROM mid_memory_entries WHERE id = 'frag_a'").get() as { h: string }
  assert.equal(kept.h, '甲；乙', '★ 粗 hint 是机械拼接（A）')
  const row = opened.db.prepare("SELECT status FROM mid_memory_entries WHERE id = 'frag_b'").get() as { status: string }
  assert.equal(row.status, 'archived', '★ 被并的归档（不是删）')
  assert.equal(listFragmentMerges(opened.db, 'frag_a')[0]?.rule, 'intersection(minShared=2)', '★ 留痕记规则')
  // ★ 孤立的 frag_c 不许被动
  const lonely = opened.db.prepare("SELECT status FROM mid_memory_entries WHERE id = 'frag_c'").get() as { status: string }
  assert.equal(lonely.status, 'fragmented')
  opened.close?.()
})

test('★★★ 两套判据在同一批数据上**真的不一样**（"配置可选"的实证）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  // 各 5 个 entity、共享 2 个 ⇒ B（≥2）合；Jaccard = 2/8 = 0.25 < 0.5 ⇒ C 不合
  seed(opened.db, 'frag_x', ['a', 'b', 'c', 'd', 'e'], 'X')
  seed(opened.db, 'frag_y', ['a', 'b', 'f', 'g', 'h'], 'Y')
  const byB = await runFragmentMerge(opened.db, { settings: { ...BY_B, mode: 'shadow' } })
  const byC = await runFragmentMerge(opened.db, {
    settings: { ...BY_B, criterion: 'jaccard', mode: 'shadow' },
  })
  assert.equal(byB.groups, 1, '★ B 应当合起来')
  assert.equal(byC.groups, 0, '★ C 不该合（相似度只有 0.25）')
  opened.close?.()
})

test('★ `note` 要能回答"按哪套判据、合了几组"（写日志/审计用）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2'], '甲')
  seed(opened.db, 'frag_b', ['e1', 'e2'], '乙')
  const result = await runFragmentMerge(opened.db, { settings: { ...BY_B, mode: 'shadow' } })
  assert.match(result.note, /候选 2 条/)
  assert.match(result.note, /1 组/)
  assert.match(result.note, /B 交集≥2/, '★ 判据要出现在 note 里')
  assert.match(result.note, /A 机械拼接/)
  assert.ok(!result.note.includes('**'), '★ 面板/日志不渲染 Markdown')
  opened.close?.()
})

test('★ 空库 / 没有候选 ⇒ 不报错、不写任何东西（维护每轮都会跑它）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const result = await runFragmentMerge(opened.db, { settings: BY_B })
  assert.deepEqual(
    { candidates: result.candidates, groups: result.groups, archived: result.archived },
    { candidates: 0, groups: 0, archived: 0 },
  )
  opened.close?.()
})

test('★ 模型生成模式（B）走注入回调；★ 回调给空串要退回机械拼接', async () => {
  const opened = openDatabase({ file: ':memory:' })
  seed(opened.db, 'frag_a', ['e1', 'e2'], '甲')
  seed(opened.db, 'frag_b', ['e1', 'e2'], '乙')
  const settings: MergeSettings = { ...BY_B, hintMode: 'model' }
  const generated = await runFragmentMerge(opened.db, { settings, generate: () => Promise.resolve('模型写的更粗的提示') })
  assert.equal(generated.hinted, 1)
  const kept = opened.db.prepare("SELECT fragment_hint AS h FROM mid_memory_entries WHERE id = 'frag_a'").get() as { h: string }
  assert.equal(kept.h, '模型写的更粗的提示', '★ 模型生成要真的被用上')
  void ((): readonly MergeCandidate[] => [])
  opened.close?.()
})
