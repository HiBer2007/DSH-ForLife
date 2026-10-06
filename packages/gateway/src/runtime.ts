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
import { startEndpointHealthLoop } from './endpoint-health.ts'
import { createWakeRuntime } from './wake-runtime.ts'
import type { DatabaseSync } from 'node:sqlite'

import { FLAG_QQ_TAKEOVER, getFlag } from '@forlife/store'

import { FakeTurnDriver, HeadlessTurnDriver, type FakeScript } from './driver.ts'
import { Gateway, type GatewayState } from './gateway.ts'
import { createOneBotTransport, type OneBotTransport } from './onebot.ts'
import { enqueueOutbound } from './outbox.ts'
import { conversationKey } from './transport.ts'
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
  readonly outboxPollMs?: number
  /** 注入随机数（**测试用**）：唤醒判定有概率规则，不注入就没法稳定断言。 */
  readonly random?: (() => number) | undefined
}

/** 运行中的网关。 */
export interface RunningGatewayRuntime {
  readonly transport: OneBotTransport
  readonly gateway: Gateway
  state: () => GatewayState
  stop: () => Promise<void>
}

/**
 * 联调用剧本：把收到的消息回执出去，并**明确标注这是脚本**。
 *
 * ## 为什么脚本必须自己入队出站（而不是只返回 segments）
 *
 * `TurnRunner` **刻意不做出站**：出站动作是**模型通过工具**产出的（`qq_reply` 之类），
 * 发送归网关的 outbox 消费者。这是好设计（"模型说了什么"与"平台收到什么"分开，各自可重试），
 * 但它有个直接后果：**只返回文本的驱动永远不会产生回复** ——
 * 我第一版就是只返回 `segments`，于是"消息进了、轮次跑了、但没有回话"，
 * 现场看就是"出站队列是空的"。
 *
 * 所以这里补上工具层该做的那一步：把回执写进 outbox。
 * 这样联调时"收到 → 轮次 → 出站 → 平台确认"整条链都能被真实走通。
 */
function makeFakeScript(db: DatabaseSync, log: (message: string) => void): FakeScript {
  return (request) => {
    const texts = request.messages.map((message) => message.text.trim()).filter((text) => text !== '')
    const excerpt = texts.join(' / ').slice(0, 120)
    const reply = `【联调脚本】收到 ${String(request.messages.length)} 条消息：${excerpt === '' ? '(无文本)' : excerpt}`
    try {
      enqueueOutbound(db, {
        conversationKey: conversationKey(request.conversation),
        kind: 'text',
        payload: { segments: [{ kind: 'text', text: reply }] },
        conversationKind: request.conversation.kind,
      })
    } catch (error) {
      // 入队失败不能让轮次崩掉：它已经跑完了，报出去比抛出去有用
      log(`[gateway] fake 驱动入队出站失败：${String(error)}`)
    }
  // 端点健康探测：启动时立刻探一次 + 之后定时。
  // 不做这一步的话，面板上的「健康/已登记」永远显示 0/N ——
  // 因为 health_ok 从没被写过（探测以前只能手动触发）。
  const stopHealthLoop = startEndpointHealthLoop({ db, log })

    return { segments: [reply], tokensIn: 0, tokensOut: 0 }
  }
}

/** 装配（不启动）。 */
export function createGatewayRuntime(options: GatewayRuntimeOptions): RunningGatewayRuntime {
  const log = options.log

  // 唤醒引擎（PLAN 阶段 8）。没配桥时 engine 为 undefined —— 功能**明确禁用**，
  // 而不是等一次失败去推断。
  const wake = createWakeRuntime({ db: options.db, env: process.env, log })

  const transport = createOneBotTransport({
    port: options.onebot.port,
    host: options.onebot.host,
    path: options.onebot.path,
    ...(options.onebot.accessToken === undefined ? {} : { accessToken: options.onebot.accessToken }),
    log,
    // QQ 掉线/恢复 → 系统事件源（**边沿检测在里面**，所以重连不会重复唤醒）
    ...(wake.systemSource === undefined
      ? {}
      : {
          onConnectionState: (connected: boolean, detail?: string) => {
            // 断线与恢复用**独立的事件名** —— 它们是两件不同的事，
            // 用户可能只想被其中一件叫醒
            const name = connected ? 'qq.reconnected' : 'qq.disconnected'
            const outcome = wake.systemSource!.observe(name, 'onebot11', connected ? 'up' : 'down', detail)
            if (outcome.triggered.length > 0) log(`QQ 状态变化已触发 ${String(outcome.triggered.length)} 条唤醒`)
          },
        }),
  })

  let driver: TurnDriver
  if (options.driver === 'fake') {
    log('[gateway] ⚠ 驱动 = fake：回复由脚本生成（联调用），**不是模型输出**')
    driver = new FakeTurnDriver(makeFakeScript(options.db, log))
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
    ...(options.random === undefined ? {} : { random: options.random }),
  })

  const gateway = new Gateway({
    db: options.db,
    transport,
    runner,
    log,
    // 接管开关每次入站都从库里读 ⇒ 面板一拨就生效，不用重启服务
    takeover: () => getFlag(options.db, FLAG_QQ_TAKEOVER),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.outboxPollMs === undefined ? {} : { outboxPollMs: options.outboxPollMs }),
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
