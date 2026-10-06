/**
 * 存储页的写动作：**立即备份**。
 *
 * ## 为什么加的是"备份"而不是"清理"
 *
 * 存储页原本在「清理」那块写着「这里刻意没有按钮」，理由充分：
 * 清理是**破坏性**动作，该走明确流程（先备份、再确认、可回滚），
 * 不该是顺手一点的界面按钮。**这个理由仍然成立，我没有推翻它。**
 *
 * 但那一块确实缺一个**安全且真正有用**的写动作：
 * 页面能**看见**备份清单，却**不能在面板里做一份备份** ——
 * 而它自己写的流程第一步就是"先备份"。**能看不能做**正是用户抱怨的那类问题。
 *
 * ## 为什么用 VACUUM INTO
 *
 * - **原子**：要么完整生成，要么什么都不留（不会留下半截文件被误当成可用备份）；
 * - **紧凑**：顺带整理碎片，备份比直接拷文件小；
 * - **不动原库**：只读原库、写出一个新文件，**不修改、不锁死**正在用的数据库
 *   （对比 `VACUUM`：那会重写原库并需要独占锁，在有流量的服务里是危险的）。
 *
 * @module @forlife/gateway/admin/storage-write
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** 备份结果。 */
export interface BackupResult {
  readonly ok: boolean
  readonly reason: string
  readonly path?: string
  readonly sizeBytes?: number
}

/**
 * 立即做一份备份。
 *
 * @param db - 数据库句柄。
 * @param options.dbPath - 原库路径（备份放在它旁边）。
 * @param options.now - 便于测试。
 */
export function backupNow(db: DatabaseSync, options: { readonly dbPath: string; readonly now?: Date }): BackupResult {
  if (options.dbPath === '' || options.dbPath === ':memory:') {
    // 内存库没有"文件"可备份 —— 明确说清，而不是生成一个空文件让人以为备份成功了
    return { ok: false, reason: '内存库无法备份（没有对应文件）' }
  }

  const now = options.now ?? new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = `${options.dbPath}.backup-manual-${stamp}`

  // 同名文件已存在就直接拒绝：VACUUM INTO **要求目标不存在**，
  // 否则报错。提前判一下能给出更清楚的原因。
  if (existsSync(target)) return { ok: false, reason: `目标文件已存在：${target}` }

  try {
    // 参数化不行（VACUUM INTO 只接受字面量），所以要转义单引号防注入
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } catch (error) {
    return { ok: false, reason: `备份失败：${String(error).slice(0, 200)}` }
  }

  if (!existsSync(target)) return { ok: false, reason: '备份命令没有报错，但目标文件不存在 —— 不要当成成功' }

  const sizeBytes = statSync(target).size
  // 空文件也算失败：那说明备份没真正写出内容，而"有个文件"最容易让人放心
  if (sizeBytes === 0) return { ok: false, reason: '备份文件是空的 ⇒ 视为失败' }

  return { ok: true, reason: `已备份（${String(Math.round(sizeBytes / 1024))} KB）`, path: target, sizeBytes }
}

/** 列出备份文件（含手动与迁移前的）。 */
export function listBackups(dbPath: string): readonly { readonly name: string; readonly sizeBytes: number; readonly at: string }[] {
  if (dbPath === '' || dbPath === ':memory:') return []
  const dir = join(dbPath, '..')
  const base = dbPath.slice(dir.length + 1)
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.backup`))
      .map((name) => {
        const stat = statSync(join(dir, name))
        return { name, sizeBytes: stat.size, at: stat.mtime.toISOString() }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  } catch {
    return []
  }
}

/** 占位：让调用方知道 mkdirSync 是为将来"备份到指定目录"留的。 */
export const ensureDir = mkdirSync
