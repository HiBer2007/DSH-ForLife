/**
 * 把 `FailoverRuntime`（纯裁决对象）**真的挂到宿主那两个瀑布事件上**。
 *
 * ## ★ 为什么需要这一层（`router-hooks.ts` 自己没写）
 *
 * `router-hooks.ts` 的模块头逐字写着：
 *
 * > 宿主**没有**跨模型 failover：`agent/request-error` 的动作联合只有 `{kind:'retry'}`。
 * > 所以降级能力完全取决于**我们有没有挂上这两个钩子**。
 *
 * **但它全文没有一行宿主交互**（没有 `ctx.on`、没有 `dispatch`；
 * `buildFailoverRuntime(runtime, options)` 连 `runtime` 都忽略）。
 * ⇒ 它只是裁决逻辑，**接线这一层从来没写过**。`deviations.ts:129` 也记着这条偏离
 * （`FailoverDecision.next` 没有消费者）。
 *
 * ## 两个事件的**真实形状**（从 `dsh-agent/lib/types/runtime-types.d.ts` 读出来的）
 *
 * ```ts
 * 'agent/request'(payload: { agent, turn, step, signal },
 *                 next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>          // waterfall
 *
 * 'agent/request-error'(payload: { agent, turn, step, provider,
 *                                  failure: LlmFailure, retryPolicy, signal },
 *                       next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>  // waterfall
 * ```
 *
 * 宿主文档原文：**监听器在"自己接管恢复"时返回 `{kind:'retry'}` 并且不调 `next()`**，
 * 否则调 `next()` 委托。默认的 `undefined` 让失败成为终局。
 *
 * ```ts
 * interface LlmCallConfig { provider: string; model: string;
 *                           reasoningEffort?; temperature?; maxTokens?; stop? }
 * interface LlmFailure { message: string; code: string; status?; providerRetryAfterMs?; … }
 * ```
 *
 * ## ★★ 三条不许违反的纪律
 *
 * **① 默认不许改行为。** 换模型是"她答得不一样"的直接原因。所以本层受
 * **`FORLIFE_ROUTER_MODE`** 同一个门控：`off` 完全不订阅；`observe`
 * **只记一条日志、原样 `next()`**；只有 `apply` 才真的换。
 * （复用同一个门控而不是新开一个开关：两个开关会让人以为"路由关了但降级还开着"。）
 *
 * **② `agent/request` 每次重试都会重跑 ⇒ 必须幂等 + 每步重新断言。**
 * 幂等由 `assertRouteForStep` 保证（同一步重跑保持当前路由）；"每步重新断言"
 * 是防**粘性**（换过的路由会成为新基线并粘住）。
 *
 * **③ 自己接管时要返回 `{kind:'retry'}` 且不调 `next()`。**
 * 调了 `next()` 就等于把裁决权交回去 —— 那我们算出来的新路由**永远不会生效**，
 * 而日志里却写着"已降级"。**那是最坏的一种谎**。
 *
 * @module forlife-memory/failover-hooks
 */
import { type FailoverRuntime, type RouterHookOptions } from './router-hooks.ts'

/** 门控（与 `model-router.ts` 同一套取值）。 */
export type RouterMode = 'off' | 'observe' | 'apply'

/** `LlmCallConfig` 的**最小**形状（宿主那边在 `dsh-llm/lib/types/call-config.d.ts`）。 */
export interface LlmCallConfigLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: unknown
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
}

/** 处理器要写回的配置（我们只改 provider/model，其余原样带过去）。 */
function withRoute(config: LlmCallConfigLike, provider: string, model: string): LlmCallConfigLike {
  // ★ **原样保留**其余字段：只换路由不该顺手把 temperature/maxTokens 抹掉
  //   （那会让"降级之后答得不一样"多出一个与降级无关的原因，最难查）
  return { ...config, provider, model }
}

/** 装机参数。 */
export interface InstallFailoverOptions {
  /** 门控。`off` = 不订阅；`observe` = 只记日志；`apply` = 真的换。 */
  readonly mode: RouterMode
  /** 裁决对象（`buildFailoverRuntime` 造的）。 */
  readonly failover: FailoverRuntime
  /** 这一档的候选链（有序）。 */
  readonly candidates: RouterHookOptions['candidates']
  readonly record: RouterHookOptions['record']
  readonly log: (message: string) => void
  /** 按档位判定"这一步该用谁"（缺省 = 候选链第一个）。 */
  readonly assertRoute?: (input: {
    readonly turn: number
    readonly step: number
  }) => { readonly provider: string; readonly model: string } | undefined
}

/** 装上之后拿到的东西。 */
export interface FailoverHooks {
  readonly dispose: () => void
  /** 到目前换过几次（面板/日志要能看出"这次降级了"）。 */
  readonly swaps: () => number
}

/** 宿主那两个事件的**最小**形状（只声明我们读的部分）。 */
interface HostLike {
  readonly on?: (
    event: string,
    handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => unknown
}

/**
 * 把回退链接到宿主上。
 *
 * @param ctx - 宿主上下文（只要有 `on` 就行 —— 便于在没有 DSH 的环境里测）。
 * @param options - 见 {@link InstallFailoverOptions}。
 */
export function installFailoverHooks(ctx: HostLike, options: InstallFailoverOptions): FailoverHooks {
  const log = options.log
  const disposers: (() => void)[] = []

  // ★ 纪律 ①：`off` 连订阅都不订（"没开的功能不许留一堆空转的钩子"）
  if (options.mode === 'off') {
    log('跨模型 failover：未启用（设 FORLIFE_ROUTER_MODE=observe 可先观察，=apply 才真的换模型）')
    return { dispose: () => undefined, swaps: () => 0 }
  }

  const on = ctx.on
  if (typeof on !== 'function') {
    // 拿不到宿主事件面 ⇒ **如实说**，不假装装上了
    log('⚠️ 跨模型 failover：宿主没有 `on`，装不上（这一层没生效）')
    return { dispose: () => undefined, swaps: () => 0 }
  }

  const assertRoute =
    options.assertRoute ??
    ((): { provider: string; model: string } | undefined => {
      const first = options.candidates()[0]
      return first === undefined ? undefined : { provider: first.provider, model: first.model }
    })

  const stepKeyOf = (turn: number, step: number): string => `${String(turn)}:${String(step)}`

  // ── ① agent/request：每步重新断言（防粘性）────────────────────────────
  const requestDisposer = on('agent/request', async (payload, next) => {
    const config = (await next()) as LlmCallConfigLike
    const input = (payload ?? {}) as { turn?: unknown; step?: unknown }
    const turn = typeof input.turn === 'number' ? input.turn : 0
    const step = typeof input.step === 'number' ? input.step : 0

    const asserted = assertRoute({ turn, step })
    if (asserted === undefined) return config
    if (options.mode !== 'apply') {
      // observe：**只说不做** —— 但要说清"如果开了会换成谁"
      log(
        `👀 failover(observe) 第 ${stepKeyOf(turn, step)} 步：宿主给的是 ${config.provider}/${config.model}，` +
          `若开启会断言成 ${asserted.provider}/${asserted.model}`,
      )
      return config
    }

    const effective = options.failover.beginStep(stepKeyOf(turn, step), asserted)
    if (effective.provider === config.provider && effective.model === config.model) return config
    log(
      `🔀 failover：第 ${stepKeyOf(turn, step)} 步改用 ${effective.provider}/${effective.model}` +
        `（宿主原本给的是 ${config.provider}/${config.model}）`,
    )
    return withRoute(config, effective.provider, effective.model)
  })
  if (typeof requestDisposer === 'function') disposers.push(requestDisposer as () => void)

  // ── ② agent/request-error：裁决是否换路由 ─────────────────────────────
  const errorDisposer = on('agent/request-error', async (payload, next) => {
    const input = (payload ?? {}) as {
      turn?: unknown
      step?: unknown
      provider?: unknown
      failure?: { message?: unknown; code?: unknown }
    }
    const provider = typeof input.provider === 'string' ? input.provider : ''
    const message =
      typeof input.failure?.message === 'string' && input.failure.message !== ''
        ? input.failure.message
        : typeof input.failure?.code === 'string'
          ? input.failure.code
          : '（宿主没给失败详情）'
    const turn = typeof input.turn === 'number' ? input.turn : 0
    const step = typeof input.step === 'number' ? input.step : 0
    const current = options.failover.currentRoute()

    const decision = options.failover.onError({
      provider: provider !== '' ? provider : (current?.provider ?? ''),
      model: current?.model ?? '',
      message,
    })

    if (options.mode !== 'apply') {
      log(
        `👀 failover(observe)：第 ${stepKeyOf(turn, step)} 步 ${provider} 失败（${message.slice(0, 80)}）` +
          ` ⇒ 裁决 ${decision.action}${decision.next === undefined ? '' : ` → ${decision.next.provider}/${decision.next.model}`}`,
      )
      return next()
    }

    if (decision.action === 'swap' && decision.next !== undefined) {
      // ★ 纪律 ③：自己接管 —— 返回 `{kind:'retry'}` 且**不调 `next()`**。
      //   调了 next() 就等于把裁决权交回去，新路由**永远不会生效**，
      //   而日志里却写着"已降级" = 最坏的一种谎。
      log(
        `🔀 failover：${provider} 失败（${message.slice(0, 80)}）⇒ 换到 ` +
          `${decision.next.provider}/${decision.next.model} 重试`,
      )
      return { kind: 'retry' }
    }

    log(`failover：${provider} 失败但裁决是 ${decision.action}（${decision.reason}）⇒ 交给宿主`)
    return next()
  })
  if (typeof errorDisposer === 'function') disposers.push(errorDisposer as () => void)

  return {
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
    swaps: () => options.failover.swaps(),
  }
}
