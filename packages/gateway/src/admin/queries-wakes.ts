/**
 * 面板「触发器」页的查询（PLAN 阶段 8 交付物 7）。
 *
 * ## 这页要回答的问题
 *
 * 用户打开它时想知道的是：
 *  1. **我安排过什么**（列表：下次触发 / 最近触发 / 是否还活着）；
 *  2. **它到底醒过没有、花了多少钱、醒的时候干了什么**（唤醒历史）；
 *  3. **现在是不是被暂停了**（全局开关）；
 *  4. **监视程序在跑吗**（状态与最近错误）。
 *
 * ## 两个刻意的处理
 *
 * 1. **"健康"要能看出三种不同的坏**：从没触发过（可能没到点，也可能根本没生效）、
 *    最近失败、已停用。压成一个 `ok: false` 的话，用户不知道该去查哪。
 * 2. **花费要按触发器汇总**，不能只给总数 —— "这个触发器烧了 20 万 token"
 *    才是能指导行动的结论。
 *
 * @module @forlife/gateway/admin/queries-wakes
 */
import type { DatabaseSync } from 'node:sqlite'

import { isWakePaused, listWakeEvents, listWakeTriggers, type WakeTriggerRow } from '@forlife/store'

/** 一个触发器的面板视图。 */
export interface WakeTriggerView {
  readonly id: string
  readonly kind: string
  readonly scope: string
  readonly title: string
  readonly prompt: string
  readonly enabled: boolean
  readonly nextFireAt: string | null
  readonly lastFiredAt: string | null
  readonly fireCount: number
  /** 健康判定（**三种不同的坏要能分开**）。 */
  readonly health: 'ok' | 'idle' | 'failing' | 'disabled'
  readonly healthNote: string
  readonly dailyLimit: number
  readonly budgetTokens: number
  readonly spentTokens: number
  readonly quietUntil: string | null
  readonly depth: number
  readonly createdAt: string
}

/** 一个监视程序的面板视图。 */
export interface WakeProgramView {
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

/** 整页数据。 */
export interface WakesOverview {
  readonly paused: boolean
  readonly triggers: readonly WakeTriggerView[]
  readonly programs: readonly WakeProgramView[]
  readonly events: readonly {
    readonly id: string
    readonly triggerId: string | null
    readonly kind: string
    readonly firedAt: string
    readonly decision: string
    readonly reason: string | null
    readonly costTokens: number | null
    readonly modelDid: string | null
  }[]
  readonly stats: {
    readonly triggers: number
    readonly enabled: number
    readonly firedTotal: number
    readonly spentTokens: number
  }
}

/**
 * 判一个触发器的健康。
 *
 * **三种"坏"要分开**：
 *  - `disabled`：用户停用了它；
 *  - `failing`：最近一次是失败的（派发失败 / 桥不通）；
 *  - `idle`：一次都没触发过（可能只是还没到点，也可能是根本没生效）。
 */
function healthOf(row: WakeTriggerRow, lastDecision: string | undefined): { health: WakeTriggerView['health']; note: string } {
  if (row.enabled !== 1) return { health: 'disabled', note: '已停用' }
  if (lastDecision === 'failed') return { health: 'failing', note: '最近一次唤醒失败（看历史里的原因）' }
  if (lastDecision === undefined) {
    // 从没触发过：说清"它还没到点"，而不是笼统的"未知"
    return { health: 'idle', note: row.next_fire_at === null ? '还没触发过（且没有下次时间）' : `还没触发过，下次 ${row.next_fire_at}` }
  }
  return { health: 'ok', note: '正常' }
}

/** 查整页。 */
export function queryWakes(db: DatabaseSync, eventLimit = 50): WakesOverview {
  const rows = listWakeTriggers(db)
  const events = listWakeEvents(db, eventLimit)

  // 每个触发器最近一次的决策（用于判健康）
  const lastDecision = new Map<string, string>()
  for (const e of events) {
    const id = e['trigger_id']
    if (typeof id === 'string' && !lastDecision.has(id)) {
      lastDecision.set(id, String(e['decision'] ?? ''))
    }
  }

  // 花费按触发器汇总 —— "这个触发器烧了 20 万 token"才是能指导行动的结论
  const spentByTrigger = new Map<string, number>()
  for (const e of events) {
    const id = e['trigger_id']
    const cost = e['cost_tokens']
    if (typeof id === 'string' && typeof cost === 'number') {
      spentByTrigger.set(id, (spentByTrigger.get(id) ?? 0) + cost)
    }
  }

  const triggers: WakeTriggerView[] = rows.map((row) => {
    const { health, note } = healthOf(row, lastDecision.get(row.id))
    return {
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      nextFireAt: row.next_fire_at,
      lastFiredAt: row.last_fired_at,
      fireCount: row.fire_count,
      health,
      healthNote: note,
      dailyLimit: row.daily_limit,
      budgetTokens: row.budget_tokens,
      spentTokens: spentByTrigger.get(row.id) ?? 0,
      quietUntil: row.quiet_until,
      depth: row.depth,
      createdAt: row.created_at,
    }
  })

  const programs = db
    .prepare('SELECT * FROM wake_programs ORDER BY name')
    .all() as unknown as {
    id: string
    name: string
    contract: string
    path: string
    status: string
    enabled: number
    restart_count: number
    last_started_at: string | null
    last_exit_at: string | null
    last_exit_code: number | null
    last_error: string | null
  }[]

  return {
    paused: isWakePaused(db),
    triggers,
    programs: programs.map((p) => ({
      id: p.id,
      name: p.name,
      contract: p.contract,
      path: p.path,
      status: p.status,
      enabled: p.enabled === 1,
      restartCount: p.restart_count,
      lastStartedAt: p.last_started_at,
      lastExitAt: p.last_exit_at,
      lastExitCode: p.last_exit_code,
      lastError: p.last_error,
    })),
    events: events.map((e) => ({
      id: String(e['id']),
      triggerId: typeof e['trigger_id'] === 'string' ? e['trigger_id'] : null,
      kind: String(e['kind']),
      firedAt: String(e['fired_at']),
      decision: String(e['decision']),
      reason: typeof e['reason'] === 'string' ? e['reason'] : null,
      costTokens: typeof e['cost_tokens'] === 'number' ? e['cost_tokens'] : null,
      modelDid: typeof e['model_did'] === 'string' ? e['model_did'] : null,
    })),
    stats: {
      triggers: triggers.length,
      enabled: triggers.filter((t) => t.enabled).length,
      firedTotal: triggers.reduce((sum, t) => sum + t.fireCount, 0),
      spentTokens: triggers.reduce((sum, t) => sum + t.spentTokens, 0),
    },
  }
}
