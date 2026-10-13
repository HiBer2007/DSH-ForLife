/** 触发器页的数据形状（与 GET /api/admin/wakes 对齐）。 */
export interface WakeTriggerRow {
  readonly id: string
  readonly kind: string
  readonly scope: string
  readonly title: string
  readonly prompt: string
  readonly enabled: boolean
  readonly nextFireAt: string | null
  readonly lastFiredAt: string | null
  readonly fireCount: number
  readonly health: 'ok' | 'idle' | 'failing' | 'disabled'
  readonly healthNote: string
  readonly dailyLimit: number
  readonly budgetTokens: number
  readonly spentTokens: number
  readonly quietUntil: string | null
  readonly depth: number
  readonly createdAt: string
}

export interface WakeProgramRow {
  readonly id: string
  readonly name: string
  readonly contract: string
  readonly path: string
  readonly status: string
  readonly enabled: boolean
  readonly restartCount: number
  readonly lastStartedAt: string | null
  readonly lastExitAt: string | null
  readonly lastExitCode: number | null
  readonly lastError: string | null
}

export interface WakeEventRow {
  readonly id: string
  readonly triggerId: string | null
  readonly kind: string
  readonly firedAt: string
  readonly decision: string
  readonly reason: string | null
  readonly costTokens: number | null
  readonly modelDid: string | null
}

export interface WakesOverview {
  readonly paused: boolean
  readonly triggers: readonly WakeTriggerRow[]
  readonly programs: readonly WakeProgramRow[]
  readonly events: readonly WakeEventRow[]
  readonly stats: {
    readonly triggers: number
    readonly enabled: number
    readonly firedTotal: number
    readonly spentTokens: number
  }
}
