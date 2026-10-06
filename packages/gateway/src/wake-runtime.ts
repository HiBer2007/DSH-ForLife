/**
 * 唤醒引擎的运行时装配（PLAN 阶段 8）。
 *
 * ## 三条通道，一个引擎
 *
 * ```
 * timer    ──(引擎自己 tick)──────────────────┐
 * watcher  ──(监视源 tick → 设 next_fire_at)──┤
 * system   ──(事件源 observe → 设 next_fire_at)┤──> 同一个 tick 扫到 → 过闸 → 派发
 * external ──(HTTP → 设 next_fire_at)─────────┘
 * ```
 *
 * **三条通道最终都落在"把 next_fire_at 设成现在"这一个动作上** ——
 * 这不是偷懒，而是刻意的：**只有一个入口，就不会出现"某条通道绕过了六道闸"这种事**。
 *
 * ## 监视 tick 与引擎 tick 分开
 *
 * 引擎 tick 是 1 秒（要准时）；监视 tick 默认也是 1 秒，但它**可以更慢** ——
 * 监视条件的求值要读文件（可能很慢），而引擎 tick 必须轻快。
 * 所以它们是两个独立的定时器，间隔可分别配置。
 *
 * ## 监视源没配工作区时**明确禁用**
 *
 * 与端口出口同一纪律：没配 `FORLIFE_WORKSPACE_ROOT` 时，监视条件**无法求值**
 * （路径没有沙箱根可比）。这时不启动监视 tick，并给出原因 ——
 * 而不是让它每秒钟失败一次（那会把日志刷满，把真正的错误淹掉）。
 *
 * @module @forlife/gateway/wake-runtime
 */
import type { DatabaseSync } from 'node:sqlite'

import { createWakeBridge } from './wake-bridge.ts'
import { createWakeEngine, type WakeEngine, type WakeDispatcher } from './wake-engine.ts'
import { buildWakePrompt } from './wake-prompt.ts'
import { createSystemWakeSource, type SystemWakeSource } from './wake-system-source.ts'
import { createWatchSource, type WatchSource } from './wake-watch-source.ts'

/** 装配配置。 */
export interface WakeRuntimeOptions {
  readonly db: DatabaseSync
  readonly env: Record<string, string | undefined>
  readonly log: (message: string) => void
  readonly fetchImpl?: Parameters<typeof createWakeBridge>[0]['fetchImpl']
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
  readonly now?: () => Date
}

/** 装配结果。 */
export interface WakeRuntime {
  readonly engine: WakeEngine | undefined
  /** 系统事件源（QQ 掉线等由调用方 observe；未启用时为 undefined）。 */
  readonly systemSource: SystemWakeSource | undefined
  /** 监视源（未配工作区时为 undefined）。 */
  readonly watchSource: WatchSource | undefined
  /** 引擎禁用原因（界面要显示它）。 */
  readonly disabledReason: string | undefined
  /** 监视源禁用原因 —— **与引擎的原因分开**（它们可能一个启用一个没启用）。 */
  readonly watchDisabledReason: string | undefined
  readonly stop: () => void
}

/** 从环境变量读唤醒桥配置。 */
export function wakeConfigFromEnv(env: Record<string, string | undefined>): {
  readonly bridgeUrl?: string
  readonly bridgeSecret?: string
  readonly workspaceRoot?: string
  readonly tickMs: number
  readonly watchTickMs: number
} {
  const url = env['FORLIFE_WAKE_BRIDGE_URL']
  const secret = env['FORLIFE_WAKE_BRIDGE_SECRET']
  const root = env['FORLIFE_WORKSPACE_ROOT']
  const tick = Number(env['FORLIFE_WAKE_TICK_MS'] ?? '1000')
  const watchTick = Number(env['FORLIFE_WATCH_TICK_MS'] ?? '1000')
  return {
    ...(url === undefined || url === '' ? {} : { bridgeUrl: url }),
    ...(secret === undefined || secret === '' ? {} : { bridgeSecret: secret }),
    ...(root === undefined || root === '' ? {} : { workspaceRoot: root }),
    tickMs: Number.isFinite(tick) && tick >= 100 ? tick : 1000,
    // 监视 tick 允许更慢（它要读文件）；下限给 500ms
    watchTickMs: Number.isFinite(watchTick) && watchTick >= 500 ? watchTick : 1000,
  }
}

/** 装配唤醒引擎与三个事件源。 */
export function createWakeRuntime(options: WakeRuntimeOptions): WakeRuntime {
  const { db, log } = options
  const config = wakeConfigFromEnv(options.env)
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))
  const handles: unknown[] = []

  // ── 监视源（与引擎独立装配，原因分开报）──
  let watchSource: WatchSource | undefined
  let watchDisabledReason: string | undefined
  if (config.workspaceRoot === undefined) {
    watchDisabledReason = '监视源未启用：缺少环境变量 FORLIFE_WORKSPACE_ROOT（路径没有沙箱根可比）'
  } else {
    watchSource = createWatchSource({
      db,
      workspaceRoot: config.workspaceRoot,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  // ── 引擎：**没配桥就明确禁用**（不假装能唤醒）──
  if (config.bridgeUrl === undefined || config.bridgeSecret === undefined) {
    const missing = [
      ...(config.bridgeUrl === undefined ? ['FORLIFE_WAKE_BRIDGE_URL'] : []),
      ...(config.bridgeSecret === undefined ? ['FORLIFE_WAKE_BRIDGE_SECRET'] : []),
    ]
    return {
      engine: undefined,
      systemSource: undefined,
      watchSource,
      disabledReason: `唤醒引擎未启用：缺少环境变量 ${missing.join('、')}（需要 DSH 侧挂上唤醒桥）`,
      watchDisabledReason,
      stop: () => {},
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
    // scope 为 `*` 的触发器**没有会话可唤醒**。这不是错误配置 ——
    // 有些触发器只是"记账"用的，但要**明确说出来**，而不是发空 sessionId 让桥去 404。
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

  // ── 系统事件源（QQ 掉线等由调用方 observe）──
  const systemSource = createSystemWakeSource({
    db,
    log,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  // ── 监视 tick：**独立定时器** ──
  if (watchSource !== undefined) {
    const watch = watchSource
    const handle = setIntervalFn(() => {
      // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环，
      // 监视从此失效而没人知道
      try {
        for (const o of watch.tick()) {
          if (o.triggered) log(`监视触发「${o.title}」：${o.detail}`)
        }
      } catch (error) {
        log(`监视 tick 异常：${String(error).slice(0, 200)}`)
      }
    }, config.watchTickMs)
    handle.unref?.()
    handles.push(handle)
    log(`监视源已启用：${config.workspaceRoot}，tick ${String(config.watchTickMs)}ms`)
  } else {
    log(watchDisabledReason ?? '监视源未启用')
  }

  log(`唤醒引擎已启用：桥 ${config.bridgeUrl}，tick ${String(config.tickMs)}ms`)

  return {
    engine,
    systemSource,
    watchSource,
    disabledReason: undefined,
    watchDisabledReason,
    stop: () => {
      engine.stop()
      for (const h of handles) clearIntervalFn(h)
    },
  }
}
