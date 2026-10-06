/**
 * SQLite 连接与迁移器。
 *
 * 三条硬约束（来自 EXECUTION_PLAN 的调研与决策）：
 *  1. **零原生依赖**：用 Node 24 内置的 `node:sqlite`（实测 SQLite 3.53.3 + FTS5 可用）；
 *  2. **多进程同机安全**：WAL + `busy_timeout`，网关与 DSH 进程共享同一个库文件；
 *  3. **迁移只前滚**：有序迁移 + `user_version` + 迁移前自动备份；回滚靠备份，不写 down 迁移。
 *
 * 时间存储一律 **UTC ISO-8601**（EXECUTION_PLAN §2.16：存储用系统时区，显示才转换）。
 *
 * @module @forlife/store/db
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { MIGRATIONS, LATEST_SCHEMA_VERSION, type Migration } from './migrations.ts'

/** 打开选项。 */
export interface OpenOptions {
  /** 数据库文件路径；`:memory:` 表示内存库（测试用）。 */
  readonly file: string
  /** busy 超时（毫秒）。多进程共享时避免 `SQLITE_BUSY` 直接失败。 */
  readonly busyTimeoutMs?: number
  /** 是否在迁移前自动备份（有数据时）。默认 true。 */
  readonly backupBeforeMigrate?: boolean
  /** 迁移日志（默认静默）。 */
  readonly log?: (message: string) => void
}

/** 打开结果。 */
export interface OpenedDatabase {
  readonly db: DatabaseSync
  /** 本次实际应用的迁移版本（已是最新则为空数组）。 */
  readonly applied: readonly number[]
  /** 迁移前的备份文件路径（未备份则为 undefined）。 */
  readonly backupPath?: string
  close(): void
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000

/**
 * 打开（必要时创建并迁移）数据库。
 *
 * @param options - 打开选项。
 * @returns 打开的数据库与迁移结果。
 */
export function openDatabase(options: OpenOptions): OpenedDatabase {
  const { file, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, backupBeforeMigrate = true } = options
  const log = options.log ?? ((): void => {})

  const isMemory = file === ':memory:'
  if (!isMemory) mkdirSync(dirname(file), { recursive: true })

  const db = new DatabaseSync(file)

  // WAL 只在文件库上有意义；内存库设了也无害
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = ' + String(busyTimeoutMs))
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)

  let backupPath: string | undefined
  if (pending.length > 0 && backupBeforeMigrate && !isMemory && from > 0) {
    backupPath = backupDatabase(db, file, from)
    log(`迁移前已备份 v${from} → ${backupPath}`)
  }

  const applied: number[] = []
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum)
      db.exec('COMMIT')
      applied.push(migration.version)
      log(`已应用迁移 v${migration.version} ${migration.name}`)
    } catch (error) {
      db.exec('ROLLBACK')
      // **这里不能走唤醒通道** —— 结构上走不通，不是没做：
      // 迁移失败意味着**这个库本身不可用**，而"标记 system 触发器为到点"
      // 需要写这个库。下面紧接着 db.close()，连写的机会都没有。
      //
      // 所以迁移失败的**上报必须走带外**（日志 / 面板 / 启动失败退出码），
      // 而不是"数据库即通道"那条路。真正的告警在 openDatabase 的调用方那里。
      db.close()
      throw new Error(
        `迁移 v${migration.version}（${migration.name}）失败：${String(error)}` +
          (backupPath === undefined ? '' : `；迁移前备份在 ${backupPath}`),
      )
    }
  }

  return {
    db,
    applied,
    ...(backupPath === undefined ? {} : { backupPath }),
    close: (): void => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // 关闭前的 checkpoint 失败不影响正确性
      }
      db.close()
    },
  }
}

/** 读取当前 schema 版本。 */
export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/**
 * 迁移前备份。
 *
 * WAL 模式下只复制主文件会丢数据，所以先 checkpoint(TRUNCATE) 把 WAL 落盘再复制。
 * 备份采用"先写临时文件再改名"，避免半个备份被误当成可用备份。
 */
export function backupDatabase(db: DatabaseSync, file: string, fromVersion: number): string {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.backup-v${fromVersion}-${stamp}`
  const temp = `${target}.partial`
  if (existsSync(temp)) rmSync(temp, { force: true })
  copyFileSync(file, temp)
  renameSync(temp, target)
  return target
}

/** 迁移清单（供 doctor / 测试展示）。 */
export function migrationList(): readonly Pick<Migration, 'version' | 'name' | 'checksum'>[] {
  return MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }))
}

/** 最新 schema 版本号。 */
export const SCHEMA_VERSION: number = LATEST_SCHEMA_VERSION

/** 存储根下的默认库文件名。 */
export const DEFAULT_DB_FILENAME = join('forlife.sqlite')

