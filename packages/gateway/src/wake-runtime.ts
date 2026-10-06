/**
 * 唤醒引擎的运行时装配（PLAN 阶段 8）。
 *
 * ## 把三块接起来
 *
 * ```
 * Trigger Engine ──(到期)──> 派发器 ──(提示词)──> 唤醒桥 ──HTTP──> 插件薄桥 ──> agent.followup
 *      ↑                                          ↓
 *   三张表（gateway 与插件共享同一个库）
 * ```
 *
 * ## 两个"没配就明确禁用"的地方
 *
 * 与端口出口同一个纪律：**没配桥地址/密钥时不要"假装能唤醒"**。
 * 否则 `wake_events` 里会记成 `fired`、面板显示"已唤醒"，
 * 而模型**根本没动** —— 这类假成功比明确的失败难查得多。
 *
 * ## 为什么派发器要读"上次行动"
 *
 * 提示词里要带"上次醒来时你做了什么"。不带的话，模型每次醒来都不知道
 * 自己上次做到哪了 —— 会**重复劳动**，或者接着一个**已经放弃的计划**往下做。
 * 数据就在 `wake_trigger_events` 里，读一次的事。
 *
 * @module @forlife/gateway/wake-runtime
 */
import type { DatabaseSync } from 'node:sqlite'

import { buildWakePrompt } from './wake-prompt.ts'
import { createWakeBridge } from './wake-bridge.ts'
import { createWakeEngine, type WakeEngine, type WakeDispatcher } from './wake-engine.ts'

/** 装配配置。 */
export interface WakeRuntimeOptions {
  readonly db: DatabaseSync
  readonly env: Record<string, string | undefined>
  readonly log: (message: string) => void
  /** 便于测试注入。 */
  readonly fetchImpl?: Parameters<typeof createWakeBridge>[0]['fetchImpl']
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
  readonly now?: () => Date
}

/** 装配结果。 */
export interface WakeRuntime {
  readonly engine: WakeEngine | undefined
  /** 禁用原因（界面要显示它，而不是显示一个点不动的按钮）。 */
  readonly disabledReason: string | undefined
}

/** 从环境变量读唤醒桥配置。 */
export function wakeConfigFromEnv(env: Record<string, string | undefined>): {
  readonly bridgeUrl?: string
  readonly bridgeSecret?: string
  readonly tickMs: number
} {
  const url = env['FORLIFE_WAKE_BRIDGE_URL']
  const secret = env['FORLIFE_WAKE_BRIDGE_SECRET']
  const tick = Number(env['FORLIFE_WAKE_TICK_MS'] ?? '1000')
  return {
    ...(url === undefined || url === '' ? {} : { bridgeUrl: url }),
    ...(secret === undefined || secret === '' ? {} : { bridgeSecret: secret }),
    tickMs: Number.isFinite(tick) && tick >= 100 ? tick : 1000,
  }
}

/** 装配唤醒引擎。 */
export function createWakeRuntime(options: WakeRuntimeOptions): WakeRuntime {
  const { db, log } = options
  const config = wakeConfigFromEnv(options.env)

  // **没配就明确禁用** —— 不假装能唤醒
  if (config.bridgeUrl === undefined || config.bridgeSecret === undefined) {
    const missing = [
      ...(config.bridgeUrl === undefined ? ['FORLIFE_WAKE_BRIDGE_URL'] : []),
      ...(config.bridgeSecret === undefined ? ['FORLIFE_WAKE_BRIDGE_SECRET'] : []),
    ]
    return {
      engine: undefined,
      disabledReason: `唤醒引擎未启用：缺少环境变量 ${missing.join('、')}（需要 DSH 侧挂上唤醒桥）`,
    }
  }

  const bridge = createWakeBridge({
    url: config.bridgeUrl,
    secret: config.bridgeSecret,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  /** 取这个触发器上一次唤醒时"模型做了什么"。 */
  const lastActionOf = (triggerId: string): string | undefined => {
    const row = db
      .prepare(
        `SELECT model_did FROM wake_trigger_events
         WHERE trigger_id = ? AND model_did IS NOT NULL
         ORDER BY fired_at DESC LIMIT 1`,
      )
      .get(triggerId) as { model_did: string | null } | undefined
    return row?.model_did ?? undefined
  }

  const dispatch: WakeDispatcher = async ({ trigger, reason, payload }) => {
    // scope 为 `*` 的触发器**没有会话可唤醒**。
    // 这不是错误配置 —— 有些触发器只是"记账"用的（比如只想知道某件事发生过），
    // 但要**明确说出来**，而不是发一个空 sessionId 让桥去 404。
    if (trigger.scope === '*' || trigger.scope.trim() === '') {
      return { ok: false, reason: '触发器没有绑定会话（scope=*），无处唤醒' }
    }

    const lastAction = lastActionOf(trigger.id)
    const prompt = buildWakePrompt({
      trigger,
      reason,
      payload,
      ...(lastAction === undefined ? {} : { lastAction }),
      ...(trigger.budget_tokens > 0 ? { budgetTokens: trigger.budget_tokens } : {}),
    })

    const result = await bridge.wake({
      sessionId: trigger.scope,
      text: prompt,
      // **sourceKind 必须区分来源**（不能是 'user'）——
      // 否则系统唤醒在会话里看起来像用户发的消息
      sourceKind: `wake-${trigger.kind}`,
      summary: trigger.title,
    })

    return {
      ok: result.ok,
      reason: result.reason,
      ...(result.modelDid === undefined ? {} : { modelDid: result.modelDid }),
    }
  }

  const engine = createWakeEngine({
    db,
    dispatch,
    log,
    tickMs: config.tickMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.setIntervalImpl === undefined ? {} : { setIntervalImpl: options.setIntervalImpl }),
    ...(options.clearIntervalImpl === undefined ? {} : { clearIntervalImpl: options.clearIntervalImpl }),
  })

  log(`唤醒引擎已启用：桥 ${config.bridgeUrl}，tick ${String(config.tickMs)}ms`)
  return { engine, disabledReason: undefined }
}
