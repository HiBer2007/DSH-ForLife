/**
 * 碎片维护的守卫测试（PLAN 阶段 9 交付物 4）。
 *
 * ## 最值得守的四条（都是"删错就没救"）
 *
 * 1. **只淘汰 `status='fragmented'`** —— `active` 是还没被代表的原始记忆，删了真的丢。
 * 2. **归宿没了必须留着** —— 那些碎片是那件事的**唯一副本**。
 * 3. **保留期** —— 刚沉淀完就删的话，"长期记忆写得对不对"还没人验证过，
 *    而那时碎片是唯一的对照物。
 * 4. **执行时要再过一遍红线** —— 计划算出来到执行之间，归宿可能刚被删。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import {
  DEFAULT_FRAGMENT_POLICY,
  evictFragments,
  mergeFragmentIndex,
  planFragmentMaintenance,
} from '../src/fragment-maintenance.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

/** 造一个 db。 */
function setup(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

/** 插一条长期记忆。 */
function addLong(opened: ReturnType<typeof openDatabase>, id: string): void {
  opened.db
    .prepare(
      `INSERT INTO long_memory_entries (id, content, summary, entities, source_mid_ids, storage_tier, status, created_at)
       VALUES (?, '内容', '摘要', '[]', '[]', 'hot', 'active', ?)`,
    )
    .run(id, AT.toISOString())
}

/** 插一条 mid 记忆。 */
function addMid(
  opened: ReturnType<typeof openDatabase>,
  id: string,
  opts: { status: string; into: string | null; daysAgo?: number; tokens?: number },
): void {
  const created = new Date(AT.getTime() - (opts.daysAgo ?? 0) * 86_400_000).toISOString()
  opened.db
    .prepare(
      `INSERT INTO mid_memory_entries
         (id, entry_type, summary, entities, token_count, window_offset, status, fragmented_into, compaction_epoch, source_short_ids, created_at, storage_tier, revision)
       VALUES (?, 'semantic', ?, '[]', ?, 0, ?, ?, 1, '[]', ?, 'hot', 1)`,
    )
    .run(id, `摘要 ${id}`, opts.tokens ?? 100, opts.status, opts.into, created)
}

test('★ 只淘汰 fragmented —— active 是原始记忆，删了真的丢', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M-active', { status: 'active', into: null, daysAgo: 999 })
    addMid(opened, 'M-frag', { status: 'fragmented', into: 'L1', daysAgo: 999 })

    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 1)
    assert.equal(plan.evictable[0]?.id, 'M-frag')

    const r = evictFragments(opened.db, ['M-active', 'M-frag'])
    assert.equal(r.evicted, 1)
    assert.equal(r.refused.length, 1)
    assert.match(r.refused[0]?.reason ?? '', /只有 fragmented 才能淘汰/)
    // active 那条必须还在
    const still = opened.db.prepare("SELECT COUNT(*) AS n FROM mid_memory_entries WHERE id = 'M-active'").get()
    assert.equal(still?.n, 1, '**active 绝不能被删**')
  } finally {
    opened.db.close()
  }
})

test('★ 归宿已丢 ⇒ **必须留着**（它是那件事的唯一副本）', () => {
  const opened = setup()
  try {
    // fragmented_into 指向一个不存在的长期记忆
    addMid(opened, 'M-orphan', { status: 'fragmented', into: 'L-gone', daysAgo: 999 })

    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 0, '归宿没了不该进可淘汰列表')
    assert.equal(plan.orphaned.length, 1, '要进"归宿已丢"列表（界面能看见）')
    assert.match(plan.reason, /归宿已丢/)

    const r = evictFragments(opened.db, ['M-orphan'])
    assert.equal(r.evicted, 0)
    assert.match(r.refused[0]?.reason ?? '', /唯一副本/)
    const still = opened.db.prepare("SELECT COUNT(*) AS n FROM mid_memory_entries WHERE id = 'M-orphan'").get()
    assert.equal(still?.n, 1)
  } finally {
    opened.db.close()
  }
})

test('★ 保留期：刚沉淀的**不淘汰**（那时碎片是唯一的对照物）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M-fresh', { status: 'fragmented', into: 'L1', daysAgo: 1 })

    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 0)
    assert.equal(plan.tooYoung, 1)
    assert.match(plan.reason, /未到保留期/)
  } finally {
    opened.db.close()
  }
})

test('★ 执行时要**再过一遍红线**（计划到执行之间归宿可能被删了）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M1', { status: 'fragmented', into: 'L1', daysAgo: 999 })

    // 先算计划（那时 L1 还在 ⇒ 可淘汰）
    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 1)

    // 计划之后、执行之前，L1 被删了
    opened.db.prepare("DELETE FROM long_memory_entries WHERE id = 'L1'").run()

    const r = evictFragments(opened.db, plan.evictable.map((f) => f.id))
    assert.equal(r.evicted, 0, '**执行时必须重新检查**，不能只信计划')
    assert.match(r.refused[0]?.reason ?? '', /归宿.*已不存在/)
  } finally {
    opened.db.close()
  }
})

test('★ 没有归宿标记的（fragmented_into 为空）**不算碎片**，既不淘汰也不动', () => {
  const opened = setup()
  try {
    addMid(opened, 'M-nohome', { status: 'fragmented', into: null, daysAgo: 999 })
    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 0)
    assert.equal(plan.orphaned.length, 0, '它不该进"归宿已丢" —— 它压根没有归宿')
    assert.match(plan.reason, /无归宿标记/)
  } finally {
    opened.db.close()
  }
})

test('★ limit 生效（防一次删太多把 WAL 撑爆）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    for (let i = 0; i < 10; i += 1) {
      addMid(opened, `M${String(i)}`, { status: 'fragmented', into: 'L1', daysAgo: 999 })
    }
    const plan = planFragmentMaintenance(opened.db, { keepDays: 30, limit: 3 }, AT)
    assert.equal(plan.evictable.length, 3)
  } finally {
    opened.db.close()
  }
})

test('★ keepDays = 0 ⇒ 不按时间淘汰（策略关闭）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M-fresh', { status: 'fragmented', into: 'L1', daysAgo: 0 })
    const plan = planFragmentMaintenance(opened.db, { keepDays: 0, limit: 100 }, AT)
    assert.equal(plan.evictable.length, 1, 'keepDays=0 时不该按时间拦')
  } finally {
    opened.db.close()
  }
})

test('★ 合并索引**不动数据**（所以可以随便跑）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M1', { status: 'fragmented', into: 'L1', daysAgo: 999 })
    const before = opened.db.prepare('SELECT COUNT(*) AS n FROM mid_memory_entries').get()?.n
    const r = mergeFragmentIndex(opened.db)
    assert.equal(r.ok, true, r.reason)
    const after = opened.db.prepare('SELECT COUNT(*) AS n FROM mid_memory_entries').get()?.n
    assert.equal(after, before, '**合并不该删任何行**')
  } finally {
    opened.db.close()
  }
})

test('可回收 token 会算出来（面板要显示"能省多少"）', () => {
  const opened = setup()
  try {
    addLong(opened, 'L1')
    addMid(opened, 'M1', { status: 'fragmented', into: 'L1', daysAgo: 999, tokens: 300 })
    addMid(opened, 'M2', { status: 'fragmented', into: 'L1', daysAgo: 999, tokens: 200 })
    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.reclaimableTokens, 500)
  } finally {
    opened.db.close()
  }
})

test('空库 ⇒ 计划是空的，不是报错', () => {
  const opened = setup()
  try {
    const plan = planFragmentMaintenance(opened.db, DEFAULT_FRAGMENT_POLICY, AT)
    assert.equal(plan.evictable.length, 0)
    assert.equal(plan.reclaimableTokens, 0)
  } finally {
    opened.db.close()
  }
})
