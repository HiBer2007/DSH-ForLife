/**
 * ★ QQ「离线」判据 —— 唤醒条件 `bot_offline` 的**输入侧**（什么算离线、超时多少、状态机）。
 *
 * ## 为什么必须有这一层（真实故障，不是理论风险）
 *
 * `research/napcat_issues.json:531` 记录过一次真实事故：
 * **反向 WS 一直是 ESTABLISHED，而 QQ 侧 35 小时收不到任何事件**。
 * 我们的连接层只会看「WS 通不通」（`onebot.ts` 的 `onConnectionState`），
 * 于是那种形态下**一切显示正常** —— 模型以为自己在线，其实发不出去也收不到。
 *
 * 判据必须区分**两种完全不同的"离线"**：
 *
 * | 形态 | 我们能看到什么 | 谁来报 |
 * | :--- | :--- | :--- |
 * | WS 断了 | 连接回调立刻知道（`onConnectionState(false)`） | 已有路径（`qq.disconnected`） |
 * | ★ WS 通、QQ 死了（"假活"） | **只有心跳能看出来** | 本模块（`qq.silent`） |
 *
 * ## 判据为什么是"心跳"，而不是"N 分钟没收到任何事件"
 *
 * 这是本模块最重要的一个取舍，写清楚：
 *
 * 1. **"没有事件"不等于"离线"**。凌晨三点没人说话、周末没人说话，
 *    都是完全正常的 —— 用"N 分钟无事件"判离线，**每一个安静的夜晚都会误报**，
 *    而误报的代价是一次真实模型调用（钱）+ 模型开始怀疑一个并不存在的故障。
 * 2. **心跳是唯一与"有没有人说话"无关的周期性证据**：NapCat 每 30 秒发一次
 *    `meta_event.heartbeat`（实测 `heartInterval: 30000`），带 `status.online` / `status.good`。
 *    它**只取决于连接与 QQ 客户端是否活着**。
 * 3. 所以本模块的判据是：**心跳本身断了 ⇒ 离线**（假活），
 *    **心跳说 `online=false` ⇒ 离线**（确诊）。两条都是"与人类活动无关"的证据。
 * 4. 心跳**还没接进来**时（`onebot.ts` 目前把 `meta_event` 直接丢掉，P1-3 在修），
 *    本模块**如实返回 `unknown`**，而不是拿"安静"当"离线"——
 *    理由与 `wake-system-monitor.ts` 的 `checkDisk` 同一条纪律：
 *    **取不到不等于健康，也不等于坏了，要说清"判不了"**。
 *
 * ## 阈值为什么是 3 个心跳周期、且不低于 90 秒
 *
 * - 丢**一个**心跳是常态（GC、网络抖动、事件循环卡顿），拿它判离线会天天误报；
 * - 连丢**三个**才叫"心跳断了"，而 30s × 3 = 90s 刚好是"一个心跳周期"的下限保护：
 *   若 NapCat 侧把 `heartInterval` 配得比 30s 小（实测值可被配置改），
 *   3 倍仍然成立，所以取 `max(3 × interval, 90_000)`；
 * - 用**收到的心跳自带的 `interval`** 而不是写死 30s —— 换配置不用改代码。
 *
 * ## 为什么"WS 断了"这条证据也要进来（虽然不由本模块上报）
 *
 * 不进来的话，一次**真的** WS 断线会同时触发两条路径（连接回调 + 心跳超时），
 * 于是模型被同一件事叫醒两次。所以本模块记住 WS 状态，
 * 并把 `ws-down` 单独标成一个**不归本模块上报**的结论（`isSilentOffline()` 会返回 false）。
 *
 * @module @forlife/gateway/wake-liveness
 */
import type { DatabaseSync } from 'node:sqlite'

import { decideWake } from './wake.ts'

/** 存活判定结论。 */
export type LivenessState = 'alive' | 'offline' | 'unknown'

/**
 * 判定的**依据**（必须具体 —— "判不了"和"离线了"是不同的事，处理方式也不同）。
 */
export type LivenessEvidence =
  /** 心跳自带 `status.online = false`：NapCat 自己说 QQ 掉线了（**确诊**）。 */
  | 'heartbeat-online'
  /** 心跳本身断了：连接假活（**本模块存在的主要理由**）。 */
  | 'heartbeat-stale'
  /** NapCat 主动上报 `notice_type: bot_offline`（第二道保险）。 */
  | 'bot-offline-notice'
  /** 反向 WS 断了 —— 这条由**已有的连接路径**上报，本模块只用它避免重复唤醒。 */
  | 'ws-down'
  /** ★ 从没见过心跳 ⇒ **判不了**（说清原因，而不是猜一个结论）。 */
  | 'no-heartbeat'

/** 一次判定。 */
export interface LivenessVerdict {
  readonly state: LivenessState
  readonly evidence: LivenessEvidence
  /** 人话说明（进日志与 system 触发 payload 的 detail）。 */
  readonly reason: string
  /** 判定时刻（ISO）。 */
  readonly at: string
  /** 距最后一次心跳的毫秒数（从没见过心跳时缺席）。 */
  readonly sinceHeartbeatMs?: number
  /** 本次判定用的超时阈值（毫秒）；只有心跳路径才有意义。 */
  readonly staleAfterMs?: number
}

/** 心跳观察输入。 */
export interface HeartbeatObservation {
  /** `status.online` —— **唯一能确诊"QQ 掉线"的字段**。 */
  readonly online: boolean
  /** `status.good`（NapCat 给的补充信号，只进 reason，不参与判定）。 */
  readonly good?: boolean
  /** 心跳自带的间隔（`heartInterval`）；换配置不用改代码。 */
  readonly intervalMs?: number
  readonly at?: Date
}

/** 存活监视器。 */
export interface LivenessMonitor {
  /** 观察一次心跳（`meta_event.heartbeat`）。 */
  readonly observeHeartbeat: (input: HeartbeatObservation) => LivenessVerdict
  /** 观察"反向 WS 的连通状态"（由连接回调喂进来）。 */
  readonly observeTransport: (connected: boolean, detail?: string) => void
  /** 观察 NapCat 的 `notice_type: bot_offline`。 */
  readonly observeBotOffline: (reason: string, at?: Date) => LivenessVerdict
  /** 按当前证据算一次结论（定时调；**不改变状态**）。 */
  readonly check: (at?: Date) => LivenessVerdict
}

/** 判据参数。 */
export interface LivenessOptions {
  readonly now?: () => Date
  /** 心跳超时 = `factor × interval`（默认 3）。 */
  readonly heartbeatMissFactor?: number
  /** 心跳超时的下限（默认 90s，见模块头）。 */
  readonly minStaleMs?: number
  readonly log?: (message: string) => void
}

/** 缺心跳时说清"缺的是什么"（这是最容易被误读成"在线"的结论）。 */
export const NO_HEARTBEAT_REASON =
  '判不了：一次心跳都没收到 —— 说明 QQ 事件源里没有 heartbeat（onebot.ts 目前丢弃 meta_event）' +
  '，而"没有消息"在安静时段是正常的、不能当离线证据'

/**
 * ★ 这条结论该不该由**本模块**上报成 `qq.silent`。
 *
 * `ws-down` 排除在外的理由：那条路径已经有上报者（连接回调 → `qq.disconnected`），
 * 重复上报会让同一件事把模型叫醒两次。
 */
export function isSilentOffline(verdict: LivenessVerdict): boolean {
  return verdict.state === 'offline' && verdict.evidence !== 'ws-down'
}

/** 造一个存活监视器（**纯状态机**：注入时钟、不碰 IO）。 */
export function createLivenessMonitor(options: LivenessOptions = {}): LivenessMonitor {
  const now = options.now ?? ((): Date => new Date())
  const factor = options.heartbeatMissFactor ?? 3
  const minStaleMs = options.minStaleMs ?? 90_000
  const log = options.log ?? ((): void => {})

  let lastHeartbeatAt: number | undefined
  let lastHeartbeatOnline: boolean | undefined
  let heartbeatIntervalMs: number | undefined
  let botOfflineReason: string | undefined
  let transportConnected: boolean | undefined

  const staleAfterMs = (): number =>
    lastHeartbeatAt === undefined
      ? minStaleMs
      : Math.max(Math.round(factor * (heartbeatIntervalMs ?? 30_000)), minStaleMs)

  const check = (at: Date = now()): LivenessVerdict => {
    const base = { at: at.toISOString() }

    // ① NapCat 自己说掉线了 ⇒ 直接采信（第二道保险）
    if (botOfflineReason !== undefined) {
      return {
        ...base,
        state: 'offline',
        evidence: 'bot-offline-notice',
        reason: `NapCat 上报 bot_offline：${botOfflineReason}`,
      }
    }

    // ② 从没见过心跳 ⇒ **如实说判不了**（见 NO_HEARTBEAT_REASON）
    if (lastHeartbeatAt === undefined) {
      // WS 断开这条是例外：那是**确定**的离线，只是不由本模块上报
      if (transportConnected === false) {
        return { ...base, state: 'offline', evidence: 'ws-down', reason: '反向 WS 未连接（由连接路径上报）' }
      }
      return { ...base, state: 'unknown', evidence: 'no-heartbeat', reason: NO_HEARTBEAT_REASON }
    }

    const sinceHeartbeatMs = Math.max(0, at.getTime() - lastHeartbeatAt)
    const staleAfter = staleAfterMs()

    // ③ ★ 心跳断了 = 连接假活（本模块存在的主要理由）
    if (sinceHeartbeatMs > staleAfter) {
      return {
        ...base,
        state: 'offline',
        evidence: 'heartbeat-stale',
        reason:
          `心跳已停 ${String(Math.round(sinceHeartbeatMs / 1000))} 秒（阈值 ${String(Math.round(staleAfter / 1000))} 秒` +
          `＝${String(factor)} × ${String(Math.round((heartbeatIntervalMs ?? 30_000) / 1000))} 秒）` +
          '：反向 WS 可能还连着，但 QQ 侧已经不发事件了',
        sinceHeartbeatMs,
        staleAfterMs: staleAfter,
      }
    }

    // ④ 心跳自带 online=false ⇒ 确诊离线
    if (lastHeartbeatOnline === false) {
      return {
        ...base,
        state: 'offline',
        evidence: 'heartbeat-online',
        reason: '心跳的 status.online = false：QQ 客户端已不在线',
        sinceHeartbeatMs,
        staleAfterMs: staleAfter,
      }
    }

    // ⑤ WS 断了（由连接路径上报，本模块只记录）
    if (transportConnected === false) {
      return {
        ...base,
        state: 'offline',
        evidence: 'ws-down',
        reason: '反向 WS 未连接（由连接路径上报）',
        sinceHeartbeatMs,
        staleAfterMs: staleAfter,
      }
    }

    return {
      ...base,
      state: 'alive',
      evidence: 'heartbeat-online',
      reason: `心跳正常（距上次 ${String(Math.round(sinceHeartbeatMs / 1000))} 秒，阈值 ${String(Math.round(staleAfter / 1000))} 秒）`,
      sinceHeartbeatMs,
      staleAfterMs: staleAfter,
    }
  }

  const observeHeartbeat = (input: HeartbeatObservation): LivenessVerdict => {
    const at = input.at ?? now()
    lastHeartbeatAt = at.getTime()
    lastHeartbeatOnline = input.online
    if (input.intervalMs !== undefined && Number.isFinite(input.intervalMs) && input.intervalMs >= 1000) {
      heartbeatIntervalMs = input.intervalMs
    }
    // 心跳能到达 ⇒ 反向 WS 一定是通的（它是从那条连接上来的）
    transportConnected = true
    // 收到任何一次"活着"的心跳都清掉 bot_offline 的旧结论：
    // 那条通知是**历史事件**，不能被当成永久状态
    if (input.online) botOfflineReason = undefined
    const verdict = check(at)
    log(
      `心跳：online=${String(input.online)}${input.good === undefined ? '' : ` good=${String(input.good)}`}` +
        ` ⇒ ${verdict.state}（${verdict.evidence}）`,
    )
    return verdict
  }

  const observeTransport = (connected: boolean, detail?: string): void => {
    transportConnected = connected
    if (connected) botOfflineReason = undefined
    log(`反向 WS ${connected ? '已连接' : '已断开'}${detail === undefined ? '' : `（${detail}）`}`)
  }

  const observeBotOffline = (reason: string, at: Date = now()): LivenessVerdict => {
    botOfflineReason = reason
    log(`收到 bot_offline 通知：${reason}`)
    return check(at)
  }

  return { observeHeartbeat, observeTransport, observeBotOffline, check }
}

// ── 诊断：最后一次"听到 QQ 说话"是什么时候 ──────────────────────────────────

/**
 * 最后一次收到 QQ 事件的时刻（ISO）。
 *
 * 两个来源都看，因为它们覆盖的事件类型不重叠：
 *  - `qq_inbox.received_at` —— 消息（进轮次的那一类）；
 *  - `effects.created_at` 里 `kind = qq_event:*` —— **非消息事件**（撤回/入群/好友申请…），
 *    由 `gateway.ts recordNonMessageEvent` 落库（已经是生产路径）。
 *
 * ⚠️ 这个值**只用于解释**（"已经 N 分钟没听到 QQ 说话了"），**不参与判离线** ——
 * 理由见模块头第 1 条：安静时段没有事件是正常的。
 */
export function lastQqActivityAt(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT
           (SELECT MAX(received_at) FROM qq_inbox) AS inbox_at,
           (SELECT MAX(created_at) FROM effects WHERE kind GLOB 'qq_event:*') AS event_at`,
      )
      .get() as { inbox_at: string | null; event_at: string | null } | undefined
    const candidates = [row?.inbox_at ?? undefined, row?.event_at ?? undefined].filter(
      (value): value is string => value !== undefined && value !== null && value !== '',
    )
    if (candidates.length === 0) return undefined
    return candidates.sort().at(-1)
  } catch (error) {
    // 诊断信息取不到不该影响判定
    return undefined
  }
}

// ── 定时循环：把判据接到唤醒矩阵与事件源上 ──────────────────────────────────

/** 一次判定的闸门结果。 */
export interface LivenessGate {
  readonly wake: boolean
  readonly reason: string
}

/** 循环配置。 */
export interface LivenessWatchOptions {
  readonly db: DatabaseSync
  readonly monitor: LivenessMonitor
  /**
   * 过**唤醒矩阵**（`wake_rules` 的 `bot_offline` 一行）。
   *
   * 默认实现就是真正的 `decideWake` —— 于是面板上那条规则的开关/概率/日限
   * **真的**决定要不要为离线开口（这正是"配置项存在、生产者为零"要修的东西）。
   */
  readonly decide?: (verdict: LivenessVerdict) => LivenessGate
  /** 放行后的上报出口（生产里是 `systemSource.observe('qq.silent', …)`）。 */
  readonly report?: (state: 'silent' | 'alive', detail: string) => void
  readonly log?: (message: string) => void
  readonly now?: () => Date
  /** 判定间隔（默认 15 秒；下限 5 秒 —— 判据以分钟计，没必要更密）。 */
  readonly intervalMs?: number
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
}

/** 循环句柄。 */
export interface LivenessWatch {
  /** 跑一次（测试直接调它，不用等定时器）。 */
  readonly tick: (at?: Date) => LivenessVerdict
  /** 当前报告的边沿状态（排障用）。 */
  readonly reported: () => 'silent' | 'alive' | 'unknown' | undefined
  readonly stop: () => void
}

/**
 * 启动存活监视循环。
 *
 * ## 为什么必须自己做**边沿检测**
 *
 * 判据每次 tick 都会给出同一个结论（离线期间一直离线），
 * 而 `decideWake` **每调一次就写一行 `wake_events`** ——
 * 15 秒一次就是 5760 行/天，而且那行行都在消耗概率与全局预算
 * （`budgetExceeded` 数的是 `wake_events` 里 `decision='wake'` 的行）。
 * 所以只在**结论发生变化**时才过闸与上报，与 `wake-events.ts` 的边沿检测同一条纪律。
 */
export function startLivenessWatch(options: LivenessWatchOptions): LivenessWatch {
  const { db, monitor } = options
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): Date => new Date())
  const intervalMs = Math.max(5_000, options.intervalMs ?? 15_000)
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))

  let reported: 'silent' | 'alive' | 'unknown' | undefined

  const decide =
    options.decide ??
    ((verdict: LivenessVerdict): LivenessGate => {
      const result = decideWakeForOffline(db, verdict)
      return result
    })

  const tick = (at: Date = now()): LivenessVerdict => {
    const verdict = monitor.check(at)
    const state: 'silent' | 'alive' | 'unknown' = isSilentOffline(verdict) ? 'silent' : verdict.state === 'alive' ? 'alive' : 'unknown'
    if (state === reported) return verdict // 没变化 ⇒ 不过闸、不上报（防唤醒风暴 + 防 wake_events 刷屏）

    if (state === 'alive') {
      reported = 'alive'
      options.report?.('alive', verdict.reason)
      log(`QQ 存活状态恢复：${verdict.reason}`)
      return verdict
    }
    if (state === 'unknown') {
      reported = 'unknown'
      // **判不了就说判不了**（这条日志本身就是"为什么我们检测不到假活"的答案）
      log(`QQ 存活状态：${verdict.reason}`)
      return verdict
    }

    // ★ 离线：先过**唤醒矩阵**（面板上那条 `bot_offline` 规则真的生效）
    const gate = decide(verdict)
    if (!gate.wake) {
      reported = 'silent'
      log(`检测到 QQ 静默离线，但唤醒矩阵不放行（${gate.reason}）：${verdict.reason}`)
      return verdict
    }
    reported = 'silent'
    const silence = describeSilence(db, at)
    options.report?.('silent', `${verdict.reason}${silence}`)
    log(`★ QQ 静默离线（${verdict.evidence}）：${verdict.reason}${silence}`)
    return verdict
  }

  const handle = setIntervalFn(() => {
    // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环（监视从此失效而没人知道）
    try {
      tick()
    } catch (error) {
      log(`QQ 存活监视 tick 异常：${String(error).slice(0, 200)}`)
    }
  }, intervalMs)
  handle.unref?.()

  return { tick, reported: () => reported, stop: () => clearIntervalFn(handle) }
}

/** "已经多久没听到 QQ 说话了"（只用于解释，不参与判定）。 */
function describeSilence(db: DatabaseSync, at: Date): string {
  const last = lastQqActivityAt(db)
  if (last === undefined) return '；另外：库里没有任何 QQ 事件记录'
  const ms = at.getTime() - Date.parse(last)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.round(ms / 60_000)
  const human = minutes < 60 ? `${String(minutes)} 分钟` : `${String(Math.round(minutes / 60))} 小时`
  return `；另外：已经 ${human}没有任何 QQ 事件（最后一条 ${last}）`
}

/** 默认的矩阵闸门：真正的 `decideWake(bot_offline)`。 */
function decideWakeForOffline(db: DatabaseSync, verdict: LivenessVerdict): LivenessGate {
  const result = decideWake(db, {
    // 作用域用 `*`：离线是**全局**现象，不该被某一个群的规则挡住
    // （与 `backlog.ts` 的 `pending_backlog` 同一条口径）。
    scope: '*',
    condition: 'bot_offline',
    conversationKey: '*',
    // ⚠️ 刻意**不给 `summary`**：`decideWake` 在跳过时会把 summary 记进待读池 ——
    // 那等于"为离线这条状态凭空造一条未读消息"，还会把 `pending_backlog` 唤醒带上
    // （池子自己长大）。与 `backlog.ts` 的同一条纪律。
  })
  void verdict
  return { wake: result.decision === 'wake', reason: result.reason }
}
