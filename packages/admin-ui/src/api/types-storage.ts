/**
 * 存储与迁移的线上契约（镜像 gateway 的 `admin/queries-storage.ts`）。
 *
 * 与其它 types-*.ts 一样：逐字段对齐，可空字段用 `readonly x?: T`
 * （服务端"整个键缺席"的语义，与"值为 null"是两件事）。
 */
export interface StorageTable {
  readonly name: string
  readonly rows: number
  /** 行数为 -1 表示**表不存在**（与"表是空的"不同）。 */
  readonly group: string
}

export interface AppliedMigration {
  readonly version: number
  readonly name: string
  readonly appliedAt: string
}

export interface BackupFile {
  readonly name: string
  readonly sizeBytes: number
  readonly at: string
}

export interface StorageOverview {
  readonly db: {
    readonly path: string
    readonly sizeBytes: number
    readonly walBytes: number
    readonly shmBytes: number
    readonly dirWritable: boolean
  }
  readonly schema: {
    readonly current: number
    readonly latest: number
    /** 落后于代码里的最新迁移（说明进程还没跑过新迁移）。 */
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
