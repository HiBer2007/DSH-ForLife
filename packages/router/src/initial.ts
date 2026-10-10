/**
 * ★★ **初始路由**：一轮开始前，决定"这一轮用哪个模型"。
 *
 * ## 它在整个中介层里的位置
 *
 * ```
 * [ 接入提供方 ]  ── listProviders() / listModels() ──▶ catalog.ts（模型表 + 可达性）
 *                                                              │
 *   轮次输入 ──────────────────────────────────────────────────┐│
 *                                                             ▼▼
 *                              ★★ 本文件：初始路由 ★★
 *                                                             │
 *                                        ModelSelection {provider, model, effort}
 *                                                             ▼
 * [ 实际调用位置 ]  ◀── 写 ModelSelectionRef.current
 * ```
 *
 * ## 用户定的输入（**只有三样，不吃全部上下文**）
 *
 * > 初始路由不用特别关心记忆的内容，所以不用吃掉所有上下文，
 * > **只需要轮次输入作为参考，以及表、各个模型当前可达性**。
 *
 * ⇒ 所以这个函数的签名里**没有记忆、没有历史、没有系统提示词**。这是刻意的。
 *
 * ## 决策顺序（用户 2026-10-08 确认）
 *
 * ```
 * ① 守卫（规则，零成本）
 *      命中 ⇒ 直接定档（不调模型）
 * ② minimum 小模型评分（**还没接**，见文件末尾的 TODO）
 * ③ 启发式兜底（一定给得出答案）
 * ```
 *
 * ⚠️ **② 还没做** —— 那要先部署 `minimum`（Qwen2.5-0.5B）。现在走 ①→③。
 * **但接口已经留好了**（`PreScore`），接上时不用改这里的结构。
 *
 * ## 为什么"选模型"要独立于"定档"
 *
 * 档位（L1/L2/L3）是**语义**，模型是**资源**。
 * 同一个档位下可能有多个可达模型（我们的 GO、DS 原生、将来的本地小模型）。
 * ⇒ **先定档，再从目录里挑一个可达的** —— 这样"某个接入点挂了"只会换模型，
 * **不会改变对任务的判断**。
 */
import type { ReasoningEffort } from '@forlife/contracts'

import { type CatalogEntry, type ModelCatalog, TIER_EFFORT } from './catalog.ts'
import { type GuardContext, runGuards, type Tier } from './guards.ts'
import { heuristicScore, heuristicTier } from './heuristic.ts'

/** 怎么定的档（写进理由里，便于回看）。 */
export type TierSource = 'guard' | 'pre-score' | 'heuristic'

/** `minimum` 小模型的预评分结果（**② 还没接，先留接口**）。 */
export interface PreScore {
  readonly tier: Tier
  /** 0–1；低于置信度下限时应该退回启发式。 */
  readonly confidence: number
  /** 它给的理由（可选）。 */
  readonly reason?: string
}

/** 一个候选（用于"备选"列表）。 */
export interface RouteCandidate {
  readonly provider: string
  readonly model: string
  readonly marks: readonly string[]
}

/** 决策结果。 */
export interface InitialRouteDecision {
  /** 定的档。 */
  readonly tier: Tier
  /** 档是怎么定的。 */
  readonly tierSource: TierSource
  /** 选中哪个模型。 */
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ReasoningEffort
  /** **给人看的理由**（面板/日志/`router_status` 都用它）。 */
  readonly why: string
  /** 还有哪些可达的同类候选（降级时用）。 */
  readonly alternatives: readonly RouteCandidate[]
  /** 定了档但**一个可达模型都没有**时为 `undefined`。 */
  readonly degradeReason?: string
}

/**
 * 每个档位**偏好的模型特征**。
 *
 * ⚠️ 这里**不写死 provider/model**（那正是第 17 处缺陷的教训：
 * 写死的清单会与实际可用集合漂移）。**只写"要什么特征"**，
 * 由目录里**实际可达的**模型来满足。
 *
 * ## ★★ 2026-10-10 改序：`native` 提到 `ours` 前面（用户要求的 P2-b）
 *
 * **原来的写法把 `ours` 排在前面，理由是"自建接入点优先（额度可控）"** —— 那句话里
 * 藏着一个**不成立的等号**：
 *
 * ```
 * ours  = "我们自己注册的 provider"      ← marksOf 的判据（catalog.ts:128）
 * 额度可控 = "自己搭的、烧的是自己的电"    ← 注释想表达的意思
 * ```
 *
 * 这两个**不是一回事**。反例就是本项目自己：`marksOf` 的默认
 * `oursProviders = ['opencode-go']`（`catalog.ts:151`）——
 * **`opencode-go` 是第三方 API，而用户原话是「GO 额度实际上只有百分之 9」。**
 *
 * ⇒ 按**分数**算一遍（`scoreCandidate` 给 want 里第 i 个标记 `10 - i*2` 分）：
 *
 * | 档位 | 原 `want` | GO（`ours`） | DS（`native`） | 结果 |
 * | :--- | :--- | :--- | :--- | :--- |
 * | L1 | `['ours','free']` | **10** | 0 | ❌ 走 GO |
 * | L2 | `['ours','native']` | **10** | 8 | ❌ 走 GO |
 * | L3 | `['native','ours']` | 8 | **10** | ✅ 走 DS |
 *
 * ⇒ **L1 与 L2 会把每一个轮次都送去那家只剩 9% 的**（而 L3 恰好是对的）。
 * 这正是 `FIX_PLAN.md` §25 里那条警告的具体数字 —— 也是我在 `93fa2f2`
 * 修 failover 时踩过的**同一个坑、同一个方向**。
 *
 * ⇒ 改成 **`native`（DSH 原生 provider，如 `deepseek-official`）一律排在最前**，
 * `ours` 退成兜底。用户的原话就是"**额度路由往 `deepseek-official` 倾**"。
 *
 * ⚠️ **仍然不写死 provider 名** —— 只是换了**特征的优先级**：
 * 将来若真有一个"自建、烧自己的电"的 provider，它该拿 `native`/`account` 这类标记，
 * 而不是靠"名字被列进 `oursProviders`"。
 */
const TIER_PREFERENCE: Record<Tier, { readonly want: readonly string[]; readonly avoid: readonly string[] }> = {
  // L1：闲聊与简单问答 —— 要快。避开贵的/慢的。
  // ★ `free` 保留在末位：真·免费的（本地/免费额度）仍然优先于付费兜底。
  L1: { want: ['native', 'ours', 'free'], avoid: [] },
  // L2：一般任务 —— 要稳。**原生账号优先**（额度是主账户的，见上面那张表）。
  L2: { want: ['native', 'ours'], avoid: [] },
  // L3：复杂任务 —— 要强。原生 + 自建都行（本来就已是 native 在前，未改）。
  L3: { want: ['native', 'ours'], avoid: [] },
}

/** 给一个候选打分（越高越优先）。**纯函数，便于测**。 */
export function scoreCandidate(entry: CatalogEntry, tier: Tier): number {
  const pref = TIER_PREFERENCE[tier]
  let score = 0
  for (const mark of pref.want) {
    if (entry.marks.includes(mark as never)) score += 10 - pref.want.indexOf(mark) * 2
  }
  for (const mark of pref.avoid) {
    if (entry.marks.includes(mark as never)) score -= 20
  }
  // 可达是**硬门槛**，这里只是兜底（调用方已经过滤过）
  if (!entry.reachable) score -= 1000
  return score
}

/** 从目录里挑一个（按档位偏好）。**可达性是真门槛**。 */
export function pickModel(
  catalog: ModelCatalog,
  tier: Tier,
  exclude: readonly string[] = [],
): { readonly entry: CatalogEntry; readonly alternatives: readonly RouteCandidate[] } | undefined {
  const usable = catalog.entries.filter(
    (e) => e.reachable && !exclude.includes(e.provider + '/' + e.model),
  )
  if (usable.length === 0) return undefined

  const ranked = [...usable].sort((a, b) => {
    const d = scoreCandidate(b, tier) - scoreCandidate(a, tier)
    if (d !== 0) return d
    // 同分时**按坐标排序**，保证结果稳定（否则测试会飘）
    return (a.provider + '/' + a.model).localeCompare(b.provider + '/' + b.model)
  })

  const best = ranked[0]
  if (best === undefined) return undefined
  const alternatives = ranked.slice(1).map((e) => ({ provider: e.provider, model: e.model, marks: e.marks }))
  return { entry: best, alternatives }
}

/** 定档（守卫 → 预评分 → 启发式）。 */
export function decideTier(
  turnText: string,
  options: {
    readonly guardContext?: GuardContext
    readonly preScore?: PreScore
    /** 预评分的置信度下限（低于它就不采信）。 */
    readonly preScoreMinConfidence?: number
  } = {},
): { readonly tier: Tier; readonly source: TierSource; readonly why: string } {
  // ① 守卫（零成本，先跑）
  const verdict = runGuards(turnText, options.guardContext ?? {})
  if (verdict.tier !== undefined) {
    // GuardVerdict 的字段是 `rule` / `rationale`（没有 `reason` —— 别照感觉写）
    const who = verdict.rule === undefined ? '（未记规则名）' : verdict.rule
    return {
      tier: verdict.tier,
      source: 'guard',
      why: '守卫命中规则 ' + who + (verdict.rationale === undefined ? '' : '：' + verdict.rationale),
    }
  }

  // ② minimum 小模型预评分（如果调用方给了）
  const minConf = options.preScoreMinConfidence ?? 0.6
  if (options.preScore !== undefined && options.preScore.confidence >= minConf) {
    return {
      tier: options.preScore.tier,
      source: 'pre-score',
      why: 'minimum 评分（置信度 ' + options.preScore.confidence.toFixed(2) + '）' +
        (options.preScore.reason === undefined ? '' : '：' + options.preScore.reason),
    }
  }

  // ③ 启发式兜底（一定给得出答案）
  const score = heuristicScore({ text: turnText })
  const tier = heuristicTier({ text: turnText })
  return {
    tier,
    source: 'heuristic',
    why: '启发式兜底：分数 ' + score.score.toFixed(2) + ' ⇒ ' + tier +
      (options.preScore === undefined ? '（minimum 未启用）' : '（minimum 置信度不足，不信它）'),
  }
}

/**
 * 一轮开始前的初始路由。
 *
 * @param input.turnText - **轮次输入**（用户这一轮说的话）。
 * @param input.catalog - **模型表 + 可达性**。
 * @param input.guardContext - 守卫要的额外信号（可选）。
 * @param input.preScore - `minimum` 的预评分（没接就是 `undefined`）。
 */
export function initialRoute(input: {
  readonly turnText: string
  readonly catalog: ModelCatalog
  readonly guardContext?: GuardContext
  readonly preScore?: PreScore
  readonly preScoreMinConfidence?: number
}): InitialRouteDecision | undefined {
  const decided = decideTier(input.turnText, {
    ...(input.guardContext === undefined ? {} : { guardContext: input.guardContext }),
    ...(input.preScore === undefined ? {} : { preScore: input.preScore }),
    ...(input.preScoreMinConfidence === undefined ? {} : { preScoreMinConfidence: input.preScoreMinConfidence }),
  })

  const picked = pickModel(input.catalog, decided.tier)
  if (picked === undefined) {
    return undefined
  }

  const effort = TIER_EFFORT[decided.tier] ?? 'low'
  return {
    tier: decided.tier,
    tierSource: decided.source,
    provider: picked.entry.provider,
    model: picked.entry.model,
    reasoningEffort: effort,
    why: decided.why + ' ⇒ 选 ' + picked.entry.provider + '/' + picked.entry.model +
      '（强度 ' + effort + '，' + String(picked.alternatives.length) + ' 个备选）',
    alternatives: picked.alternatives,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO（用户 2026-10-08 明确要求，**尚未接**）：
//
//   ② **minimum 小模型评分** —— 部署 Qwen2.5-0.5B（GGUF Q4）后，
//      用 `renderCatalogForPrompt(catalog)` 当上下文、`turnText` 当问题，
//      让它输出档位 + 置信度，作为 `preScore` 传进来。
//      ★ **它只需要这三样**（轮次输入 / 模型表 / 可达性），**不吃全部上下文**。
//
//   ④ **工具**：
//      - 主模型**自助切换**（`switch_model` 要真的落到 `ModelSelectionRef.current`）
//      - 主模型**决定用哪个模型分派子代理**
//      - 允许主模型**在本轮结束时建议下次用什么模型**
//
//   ⇒ 接线点：`packages/dsh-component/src/index.ts` 里
//     `ctx.get('agent')` / `ModelSelectionRef.current`。
// ─────────────────────────────────────────────────────────────────────────────
