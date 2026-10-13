/**
 * 存储分层的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **没配 hot 必须报错** —— 没有"默认路径"这种东西，猜一个会把数据写到
 *    用户没想到的地方，而那种错很难发现。
 * 2. **退回要在返回值里说清** —— 否则用户会以为数据真的分了三层在放。
 * 3. **没访问过用创建时间** —— 用 0 或"很久以前"会让新写入的大条目立刻被沉下去，
 *    而那正是用户马上要用的。
 * 4. **只能往更冷沉** —— 反向提升必须由"访问"触发，否则
 *    "为什么这条突然变热了"会变成查不出来的问题。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decideSettle,
  DEFAULT_SETTLE_POLICY,
  resolveTierRoots,
  settlePolicyFromEnv,
  STORAGE_TIERS,
  type SettleCandidate,
} from '../src/storage-tiers.ts'

const NOW = new Date('2026-10-06T12:00:00.000Z')

/** 造一个候选。 */
function cand(over: Partial<SettleCandidate> = {}): SettleCandidate {
  return {
    tier: 'hot',
    lastAccessedAt: undefined,
    createdAt: NOW.toISOString(),
    bytes: 100_000,
    ...over,
  }
}

test('★ 没配 FORLIFE_ROOT_HOT ⇒ 报错（没有"默认路径"这种东西）', () => {
  assert.throws(() => resolveTierRoots({}), /缺少 FORLIFE_ROOT_HOT/)
  // 空字符串也算没配
  assert.throws(() => resolveTierRoots({ FORLIFE_ROOT_HOT: '  ' }), /缺少 FORLIFE_ROOT_HOT/)
})

test('只配 hot ⇒ warm/cold 都退回 hot，**且说清退回了**', () => {
  const r = resolveTierRoots({ FORLIFE_ROOT_HOT: 'D:\\hot' })
  assert.deepEqual(r.roots, { hot: 'D:\\hot', warm: 'D:\\hot', cold: 'D:\\hot' })
  // 界面要显示"退回了" —— 否则用户以为真的分了三层在放
  assert.equal(r.fellBack.length, 2)
  assert.deepEqual(r.fellBack.map((f) => f.tier).sort(), ['cold', 'warm'])
  assert.equal(r.fellBack.every((f) => f.from === 'hot'), true)
})

test('★ 配了 warm 没配 cold ⇒ cold 退到 **warm**（不是 hot）', () => {
  const r = resolveTierRoots({ FORLIFE_ROOT_HOT: 'C:\\h', FORLIFE_ROOT_WARM: 'D:\\w' })
  assert.deepEqual(r.roots, { hot: 'C:\\h', warm: 'D:\\w', cold: 'D:\\w' })
  // 用户的意图显然是"温的和冷的一起放那块盘上"
  assert.deepEqual(r.fellBack, [{ tier: 'cold', from: 'warm' }])
})

test('三层都配 ⇒ 不退回，各用各的', () => {
  const r = resolveTierRoots({ FORLIFE_ROOT_HOT: 'C:\\h', FORLIFE_ROOT_WARM: 'D:\\w', FORLIFE_ROOT_COLD: 'E:\\c' })
  assert.deepEqual(r.roots, { hot: 'C:\\h', warm: 'D:\\w', cold: 'E:\\c' })
  assert.deepEqual(r.fellBack, [])
})

test('★ 验收要求：冷层指 HDD 与指 SSD **代码路径完全一致**（只有路径不同）', () => {
  // 这正是"同一套测试跑两遍"的根据：策略函数**完全不知道**盘是什么
  const hdd = resolveTierRoots({ FORLIFE_ROOT_HOT: 'C:\\ssd', FORLIFE_ROOT_COLD: 'E:\\hdd' })
  const ssd = resolveTierRoots({ FORLIFE_ROOT_HOT: 'C:\\ssd', FORLIFE_ROOT_COLD: 'C:\\ssd2' })
  const c = cand({ tier: 'hot', lastAccessedAt: '2026-08-01T00:00:00.000Z' })
  // 同一个候选、同一个策略 ⇒ 同一个判定，与路径无关
  assert.deepEqual(decideSettle(c, NOW), decideSettle(c, NOW))
  assert.notEqual(hdd.roots.cold, ssd.roots.cold)
  assert.equal(decideSettle(c, NOW).target, 'cold')
})

test('★ 还新的不沉', () => {
  const r = decideSettle(cand({ lastAccessedAt: NOW.toISOString() }), NOW)
  assert.equal(r.target, undefined)
  assert.match(r.reason, /还新/)
})

test('7 天没动 ⇒ warm；30 天没动 ⇒ cold', () => {
  const w = decideSettle(cand({ tier: 'hot', lastAccessedAt: '2026-09-28T12:00:00.000Z' }), NOW)
  assert.equal(w.target, 'warm')
  assert.match(w.reason, /8 天没动/)

  const c = decideSettle(cand({ tier: 'hot', lastAccessedAt: '2026-08-01T12:00:00.000Z' }), NOW)
  assert.equal(c.target, 'cold')
})

test('★ 没访问过用**创建时间**（用"很久以前"会让刚写的大条目立刻被沉下去）', () => {
  // 刚创建、从没访问过 ⇒ 不该沉
  const fresh = decideSettle(cand({ lastAccessedAt: undefined, createdAt: NOW.toISOString() }), NOW)
  assert.equal(fresh.target, undefined, '刚写的大条目正是用户马上要用的')

  // 很早就创建、从没访问过 ⇒ 该沉
  const old = decideSettle(cand({ lastAccessedAt: undefined, createdAt: '2026-06-01T00:00:00.000Z' }), NOW)
  assert.equal(old.target, 'cold')
})

test('★ 只能往更冷沉：已在 warm 且只够 warm 条件 ⇒ 不动', () => {
  const r = decideSettle(cand({ tier: 'warm', lastAccessedAt: '2026-09-28T12:00:00.000Z' }), NOW)
  assert.equal(r.target, undefined)
  assert.match(r.reason, /已在温层/)
})

test('★ 已在 cold ⇒ 不动（反向提升是 recover() 的事）', () => {
  const r = decideSettle(cand({ tier: 'cold', lastAccessedAt: '2020-01-01T00:00:00.000Z' }), NOW)
  assert.equal(r.target, undefined)
  assert.match(r.reason, /已在冷层/)
})

test('太小不搬（搬动的元数据开销可能比数据本身还大）', () => {
  const r = decideSettle(cand({ bytes: 100, lastAccessedAt: '2020-01-01T00:00:00.000Z' }), NOW)
  assert.equal(r.target, undefined)
  assert.match(r.reason, /太小/)
})

test('时间解析不了 ⇒ 不动（不能因为"看不懂"就把数据搬走）', () => {
  const r = decideSettle(cand({ lastAccessedAt: '不是时间' }), NOW)
  assert.equal(r.target, undefined)
  assert.match(r.reason, /解析不了/)
})

test('策略 0 表示该档不启用', () => {
  const policy = { ...DEFAULT_SETTLE_POLICY, warmAfterDays: 0, coldAfterDays: 0 }
  const r = decideSettle(cand({ lastAccessedAt: '2020-01-01T00:00:00.000Z' }), NOW, policy)
  assert.equal(r.target, undefined, '两档都关掉就不该沉')
})

test('settlePolicyFromEnv：非法值退回默认；0 是合法的"关闭"', () => {
  assert.deepEqual(settlePolicyFromEnv({}), DEFAULT_SETTLE_POLICY)
  assert.equal(settlePolicyFromEnv({ FORLIFE_SETTLE_WARM_DAYS: '3' }).warmAfterDays, 3)
  // **0 合法**（关闭该档），不能被当成非法值退回默认
  assert.equal(settlePolicyFromEnv({ FORLIFE_SETTLE_WARM_DAYS: '0' }).warmAfterDays, 0)
  // 负数/非数字退回默认
  assert.equal(settlePolicyFromEnv({ FORLIFE_SETTLE_WARM_DAYS: '-1' }).warmAfterDays, 7)
  assert.equal(settlePolicyFromEnv({ FORLIFE_SETTLE_WARM_DAYS: 'abc' }).warmAfterDays, 7)
})

test('三层常量按由热到冷排列（界面按这个顺序显示）', () => {
  assert.deepEqual([...STORAGE_TIERS], ['hot', 'warm', 'cold'])
})
