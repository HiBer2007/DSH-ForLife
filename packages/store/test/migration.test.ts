/**
 * 迁移机制的守卫测试（PLAN §2.4 + 阶段 9 交付物 2）。
 *
 * ## 最值得守的五条（都是"出错就难收拾"）
 *
 * 1. **只有 verified 才允许切换引用** —— 半个文件比没有文件更危险。
 * 2. **有未完成条目 ⇒ 不许标 done** —— 标了的话 `--resume` 再也接不上。
 * 3. **续传不重搬已 verified 的**（那是"可续传"的定义）。
 * 4. **回滚 = 切回旧根，不删新数据** —— 回滚是出事时才用的，那时最不该做危险的事。
 * 5. **锁靠心跳自愈** —— 崩溃留下的锁如果不会过期，系统永久拒绝写入。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import {
  acquireLock,
  activeLock,
  finishMigration,
  getMigrationRun,
  heartbeat,
  listResumable,
  LOCK_STALE_MS,
  migrateBatch,
  preflight,
  releaseLock,
  rollbackMigration,
  startMigration,
  switchReferences,
} from '../src/migration.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

function setup(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

function addBlob(opened: ReturnType<typeof openDatabase>, id: string, tier = 'hot'): void {
  opened.db
    .prepare(
      `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
       VALUES (?, ?, 'image', 'image/png', 1000, ?, ?, ?)`,
    )
    .run(id, id.padEnd(64, '0'), `D:\\${tier}\\${id}.png`, tier, AT.toISOString())
}

const TO_PATH = (sha: string, from: string): string => `D:\\cold\\${sha.slice(0, 2)}\\${sha}${from.slice(from.lastIndexOf('.'))}`

/** 起一个迁移。 */
function start(opened: ReturnType<typeof openDatabase>, count: number): string {
  for (let i = 0; i < count; i += 1) addBlob(opened, `B${String(i)}`)
  const r = startMigration(opened.db, {
    fromTier: 'hot',
    toTier: 'cold',
    fromRoot: 'D:\\hot',
    toRoot: 'D:\\cold',
    toPathFor: TO_PATH,
    now: AT,
  })
  assert.equal(r.ok, true, r.reason)
  return String(r.runId)
}

const okCopy = async (): Promise<{ ok: boolean; reason: string }> => ({ ok: true, reason: 'ok' })

test('★ Preflight：有活跃压缩事务 ⇒ 拒绝（会把"正在被写的引用"搬走）', () => {
  const opened = setup()
  try {
    opened.db
      .prepare(
        `INSERT INTO compaction_runs (id, compaction_id, session_id, phase, epoch_from, epoch_to, plan, started_at)
           VALUES ('c1', 'c1', 'onebot11:1', 'running', 1, 2, '{}', ?)`,
      )
      .run(AT.toISOString())
    const r = preflight(opened.db, { fromTier: 'hot', toTier: 'cold' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /压缩事务/)
  } finally {
    opened.db.close()
  }
})

test('★ Preflight：预留 10%（"搬到一半空间不够"是最难收拾的中断）', () => {
  const opened = setup()
  try {
    addBlob(opened, 'B1') // 1000 字节
    const r = preflight(opened.db, { fromTier: 'hot', toTier: 'cold' })
    assert.equal(r.items, 1)
    assert.equal(r.estimatedBytes, 1000)
    assert.equal(r.requiredBytes, 1100, '要预留 10%')
  } finally {
    opened.db.close()
  }
})

test('★ 复制失败 ⇒ **不标 verified**（下次续传会重试它）', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 2)
    const r = await migrateBatch(opened.db, {
     
      runId,
      copyFile: async ({ from }: { from: string }) => (from.includes('B0') ? { ok: false, reason: '磁盘满了' } : { ok: true, reason: 'ok' }),
      now: AT,
    })
    assert.equal(r.verified, 1)
    assert.equal(r.failed, 1)
    const states = opened.db.prepare('SELECT item_id, state FROM migration_journal ORDER BY item_id').all()
    assert.equal(states.find((s) => s.item_id === 'B0')?.state, 'pending', '失败的要留在 pending')
    assert.equal(states.find((s) => s.item_id === 'B1')?.state, 'verified')
  } finally {
    opened.db.close()
  }
})

test('★ 续传：**不重搬已 verified 的**（那是"可续传"的定义）', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 3)
    let copies = 0
    const counting = async (): Promise<{ ok: boolean; reason: string }> => {
      copies += 1
      return { ok: true, reason: 'ok' }
    }
    // 第一批只搬 1 条（模拟中断）
    await migrateBatch(opened.db, { runId, copyFile: counting, limit: 1, now: AT })
    assert.equal(copies, 1)
    // 续传：剩下 2 条
    const second = await migrateBatch(opened.db, { runId, copyFile: counting, limit: 10, now: AT })
    assert.equal(second.copied, 2, '只该搬剩下的 2 条')
    assert.equal(copies, 3, `**总共只该复制 3 次**，实际 ${String(copies)} 次 —— 已 verified 的不该重搬`)
    assert.equal(second.remaining, 0)
  } finally {
    opened.db.close()
  }
})

test('★ 有未完成条目 ⇒ **不许标 done**（标了 --resume 再也接不上）', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 2)
    await migrateBatch(opened.db, { runId, copyFile: okCopy, limit: 1, now: AT })
    const f = finishMigration(opened.db, runId, AT)
    assert.equal(f.ok, false)
    assert.match(f.reason, /不能标完成/)
    // run 仍在可续传列表里
    assert.equal(listResumable(opened.db).length, 1)
  } finally {
    opened.db.close()
  }
})

test('★ 只有 verified 才允许切换引用', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 2)
    // B0 成功、B1 失败
    await migrateBatch(opened.db, {
     
      runId,
      copyFile: async ({ from }: { from: string }) => (from.includes('B1') ? { ok: false, reason: '坏了' } : { ok: true, reason: 'ok' }),
      now: AT,
    })
    const s = switchReferences(opened.db, runId, AT)
    assert.equal(s.switched, 1, '**只该切 verified 的那一条**')
    assert.equal(s.skipped, 1)
    const row = opened.db.prepare("SELECT storage_path FROM media_assets WHERE id = 'B1'").get()
    assert.ok(String(row?.storage_path).includes('hot'), '失败的那条**引用不能动**')
  } finally {
    opened.db.close()
  }
})

test('★ 全流程：搬完 → 切换 → 标 done → 锁释放', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 2)
    await migrateBatch(opened.db, { runId, copyFile: okCopy, now: AT })
    const s = switchReferences(opened.db, runId, AT)
    assert.equal(s.switched, 2)
    const f = finishMigration(opened.db, runId, AT)
    assert.equal(f.ok, true, f.reason)
    assert.equal(activeLock(opened.db, AT), undefined, '锁要释放')
    const run = getMigrationRun(opened.db, runId)
    assert.equal(run?.status, 'done')
    // 库里的 tier 也切了
    const row = opened.db.prepare("SELECT storage_tier FROM media_assets WHERE id = 'B0'").get()
    assert.equal(row?.storage_tier, 'cold')
  } finally {
    opened.db.close()
  }
})

test('★ 回滚：**引用切回旧根，新数据不删**（回滚是出事时才用的）', async () => {
  const opened = setup()
  try {
    const runId = start(opened, 2)
    await migrateBatch(opened.db, { runId, copyFile: okCopy, now: AT })
    switchReferences(opened.db, runId, AT)

    const r = rollbackMigration(opened.db, runId, AT)
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.restored, 2)
    const row = opened.db.prepare("SELECT storage_path, storage_tier FROM media_assets WHERE id = 'B0'").get()
    assert.ok(String(row?.storage_path).includes('hot'), '引用要切回旧路径')
    assert.equal(row?.storage_tier, 'hot')
    assert.equal(getMigrationRun(opened.db, runId)?.status, 'rolledback')
    assert.equal(activeLock(opened.db, AT), undefined, '回滚后锁也要释放')
  } finally {
    opened.db.close()
  }
})

test('★ 锁：未过期 ⇒ 拒绝；**心跳过期 ⇒ 抢过来**（否则崩溃一次就永久拒绝写入）', () => {
  const opened = setup()
  try {
    assert.equal(acquireLock(opened.db, 'run-A', AT).ok, true)
    // 立刻再取 ⇒ 被拒
    const denied = acquireLock(opened.db, 'run-B', AT)
    assert.equal(denied.ok, false)
    assert.match(denied.reason, /未过期/)

    // 心跳过期 ⇒ 抢过来
    const later = new Date(AT.getTime() + LOCK_STALE_MS + 1000)
    const taken = acquireLock(opened.db, 'run-B', later)
    assert.equal(taken.ok, true, '**崩溃留下的锁必须能被抢**')
    assert.match(taken.reason, /过期/)
  } finally {
    opened.db.close()
  }
})

test('★ 心跳续上后，锁不再算过期', () => {
  const opened = setup()
  try {
    acquireLock(opened.db, 'run-A', AT)
    const later = new Date(AT.getTime() + LOCK_STALE_MS - 1000)
    heartbeat(opened.db, 'run-A', later)
    const muchLater = new Date(later.getTime() + LOCK_STALE_MS - 1000)
    assert.ok(activeLock(opened.db, muchLater) !== undefined, '续过心跳就不该算过期')
  } finally {
    opened.db.close()
  }
})

test('releaseLock 之后别人能取', () => {
  const opened = setup()
  try {
    acquireLock(opened.db, 'run-A', AT)
    releaseLock(opened.db, 'run-A')
    assert.equal(acquireLock(opened.db, 'run-B', AT).ok, true)
  } finally {
    opened.db.close()
  }
})

test('★ 空层 ⇒ Preflight 说"没有要搬的"，startMigration 仍能建 run（0 条）', () => {
  const opened = setup()
  try {
    const r = startMigration(opened.db, {
      fromTier: 'hot',
      toTier: 'cold',
      fromRoot: 'D:\\hot',
      toRoot: 'D:\\cold',
      toPathFor: TO_PATH,
      now: AT,
    })
    assert.equal(r.ok, true, r.reason)
    assert.match(r.reason, /记了 0 条/)
  } finally {
    opened.db.close()
  }
})

test('★ 回滚不存在的 run ⇒ 明确说"没有这个 run"', () => {
  const opened = setup()
  try {
    const r = rollbackMigration(opened.db, 'nope', AT)
    assert.equal(r.ok, false)
    assert.match(r.reason, /没有这个 run/)
  } finally {
    opened.db.close()
  }
})
