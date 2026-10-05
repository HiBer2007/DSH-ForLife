/**
 * 唤醒条件矩阵的测试 —— 用**固定随机序列**做统计断言，用真库做状态断言。
 *
 * 这里守的是用户亲口定的默认值，所以每一条都写清"为什么是这个数"：
 * 群聊零唤醒、私聊 80%、临时 20%、@我 100%、拍一拍 100%、**@全体 50% 独立算**。
 * 最关键的一条是"三条件互不派生"—— 它一旦退化，用户最在意的隐私边界就没了。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { decideWake, listWakeRules, pendingStats, readPending, recordPending, seedWakeRules, setWakeRule, type WakeCondition } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-wake-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
})

after(async () => {
  close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/**
 * 宽预算：**全局预算是共享资源**，上面那些上千次的统计测试会把默认的每小时 30 次额度用光，
 * 导致后面期望"能唤醒"的用例被 budget 拦下。凡是期望唤醒的用例都必须显式给宽预算，
 * 并清楚自己不是在测预算本身。
 */
const GENEROUS_BUDGET = { globalPerHour: 1_000_000, globalPerDay: 1_000_000 } as const

/** 固定序列随机数（可复算）。 */
function sequence(values: readonly number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index += 1
    return value
  }
}

/** 跑 N 次判定，返回唤醒次数。 */
function runMany(condition: WakeCondition, scope: string, count: number, random: () => number): number {
  let wakes = 0
  for (let i = 0; i < count; i++) {
    const verdict = decideWake(
      db,
      { scope, condition, conversationKey: `${scope}#c${String(i)}`, summary: `第 ${String(i)} 条` },
      { random, budget: { globalPerHour: 10_000, globalPerDay: 10_000 } },
    )
    if (verdict.decision === 'wake') wakes += 1
  }
  return wakes
}

test('默认值：与用户拍板的一致（群聊零唤醒 / 私聊 80% / 临时 20%）', () => {
  const rules = listWakeRules(db, '*')
  const find = (condition: WakeCondition): { enabled: boolean; probability: number } => {
    const rule = rules.find((r) => r.condition === condition)
    assert.ok(rule !== undefined, `缺少条件 ${condition}`)
    return rule
  }
  assert.equal(find('group_message_any').enabled, false, '群聊里任何消息默认不唤醒')
  assert.equal(find('group_message_any').probability, 0, '群聊条件不仅关，概率也是 0（双保险）')
  assert.equal(find('private_message').probability, 80, '私聊 80%')
  assert.equal(find('temp_message').probability, 20, '临时会话 20%')
  assert.equal(find('group_mention').probability, 100, '@我 100%')
  assert.equal(find('group_poke').probability, 100, '拍一拍 100%')
  assert.equal(find('group_mention_all').probability, 50, '@全体成员 50%（独立条件）')
})

test('统计：私聊命中率 ≈80%（1000 次均匀随机）', () => {
  // 均匀序列 [0,1,...,0.999] 循环 ⇒ 命中数应精确等于 < 0.8 的个数
  const values = Array.from({ length: 1000 }, (_, i) => i / 1000)
  const wakes = runMany('private_message', 'private:10001', 1000, sequence(values))
  assert.equal(wakes, 800, '阈值 80 时，均匀随机数中小于 0.8 的恰好 800 个')
})

test('统计：临时会话命中率 ≈20%', () => {
  const values = Array.from({ length: 1000 }, (_, i) => i / 1000)
  assert.equal(runMany('temp_message', 'private:10002', 1000, sequence(values)), 200)
})

test('统计：@全体成员独立按 50%（验收要求 35–65 区间）', () => {
  const values = Array.from({ length: 1000 }, (_, i) => i / 1000)
  const wakes = runMany('group_mention_all', 'group:88888', 1000, sequence(values))
  assert.equal(wakes, 500, '均匀随机下 50% 应为 500')

  // 用真随机再跑一次，断言落在验收区间（真随机会抖动，区间才是真的在测概率）
  const randomWakes = runMany('group_mention_all', 'group:88889', 100, Math.random)
  assert.ok(randomWakes >= 35 && randomWakes <= 65, `100 条 @全体 应唤醒 35–65 次，实际 ${String(randomWakes)}`)
})

test('统计：@我 100%（100 条必须 100 次）', () => {
  assert.equal(runMany('group_mention', 'group:88888', 100, Math.random), 100, '被 @ 必须每次都醒')
})

test('统计：群聊普通消息 100 条零唤醒（默认群聊零唤醒）', () => {
  assert.equal(runMany('group_message_any', 'group:88888', 100, Math.random), 0)
})

test('互不派生：同群三条件各判各的（关普通消息、开 @我、关拍一拍）', () => {
  const scope = 'group:77777'
  setWakeRule(db, scope, 'group_message_any', { enabled: false }, 'admin')
  setWakeRule(db, scope, 'group_mention', { enabled: true, probability: 100 }, 'admin')
  setWakeRule(db, scope, 'group_poke', { enabled: false }, 'admin')

  // 普通消息 100 条：零唤醒
  for (let i = 0; i < 100; i++) {
    const verdict = decideWake(db, { scope, condition: 'group_message_any', conversationKey: scope, summary: `闲聊 ${String(i)}` }, { random: () => 0 })
    assert.equal(verdict.decision, 'skip')
    assert.equal(verdict.reason, 'disabled')
  }
  // @我：立即唤醒
  assert.equal(
    decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0.99, budget: GENEROUS_BUDGET }).decision,
    'wake',
  )
  // 拍一拍：不唤醒（即使随机数为 0）
  const poke = decideWake(db, { scope, condition: 'group_poke', conversationKey: scope }, { random: () => 0 })
  assert.equal(poke.decision, 'skip')
  assert.equal(poke.reason, 'disabled', '拍一拍关掉就是关掉，不能因为别的条件开着就被唤醒')

  // 关键：被跳过的 100 条闲聊必须都进了待读池（"不唤醒 ≠ 不知道"）
  const pending = readPending(db, { scope, limit: 200, markRead: false })
  assert.equal(pending.length, 100, '零唤醒但摘要必须能在待读池里读到')
})

test('待读池：readPending 默认标记已读，重复读不再返回', () => {
  const scope = 'group:66666'
  recordPending(db, { scope, conversationKey: scope, summary: '第一条', senderName: '老王' })
  recordPending(db, { scope, conversationKey: scope, summary: '第二条' })
  const first = readPending(db, { scope })
  assert.equal(first.length, 2)
  assert.equal(first[0]?.summary, '第一条', '按时间升序（阅读顺序）')
  assert.equal(first[0]?.senderName, '老王')
  assert.equal(readPending(db, { scope }).length, 0, '读过的不该再返回')
  const stats = pendingStats(db)
  assert.ok(stats.total >= 102)
})

test('待读池：超出容量时丢最旧的（有界）', () => {
  const scope = 'group:55555'
  for (let i = 0; i < 210; i++) {
    recordPending(db, { scope, conversationKey: scope, summary: `消息 ${String(i)}`, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
  }
  const items = readPending(db, { scope, limit: 500, markRead: false })
  assert.ok(items.length <= 200, `单 scope 上限应为 200，实际 ${String(items.length)}`)
  assert.ok(!items.some((i) => i.summary === '消息 0'), '最旧的应当被丢弃')
  assert.ok(items.some((i) => i.summary === '消息 209'), '最新的必须保留')
})

test('限流：日限与最小间隔生效，且原因可区分', () => {
  const scope = 'group:44444'
  setWakeRule(db, scope, 'group_mention', { enabled: true, probability: 100, dailyLimit: 2 }, 'admin')
  const now = new Date('2026-10-05T12:00:00.000Z')
  const opts = { now, random: () => 0, budget: GENEROUS_BUDGET }
  assert.equal(decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, opts).decision, 'wake')
  assert.equal(decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, opts).decision, 'wake')
  const third = decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, opts)
  assert.equal(third.decision, 'skip')
  assert.equal(third.reason, 'daily_limit')

  // 最小间隔：换一个 scope，避免受上面日限影响
  const scope2 = 'group:44445'
  setWakeRule(db, scope2, 'group_mention', { enabled: true, probability: 100, minIntervalMs: 60_000 }, 'admin')
  assert.equal(decideWake(db, { scope: scope2, condition: 'group_mention', conversationKey: scope2 }, { ...opts }).decision, 'wake')
  const tooSoon = decideWake(db, { scope: scope2, condition: 'group_mention', conversationKey: scope2 }, { now: new Date(now.getTime() + 30_000), random: () => 0, budget: GENEROUS_BUDGET })
  assert.equal(tooSoon.reason, 'min_interval')
  assert.equal(
    decideWake(db, { scope: scope2, condition: 'group_mention', conversationKey: scope2 }, { now: new Date(now.getTime() + 61_000), random: () => 0, budget: GENEROUS_BUDGET }).decision,
    'wake',
  )
})

test('静默期：quietUntil 之前一律不唤醒', () => {
  const scope = 'group:33333'
  const until = new Date(Date.now() + 3600_000).toISOString()
  setWakeRule(db, scope, 'group_mention', { enabled: true, probability: 100, quietUntil: until }, 'model')
  const verdict = decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0 })
  assert.equal(verdict.decision, 'skip')
  assert.equal(verdict.reason, 'quiet_hours')
})

test('全局预算：超过每小时上限后即便概率过了也不唤醒', () => {
  const scope = 'group:22222'
  setWakeRule(db, scope, 'group_mention', { enabled: true, probability: 100 }, 'admin')
  // 预算统计的是**全局** wake_events，而前面上千次统计测试已经把计数堆起来了。
  // 想测"预算刚好用完"的边界，就必须先把共享计数清零（等价于"新的一小时开始了"）。
  db.exec('DELETE FROM wake_events')
  // 预算设为 1：第一次唤醒，第二次因预算被拦
  assert.equal(
    decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0, budget: { globalPerHour: 1, globalPerDay: 1 } }).decision,
    'wake',
  )
  const blocked = decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0, budget: { globalPerHour: 1, globalPerDay: 1 } })
  assert.equal(blocked.decision, 'skip')
  assert.equal(blocked.reason, 'budget')
})

test('概率为 0 或关闭都归为 disabled（模型/后台可以一键静音某条件）', () => {
  const scope = 'group:11111'
  setWakeRule(db, scope, 'group_mention', { probability: 0 }, 'model')
  assert.equal(decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0 }).reason, 'disabled')
  setWakeRule(db, scope, 'group_mention', { enabled: false, probability: 100 }, 'model')
  assert.equal(decideWake(db, { scope, condition: 'group_mention', conversationKey: scope }, { random: () => 0 }).reason, 'disabled')
})

test('规则作用域：精确 scope 覆盖全局，回落后仍能取到全局值', () => {
  setWakeRule(db, '*', 'temp_message', { probability: 20 }, 'admin')
  setWakeRule(db, 'private:99999', 'temp_message', { probability: 90 }, 'model')
  assert.equal(listWakeRules(db, 'private:99999').find((r) => r.condition === 'temp_message')?.probability, 90)
  assert.equal(listWakeRules(db, 'private:12345').find((r) => r.condition === 'temp_message')?.probability, 20, '别的 scope 应回落到全局')
})

test('审计：wake_events 记录每次判定的原因（面板与排障的命根子）', () => {
  const before = (db.prepare('SELECT count(*) AS n FROM wake_events').get() as { n: number }).n
  decideWake(db, { scope: 'group:10101', condition: 'group_message_any', conversationKey: 'group:10101', summary: 'x' }, { random: () => 0 })
  const after = (db.prepare('SELECT count(*) AS n FROM wake_events').get() as { n: number }).n
  assert.equal(after, before + 1, '每次判定都要留痕')

  const row = db.prepare('SELECT * FROM wake_events ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown>
  assert.equal(row['decision'], 'skip')
  assert.equal(row['reason'], 'disabled')
  assert.equal(row['scope'], 'group:10101')
  assert.equal(row['condition'], 'group_message_any')
})

test('播种幂等：重复 seed 不覆盖已有规则', () => {
  const scope = 'group:12321'
  setWakeRule(db, scope, 'group_mention', { probability: 33 }, 'admin')
  seedWakeRules(db)
  assert.equal(listWakeRules(db, scope).find((r) => r.condition === 'group_mention')?.probability, 33, '播种不能覆盖用户的调整')
})

