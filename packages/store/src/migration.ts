/**
 * 迁移机制（PLAN §2.4 五步流程 + 阶段 9 交付物 2）。
 *
 * ## 五步流程（PLAN 原文）
 *
 * 1. **Preflight**：目标根可写、剩余空间 ≥ 预估（源大小 × 1.1）、无活跃压缩事务；
 * 2. **加锁**：`migration_lock` 表行（心跳），core 侧读到锁即拒绝新的沉降/blobs 写入；
 * 3. **复制 + 校验**：按 blob 粒度复制，逐个 SHA-256 比对；写 `migration_journal`（可续传）；
 * 4. **原子切换**：更新配置根路径 + DB 内 blob 引用前缀；
 * 5. **可选清理源**：显式 `--purge-source`，默认保留 7 天；
 * 6. **可中断可回滚**：中断后 `--resume`；回滚 = 切回旧根（旧数据仍在）。
 *
 * ## 这个模块的重心在**第 3 步与第 6 步**
 *
 * CLI 与按钮只是**包装**；**续传与回滚的正确性才是难点**，
 * 而验收标准也正是那两条（"可中断、可续传、SHA 校验全通过、失败可一键回滚"）。
 *
 * ## 三条不可动摇的判断
 *
 * 1. **只有 `verified` 的条目才允许切换引用** ——
 *    半个文件比没有文件更危险（它看起来是好的）。所以
 *    "复制"与"切换"**分两步**，中间隔着校验。
 * 2. **回滚 = 切回旧根，不是"删掉新数据"** ——
 *    旧数据一直在（第 5 步默认保留 7 天），所以回滚只是把引用指回去。
 *    **删新数据**的话，回滚本身就成了一个有风险的写操作。
 * 3. **锁靠心跳自愈** —— 崩溃留下的锁如果不会过期，
 *    系统就**永久拒绝写入**。心跳超时才能自愈。
 *
 * @module @forlife/store/migration
 */
import type { DatabaseSync } from 'node:sqlite'

/** 锁名（目前只有 blob）。 */
export const BLOB_LOCK = 'blobs'

/** 心跳多久算过期（毫秒）。超过就认为持有者崩了。 */
export const LOCK_STALE_MS = 120_000

/** 一次迁移的状态行。 */
export interface MigrationRun {
  readonly id: string
  readonly from_tier: string
  readonly to_tier: string
  readonly from_root: string
  readonly to_root: string
  readonly status: string
  readonly estimated_bytes: number
  readonly copied_bytes: number
  readonly total_items: number
  readonly copied_items: number
  readonly note: string | null
  readonly started_at: string
  readonly updated_at: string
  readonly finished_at: string | null
}

/** 一条 journal 记录。 */
export interface JournalEntry {
  readonly run_id: string
  readonly item_id: string
  readonly sha256: string
  readonly from_path: string
  readonly to_path: string
  readonly byte_size: number
  readonly state: string
  readonly note: string | null
  readonly updated_at: string
}

/** Preflight 结果。 */
export interface PreflightResult {
  readonly ok: boolean
  readonly reason: string
  readonly items: number
  readonly estimatedBytes: number
  /** 需要的空间（源大小 × 1.1）。 */
  readonly requiredBytes: number
}

// ── 锁 ─────────────────────────────────────────────────────────────────

/**
 * 尝试取锁。**已被别人持有且心跳未过期 ⇒ 拒绝**。
 *
 * 心跳过期 ⇒ 抢过来（那是崩溃留下的）——
 * **不做这一步的话，一次崩溃就让系统永久拒绝写入。**
 */
export function acquireLock(
  db: DatabaseSync,
  runId: string,
  now: Date = new Date(),
  name: string = BLOB_LOCK,
): { ok: boolean; reason: string } {
  const existing = db.prepare('SELECT run_id, heartbeat_at FROM migration_lock WHERE name = ?').get(name) as
    | { run_id: string; heartbeat_at: string }
    | undefined
  if (existing !== undefined) {
    const age = now.getTime() - new Date(existing.heartbeat_at).getTime()
    if (age < LOCK_STALE_MS) {
      return { ok: false, reason: `锁被 ${existing.run_id} 持有（心跳 ${String(Math.round(age / 1000))} 秒前，未过期）` }
    }
    // **心跳过期 ⇒ 抢过来**（崩溃留下的锁不能永久挡住写入）
  }
  db.prepare(
    `INSERT INTO migration_lock (name, run_id, heartbeat_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, heartbeat_at = excluded.heartbeat_at`,
  ).run(name, runId, now.toISOString())
  return { ok: true, reason: existing === undefined ? '已取锁' : '抢过了一个心跳过期的锁（原持有者可能崩了）' }
}

/** 续心跳。**长迁移必须定期调它**，否则锁会被别人当成过期的抢走。 */
export function heartbeat(db: DatabaseSync, runId: string, now: Date = new Date()): boolean {
  const r = db.prepare('UPDATE migration_lock SET heartbeat_at = ? WHERE run_id = ?').run(now.toISOString(), runId)
  return Number(r.changes) > 0
}

/** 释放锁。 */
export function releaseLock(db: DatabaseSync, runId: string): void {
  db.prepare('DELETE FROM migration_lock WHERE run_id = ?').run(runId)
}

/** 当前有没有活跃的锁（**core 侧用它决定要不要拒绝写入**）。 */
export function activeLock(db: DatabaseSync, now: Date = new Date()): { runId: string; note: string } | undefined {
  const row = db.prepare('SELECT run_id, heartbeat_at, note FROM migration_lock WHERE name = ?').get(BLOB_LOCK) as
    | { run_id: string; heartbeat_at: string; note: string | null }
    | undefined
  if (row === undefined) return undefined
  if (now.getTime() - new Date(row.heartbeat_at).getTime() >= LOCK_STALE_MS) return undefined
  return { runId: row.run_id, note: String(row.note ?? '') }
}

// ── 五步流程 ────────────────────────────────────────────────────────────

/** 第 1 步：Preflight（**只读，不改任何东西**）。 */
export function preflight(db: DatabaseSync, options: { readonly fromTier: string; readonly toTier: string }): PreflightResult {
  // **活跃压缩事务 ⇒ 拒绝**：压缩正在写 mid_memory_entries 与长期记忆，
  // 那时迁移会把"正在被写的引用"搬走
  const running = db
    .prepare("SELECT COUNT(*) AS n FROM compaction_runs WHERE phase NOT IN ('done', 'failed', 'rolled_back')")
    .get() as { n?: number } | undefined
  if (Number(running?.n ?? 0) > 0) {
    return { ok: false, reason: `有 ${String(running?.n)} 个压缩事务在跑 —— 迁移会把"正在被写的引用"搬走`, items: 0, estimatedBytes: 0, requiredBytes: 0 }
  }

  const agg = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM media_assets WHERE storage_tier = ?')
    .get(options.fromTier) as { n?: number; b?: number } | undefined
  const items = Number(agg?.n ?? 0)
  const estimatedBytes = Number(agg?.b ?? 0)
  // 预留 10%：预估永远会偏，而"搬到一半空间不够"是最难收拾的中断
  const requiredBytes = Math.ceil(estimatedBytes * 1.1)

  return {
    ok: true,
    reason: items === 0 ? `${options.fromTier} 层没有要搬的东西` : `待搬 ${String(items)} 条（${String(estimatedBytes)} 字节，需预留 ${String(requiredBytes)}）`,
    items,
    estimatedBytes,
    requiredBytes,
  }
}

/** 第 2 步：建 run + 取锁 + **把每个 blob 写进 journal（state=pending）**。 */
export function startMigration(
  db: DatabaseSync,
  options: {
    readonly fromTier: string
    readonly toTier: string
    readonly fromRoot: string
    readonly toRoot: string
    readonly toPathFor: (sha256: string, fromPath: string) => string
    readonly now?: Date
  },
): { ok: boolean; reason: string; runId?: string } {
  const now = options.now ?? new Date()
  const pre = preflight(db, { fromTier: options.fromTier, toTier: options.toTier })
  if (!pre.ok) return { ok: false, reason: `Preflight 没过：${pre.reason}` }

  const runId = `mig_${crypto.randomUUID()}`
  const lock = acquireLock(db, runId, now)
  if (!lock.ok) return { ok: false, reason: `取锁失败：${lock.reason}` }

  db.prepare(
    `INSERT INTO migration_runs
       (id, from_tier, to_tier, from_root, to_root, status, estimated_bytes, total_items, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
  ).run(runId, options.fromTier, options.toTier, options.fromRoot, options.toRoot, pre.estimatedBytes, pre.items, now.toISOString(), now.toISOString())

  // **把账先记全**（pending）—— 这是"可续传"的前提：
  // 中断后要看得出"哪些还没搬"，而不是重新扫一遍源（源可能已经变了一半）
  const rows = db
    .prepare('SELECT id, sha256, storage_path, size_bytes FROM media_assets WHERE storage_tier = ? ORDER BY created_at')
    .all(options.fromTier) as unknown as readonly { id: string; sha256: string; storage_path: string; size_bytes: number }[]
  const ins = db.prepare(
    `INSERT INTO migration_journal (run_id, item_id, sha256, from_path, to_path, byte_size, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
  for (const r of rows) {
    ins.run(runId, r.id, r.sha256, r.storage_path, options.toPathFor(r.sha256, r.storage_path), r.size_bytes, now.toISOString())
  }

  return { ok: true, reason: `已建 run ${runId}，记了 ${String(rows.length)} 条待搬（取锁：${lock.reason}）`, runId }
}

/** 复制实现（注入：真实实现碰磁盘，测试用替身）。 */
export type CopyFile = (input: {
  readonly from: string
  readonly to: string
  readonly expectedSha256: string
}) => Promise<{ readonly ok: boolean; readonly reason: string }>

/** 一批的结果。 */
export interface BatchResult {
  readonly copied: number
  readonly verified: number
  readonly failed: number
  readonly remaining: number
  readonly failures: readonly string[]
}

/**
 * 第 3 步：搬一批（**复制 + 校验**），并写 journal。
 *
 * **中断后再调它就是续传** —— 因为 journal 里记着哪些还是 `pending`，
 * 而那些已经 `verified` 的不会被重搬。
 *
 * **失败的不标 verified** ⇒ 下次续传会重试它。
 */
export async function migrateBatch(
  db: DatabaseSync,
  options: {
    readonly runId: string
    readonly copyFile: CopyFile
    readonly limit?: number
    readonly now?: Date
    readonly log?: (message: string) => void
  },
): Promise<BatchResult> {
  const now = options.now ?? new Date()
  const log = options.log ?? ((): void => {})
  const limit = options.limit ?? 100

  const pending = db
    .prepare("SELECT * FROM migration_journal WHERE run_id = ? AND state = 'pending' ORDER BY item_id LIMIT ?")
    .all(options.runId, limit) as unknown as readonly JournalEntry[]

  let copied = 0
  let verified = 0
  let failed = 0
  const failures: string[] = []

  for (const item of pending) {
    let outcome: { ok: boolean; reason: string }
    try {
      outcome = await options.copyFile({ from: item.from_path, to: item.to_path, expectedSha256: item.sha256 })
    } catch (error) {
      outcome = { ok: false, reason: `复制抛异常：${String(error).slice(0, 120)}` }
    }

    if (!outcome.ok) {
      // **失败的不标 verified** ⇒ 下次续传会重试它
      db.prepare("UPDATE migration_journal SET state = 'pending', note = ?, updated_at = ? WHERE run_id = ? AND item_id = ?")
        .run(outcome.reason.slice(0, 200), now.toISOString(), options.runId, item.item_id)
      failed += 1
      failures.push(`${item.item_id}：${outcome.reason}`)
      continue
    }

    copied += 1
    verified += 1
    db.prepare("UPDATE migration_journal SET state = 'verified', note = NULL, updated_at = ? WHERE run_id = ? AND item_id = ?")
      .run(now.toISOString(), options.runId, item.item_id)
    // 心跳：长迁移必须续，否则锁会被当成过期的抢走
    heartbeat(db, options.runId, now)
  }

  const remainingRow = db
    .prepare("SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ? AND state = 'pending'")
    .get(options.runId) as { n?: number } | undefined
  const remaining = Number(remainingRow?.n ?? 0)

  // 累计进度（**预估与实际分开记**）
  db.prepare(
    `UPDATE migration_runs SET copied_items = (SELECT COUNT(*) FROM migration_journal WHERE run_id = ? AND state = 'verified'),
       copied_bytes = (SELECT COALESCE(SUM(byte_size), 0) FROM migration_journal WHERE run_id = ? AND state = 'verified'),
       updated_at = ? WHERE id = ?`,
  ).run(options.runId, options.runId, now.toISOString(), options.runId)

  if (copied > 0 || failed > 0) log(`迁移一批：校验通过 ${String(verified)} 条、失败 ${String(failed)} 条、剩 ${String(remaining)} 条`)
  return { copied, verified, failed, remaining, failures }
}

/**
 * 第 4 步：原子切换（**只切已 verified 的**）。
 *
 * 没 verified 的**不切** —— 它们指向的可能是半个文件。
 * 所以"全部 verified 才允许 finish"这条要在调用方检查（见 `finishMigration`）。
 */
export function switchReferences(
  db: DatabaseSync,
  runId: string,
  now: Date = new Date(),
): { switched: number; skipped: number } {
  const verified = db
    .prepare("SELECT item_id, to_path FROM migration_journal WHERE run_id = ? AND state = 'verified'")
    .all(runId) as unknown as readonly { item_id: string; to_path: string }[]

  const upd = db.prepare("UPDATE media_assets SET storage_path = ?, storage_tier = ? WHERE id = ?")
  const run = db.prepare('SELECT to_tier FROM migration_runs WHERE id = ?').get(runId) as { to_tier: string } | undefined
  const toTier = String(run?.to_tier ?? 'warm')

  let switched = 0
  for (const v of verified) {
    upd.run(v.to_path, toTier, v.item_id)
    db.prepare("UPDATE migration_journal SET state = 'switched', updated_at = ? WHERE run_id = ? AND item_id = ?")
      .run(now.toISOString(), runId, v.item_id)
    switched += 1
  }

  const pendingRow = db
    .prepare("SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ? AND state != 'switched'")
    .get(runId) as { n?: number } | undefined
  return { switched, skipped: Number(pendingRow?.n ?? 0) }
}

/**
 * 收尾：**只有在没有未完成条目时**才允许标 done。
 *
 * 有未完成条目却标 done 的话，`--resume` 就再也接不上了 ——
 * 而那些条目指向的可能是**半个文件**。
 */
export function finishMigration(
  db: DatabaseSync,
  runId: string,
  now: Date = new Date(),
): { ok: boolean; reason: string } {
  const pendingRow = db
    .prepare("SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ? AND state != 'switched'")
    .get(runId) as { n?: number } | undefined
  const pending = Number(pendingRow?.n ?? 0)
  if (pending > 0) {
    return { ok: false, reason: `还有 ${String(pending)} 条没切过去 —— 不能标完成（标了的话 --resume 再也接不上）` }
  }
  db.prepare("UPDATE migration_runs SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(now.toISOString(), now.toISOString(), runId)
  releaseLock(db, runId)
  return { ok: true, reason: '迁移完成，锁已释放' }
}

/**
 * 回滚：**把引用切回旧根**（不删新数据）。
 *
 * 旧数据一直在（第 5 步默认保留 7 天），所以回滚只是把引用指回去。
 * **"删掉新数据"式的回滚**会让回滚本身变成一个**有风险的写操作** ——
 * 而回滚恰恰是出事时才用的，那时最不该再做危险的事。
 */
export function rollbackMigration(
  db: DatabaseSync,
  runId: string,
  now: Date = new Date(),
): { ok: boolean; reason: string; restored: number } {
  const run = db.prepare('SELECT from_tier, status FROM migration_runs WHERE id = ?').get(runId) as
    | { from_tier: string; status: string }
    | undefined
  if (run === undefined) return { ok: false, reason: `没有这个 run：${runId}`, restored: 0 }

  const rows = db
    .prepare("SELECT item_id, from_path FROM migration_journal WHERE run_id = ? AND state = 'switched'")
    .all(runId) as unknown as readonly { item_id: string; from_path: string }[]

  const upd = db.prepare('UPDATE media_assets SET storage_path = ?, storage_tier = ? WHERE id = ?')
  for (const r of rows) {
    // **切回旧路径** —— 旧文件一直在，所以这一步不会碰磁盘
    upd.run(r.from_path, run.from_tier, r.item_id)
  }
  db.prepare("UPDATE migration_journal SET state = 'verified', updated_at = ? WHERE run_id = ? AND state = 'switched'")
    .run(now.toISOString(), runId)
  db.prepare("UPDATE migration_runs SET status = 'rolledback', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(now.toISOString(), now.toISOString(), runId)
  releaseLock(db, runId)
  return { ok: true, reason: `已回滚 ${String(rows.length)} 条（引用切回旧根，**新数据没删**）`, restored: rows.length }
}

/** 续传入口：找出未完成的 run（**中断后 `--resume` 用它**）。 */
export function listResumable(db: DatabaseSync): readonly MigrationRun[] {
  return db
    .prepare("SELECT * FROM migration_runs WHERE status IN ('preflight', 'running') ORDER BY started_at")
    .all() as unknown as readonly MigrationRun[]
}

/** 读一次迁移的状态（面板用）。 */
export function getMigrationRun(db: DatabaseSync, runId: string): MigrationRun | undefined {
  return db.prepare('SELECT * FROM migration_runs WHERE id = ?').get(runId) as MigrationRun | undefined
}
