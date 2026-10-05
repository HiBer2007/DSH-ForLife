/**
 * 路由决策流水线（模型路由.MD §5.5 完整流程）。
 *
 * ```
 * 轮次开始
 *   ↓
 * 守卫规则（< 1ms）
 *   ├─ 命中 → 直接返回档位
 *   ↓ 未命中
 * L1 模型评分（5-30ms，超时 50ms）
 *   ├─ 成功 → 返回档位 + confidence
 *   ├─ 超时/报错 → 启发式兜底
 *   ├─ 低置信度（< 0.6）→ 提升一档
 *   ↓
 * 档位确定
 * ```
 *
 * ## 三条纪律（都是这份文档反复强调的）
 *
 * ① **超时不阻塞**：50ms 到了就走兜底，绝不等待。评分在关键路径上。
 * ② **低置信度升一档**：误判为低档的成本（升级重试 + 用户感知）高于误判为高档
 *    （略高 token 花费）。所以宁可高估。
 * ③ **决策必须可解释**：每次决策都带 `source`（哪一层定的）、`rule`/`backend`、
 *    耗时与是否降级 —— 复盘时才能回答"为什么这次用了弱模型"。
 *
 * @module @forlife/router/pipeline
 */
import { defaultFor } from '@forlife/contracts'

import { runGuards, type GuardContext, type GuardRule, type Tier } from './guards.ts'
import { heuristicScore, type HeuristicInput } from './heuristic.ts'
import { HeuristicTierScorer, type ScoreResult, type ScoringInput, type TierScorer } from './scorer.ts'

/** 档位顺序（用于"升一档"）。 */
const TIER_ORDER: readonly Tier[] = ['L1', 'L2', 'L3']

/** 升档。 */
export function escalate(tier: Tier, steps = 1): Tier {
  const index = TIER_ORDER.indexOf(tier)
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, Math.max(0, index + steps))] ?? tier
}

/** 降档（切换策略里"省成本"时用）。 */
export function deescalate(tier: Tier, steps = 1): Tier {
  const index = TIER_ORDER.indexOf(tier)
  return TIER_ORDER[Math.max(0, index - steps)] ?? tier
}

/** 一次路由决策。 */
export interface RoutingDecision {
  /** 最终档位（已应用低置信度升档）。 */
  readonly tier: Tier
  /** 哪一层定的。 */
  readonly source: 'guard' | 'scorer' | 'heuristic'
  /** 守卫规则名（source=guard 时）。 */
  readonly rule?: string
  /** 评分后端（source=scorer/heuristic 时）。 */
  readonly backend?: string
  /** 原始档位（升档前；没升档则与 tier 相同）。 */
  readonly rawTier?: Tier
  /** 置信度（守卫给 1 —— 规则命中是确定的）。 */
  readonly confidence: number
  /** 是否升过档。 */
  readonly escalated: boolean
  /** 是否降级（评分失败）。 */
  readonly degraded: boolean
  readonly degradeReason?: string
  /** 总耗时。 */
  readonly latencyMs: number
  /** 启发式明细（降级时给，便于复盘）。 */
  readonly heuristicParts?: readonly { readonly name: string; readonly value: number }[]
}

/** 路由配置。 */
export interface RouterOptions {
  /** 主评分后端（本地容器或外挂端点）。 */
  readonly scorer?: TierScorer
  /** 兜底后端（默认启发式）。 */
  readonly fallback?: TierScorer
  /** 守卫规则集。 */
  readonly guards?: readonly GuardRule[]
  /** 注入时钟（测试用）。 */
  readonly now?: () => number
}

/**
 * 路由流水线。
 */
export class Router {
  private readonly scorer: TierScorer | undefined
  private readonly fallback: TierScorer
  private readonly guards: readonly GuardRule[] | undefined
  private readonly now: () => number

  constructor(options: RouterOptions = {}) {
    this.scorer = options.scorer
    this.fallback = options.fallback ?? new HeuristicTierScorer()
    this.guards = options.guards
    this.now = options.now ?? ((): number => Date.now())
  }

  /**
   * 决定档位。
   *
   * @param input - 文本与上下文。
   * @param guardContext - 守卫上下文（压缩任务/路由仲裁/工具链长度）。
   * @returns 决策（**永不抛异常** —— 路由失败不该让轮次失败）。
   */
  async route(input: ScoringInput, guardContext: GuardContext = {}): Promise<RoutingDecision> {
    const started = this.now()

    // 第一层：守卫（< 1ms）
    const guard = runGuards(input.text, guardContext, this.guards)
    if (guard.tier !== undefined) {
      return {
        tier: guard.tier,
        source: 'guard',
        ...(guard.rule === undefined ? {} : { rule: guard.rule }),
        confidence: 1,
        escalated: false,
        degraded: false,
        latencyMs: this.now() - started,
      }
    }

    // 第二层：L1 评分（带超时）
    const timeoutMs = defaultFor<number>('router.scorer.timeoutMs')
    const lowConfidence = defaultFor<number>('router.confidence.low')

    let scored: { tier: Tier; confidence: number } | undefined
    let backend = this.scorer?.kind ?? 'heuristic'
    let degradeReason: string | undefined

    if (this.scorer === undefined || !this.scorer.available()) {
      degradeReason = '评分后端未配置或不可用'
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        scored = await this.scorer.score(input, controller.signal)
      } catch (error) {
        const aborted = controller.signal.aborted
        degradeReason = aborted ? `评分超时（>${String(timeoutMs)}ms）` : `评分失败：${String(error)}`
      } finally {
        clearTimeout(timer)
      }
    }

    if (scored !== undefined) {
      const shouldEscalate = scored.confidence < lowConfidence
      const tier = shouldEscalate ? escalate(scored.tier) : scored.tier
      return {
        tier,
        source: 'scorer',
        backend,
        rawTier: scored.tier,
        confidence: scored.confidence,
        escalated: shouldEscalate,
        degraded: false,
        latencyMs: this.now() - started,
      }
    }

    // 第三层：启发式兜底（< 1ms，绝不阻塞）
    const fallbackResult = await this.fallback.score(input, new AbortController().signal)
    backend = this.fallback.kind
    const heuristic = heuristicScore(input)
    const shouldEscalate = fallbackResult.confidence < lowConfidence
    return {
      tier: shouldEscalate ? escalate(fallbackResult.tier) : fallbackResult.tier,
      source: 'heuristic',
      backend,
      rawTier: fallbackResult.tier,
      confidence: fallbackResult.confidence,
      escalated: shouldEscalate,
      degraded: true,
      ...(degradeReason === undefined ? {} : { degradeReason }),
      latencyMs: this.now() - started,
      heuristicParts: heuristic.parts,
    }
  }
}

/**
 * 批处理评分（模型路由.MD §8.2）。
 *
 * 群聊场景下多条消息同时到达时，逐个评分会浪费吞吐。这里并发发起（vLLM 的
 * 连续批处理会在服务端合并），并**保持输入顺序**返回 —— 顺序错了会让路由与消息错配，
 * 那是最难查的一类 bug。
 *
 * @param router - 路由器。
 * @param inputs - 待评分项。
 * @returns 与输入同序的决策。
 */
export async function routeBatch(
  router: Router,
  inputs: readonly { readonly input: ScoringInput; readonly guardContext?: GuardContext }[],
): Promise<readonly RoutingDecision[]> {
  return await Promise.all(inputs.map(async (item) => router.route(item.input, item.guardContext ?? {})))
}

/**
 * 预评分（模型路由.MD §8.5）：在防抖窗口内就把分打了。
 *
 * 用法：消息到达时启动，防抖结束时取结果。**完全隐藏评分延迟**。
 * 取不到（还没算完）就返回 undefined，调用方回落到同步评分 —— 不阻塞。
 *
 * @param router - 路由器。
 * @param input - 输入。
 * @returns 取结果的函数（同步、无副作用）。
 */
export function startPreScore(router: Router, input: ScoringInput, guardContext: GuardContext = {}): () => RoutingDecision | undefined {
  let settled: RoutingDecision | undefined
  void router.route(input, guardContext).then((decision) => {
    settled = decision
  })
  return () => settled
}

/** 把决策压成一行日志（routing_log 与面板都用这个形状）。 */
export function describeDecision(decision: RoutingDecision): string {
  const who = decision.source === 'guard' ? `守卫:${decision.rule ?? '?'}` : `${decision.source}:${decision.backend ?? '?'}`
  const bits = [`${decision.tier}`, `← ${who}`, `conf=${decision.confidence.toFixed(2)}`, `${String(Math.round(decision.latencyMs))}ms`]
  if (decision.escalated) bits.push(`（原判 ${decision.rawTier ?? '?'}，置信度低已升档）`)
  if (decision.degraded) bits.push(`（降级：${decision.degradeReason ?? '未知原因'}）`)
  return bits.join(' ')
}
