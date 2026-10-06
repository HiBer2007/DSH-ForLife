/**
 * 接口返回类型 —— 前端与 gateway 的**契约**。
 *
 * 这里只声明前端真正用到的字段。服务端多给字段不算错（前端忽略即可），
 * 但前端用到的字段服务端必须给 —— 改接口时先改这里，两边都不会跑偏。
 */

/** `GET /api/admin/series?hours=24` —— 运行图表的时序数据（按小时分桶）。 */
export interface SeriesPayload {
  /** 每个桶的起点（ISO），长度固定 = hours。 */
  readonly buckets: readonly string[]
  readonly bucketMinutes: number
  readonly hours: number
  readonly metrics: {
    readonly messages: readonly number[]
    readonly turns: readonly number[]
    readonly routing: readonly number[]
    readonly degraded: readonly number[]
    readonly promptTokens: readonly number[]
    /** 命中率 0..1；该桶没有模型调用时为 **null**（不是 0）。 */
    readonly cacheHitRate: readonly (number | null)[]
    readonly outboxSent: readonly number[]
    readonly outboxFailed: readonly number[]
  }
}

/** `GET /api/admin/memory` —— 记忆板块。 */
export interface MemoryEntryRow {
  readonly id: string
  readonly entryType: string
  readonly status: string
  readonly summary: string
  readonly contentPreview: string
  readonly tokenCount: number
  readonly windowOffset: number
  readonly compactionEpoch: number
  readonly sourceScope?: string
  readonly createdAt: string
  readonly lastAccessedAt?: string
}

export interface MemoryOverview {
  readonly epoch: number
  readonly revision: number
  readonly counts: { readonly active: number; readonly fragmented: number; readonly archived: number; readonly long: number }
  readonly tokens: { readonly active: number; readonly fragment: number }
  readonly entries: readonly MemoryEntryRow[]
}

/** `GET /api/admin/compaction` —— 压缩板块。 */
export interface CompactionRunRow {
  readonly id: string
  readonly phase: string
  readonly epochFrom: number
  readonly epochTo?: number
  readonly startedAt: string
  readonly endedAt?: string
  readonly error?: string
  readonly detailPreview?: string
}

export interface CompactionLogRow {
  readonly id: string
  readonly timestamp: string
  readonly requestedBy?: string
  readonly approved?: boolean
  readonly reasonIfRejected?: string
  readonly shortTokensBefore: number
  readonly keptInShortTokens: number
  readonly modelUsed?: string
}

export interface CompactionOverview {
  readonly runs: readonly CompactionRunRow[]
  readonly log: readonly CompactionLogRow[]
  readonly stats: {
    readonly committed: number
    readonly aborted: number
    readonly started: number
    readonly lastAt?: string
    readonly tokensBefore?: number
    readonly tokensAfter?: number
  }
}

/** `GET /api/admin/session` */
export interface SessionInfo {
  readonly authenticated: boolean
  readonly needsSetup: boolean
  readonly expiresAt?: string
}

/** `GET /api/admin/overview` —— 运行总览。 */
export interface Overview {
  /** 服务端生成这份数据的时刻（ISO）。 */
  readonly at: string
  readonly build: {
    readonly schemaVersion: number
    readonly node: string
    readonly uptimeSec: number
  }
  readonly db: {
    readonly path: string
    readonly sizeBytes: number
    readonly walBytes: number
  }
  readonly memory: {
    readonly epoch: number
    readonly revision: number
    readonly activeEntries: number
    readonly fragmentEntries: number
    readonly longEntries: number
    readonly activeTokens: number
    readonly fragmentTokens: number
    readonly lastWriteAt?: string
  }
  readonly compaction: {
    readonly runs: number
    readonly failedRuns: number
    readonly lastAt?: string
    readonly lastStatus?: string
    readonly tokensBefore?: number
    readonly tokensAfter?: number
  }
  readonly qq: {
    /** `undefined` = 本服务没接管 QQ 连接，无法判断（不是"离线"）。 */
    readonly connected?: boolean
    readonly queueDepth: number
    readonly pendingItems: number
    readonly outboxPending: number
    readonly sessions: number
    readonly lastInboundAt?: string
    readonly lastTurnAt?: string
  }
  readonly routing: {
    readonly endpoints: number
    readonly healthyEndpoints: number
    readonly total24h: number
    readonly degraded24h: number
    readonly uncertainPending: number
    readonly lastSwitchAt?: string
  }
  readonly prompts: {
    readonly slots: number
    readonly overrides: number
    readonly revisions: number
  }
  readonly time: {
    readonly authorityTz: string
    readonly driftMs?: number
    readonly lastReadingAt?: string
  }
}
