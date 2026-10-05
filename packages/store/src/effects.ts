/**
 * 影响审计（"压缩日志三写"的第三写，也是阶段 3 铁律的地基）。
 *
 * ## 为什么需要它
 *
 * 压缩改了模型的记忆与窗口 —— 这是**会影响模型的操作**，按项目铁律必须留痕：
 * ① `compaction_log`（压缩协议的专用字段，PLAN §4.5 规定）；
 * ② 会话事件 `forlife.compaction.committed`（给会话日志，可回放）；
 * ③ **影响审计**（本表：谁在什么时候因为什么改了什么，且"是否已向模型报告"）。
 *
 * 三者用途不同、都要有：① 是协议数据，② 是会话时间线，③ 是跨功能的统一审计面
 * （阶段 3 的 `admin_actions` 会用同一张表，这样面板只需一个视图）。
 *
 * @module @forlife/store/effects
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './repository.ts'

/** 一条影响记录。 */
export interface EffectRow {
  readonly id: string
  readonly kind: string
  readonly actor: 'system' | 'model' | 'admin'
  readonly subject: string | null
  readonly detail: string
  readonly affects_model: number
  readonly reported: number
  readonly created_at: string
}

/** 记录一次影响。 */
export function recordEffect(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly kind: string
    readonly actor: 'system' | 'model' | 'admin'
    readonly subject?: string | null
    readonly detail: unknown
    /** 是否影响模型（默认 true ⇒ 需要向模型报告）。 */
    readonly affectsModel?: boolean
  },
): EffectRow {
  db.prepare(
    `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    input.id,
    input.kind,
    input.actor,
    input.subject ?? null,
    JSON.stringify(input.detail ?? {}),
    input.affectsModel === false ? 0 : 1,
    nowIso(),
  )
  const row = getEffect(db, input.id)
  if (row === undefined) throw new Error('写入后读不到影响记录')
  return row
}

/** 按 id 取影响记录。 */
export function getEffect(db: DatabaseSync, id: string): EffectRow | undefined {
  return db.prepare('SELECT * FROM effects WHERE id = ?').get(id) as EffectRow | undefined
}

/** 列最近的影响记录。 */
export function listEffects(db: DatabaseSync, limit = 50, kind?: string): readonly EffectRow[] {
  return (
    kind === undefined
      ? db.prepare('SELECT * FROM effects ORDER BY created_at DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM effects WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit)
  ) as unknown as EffectRow[]
}

/**
 * 取出"尚未向模型报告"的影响（铁律 1：后台任何影响模型的操作都要唤醒/注入报告）。
 *
 * @param db - 数据库。
 * @param limit - 最多取多少条。
 * @returns 待报告的影响记录（按时间升序，保证报告顺序与发生顺序一致）。
 */
export function listUnreportedEffects(db: DatabaseSync, limit = 50): readonly EffectRow[] {
  return db
    .prepare('SELECT * FROM effects WHERE affects_model = 1 AND reported = 0 ORDER BY created_at ASC LIMIT ?')
    .all(limit) as unknown as EffectRow[]
}

/** 标记为已报告。 */
export function markEffectsReported(db: DatabaseSync, ids: readonly string[]): number {
  if (ids.length === 0) return 0
  let changed = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const statement = db.prepare('UPDATE effects SET reported = 1 WHERE id = ? AND reported = 0')
    for (const id of ids) changed += Number(statement.run(id).changes)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return changed
}
