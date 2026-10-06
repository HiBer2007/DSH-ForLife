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

import { createWakeBridge, isHeaderSafe } from './wake-bridge.ts'
import { enqueueWakeRequest } from '@forlife/store'
import { createSystemEventHooks } from './wake-system-hooks.ts'
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
  /**
   * 跑一轮的入口（**gateway 自己的 driver**）。
   *
   * **为什么需要它**：真机发现 QQ 的每一轮是 gateway 起 `dsh headless`
   * 子进程跑的（driver.ts:64），**不是** web app 的会话。
   * 而唤醒轮询器在 web app 里 —— 两者没有交集，
   * `resolveAgent("onebot11:*")` 永远失败。
   *
   * 唤醒的目标是 QQ 会话，那就该走**和普通 QQ 轮次完全相同**的路径。
   * 没有它时退回队列（那条路是给"唤醒 web app 会话"用的）。
   */
  readonly runTurn?: (input: {
    readonly conversationKey: string
    readonly prompt: string
    readonly sourceKind: string
    readonly summary: string
  }) => Promise<{
    readonly ok: boolean
    readonly reason: string
    readonly modelDid?: string
    readonly costTokens?: number
  }>
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
  const runTurn = options.runTurn
  const config = wakeConfigFromEnv(options.env)

  // **密钥必须是 latin-1**（它要当 HTTP 头发出去）。
  // 不拦的话，每一次唤醒都会以一句 `Cannot convert argument to a ByteString` 失败 ——
  // 而那句话完全看不出真正原因。
  const secretCheck = config.bridgeSecret === undefined ? { ok: true as const } : isHeaderSafe(config.bridgeSecret)

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
  if (!secretCheck.ok) {
    return {
      engine: undefined,
      systemSource: undefined,
      watchSource,
      disabledReason: `唤醒引擎未启用：FORLIFE_WAKE_BRIDGE_SECRET ${secretCheck.reason}` ,
      watchDisabledReason,
      stop: () => {},
    }
  }

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

  // 保留：桥的密钥校验/忙判定/flush 守卫逻辑在**轮询侧原样复用**。
  // 将来 DSH 若提供免鉴权路由机制，可以切回这条路径。
  void createWakeBridge
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

    // **写队列，不调 HTTP 桥**（方向性调整）。
    // 原因：DSH 注册的路由是在**它自己鉴权之后**才被调用的（没法绕过），
    // 而它的 token 重启即失效 —— gateway 拿不到稳定凭据（真机 401）。
    // 改成写一行，由**插件侧**（DSH 进程内）轮询认领并直接调 agent.followup()。
    // **包住入队异常并给一句人话** ——
    // 原始 SQLite 错误（如 "no such table"）看不出是"入队失败"，
    // 而"入队失败"和"派发失败"要采取的措施完全不同。
    let requestId: string
    // **优先走 gateway 自己的 driver**（和普通 QQ 轮次同一条路）。
    if (runTurn !== undefined) {
      return await runTurn({
        conversationKey: trigger.scope,
        prompt,
        sourceKind: `wake-${trigger.kind}`,
        summary: trigger.title,
      })
    }

    try {
    const requestId = enqueueWakeRequest(db, {
    triggerId: trigger.id,
    sessionId: trigger.scope,
    text: prompt,
    sourceKind: `wake-${trigger.kind}`,
    summary: trigger.title,
    })
    // **decision 的语义变了**：以前 fired = "桥确认收到了"；
    // 现在是"**已入队，等插件执行**"。这个区别必须写进 reason ——
    // 否则看 wake_events 的人会以为"模型已经动了"，而实际可能还在队列里。
    return { ok: true, reason: `已入队（${requestId}），等插件侧认领执行` }
    } catch (error) {
      return { ok: false, reason: `入队失败：${String(error).slice(0, 160)}` }
    }


  }

  // 系统事件钩子（预算超限等要能变成 system 触发）
  const systemSource = createSystemWakeSource({
    db,
    log,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const systemHooks = createSystemEventHooks({ source: systemSource, log })

  const engine = createWakeEngine({
    // **预算超限 ⇒ system 触发** —— 六道闸里早就判了，但以前没人往外说，
    // 于是"预算超了"只能靠人去面板上看。
    onGateBlocked: (trigger, decision, reason) => {
      if (decision === 'budget') systemHooks.budgetExceeded(trigger.scope, reason)
    },
    db,
    dispatch,
    log,
    tickMs: config.tickMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.setIntervalImpl === undefined ? {} : { setIntervalImpl: options.setIntervalImpl }),
    ...(options.clearIntervalImpl === undefined ? {} : { clearIntervalImpl: options.clearIntervalImpl }),
  })

  // ── 系统事件源（QQ 掉线等由调用方 observe）──

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
