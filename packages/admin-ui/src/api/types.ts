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

/**
 * DSH 后端探测结果（`packages/gateway/src/dsh-status.ts` 的 `DshStatus` 的前端镜像）。
 *
 * **为什么总览必须有它**：gateway 与 DSH 是**两个进程**、共享一个库。DSH 挂了时
 * 面板看起来一切正常（QQ 在收、库在写、图表在动），但模型那一侧根本没在跑。
 *
 * ⚠️ 三个状态必须分开表达，混成一个布尔就白做了：
 *  - 字段**缺席**（`overview.dsh === undefined`）= 服务端没探（旧版接口 / 探针被删）；
 *  - `reachable === undefined` = **没配 URL，无法判断**（不是"连不上"）；
 *  - `reachable === false` = **配了但连不上**。
 */
export interface DshStatus {
  /** `undefined` = 未配置，**无法判断**（不是"连不上"）。 */
  readonly reachable: boolean | undefined
  /** HTTP 状态码（可达时有）。 */
  readonly status?: number
  readonly latencyMs?: number
  readonly error?: string
  /** 这次探测的时刻（ISO）。 */
  readonly at: string
  /** 配置的 DSH web 地址（未配则 undefined）。 */
  readonly url: string | undefined
  /** 唤醒桥是否已配置（gateway 侧发唤醒的前提）。 */
  readonly wakeBridgeConfigured: boolean
  /** 唤醒桥地址（未配时整个字段不出现）。 */
  readonly wakeBridgeUrl?: string
  /** 给人看的一句话结论（已含"该怎么理解"）。 */
  readonly note: string
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
    /** **全表**口径：active 条目数（不等于进上下文的条数）。 */
    readonly activeEntries: number
    /** **全表**口径：碎片条目数。 */
    readonly fragmentEntries: number
    readonly longEntries: number
    /** **全表**口径：active 的 token 之和（诊断用；真机曾达 1,505k）。 */
    readonly activeTokens: number
    /** **全表**口径：碎片的 token 之和。 */
    readonly fragmentTokens: number
    /** **窗口**口径：真正进系统提示词的条目数。 */
    readonly windowEntries: number
    /** **窗口**口径：真正进系统提示词的 token 之和 —— 「活跃 token」显示的是它。 */
    readonly windowTokens: number
    /** 被窗口丢掉的条目数。 */
    readonly windowDroppedEntries: number
    /** 被窗口丢掉的 token 之和。 */
    readonly windowDroppedTokens: number
    /** 其中由**条数上限**造成的条数（0 ⇒ token 预算在生效）。 */
    readonly windowDroppedByCount: number
    /** 窗口的 token 预算（基线 `memory.midWindow.maxTokens`）。 */
    readonly windowMaxTokens: number
    /** 窗口的条数上限（基线 `memory.midWindow.maxCount`）。 */
    readonly windowMaxCount: number
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
  /**
   * DSH 后端连接状态（**整段缺席** = 服务端这一轮没探到，界面显示"未知"）。
   *
   * ⚠️ 必须渲染它：这个字段存在的**全部理由**就是"**DSH 挂了时面板看起来一切正常**"。
   * 声明了却不显示，等于白探 —— 2026-10-09 修的就是这条数据链（服务端那边它一度
   * 被展开进了 `time` 对象里，前端这边压根没声明）。
   */
  readonly dsh?: DshStatus
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
