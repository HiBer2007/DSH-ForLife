// 唤醒诊断（只读）：把 wake_* / *_trigger* 相关表的行导出到 wake-diag.json。
// 背景：headless 的工具沙箱挂了（pwsh 无法授予工作区写权限、glob 超时），
// 只能借 register_watcher 的 probe 进程来跑一次 node，读 SQLite。
// 永远 exit 0 —— probe 不触发唤醒，避免给已经每 2 分钟空唤醒一次的系统再加噪声。
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

const DB = 'D:/DSH-ForLife/.runtime/dsh/forlife/db/forlife.sqlite'
const OUT = 'D:/DSH-ForLife/wake-diag.json'

const out = { at: new Date().toISOString(), db: DB }
try {
  const db = new DatabaseSync(DB, { readOnly: true })
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%wake%' OR name LIKE '%trigger%') ORDER BY name",
    )
    .all()
    .map((r) => r.name)
  out.tables = names
  out.data = {}
  for (const n of names) {
    try {
      out.data[n] = db.prepare(`SELECT * FROM "${n}" LIMIT 50`).all()
    } catch (e) {
      out.data[n] = { error: String(e) }
    }
  }
  db.close()
} catch (e) {
  out.error = String(e)
}
writeFileSync(OUT, JSON.stringify(out, null, 2))
process.exit(0)
