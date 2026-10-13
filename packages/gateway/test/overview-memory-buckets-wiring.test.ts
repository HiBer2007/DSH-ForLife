/**
 * 接线守卫：面板「记忆条目」卡必须显示**四块口径**，且术语准确
 * （`FIX_PLAN.md` §10 / 用户原话）。
 *
 * ## 用户原话
 *
 * > 记忆条目板块应当显示为 **活跃 / 中期 / 长期碎片 / 长期**，
 * > **长期碎片**指**在中期记忆中关于长期记忆的碎片**。
 *
 * ## 这条盯的是两个**容易搞混**的地方
 *
 * **① 「中期」不是「活跃」的同义词。**
 * `PLAN.MD:257`：中期记忆区 = active 条目（80–85%）+ 碎片索引（15–20%）。
 * 所以「中期」= 活跃 + 长期碎片。把这两个当成一回事，面板上的数就会
 * 比真实的中期区小一大截 —— 而用户正是**看着面板上的数**做的判断。
 *
 * **② 「碎片」这个词太泛，必须叫「长期碎片」。**
 * 它特指**指向长期记忆的**碎片（`status='fragmented'`，带 `fragment_hint`
 * 与 `fragmented_into`）。写成光秃秃的「碎片」，读者无法与「长期」区分开 ——
 * 这两个词在面板上挨着出现，混淆的代价是误判记忆到底搬没搬过去。
 *
 * ## 为什么断言源码而不是渲染结果
 *
 * 这张卡是 `computed` 里的一段字面量，渲染测试要搭整套 `data` 夹具；
 * 而这里真正要守的是**用词**与**加总方式**，源码守卫更直接。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const view = (): string =>
  readFileSync(new URL('../../admin-ui/src/views/OverviewView.vue', import.meta.url), 'utf8')

test('★★ 守卫：记忆卡必须**四个口径齐全**（活跃 / 中期 / 长期碎片 / 长期）', () => {
  const src = view()

  assert.match(src, /label: '中期条目'/, '主数字必须是「中期条目」—— 它是活跃 + 长期碎片，不是活跃')
  assert.match(
    src,
    /活跃 \$\{formatNumber\(d\.memory\.activeEntries\)\}/,
    '必须显示「活跃」条数',
  )
  assert.match(
    src,
    /长期碎片 \$\{formatNumber\(d\.memory\.fragmentEntries\)\}/,
    '必须显示「长期碎片」条数（**带"长期"两个字**，不能只写"碎片"）',
  )
  assert.match(src, /长期 \$\{formatNumber\(d\.memory\.longEntries\)\}/, '必须显示「长期」条数')
})

test('★★ 守卫：「中期」= 活跃 + 长期碎片（`PLAN.MD:257` 的那种加总）', () => {
  const src = view()
  assert.match(
    src,
    /value: formatNumber\(d\.memory\.activeEntries \+ d\.memory\.fragmentEntries\)/,
    '中期必须是**两者相加** —— 少加一项，面板上的中期就偏小，而用户是照着这个数做判断的',
  )
})

test('★ 守卫：不许再把「碎片」当独立口径写（它必须与「长期」区分开）', () => {
  const src = view()
  // 允许出现「长期碎片」；不允许出现光秃秃的「碎片 ${...}」那种标签写法
  assert.ok(
    !/· 碎片 \$\{/.test(src),
    '「碎片」这个词太泛，且与旁边的「长期」无法区分 ⇒ 一律写「长期碎片」',
  )
})

test('★ 守卫：不许读回全表 `activeTokens` 当主数字（那是 2026-10-09 修过的坑）', () => {
  const src = view()
  // 这条卡是**条数**口径；token 口径归「活跃 token」卡（窗口口径），
  // 全表的那个数只允许出现在副标题里做诊断对照。
  assert.ok(
    !/value: formatTokens\(d\.memory\.activeTokens\)/.test(src),
    '主数字读全表 activeTokens = 退回那个「数字对不上、用户以为窗口没生效」的坑',
  )
})
