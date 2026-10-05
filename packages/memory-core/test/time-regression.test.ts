/**
 * 时间感知回归测试集的测试。
 *
 * 这里**不跑真模型**（本机没有凭据），而是把"考卷本身"测好：
 *  ① 题目与判分规则符合预期（正确的答案得满分、幻觉答案被扣分）；
 *  ② **对比逻辑会说真话** —— 如果对照组也能答对，它必须说"这套题没测到东西"，
 *     而不是庆祝。一个测不出差异的测试集比没有更危险（虚假信心）。
 *
 * 真模型下的两轮对比要等有凭据时跑 `scripts/time-regression.ts`，属于待验项。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareRegression, scoreAnswer, scoreRegression, timeQuestions } from '../src/time-regression.ts'

const NOW = new Date('2026-10-05T06:23:00.000Z') // 东八区 2026-10-05 14:23 周一

test('题库：10 题，覆盖五类时间问题，每题都有判分规则', () => {
  const questions = timeQuestions(NOW)
  assert.equal(questions.length, 10)
  for (const question of questions) {
    assert.ok(question.id.length > 0)
    assert.ok(question.question.length > 0)
    assert.ok(question.expect.length > 0, `${question.id} 缺少判分规则（那样永远算对）`)
  }
  // 覆盖 §2.15.2 列出的五类
  const ids = questions.map((q) => q.id).join(' ')
  for (const kind of ['now-clock', 'how-long-since', 'this-week-count', 'cross-day', 'recent-three-days']) {
    assert.ok(ids.includes(kind), `缺少"${kind}"这一类问题`)
  }
})

test('判分：正确回答得分，缺失关键信息不得分', () => {
  const questions = timeQuestions(NOW)
  const clock = questions.find((q) => q.id === 'Q1-now-clock')
  const year = questions.find((q) => q.id === 'Q3-year')
  assert.ok(clock !== undefined && year !== undefined)

  assert.equal(scoreAnswer(clock, '现在是 2026-10-05 14:23，周一。').correct, true)
  assert.equal(scoreAnswer(year, '今年是 2026 年。').correct, true)

  const wrong = scoreAnswer(clock, '现在是下午三点左右吧。')
  assert.equal(wrong.correct, false, '回避具体日期/时刻不算答对')
  assert.ok(wrong.missing.length > 0)
})

test('判分：落在训练数据里的年份要被扣分（这是时间幻觉的典型表现）', () => {
  const questions = timeQuestions(NOW)
  const clock = questions.find((q) => q.id === 'Q1-now-clock')
  assert.ok(clock !== undefined)
  const hallucinated = scoreAnswer(clock, '现在是 2024 年 3 月 15 日 14:23。')
  assert.equal(hallucinated.correct, false, '即使格式对，年份错了也是幻觉')
  assert.ok(hallucinated.rejected.length > 0, '要能指出命中了哪条"禁止模式"')
})

test('判分：拒绝凭印象猜是**正确行为**（纪律题）', () => {
  const questions = timeQuestions(NOW)
  const discipline = questions.find((q) => q.id === 'Q10-refuse-to-guess')
  assert.ok(discipline !== undefined)
  assert.equal(scoreAnswer(discipline, '我不能凭印象说，需要查一下时间读数。').correct, true)
  assert.equal(scoreAnswer(discipline, '大概下午三点吧。').correct, false, '凭印象猜要扣分')
})

test('汇总：按题计分并给出比率', () => {
  const questions = timeQuestions(NOW)
  const answers: Record<string, string> = {}
  for (const question of questions) answers[question.id] = '不知道'
  // 只答对"这周几次"这类允许说"不知道"的宽容题
  const score = scoreRegression(questions, answers)
  assert.equal(score.total, 10)
  assert.ok(score.rate >= 0 && score.rate <= 1)
  assert.equal(score.details.length, 10)
  assert.ok(score.correct < 10, '全答"不知道"不该拿满分')
})

test('对比：两组差距明显时判定因果成立', () => {
  const verdict = compareRegression(
    { total: 10, correct: 9, rate: 0.9, details: [] },
    { total: 10, correct: 3, rate: 0.3, details: [] },
  )
  assert.equal(verdict.causal, true)
  assert.match(verdict.verdict, /因果成立/)
  assert.ok(Math.abs(verdict.delta - 0.6) < 1e-9)
})

test('对比：**对照组也答得好时必须说"这套题没测到东西"**（不许自我庆祝）', () => {
  const verdict = compareRegression(
    { total: 10, correct: 10, rate: 1, details: [] },
    { total: 10, correct: 9, rate: 0.9, details: [] },
  )
  assert.equal(verdict.causal, false)
  assert.match(verdict.verdict, /没测到/)
  assert.match(verdict.verdict, /题目太容易|推出来/)
})

test('对比：差距不够时如实说"不足以证明因果"，并给出排查方向', () => {
  const verdict = compareRegression(
    { total: 10, correct: 6, rate: 0.6, details: [] },
    { total: 10, correct: 5, rate: 0.5, details: [] },
  )
  assert.equal(verdict.causal, false)
  assert.match(verdict.verdict, /不足以证明因果/)
  assert.match(verdict.verdict, /查注入日志|不敏感/)
})

test('题面随"现在"变化：换一天，期望模式跟着变', () => {
  const other = new Date('2027-01-20T02:00:00.000Z') // 东八区 2027-01-20 10:00
  const questions = timeQuestions(other)
  const clock = questions.find((q) => q.id === 'Q1-now-clock')
  assert.ok(clock !== undefined)
  assert.equal(scoreAnswer(clock, '现在是 2027-01-20 10:00。').correct, true, '日期断言必须按传入的现在算')
  const year = questions.find((q) => q.id === 'Q3-year')
  assert.ok(year !== undefined)
  assert.equal(scoreAnswer(year, '今年是 2027 年。').correct, true)
})
