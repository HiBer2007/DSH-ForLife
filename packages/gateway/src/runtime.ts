/**
 * 常驻运行时 —— 把"传输 → 网关 → 轮次 → 出站"这条链装配成一个可以 start/stop 的整体。
 *
 * ## 为什么要单独一个模块
 *
 * `server.ts` 只该管 HTTP（管理后台）；QQ 这条链是**另一件事**，有自己的启动顺序、
 * 失败模式与开关。混在一起会变成"HTTP 起来了但 QQ 没起来，日志里看不出谁的问题"。
 *
 * ## 驱动是可切换的（这是排障的关键设计）
 *
 * - `headless`：真跑 DSH 无头会话（生产用）；
 * - `fake`：按剧本扮演模型（**联调/排障用**）。它让"消息进 → 唤醒 → 轮次 → 出站 → 确认"
 *   这条链能在没有模型凭据的情况下先跑通 —— 出问题时能立刻分清是链路错还是模型错。
 *
 * 用 fake 时会**大声打日志**：绝不能让人以为那是模型回复。
 *
 * @module @forlife/gateway/runtime
 */
import type { DatabaseSync } from 'node:sqlite'

import { FakeTurnDriver, HeadlessTurnDriver, type FakeScript } from './driver.ts'
import { Gateway, type GatewayState } from './gateway.ts'
import { createOneBotTransport, type OneBotTransport } from './onebot.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner, type TurnDriver } from './turns.ts'

/** 运行时选项。 */
export interface GatewayRuntimeOptions {
  readonly db: DatabaseSync
  readonly log: (message: string) => void
  /** OneBot 反向 WS 监听。 */
  readonly onebot: {
    readonly port: number
    readonly host: string
    readonly path: string
    readonly accessToken?: string | undefined
  }
  /** 驱动选择。 */
  readonly driver: 'headless' | 'fake'
  /** headless 驱动参数（DSH_HOME / profile 等）。 */
  readonly headless?: {
    readonly bin?: string | undefined
    readonly profile?: string | undefined
    readonly dshHome?: string | undefined
    readonly timeoutMs?: number | undefined
  }
  /** 关掉噪音过滤（默认开）。**只用于排障**：正常该让不值得回复的消息不进记忆系统。 */
  readonly disableNoiseFilter?: boolean
  readonly debounceMs?: number
}

/** 运行中的网关。 */
export interface RunningGatewayRuntime {
  readonly transport: OneBotTransport
  readonly gateway: Gateway
  state: () => GatewayState
  stop: () => Promise<void>
}

/** 联调用剧本：把收到的消息原样回执，并**明确标注这是脚本**。 */
const fakeScript: FakeScript = (request) => {
  const texts = request.messages.map((message) => message.text.trim()).filter((text) => text !== '')
  const excerpt = texts.join(' / ').slice(0, 120)
  return {
    segments: [`【联调脚本】收到 ${request.messages.length} 条消息：${excerpt === '' ? '(无文本)' : excerpt}`],
    tokensIn: 0,
    tokensOut: 0,
  }
}

/** 装配（不启动）。 */
export function createGatewayRuntime(options: GatewayRuntimeOptions): RunningGatewayRuntime {
  const log = options.log

  const transport = createOneBotTransport({
    port: options.onebot.port,
    host: options.onebot.host,
    path: options.onebot.path,
    ...(options.onebot.accessToken === undefined ? {} : { accessToken: options.onebot.accessToken }),
    log,
  })

  let driver: TurnDriver
  if (options.driver === 'fake') {
    log('[gateway] ⚠ 驱动 = fake：回复由脚本生成（联调用），**不是模型输出**')
    driver = new FakeTurnDriver(fakeScript)
  } else {
    const headless = options.headless ?? {}
    log(`[gateway] 驱动 = headless（profile=${headless.profile ?? 'forlife-headless'}）`)
    driver = new HeadlessTurnDriver({
      ...(headless.bin === undefined ? {} : { bin: headless.bin }),
      ...(headless.profile === undefined ? {} : { profile: headless.profile }),
      ...(headless.timeoutMs === undefined ? {} : { timeoutMs: headless.timeoutMs }),
      ...(headless.dshHome === undefined ? {} : { env: { DSH_HOME: headless.dshHome } }),
      log,
    })
  }

  const runner = new TurnRunner({
    db: options.db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    log,
    ...(options.disableNoiseFilter === true ? { disableNoiseFilter: true } : {}),
  })

  const gateway = new Gateway({
    db: options.db,
    transport,
    runner,
    log,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  })

  return {
    transport,
    gateway,
    state: () => gateway.state(),
    stop: async (): Promise<void> => {
      await gateway.stop()
      await driver.close?.()
      await transport.stop()
    },
  }
}

/** 启动：**先开传输再开网关**（顺序反了会漏掉握手后立刻到达的事件）。 */
export async function startGatewayRuntime(options: GatewayRuntimeOptions): Promise<RunningGatewayRuntime> {
  const runtime = createGatewayRuntime(options)
  await runtime.transport.start()
  runtime.gateway.start()
  options.log(`[gateway] OneBot 反向 WS 监听 ws://${options.onebot.host}:${options.onebot.port}${options.onebot.path}`)
  return runtime
}
