/**
 * 跨模型 failover 的**接线守卫**。
 *
 * ## 为什么必须读源码而不是靠单测
 *
 * `failover-hooks.ts` 自己的 8 条测试**全绿** —— 但它们测的是"**这个函数**对不对"，
 * 不是"**它有没有被调用**"。而这个模块存在的**全部理由**就是"挂上去"：
 * `router-hooks.ts` 的模块头写着「降级能力完全取决于**我们有没有挂上这两个钩子**」，
 * 而它此前**一行宿主交互都没有**（`deviations.ts:129` 记着这条偏离）。
 *
 * ⇒ **函数写好了、测试全绿、生产里根本没跑** —— 本仓栽过这个跟头
 *   （`beginTurn()` / `observeShortTokens()` 曾经只被测试调用）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读源码并**去掉注释**（注释里引用的写法不许把守卫骗过去）。 */
function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const INDEX = code('../src/index.ts')

test('★★★ `index.ts` 真的装了 failover 接线（不是只 import 不调用）', () => {
  assert.match(INDEX, /import \{[^}]*installFailoverHooks[^}]*\}/, '必须 import')
  assert.match(INDEX, /installFailoverHooks\(ctx as never, \{/, '★ 必须**调用**它（`router-hooks.ts` 此前就是"写了没接"）')
  assert.match(INDEX, /buildFailoverRuntime\(runtime, \{/, '裁决对象要用真的 runtime 建')
})

test('★★ 门控**复用** `resolveRouterMode()` —— 不新开第二个开关', () => {
  // 两个开关会让人以为"路由关了但降级还开着" —— 而那正是最需要说清的一件事
  assert.match(INDEX, /mode: resolveRouterMode\(\)/, '★ 必须用与模型路由**同一个**门控')
  assert.ok(
    !/FORLIFE_FAILOVER_MODE|FAILOVER_ENABLED/.test(INDEX),
    '★ 不许新开一个 failover 专用开关（功能开关只能有一个真源）',
  )
})

test('★★ 候选链取自 `model_routes` 且**只取启用的**', () => {
  assert.match(INDEX, /listModelRoutes\(runtime\.db, failoverRole\)/, '候选链的真源是 model_routes（有序）')
  assert.match(
    INDEX,
    /\.filter\(\(row\) => row\.enabled === 1\)/,
    '★ 只取 enabled 的 —— 面板上禁用的行不该被降级链捡起来（"禁用了却还在用"是最难查的一类）',
  )
})

test('★★ 装上就必须能卸（不退订 = 一堆死监听器，内存与 CPU 双漏）', () => {
  assert.match(INDEX, /disposers\.push\(\(\) => \{\s*failoverHooks\.dispose\(\)/, '★ 必须进 disposers')
})

test('★ 降级要留痕：写进路由日志（否则"为什么这次答得不一样"无从查起）', () => {
  assert.match(INDEX, /runtime\.recordRoutingDecision\(\{ \.\.\.input, latencyMs: input\.latencyMs \?\? 0 \}\)/)
})
