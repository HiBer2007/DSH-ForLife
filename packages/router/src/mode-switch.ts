/**
 * 运行模式切换（§2.13.2）—— resident ↔ on-demand ↔ remote-api ↔ host-native。
 *
 * ## 切换的四条工程要求（文档明写）
 *
 * ① **幂等**并落审计：重复切到同一个模式不该有任何副作用，但每次尝试都要留痕；
 * ② **切换前优雅排水**：等在途请求结束（或有界超时），避免打断进行中的轮次；
 * ③ **失败自动回滚**到上一个可用模式；
 * ④ 切换过程中**路由层必须容忍端点短暂不可用**（回退链 + 熔断）。
 *
 * ## 这个模块为什么是纯逻辑
 *
 * 真正的切换动作（`docker stop` / 改配置 / 等排水）都是副作用，注入进来。
 * 这样"排水没排完就切换""回滚也失败"这些**最难在真机上复现**的路径可以精确测试 ——
 * 它们在真机上表现为"偶尔有一个轮次被打断"，几乎无法定位。
 *
 * @module @forlife/router/mode-switch
 */
import type { RunMode } from './endpoints.ts'

/** 切换请求。 */
export interface SwitchModeRequest {
  readonly endpointId: string
  readonly from: RunMode
  readonly to: RunMode
  /** 是谁发起的（`auto` / `admin` / `api`）—— 审计要能区分。 */
  readonly actor: 'auto' | 'admin' | 'api' | 'system'
  readonly reason: string
}

/** 切换副作用（注入）。 */
export interface ModeSwitchEffects {
  /** 当前在途请求数（排水的依据）。 */
  readonly inFlight: () => number
  /** 停止接受新请求（排水第一步：先关上入口，再等在途结束）。 */
  readonly stopAccepting: (endpointId: string) => Promise<void>
  /** 恢复接受请求（回滚时用）。 */
  readonly resumeAccepting: (endpointId: string) => Promise<void>
  /** 真正执行切换（停容器/起容器/改路由等）。 */
  readonly apply: (request: SwitchModeRequest) => Promise<void>
  /** 写审计。 */
  readonly audit: (entry: {
    readonly endpointId: string
    readonly from: RunMode
    readonly to: RunMode
    readonly actor: string
    readonly reason: string
    readonly ok: boolean
    readonly note: string
    readonly at: string
  }) => void
  /** 等待（注入以便测试不真的 sleep）。 */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => Date
}

/** 切换选项。 */
export interface SwitchModeOptions {
  /** 排水的有界超时（**有界**是关键：无限等会让切换永远挂住）。 */
  readonly drainTimeoutMs?: number
  readonly drainPollMs?: number
  /** 排水超时后是否仍然强切（默认 false —— 宁可放弃切换也不打断轮次）。 */
  readonly forceOnDrainTimeout?: boolean
}

/** 切换结果。 */
export interface SwitchModeResult {
  readonly ok: boolean
  /** 切换后实际生效的模式（失败时=回滚后的模式）。 */
  readonly effectiveMode: RunMode
  readonly drained: boolean
  readonly drainWaitedMs: number
  readonly rolledBack: boolean
  readonly note: string
}

/** 默认选项。 */
export function defaultSwitchOptions(): Required<Pick<SwitchModeOptions, 'drainTimeoutMs' | 'drainPollMs' | 'forceOnDrainTimeout'>> {
  return { drainTimeoutMs: 30_000, drainPollMs: 200, forceOnDrainTimeout: false }
}

/**
 * 执行一次模式切换（幂等 + 排水 + 失败回滚 + 审计）。
 *
 * @param request - 切换请求。
 * @param effects - 副作用。
 * @param options - 排水参数。
 * @returns 结果。
 */
export async function switchMode(
  request: SwitchModeRequest,
  effects: ModeSwitchEffects,
  options: SwitchModeOptions = {},
): Promise<SwitchModeResult> {
  const defaults = defaultSwitchOptions()
  const drainTimeoutMs = options.drainTimeoutMs ?? defaults.drainTimeoutMs
  const drainPollMs = options.drainPollMs ?? defaults.drainPollMs
  const forceOnDrainTimeout = options.forceOnDrainTimeout ?? defaults.forceOnDrainTimeout
  const sleep = effects.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = effects.now ?? ((): Date => new Date())

  // ① 幂等：已经是目标模式 ⇒ 什么都不做（但仍写审计，让"谁试过切"有迹可查）
  if (request.from === request.to) {
    effects.audit({
      endpointId: request.endpointId,
      from: request.from,
      to: request.to,
      actor: request.actor,
      reason: request.reason,
      ok: true,
      note: '已经是目标模式，幂等跳过（未执行任何动作）',
      at: now().toISOString(),
    })
    return { ok: true, effectiveMode: request.to, drained: true, drainWaitedMs: 0, rolledBack: false, note: '已经是目标模式，未做改动' }
  }

  // ② 排水：先关上入口，再等在途请求结束（**有界**等待）
  let drained = true
  let waitedMs = 0
  await effects.stopAccepting(request.endpointId)
  while (effects.inFlight() > 0) {
    if (waitedMs >= drainTimeoutMs) {
      drained = false
      break
    }
    await sleep(drainPollMs)
    waitedMs += drainPollMs
  }

  if (!drained && !forceOnDrainTimeout) {
    // 排水超时且不允许强切 ⇒ **放弃切换并恢复入口**。
    // 宁可"这次没切成"，也不要打断一个正在进行的轮次 ——
    // 用户看到的是"机器人答到一半没了"，那比"这次没换成"严重得多。
    await effects.resumeAccepting(request.endpointId)
    effects.audit({
      endpointId: request.endpointId,
      from: request.from,
      to: request.to,
      actor: request.actor,
      reason: request.reason,
      ok: false,
      note: `排水超时（${String(waitedMs)}ms 后仍有 ${String(effects.inFlight())} 个在途请求）⇒ 放弃切换并恢复入口`,
      at: now().toISOString(),
    })
    return {
      ok: false,
      effectiveMode: request.from,
      drained: false,
      drainWaitedMs: waitedMs,
      rolledBack: false,
      note: `排水超时，已放弃切换到 ${request.to}（在途请求未被中断）`,
    }
  }

  // ③ 执行切换；失败则回滚到上一个模式
  try {
    await effects.apply(request)
    effects.audit({
      endpointId: request.endpointId,
      from: request.from,
      to: request.to,
      actor: request.actor,
      reason: request.reason,
      ok: true,
      note: `切换成功（排水等待 ${String(waitedMs)}ms${drained ? '' : '，超时后强切'}）`,
      at: now().toISOString(),
    })
    return {
      ok: true,
      effectiveMode: request.to,
      drained,
      drainWaitedMs: waitedMs,
      rolledBack: false,
      note: `已切到 ${request.to}${drained ? '' : '（排水超时，强切）'}`,
    }
  } catch (error) {
    // 回滚：把模式改回去，并恢复入口
    let rolledBack = false
    let rollbackNote = ''
    try {
      await effects.apply({ ...request, from: request.to, to: request.from, reason: `回滚：原切换失败（${String(error)}）` })
      await effects.resumeAccepting(request.endpointId)
      rolledBack = true
      rollbackNote = '已回滚到上一个模式'
    } catch (rollbackError) {
      rollbackNote = `**回滚也失败了**（${String(rollbackError)}）—— 端点当前状态未知，需要人工介入`
      // 回滚都失败时也要尽量恢复入口，否则这个端点会一直"不接受新请求"
      try {
        await effects.resumeAccepting(request.endpointId)
      } catch {
        rollbackNote += '；连恢复入口都失败'
      }
    }
    effects.audit({
      endpointId: request.endpointId,
      from: request.from,
      to: request.to,
      actor: request.actor,
      reason: request.reason,
      ok: false,
      note: `切换失败：${String(error)}；${rollbackNote}`,
      at: now().toISOString(),
    })
    return {
      ok: false,
      effectiveMode: rolledBack ? request.from : request.to,
      drained,
      drainWaitedMs: waitedMs,
      rolledBack,
      note: `切换到 ${request.to} 失败：${String(error)}；${rollbackNote}`,
    }
  }
}

// ── 自动切换策略 ───────────────────────────────────────────────────────────

/** 自动切换的输入信号。 */
export interface AutoSwitchSignals {
  /** 当前小时（0–23，本地时区）。 */
  readonly hour: number
  /** 内存压力：可用内存 / 总内存。 */
  readonly memoryFreeRatio: number
  /** 最近一小时请求数。 */
  readonly requestsLastHour: number
  /** 当前模式。 */
  readonly current: RunMode
  /** 端点的来源类型（本地容器才能 resident/on-demand）。 */
  readonly endpointType: 'local' | 'remote-selfhost' | 'cloud-api' | 'host-native'
}

/** 自动切换建议。 */
export interface AutoSwitchAdvice {
  readonly to: RunMode
  readonly reason: string
  /** 是否建议切换（false = 保持现状）。 */
  readonly shouldSwitch: boolean
}

/**
 * 自动切换策略（§2.13.2「按请求量/内存压力/时段自动决定」）。
 *
 * @param signals - 信号。
 * @param config - 阈值。
 * @returns 建议。
 */
export function adviseAutoSwitch(
  signals: AutoSwitchSignals,
  config: { readonly busyRequestsPerHour?: number; readonly memoryPressureRatio?: number; readonly nightHours?: readonly number[] } = {},
): AutoSwitchAdvice {
  const busy = config.busyRequestsPerHour ?? 20
  const pressure = config.memoryPressureRatio ?? 0.15
  const nightHours = config.nightHours ?? [0, 1, 2, 3, 4, 5, 6]

  // 非本地来源不参与本地容器模式切换（它们本来就不在本地跑）
  if (signals.endpointType === 'cloud-api') {
    return { to: 'remote-api', shouldSwitch: signals.current !== 'remote-api', reason: '云模型端点只能是 remote-api 模式' }
  }
  if (signals.endpointType === 'host-native') {
    return { to: 'host-native', shouldSwitch: signals.current !== 'host-native', reason: '宿主自带模型只能是 host-native 模式（只读引用）' }
  }

  // 内存告急 ⇒ 优先卸载（这条压过其它所有考虑：OOM 会让整个机器人挂掉）
  if (signals.memoryFreeRatio < pressure) {
    return {
      to: 'on-demand',
      shouldSwitch: signals.current === 'resident',
      reason: `可用内存只剩 ${(signals.memoryFreeRatio * 100).toFixed(0)}%（低于 ${(pressure * 100).toFixed(0)}%）⇒ 卸载常驻模型，只在需要时加载`,
    }
  }

  // 深夜 + 不忙 ⇒ 按需
  if (nightHours.includes(signals.hour) && signals.requestsLastHour < busy / 4) {
    return {
      to: 'on-demand',
      shouldSwitch: signals.current === 'resident',
      reason: `深夜（${String(signals.hour)} 点）且最近一小时只有 ${String(signals.requestsLastHour)} 次请求 ⇒ 没必要常驻`,
    }
  }

  // 白天 + 忙 ⇒ 常驻（避免每个请求都吃冷启动）
  if (signals.requestsLastHour >= busy) {
    return {
      to: 'resident',
      shouldSwitch: signals.current === 'on-demand',
      reason: `最近一小时 ${String(signals.requestsLastHour)} 次请求（≥${String(busy)}）⇒ 常驻避免冷启动`,
    }
  }

  return { to: signals.current, shouldSwitch: false, reason: '当前负载与时段没有明显倾向，保持现状' }
}
