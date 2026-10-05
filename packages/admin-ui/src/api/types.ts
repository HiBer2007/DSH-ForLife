/**
 * 接口返回类型 —— 前端与 gateway 的**契约**。
 *
 * 这里只声明前端真正用到的字段。服务端多给字段不算错（前端忽略即可），
 * 但前端用到的字段服务端必须给 —— 改接口时先改这里，两边都不会跑偏。
 */

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
    readonly version: string
    /** 保真度基线里的参数条数（对账用）。 */
    readonly params: number
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
    readonly activeTokens: number
    readonly fragmentTokens: number
    readonly renderedTokens: number
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
    readonly connected: boolean
    readonly queueDepth: number
    readonly pendingItems: number
    readonly outboxPending: number
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
