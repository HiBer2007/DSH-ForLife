/**
 * 把自研回退链接到宿主的 `agent/request-error` / `agent/request`（阶段 5 §2.7.3）。
 *
 * ## 为什么必须"接线"而不是写个函数
 *
 * 宿主**没有**跨模型 failover：`agent/request-error` 的动作联合只有 `{kind:'retry'}`。
 * 所以降级能力完全取决于**我们有没有挂上这两个钩子**。
 *
 * ## 两条时序约束（§2.7.3 第 3/4 条）
 *
 * ① `agent/request` 在 `step()` 的**重试循环内**，每次重试都会重跑 ⇒
 *    换路由的状态机必须**幂等**（`@forlife/router` 的 `onRequestError` 保证了）；
 * ② 换过路由会成为**新的 header 基线并粘住** ⇒ 每个 step 必须**重新断言**
 *    （`assertRouteForStep` 保证了）。
 *
 * ## 这个模块的职责边界
 *
 * 它只做"记账 + 裁决 + 留痕"，**不直接改宿主的路由**（那是 `agent/request` 钩子里
 * 用返回的 `LlmCallConfig` 做的）。这样裁决逻辑可以被完整测试，而宿主交互面最小。
 *
 * @module forlife-memory/router-hooks
 */
import {
  assertRouteForStep,
  classifyFailure,
  onRequestError,
  type FailoverDecision,
  type ModelRef,
  type StepFailoverState,
} from '@forlife/router'

import type { MemoryRuntime } from './runtime.ts'

/** 钩子配置。 */
export interface RouterHookOptions {
  /** 当前档位对应的候选链（有序）。 */
  readonly candidates: () => readonly ModelRef[]
  /** 记一条路由决策（落到 routing_log）。 */
  readonly record: (input: {
    readonly tier: string
    readonly source: string
    readonly confidence: number
    readonly latencyMs: number
    readonly provider?: string | null
    readonly model?: string | null
    readonly switched?: boolean
    readonly switchReason?: string | null
    readonly note?: string | null
  }) => void
  readonly log?: (message: string) => void
}

/**
 * 回退链的运行时状态（跨钩子共享）。
 *
 * 刻意做成一个显式对象而不是模块级变量：**可测**且**可重置**
 * （模块级状态会让测试互相污染，那是我们已经在别处踩过的坑）。
 */
export class FailoverRuntime {
  private state: StepFailoverState | undefined
  private readonly options: RouterHookOptions

  constructor(options: RouterHookOptions) {
    this.options = options
  }

  /** 当前这一步的路由（没有任何状态时返回 undefined）。 */
  currentRoute(): ModelRef | undefined {
    return this.state?.current
  }

  /** 已经换过几次（面板/日志要能看出"这次降级了"）。 */
  swaps(): number {
    return this.state?.swaps ?? 0
  }

  /**
   * 步骤开始：每 step 重新断言（防粘性）。
   *
   * @param stepKey - 步骤标识（`turnId:step`）。
   * @param asserted - 按档位判定出来的路由。
   * @returns 生效的路由。
   */
  beginStep(stepKey: string, asserted: ModelRef): ModelRef {
    const { state, note } = assertRouteForStep(this.state, stepKey, asserted)
    this.state = state
    if (note !== undefined) this.options.log?.(note)
    return state.current
  }

  /**
   * 请求失败：裁决是否换路由（**幂等**：同一步重跑只会换一次）。
   *
   * @param input - 失败的 provider/model 与错误消息。
   * @returns 裁决结果。
   */
  onError(input: { readonly provider: string; readonly model: string; readonly message: string; readonly tier?: string }): FailoverDecision {
    if (this.state === undefined) {
      // 没走过 beginStep 就先失败：以当前 provider/model 作为起点，仍要给出裁决
      this.state = assertRouteForStep(undefined, 'unknown', { provider: input.provider, model: input.model }).state
    }
    const decision = onRequestError(
      this.state,
      {
        kind: classifyFailure(input.message),
        provider: input.provider,
        message: input.message,
        at: new Date().toISOString(),
      },
      this.options.candidates(),
    )
    this.state = decision.state

    // 留痕：降级必须能在路由日志里看到（否则"为什么这次答得不一样"无从查起）
    this.options.record({
      tier: input.tier ?? 'L2',
      source: decision.action === 'swap' ? 'failover-swap' : decision.action === 'give-up' ? 'failover-give-up' : 'failover-retry',
      confidence: 1,
      latencyMs: 0,
      provider: decision.next?.provider ?? input.provider,
      model: decision.next?.model ?? input.model,
      switched: decision.action === 'swap',
      switchReason: decision.reason,
      note: decision.reason,
    })
    if (decision.action !== 'keep') this.options.log?.(`回退链：${decision.action} —— ${decision.reason}`)
    return decision
  }

  /** 重置（新一轮/新会话）。 */
  reset(): void {
    this.state = undefined
  }
}

/**
 * 构造回退链运行时。
 *
 * @param runtime - 记忆运行时。
 * @param options - 候选链与记账。
 * @returns 运行时。
 */
export function buildFailoverRuntime(runtime: MemoryRuntime, options: RouterHookOptions): FailoverRuntime {
  void runtime
  return new FailoverRuntime(options)
}
