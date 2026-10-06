/**
 * 「存储与迁移」板块的数据。
 *
 * 这一页要回答三个运维问题：
 *  1. **磁盘会不会满**：库、WAL、长期记忆 blob 各占多少；
 *  2. **哪些表在涨**：行数排行 —— 涨得最快的那张表就是下一个要治理的对象；
 *  3. **迁移到哪一版了**：`schema_migrations` 的账本 + 备份文件清单
 *     （迁移前的自动备份是最后一道保险，得能看见它在不在）。
 *
 * 刻意**不做**的事：不提供"删数据"按钮。清理是破坏性动作，应该由明确的运维流程做，
 * 不该是一个顺手点下去的界面按钮。
 *
 * @module @forlife/gateway/admin/queries-storage
 */
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { LATEST_SCHEMA_VERSION } from '@forlife/store'

/** 一张表的大小概览。 */
export interface StorageTable {
  readonly name: string
  readonly rows: number
  /** 这张表在我们关心的哪一类里（便于分组看）。 */
  readonly group: string
}

/** 已应用的迁移。 */
export interface AppliedMigration {
  readonly version: number
  readonly name: string
  readonly appliedAt: string
}

/** 备份文件。 */
export interface BackupFile {
  readonly name: string
  readonly sizeBytes: number
  readonly at: string
}

/** 板块数据。 */
export interface StorageOverview {
  readonly db: {
    readonly path: string
    readonly sizeBytes: number
    readonly walBytes: number
    readonly shmBytes: number
    /** 目录可写（能不能继续写库）。 */
    readonly dirWritable: boolean
  }
  readonly schema: {
    readonly current: number
    readonly latest: number
    /** 是否落后于代码里的最新迁移（落后说明进程没跑过新迁移）。 */
    readonly behind: boolean
  }
  readonly migrations: readonly AppliedMigration[]
  readonly backups: readonly BackupFile[]
  readonly tables: readonly StorageTable[]
  readonly totals: {
    readonly rows: number
    readonly backupBytes: number
  }
}

/** 我们关心的表（按用途分组，便于一眼看出谁在涨）。 */
const WATCHED: readonly { name: string; group: string }[] = [
  { name: 'mid_memory_entries', group: '记忆' },
  { name: 'long_memory_entries', group: '记忆' },
  { name: 'spill_entries', group: '记忆' },
  { name: 'compaction_runs', group: '压缩' },
  { name: 'compaction_log', group: '压缩' },
  { name: 'qq_inbox', group: 'QQ' },
  { name: 'qq_outbox', group: 'QQ' },
  { name: 'qq_turns', group: 'QQ' },
  { name: 'qq_sessions', group: 'QQ' },
  { name: 'pending_messages', group: 'QQ' },
  { name: 'wake_rules', group: '唤醒' },
  { name: 'wake_events', group: '唤醒' },
  { name: 'model_routes', group: '模型' },
  { name: 'routing_log', group: '模型' },
  { name: 'uncertain_cases', group: '模型' },
  { name: 'inference_endpoints', group: '模型' },
  { name: 'cache_metrics', group: '缓存' },
  { name: 'time_readings', group: '时间' },
  { name: 'time_drift', group: '时间' },
  { name: 'prompt_revisions', group: '提示词' },
  { name: 'prompt_overrides', group: '提示词' },
  { name: 'admin_audit', group: '后台' },
  { name: 'admin_sessions', group: '后台' },
  { name: 'admin_chat', group: '后台' },
  { name: 'effects', group: '审计' },
  { name: 'image_descriptions', group: '媒体' },
  { name: 'vision_call_log', group: '媒体' },
]

/** 文件大小（不存在给 0）。 */
function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 查行数（表不存在给 -1，而不是 0 —— 0 会被误读成"表是空的"）。 */
function rows(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS v FROM ${table}`).get() as { v?: number } | undefined
    return row?.v ?? 0
  } catch {
    return -1
  }
}

/** 组装板块数据。 */
export function queryStorage(db: DatabaseSync, options: { readonly dbPath: string }): StorageOverview {
  const path = options.dbPath
  const dir = dirname(path)

  const applied = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string; applied_at: string }[]
  const current = applied.length === 0 ? 0 : Math.max(...applied.map((row) => row.version))

  // 备份清单：迁移前的自动备份就放在库旁边，命名规则见 store/db.ts
  let backups: BackupFile[] = []
  try {
    backups = readdirSync(dir)
      .filter((name) => name.includes('.backup-'))
      .map((name) => ({
        name,
        sizeBytes: size(join(dir, name)),
        at: (() => {
          try {
            return statSync(join(dir, name)).mtime.toISOString()
          } catch {
            return ''
          }
        })(),
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  } catch {
    backups = []
  }

  const tables: StorageTable[] = WATCHED.map((item) => ({
    name: item.name,
    group: item.group,
    rows: rows(db, item.name),
  }))

  let dirWritable = true
  try {
    statSync(dir)
  } catch {
    dirWritable = false
  }

  return {
    db: {
      path,
      sizeBytes: size(path),
      walBytes: size(`${path}-wal`),
      shmBytes: size(`${path}-shm`),
      dirWritable,
    },
    schema: {
      current,
      latest: LATEST_SCHEMA_VERSION,
      behind: current < LATEST_SCHEMA_VERSION,
    },
    migrations: applied.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at })),
    backups,
    tables,
    totals: {
      rows: tables.reduce((sum, table) => sum + Math.max(0, table.rows), 0),
      backupBytes: backups.reduce((sum, file) => sum + file.sizeBytes, 0),
    },
  }
}
