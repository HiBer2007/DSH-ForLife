/**
 * 时间感知的纯逻辑测试。
 *
 * 守两件容易被"看起来对"骗过去的事：
 *  ① **时区换算**：夏令时、偏移格式、午夜 24 点这些边界；
 *  ② **注入判定的顺序**：强事件（压缩后/唤醒/跨天/首步）必须优先于时间间隔 ——
 *     反过来就会退化成宿主那个"10 分钟节流"的毛病（压缩后一条新鲜读数都没有）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dateBounds,
  decideInjection,
  defaultClockSettings,
  describeReason,
  formatHuman,
  formatIsoWithOffset,
  formatRelative,
  isFresh,
  readingAgeMs,
  renderTimeBlock,
  zonedParts,
} from '../src/clock.ts'

const SH = 'Asia/Shanghai'
const UTC = 'UTC'

test('时区换算：东八区的 ISO 带正确偏移', () => {
  const at = new Date('2026-10-05T06:23:01.000Z')
  assert.equal(formatIsoWithOffset(at, SH), '2026-10-05T14:23:01+08:00')
  assert.equal(formatIsoWithOffset(at, UTC), '2026-10-05T06:23:01+00:00')
})

test('时区换算：人类可读带星期，24/12 小时制都对', () => {
  const at = new Date('2026-10-05T06:23:01.000Z') // 东八区 10-05 14:23，周一
  assert.equal(formatHuman(at, SH, true), '2026-10-05 Mon 14:23')
  const pm = formatHuman(new Date('2026-10-05T12:30:00.000Z'), SH, false) // 东八区 20:30
  assert.match(pm, /8:30 PM/)
  const am = formatHuman(new Date('2026-10-04T22:05:00.000Z'), SH, false) // 东八区 06:05
  assert.match(am, /6:05 AM/)
  const midnight = formatHuman(new Date('2026-10-05T16:00:00.000Z'), SH, false) // 东八区 00:00
  assert.match(midnight, /12:00 AM/, '午夜要显示 12:00 AM 而不是 0:00 AM')
})

test('时区换算：夏令时地区按当天规则算（不写死偏移）', () => {
  // 纽约：2026-03-08 是夏令时开始；3 月 1 日仍是 EST(-05:00)，3 月 15 日是 EDT(-04:00)
  const winter = formatIsoWithOffset(new Date('2026-03-01T12:00:00.000Z'), 'America/New_York')
  const summer = formatIsoWithOffset(new Date('2026-03-15T12:00:00.000Z'), 'America/New_York')
  assert.match(winter, /-05:00$/, `冬令时应当是 -05:00，实际 ${winter}`)
  assert.match(summer, /-04:00$/, `夏令时应当是 -04:00，实际 ${summer}`)
})

test('相对时间：从秒到年，措辞是人话', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const before = (ms: number): string => formatRelative(new Date(now.getTime() - ms), now)
  assert.equal(before(5_000), '5s ago')
  assert.equal(before(3 * 60_000), '3 min ago')
  assert.equal(before(3 * 3600_000), '3h ago')
  assert.equal(before(3 * 86_400_000), '3d ago')
  assert.equal(before(70 * 86_400_000), '2mo ago')
  assert.equal(before(800 * 86_400_000), '2y ago')
})

test('相对时间：未来的时间戳如实说"之后"（对方时钟可能快），不悄悄取绝对值', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const ahead = formatRelative(new Date(now.getTime() + 120_000), now)
  assert.match(ahead, /2 min in the future/)
  assert.match(ahead, /clock may be ahead/)
})

test('日期边界：今天起止、本周起点（周一算第一天）与跨天判定', () => {
  // 2026-10-05 是周一
  const monday = new Date('2026-10-05T06:00:00.000Z') // 东八区 14:00 周一
  const bounds = dateBounds(monday, SH)
  assert.equal(bounds.weekday, 'Mon')
  assert.equal(bounds.todayStart, '2026-10-05 00:00')
  assert.equal(bounds.weekStart, '2026-10-05', '周一当天本周就从今天开始')
  assert.equal(bounds.isNewDay, false, '没给上一次读数时不该报跨天')

  // 周日（10-11）往前推应当是 10-05
  const sunday = dateBounds(new Date('2026-10-11T06:00:00.000Z'), SH)
  assert.equal(sunday.weekday, 'Sun')
  assert.equal(sunday.weekStart, '2026-10-05', '周日的本周起点仍是那个周一')

  // 跨天：东八区 10-05 23:50 → 10-06 00:10
  const cross = dateBounds(new Date('2026-10-05T16:10:00.000Z'), SH, new Date('2026-10-05T15:50:00.000Z'))
  assert.equal(cross.isNewDay, true, '跨过会话时区的午夜必须判定为跨天')
})

test('注入判定：从未注入过 ⇒ 必注入（否则模型手里一个读数都没有）', () => {
  const decision = decideInjection({ now: new Date('2026-10-05T12:00:00.000Z'), isTurnFirstStep: true })
  assert.equal(decision.inject, true)
  assert.equal(decision.reason, 'turn-first')
})

test('注入判定：每轮首步必注入（保证每个用户可见轮次都有新读数）', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const decision = decideInjection({
    now,
    lastReadingAt: new Date(now.getTime() - 1_000), // 1 秒前刚读过
    isTurnFirstStep: true,
  })
  assert.equal(decision.inject, true)
  assert.equal(decision.reason, 'turn-first', '首步优先于间隔（间隔是给同轮后续步用的）')
})

test('注入判定：顺序 —— 强事件优先于间隔（这是宿主那个 bug 的解药）', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const justRead = new Date(now.getTime() - 1_000)

  assert.equal(decideInjection({ now, lastReadingAt: justRead, isTurnFirstStep: false, compactedSinceLastReading: true }).reason, 'after-compaction')
  assert.equal(decideInjection({ now, lastReadingAt: justRead, isTurnFirstStep: false, wokeSinceLastReading: true }).reason, 'after-wake')
  // 跨天：上一次读数在前一天
  const yesterday = new Date(now.getTime() - 20 * 3600_000)
  assert.equal(decideInjection({ now, lastReadingAt: yesterday, isTurnFirstStep: false }).reason, 'date-boundary')
})

test('注入判定：长期空闲后的首条消息必注入（自唤醒可能隔几小时/几天）', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const decision = decideInjection({
    now,
    lastReadingAt: new Date(now.getTime() - 30_000),
    lastInteractionAt: new Date(now.getTime() - 3 * 3600_000),
    isTurnFirstStep: false,
  })
  assert.equal(decision.inject, true)
  assert.equal(decision.reason, 'after-idle')
})

test('注入判定：同轮后续步 —— 未跨间隔就跳过，且**说清为什么跳过**', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const decision = decideInjection({
    now,
    lastReadingAt: new Date(now.getTime() - 30_000),
    lastInteractionAt: new Date(now.getTime() - 60_000),
    isTurnFirstStep: false,
    intervalMs: 300_000,
  })
  assert.equal(decision.inject, false)
  assert.match(decision.skipReason ?? '', /since the last reading/)
  assert.match(String(decision.skipReason), /30s ago/)
  assert.match(String(decision.skipReason), /5 min/, '要说清阈值，排障时不用翻代码')
})

test('注入判定：跨过间隔就注入', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const decision = decideInjection({
    now,
    lastReadingAt: new Date(now.getTime() - 6 * 60_000),
    isTurnFirstStep: false,
    intervalMs: 300_000,
  })
  assert.equal(decision.inject, true)
  assert.equal(decision.reason, 'interval')
})

test('新鲜度：读数年龄与 30 秒判据（验收要求）', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  assert.equal(readingAgeMs(new Date(now.getTime() - 10_000), now), 10_000)
  assert.equal(isFresh(new Date(now.getTime() - 10_000), now), true)
  assert.equal(isFresh(new Date(now.getTime() - 31_000), now), false)
  assert.equal(readingAgeMs(new Date(now.getTime() + 5_000), now), 0, '未来时间戳不该算出负年龄')
})

test('时间块：权威式措辞 + 三个锚点 + 明确的裁决规则', () => {
  const now = new Date('2026-10-05T06:23:01.000Z')
  const block = renderTimeBlock({
    now,
    timezone: SH,
    reason: 'after-wake',
    lastInteractionAt: new Date(now.getTime() - 3 * 3600_000),
    lastActionAt: new Date(now.getTime() - 2 * 3600_000),
    lastReadingAt: new Date(now.getTime() - 10 * 60_000),
  })
  assert.match(block, /time reading/)
  assert.match(block, /authoritative/)
  assert.match(block, /now: 2026-10-05 Mon 14:23/)
  assert.match(block, /\+08:00/)
  assert.match(block, /since last interaction: 3h ago/)
  assert.match(block, /since last action: 2h ago/)
  assert.match(block, /previous reading: 10 min ago/)
  assert.match(block, /today: from 2026-10-05 00:00/)
  assert.match(block, /you were just woken/, '要说清本次为什么给读数')
  assert.match(
      block,
      /do not infer "now" from your training data/,
      '必须写死裁决规则（否则模型还是用自己的先验）',
    )
})

test('原因说明覆盖全部分支（漏一个会显示 undefined）', () => {
  for (const reason of ['turn-first', 'interval', 'date-boundary', 'after-compaction', 'after-wake', 'after-idle', 'manual'] as const) {
    const text = describeReason(reason)
    assert.ok(text.length > 2, `${reason} 缺说明`)
    assert.ok(!text.includes('undefined'))
  }
})

test('默认设置：记录用 UTC，会话默认东八区（用户拍板）', () => {
  const settings = defaultClockSettings()
  assert.equal(settings.systemTimezone, 'UTC')
  assert.equal(settings.conversationTimezone, 'Asia/Shanghai')
  assert.equal(settings.hour24, true)
})

test('边界：UTC 时区自身不产生偏移漂移', () => {
  const p = zonedParts(new Date('2026-01-01T00:00:00.000Z'), UTC)
  assert.equal(p.year, 2026)
  assert.equal(p.month, 1)
  assert.equal(p.day, 1)
  assert.equal(p.hour, 0)
})
