/**
 * ★★ 压缩判据的**分母守卫**（`FIX_PLAN.md` §61 缺口②）。
 *
 * ## 它守的是什么
 *
 * `PLAN.MD` §4.2 说「短期 token **占比** ≥ 50% 触发压缩」、§4.4 说「短期记忆**占比** ≥ 75%
 * 强制绕过冷却期」—— ★ 这两条**必须有一个分母**，而按 `PLAN.MD` 附录 A，
 * **L4 短期记忆区的上限是总上下文的 10%**（1M ⇒ **100k**）。
 *
 * ★★ 改动前的病：分母有两处，**都不是它** ——
 *   - `runtime.compactionStats()` 默认按 **128k** 估
 *   - 另一处传的是**上下文窗口**（1M）
 *   ⇒ ★ 50% 被推到 64k/500k，而 L4 只有 100k 可用 ⇒ **L4 早爆 5 倍了判据才响**。
 *
 * ★ 真机证据（改前）：`acct_short_tokens = 21844` ⇒ 按 128k 算 **17.1%**、按 1M 算 **2.2%**，
 *   两条都远不到 50%；★ 按 100k 算 ⇒ **21.8%**。
 *
 * ## 为什么守卫要读源码
 *
 * ★ "分母对不对"是个**接线**问题，不是纯函数行为问题：`compactionStats` 自己算得没错，
 * 错的是**喂给它的那个数**。⇒ 必须断言**源码里的算式**（去注释后、断言位置）。
 *
 * ★ 每条守卫都跑过注入验证（改坏对应那行 ⇒ 红；还原 ⇒ 绿）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { defaultFor } from '@forlife/contracts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 去掉注释（尊重字符串/模板字面量）—— 本仓注释里就写着"分母该是哪个"，不去掉会自己满足自己。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// ① 基线：L4 预算必须存在、且是"总上下文的 10%"这个量级
// ════════════════════════════════════════════════════════════════════════════

test('★★ `memory.shortBudgetTokens` 存在且为正（压缩判据的分母）', () => {
  const v = defaultFor<number>('memory.shortBudgetTokens')
  assert.ok(
    typeof v === 'number' && v > 0,
    '★ 没有它，`PLAN.MD` §4.2 的「短期占比 ≥ 50%」与 §4.4 的「≥ 75%」**没有分母**，' +
      '两条判据算不出来 —— 那正是改动前的状态。',
  )
})

test('★★ L4 预算 ≤ L3 预算（五区口径：10% ≤ 50%，PLAN 附录 A）', () => {
  const short = defaultFor<number>('memory.shortBudgetTokens')
  const mid = defaultFor<number>('memory.midBudgetTokens')
  assert.ok(
    short <= mid,
    '★ 按 `PLAN.MD` 附录 A：**L4 ≤ 10%** 而 **L3 ≤ 50%** ⇒ L4 的预算**不该超过** L3 的。' +
      '★ 若这条红了，多半是有人把两个区的预算抄混了。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ② 源码：`shortRatio` 的**分母**必须是 L4 预算，不是上下文窗口
// ════════════════════════════════════════════════════════════════════════════

test('★★ `shortRatio` 的算式里**不许**出现 `contextWindowTokens`（源码级，去注释）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  // ⚠️ 文件里有**两处** `shortRatio:` —— ① 返回类型里的 `shortRatio: number`、
  //    ② 真正的赋值。★ 我第一次用 `exec`（取第一个）⇒ 匹配到类型声明 ⇒ 守卫假红。
  //    ⇒ 取**最后一处**（赋值在声明之后）。
  const all = [...body.matchAll(/shortRatio:\s*([^,\n]+)/g)]
  assert.ok(all.length > 0, '找不到 `shortRatio:`（形状变了？守卫要跟着改）')
  const expr = all[all.length - 1]?.[1] ?? ''
  assert.ok(
    !expr.includes('contextWindowTokens'),
    '★ 分母**不许**是上下文窗口 —— 按 `PLAN.MD` 附录 A，L4 的预算是总上下文的 **10%**，' +
      '拿 1M 当分母会把 50% 推到 500k，而 L4 只有 100k 可用 ⇒ **判据永远不会响**。\n' +
      `★ 实际算式：${expr.trim()}`,
  )
  assert.ok(
    expr.includes('shortBudget'),
    '★ 分母必须是 `shortBudget`（= 基线 `memory.shortBudgetTokens`）。\n' +
      `★ 实际算式：${expr.trim()}`,
  )
})

test('★★ `shortBudget` 从基线派生（不许写死数字）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  assert.ok(
    body.includes("defaultFor<number>('memory.shortBudgetTokens')"),
    '★ 本仓铁律：**代码里的默认值只能从基线派生**（`param-consumption.test.ts` 守着这一条）。' +
      '★ 写死 100000 的话，改基线它不会跟着改。',
  )
})

test('★★ 已经删掉的 `contextWindowTokens` getter 不许回来当分母', () => {
  const body = stripComments(read('../src/runtime.ts'))
  assert.ok(
    !/get\s+contextWindowTokens\s*\(/.test(body),
    '★ 那个 private getter（"上下文上限（用于算短期占比）"）**已删除** —— ' +
      '它的语义就是错的。★ 若它回来了，多半是有人把分母又改回上下文窗口。',
  )
})

test('★ 参数化路径仍在：`compactionStats` 能收一个显式的 L4 预算（测试需要控制分母）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  assert.ok(
    /compactionStats\s*\(\s*shortBudgetTokens\s*\?\s*:\s*number\s*\)/.test(body),
    '★ 参数名必须是 `shortBudgetTokens`（不是 `contextWindowTokens`）—— ' +
      '★ 10 个测试文件靠它把占比做大（原来用的是 `contextWindowTokens: 8000`，那是旧写法）。',
  )
})
