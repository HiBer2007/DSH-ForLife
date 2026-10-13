/**
 * ★★ 合并策略**从契约键读**（D8；用户 2026-10-13 裁定"BC 都实现、AB 都实现、配置时选"）。
 *
 * ## 这一组钉四件事
 *
 * 1. ★★ **五个键都有消费者**（`param-consumption` 那类守卫盯的就是这个）——
 *    这里逐个键断言"改了它，读出来的策略就跟着变"；
 * 2. ★★ **非法值必须抛错、不许静默回退** —— 拼错的 `criterion` 若被当成默认值，
 *    用户会以为"我配了 C"而其实在跑 B（最难发现的一类问题）；
 * 3. ★ 默认值与裁定一致：B（交集 ≥ 2）· A（机械拼接）· `apply`；
 * 4. ★ `describeMergeSettings()` 能把当前策略写成一句话（事后能回答"当时用的是哪套"）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeMergeSettings, mergeSettingsFromContract } from '../src/fragment-merge-policy.ts'

/** 造一个**注入的读键函数**（★ 不去改基线文件：defaultFor 在导入时就把基线读进内存了，
 *  改文件对已加载的模块没有影响 —— 我第一版就是这么写错的，两条测试当场红）。 */
function fakeRead(overrides: Record<string, unknown>): <T>(key: string) => T {
  return <T>(key: string): T => {
    const base: Record<string, unknown> = {
      'fragment.merge.criterion': 'intersection',
      'fragment.merge.minShared': 2,
      'fragment.merge.jaccard': 0.5,
      'fragment.merge.hintMode': 'mechanical',
      'fragment.merge.mode': 'apply',
    }
    const value = key in overrides ? overrides[key] : base[key]
    return value as T
  }
}

test('★★★ 五个键都真的被读（逐个改，逐个看策略变）', () => {
  const read = (overrides: Record<string, unknown>) => (): unknown => fakeRead(overrides)
  assert.equal(mergeSettingsFromContract(undefined, fakeRead({ 'fragment.merge.criterion': 'jaccard' })).criterion, 'jaccard')
  assert.equal(mergeSettingsFromContract(undefined, fakeRead({ 'fragment.merge.minShared': 3 })).minShared, 3)
  assert.equal(mergeSettingsFromContract(undefined, fakeRead({ 'fragment.merge.jaccard': 0.75 })).jaccard, 0.75)
  assert.equal(mergeSettingsFromContract(undefined, fakeRead({ 'fragment.merge.hintMode': 'model' })).hintMode, 'model')
  assert.equal(mergeSettingsFromContract(undefined, fakeRead({ 'fragment.merge.mode': 'shadow' })).mode, 'shadow')
  void read
})
test('★★ 默认值与用户裁定一致（B 交集≥2 · A 机械 · apply）', () => {
  const s = mergeSettingsFromContract()
  assert.equal(s.criterion, 'intersection', '★ 裁定：默认走 B')
  assert.equal(s.minShared, 2, '★ 裁定：B 的 N=2')
  assert.equal(s.hintMode, 'mechanical', '★ 裁定：默认走 A（机械拼接，不花钱）')
  assert.equal(s.mode, 'apply', '★ 裁定按"能生效"给的 ⇒ 默认真合并')
  assert.equal(s.jaccard, 0.5, '★ C 的 X 标定前先用 0.5（标定结论出来后改基线并记账）')
})

test('★★★ 非法值必须抛错（不许静默回退 —— 那会让人以为配上了）', () => {
  const bad = (overrides: Record<string, unknown>): unknown =>
    ((): unknown => mergeSettingsFromContract(undefined, fakeRead(overrides)))()
  assert.throws(() => bad({ 'fragment.merge.criterion': 'Jaccard' }), /取值非法/, '★ 大小写写错也要抛')
  assert.throws(() => bad({ 'fragment.merge.hintMode': 'llm' }), /取值非法/)
  assert.throws(() => bad({ 'fragment.merge.mode': 'dry' }), /取值非法/)
  // ★ Jaccard 是比值 ⇒ 0 与 >1 都不合法（0 = 什么都不合，>1 = 永远不合，两种都是"配了等于没配"）
  assert.throws(() => bad({ 'fragment.merge.jaccard': 0 }), /超出范围/)
  assert.throws(() => bad({ 'fragment.merge.jaccard': 1.5 }), /超出范围/)
  // ★ minShared 至少 1（0 在 fragment-merge 里是"不判"）
  assert.throws(() => bad({ 'fragment.merge.minShared': 0 }), /超出范围/)
})
test('★ `maxHintTokens` 由调用方传（与 `fragment.maxHintTokens` 同源），描述文本要含判据/生成/模式', () => {
  assert.equal(mergeSettingsFromContract(80).maxHintTokens, 80)
  assert.equal(mergeSettingsFromContract().maxHintTokens, undefined, '不传就不带（不猜一个默认值）')
  const text = describeMergeSettings(mergeSettingsFromContract(80))
  assert.match(text, /B 交集≥2/)
  assert.match(text, /A 机械拼接/)
  assert.match(text, /apply/)
  assert.ok(!text.includes('**'), '★ 面板/日志不渲染 Markdown')
})
