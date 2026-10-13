/**
 * ★★ 维护请求的**功能**测试（`FIX_PLAN.md` §72 / §74）。
 *
 * ## 用户原话
 * 「所有的沉降**都有手动触发途径，都有工具触发途径**」
 * （PLAN `src-01.md:342`「按需触发**沉降/碎片维护/复盘**任务」·
 *   `src-08.md:346`「碎片索引合并与淘汰（**定时 + 手动**）」）。
 *
 * ## ★ 这里验的是"数据库即通道"真的通
 * ★ 写一条 → 认领 → 完成；★ 而且**认领者崩了不能把请求永久卡死**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAINTENANCE_CLAIM_TIMEOUT_MS,
  claimMaintenanceRequests,
  countPendingMaintenanceRequests,
  enqueueMaintenanceRequest,
  finishMaintenanceRequest,
  listMaintenanceRequests,
  openDatabase,
} from '../src/index.ts'

function temp(): { readonly dir: string; readonly db: ReturnType<typeof openDatabase> } {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-mreq-'))
  return { dir, db: openDatabase({ file: join(dir, 'forlife.sqlite') }) }
}

function cleanup(dir: string, db: ReturnType<typeof openDatabase>): void {
  try {
    db.db.close()
  } catch {
    // 关库失败不影响断言
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 文件锁
  }
}

test('★★ 写一条 → 待处理数 +1；认领之后状态变 claimed', () => {
  const { dir, db } = temp()
  try {
    assert.equal(countPendingMaintenanceRequests(db.db), 0, '新库应当是空的')
    const id = enqueueMaintenanceRequest(db.db, { kind: 'fragments', requestedBy: 'test' })
    assert.ok(id.startsWith('mreq_'), `id 要有前缀便于排障，实际：${id}`)
    assert.equal(countPendingMaintenanceRequests(db.db), 1)

    const claimed = claimMaintenanceRequests(db.db, 'gateway', 5)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.id, id)
    assert.equal(claimed[0]?.status, 'claimed', '★ 认领后状态必须是 claimed（否则会被重复认领）')
    assert.equal(claimed[0]?.claimed_by, 'gateway')
    // ★ 认领过的**不该**再被认领一次（那是"同一条请求跑两遍"）
    assert.equal(claimMaintenanceRequests(db.db, 'gateway', 5).length, 0, '★ 不能被认领两次')
  } finally {
    cleanup(dir, db)
  }
})

test('★★ 完成之后不再待处理（成功与失败都要落 result）', () => {
  const { dir, db } = temp()
  try {
    const okId = enqueueMaintenanceRequest(db.db, { kind: 'full', requestedBy: 'test' })
    const badId = enqueueMaintenanceRequest(db.db, { kind: 'full', requestedBy: 'test' })
    claimMaintenanceRequests(db.db, 'gateway', 5)
    finishMaintenanceRequest(db.db, okId, true, '搬运 3 条')
    finishMaintenanceRequest(db.db, badId, false, '冷层不可写')
    assert.equal(countPendingMaintenanceRequests(db.db), 0, '两个都结束了')

    const rows = listMaintenanceRequests(db.db, 10)
    const ok = rows.find((r) => r.id === okId)
    const bad = rows.find((r) => r.id === badId)
    assert.equal(ok?.status, 'done')
    assert.equal(bad?.status, 'failed', '★ **失败要有独立状态** —— 与"跑过了"分开')
    assert.equal(bad?.result, '冷层不可写', '★ 失败也要落 result（否则面板看到的是"跑过了"）')
  } finally {
    cleanup(dir, db)
  }
})

test('★★★ 认领者崩了 ⇒ 超时后**放回 pending**（不能永久卡死）', () => {
  // ★ 与 `wake-requests.ts` 同一条纪律：**不做这一步的话，认领者崩一次，
  //   那一行就永久卡在 claimed —— 而没人会去看**。
  const { dir, db } = temp()
  try {
    const id = enqueueMaintenanceRequest(db.db, { kind: 'fragments', requestedBy: 'test' })
    const t0 = new Date('2026-10-11T00:00:00.000Z')
    claimMaintenanceRequests(db.db, 'gateway', 5, t0)
    assert.equal(claimMaintenanceRequests(db.db, 'gateway', 5, t0).length, 0, '刚认领的不该被回收')

    // ★ 超时之后：同一行必须能再被认领
    const t1 = new Date(t0.getTime() + MAINTENANCE_CLAIM_TIMEOUT_MS + 1000)
    const reclaimed = claimMaintenanceRequests(db.db, 'gateway', 5, t1)
    assert.equal(reclaimed.length, 1, '★ 超时的认领必须被**放回 pending**')
    assert.equal(reclaimed[0]?.id, id, '回收的应当是同一行')
  } finally {
    cleanup(dir, db)
  }
})

test('★ 批量认领受 limit 约束（不能一次把队列全吞了）', () => {
  const { dir, db } = temp()
  try {
    for (let i = 0; i < 5; i += 1) enqueueMaintenanceRequest(db.db, { kind: 'fragments', requestedBy: 'test' })
    const first = claimMaintenanceRequests(db.db, 'gateway', 2)
    assert.equal(first.length, 2)
    assert.equal(countPendingMaintenanceRequests(db.db), 5, '★ 待处理数含 claimed（它们还没做完）')
  } finally {
    cleanup(dir, db)
  }
})

test('★ reason 落库（模型给的理由要能回看）', () => {
  const { dir, db } = temp()
  try {
    enqueueMaintenanceRequest(db.db, {
      kind: 'fragments',
      requestedBy: 'tool:request_maintenance',
      reason: '碎片索引感觉涨了',
    })
    const row = listMaintenanceRequests(db.db, 1)[0]
    assert.equal(row?.reason, '碎片索引感觉涨了')
    assert.equal(row?.requested_by, 'tool:request_maintenance', '★ 谁请求的要能查（工具 / 面板 / CLI）')
  } finally {
    cleanup(dir, db)
  }
})
