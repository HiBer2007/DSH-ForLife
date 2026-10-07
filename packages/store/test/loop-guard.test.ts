/**
 * 死循环监控的守卫测试。
 *
 * ## 最值得守的五条
 *
 * 1. **一字不差地重复**要抓到（最基本的一条）；
 * 2. ★ **归一化后重复**也要抓到 —— 模型会在重复里换标点、加空格、
 *    改大小写。只比对原文的话**真死循环会漏掉**；
 * 3. ★ **周期循环**要抓到（`abcabcabc`）—— 只看"整句相同"会漏掉它；
 * 4. ★ **不能误杀正常对话** —— 短回应（`嗯`/`好的`）天然会重复，
 *    把它们算进去的话，一个正常的对话会被判成死循环；
 * 5. **样本不足时不下结论** —— "还没看够"不是"正常"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_LOOP_POLICY, LoopGuard, normalizeForLoop, scanForLoop } from '../src/loop-guard.ts'

test('★ 归一化：标点、空白、大小写都不该算"不同的输出"', () => {
  const a = normalizeForLoop('好的，我明白了。')
  const b = normalizeForLoop('好的, 我明白了!')
  const c = normalizeForLoop('  好的，我明白了！  ')
  assert.equal(a, b, `标点不同应当归一：${a} vs ${b}`)
  assert.equal(a, c, `空白与全角标点应当归一：${a} vs ${c}`)
  assert.equal(normalizeForLoop('ABC'), normalizeForLoop('abc'), '大小写应当归一')
})

test('★ 一字不差地重复 ⇒ 判死循环', () => {
  const g = new LoopGuard()
  let v = g.judge()
  for (let i = 0; i < 12; i += 1) v = g.feed('我先看看这个文件的内容')
  assert.equal(v.action, 'stop-and-restart', v.reason)
  assert.match(v.reason, /重复|周期|打转/)
})

test('★★ **归一化后重复**也要抓到（模型会换标点）', () => {
  const g = new LoopGuard()
  let v = g.judge()
  const variants = [
    '好的，我明白了。',
    '好的, 我明白了!',
    '好的，我明白了！',
    ' 好的，我明白了。',
    '好的,我明白了.',
  ]
  for (let i = 0; i < 12; i += 1) v = g.feed(variants[i % variants.length] ?? '')
  assert.equal(v.action, 'stop-and-restart', `换标点的重复必须抓到：${v.reason}`)
})

test('★★ **周期循环**也要抓到（`abcabcabc` —— 只看整句相同会漏）', () => {
  // 单条输出内部就是周期重复（不是"多条相同"）
  const v = scanForLoop('第一步检查配置。第二步运行测试。第三步看结果。'.repeat(8))
  assert.equal(v.action, 'stop-and-restart', `周期循环必须抓到：${v.reason}`)
  assert.ok(v.signals.period > 0, '要报出周期长度')
})

test('★ **不能误杀正常对话**（短回应天然会重复）', () => {
  const g = new LoopGuard()
  // 一段正常的多轮对话：有重复的短回应，但整体在推进
  const normal = [
    '嗯',
    '好的',
    '我看看这个文件',
    '这个文件里有一个配置项',
    '嗯',
    '我改一下它',
    '改好了',
    '好的',
    '再跑一遍测试',
    '测试通过了',
  ]
  let v = g.judge()
  for (const line of normal) v = g.feed(line)
  assert.notEqual(v.action, 'stop-and-restart', `**正常对话被误杀了**：${v.reason}`)
})

test('★ 样本不足 ⇒ 不下结论（"还没看够"不是"正常"）', () => {
  const g = new LoopGuard()
  g.feed('一样的话')
  g.feed('一样的话')
  const v = g.judge()
  assert.equal(v.action, 'ok')
  assert.match(v.reason, /样本不足/, '要说清是"没看够"而不是"正常"')
})

test('★ **原地打转**（首尾相同、中间换词）⇒ 判死循环', () => {
  const g = new LoopGuard()
  let v = g.judge()
  for (let i = 0; i < 12; i += 1) {
    // 开头与结尾不变，中间换一个词 —— **整句比对会判成"不同"**
    v = g.feed(`我需要先确认一下配置是否正确然后再继续处理第${String(i)}种情况`)
  }
  assert.equal(v.action, 'stop-and-restart', `原地打转必须抓到：${v.reason}`)
})

test('★ `reset()` 要清干净（重启本轮时必须调，否则上轮的重复会算进新一轮）', () => {
  const g = new LoopGuard()
  for (let i = 0; i < 12; i += 1) g.feed('同一句话')
  assert.equal(g.judge().action, 'stop-and-restart')
  g.reset()
  const after = g.judge()
  assert.equal(after.action, 'ok')
  assert.equal(after.signals.samples, 0, 'reset 后样本要归零')
})

test('★ 判定要**能解释**（报数，不是布尔）', () => {
  const g = new LoopGuard()
  let v = g.judge()
  for (let i = 0; i < 12; i += 1) v = g.feed('重复的话')
  assert.ok(v.signals.samples > 0, '要报样本数')
  assert.ok(v.signals.distinct >= 1, '要报不同条数')
  assert.ok(v.signals.repeatRatio > 0, '要报重复率')
  assert.ok(v.reason.length > 0, '要有理由')
})

test('warn：可疑但未越线（让人在真死循环前有机会看到）', () => {
  const g = new LoopGuard()
  let v = g.judge()
  // 交替两种内容 —— 重复率 50%，不到 85% 的线，但也不正常
  for (let i = 0; i < 14; i += 1) v = g.feed(i % 2 === 0 ? '第一种说法在这里' : '第二种说法在这里')
  assert.ok(v.action === 'warn' || v.action === 'stop-and-restart', `应当至少 warn：${v.reason}`)
})

test('scanForLoop：空文本不报错', () => {
  const v = scanForLoop('')
  assert.equal(v.action, 'ok')
  assert.match(v.reason, /空文本/)
})

test('scanForLoop：正常长文不该被判死循环', () => {
  const text = [
    '先看配置文件，里面写着端口和数据库路径。',
    '然后检查数据库文件是否存在，不存在就初始化。',
    '接着跑一遍迁移，把表结构建起来。',
    '最后启动服务，确认端口在监听。',
    '如果端口被占用，就换一个端口重试。',
  ].join('')
  const v = scanForLoop(text)
  assert.notEqual(v.action, 'stop-and-restart', `正常长文被误杀：${v.reason}`)
})

test('阈值可调（不同模型/任务的"正常重复"程度不一样）', () => {
  const strict = new LoopGuard({ ...DEFAULT_LOOP_POLICY, repeatRatio: 0.3 })
  let v = strict.judge()
  for (let i = 0; i < 10; i += 1) v = strict.feed(i % 3 === 0 ? '甲种说法' : i % 3 === 1 ? '乙种说法' : '丙种说法')
  // 3 种 / 10 条 ⇒ 重复率 0.7 ≥ 0.3 ⇒ 严阈值下应当判停
  assert.equal(v.action, 'stop-and-restart', `严阈值应当判停：${v.reason}`)
})
