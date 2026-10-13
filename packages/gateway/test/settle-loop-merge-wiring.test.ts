/**
 * ★★ D8 接线：沉降循环里**先合并、后淘汰**（`FIX_PLAN.md` §78.57 / §78.58）。
 *
 * ## 为什么要源码级守卫
 *
 * 这个功能**已经写了三层、测试全绿**，但如果在沉降循环里**没有那一行调用**，
 * 它就是"**库写好了、测试全绿、生产零调用**"—— 本仓历史上真出现过这类问题
 * （循环守卫、`mergeGroups` 都是）。★ 所以这里断言**调用真的在**，而且**顺序对**。
 *
 * ## 钉四件事
 *
 * 1. ★★ `runFragmentMerge` 在沉降循环里**真的被调用**；
 * 2. ★★ **顺序**：合并必须在 `evictFragments`（淘汰）**之前**（反过来会先删掉"本可以合并"的碎片 —— 不可逆）；
 * 3. ★ 合并失败**不许拖垮整轮**（有 try/catch，且淘汰照跑）；
 * 4. ★ 合并结果**如实上报**（失败时保持 `undefined`，不许写成"跑了 0 组"）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 读源码并**去掉注释行**（注释里提到函数名不算"调用了它"）。 */
function codeOf(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

test('★★★ 沉降循环里真的调了 `runFragmentMerge`（防"库写好、生产零调用"）', () => {
  const loop = codeOf('../src/settle-loop.ts')
  assert.match(loop, /await runFragmentMerge\(options\.db, \{/, '★ 要有真调用（带 db）')
  assert.match(loop, /maxHintTokens: defaultFor<number>\('fragment\.maxHintTokens'\)/, '★ 粗 hint 上限与契约键同源')
  assert.match(loop, /atLevel\(log, 'note'\)\(message\)/, '★ 合并结果要进日志（note 级）')
})

test('★★★ 顺序：合并必须在**淘汰之前**（反过来会先删掉"本可以合并"的碎片 —— 不可逆）', () => {
  const loop = codeOf('../src/settle-loop.ts')
  const mergeAt = loop.indexOf('await runFragmentMerge(options.db')
  const evictAt = loop.indexOf('evictFragments(options.db')
  assert.ok(mergeAt > 0, '合并调用要在')
  assert.ok(evictAt > 0, '淘汰调用要在')
  assert.ok(mergeAt < evictAt, '★★ 合并必须先于淘汰（这条顺序是不可逆损失的分界线）')
})

test('★★ 合并失败不许拖垮整轮：有 try/catch，且淘汰照跑', () => {
  const loop = codeOf('../src/settle-loop.ts')
  assert.match(loop, /碎片合并失败（淘汰照跑）/, '★ 失败要如实报（不吞）')
  assert.match(loop, /atLevel\(log, 'error'\)/, '★ 用 error 级（不是 note/info）')
  // ★ 失败时 mergeResult 保持 undefined ⇒ 不许把"没跑成"写成"跑了 0 组"
  assert.match(loop, /let mergeResult: MergeRunResult \| undefined/)
  assert.match(loop, /mergeResult = mergeRun/, '★ 只在成功时赋值')
})
