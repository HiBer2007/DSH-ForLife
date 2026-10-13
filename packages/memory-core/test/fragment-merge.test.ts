/**
 * ★★ D8：碎片语义合并的**判据与分组**（`FIX_PLAN.md` §78.33 的裁定）。
 *
 * 用户 2026-10-13 裁定：① 重叠判据 **B（交集 ≥ N）与 C（Jaccard ≥ X）都实现**、配置时选，
 * 且 **C 的 X 要由测试标定**；② 粗 hint **A（机械）与 B（模型）都实现**、配置时选。
 *
 * ## 这一组测试要钉住的四件事
 *
 * 1. ★★ **两套判据的差别是真的**（同样的数据，B 合、C 不合 —— 反之亦然），
 *    否则"配置可选"就是摆设；
 * 2. ★★ **分组是传递闭包**（A~B、B~C ⇒ 三条同组）且**输出稳定**（可复现）；
 * 3. ★ **粗 hint 绝不空**（模型给了空串要退回机械拼接 —— hint 是碎片唯一进上下文的东西）；
 * 4. ★ **`rule` 记下判据与参数**（落库后能回答"这条是怎么合出来的"）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_MERGED_ENTITIES,
  groupFragments,
  jaccard,
  mechanicalHint,
  planFragmentMerges,
  sharesAtLeast,
  unionEntities,
  type MergeCandidate,
  type MergePolicy,
} from '../src/fragment-merge.ts'

/** 造一条碎片。 */
function frag(id: string, entities: readonly string[], hint = `hint-${id}`): MergeCandidate {
  return { id, entities, hint }
}

const BY_INTERSECTION: MergePolicy = { criterion: 'intersection', minShared: 2, jaccard: 0.5, hintMode: 'mechanical' }
const BY_JACCARD: MergePolicy = { criterion: 'jaccard', minShared: 2, jaccard: 0.5, hintMode: 'mechanical' }

test('★ B（交集 ≥ N）：`sharesAtLeast` 只数共享的个数，重复 entity 不算两次', () => {
  assert.equal(sharesAtLeast(['a', 'b'], ['b', 'c'], 2), false, '只共享 1 个 ⇒ 不算')
  assert.equal(sharesAtLeast(['a', 'b'], ['b', 'a'], 2), true)
  assert.equal(sharesAtLeast(['a', 'a', 'b'], ['a', 'b'], 2), true, '★ 重复项不许被数两次')
  assert.equal(sharesAtLeast(['a'], ['a'], 0), false, '★ minShared ≤ 0 = 不判（不是"全合"）')
})

test('★ C（Jaccard）：空集给 0（★ 不许给 1 —— 那会让"两条都没 entities"永远合并）', () => {
  assert.equal(jaccard([], []), 0)
  assert.equal(jaccard([], ['a']), 0)
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1)
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
})

test('★★★ 两套判据**真的不一样**：同一组数据，B 合、C 不合', () => {
  // 两条各 5 个 entity，共享 2 个 ⇒ B（≥2）合；Jaccard = 2/8 = 0.25 < 0.5 ⇒ C 不合
  const items = [frag('x', ['a', 'b', 'c', 'd', 'e']), frag('y', ['a', 'b', 'f', 'g', 'h'])]
  assert.equal(groupFragments(items, BY_INTERSECTION).length, 1, 'B 应当合起来')
  assert.equal(groupFragments(items, BY_JACCARD).length, 0, '★ C 不该合（相似度只有 0.25）')
})

test('★★ 分组是**传递闭包**（A~B、B~C ⇒ 三条同组），且输出稳定', () => {
  // a~b 共享 2 个；b~c 共享 2 个；a~c 一个都不共享 ⇒ 传递闭包仍应把它们放一组
  const items = [frag('a', ['e1', 'e2']), frag('b', ['e1', 'e2', 'e3', 'e4']), frag('c', ['e3', 'e4'])]
  const groups = groupFragments(items, BY_INTERSECTION)
  assert.equal(groups.length, 1, '应当是一组（传递闭包）')
  assert.deepEqual(groups[0], ['a', 'b', 'c'], '★ 成员按输入顺序（稳定、可复现）')
  // 再跑一遍必须一样
  assert.deepEqual(groupFragments(items, BY_INTERSECTION), groups)
})

test('★ 孤立的碎片不进组（`untouched` 里能看到它们）', async () => {
  const items = [frag('a', ['e1', 'e2']), frag('b', ['e1', 'e2']), frag('lonely', ['zz'])]
  const plan = await planFragmentMerges(items, BY_INTERSECTION)
  assert.deepEqual(plan.groups.map((g) => g.sourceIds), [['a', 'b']])
  assert.deepEqual(plan.untouched, ['lonely'])
})

test('★★ 粗 hint（A 机械拼接）：按条边界截断，★ 绝不产出空 hint', () => {
  const items = [frag('a', ['e1'], '第一段的提示'), frag('b', ['e2'], '第二段的提示')]
  assert.equal(mechanicalHint(items), '第一段的提示；第二段的提示', '不截断时全拼')
  // ★ 只放得下第一条 ⇒ 给第一条 + "另有 N 条"
  const tight = mechanicalHint(items, 8, (text) => text.length)
  assert.match(tight, /第一段的提示/, '★ 至少要留下第一条（不许空）')
  assert.match(tight, /另有 1 条同类碎片/, '要标出"还有几条"')
  // ★ 连第一条都放不下 ⇒ 仍然给第一条（空 hint 比超一点更糟）
  assert.equal(mechanicalHint(items, 2, (text) => text.length), '第一段的提示')
})

test('★★ 模型生成（B）走注入回调；★ 回调给空串要退回机械拼接', async () => {
  const items = [frag('a', ['e1', 'e2'], '甲'), frag('b', ['e1', 'e2'], '乙')]
  const policy: MergePolicy = { ...BY_INTERSECTION, hintMode: 'model' }
  const generated = await planFragmentMerges(items, policy, { generate: () => Promise.resolve('模型写的更粗的提示') })
  assert.equal(generated.groups[0]?.hint, '模型写的更粗的提示')
  const empty = await planFragmentMerges(items, policy, { generate: () => Promise.resolve('   ') })
  assert.equal(empty.groups[0]?.hint, '甲；乙', '★ 模型给空串 ⇒ 退回机械拼接（hint 绝不能空）')
  // 没给回调时也不许崩：退回机械
  const noCallback = await planFragmentMerges(items, policy)
  assert.equal(noCallback.groups[0]?.hint, '甲；乙')
})

test('★ entities 并集：去重、保序、★ 上限 5（与单条限制同口径）', () => {
  const items = [frag('a', ['e1', 'e2', 'e3']), frag('b', ['e2', 'e4', 'e5', 'e6'])]
  const union = unionEntities(items)
  assert.deepEqual(union, ['e1', 'e2', 'e3', 'e4', 'e5'], '★ 上限 5 个，超出截断')
  assert.equal(union.length, MAX_MERGED_ENTITIES)
})

test('★★ `rule` 要记下判据与参数（落库后能回答"这条是怎么合的"）', async () => {
  const items = [frag('a', ['e1', 'e2']), frag('b', ['e1', 'e2'])]
  const byB = await planFragmentMerges(items, BY_INTERSECTION)
  assert.equal(byB.groups[0]?.rule, 'intersection(minShared=2)')
  const byC = await planFragmentMerges(items, { ...BY_JACCARD, jaccard: 0.5 })
  assert.equal(byC.groups[0]?.rule, 'jaccard(>=0.5)', '★ C 也要把阈值记下来')
})
