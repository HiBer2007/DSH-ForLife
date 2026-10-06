/**
 * DSH 后端连接状态（面板总览要显示的那个）。
 *
 * ## 为什么需要它
 *
 * gateway 与 DSH 是**两个进程**，共享一个数据库。于是有一种很难查的故障：
 * **DSH 挂了，而面板看起来一切正常** —— QQ 在收消息、库在写、图表在动，
 * 但模型那一侧根本没在跑（没有会话在处理）。用户会以为"模型不回我"，
 * 而真正的原因是后端没起来。
 *
 * 面板必须能一眼看出这件事。
 *
 * ## 为什么要**短超时 + 缓存**
 *
 * 总览是打开面板时第一个请求。如果每次都在里面同步探一次 DSH，
 * 那么 DSH 挂掉时**面板会跟着卡住**（探到超时为止）——
 * 而这恰恰是最需要看面板的时候。
 *
 * 所以：探测超时压到 800ms，结果缓存 5 秒。缓存让"面板连续刷新"不会
 * 反复打 DSH；短超时让"DSH 挂了"时面板最多多等 800ms。
 *
 * ## 为什么 `undefined` 与 `false` 要分开
 *
 * `reachable: undefined` = **没配 URL，无法判断**；
 * `reachable: false` = **配了但连不上**。
 * 合成一个 `false` 的话，用户会去查一个根本没配的东西。
 *
 * @module @forlife/gateway/dsh-status
 */

/** 一次探测结果。 */
export interface DshProbe {
  /** `undefined` = 未配置，无法判断。 */
  readonly reachable: boolean | undefined
  readonly status?: number
  readonly latencyMs?: number
  readonly error?: string
  readonly at: string
}

/** 状态查询结果。 */
export interface DshStatus extends DshProbe {
  /** 配置的 DSH web 地址（未配则 undefined）。 */
  readonly url: string | undefined
  /** 唤醒桥是否已配置（gateway 侧发唤醒的前提）。 */
  readonly wakeBridgeConfigured: boolean
  /** 唤醒桥地址（**未配时整个字段不出现** —— exactOptionalPropertyTypes 下不能赋 undefined）。 */
  readonly wakeBridgeUrl?: string
  /** 本进程是否真的接管了 DSH 侧的服务（gateway 自身永远是 false）。 */
  readonly note: string
}

/** 探测选项。 */
export interface DshStatusOptions {
  readonly env: Record<string, string | undefined>
  readonly fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>
  readonly timeoutMs?: number
  /** 缓存时长（毫秒）；0 = 不缓存（测试用）。 */
  readonly cacheMs?: number
  readonly now?: () => Date
}

/** 从环境变量读 DSH 地址。 */
export function dshUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  const explicit = env['FORLIFE_DSH_URL']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  // 唤醒桥的地址里就含 DSH 的 host:port —— 从它推导，省一个配置项
  const bridge = env['FORLIFE_WAKE_BRIDGE_URL']
  if (bridge !== undefined && bridge.trim() !== '') {
    try {
      const u = new URL(bridge)
      return `${u.protocol}//${u.host}`
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 造一个带缓存的状态查询器。 */
export function createDshStatusProbe(options: DshStatusOptions): () => Promise<DshStatus> {
  const timeoutMs = options.timeoutMs ?? 800
  const cacheMs = options.cacheMs ?? 5000
  const now = options.now ?? ((): Date => new Date())
  const fetchImpl =
    options.fetchImpl ??
    ((url: string, init: { signal: AbortSignal }) => fetch(url, { method: 'GET', ...init }))

  let cached: { at: number; value: DshStatus } | undefined

  return async (): Promise<DshStatus> => {
    const current = now().getTime()
    if (cacheMs > 0 && cached !== undefined && current - cached.at < cacheMs) return cached.value

    const url = dshUrlFromEnv(options.env)
    const wakeBridgeUrl = options.env['FORLIFE_WAKE_BRIDGE_URL']
    const wakeBridgeConfigured = wakeBridgeUrl !== undefined && wakeBridgeUrl.trim() !== ''
    const at = now().toISOString()

    let value: DshStatus
    if (url === undefined) {
      // **未配置 ≠ 连不上** —— 说清是"没配"，否则用户会去查一个不存在的东西
      value = {
        reachable: undefined,
        at,
        url: undefined,
        wakeBridgeConfigured,
        ...(wakeBridgeConfigured ? { wakeBridgeUrl } : {}),
        note: '未配置 FORLIFE_DSH_URL（也没有唤醒桥地址可推导），无法判断 DSH 是否在跑',
      }
    } else {
      const started = Date.now()
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        value = {
          reachable: true,
          status: response.status,
          latencyMs: Date.now() - started,
          at,
          url,
          wakeBridgeConfigured,
          ...(wakeBridgeConfigured ? { wakeBridgeUrl } : {}),
          note: 'DSH web 后端可达',
        }
      } catch (error) {
        value = {
          reachable: false,
          latencyMs: Date.now() - started,
          // 错误信息截断：完整堆栈在面板上显示不下，也会泄露本机路径
          error: String(error).slice(0, 160),
          at,
          url,
          wakeBridgeConfigured,
          ...(wakeBridgeConfigured ? { wakeBridgeUrl } : {}),
          note: 'DSH web 后端连不上 —— 模型那一侧可能没在跑（面板与 QQ 仍然正常，这是最难查的一种故障）',
        }
      }
    }

    if (cacheMs > 0) cached = { at: current, value }
    return value
  }
}
