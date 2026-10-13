/**
 * ★★ 分区预算检查（`FIX_PLAN.md` §76.5⑦ / `PLAN.MD` 附录 A.4 的最后一个 ❌）。
 *
 * ## 为什么需要
 *
 * `PLAN.MD` 附录 A.1 给四层定了上限（L2 ≤ 10% / L3 ≤ 50% / L4 ≤ 10%），
 * 而 §A.4 的"PLAN vs 实现"对照表里有三条 ❌：L3 渲染窗口偏小、**L4 没有任何键在管它**、
 * **L2 没有任何键在管它**。★ 前两条 2026-10-11 已补，**L2 一直缺** ⇒
 * "L2 手册涨到 30 万 token"**没有任何人会知道**。
 *
 * ## 钉三件事
 *
 * 1. ★★ **跨线只喊一次**（边沿检测）—— 超了会一直超，每轮都喊会把日志库灌满；
 * 2. ★★ **只量不截断** —— §A.1 明说"上限是**最大值**不是目标值 ⇒ 没到上限就不该动它"，
 *    而截断会改变模型看到的东西（那是产品决策，不是守卫该做的事）；
 * 3. ★ **预算 ≤ 0 视为"没在管"**，不许把"没配"当成"超了"（那是误报）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { estimateTokens } from '@forlife/memory-core'

import { BUDGET_LOG_MODULE, createBudgetCheck } from '../src/budget-check.ts'

/** 造一段刚好 `tokens` 个 token 的文本（用 CJK：1 字 = 1 token，好算）。 */
function textOfTokens(tokens: number): string {
  return '字'.repeat(tokens)
}

test('★★★ 超预算 ⇒ 喊一次；再检查**不许重复**（边沿检测，否则每轮都灌一条）', () => {
  const lines: string[] = []
  const check = createBudgetCheck({ budgetTokens: 100, warn: (m) => lines.push(m), label: 'L2' })
  const first = check.check(textOfTokens(150))
  // ★ 第一次检查会先记一条**基线**（'它活着'的凭据 + 量出来的数字）
  assert.equal(lines.length, 2, '第一次 = 基线 + 超预算（基线在前）')
  assert.match(lines[0] ?? '', /预算基线/)
  assert.equal(first.over, true)
  assert.equal(first.warned, true, '第一次跨线要喊')
  assert.equal(lines.length, 2, '基线 + 超预算各一条')
  assert.match(lines[1] ?? '', /超预算/, '要说清超了')
  assert.match(lines[1] ?? '', /150 token > 100/, '★ 要把**实际值**与**预算**都写出来')
  assert.match(lines[1] ?? '', /最大值不是目标值/, '★ 要把"上限不是目标值"这条纪律带上（否则人会去乱改）')
  assert.match(lines[1] ?? '', /先问用户/, '★ 要指出改产品行为要先问用户')

  // 还是超着 ⇒ 不许再喊
  assert.equal(check.check(textOfTokens(200)).warned, false)
  assert.equal(check.check(textOfTokens(120)).warned, false)
  assert.equal(lines.filter((l) => l.includes('超预算')).length, 1, '★ 超着的时候只喊一次（基线那条不算）')
})

test('★★ 回到预算内 ⇒ 喊一次"恢复了"（不然人以为它一直超着）', () => {
  const warns: string[] = []
  const notes: string[] = []
  const check = createBudgetCheck({
    budgetTokens: 100,
    warn: (m) => warns.push(m),
    note: (m) => notes.push(m),
    label: 'L2',
  })
  check.check(textOfTokens(150))
  const back = check.check(textOfTokens(80))
  assert.equal(back.over, false)
  assert.equal(back.warned, true, '恢复也要说一声')
  assert.equal(notes.length, 2, '基线一条 + 恢复一条')
  assert.match(notes[1] ?? '', /回到预算内/)
  assert.equal(check.over(), false, '★ 状态要复位（否则下次真超了不会再喊）')
  // 再超 ⇒ 要能再喊（复位真的生效）
  assert.equal(check.check(textOfTokens(150)).warned, true, '★★ 复位之后下一次跨线必须还能喊')
  assert.equal(warns.length, 2)
})

test('★ 没超 ⇒ 什么都不说（安静是默认）', () => {
  const lines: string[] = []
  const check = createBudgetCheck({ budgetTokens: 100, warn: (m) => lines.push(m) })
  const result = check.check(textOfTokens(99))
  assert.equal(result.over, false)
  assert.equal(result.warned, false)
  assert.deepEqual(lines.filter((l) => l.includes('超预算')), [], '没超 ⇒ 不该有超预算告警（基线那条不算）')
})

test('★★ 预算 ≤ 0 = "没在管"，**不许**把"没配"当成"超了"', () => {
  const lines: string[] = []
  const check = createBudgetCheck({ budgetTokens: 0, warn: (m) => lines.push(m) })
  const result = check.check(textOfTokens(10_000))
  assert.equal(result.over, false, '★ 没配预算 ≠ 超预算（那是误报）')
  assert.deepEqual(lines.filter((l) => l.includes('超预算')), [], '没超 ⇒ 不该有超预算告警（基线那条不算）')
})

test('★ 量出来的 token 数与 `estimateTokens` 一致（不另算一套）', () => {
  const text = '一段中文加 English words 混排'
  const check = createBudgetCheck({ budgetTokens: 1000, warn: () => {} })
  assert.equal(check.check(text).tokens, estimateTokens(text))
})

test('★★ 模块名是 `memory-budget`（面板按模块筛得到）', () => {
  assert.equal(BUDGET_LOG_MODULE, 'memory-budget')
})

// ════════════════════════════════════════════════════════════════════════════
// 源码级：生产路径真的接上了（★ "库写好了、测试全绿、生产零调用"是本仓栽过 20+ 次的形状）
// ════════════════════════════════════════════════════════════════════════════

test('★★★ `index.ts` 真的用**契约值**造了检查器，并检查了 L2 文本', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(source, /createBudgetCheck\(\{/, '★ 要真的造检查器（只 import 不算）')
  assert.match(
    source,
    /budgetTokens: defaultFor<number>\('memory\.l2BudgetTokens'\)/,
    '★★ 预算必须来自契约键 —— ★ 在代码里写死一个 100000 就等于又一次"那个键没人读"',
  )
  assert.match(source, /l2Budget\.check\(runtime\.l2Text\(\)\)/, '★★ 必须真的**检查了 L2 文本**（造了不检查 = 什么都没管）')
  assert.match(source, /pluginLog\?\.write\('warn', message, BUDGET_LOG_MODULE\)/, '★ 告警要进日志汇（模块名固定）')
})
