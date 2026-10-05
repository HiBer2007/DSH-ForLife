/**
 * 压缩事务：崩溃一致性的落地层。
 *
 * ## 为什么需要它
 *
 * 一次压缩要改三处：① 追加 `push_to_mid` 条目；② 把 `fragment_mid` 里的条目降级为碎片；
 * ③ 推进 `compaction_epoch`。DSH 会话日志里的 `compaction/start` / `compaction/end`
 * 是**它自己的**锁与审计，管不到我们的表。如果进程在 ① 之后、③ 之前被杀，
 * 我们的表就处于"半写"状态：条目进来了、epoch 没推进、碎片化做了一半。
 *
 * ## 做法
 *
 * 改动之前先写一条 `started` 运行记录，**并把计划（要写哪些 id、要碎片化哪些 id）一起落盘**；
 * 全部改完再改 `committed`。启动时扫出残留的 `started` → 按计划回滚：
 * 删掉本次新写的条目、把碎片化过的条目恢复成 active、把 epoch 退回原值。
 *
 * 回滚是**幂等**的：重复回滚不会造成二次破坏（删不存在的 id、恢复已恢复的条目都是无操作）。
 *
 * @module @forlife/store/compaction-runs
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一次压缩的**计划**（回滚依据；必须在动手之前落盘）。 */
export interface CompactionPlan {
  /** 本次将追加的中期条目 id（回滚时删除）。 */
  readonly pushedIds: readonly string[]
  /** 本次将碎片化的中期条目 id（回滚时恢复为 active）。 */
  readonly fragmentedIds: readonly string[]
  /** 本次将写入的长期记忆 id（回滚时删除）。 */
  readonly longIds?: readonly string[]
}

/** 运行记录。 */
export interface CompactionRunRow {
  readonly id: string
  readonly compaction_id: string | null
  readonly session_id: string | null
  readonly phase: 'started' | 'committed' | 'aborted'
  readonly epoch_from: number
  readonly epoch_to: number | null
  readonly plan: string
  readonly detail: string | null
  readonly error: string | null
  readonly started_at: string
  readonly ended_at: string | null
}

/** 开始一次压缩事务。 */
export function beginCompactionRun(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly compactionId?: string | null
    readonly sessionId?: string | null
    readonly epochFrom: number
    readonly plan: CompactionPlan
  },
): CompactionRunRow {
  db.prepare(
    `INSERT INTO compaction_runs (id, compaction_id, session_id, phase, epoch_from, epoch_to, plan, detail, error, started_at, ended_at)
     VALUES (?, ?, ?, 'started', ?, NULL, ?, NULL, NULL, ?, NULL)`,
  ).run(
    input.id,
    input.compactionId ?? null,
    input.sessionId ?? null,
    input.epochFrom,
    JSON.stringify(input.plan),
    nowIso(),
  )
  const row = getCompactionRun(db, input.id)
  if (row === undefined) throw new Error('写入后读不到压缩运行记录')
  return row
}

/** 标记压缩事务成功提交。 */
export function commitCompactionRun(
  db: DatabaseSync,
  id: string,
  result: { readonly epochTo: number; readonly detail?: unknown },
): void {
  db.prepare(
    `UPDATE compaction_runs SET phase = 'committed', epoch_to = ?, detail = ?, ended_at = ? WHERE id = ? AND phase = 'started'`,
  ).run(result.epochTo, result.detail === undefined ? null : JSON.stringify(result.detail), nowIso(), id)
}

/** 标记压缩事务失败（已回滚或明确放弃）。 */
export function abortCompactionRun(db: DatabaseSync, id: string, error: string): void {
  db.prepare(`UPDATE compaction_runs SET phase = 'aborted', error = ?, ended_at = ? WHERE id = ? AND phase = 'started'`).run(
    error,
    nowIso(),
    id,
  )
}

/** 按 id 取运行记录。 */
export function getCompactionRun(db: DatabaseSync, id: string): CompactionRunRow | undefined {
  return db.prepare('SELECT * FROM compaction_runs WHERE id = ?').get(id) as CompactionRunRow | undefined
}

/** 列出未完成的运行（启动时用）。 */
export function pendingCompactionRuns(db: DatabaseSync): readonly CompactionRunRow[] {
  return db
    .prepare("SELECT * FROM compaction_runs WHERE phase = 'started' ORDER BY started_at ASC")
    .all() as unknown as CompactionRunRow[]
}

/** 列出最近的运行（面板用）。 */
export function listCompactionRuns(db: DatabaseSync, limit = 20): readonly CompactionRunRow[] {
  return db
    .prepare('SELECT * FROM compaction_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as unknown as CompactionRunRow[]
}

/** 回滚结果。 */
export interface RollbackResult {
  readonly runId: string
  readonly deletedMidEntries: number
  readonly restoredFragments: number
  readonly deletedLongEntries: number
  readonly epochRestoredTo: number
}

/**
 * 按计划回滚一次未完成的压缩。
 *
 * 顺序刻意如此：先删**本次新增**的（它们只可能属于新 epoch），再恢复碎片，
 * 最后把 epoch 退回 —— 每步都幂等，中断后重跑安全。
 *
 * @param db - 数据库。
 * @param run - `started` 状态的运行记录。
 * @returns 回滚统计。
 */
export function rollbackCompactionRun(db: DatabaseSync, run: CompactionRunRow): RollbackResult {
  const plan = JSON.parse(run.plan) as CompactionPlan
  let deletedMidEntries = 0
  let restoredFragments = 0
  let deletedLongEntries = 0

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of plan.pushedIds) {
      const info = db.prepare('DELETE FROM mid_memory_entries WHERE id = ?').run(id)
      deletedMidEntries += Number(info.changes)
    }
    for (const id of plan.longIds ?? []) {
      const info = db.prepare('DELETE FROM long_memory_entries WHERE id = ?').run(id)
      deletedLongEntries += Number(info.changes)
    }
    for (const id of plan.fragmentedIds) {
      // 只在"确实被碎片化了"时恢复，避免把用户/模型主动碎片化的条目误恢复
      const info = db
        .prepare(
          `UPDATE mid_memory_entries
              SET status = 'active', entry_type = 'semantic', fragmented_into = NULL,
                  fragment_hint = NULL, revision = revision + 1
            WHERE id = ? AND status = 'fragmented'`,
        )
        .run(id)
      restoredFragments += Number(info.changes)
    }
    db.prepare("UPDATE forlife_state SET value = ? WHERE key = 'compaction_epoch'").run(String(run.epoch_from))
    db.prepare("UPDATE forlife_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'render_revision'").run()
    db.prepare(
      `UPDATE compaction_runs SET phase = 'aborted', error = ?, ended_at = ? WHERE id = ?`,
    ).run(`回滚：删除 ${String(deletedMidEntries)} 条中期条目，恢复 ${String(restoredFragments)} 个碎片`, nowIso(), run.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { runId: run.id, deletedMidEntries, restoredFragments, deletedLongEntries, epochRestoredTo: run.epoch_from }
}

/** 启动时的校验：把残留的 `started` 全部回滚。 */
export function recoverPendingCompactions(db: DatabaseSync): readonly RollbackResult[] {
  const pending = pendingCompactionRuns(db)
  return pending.map((run) => rollbackCompactionRun(db, run))
}
