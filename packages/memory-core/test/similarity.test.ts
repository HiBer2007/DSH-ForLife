/**
 * 词面近似相似度的测试。
 *
 * 这个函数原来住在 `dsh-component/src/runtime.ts`（只为 recall 的重复查询服务），
 * 2026-10-07 因「手动喂食记忆资料」的查重要复用**同一份判据**而下沉到这里。
 * 所以这里要钉住两类东西：
 *  ① **能力边界**（抓得住什么、抓不住什么）—— 与 recall 侧那份测试同一批断言，
 *     确保搬家没改变行为（搬完两边都得绿）；
 *  ② **喂食场景**的用法：长段落与它自己的表面变体必须判"同一段"，
 *     而两段不同的资料**不许**被判成重复（误杀会让用户以为"喂进去了"，其实一个字都没多）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeForSimilarity, similarityTokens, textSimilarity } from '../src/similarity.ts'

test('相似度：空白 / 大小写 / 标点 / 全半角的差异不算"换了一段"', () => {
  assert.equal(textSimilarity('防抖 2-3 秒', '防抖2-3秒。'), 1)
  assert.equal(textSimilarity('QQ Bot 防抖', 'qq　bot 防抖'), 1, 'NFKC + 小写 + 去全角空格')
  assert.equal(textSimilarity('QQ防抖', '防抖QQ'), 1, '集合语义忽略词序')
})

test('相似度：同义改写与不同主题都抓不到（如实返回低值，不假装懂语义）', () => {
  assert.ok(textSimilarity('防抖实现', '防抖是怎么做的') < 0.9, '同义改写抓不到 —— 那需要向量')
  assert.equal(textSimilarity('消息队列', '数据库迁移'), 0, '不同主题必须判 0')
})

test('相似度：空文本与纯标点返回 0（不判重复，交给调用方如实报"没命中"）', () => {
  assert.equal(textSimilarity('', '防抖'), 0)
  assert.equal(textSimilarity('！！！', '防抖'), 0, '全是标点 ⇒ 归一化后没有 token')
  assert.equal(normalizeForSimilarity('（一）'), '一', '括号也算标点')
})

test('相似度：长段落与自己的表面变体仍判同一段（喂食的实际形态）', () => {
  const paragraph = [
    '压缩前的短期窗口里保留最近几轮原文。',
    '超过阈值时把要点推进中期记忆，原文碎片化后指向长期记忆。',
  ].join('\n')
  const variant = `压缩前的短期窗口里保留最近几轮原文。\n\n超过阈值时把要点推进中期记忆，原文碎片化后指向长期记忆！`
  assert.equal(textSimilarity(paragraph, variant), 1, '换行与句末标点的差异不该算新内容')
})

test('相似度：CJK 取 bigram，单字成段取该字本身（否则永远判不出重复）', () => {
  assert.deepEqual([...similarityTokens('防抖窗口')].sort(), ['防抖', '抖窗', '窗口'].sort())
  assert.deepEqual([...similarityTokens('猫')], ['猫'])
  assert.equal(textSimilarity('猫', '猫'), 1)
})
