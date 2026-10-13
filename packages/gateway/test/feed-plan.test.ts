/**
 * 投喂排产的测试（用户 2026-10-10：**以单个轮次为界** + **断点续传**）。
 *
 * 排产是纯函数，所以这里能把"重喂"和"漏喂"的**所有边界**都钉住 ——
 * 而那些边界正是这套东西唯一会出错的地方：
 *
 * 1. **游标落在批中间**（上一轮被 30 分钟上限截断）⇒ 下一轮必须从游标之后接着喂，
 *    **不许从"第 N 个整批"重算** —— 否则重喂已喂过的那半批
 * 2. **最后一批不满** ⇒ `to` 必须夹在 `total` 上，不许越界
 * 3. **游标比总数大**（素材变短）⇒ 夹住，不许出现"待喂 −20 段"
 * 4. **坏的 `perTurn`**（0 / 负数）⇒ 夹到 ≥1，且 `pendingFeedTurns` **不许死循环**
 * 5. **已喂完** ⇒ `next` 是 `undefined`（不是"第 284–283 段"那种荒唐区间）
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeFeedPlan, nextFeedTurn, pendingFeedTurns } from '../src/feed-plan.ts'

test('★ 从零开始：第一轮就是第 1–perTurn 段', () => {
  const plan = nextFeedTurn({ total: 283, perTurn: 50 })
  assert.deepEqual(plan.next, { from: 1, to: 50, count: 50 })
  assert.equal(plan.fed, 0)
  assert.equal(plan.pending, 283)
  assert.equal(plan.done, false)
})

test('★★ 游标落在**批中间**（被 30 分钟截断）⇒ 从游标之后接着喂，不许重算整批', () => {
  // 上一轮本该喂 1–50，但第 23 段时被中止 ⇒ 游标停在 23
  const plan = nextFeedTurn({ total: 283, fedThrough: 23, perTurn: 50 })
  assert.equal(plan.next?.from, 24, '★ 必须从 24 开始 —— 从 51 开始会**漏喂** 24–50')
  assert.equal(plan.next?.to, 73)
  assert.equal(plan.next?.count, 50)
  assert.equal(plan.pending, 260)

  // 反面：若有人写成"按整批对齐"，from 会变成 51 —— 那条就漏了 27 段
  assert.notEqual(plan.next?.from, 51, '不许按整批对齐（那会漏喂）')
})

test('★ 最后一批不满：`to` 夹在 total 上，不许越界', () => {
  const plan = nextFeedTurn({ total: 283, fedThrough: 250, perTurn: 50 })
  assert.deepEqual(plan.next, { from: 251, to: 283, count: 33 })
  assert.equal(plan.pending, 33)
})

test('★★ 游标越界 / 坏值：夹住，不许算出荒唐区间', () => {
  // 素材变短了（283 → 100），游标还停在 283
  const shrunk = nextFeedTurn({ total: 100, fedThrough: 283, perTurn: 50 })
  assert.equal(shrunk.done, true)
  assert.equal(shrunk.pending, 0, '待喂不许是负数')
  assert.equal(shrunk.next, undefined, '不许出现"第 284–283 段"那种区间')

  // 游标是坏的（负数）
  assert.equal(nextFeedTurn({ total: 10, fedThrough: -5, perTurn: 3 }).next?.from, 1)

  // 总数为 0 / 负数
  assert.equal(nextFeedTurn({ total: 0, perTurn: 50 }).done, true)
  assert.equal(nextFeedTurn({ total: -3, perTurn: 50 }).done, true)
})

test('★★ 坏的 `perTurn`：夹到 ≥1，且 `pendingFeedTurns` **不许死循环**', () => {
  // perTurn = 0 / 负数 ⇒ 夹到 1（否则 next.from 会等于 fed+1 而 to 也等于它，
  // 每轮只前进 1 段 —— 那不算错，但如果谁写成"to = fed"就会**永远原地踏步**）
  const zero = nextFeedTurn({ total: 5, perTurn: 0 })
  assert.equal(zero.next?.count, 1, 'perTurn=0 必须被夹到 1')

  const negative = nextFeedTurn({ total: 5, perTurn: -100 })
  assert.equal(negative.next?.count, 1)

  // ★ 即使 perTurn 是坏的，列待喂也必须**有限**（展示用的函数把界面卡死最没道理）
  const list = pendingFeedTurns({ total: 10, perTurn: 0, limit: 20 })
  assert.equal(list.length, 10, '每轮 1 段、共 10 段 ⇒ 正好 10 项')
  assert.deepEqual(
    list.map((range) => range.from),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    '不许漏段、不许原地踏步',
  )
  // 上限也要真的生效
  assert.equal(pendingFeedTurns({ total: 1000, perTurn: 1, limit: 5 }).length, 5)
})

test('★★ 分批不重不漏：把 283 段按每轮 50 段排完，覆盖必须**恰好**是 1..283', () => {
  const turns = pendingFeedTurns({ total: 283, perTurn: 50 })
  assert.equal(turns.length, 6, '283/50 ⇒ 6 轮（前 5 轮各 50，最后一轮 33）')
  // 逐段展开，检查覆盖
  const covered: number[] = []
  for (const range of turns) {
    for (let i = range.from; i <= range.to; i += 1) covered.push(i)
  }
  assert.deepEqual(
    covered,
    Array.from({ length: 283 }, (_, i) => i + 1),
    '★ 分批必须**不重不漏** —— 这是整套断点续传的地基性质',
  )
})

test('★ 已喂完：`next` 是 undefined，且进度话术说"全部完成"', () => {
  const plan = nextFeedTurn({ total: 283, fedThrough: 283, perTurn: 50 })
  assert.equal(plan.done, true)
  assert.equal(plan.next, undefined)
  assert.ok(describeFeedPlan(plan).includes('全部完成'), describeFeedPlan(plan))
  assert.deepEqual(pendingFeedTurns({ total: 283, fedThrough: 283, perTurn: 50 }), [])
})

test('★ 进度话术三处口径一致（面板 / 日志 / 提示词共用同一份）', () => {
  const line = describeFeedPlan(nextFeedTurn({ total: 283, fedThrough: 100, perTurn: 50 }))
  for (const piece of ['100', '283', '101', '150', '183']) {
    assert.ok(line.includes(piece), `进度话术里应当有「${piece}」：${line}`)
  }
})
