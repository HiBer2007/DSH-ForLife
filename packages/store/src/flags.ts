/**
 * 运行时开关（`forlife_state` 的布尔键）。
 *
 * 为什么单独一个文件而不是散在各处 `SELECT value FROM forlife_state`：
 * 开关的**读法**必须一致 —— 缺键、空串、`'0'`、`'false'` 都要判成"关"，
 * 而"忘了判某一种"会表现成"开关偶尔不生效"，那种 bug 极难复现。
 *
 * @module @forlife/store/flags
 */
import type { DatabaseSync } from 'node:sqlite'

/** 已定义的开关（用常量而不是裸字符串，避免拼错后静默失效）。 */
export const FLAG_QQ_TAKEOVER = 'qq_takeover'

/**
 * 读一个布尔开关。
 *
 * 只有明确的真值才算开：`1` / `true` / `on` / `yes`（大小写不敏感）。
 * 缺键或其它任何值都算**关** —— 默认必须是"不改变既有行为"。
 */
export function getFlag(db: DatabaseSync, key: string): boolean {
  const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value?: string } | undefined
  const value = (row?.value ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'yes'
}

/** 写一个布尔开关。 */
export function setFlag(db: DatabaseSync, key: string, value: boolean, note?: string): void {
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value ? '1' : '0')
  // 留一条痕迹：开关什么时候被谁动过，是排障时最想知道的事
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`${key}_changed_at`, note === undefined ? at : `${at} ${note}`)
}
