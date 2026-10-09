/**
 * 中期**窗口**选取的单元测试（纯函数，不需要数据库）。
 *
 * 这一组用例钉的是 PLAN §1.2 那半句「上下文窗口中的**稳定前缀**」：
 * 窗口有 token 预算、丢失的是**旧的**、输出顺序不重排（前缀才逐字节稳定）。
 *
 * ⚠️ 其中有一条专门钉**排序键**（`epoch` 分桶那个坑）：`window_offset` 是按 epoch
 * 分桶的，压缩后新条目从 0 重新开始 —— 只按 `window_offset` 从大到小取，
 * 会把"压缩刚 push 的、最新的"记忆判成最旧丢出去。见 `window.ts` 模块头。
 *
 * ⚠️ 2026-10-09 起窗口有**两个**预算（`maxTokens` + `maxCount`），
 * 本文件后半段那三条专门钉"两个约束各自生效、并且能分辨是谁在生效"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MidEntryRow } from '@forlife/store'
import { defaultFor } from '@forlife/contracts'
import { selectMidWindow } from '../src/window.ts'

/**
 * 条数上限的"够不着"取值 —— 只考 token 预算的用例用它。
 *
 * 刻意写成一个具名常量而不是到处写 `100_000`：它表达的是"这条用例不考条数"，
 * 而不是"条数上限是 10 万"（真值是基线 `memory.midWindow.maxCount`，这里不重复它）。
 */
const NO_COUNT_LIMIT = 100_000

/** 造一行中期条目（只填选取关心的字段；token_count 显式给，方便构造预算边界）。 */
function row(partial: Partial<MidEntryRow> & { id: string }): MidEntryRow {
  return {
    entry_type: 'semantic',
    content: null,
    summary: `条目 ${partial.id}`,
    entities: '[]',
    token_count: 10,
    window_offset: 0,
    status: 'active',
    fragmented_into: null,
    fragment_hint: null,
    compaction_epoch: 0,
    source_short_ids: '[]',
    created_at: '2026-10-05T00:00:00.000Z',
    last_accessed_at: null,
    storage_tier: 'ssd',
    revision: 1,
    source_scope: null,
    ...partial,
  }
}

/** 一条 40k token 的条目（用于构造"预算装不下三条"的场景）。 */
function big(id: string, offset: number, epoch = 0): MidEntryRow {
  return row({ id, window_offset: offset, compaction_epoch: epoch, token_count: 40_000 })
}

test('★ token 预算生效：装不下就停，且丢的是**最旧**的', () => {
  const a = big('a', 0) // 最旧
  const b = big('b', 1)
  const c = big('c', 2) // 最新
  const result = selectMidWindow([a, b, c], { maxTokens: 100_000, maxCount: NO_COUNT_LIMIT })

  assert.deepEqual(result.entries.map((e) => e.id), ['b', 'c'], '100k 装不下 3×40k ⇒ 留最新两条')
  assert.equal(result.tokens, 80_000)
  assert.equal(result.droppedCount, 1)
  assert.equal(result.droppedTokens, 40_000)
  assert.equal(result.droppedByCount, 0, 'token 预算生效时，条数账必须是 0（否则面板会误报"条数爆炸"）')
})

test('★ 取的是最新、不是最旧（反过来取会立刻被这条抓住）', () => {
  const rows = [0, 1, 2, 3, 4].map((i) => row({ id: `m${String(i)}`, window_offset: i, token_count: 20_000 }))
  const result = selectMidWindow(rows, { maxTokens: 60_000, maxCount: NO_COUNT_LIMIT })

  assert.deepEqual(result.entries.map((e) => e.id), ['m2', 'm3', 'm4'], '只留最新的三条（m0/m1 出窗口）')
})

test('★ 输出**保持输入顺序**（不重排）—— 新条目只能追加在尾部，前缀才逐字节稳定', () => {
  const rows = [0, 1, 2, 3].map((i) => row({ id: `m${String(i)}`, window_offset: i, token_count: 30_000 }))
  const result = selectMidWindow(rows, { maxTokens: 60_000, maxCount: NO_COUNT_LIMIT })

  // 选取是"从后往前"做的，但输出必须是输入序的子序列（否则每次 append 都改写整个前缀）
  assert.deepEqual(result.entries.map((e) => e.id), ['m2', 'm3'], '选取从新往旧、输出仍按原顺序')
  const positions = result.entries.map((e) => rows.indexOf(e))
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y), '输出下标必须单调递增')
})

test('★ epoch 分桶的坑：压缩后新条目 offset 从 0 重来，**不能**按 offset 判新旧', () => {
  // epoch 0 的老条目（offset 很大，是压缩前写的）
  const old = [0, 1].map((i) => row({ id: `old${String(i)}`, window_offset: 100 + i, compaction_epoch: 0, token_count: 40_000 }))
  // epoch 1 的新条目（压缩后写的：offset 从 0 重新开始）
  const fresh = [0, 1].map((i) => row({ id: `new${String(i)}`, window_offset: i, compaction_epoch: 1, token_count: 40_000 }))

  // 输入顺序按 SQL 的 window_offset ASC：新条目（offset 0/1）反而排在前面
  const result = selectMidWindow([...fresh, ...old], { maxTokens: 80_000, maxCount: NO_COUNT_LIMIT })

  assert.deepEqual(
    result.entries.map((e) => e.id),
    ['new0', 'new1'],
    '只按 window_offset 从大到小取会留下 old0/old1（把刚压缩出来的记忆丢掉）—— 那是本用例要拦的错',
  )
})

test('★ 边界：空表 / 恰好等于上限 / 差 1 token', () => {
  assert.deepEqual(selectMidWindow([], { maxTokens: 100_000, maxCount: NO_COUNT_LIMIT }), {
    entries: [],
    droppedCount: 0,
    droppedTokens: 0,
    tokens: 0,
    droppedByCount: 0,
  })

  const exact = [big('a', 0), big('b', 1), big('c', 2)]
  const keptAll = selectMidWindow(exact, { maxTokens: 120_000, maxCount: NO_COUNT_LIMIT })
  assert.deepEqual(keptAll.entries.map((e) => e.id), ['a', 'b', 'c'], '恰好等于上限 ⇒ 全部保留（判据是"超过"才停）')
  assert.equal(keptAll.droppedCount, 0)

  const oneLess = selectMidWindow(exact, { maxTokens: 119_999, maxCount: NO_COUNT_LIMIT })
  assert.deepEqual(oneLess.entries.map((e) => e.id), ['b', 'c'], '差 1 token 就装不下最旧的那条')
  assert.equal(oneLess.droppedCount, 1)
  assert.equal(oneLess.droppedTokens, 40_000)
})

test('★ 边界：单条自身超预算 ⇒ 空窗口（刻意不"至少留一条"）', () => {
  const result = selectMidWindow([row({ id: 'huge', token_count: 150_000 })], { maxTokens: 100_000, maxCount: NO_COUNT_LIMIT })
  assert.deepEqual(result.entries, [], '单条无界条目不该把窗口炸掉：那是写入方该拦的（PLAN §5.3 四层长度限制）')
  assert.equal(result.droppedCount, 1)
  assert.equal(result.droppedTokens, 150_000)
})

test('★ 预算不可用（0 / 负数 / NaN）⇒ 空窗口，**不退化成全表**', () => {
  const rows = [row({ id: 'a', window_offset: 0 }), row({ id: 'b', window_offset: 1 })]
  for (const maxTokens of [0, -1, Number.NaN]) {
    const result = selectMidWindow(rows, { maxTokens, maxCount: NO_COUNT_LIMIT })
    assert.deepEqual(result.entries, [], `预算 ${String(maxTokens)} 时必须给空窗口 —— 退回全表正是这次要修的故障形态`)
    assert.equal(result.droppedCount, 2)
    assert.equal(result.droppedByCount, 0, '是 token 预算不可用（不是条数）—— 账要记对')
  }
})

test('★ 纯函数：不改输入数组、不改行对象、两次调用结果一致', () => {
  const rows = [0, 1, 2].map((i) => row({ id: `m${String(i)}`, window_offset: i, token_count: 40_000 }))
  const snapshot = [...rows]
  const first = selectMidWindow(rows, { maxTokens: 80_000, maxCount: NO_COUNT_LIMIT })
  const second = selectMidWindow(rows, { maxTokens: 80_000, maxCount: NO_COUNT_LIMIT })

  assert.deepEqual(rows, snapshot, '输入数组（顺序、内容）不能被改 —— 它可能是调用方持有的一份缓存')
  assert.deepEqual(first.entries.map((e) => e.id), second.entries.map((e) => e.id), '同样的输入必须给同样的输出')
  assert.equal(first.entries[0] === rows[1], true, '返回的是原行对象（渲染直接读它，不做拷贝）')
})

test('★ 碎片（fragment）与 active 用同一套 token 记账，不另开预算', () => {
  // 老碎片只占 80 token，但新 active 条目正好用满预算 ⇒ 碎片那 80 也必须算进去
  const rows = [
    row({ id: 'f0', window_offset: 0, entry_type: 'fragment', fragment_hint: '某条已沉降', token_count: 80 }),
    row({ id: 'm1', window_offset: 1, token_count: 60_000 }),
  ]
  const result = selectMidWindow(rows, { maxTokens: 60_000, maxCount: NO_COUNT_LIMIT })
  assert.deepEqual(result.entries.map((e) => e.id), ['m1'], '碎片若被豁免，f0 会被硬塞进来（§5.3 的 15-20% 是**全表**占比，不是这里的窗口预算）')
  assert.equal(result.droppedTokens, 80, '碎片那 80 token 必须计进预算账')
})

test('★ 记账：tokens / droppedTokens 之和 = 全部条目的 token 之和', () => {
  const rows = [0, 1, 2, 3, 4].map((i) => row({ id: `m${String(i)}`, window_offset: i, token_count: 7_777 }))
  const result = selectMidWindow(rows, { maxTokens: 20_000, maxCount: NO_COUNT_LIMIT })
  const total = rows.reduce((sum, e) => sum + e.token_count, 0)
  assert.equal(result.tokens + result.droppedTokens, total, '窗口内 + 窗口外的 token 必须等于总数（账要平）')
})

// ════════════════════════════════════════════════════════════════════════════
// ★ 条数上限（2026-10-09 加）：token 记账对**超短条目**不设防
//
// 每条 1 token 的话，10 万条也才 10 万 token —— token 预算一分没超，
// 渲染出来却是 10 万行，行标记本身就把前缀撑爆。所以要一道条数闸，
// 而且必须能**分辨**是哪个约束在生效（面板要看得懂"丢了很多条"是什么意思）。
// ════════════════════════════════════════════════════════════════════════════

test('★★ 条数上限生效：条数到顶就停，丢的同样是**最旧**的', () => {
  // 每条只 1 token：token 预算（100k）远远装得下，能拦住它的只有条数上限
  const rows = [0, 1, 2, 3, 4].map((i) => row({ id: `t${String(i)}`, window_offset: i, token_count: 1 }))
  const result = selectMidWindow(rows, { maxTokens: 100_000, maxCount: 3 })

  assert.deepEqual(result.entries.map((e) => e.id), ['t2', 't3', 't4'], '条数到顶 ⇒ 只留最新 3 条')
  assert.equal(result.tokens, 3, 'token 账只有 3（远没到 100k）—— 正说明这次拦人的不是 token 预算')
  assert.equal(result.droppedCount, 2)
  assert.equal(result.droppedTokens, 2)
  assert.equal(result.droppedByCount, 2, '这 2 条是**条数**上限丢的，必须记在条数账上')
})

test('★★ 两个约束各自生效：谁先到就按谁停，而且能分辨是谁', () => {
  const rows = [0, 1, 2, 3].map((i) => row({ id: `m${String(i)}`, window_offset: i, token_count: 40_000 }))

  // ① token 先到：40k×2 = 80k，第三条会超 100k ⇒ 留 2 条，账记在 token 上
  const byTokens = selectMidWindow(rows, { maxTokens: 100_000, maxCount: 10 })
  assert.deepEqual(byTokens.entries.map((e) => e.id), ['m2', 'm3'])
  assert.equal(byTokens.droppedByCount, 0, 'token 预算先生效时 droppedByCount 必须是 0')

  // ② 条数先到：同样的 4 条，条数上限 2 ⇒ 也只留 2 条，但账记在条数上
  const byCount = selectMidWindow(rows, { maxTokens: 100_000, maxCount: 2 })
  assert.deepEqual(
    byCount.entries.map((e) => e.id),
    ['m2', 'm3'],
    '两个约束在"留哪几条"上必须一致（都是最新优先）—— 不同的只是**为什么停**',
  )
  assert.equal(byCount.droppedByCount, 2, '这次是条数上限在管')
  assert.equal(byCount.droppedTokens, 80_000)
  assert.equal(byCount.droppedCount, 2)
})

test('★ 条数上限不可用（0 / 负数 / NaN）⇒ 空窗口，与 token 预算同一条纪律', () => {
  const rows = [row({ id: 'a', window_offset: 0 }), row({ id: 'b', window_offset: 1 })]
  for (const maxCount of [0, -1, Number.NaN]) {
    const result = selectMidWindow(rows, { maxTokens: 100_000, maxCount })
    assert.deepEqual(result.entries, [], `条数上限 ${String(maxCount)} 时必须给空窗口 —— 配置坏了不退回全表`)
    assert.equal(result.droppedCount, 2)
    assert.equal(result.droppedByCount, 2, '是条数上限把窗口清空的 ⇒ 账要记在条数上（面板才看得出原因）')
  }
})

test('★ 边界：恰好等于条数上限 ⇒ 全留；差 1 条 ⇒ 最旧的出窗口', () => {
  const rows = [0, 1, 2].map((i) => row({ id: `e${String(i)}`, window_offset: i, token_count: 10 }))

  const exact = selectMidWindow(rows, { maxTokens: NO_COUNT_LIMIT, maxCount: 3 })
  assert.equal(exact.entries.length, 3, '恰好等于条数上限 ⇒ 全部保留（判据是"已达上限"才停）')
  assert.equal(exact.droppedByCount, 0)
  assert.equal(exact.droppedCount, 0)

  const oneLess = selectMidWindow(rows, { maxTokens: NO_COUNT_LIMIT, maxCount: 2 })
  assert.deepEqual(oneLess.entries.map((e) => e.id), ['e1', 'e2'], '差 1 条就装不下最旧的那条')
  assert.equal(oneLess.droppedByCount, 1)
})

test('★ 基线真值兜底：`memory.midWindow.maxCount` 本身必须是能用的正整数', () => {
  // 这条守的不是算法（上面几条已经守了），而是**基线里那个数**：
  // 谁把它改成 0 / 负数 / 非整数，窗口会被整体清空（见"预算不可用 ⇒ 空窗口"那条纪律），
  // 而那时所有纯函数用例仍然全绿 —— 只有这条会红。
  const maxCount = defaultFor<number>('memory.midWindow.maxCount')
  const maxTokens = defaultFor<number>('memory.midWindow.maxTokens')
  assert.ok(Number.isInteger(maxCount) && maxCount > 0, `基线 maxCount 必须是正整数，实际 ${String(maxCount)}`)
  assert.ok(Number.isInteger(maxTokens) && maxTokens > 0, `基线 maxTokens 必须是正整数，实际 ${String(maxTokens)}`)

  // 用**基线真值**跑一遍：多一条都不给（这正是"防呆"两个字的含义）
  const rows = Array.from({ length: maxCount + 1 }, (_, i) =>
    row({ id: `b${String(i)}`, window_offset: i, token_count: 1 }),
  )
  const result = selectMidWindow(rows, { maxTokens, maxCount })
  assert.equal(result.entries.length, maxCount, '基线真值下条数上限必须真的截断')
  assert.equal(result.droppedByCount, 1, '超出的那 1 条要记在**条数**账上（token 才用了 maxCount 个，远没到预算）')
})
