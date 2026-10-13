/**
 * ★★ **D10**：碎片闸门的**两个口径**（`FIX_PLAN.md` §46）。
 *
 * ## 那件事
 *
 * `PLAN.MD` §5.3-2 说的「碎片索引**占中期记忆区** 15–20%」是 **token 口径**；
 * 而实现里的闸门是 **条数口径**（`fragmented / (fragmented + active)`）。
 * ★ 同一个词、两个口径，两者都拿去跟同一个 20% 比，但**到线的时间差着数倍**：
 *   条数口径约 **2,183 条**就到（真机 `f=400, a=10514`），token 口径要**上万条**。
 * ★ 而条数口径连的是**不可逆的真删**（`evictFragments` = `DELETE FROM`）。
 *
 * ## 本模块只做一件事：**把两个口径同时报出来**
 *
 * ⚠️ **判定仍然只看条数** —— 改判定 = 改行为，要先有用户裁定（账目 §46 明说"不 judge 哪个对"）。
 * 这里钉的就是这条边界：**报出来了，但没偷偷改判**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  shouldRunFragmentMaintenance,
  type FragmentThresholdPolicy,
} from '../src/fragment-threshold.ts'

/** 造一个库，塞 `fragmented` 条碎片 + `active` 条 active，每条 `tokens` 个 token。 */
function seeded(fragmented: number, active: number, tokens = 50): ReturnType<typeof openDatabase>['db'] {
  const opened = openDatabase({ file: ':memory:' })
  const insert = opened.db.prepare(
    `INSERT INTO mid_memory_entries (id, entry_type, content, summary, entities, token_count, window_offset, status, created_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  )
  for (let i = 0; i < fragmented; i += 1) {
    insert.run(`f${String(i)}`, 'fragment', null, `碎片 ${String(i)}`, tokens, i, 'fragmented', '2026-10-01T00:00:00.000Z')
  }
  for (let i = 0; i < active; i += 1) {
    insert.run(`a${String(i)}`, 'semantic', '正文', `条目 ${String(i)}`, tokens, fragmented + i, 'active', '2026-10-01T00:00:00.000Z')
  }
  return opened.db
}

const POLICY: FragmentThresholdPolicy = { ...DEFAULT_FRAGMENT_THRESHOLD, staleDays: 0 }

test('★★★ 两个口径**同时报出来**：条数口径与 token 口径各是多少', () => {
  // 400 碎片 + 10514 active（照真机那一组数），每条 50 token
  const db = seeded(400, 10_514, 50)
  const decision = shouldRunFragmentMaintenance(db, { ...POLICY, budgetTokens: 500_000 })
  assert.equal(decision.fragmented, 400)
  assert.equal(decision.active, 10_514)
  assert.ok(Math.abs(decision.ratio - 400 / 10_914) < 1e-9, '条数口径 = 400/10914 ≈ 3.7%')
  assert.equal(decision.fragmentTokens, 400 * 50, '碎片占的 token')
  assert.equal(decision.midTokens, 10_914 * 50, '中期区全部 token')
  // token 口径：20000 / 500000 = 4.0%
  assert.ok(Math.abs(decision.tokenRatio - 0.04) < 1e-9, `token 口径应当是 4.0%（实际 ${String(decision.tokenRatio)}）`)
  // ★ 两个口径**都要写在理由里**（否则面板/日志上只有一套数字，人会对不上账）
  assert.match(decision.reason, /碎片 400 条/, '条数要写')
  assert.match(decision.reason, /按 token 口径/, '★ 另一个口径也要写出来')
})

test('★★★ **判定没被偷偷改掉**：条数口径到线就动手（哪怕 token 口径还早）', () => {
  // 400 碎片 / 200 active ⇒ 条数口径 66.7% ≥ 20%；token 口径只有 20000/500000 = 4%
  const db = seeded(400, 200, 50)
  const decision = shouldRunFragmentMaintenance(db, { ...POLICY, budgetTokens: 500_000 })
  assert.equal(decision.shouldRun, true, '★ 判定仍然只看条数（这条钉的是"没偷偷改判"）')
  assert.ok(decision.tokenRatio < 0.2, `token 口径确实还没到线（${String(decision.tokenRatio)}）`)
  assert.match(decision.reason, /碎片占比/, '理由说的是条数口径')
})

test('★★ 不给预算 ⇒ 不算 token 口径（老调用方行为与文案都不变）', () => {
  const db = seeded(400, 10_514, 50)
  const decision = shouldRunFragmentMaintenance(db, POLICY)
  assert.equal(decision.tokenRatio, 0, '没给预算就是 0（不是"猜一个"）')
  assert.ok(
    !decision.reason.includes('按 token 口径'),
    `★ 不给预算时理由里不该冒出另一个口径（实际：${decision.reason}）`,
  )
})

test('★ 没有碎片 ⇒ 各口径都给 0，理由照旧', () => {
  const db = seeded(0, 10, 50)
  const decision = shouldRunFragmentMaintenance(db, { ...POLICY, budgetTokens: 500_000 })
  assert.equal(decision.shouldRun, false)
  assert.equal(decision.reason, '没有碎片')
  assert.equal(decision.fragmentTokens, 0)
  assert.equal(decision.tokenRatio, 0)
})

test('★★ 生产接线：`settle-loop.ts` 传的是**契约值** `memory.midBudgetTokens`', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../gateway/src/settle-loop.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(
    source,
    /budgetTokens: defaultFor<number>\('memory\.midBudgetTokens'\)/,
    '★★ 预算必须来自契约键（写死一个 500000 就等于又一次"那个键没人读"）',
  )
  assert.match(source, /shouldRunFragmentMaintenance\(options\.db, \{/, '★ 要真的把它传进判定（传了才算报出来）')
})
