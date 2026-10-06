/**
 * 端口出口的运行时装配：从环境变量造服务 + 起回收定时任务。
 *
 * ## 为什么"没配 Caddy"时要**明确禁用**而不是"假装可用"
 *
 * 没配 `FORLIFE_CADDY_ADMIN` 时，发布功能**不可能成功**（没有 Caddy 可配）。
 * 这时有两种做法：
 *  - 让 `publish` 一路走到"连不上 Caddy"再报错 —— 用户看到的是"配置失败"，
 *    会去排查 Caddy，而其实是根本没配；
 *  - **直接禁用**，并在接口里回一个明确的原因。
 *
 * 选后者：**能做的事与不能做的事要一眼看得出来**，而不是靠一次失败去推断。
 *
 * ## 回收定时任务为什么也要"没配就不起"
 *
 * 没有 Caddy 就没有路由可回收；而起一个每 60 秒连一次不存在地址的任务，
 * 只会在日志里刷"无法连接" —— 把真正的错误淹掉。
 *
 * @module @forlife/gateway/port-runtime
 */
import type { DatabaseSync } from 'node:sqlite'

import { createCaddyClient } from './caddy.ts'
import { DEFAULT_PORT_WHITELIST } from './ports.ts'
import { createPortService, type PortService } from './port-service.ts'

/** 装配结果。 */
export interface PortRuntime {
  /** 已装配的服务；未配置时为 `undefined`（功能禁用）。 */
  readonly service: PortService | undefined
  /** 禁用原因（界面要显示它，而不是显示一个点不动的按钮）。 */
  readonly disabledReason: string | undefined
  /** 解析出的白名单（界面要显示允许哪些段）。 */
  readonly whitelist: readonly { readonly from: number; readonly to: number }[]
  /** 停止回收定时任务。 */
  readonly stop: () => void
}

/** 从环境变量解析端口出口配置。 */
export function portConfigFromEnv(env: Record<string, string | undefined>): {
  // 用**省略**表达"没配"（而不是显式 undefined）——
  // 在 exactOptionalPropertyTypes 下这两者不是一回事，而"没配"就是没这个键
  readonly adminUrl?: string
  readonly host?: string
  readonly upstreamHost?: string
  readonly whitelist: readonly { readonly from: number; readonly to: number }[]
  readonly reclaimIntervalMs: number
} {
  const adminUrl = env['FORLIFE_CADDY_ADMIN']
  const host = env['FORLIFE_PUBLIC_HOST']
  const upstreamHost = env['FORLIFE_UPSTREAM_HOST']

  // 白名单：`8000-8099,3000-3099` 这种写法。解析不出来就**退回默认**而不是"空白名单"——
  // 空白名单会让所有发布都被拒，而用户只会以为"功能坏了"。
  const raw = env['FORLIFE_PORT_WHITELIST']
  let whitelist = DEFAULT_PORT_WHITELIST
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = raw
      .split(',')
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '')
      .map((piece) => {
        const [from, to] = piece.split('-').map((v) => Number(v.trim()))
        return { from: from ?? Number.NaN, to: to ?? from ?? Number.NaN }
      })
      .filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to) && range.from <= range.to)
    if (parsed.length > 0) whitelist = parsed
  }

  const interval = Number(env['FORLIFE_PORT_RECLAIM_MS'] ?? '60000')

  return {
    ...(adminUrl === undefined || adminUrl === '' ? {} : { adminUrl }),
    ...(host === undefined || host === '' ? {} : { host }),
    ...(upstreamHost === undefined || upstreamHost === '' ? {} : { upstreamHost }),
    whitelist,
    reclaimIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 60000,
  }
}

/**
 * 装配端口出口。
 *
 * @param options.db - 数据库。
 * @param options.env - 环境变量。
 * @param options.log - 日志。
 * @param options.fetchImpl - 便于测试注入。
 */
export function createPortRuntime(options: {
  readonly db: DatabaseSync
  readonly env: Record<string, string | undefined>
  readonly log: (message: string) => void
  readonly fetchImpl?: Parameters<typeof createCaddyClient>[0]['fetchImpl']
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: never) => void
}): PortRuntime {
  const config = portConfigFromEnv(options.env)

  if (config.adminUrl === undefined || config.host === undefined) {
    const missing = [
      ...(config.adminUrl === undefined ? ['FORLIFE_CADDY_ADMIN'] : []),
      ...(config.host === undefined ? ['FORLIFE_PUBLIC_HOST'] : []),
    ]
    return {
      service: undefined,
      // 说清缺哪个变量 —— 用户看一眼就知道要配什么
      disabledReason: `端口出口未启用：缺少环境变量 ${missing.join('、')}`,
      whitelist: config.whitelist,
      stop: () => {},
    }
  }

  const caddy = createCaddyClient({
    adminUrl: config.adminUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  const service = createPortService({
    db: options.db,
    caddy,
    host: config.host,
    ...(config.upstreamHost === undefined ? {} : { upstreamHost: config.upstreamHost }),
    log: options.log,
  })

  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((handle) => clearInterval(handle as never))

  const tick = async (): Promise<void> => {
    try {
      const result = await service.reclaimExpired()
      if (result.reclaimed.length > 0) options.log(`端口回收：${result.reclaimed.join('、')}`)
      // 失败要**每次都报**（不能只在第一次报）：一直失败说明 Caddy 有问题，
      // 而"孤儿路由还开着"这件事必须持续可见
      for (const failure of result.failed) options.log(`端口回收失败（下次会重试）：${failure}`)
    } catch (error) {
      // 定时任务里抛异常会**静默杀死整个循环**，所以必须自己接住
      options.log(`端口回收任务异常：${String(error).slice(0, 200)}`)
    }
  }

  const handle = setIntervalFn(() => void tick(), config.reclaimIntervalMs)
  // 不阻止进程退出（与健康检查循环一致）
  handle.unref?.()

  options.log(`端口出口已启用：${config.adminUrl} → https://${config.host}/svc/<name>/`)

  return {
    service,
    disabledReason: undefined,
    whitelist: config.whitelist,
    stop: () => clearIntervalFn(handle as never),
  }
}
