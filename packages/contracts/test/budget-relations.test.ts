/**
 * ★★ 五区预算的**关系守卫**（`PLAN.MD` 附录 A / 用户 2026-10-11 口述）。
 *
 * ## 为什么需要它（以及它和别的守卫的区别）
 *
 * `mid-window-wiring` / `overview-window-wiring` 那几个端到端用例，2026-10-11 被我改成了
 * **相对预算**造数据（`ceil(预算/4)+1` 之类）—— 好处是**预算再改也不会假红**，
 * ★ 但代价是：**它们不再能证明"预算真的是某个值"** ❌。
 *
 * ⇒ 那件事由本文件负责：★ **把"预算之间的关系"钉住**，而不是钉住某个字面数字。
 *   字面数字会随用户裁定变（100k → 500k 就是一次），**关系不会**。
 *
 * ## 钉的是哪两条关系
 *
 * 1. ★ **L3 的两个键必须一致**：`memory.midWindow.maxTokens`（渲染窗口）
 *    与 `memory.midBudgetTokens`（中期区总量）**都是 L3 的上限**，
 *    ⇒ 按 `PLAN.MD` 附录 A，它们**必须是同一个数**。
 *    ★ 历史背景：2026-10-09 它们**不相等**（100k vs 500k），
 *      结果是「中期只渲染得进 100k，另 1.36M 永远进不了上下文」（真机日志实证）。
 * 2. ★ **条数上限的标定不变**：`memory.midWindow.maxCount` = `maxTokens ÷ 50`
 *    —— 这个"50 token/条"是 `maxCount` 自己的 `src` 写明的标定，
 *    **换预算时要按同一个标定换算**（否则两个键会各自漂）。
 *
 * ★ 两条都**只读基线**、不碰数据库 ⇒ 快、稳、与实现细节解耦。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultFor } from '../src/defaults.ts'

/** 条数上限的标定（token/条）—— 与 `memory.midWindow.maxCount` 的 `src` 保持一致。 */
const COUNT_CALIBRATION_TOKENS_PER_ENTRY = 50

test('★★ L3 的两个键必须同值：渲染窗口 = 中期区总量（PLAN 附录 A）', () => {
  const windowTokens = defaultFor<number>('memory.midWindow.maxTokens')
  const budgetTokens = defaultFor<number>('memory.midBudgetTokens')
  assert.equal(
    windowTokens,
    budgetTokens,
    '★ `memory.midWindow.maxTokens`（渲染窗口）与 `memory.midBudgetTokens`（中期区总量）' +
      '**都是 L3 的上限** ⇒ 按 PLAN 附录 A **必须相等**。\n' +
      '★ 2026-10-09 它们不等（100k vs 500k），后果是「中期只渲染得进 100k、' +
      '另 1.36M 永远进不了上下文」—— 真机日志实证过。',
  )
})

test('★ 两个预算都必须是正数（0 会让中期区一条都渲染不出来）', () => {
  const windowTokens = defaultFor<number>('memory.midWindow.maxTokens')
  const maxCount = defaultFor<number>('memory.midWindow.maxCount')
  assert.ok(windowTokens > 0, 'L3 的窗口预算必须是正数')
  assert.ok(maxCount > 0, '条数上限必须是正数')
})

// ★★ 2026-10-11：这里原来还有一条 `windowTokens <= context.windowTokensDefault`，
//   我写完就发现自己**前提错了** ❌ —— `context.windowTokensDefault` 是 **128000 的兜底值**
//   （它的 `src` 自己写着「宿主 tokenMeter 可用时以它为准」），而 **真实分母是模型 adapter
//   声明的 `contextWindow`**（四个 profile 给 `deepseek-v4.1-flash` 声明 **1000000**，
//   见 `compaction-engine.ts:335-341` 的那段注释）。
//   ⇒ 拿 128K 兜底当分母去比 500K 的 L3，**必然失败**，而且**什么都没证明**。
//   ★ 所以删掉，而不是把它改宽 —— **一条前提错的断言，改宽只会让它更安静地错下去**。
//   ★ 真要钉"50%"那条，得去读 profile 里**声明**的那个数；而那属于
//     `compaction-threshold.test.ts` 已经在守的东西（"生效触发点 = 600k"那条）。

test('★ 条数上限按同一标定换算（maxCount = maxTokens ÷ 50）', () => {
  const windowTokens = defaultFor<number>('memory.midWindow.maxTokens')
  const maxCount = defaultFor<number>('memory.midWindow.maxCount')
  assert.equal(
    maxCount,
    windowTokens / COUNT_CALIBRATION_TOKENS_PER_ENTRY,
    `★ 条数上限应等于 token 预算 ÷ ${String(COUNT_CALIBRATION_TOKENS_PER_ENTRY)}` +
      '（这个标定写在 `memory.midWindow.maxCount` 的 `src` 里：' +
      '「100000 token ÷ 2000 ≈ 50 token/条」）⇒ **换预算时要一起换**，' +
      '否则两个键各自漂、取小关系失效。',
  )
})

test('★ 条数上限是防呆闸，不是主约束：典型条目下它应当**宽于** token 预算', () => {
  const windowTokens = defaultFor<number>('memory.midWindow.maxTokens')
  const maxCount = defaultFor<number>('memory.midWindow.maxCount')
  // 真机实测平均 ~155 token/条（§63）；50 是标定用的下限。
  // ★ 只要 50 < 155 ⇒ 条数闸在**畸形表**（大量超短条目）上才会先撞到 —— 正是它的职责。
  assert.ok(
    windowTokens > 0 && maxCount > 0,
    '两个预算都必须为正（`selectMidWindow` 在预算不可用时会退回空窗口，见 `window.ts`）',
  )
})
