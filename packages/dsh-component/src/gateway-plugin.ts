/**
 * `forlife-gateway` 插件行：把 QQ 网关挂进 DSH 进程。
 *
 * ## 为什么它是一个"不注入任何服务"的插件
 *
 * 网关自己管网络（OneBot 反向 WS）、自己管队列（共享 SQLite）、自己驱动模型
 * （headless 子进程或长连接），**不需要 DSH 的任何服务**。所以 `inject: []`。
 * 好处很实际：它可以被单独挂载、单独测试，也不会因为宿主缺某个服务就静默不工作
 * （本项目已经被 `ctx.inject([...], cb)` 静默不触发坑过一次）。
 *
 * ## 拓扑上的位置
 *
 * 生产部署里它是**独立容器**（`deploy/docker-compose.yml` 的 gateway 服务），
 * 与 DSH 通过共享卷上的同一个 SQLite 交换任务（见 gateway/src/outbox.ts 的说明）。
 * 这个插件是给本地开发用的：一条命令就能把网关跑起来，不必起 compose。
 *
 * @module forlife-memory/gateway-plugin
 */
import { defaultFor } from '@forlife/contracts'
import { Gateway, OneBotTransport } from '@forlife/gateway'
import z from '@deepseek-ai/schemastery'

import { createDriver, type TurnDriver } from '@forlife/gateway'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '@forlife/gateway'
import { readPending, seedWakeRules } from '@forlife/gateway'

import { activeRuntimes, whenRuntimeReady, type MemoryRuntime } from './index.ts'

/**
 * 等记忆运行时就绪（把回调式 API 包成 Promise，并带超时）。
 *
 * @param timeoutMs - 超时毫秒。
 * @returns 运行时，或 undefined（超时）。
 */
function waitForRuntime(timeoutMs: number): Promise<MemoryRuntime | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(undefined)
      }
    }, timeoutMs)
    whenRuntimeReady((runtime) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(runtime)
    })
  })
}

/** 插件配置。 */
export const Config = z.object({
  /** 是否启用（默认启用；关掉可让 DSH 只做记忆、不发 QQ）。 */
  enabled: z.boolean().default(true),
  /** OneBot 反向 WS 监听端口。 */
  port: z.natural().default(3080),
  /** 监听地址：默认仅回环；容器部署时才绑 0.0.0.0。 */
  host: z.string().default('127.0.0.1'),
  /** 反向 WS 路径。 */
  path: z.string().default('/'),
  /** 共享密钥；**强烈建议设置**（否则同网段任何人都能冒充 QQ 端）。 */
  accessToken: z.string().default(''),
  /** 驱动方式：headless（每轮一个子进程）或 longconnection（复用常驻会话）。 */
  driver: z.union([z.const('headless'), z.const('longconnection')]).default('headless'),
  /** headless 驱动用的 profile。 */
  driverProfile: z.string().default('forlife-headless'),
  /** 防抖窗口（毫秒，PLAN §8.4 给的范围是 2–3 秒）。 */
  debounceMs: z.natural().default(3000),
})

/** 模块名（cordis 用）。 */
export const name = 'forlife-gateway'

/** 不依赖任何宿主服务（自管网络与队列）。 */
export const inject: readonly string[] = []

/**
 * 挂载网关。
 *
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: { effect: (callback: () => () => void) => void; logger?: { info?: (m: string) => void } }, config: unknown): void {
  const resolved = config as {
    enabled: boolean
    port: number
    host: string
    path: string
    accessToken: string
    driver: 'headless' | 'longconnection'
    driverProfile: string
    debounceMs: number
  }
  if (!resolved.enabled) return

  // 同步打印一行：**真机验证就看这一行**（异步的"监听中"可能来不及打就退出了）
  // eslint-disable-next-line no-console
  console.log(
    `[forlife] QQ 网关已挂载（反向 WS ws://${resolved.host}:${String(resolved.port)}${resolved.path}，驱动 ${resolved.driver}）`,
  )

  let gateway: Gateway | undefined
  let transport: OneBotTransport | undefined

  // 用 ctx.effect 登记清理：返回的函数就是 disposer（本项目已被"误以为回调返回值是 disposer"坑过，
  // 这里严格按契约返回一个真正会停止网关的函数）。
  ctx.effect(() => {
    void (async (): Promise<void> => {
      // 等记忆运行时就绪（同一个共享库；迁移由先挂载的记忆插件完成）。
      // whenRuntimeReady 是回调式（宿主上下文的自定义属性是只读的，我们只能用注册表 + 回调）。
      const runtime = await waitForRuntime(30_000)
      if (runtime === undefined) {
        console.warn('[forlife] 网关启动失败：记忆运行时未就绪（超时 30 秒）')
        return
      }

      // 播种唤醒规则（幂等；保证"零配置也按文档工作"）
      seedWakeRules(runtime.db)

      const driver: TurnDriver = createDriver({
        kind: resolved.driver,
        headless: {
          profile: resolved.driverProfile,
          ...(process.env['DSH_HOME'] === undefined ? {} : { env: { DSH_HOME: process.env['DSH_HOME'] } }),
        },
        longConnection: { endpoint: `http://${resolved.host}:${String(resolved.port)}/turn` },
      })

      transport = new OneBotTransport({
        port: resolved.port,
        host: resolved.host,
        path: resolved.path,
        ...(resolved.accessToken === '' ? {} : { accessToken: resolved.accessToken }),
      })
      await transport.start()

      const runner = new TurnRunner({
        db: runtime.db,
        driver,
        scopeOf: defaultScopeOf,
        conditionOf: defaultConditionOf,
        unreadSummaryOf: (scope) => {
          // 唤醒时带上"你错过了什么"（只读不标记已读：标记留给模型自己read_pending时做）
          const items = readPending(runtime.db, { scope, limit: 5, markRead: false })
          if (items.length === 0) return undefined
          return items.map((i) => `${i.senderName ?? ''}：${i.summary}`).join('\n')
        },
        log: (message) => console.log(`[forlife] 轮次｜${message}`),
      })

      gateway = new Gateway({
        db: runtime.db,
        transport,
        runner,
        debounceMs: resolved.debounceMs,
        log: (message) => console.log(`[forlife] 网关｜${message}`),
      })
      gateway.start()
      console.log(`[forlife] QQ 网关监听中（等 QQ 端连入；送达确认窗口 ${String(defaultFor<number>('delivery.confirmTimeoutMs'))}ms）`)
    })().catch((error: unknown) => {
      console.error(`[forlife] 网关启动异常：${String(error)}`)
    })

    return () => {
      void (async (): Promise<void> => {
        await gateway?.stop()
        await transport?.stop()
      })()
    }
  })
}

/** 供诊断脚本读取：当前挂载了几个运行时。 */
export function runtimeCount(): number {
  return activeRuntimes().length
}

