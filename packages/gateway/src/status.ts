/**
 * 状态通道（EXECUTION_PLAN §2.17.6，按用户拍板）。
 *
 * ## 为什么状态不是一个字段而是"两个来源"
 *
 * 用户明确要求：状态分为
 *  ① **模型主动设置**的（"我在忙""我去睡了"）；
 *  ② **系统因为模型无法正确唤醒/执行**而设置的故障状态。
 *
 * 两者的可信度不同：系统状态是**运维信号**，模型不能悄悄把它改成"在线" ——
 * 否则你看到的"在线"可能是幻觉，而真实情况是它已经连续唤醒失败 3 次。
 * 所以：**系统状态带原因（reason）且受锁保护；要清必须显式清，且会留痕。**
 *
 * 默认策略（§2.17.6）：能唤醒就先让模型自己决定；唤不醒才落到预设文案（预设文案模型可改）。
 *
 * @module @forlife/gateway/status
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { nowIso } from '@forlife/store'

/** 状态来源。 */
export type StatusSource = 'model' | 'system'

/** 状态值。 */
export type StatusState = 'online' | 'away' | 'busy' | 'custom'

/** 当前状态。 */
export interface CurrentStatus {
  readonly source: StatusSource
  readonly state: StatusState
  readonly text: string | null
  readonly reason: string | null
  readonly since: string
  readonly updatedAt: string
}

/** 设置结果。 */
export type SetStatusResult =
  | { readonly ok: true; readonly status: CurrentStatus }
  | { readonly ok: false; readonly code: 'locked_by_system'; readonly message: string; readonly status: CurrentStatus }

/** 读当前状态。 */
export function currentStatus(db: DatabaseSync): CurrentStatus | undefined {
  const row = db.prepare('SELECT * FROM status_state WHERE id = 1').get() as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return {
    source: String(row['source']) as StatusSource,
    state: String(row['state']) as StatusState,
    text: row['text'] === null ? null : String(row['text']),
    reason: row['reason'] === null ? null : String(row['reason']),
    since: String(row['since']),
    updatedAt: String(row['updated_at']),
  }
}

/**
 * 模型主动设置状态。
 *
 * @param db - 数据库。
 * @param input - 状态与文案。
 * @returns 设置结果；若正被系统状态锁住，返回 `locked_by_system` 而不是悄悄覆盖。
 */
export function setModelStatus(
  db: DatabaseSync,
  input: { readonly state: StatusState; readonly text?: string },
): SetStatusResult {
  const existing = currentStatus(db)
  if (existing?.source === 'system') {
    // 关键：不静默覆盖。模型可以先 `acknowledge_system_status`（或让系统清除），但绝不能假装没事
    return {
      ok: false,
      code: 'locked_by_system',
      message:
        `当前是系统设置的状态（${existing.state}${existing.reason === null ? '' : `：${existing.reason}`}），` +
        '你的设置没有生效。若问题已解决，可调用 clear_system_status 说明原因后清除。',
      status: existing,
    }
  }
  const at = nowIso()
  db.prepare(
    `INSERT INTO status_state (id, source, state, text, reason, since, updated_at)
     VALUES (1, 'model', ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = 'model', state = excluded.state, text = excluded.text,
       reason = NULL, since = CASE WHEN status_state.source = 'model' THEN status_state.since ELSE excluded.since END,
       updated_at = excluded.updated_at`,
  ).run(input.state, input.text ?? null, existing === undefined ? at : existing.since, at)
  const status = currentStatus(db)
  if (status === undefined) throw new Error('写入后读不到状态')
  return { ok: true, status }
}

/**
 * 系统设置故障状态（带原因，受锁保护）。
 *
 * @param db - 数据库。
 * @param input - 故障分类与原因。
 * @returns 设置后的状态。
 */
export function setSystemStatus(db: DatabaseSync, input: { readonly state: StatusState; readonly reason: string; readonly text?: string }): CurrentStatus {
  const at = nowIso()
  db.prepare(
    `INSERT INTO status_state (id, source, state, text, reason, since, updated_at)
     VALUES (1, 'system', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = 'system', state = excluded.state, text = excluded.text, reason = excluded.reason,
       since = CASE WHEN status_state.source = 'system' THEN status_state.since ELSE excluded.since END,
       updated_at = excluded.updated_at`,
  ).run(input.state, input.text ?? null, input.reason, at, at)
  const status = currentStatus(db)
  if (status === undefined) throw new Error('写入后读不到状态')
  return status
}

/**
 * 清除系统状态（必须说明原因 —— 谁清的、为什么清，要能追溯）。
 *
 * @param db - 数据库。
 * @param input - 清除者与原因。
 * @returns 是否真的清除了（本来就不是系统状态则返回 false）。
 */
export function clearSystemStatus(db: DatabaseSync, input: { readonly clearedBy: 'model' | 'admin' | 'system'; readonly reason: string }): boolean {
  const existing = currentStatus(db)
  if (existing?.source !== 'system') return false
  const at = nowIso()
  db.prepare(
    `UPDATE status_state SET source = 'model', state = 'online', text = ?, reason = NULL, updated_at = ? WHERE id = 1`,
  ).run(`系统状态已由 ${input.clearedBy} 清除：${input.reason}`, at)
  return true
}

/** 故障状态的默认文案（预设；模型可改）。 */
export function failurePresetText(db: DatabaseSync, reason: string, attempts: number): string {
  const row = db.prepare("SELECT text FROM status_presets WHERE key = 'failure'").get() as { text: string } | undefined
  const template = row?.text ?? defaultFor<string>('status.presets.failureTemplate')
  return template.replace('{reason}', reason).replace('{n}', String(attempts))
}

/** 改预设文案（模型可改 —— 用户要求"预设文案模型可改"）。 */
export function setStatusPreset(db: DatabaseSync, key: string, text: string, updatedBy: 'model' | 'admin' | 'system'): void {
  db.prepare(
    `INSERT INTO status_presets (key, text, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, text, updatedBy, nowIso())
}

/**
 * 连续唤醒失败计数（用于自动置故障状态）。
 *
 * 存 `forlife_state`，跨重启保留：进程重启不该把"它已经坏了 3 次"的记忆清掉。
 *
 * @param db - 数据库。
 * @param succeeded - 本次唤醒是否成功。
 * @returns 失败计数与是否达到阈值。
 */
export function recordWakeAttempt(db: DatabaseSync, succeeded: boolean): { readonly failures: number; readonly threshold: number; readonly tripped: boolean } {
  const threshold = defaultFor<number>('status.systemOnWakeFailures')
  const key = 'status_wake_failures'
  const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value: string } | undefined
  const failures = succeeded ? 0 : Number(row?.value ?? '0') + 1
  db.prepare('INSERT INTO forlife_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(failures),
  )
  return { failures, threshold, tripped: failures >= threshold }
}
