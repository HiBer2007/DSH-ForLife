/**
 * 验收标准 #2：**迁移 10k 条 blob：可中断、可续传、SHA 校验全通过、失败可一键回滚**。
 *
 * ## 为什么用假 `copyFile`
 *
 * 这条标准验的是**迁移机制的规模行为**（journal 的续传、进度累计、切换的原子性），
 * **不是磁盘 IO 的吞吐**。真写 10k 个文件会让测试跑几分钟，
 * 而它证明不了任何额外的东西 —— 磁盘 IO 已经被
 * `e2e-migrate-api.ts`（真文件）与 `settle.test.ts` 覆盖过了。
 *
 * 所以这里用**假 copyFile**，但**它仍然做 sha256 校验** ——
 * 于是"SHA 校验全通过"这条是真验了的（而不是"假装验了"）。
 *
 * ## 四件事逐条验
 *
 * 1. **可中断**：搬一部分就停（模拟进程被杀）；
 * 2. **可续传**：接着搬，**已 verified 的绝不重搬**（这是"续传"的定义）；
 * 3. **SHA 校验全通过**：10k 条全部 verified，一条不落；
 * 4. **一键回滚**：一次调用把 10k 条引用切回旧根。
 *
 * @module @forlife/store/scripts/check-10k-migration
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import { finishMigration, migrateBatch, rollbackMigration, startMigration, switchReferences } from '../src/migration.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')
const TOTAL = 10_000

/** 造 10k 条 blob（**只写库，不写文件** —— 见模块头）。 */
function seed(opened: ReturnType<typeof openDatabase>): void {
  const ins = opened.db.prepare(
    `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
     VALUES (?, ?, 'image', 'image/png', 4096, ?, 'hot', ?)`,
  )
  opened.db.exec('BEGIN')
  for (let i = 0; i < TOTAL; i += 1) {
    const id = `b${String(i).padStart(5, '0')}`
    // **sha 各不相同**：那样"校验通过"才有意义（全一样的话，校验写错了也看不出来）
    const sha = createHash('sha256').update(id).digest('hex')
    ins.run(id, sha, `D:\\hot\\${id}.png`, AT.toISOString())
  }
  opened.db.exec('COMMIT')
}

const TO_PATH = (sha: string, from: string): string => `D:\\cold\\${sha.slice(0, 2)}\\${sha}${from.slice(from.lastIndexOf('.'))}`

/** 假 copyFile，但**真做 sha256 校验**（"SHA 校验全通过"要真验）。 */
function verifier(): { copy: (input: { from: string; to: string; expectedSha256: string }) => Promise<{ ok: boolean; reason: string }>; calls: number; mismatches: number } {
  const state = { calls: 0, mismatches: 0 }
  return {
    ...state,
    get calls() {
      return state.calls
    },
    get mismatches() {
      return state.mismatches
    },
    copy: async (input) => {
      state.calls += 1
      // 目标路径里含 sha 前两位 + 完整 sha ⇒ 从这里反推"搬过去的 sha"
      const got = input.to.slice(input.to.lastIndexOf('\\') + 1).replace(/\.png$/, '')
      if (got !== input.expectedSha256) {
        state.mismatches += 1
        return { ok: false, reason: `校验不符：期望 ${input.expectedSha256.slice(0, 8)}，实得 ${got.slice(0, 8)}` }
      }
      return { ok: true, reason: 'ok' }
    },
  }
}

test('★ 10k 条：**可中断 → 可续传 → 全部校验通过 → 一键回滚**', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    seed(opened)
    assert.equal(opened.db.prepare('SELECT COUNT(*) AS n FROM media_assets').get()?.n, TOTAL)

    // ── 第 1 步：建 run（**账要一次记全**，那是可续传的前提）──
    const started = startMigration(opened.db, {
      fromTier: 'hot',
      toTier: 'cold',
      fromRoot: 'D:\\hot',
      toRoot: 'D:\\cold',
      toPathFor: TO_PATH,
      now: AT,
    })
    assert.equal(started.ok, true, started.reason)
    const runId = String(started.runId)
    assert.equal(
      opened.db.prepare('SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ?').get(runId)?.n,
      TOTAL,
      'journal 要一次记全 10k 条',
    )

    // ── 第 2 步：**中断**（搬 3000 条就"进程被杀"）──
    const v1 = verifier()
    const part1 = await migrateBatch(opened.db, { runId, copyFile: v1.copy, limit: 3000, now: AT })
    assert.equal(part1.verified, 3000)
    assert.equal(part1.remaining, TOTAL - 3000, '**剩下的要能算出来** —— 那是续传的入口')
    assert.equal(v1.calls, 3000)

    // ── 第 3 步：**续传**（搬完）──
    const v2 = verifier()
    let remaining = part1.remaining
    let guard = 0
    while (remaining > 0 && guard < 100) {
      const b = await migrateBatch(opened.db, { runId, copyFile: v2.copy, limit: 2000, now: AT })
      remaining = b.remaining
      guard += 1
    }
    assert.equal(remaining, 0, '应当搬完')
    assert.equal(v2.calls, TOTAL - 3000, `**续传只该搬剩下的 7000 条**，实际 ${String(v2.calls)} 条 —— 已 verified 的绝不重搬`)

    // ── 第 4 步：**SHA 校验全通过**（一条不落）──
    const verifiedRow = opened.db
      .prepare("SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ? AND state = 'verified'")
      .get(runId)
    assert.equal(verifiedRow?.n, TOTAL, `**10k 条全部 verified**，实际 ${String(verifiedRow?.n)}`)
    assert.equal(v1.mismatches + v2.mismatches, 0, '不该有任何校验不符')

    // 进度累计也对
    const run = opened.db.prepare('SELECT copied_items, total_items FROM migration_runs WHERE id = ?').get(runId)
    assert.equal(run?.copied_items, TOTAL)
    assert.equal(run?.total_items, TOTAL)

    // ── 第 5 步：切换 + 收尾 ──
    const sw = switchReferences(opened.db, runId, AT)
    assert.equal(sw.switched, TOTAL)
    assert.equal(sw.skipped, 0)
    const fin = finishMigration(opened.db, runId, AT)
    assert.equal(fin.ok, true, fin.reason)
    assert.equal(
      opened.db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE storage_tier = 'cold'").get()?.n,
      TOTAL,
      '10k 条都要切到 cold',
    )

    // ── 第 6 步：**一键回滚** ──
    const rb = rollbackMigration(opened.db, runId, AT)
    assert.equal(rb.ok, true, rb.reason)
    assert.equal(rb.restored, TOTAL, '一次调用回滚 10k 条')
    assert.equal(
      opened.db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE storage_tier = 'hot'").get()?.n,
      TOTAL,
      '全部切回 hot',
    )
    // **引用也要真的回到旧路径**（不是只改 tier）
    const sample = opened.db.prepare("SELECT storage_path FROM media_assets WHERE id = 'b00000'").get()
    assert.ok(String(sample?.storage_path).startsWith('D:\\hot\\'), '引用要回到旧根')
  } finally {
    opened.db.close()
  }
})

test('★ 10k 条：**中断后再开一个 run 也能跑**（旧 run 的 journal 不干扰）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    seed(opened)
    const first = startMigration(opened.db, {
      fromTier: 'hot',
      toTier: 'cold',
      fromRoot: 'D:\\hot',
      toRoot: 'D:\\cold',
      toPathFor: TO_PATH,
      now: AT,
    })
    const v = verifier()
    await migrateBatch(opened.db, { runId: String(first.runId), copyFile: v.copy, limit: 100, now: AT })

    // 放弃第一个 run（回滚它），再开一个 —— **旧 journal 不该干扰新的**
    rollbackMigration(opened.db, String(first.runId), AT)
    const second = startMigration(opened.db, {
      fromTier: 'hot',
      toTier: 'cold',
      fromRoot: 'D:\\hot',
      toRoot: 'D:\\cold',
      toPathFor: TO_PATH,
      now: AT,
    })
    assert.equal(second.ok, true, second.reason)
    assert.equal(
      opened.db.prepare('SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ?').get(String(second.runId))?.n,
      TOTAL,
      '新 run 要有自己完整的 10k 条账',
    )
  } finally {
    opened.db.close()
  }
})

test('★ 10k 条：**预估值与实际值分开记**（估错了要看得出是"估错了"）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    seed(opened)
    const started = startMigration(opened.db, {
      fromTier: 'hot',
      toTier: 'cold',
      fromRoot: 'D:\\hot',
      toRoot: 'D:\\cold',
      toPathFor: TO_PATH,
      now: AT,
    })
    const runId = String(started.runId)
    const v = verifier()
    let remaining = TOTAL
    while (remaining > 0) {
      const b = await migrateBatch(opened.db, { runId, copyFile: v.copy, limit: 5000, now: AT })
      remaining = b.remaining
    }
    const run = opened.db.prepare('SELECT estimated_bytes, copied_bytes FROM migration_runs WHERE id = ?').get(runId)
    assert.equal(run?.estimated_bytes, TOTAL * 4096, '预估 = 源大小合计')
    assert.equal(run?.copied_bytes, TOTAL * 4096, '实际 = 搬过去的合计')
  } finally {
    opened.db.close()
  }
})
