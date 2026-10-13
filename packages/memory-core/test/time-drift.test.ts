/**
 * 时间漂移抽取的测试。
 *
 * 这里最重要的不是"能抽到"，而是**不会乱抽**：
 * 误报会让人开始忽略这个指标，而"被忽略的指标"等于没有指标。
 * 所以每个用例都同时检查"该抽到的抽到了"与"不该抽的没抽"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeDrift, extractTimeClaims, findDrift } from '../src/time-drift.ts'

const SH = 'Asia/Shanghai'
const NOW = new Date('2026-10-05T06:23:00.000Z') // 东八区 2026-10-05 14:23

test('抽取：完整日期（三种写法都认）', () => {
  for (const text of ['2026年10月5日', '2026-10-05', '2026/10/05']) {
    const claims = extractTimeClaims(`记于 ${text}。`, NOW, SH)
    assert.ok(claims.some((c) => c.basis === '完整日期'), `${text} 应当被认出来`)
  }
})

test('抽取：非法日期不硬认（宁可漏报）', () => {
  assert.equal(extractTimeClaims('2026年13月40日', NOW, SH).length, 0, '13 月 40 日不是日期')
  assert.equal(extractTimeClaims('编号 1234-5678', NOW, SH).length, 0, '看着像但不是日期')
})

test('抽取：年份表述与钟点', () => {
  const year = extractTimeClaims('今年是 2026 年。', NOW, SH)
  assert.ok(year.some((c) => c.basis === '年份表述'))

  const clock = extractTimeClaims('现在是 14:23。', NOW, SH)
  const parsed = clock.find((c) => c.basis.includes('14:23'))
  assert.ok(parsed?.at !== undefined)
  // 东八区 14:23 = UTC 06:23
  assert.equal(parsed.at.toISOString(), '2026-10-05T06:23:00.000Z', '时区换算必须对')
})

test('抽取：中文钟点与上下午修正', () => {
  const afternoon = extractTimeClaims('大概是下午三点吧。', NOW, SH)
  const hit = afternoon.find((c) => c.basis.includes('中文钟点'))
  assert.ok(hit?.at !== undefined)
  assert.equal(hit.at.toISOString(), '2026-10-05T07:00:00.000Z', '下午三点 = 东八区 15:00 = UTC 07:00')

  const morning = extractTimeClaims('上午九点开会。', NOW, SH)
  const am = morning.find((c) => c.basis.includes('中文钟点'))
  assert.equal(am?.at?.toISOString(), '2026-10-05T01:00:00.000Z', '上午九点 = UTC 01:00')

  const half = extractTimeClaims('下午三点半。', NOW, SH)
  assert.equal(half.find((c) => c.basis.includes('中文钟点'))?.at?.toISOString(), '2026-10-05T07:30:00.000Z')

  const eleven = extractTimeClaims('晚上十一点。', NOW, SH)
  assert.equal(eleven.find((c) => c.basis.includes('中文钟点'))?.at?.toISOString(), '2026-10-05T15:00:00.000Z', '晚上十一点 = 23:00')
})

test('抽取：相对表述只标记，不做绝对比对（硬比会误报）', () => {
  const claims = extractTimeClaims('三天前我们聊过，明天再说。', NOW, SH)
  const relative = claims.filter((c) => c.relative)
  assert.ok(relative.length >= 2, '今天/昨天/三天前/明天 这类要标记为相对表述')
  assert.ok(relative.every((c) => c.at === undefined), '相对表述不该给出绝对时刻')
})

test('漂移：容差内不算问题（人说话本来就不精确）', () => {
  const claims = extractTimeClaims('现在是 14:23。', NOW, SH)
  const findings = findDrift(claims, NOW)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.severity, 'info', '完全一致 ⇒ info')
  assert.equal(findings[0]?.driftMs, 0)
})

test('漂移：超过 1 小时 warn、超过 1 天 bad，方向要分正负', () => {
  const late = findDrift(extractTimeClaims('现在是 14:23。', NOW, SH), new Date('2026-10-05T04:00:00.000Z'))
  assert.equal(late[0]?.severity, 'warn')
  assert.ok((late[0]?.driftMs ?? 0) > 0, '模型说的时间比真实晚 ⇒ 正偏差')

  const early = findDrift(extractTimeClaims('现在是 14:23。', NOW, SH), new Date('2026-10-05T20:00:00.000Z'))
  assert.ok((early[0]?.driftMs ?? 0) < 0, '模型说的时间比真实早 ⇒ 负偏差')

  const hallucinated = findDrift(extractTimeClaims('今天是 2024年3月15日。', NOW, SH), NOW)
  assert.equal(hallucinated[0]?.severity, 'bad', '差了一年多 ⇒ bad（就是时间幻觉）')
})

test('漂移：相对表述不参与判定（它们需要锚点，硬比会误报）', () => {
  const findings = findDrift(extractTimeClaims('三天前我们聊过。', NOW, SH), NOW)
  assert.equal(findings.length, 0)
})

test('结论：给出最大偏差与方向，便于人一眼判断', () => {
  const claims = extractTimeClaims('现在是 14:23，另外今天是 2024年3月15日。', NOW, SH)
  const findings = findDrift(claims, NOW)
  const verdict = describeDrift(findings)
  assert.match(verdict, /共 \d+ 处/)
  assert.match(verdict, /最大偏差/)
  assert.match(verdict, /偏早|偏晚/)
  assert.match(verdict, /2024年3月15日/, '要把最严重的那条原文带出来（便于复核）')
  assert.equal(describeDrift([]), '没有可判定的时间表述（或都在容差内）。')
})

test('保守性：普通句子不会被误抽', () => {
  const text = '我今天很开心，代码写了 300 行，版本号 1.2.3，端口 8080。'
  const claims = extractTimeClaims(text, NOW, SH)
  // 只允许"今天"这类相对表述被标记，不能抽出绝对时刻
  assert.ok(claims.every((c) => c.relative || c.at === undefined), `不该抽出绝对时刻，实际：${JSON.stringify(claims)}`)
  assert.ok(!claims.some((c) => c.text.includes('8080')), '端口号不是时间')
  assert.ok(!claims.some((c) => c.text.includes('1.2.3')), '版本号不是时间')
})
