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
import { createSystemEventHooks } from './wake-system-hooks.ts'
import { startSettleLoop } from './settle-loop.ts'
import { monitorConfigFromEnv, startSystemMonitor } from './wake-system-monitor.ts'
import { createWakeRuntime } from './wake-runtime.ts'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { FLAG_QQ_TAKEOVER, getFlag, moveFileWithVerify } from '@forlife/store'

import { FakeTurnDriver, HeadlessTurnDriver, type FakeScript } from './driver.ts'
import { Gateway, type GatewayState } from './gateway.ts'
import { defaultAttachmentRoot } from './media-resolve.ts'
import { createOneBotTransport, type OneBotTransport } from './onebot.ts'
import { enqueueOutbound } from './outbox.ts'
import { conversationKey, parseConversationKey } from './transport.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner, type TurnDriver } from './turns.ts'
import { createVisionFromEnv } from './vision-wiring.ts'

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

    return { segments: [reply], tokensIn: 0, tokensOut: 0 }
  }
}

/** 装配（不启动）。 */
export function createGatewayRuntime(options: GatewayRuntimeOptions): RunningGatewayRuntime {
  const log = options.log

  // 唤醒引擎（PLAN 阶段 8）。没配桥时 engine 为 undefined —— 功能**明确禁用**，
  // 而不是等一次失败去推断。
  // **延迟引用 driver** —— 它在下面才建（L166+），而唤醒引擎在这里就要装配。
  // 用闭包捕获一个 `let`：等真的有唤醒要跑时，driver 早就绪了。
  let wakeDriver: TurnDriver | undefined

  const wake = createWakeRuntime({
    db: options.db,
    env: process.env,
    log,
    // **唤醒走 gateway 自己的 driver** —— 和普通 QQ 轮次完全相同的一条路。
    //
    // 真机发现：QQ 的每一轮是 gateway 起 `dsh headless` 子进程跑的，
    // **不是** web app 的会话；而唤醒轮询器在 web app 里 —— 两者没有交集。
    runTurn: async ({ conversationKey, prompt, sourceKind, summary }) => {
      if (wakeDriver === undefined) {
        return { ok: false, reason: '驱动还没就绪（gateway 仍在启动），稍后重试' }
      }
      const parsed = parseConversationKey(conversationKey)
      // 键不合法 ⇒ 明确失败。**不能猜一个会话去跑** ——
      // 那会让唤醒发到错误的会话里，而用户完全不知道。
      if (parsed === undefined) {
        return { ok: false, reason: `会话键不合法：${conversationKey}` }
      }
      // 会话类型从库里查（影响提示词里的会话标签）
      const known = options.db
        .prepare('SELECT kind FROM qq_sessions WHERE conversation_key = ?')
        .get(conversationKey) as { kind?: string } | undefined
      const kind = known?.kind === 'group' ? 'group' : 'private'
      const outcome = await wakeDriver.run({
        turnId: `wake-${randomUUID()}`,
        conversation: { platform: parsed.platform, chatId: parsed.chatId, ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }), kind },
        // **没有入站消息** —— 这是"自己醒过来"，不是"有人说话"
        messages: [],
        prompt,
        signal: AbortSignal.timeout(5 * 60_000),
      })
      if (outcome.error !== undefined) return { ok: false, reason: `轮次失败：${outcome.error}` }
      const text = (outcome.segments ?? []).join('\n').trim()
      return {
        ok: true,
        reason: `${summary}：模型已执行（工具调用 ${String(outcome.toolCalls ?? 0)} 次）`,
        ...(text === '' ? {} : { modelDid: text.slice(0, 200) }),
        ...(outcome.tokensIn === undefined && outcome.tokensOut === undefined
          ? {}
          : { costTokens: (outcome.tokensIn ?? 0) + (outcome.tokensOut ?? 0) }),
      }
    },
  })

  // 端点健康探测：启动时立刻探一次 + 之后定时。
  // 不做这一步的话，面板上的「健康/已登记」永远显示 0/N ——
  // 因为 health_ok 从没被写过（探测以前只能手动触发）。
  //
  // **搬家说明**：它原来在 makeFakeScript 里，而那是**每次跑轮次**都会调的 ——
  // 于是每跑一轮就新建一个探测循环（返回的 stop 还被丢掉了）。
  // 跑 N 轮就有 N 个循环在探所有端点 = **N 倍的端点请求量**，而额度是要花钱的。
  const systemHooks = createSystemEventHooks({ source: wake.systemSource, log })
  const stopHealthLoop = startEndpointHealthLoop({
    db: options.db,
    log,
    // 端点不可用/恢复 ⇒ system 触发（**边沿检测在事件源里**，所以不会重复唤醒）
    onProbeResult: (endpointName, ok, error) => {
      systemHooks.endpointUnavailable(endpointName, ok, error)
    },
  })

  // 系统监视：磁盘水位 ⇒ system 触发。
  // **持续看**而不是等写入失败才上报 —— 那时已经晚了（那一次写入已经丢了，
  // 而模型可能正在压缩记忆，压缩失败会丢数据）。
  const monitorConfig = monitorConfigFromEnv(process.env)
  const systemMonitor = startSystemMonitor({
    hooks: systemHooks,
    mounts: monitorConfig.mounts,
    thresholdRatio: monitorConfig.thresholdRatio,
    intervalMs: monitorConfig.intervalMs,
    log,
  })

  // ── blob 沉降循环（PLAN 阶段 9 交付物 1 的"定时"那一半）──────────────
  //
  // 只有 settleBlobs 函数不算交付物完成 —— 交付物要的是「**定时**沉降任务」。
  // 没配 FORLIFE_ROOT_HOT 时它**明确不启动**（而不是跑一个空循环）。
  const settleLoop = startSettleLoop({
    db: options.db,
    env: process.env,
    moveFile: moveFileWithVerify,
    log,
  })

  const transport = createOneBotTransport({
    port: options.onebot.port,
    host: options.onebot.host,
    path: options.onebot.path,
    ...(options.onebot.accessToken === undefined ? {} : { accessToken: options.onebot.accessToken }),
    log,
    // QQ 掉线/恢复 → 系统事件源 + **存活判据**（**边沿检测在里面**，所以重连不会重复唤醒）
    onConnectionState: (connected: boolean, detail?: string) => {
      // ① ★ 存活判据也要知道 WS 通不通。
      //
      // 不喂它的话，一次**真的**断线会走两条路：连接回调报 `qq.disconnected`，
      // 90 秒后心跳超时再报一次 `qq.silent` —— 同一件事把模型叫醒两次。
      // 喂了之后"WS 断"就归连接路径，"WS 通但 QQ 死了"才归存活判据（见 wake-liveness.ts）。
      wake.livenessMonitor?.observeTransport(connected, detail)
      const source = wake.systemSource
      if (source === undefined) return
      // ② 断线与恢复用**独立的事件名** —— 它们是两件不同的事，
      // 用户可能只想被其中一件叫醒
      // **用 observeConnection**（盯一个状态量）—— 用 observe 传两个事件名的话，
      // qq.disconnected 那一侧永远看不到"恢复"，**第二次断线不会被唤醒**
      const outcome = source.observeConnection(connected, detail)
      // **诊断日志**（真机排查用）：回调有没有被调用、边沿判定结果是什么。
      // 没有它的话，"QQ 端断开"记了但触发器没动时，完全看不出卡在哪一步。
      log(`[诊断] 连接回调 connected=${String(connected)} → changed=${String(outcome.changed)} triggered=${String(outcome.triggered.length)}｜${outcome.reason.slice(0, 90)}`)
      if (outcome.triggered.length > 0) log(`QQ 状态变化已触发 ${String(outcome.triggered.length)} 条唤醒`)
    },
    // ★★ P1-3 的后半截：**心跳必须喂给存活判据**。
    //
    //   `onebot.ts` 现在把 `meta_event.heartbeat` 的 `status.online` / `good` / `interval`
    //   原样交出来（**不落库**：30 秒一条 = 2880 行/天，而且会淹掉真正的报告）。
    //   判据侧只认"心跳沉默"这一条证据（`max(3×interval, 90s)`），
    //   而**从不采用"N 分钟无任何消息"** —— 凌晨没人说话是正常的，那会每夜误报一次
    //   （代价是一次真实模型调用 + 模型开始怀疑一个不存在的故障）。
    //
    //   ⚠️ 这条链是"35 小时假活"事故的唯一解药：WS 一直 ESTABLISHED、
    //   而 QQ 早已被静默踢下线时，只有心跳能说话。
    onHeartbeat: (heartbeat) => {
      const verdict = wake.livenessMonitor?.observeHeartbeat(heartbeat)
      if (verdict !== undefined && verdict.state !== 'alive') {
        log(`[诊断] 心跳存活判定：${verdict.state}（${verdict.evidence}）｜${verdict.reason.slice(0, 120)}`)
      }
    },
    // ★ 第二个独立证据：协议端明确说"掉线了"（NapCat 的 `notice_type: bot_offline`）。
    onBotOffline: (reason, at) => {
      const verdict = wake.livenessMonitor?.observeBotOffline(reason, at)
      log(`[诊断] 协议端报告掉线：${reason}${verdict === undefined ? '' : `（判定 ${verdict.state}）`}`)
    },
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

  // 现在 driver 就绪了 —— 唤醒可以开始跑轮次
  wakeDriver = driver

  const runner = new TurnRunner({
    db: options.db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    log,
    ...(options.disableNoiseFilter === true ? { disableNoiseFilter: true } : {}),
    ...(options.random === undefined ? {} : { random: options.random }),
  })

  // ★ P1-1：视觉桥接（图片 → 文字）。**没配就明确说没启用**，而不是静默少个功能 ——
  //   "为什么她发的截图模型看不见"必须能在一行启动日志里回答。
  const attachmentRoot = defaultAttachmentRoot(process.env)
  const visionWiring = createVisionFromEnv({ db: options.db, storageRoot: attachmentRoot, log })
  log(`[gateway] ${visionWiring.note}`)

  const gateway = new Gateway({
    db: options.db,
    transport,
    runner,
    log,
    // 接管开关每次入站都从库里读 ⇒ 面板一拨就生效，不用重启服务
    takeover: () => getFlag(options.db, FLAG_QQ_TAKEOVER),
    // ★ P1-1：图片/语音/文件的取回都挂在网关这条链上（位置见 gateway.ts 的 resolveMedia）
    imageStorageRoot: attachmentRoot,
    ...(visionWiring.vision === undefined ? {} : { imageVision: visionWiring.vision }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.outboxPollMs === undefined ? {} : { outboxPollMs: options.outboxPollMs }),
  })

  return {
    transport,
    gateway,
    state: () => gateway.state(),
    stop: async (): Promise<void> => {
      await gateway.stop()
      stopHealthLoop()
    settleLoop.stop()
      systemMonitor.stop()
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
