/**
 * 子代理模型分配（EXECUTION_PLAN §2.7.3，阶段 5 交付物 9）。
 *
 * ## 三条宿主事实决定了做法
 *
 * ① 子代理**可以**单独指定模型：`ctx.subagents.start(name, { agentOptions })`；
 * ② 工具层的 `provider/model` 参数只在开了 `modelSelectionSettings` 且有白名单时才出现
 *    ⇒ 我们**走程序化 `agentOptions`，不靠模型自选**（自选会带来不确定性）；
 * ③ **`reasoningEffort` 不是固定枚举**：它由 adapter 按具体模型声明
 *    （deepseek 是 `off/low/high/max`，pi-ai 是 `off/minimal/low/medium/high/xhigh/max`）
 *    ⇒ **绝不硬编码档位值**，从模型信息里取合法集合，取不到就不传。
 *
 * ## 为什么要"与主对话异构"
 *
 * 子代理如果和主模型是同一个，那它就只是"同一张嘴换个说法"，
 * 拿不到独立视角 —— 而独立视角正是委派子代理的主要价值。
 * 所以默认策略是：**尽量选与主模型不同的 provider/model**（同价位的另一个），
 * 实在只有一个可用模型时才退回同模型，并把这件事记下来。
 *
 * @module @forlife/router/subagents
 */
import type { RouteEntry, RouteRole } from './routes.ts'
import { selectRoute } from './routes.ts'

/** 子代理角色（按任务性质分，不按模型分）。 */
export type SubagentRole =
  | 'retrieval' // 检索/查资料
  | 'archival' // 归档/整理
  | 'formatting' // 格式化/改写
  | 'planning' // 规划/拆解
  | 'review' // 复盘/审查
  | 'compaction' // 压缩摘要
  | 'vision' // 视觉桥接

/** 全部子代理角色。 */
export const SUBAGENT_ROLES: readonly SubagentRole[] = ['retrieval', 'archival', 'formatting', 'planning', 'review', 'compaction', 'vision']

/** 角色 → 用哪个档位的模型（"便宜/强"的判断只在这里做一次）。 */
export const ROLE_TIER: Readonly<Record<SubagentRole, RouteRole>> = {
  // 这三类是"搬运/整理"型工作：不需要推理深度，用便宜模型
  retrieval: 'L1',
  archival: 'L1',
  formatting: 'L1',
  // 这三类是"要想清楚"型工作：用强模型（想错的代价远大于 token 费）
  planning: 'L3',
  review: 'L3',
  compaction: 'L3',
  // 视觉桥接必须用视觉模型
  vision: 'vision',
}

/** 角色的用途说明（面板展示，也让人理解"为什么这个角色用便宜模型"）。 */
export const ROLE_PURPOSE: Readonly<Record<SubagentRole, string>> = {
  retrieval: '检索资料：把找到的东西搬回来，不需要推理深度',
  archival: '归档整理：按格式归置，不需要判断',
  formatting: '格式化改写：机械变换',
  planning: '规划拆解：想错了代价很大，用强模型',
  review: '复盘审查：要能发现自己的问题，弱模型往往发现不了',
  compaction: '压缩摘要：摘要质量直接影响记忆，必须强模型',
  vision: '视觉桥接：必须用声明了 image 能力的模型',
}

/** 子代理的模型选项（对齐宿主 `AgentOptions` 的字段名）。 */
export interface SubagentAgentOptions {
  readonly provider: string
  readonly model: string
  /** **只在模型声明了合法集合时才给**（不硬编码档位值）。 */
  readonly reasoningEffort?: string
}

/** 分配结果。 */
export interface SubagentAssignment {
  readonly role: SubagentRole
  readonly options: SubagentAgentOptions
  /** 用的哪条路由（含降级信息）。 */
  readonly routeRank: number
  /** 是否与主模型异构（验收项：子代理与主模型不同时，日志可区分）。 */
  readonly heterogeneous: boolean
  /** 说明（进日志与面板）。 */
  readonly note: string
  /** 有没有出问题（例如只有一个可用模型）。 */
  readonly warning?: string
}

/** 模型能力查询（宿主 `resolveModelInfo` 的瘦身接口）。 */
export interface ModelInfoLike {
  readonly reasoningEfforts?: readonly string[]
  readonly defaultEffort?: string
  readonly image?: boolean
}

/** 分配输入。 */
export interface AssignmentContext {
  /** 全部路由（有序表）。 */
  readonly routes: readonly RouteEntry[]
  /** 主对话当前用的 provider/model。 */
  readonly mainModel: { readonly provider: string; readonly model: string }
  /** 查模型能力（取 reasoningEffort 合法集合）。 */
  readonly modelInfo?: (provider: string, model: string) => ModelInfoLike | undefined
  /** 不可用的 provider。 */
  readonly unavailable?: readonly string[]
}

/**
 * 给一个子代理角色分配模型。
 *
 * @param role - 角色。
 * @param context - 路由表与主模型信息。
 * @returns 分配结果；找不到可用路由时返回 undefined。
 */
export function assignSubagent(role: SubagentRole, context: AssignmentContext): SubagentAssignment | undefined {
  const tierRole = ROLE_TIER[role]

  // 优先选"与主模型异构"的候选：这样才拿得到独立视角。
  // 做法是在同角色的候选里先挑不同 provider/model 的，挑不到再退回第一个可用的。
  const candidates = context.routes.filter((entry) => entry.role === tierRole)
  const heterogeneousCandidates = candidates.filter(
    (entry) => entry.provider !== context.mainModel.provider || entry.model !== context.mainModel.model,
  )

  let selection = selectRoute(heterogeneousCandidates.length > 0 ? heterogeneousCandidates : candidates, {
    unavailable: context.unavailable ?? [],
  })
  let heterogeneous = selection !== undefined && (selection.entry.provider !== context.mainModel.provider || selection.entry.model !== context.mainModel.model)
  let warning: string | undefined

  if (selection === undefined && heterogeneousCandidates.length > 0) {
    // 异构候选都不可用 ⇒ 退回同模型的候选（仍要好过"没有模型"）
    selection = selectRoute(candidates, { unavailable: context.unavailable ?? [] })
    heterogeneous = false
    warning = '没有可用的异构候选，退回与主模型相同的模型 —— 这样拿不到独立视角（建议再加一个同档位的备选）'
  }
  if (selection !== undefined && heterogeneousCandidates.length === 0) {
    // **根本不存在异构候选**（这一档只有主模型那一条）：
    // 第一版这里什么都没说 —— 那就是"静默退化"，而这个模块的全部意义
    // 就是让"子代理和主模型是同一个"这件事**显式可见**。
    warning = '这一档只有主模型这一个候选：子代理与主模型相同，拿不到独立视角（建议给该档位加一个同价位的备选模型）'
  }
  if (selection === undefined) return undefined

  const info = context.modelInfo?.(selection.entry.provider, selection.entry.model)
  // reasoningEffort 必须来自模型声明的合法集合；取不到就不传（硬编码会让请求被拒或静默忽略）
  const legalEfforts = info?.reasoningEfforts
  const desired = selection.entry.reasoningEffort
  const reasoningEffort =
    legalEfforts === undefined || desired === undefined
      ? undefined
      : legalEfforts.includes(desired)
        ? desired
        : undefined

  const noteBits = [`角色 ${role} ⇒ 档位 ${tierRole}`, `${selection.entry.provider}/${selection.entry.model}`]
  if (selection.degraded) noteBits.push(`（降级到第 ${String(selection.rank + 1)} 个候选）`)
  if (heterogeneous) noteBits.push('与主模型异构')
  if (desired !== undefined && reasoningEffort === undefined) {
    noteBits.push(legalEfforts === undefined ? '（未取到推理强度合法集合，不传该参数）' : `（${desired} 不在该模型的合法集合里，不传）`)
  }

  return {
    role,
    options: {
      provider: selection.entry.provider,
      model: selection.entry.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    routeRank: selection.rank,
    heterogeneous,
    note: noteBits.join('，'),
    ...(warning === undefined ? {} : { warning }),
  }
}

/**
 * 批量分配全部角色（面板的"角色映射"一次算清）。
 *
 * @param context - 上下文。
 * @returns 每个角色的分配（分不到的角色值为 undefined）。
 */
export function assignAll(context: AssignmentContext): readonly (SubagentAssignment | undefined)[] {
  return SUBAGENT_ROLES.map((role) => assignSubagent(role, context))
}

/**
 * 子代理不得自切 —— 在**分配**这一侧再堵一次。
 *
 * 为什么两道：工具不存在挡住"模型想调"，运行时断言挡住"代码路径绕过去"。
 * 这里的第三道是：子代理的模型**由分配决定**，运行期不允许再改。
 *
 * @param input - 运行期试图改模型的信息。
 * @throws 当运行期试图给子代理换模型时。
 */
export function assertNoRuntimeModelChange(input: {
  readonly isSubagent: boolean
  readonly assigned: { readonly provider: string; readonly model: string }
  readonly requested: { readonly provider: string; readonly model: string }
}): void {
  if (!input.isSubagent) return
  if (input.assigned.provider === input.requested.provider && input.assigned.model === input.requested.model) return
  throw new Error(
    `子代理不得在运行期更换模型（分配的是 ${input.assigned.provider}/${input.assigned.model}，` +
      `请求的是 ${input.requested.provider}/${input.requested.model}）。` +
      '子代理的"我是不是该换个模型"判断不可信，而且换模型的代价由主对话承担。请让主代理决定。',
  )
}

