/**
 * 阈值触发的守卫测试（验收标准 #4）。
 *
 * ## 最值得守的四条
 *
 * 1. **最小条数要先过** —— 3 条碎片占 30% 是**噪音**，不是信号。
 * 2. **时间兜底必须存在** —— 只看占比的话，永远达不到阈值的库会**永远不清理**，
 *    而碎片是**只增不减**的（每次压缩都产生一批）。
 * 3. **上次清理时间要跨重启保留** —— 否则每次重启都触发一次时间兜底。
 * 4. **没碎片就不动手**（而不是"占比 0% ≥ 0%"这种边界误判）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  fragmentThresholdFromEnv,
  LAST_FRAGMENT_CLEAN_KEY,
  markFragmentCleaned,
  shouldRunFragmentMaintenance,
} from '../src/fragment-threshold.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

function setup(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

function addMid(opened: ReturnType<typeof openDatabase>, id: string, status: string): void {
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries
         (id, entry_type, summary, entities, token_count, window_offset, status, compaction_epoch, source_short_ids, created_at, storage_tier, revision)
       VALUES (?, 'semantic', ?, '[]', 100, 0, ?, 1, '[]', ?, 'hot', 1)`,
    )
    .run(id, `摘要 ${id}`, status, AT.toISOString())
}

test('★ 没碎片 ⇒ 不动手（不是"占比 0% ≥ 0%"那种边界误判）', () => {
  const opened = setup()
  try {
    addMid(opened, 'a1', 'active')
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, AT)
    assert.equal(d.shouldRun, false)
    assert.match(d.reason, /没有碎片/)
  } finally {
    opened.db.close()
  }
})

test('★ **最小条数要先过**：3 条碎片占 30% 是噪音，不是信号', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 3; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 7; i += 1) addMid(opened, `a${String(i)}`, 'active')
    // 占比 30% ≥ 20%，但条数 3 < 100 ⇒ **不该动手**
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, AT)
    assert.equal(d.shouldRun, false, `占比 30% 但只有 3 条，不该动手（实际：${d.reason}）`)
    assert.match(d.reason, /太少/, '**兜底也不该绕过最小条数**（测试暴露的那个设计问题）')
  } finally {
    opened.db.close()
  }
})

test('★ 占比超阈值且条数够 ⇒ 动手', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 300; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 700; i += 1) addMid(opened, `a${String(i)}`, 'active')
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, AT)
    assert.equal(d.shouldRun, true)
    assert.match(d.reason, /占比/)
    assert.equal(d.fragmented, 300)
    assert.equal(d.active, 700)
    assert.ok(Math.abs(d.ratio - 0.3) < 0.001)
  } finally {
    opened.db.close()
  }
})

test('★ 占比不到阈值，但**从未清理过** ⇒ 时间兜底触发', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 200; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 9800; i += 1) addMid(opened, `a${String(i)}`, 'active')
    // 占比 2% < 20% ⇒ 占比不触发；但从未清理过 ⇒ 兜底触发
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, AT)
    assert.equal(d.shouldRun, true)
    assert.match(d.reason, /从未清理过/)
  } finally {
    opened.db.close()
  }
})

test('★ 刚清理过 + 占比不到 ⇒ **不动手**（时间兜底也要有间隔）', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 200; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 9800; i += 1) addMid(opened, `a${String(i)}`, 'active')
    markFragmentCleaned(opened.db, AT)
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, AT)
    assert.equal(d.shouldRun, false, `刚清理过不该再动手（实际：${d.reason}）`)
    assert.match(d.reason, /未到阈值且未过期/)
  } finally {
    opened.db.close()
  }
})

test('★ 清理时间**跨重启保留**（否则每次重启都触发一次兜底）', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 200; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 9800; i += 1) addMid(opened, `a${String(i)}`, 'active')
    markFragmentCleaned(opened.db, AT)
    // 模拟重启：同一份数据，新的判定（DB 是同一个，"重启"体现为重新读 state）
    const stored = opened.db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(LAST_FRAGMENT_CLEAN_KEY)
    assert.equal(stored?.value, AT.toISOString(), '清理时间要落进 forlife_state（**跨重启保留**）')
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, new Date(AT.getTime() + 60_000))
    assert.equal(d.shouldRun, false, '重启后不该立刻又触发兜底')
  } finally {
    opened.db.close()
  }
})

test('★ 超过 staleDays ⇒ 兜底再次触发', () => {
  const opened = setup()
  try {
    // **占比要低于阈值**，否则占比先生效、走不到兜底那条分支
    for (let i = 0; i < 200; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 9800; i += 1) addMid(opened, `a${String(i)}`, 'active')
    markFragmentCleaned(opened.db, AT)
    const later = new Date(AT.getTime() + 8 * 86_400_000) // 8 天 > 7 天
    const d = shouldRunFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_THRESHOLD, later)
    assert.equal(d.shouldRun, true)
    assert.match(d.reason, /距上次清理/)
  } finally {
    opened.db.close()
  }
})

test('ratio = 0 ⇒ 不按占比触发（策略关闭），但兜底仍在', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 900; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 100; i += 1) addMid(opened, `a${String(i)}`, 'active')
    // 占比 90%，但 ratio=0 ⇒ 不按占比
    const d = shouldRunFragmentMaintenance(opened.db, { ratio: 0, minCount: 0, staleDays: 7 }, AT)
    assert.equal(d.shouldRun, true, '从未清理过 ⇒ 兜底仍要触发')
    assert.match(d.reason, /从未清理过/, '**不能**是"占比触发"')
  } finally {
    opened.db.close()
  }
})

test('staleDays = 0 ⇒ 不按时间兜底（两条都关就是"永远不动手"）', () => {
  const opened = setup()
  try {
    for (let i = 0; i < 200; i += 1) addMid(opened, `f${String(i)}`, 'fragmented')
    for (let i = 0; i < 9800; i += 1) addMid(opened, `a${String(i)}`, 'active')
    const d = shouldRunFragmentMaintenance(opened.db, { ratio: 0.5, minCount: 100, staleDays: 0 }, AT)
    assert.equal(d.shouldRun, false)
  } finally {
    opened.db.close()
  }
})

test('fragmentThresholdFromEnv：默认值与非法值处理', () => {
  const d = fragmentThresholdFromEnv({})
  assert.equal(d.ratio, 0.2)
  assert.equal(d.minCount, 100)
  assert.equal(d.staleDays, 7)
  // 非法值回落到默认
  assert.equal(fragmentThresholdFromEnv({ FORLIFE_FRAGMENT_RATIO: 'abc' }).ratio, 0.2)
  assert.equal(fragmentThresholdFromEnv({ FORLIFE_FRAGMENT_RATIO: '-1' }).ratio, 0.2, '负数非法')
  // 合法值生效（**0 是合法的 = 关闭该条**）
  assert.equal(fragmentThresholdFromEnv({ FORLIFE_FRAGMENT_RATIO: '0' }).ratio, 0)
  assert.equal(fragmentThresholdFromEnv({ FORLIFE_FRAGMENT_MIN_COUNT: '500' }).minCount, 500)
})
