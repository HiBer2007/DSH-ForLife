/**
 * 路由表与切换策略（EXECUTION_PLAN §2.18，阶段 5 交付物 10）。
 *
 * ## 三个概念要分清
 *
 * | 概念 | 是什么 | 谁决定 |
 * | :--- | :--- | :--- |
 * | **档位**（L1/L2/L3） | "需要多强的脑子" | 路由流水线（守卫/评分器） |
 * | **路由**（route） | "这一档具体用哪个 provider+model" | 本文件的有序表 |
 * | **切换**（switch） | 运行中改档位 | 只有主代理能，且要理由+冷却+预算 |
 *
 * ## 有序表 + 自动降级
 *
 * 每一档是一条**有序**的候选列表：主模型没额度了、挂了，就按序用下一个，
 * 每一步都落 `routing_log`。「失败/无额度按序自动降级」是验收项，
 * 所以这里刻意把"降级"做成表驱动的**顺序推进**，而不是散落各处的 if。
 *
 * ## 为什么"轮次内锁定"必须单独一个机制
 *
 * 一轮对话里模型可能被调用多次（多步）。如果每一步都重新路由，就会出现
 * "前半句用强模型、后半句用弱模型"的语气断裂（§8.6 轮次内不换模型）。
 * 但"锁定"又极易变成**粘性**：一旦锁住就再也换不回来，后面所有轮次都用错档位。
 * 所以设计成：**轮次内锁定**（lockDuringTurn）+ **每轮开始时重新断言**（re-assert）——
 * 两者缺一不可，测试里各有一条盯着。
 *
 * @module @forlife/router/routes
 */
import { defaultFor } from '@forlife/contracts'

import type { Tier } from './guards.ts'
import { escalate } from './pipeline.ts'
import type { ReasoningEffort } from '@forlife/contracts'

/** 角色：档位 + 专用模型（视觉/嵌入/评分器/子代理）。 */
export type RouteRole = Tier | 'vision' | 'embedding' | 'minimum' | 'subagent'

/** 全部角色（面板的角色映射编辑器按这个列表渲染）。 */
export const ROUTE_ROLES: readonly RouteRole[] = ['L1', 'L2', 'L3', 'vision', 'embedding', 'minimum', 'subagent']

/** 一条路由（有序表的一行）。 */
export interface RouteEntry {
  readonly role: RouteRole
  /** 序号：同一 role 内越小越优先。 */
  readonly rank: number
  readonly provider: string
  readonly model: string
  /** 推理强度（强模型的"想多久"）。 */
  readonly reasoningEffort?: ReasoningEffort
  /** 关掉的条目不参与选择（但保留在表里，便于回滚）。 */
  readonly enabled?: boolean
  /** 这一条的说明（面板展示"为什么留着它"）。 */
  readonly note?: string
}

/** 选择结果。 */
export interface RouteSelection {
  readonly entry: RouteEntry
  /** 用到了第几个候选（0 = 主选）。 */
  readonly rank: number
  /** 是否发生了降级（rank > 0）。 */
  readonly degraded: boolean
  /** 前几个候选为什么被跳过（进 routing_log）。 */
  readonly skipped: readonly { readonly provider: string; readonly model: string; readonly reason: string }[]
}

/** 选择输入。 */
export interface SelectionContext {
  /** 已被判定"不可用"的 provider（无额度、连续失败）。 */
  readonly unavailable?: readonly string[]
  /** 已被判定不健康的 provider（健康检查失败）。 */
  readonly unhealthy?: readonly string[]
}

/**
 * 按序选一条路由（失败/不可用就往后走）。
 *
 * @param entries - 该角色的候选（顺序无关，按 rank 排序）。
 * @param context - 不可用/不健康集合。
 * @returns 选择结果；全不可用时 undefined（调用方要把它当成"这一档没有可用模型"）。
 */
export function selectRoute(entries: readonly RouteEntry[], context: SelectionContext = {}): RouteSelection | undefined {
  const unavailable = new Set(context.unavailable ?? [])
  const unhealthy = new Set(context.unhealthy ?? [])
  const ordered = entries.filter((entry) => entry.enabled !== false).sort((a, b) => a.rank - b.rank)

  const skipped: { provider: string; model: string; reason: string }[] = []
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]
    if (entry === undefined) continue
    if (unavailable.has(entry.provider)) {
      skipped.push({ provider: entry.provider, model: entry.model, reason: '无额度或连续失败' })
      continue
    }
    if (unhealthy.has(entry.provider)) {
      skipped.push({ provider: entry.provider, model: entry.model, reason: '健康检查未通过' })
      continue
    }
    return { entry, rank: index, degraded: index > 0, skipped }
  }
  return undefined
}

/**
 * 档位 → 路由 的映射（§2.18）。
 *
 * `reasoningEffort` 按档位递增：弱模型不需要"想很久"，强模型的多想一会儿值回票价。
 * 这个映射可以在面板里改（角色映射编辑器），所以默认值只作为**起点**。
 *
 * @param options - provider/model 三元组（来自配置）。
 * @returns 各角色的默认路由。
 */
export function defaultRouteEntries(options: {
  readonly l1: { provider: string; model: string }
  readonly l2: { provider: string; model: string }
  readonly l3: { provider: string; model: string }
  readonly vision?: { provider: string; model: string }
  readonly embedding?: { provider: string; model: string }
  readonly scorer?: { provider: string; model: string }
  readonly subagent?: { provider: string; model: string }
}): readonly RouteEntry[] {
  const entries: RouteEntry[] = [
    { role: 'L1', rank: 0, ...options.l1, reasoningEffort: 'low', note: '闲聊与简单问答' },
    { role: 'L2', rank: 0, ...options.l2, reasoningEffort: 'high', note: '一般任务' },
    { role: 'L3', rank: 0, ...options.l3, reasoningEffort: 'max', note: '复杂任务（架构/长链推理）' },
  ]
  if (options.vision !== undefined) entries.push({ role: 'vision', rank: 0, ...options.vision, note: '看图（必须声明 image 能力）' })
  if (options.embedding !== undefined) entries.push({ role: 'embedding', rank: 0, ...options.embedding, note: '向量（必须给维度）' })
  if (options.scorer !== undefined) entries.push({ role: 'minimum', rank: 0, ...options.scorer, reasoningEffort: 'low', note: '复杂度评分器' })
  if (options.subagent !== undefined) entries.push({ role: 'subagent', rank: 0, ...options.subagent, note: '子代理（与主对话异构）' })
  return entries
}

// ── 轮次内锁定 + 每轮重新断言 ──────────────────────────────────────────────

/** 一轮内的路由状态。 */
export interface TurnRouteState {
  readonly turnId: string
  readonly tier: Tier
  /** 这一轮里实际用的路由（后续 step 都用它）。 */
  readonly selection: RouteSelection
  /** 这一轮里是否发生过切换（切换要留痕，也要计入冷却与预算）。 */
  readonly switched: boolean
}

/**
 * 轮次内锁定：**同一轮里不允许换档位**（§8.6 轮次内不换模型）。
 *
 * @param locked - 已锁定的状态（没有则这一轮尚未开始）。
 * @param requested - 这次想要用的档位。
 * @returns 实际应当使用的档位，以及是否发生了"被拒绝的切换"。
 */
export function lockTierForTurn(
  locked: Tier | undefined,
  requested: Tier,
): { readonly tier: Tier; readonly locked: boolean; readonly refusedSwitch: boolean } {
  if (locked === undefined) return { tier: requested, locked: false, refusedSwitch: false }
  return { tier: locked, locked: true, refusedSwitch: locked !== requested }
}

/**
 * 每轮开始时**重新断言**档位（防粘性基线）。
 *
 * 这条与"轮次内锁定"是一对：锁定防止一轮内漂移，重断言防止锁定变成永久。
 * 只锁不重断言 ⇒ 一旦某轮判成 L3，之后所有轮次都粘在 L3（成本悄悄翻倍而没人发现）。
 *
 * @param decided - 本轮路由流水线判出来的档位。
 * @param options - 上限与降级开关（管理员可以把档位钉住，那是显式行为）。
 * @returns 本轮生效的档位与说明。
 */
export function assertTierForTurn(
  decided: Tier,
  options: { readonly pinned?: Tier; readonly maxTier?: Tier } = {},
): { readonly tier: Tier; readonly note?: string } {
  if (options.pinned !== undefined) {
    return { tier: options.pinned, note: `管理员把档位钉在 ${options.pinned}（显式覆盖，不是粘性）` }
  }
  if (options.maxTier !== undefined) {
    const order: readonly Tier[] = ['L1', 'L2', 'L3']
    const decidedIndex = order.indexOf(decided)
    const maxIndex = order.indexOf(options.maxTier)
    if (decidedIndex > maxIndex) {
      return { tier: options.maxTier, note: `上限设为 ${options.maxTier}，已从 ${decided} 降下来（省成本）` }
    }
  }
  return { tier: decided }
}

// ── 自研回退链 ─────────────────────────────────────────────────────────────

/** 回退链状态（跨 step 保留：同一步内不重复撞同一个坏 provider）。 */
export interface FallbackState {
  /** provider → 连续失败次数。 */
  readonly failures: Readonly<Record<string, number>>
  /** 已被判定"这一轮别再用"的 provider。 */
  readonly exhausted: readonly string[]
}

/** 空白回退状态。 */
export function emptyFallbackState(): FallbackState {
  return { failures: {}, exhausted: [] }
}

/**
 * 记一次失败并按阈值判定是否要把该 provider 排除。
 *
 * @param state - 当前状态。
 * @param provider - 失败的 provider。
 * @returns 新状态与是否刚刚被排除（后者用于日志与"换路由"事件）。
 */
export function recordRouteFailure(state: FallbackState, provider: string): { readonly state: FallbackState; readonly newlyExhausted: boolean } {
  const threshold = defaultFor<number>('router.fallback.failuresBeforeSwitch')
  const failures = { ...state.failures, [provider]: (state.failures[provider] ?? 0) + 1 }
  const count = failures[provider] ?? 0
  const newlyExhausted = count >= threshold && !state.exhausted.includes(provider)
  return {
    state: { failures, exhausted: newlyExhausted ? [...state.exhausted, provider] : state.exhausted },
    newlyExhausted,
  }
}

/** 一次成功的调用要把失败计数清掉（否则"偶发失败攒够阈值"会造成误排除）。 */
export function recordRouteSuccess(state: FallbackState, provider: string): FallbackState {
  const failures = { ...state.failures }
  delete failures[provider]
  return { failures, exhausted: state.exhausted.filter((item) => item !== provider) }
}

/** 切换预算与冷却（§2.18：切换贵于委派，所以要拦住频繁切换）。 */
export interface SwitchPolicy {
  /** 冷却：两次切换之间最少间隔。 */
  readonly cooldownMs: number
  /** 预算：一小时最多切几次。 */
  readonly perHour: number
}

/** 默认切换策略（从基线取）。 */
export function defaultSwitchPolicy(): SwitchPolicy {
  return {
    cooldownMs: defaultFor<number>('router.switch.cooldownMs'),
    perHour: defaultFor<number>('router.switch.perHour'),
  }
}

/** 切换裁决结果。 */
export interface SwitchVerdict {
  readonly approved: boolean
  readonly reason: string
  readonly remainingBudget: number
  readonly cooldownRemainingMs: number
}

/**
 * 裁决一次"换档位"请求（主代理的 `switch_model` 工具走这里）。
 *
 * @param request - 请求时间与理由。
 * @param history - 最近的切换记录（用于冷却与预算）。
 * @param policy - 策略。
 * @returns 裁决。
 */
export function decideSwitch(
  request: { readonly at: Date; readonly reason: string },
  history: readonly { readonly at: string }[],
  policy: SwitchPolicy = defaultSwitchPolicy(),
): SwitchVerdict {
  const at = request.at.getTime()
  const hourAgo = at - 3_600_000
  const recent = history
    .map((item) => Date.parse(item.at))
    .filter((time) => Number.isFinite(time) && time > hourAgo)
    .sort((a, b) => b - a)

  const last = recent[0]
  const cooldownRemainingMs = last === undefined ? 0 : Math.max(0, last + policy.cooldownMs - at)
  const remainingBudget = Math.max(0, policy.perHour - recent.length)

  if (request.reason.trim().length < 4) {
    return { approved: false, reason: '切换必须说明理由（理由太短，看起来像随手切的）', remainingBudget, cooldownRemainingMs }
  }
  if (cooldownRemainingMs > 0) {
    return {
      approved: false,
      reason: `冷却中：距上次切换仅 ${String(Math.round((at - (last ?? at)) / 1000))} 秒，还需等 ${String(Math.round(cooldownRemainingMs / 1000))} 秒`,
      remainingBudget,
      cooldownRemainingMs,
    }
  }
  if (remainingBudget <= 0) {
    return { approved: false, reason: `本小时切换预算已用完（上限 ${String(policy.perHour)} 次）`, remainingBudget, cooldownRemainingMs }
  }
  return { approved: true, reason: `允许切换（本小时还剩 ${String(remainingBudget - 1)} 次）`, remainingBudget: remainingBudget - 1, cooldownRemainingMs: 0 }
}

/**
 * 子代理不得自切（验收项：**工具不存在 + 运行时拒绝**）。
 *
 * 两道防线是刻意的：工具不存在挡住"模型想调"，运行时断言挡住"代码路径绕过去"。
 * 只做前者的话，将来有人把工具注册到子代理上下文里就无声破防了。
 *
 * @param options - 调用者身份与目标档位。
 * @throws 当调用者是子代理时。
 */
export function assertNotSubagentSwitch(options: { readonly isSubagent: boolean; readonly tier?: Tier }): void {
  if (options.isSubagent) {
    throw new Error(
      '子代理不得自行切换模型：子代理的档位由主代理在创建时确定（子代理的"我是不是该换模型"判断不可信，' +
        '而且换模型的代价由主对话承担）。请让主代理决定。',
    )
  }
}

/** 升档辅助（切换时常用）。 */
export { escalate }

