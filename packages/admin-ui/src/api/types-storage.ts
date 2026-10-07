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
  /**
   * **分层分布**（阶段 9 交付物 1 的可见性）。
   *
   * **三层都会出现**（哪怕某层是 0）—— 只列"有数据的层"的话，
   * 用户看不出"warm 一层都没用上"这件事。
   */
  readonly tiers: readonly {
    readonly tier: string
    readonly rows: number
    readonly bytes: number
  }[]
  /**
   * 三层根路径 + **哪几层是退回的**。
   *
   * "warm 退回了 hot" 必须显示 —— 否则用户以为真有三层在放，而实际全在一层。
   */
  readonly tierRoots: {
    readonly roots: Readonly<Record<string, string>>
    readonly fellBack: readonly { readonly tier: string; readonly from: string }[]
    /** 没配根路径时服务端会带上这句（而不是给一个假路径）。 */
    readonly note?: string
  }
  /**
   * 碎片状态（阶段 9 交付物 4 的可见性）。
   *
   * `fragmented: -1` 表示**查不到**（不是"零个"）—— 两者含义完全不同。
   */
  readonly fragments: {
    readonly fragmented: number
    /** **归宿已丢的** —— 它们是唯一副本，必须留着，但要让界面能看见。 */
    readonly orphaned: number
    readonly reclaimableTokens: number
    readonly reason: string
  }
}
