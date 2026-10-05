/**
 * 自研回退链（EXECUTION_PLAN §2.7.3 第 3/4/5 条）。
 *
 * ## 为什么必须自己做
 *
 * 宿主**没有**跨模型 failover：`agent/request-error` 的动作联合只有 `{kind:'retry'}`，
 * 重试永远打在**同一个** provider 上。provider 挂了或没额度时，重试 5 次只是把同一个错误
 * 重放 5 次，然后整轮失败。
 *
 * ## 最难的那条约束：`agent/request` 每次重试都会重跑
 *
 * 这意味着换路由的逻辑必须：
 *  - **幂等**：同一步里重跑 N 次，只能换一次路由（否则会把候选链一路用光，
 *    最后跑到最差的那个模型上，而且日志里全是"降级"）；
 *  - **带状态**：得记住"这一步已经换到谁了"，否则每次重跑都从主选开始挑，
 *    挑到的还是那个坏掉的 provider；
 *  - **每 step 重新断言**：换过路由会成为**新的基线并粘住**（§2.7.3 第 5 条），
 *    所以每个 step 开始时必须重新按档位判定，而不是沿用上一步的临时路由。
 *
 * 这个模块是纯状态机（注入一切副作用），因为上面这三条恰恰是最难在真机上复现的：
 * 真机上的表现是"偶尔整轮失败"或"偶尔跑到很差的模型上"，几乎无法定位。
 *
 * @module @forlife/router/failover
 */
import { defaultFor } from '@forlife/contracts'

/** 模型引用。 */
export interface ModelRef {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 失败类别（决定该不该换路由）。 */
export type FailureKind =
  | 'rate-limit' // 限流/无额度：换路由有意义
  | 'server' // 服务端错误：换路由有意义
  | 'timeout' // 超时：换路由有意义
  | 'transport' // 网络：可能只是抖动，先重试
  | 'empty-response' // 空响应：换路由有意义
  | 'auth' // 鉴权失败：换路由**没意义**（我们的密钥就是错的）
  | 'bad-request' // 请求本身有问题：换路由没意义（换个模型一样错）
  | 'unknown'

/** 一次失败的记录。 */
export interface RequestFailure {
  readonly kind: FailureKind
  readonly provider: string
  readonly message: string
  readonly at: string
}

/** 换路由是否对这类失败有意义。 */
export function isSwappable(kind: FailureKind): boolean {
  return kind === 'rate-limit' || kind === 'server' || kind === 'timeout' || kind === 'empty-response'
}

/** 一步的状态（`agent/request` 重跑时要读它，保证幂等）。 */
export interface StepFailoverState {
  /** 步骤标识（turnId:step）。换了 step 就重置。 */
  readonly stepKey: string
  /** 这一步**原始**的路由（主选）。 */
  readonly original: ModelRef
  /** 这一步当前实际用的路由。 */
  readonly current: ModelRef
  /** 这一步已经换过几次（换过就不再换：见下面的"只换一次"策略）。 */
  readonly swaps: number
  /** 候选链上的下一个位置（游标，避免重复撞同一个坏 provider）。 */
  readonly cursor: number
  /** 这一步的失败记录。 */
  readonly failures: readonly RequestFailure[]
}

/** 创建一步的初始状态。 */
export function startStep(stepKey: string, original: ModelRef): StepFailoverState {
  return { stepKey, original, current: original, swaps: 0, cursor: 0, failures: [] }
}

/** 裁决结果。 */
export interface FailoverDecision {
  readonly action: 'keep' | 'swap' | 'give-up'
  readonly state: StepFailoverState
  /** 换到哪（action=swap 时）。 */
  readonly next?: ModelRef
  readonly reason: string
}

/** 回退策略。 */
export interface FailoverPolicy {
  /**
   * 同一 provider 连续失败几次后换路由。
   *
   * 默认取保真度基线 `router.fallback.failuresBeforeSwitch`（3），语义是**"到阈值就换"**。
   * 网络类失败会多给一次机会（阈值 +1），因为可能只是抖一下。
   */
  readonly failuresBeforeSwap?: number
  /** 一步内最多换几次（默认 1：见下方注释）。 */
  readonly maxSwapsPerStep?: number
}

/**
 * 记一次请求失败并裁决下一步动作。
 *
 * **「一步最多换一次」是刻意的**：换太多次意味着候选链上全是坏的，
 * 那种情况下继续换只是在浪费时间和钱，不如**尽早失败**让人看到问题
 * （"这一档没有可用模型"是必须让人知道的事实，而不是被掩盖过去）。
 *
 * @param state - 当前状态。
 * @param failure - 这次失败。
 * @param candidates - 该档位的候选链（有序）。
 * @param policy - 策略。
 * @returns 裁决。
 */
export function onRequestError(
  state: StepFailoverState,
  failure: RequestFailure,
  candidates: readonly ModelRef[],
  policy: FailoverPolicy = {},
): FailoverDecision {
  const failuresBeforeSwap = policy.failuresBeforeSwap ?? defaultFor<number>('router.fallback.failuresBeforeSwitch')
  const maxSwapsPerStep = policy.maxSwapsPerStep ?? 1
  const failures = [...state.failures, failure]
  const sameProviderFailures = failures.filter((item) => item.provider === state.current.provider).length
  const next: StepFailoverState = { ...state, failures }

  // ① 鉴权失败/请求本身有问题 ⇒ 换路由没意义
  if (failure.kind === 'auth') {
    return { action: 'give-up', state: next, reason: '鉴权失败：换模型也解决不了（密钥或权限问题需要人处理）' }
  }
  if (failure.kind === 'bad-request') {
    return { action: 'give-up', state: next, reason: '请求本身有问题：换个模型一样会失败（应该先修请求）' }
  }

  // ② 网络抖动/未知失败多给一次机会（可能只是抖一下），但仍会换 —— 连撞多次就不是抖动了
  const effectiveThreshold = isSwappable(failure.kind) ? failuresBeforeSwap : failuresBeforeSwap + 1

  // ③ 已经换过了 ⇒ 不再换（幂等 + 避免把候选链用光）
  if (next.swaps >= maxSwapsPerStep) {
    return {
      action: 'give-up',
      state: next,
      reason: `本步已换过 ${String(next.swaps)} 次路由，不再继续换（继续换只会把候选链用光；尽早失败让人看到"这一档没有可用模型"比掩盖它好）`,
    }
  }

  // ④ 同一 provider 失败次数不够 ⇒ 先重试。
  // **注意是"到阈值就换"**（第 N 次失败时换），不是"超过阈值才换"——
  // 差一位会让所有阈值整体偏移，而表现出来只是"降级慢了一拍"，极难发现。
  if (sameProviderFailures < effectiveThreshold) {
    return {
      action: 'keep',
      state: next,
      reason:
        `同一 provider 失败 ${String(sameProviderFailures)} 次，未到换路由阈值 ${String(effectiveThreshold)}` +
        (isSwappable(failure.kind) ? '' : '（网络类失败多给一次机会）'),
    }
  }

  // ⑤ 从游标之后找下一个候选（跳过当前这个坏掉的）
  let cursor = next.cursor
  while (cursor < candidates.length) {
    const candidate = candidates[cursor]
    cursor += 1
    if (candidate === undefined) continue
    if (candidate.provider === next.current.provider && candidate.model === next.current.model) continue
    const swapped: StepFailoverState = {
      ...next,
      current: candidate,
      swaps: next.swaps + 1,
      cursor,
    }
    return {
      action: 'swap',
      state: swapped,
      next: candidate,
      reason: `换到 ${candidate.provider}/${candidate.model}（原 ${next.current.provider}/${next.current.model} 失败：${failure.message.slice(0, 80)}）`,
    }
  }

  return {
    action: 'give-up',
    state: { ...next, cursor },
    reason: `候选链已用尽（试过 ${String(cursor)} 个候选）—— 这一档没有可用模型，需要人处理`,
  }
}

/**
 * 每 step 重新断言路由（§2.7.3 第 5 条：防粘性基线）。
 *
 * 这一步是**必须**的：换过路由之后，那个临时选择会成为新的基线并粘住；
 * 如果不重新断言，一次偶发失败会让后续所有步骤都用备模型（甚至更差的），
 * 而没人会注意到（表现只是"今天好像变笨了一点"）。
 *
 * @param state - 上一步的状态（可能带临时路由）。
 * @param stepKey - 新步骤的标识。
 * @param asserted - 按档位重新判定出来的路由。
 * @returns 新状态与说明。
 */
export function assertRouteForStep(
  state: StepFailoverState | undefined,
  stepKey: string,
  asserted: ModelRef,
): { readonly state: StepFailoverState; readonly note?: string } {
  if (state === undefined) return { state: startStep(stepKey, asserted) }
  if (state.stepKey === stepKey) {
    // 同一步内重跑（`agent/request` 的重试）⇒ **保持**当前路由，这正是不粘性的另一半
    return { state }
  }
  const wasSwapped = state.swaps > 0
  return {
    state: startStep(stepKey, asserted),
    ...(wasSwapped
      ? {
          note:
            `上一步曾临时换到 ${state.current.provider}/${state.current.model}，` +
            `本步已重新断言回 ${asserted.provider}/${asserted.model}（不重新断言的话临时路由会粘住，` +
            '表现为"今天好像变笨了一点"而没人能定位）',
        }
      : {}),
  }
}

/** 从错误消息猜失败类别（宿主只给一个字符串，我们只能尽力）。 */
export function classifyFailure(message: string): FailureKind {
  const text = message.toLowerCase()
  if (/401|403|unauthor|invalid api key|authentication/.test(text)) return 'auth'
  if (/400|422|invalid request|bad request|unsupported/.test(text)) return 'bad-request'
  if (/429|rate.?limit|quota|insufficient|no credit|余额|额度/.test(text)) return 'rate-limit'
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout'
  if (/500|502|503|504|server error|overloaded/.test(text)) return 'server'
  if (/econnreset|enotfound|econnrefused|socket|network|transport/.test(text)) return 'transport'
  if (/empty response|no content/.test(text)) return 'empty-response'
  return 'unknown'
}
