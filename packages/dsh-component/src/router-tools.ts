/**
 * 路由与切换的模型工具（EXECUTION_PLAN §2.18，阶段 5 交付物 10）。
 *
 * ## `switch_model` 的定位：**最后手段**
 *
 * 提示词里写明了"切换贵于委派"：换模型会作废已积累的上下文缓存，
 * 还会让对话的语气与判断标准突然变化。所以这个工具：
 *  - **必须给理由**（理由太短直接拒 —— 那看起来像随手切的）；
 *  - 受**冷却**与**每小时预算**限制；
 *  - 写 `routing_log`（谁、为什么、从哪档到哪档）；
 *  - 覆盖是**可撤销**的（`revert_model` 回到档位自动判定）。
 *
 * ## 子代理不得自切
 *
 * 三道防线（工具不存在 / 运行时断言 / 分配决定）在 `@forlife/router` 里；
 * 这里是**第一道**：这些工具根本不会注册到子代理的上下文里，
 * 而且即便被调用，`assertNotSubagentSwitch` 也会抛。
 *
 * @module forlife-memory/router-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { defaultFor } from '@forlife/contracts'
import { assertNotSubagentSwitch, decideSwitch, defaultSwitchPolicy, escalate, ROUTE_ROLES, type Tier } from '@forlife/router'

import type { MemoryRuntime, TierOverride } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 文本结果。 */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 路由工具的名单（测试与文档共用）。 */
export const ROUTER_TOOL_NAMES = ['switch_model', 'revert_model', 'router_status'] as const


/**
 * 构造路由相关工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时。
 * @param options - 调用者身份（子代理不注册这些工具）。
 * @returns 工具定义数组，或空数组（子代理）。
 */
export function buildRouterTools(
  defineTool: DefineToolLike,
  runtime: MemoryRuntime,
  options: { readonly isSubagent?: boolean } = {},
): readonly unknown[] {
  // 第一道防线：子代理**根本没有**这些工具（模型想调也调不到）
  if (options.isSubagent === true) return []

  const switchTool = defineTool({
    name: 'switch_model',
    description: [
      '切换到更强的模型档位（**最后手段**）。',
      '遇到难题时请**优先委派子代理**去做（检索、整理、独立分析），而不是换模型：',
      '换模型会作废已积累的上下文缓存，还会让对话的语气与判断标准突然变化。',
      '只有在"这个任务确实超出你的能力"且"委派也解决不了"时才用。',
      '必须说明理由；受冷却与每小时预算限制；可以随时用 revert_model 撤销。',
    ].join('\n'),
    parameters: {
      tier: { type: 'string', enum: ['L2', 'L3'], required: true, description: '目标档位（只能往上，不能往下）。' },
      reason: { type: 'string', required: true, description: '为什么必须换（要具体：是哪种能力不够）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tier: { type: 'string', description: '切换后生效的档位。' },
          note: { type: 'string', required: true },
          remainingBudget: { type: 'integer' },
          cooldownRemainingMs: { type: 'integer' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; tier?: string; note: string }
        return text(v.ok ? `已切到 ${v.tier ?? '?'}：${v.note}` : `没有切换：${v.note}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { tier: Tier; reason: string }
      runtime.recordToolCall()
      // 第二道防线：子代理即便调到了也过不去
      assertNotSubagentSwitch({ isSubagent: false })
      return applySwitch(runtime, a.tier, a.reason)
    },
  })

  const revertTool = defineTool({
    name: 'revert_model',
    description: '撤销之前的 switch_model，回到"由档位自动判定"的状态。换完发现没必要、或者问题解决了，就用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => text((value as { note: string }).note),
    },
    execute: async (): Promise<unknown> => {
      runtime.recordToolCall()
      const previous = runtime.tierOverride()
      runtime.clearTierOverride()
      if (previous === undefined) return { ok: false, note: '当前没有手动切换过档位，无需撤销。' }
      runtime.log(`已撤销档位覆盖（原为 ${previous.tier}：${previous.reason}）`)
      return { ok: true, note: `已撤销（原为 ${previous.tier}）。之后的档位回到自动判定。` }
    },
  })

  const statusTool = defineTool({
    name: 'router_status',
    description: '看当前的路由状态：生效档位、是不是手动切的、各角色的模型分配、最近的降级情况。排查"为什么这次答得不一样"时有用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tier: { type: 'string', required: true },
          source: { type: 'string', required: true, description: 'auto = 档位自动判定；override = 手动切换。' },
          reason: { type: 'string' },
          routes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                effort: { type: 'string' },
                enabled: { type: 'boolean' },
              },
            },
          },
          recentDegraded: { type: 'integer', required: true, description: '最近 24 小时降级次数。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { tier: string; source: string; recentDegraded: number }
        return text(`当前档位 ${v.tier}（${v.source === 'override' ? '手动切换' : '自动判定'}）｜近 24h 降级 ${String(v.recentDegraded)} 次`)
      },
    },
    execute: async (): Promise<unknown> => {
      const override = runtime.tierOverride()
      const stats = runtime.routingStats24h()
      return {
        ok: true,
        tier: override?.tier ?? 'L2',
        source: override === undefined ? 'auto' : 'override',
        ...(override === undefined ? {} : { reason: override.reason }),
        routes: runtime.listModelRoutes().map((route: { role: string; provider: string; model: string; reasoning_effort: string | null; enabled: number }) => ({
          role: route.role,
          provider: route.provider,
          model: route.model,
          ...(route.reasoning_effort === null ? {} : { effort: route.reasoning_effort }),
          enabled: route.enabled === 1,
        })),
        recentDegraded: stats.degraded,
      }
    },
  })

  return [switchTool, revertTool, statusTool]
}

/**
 * 应用一次档位切换（工具与面板都走这里，保证规则一致）。
 *
 * @param runtime - 运行时。
 * @param tier - 目标档位。
 * @param reason - 理由。
 * @returns 结果。
 */
export function applySwitch(runtime: MemoryRuntime, tier: Tier, reason: string): {
  readonly ok: boolean
  readonly tier?: string
  readonly note: string
  readonly remainingBudget: number
  readonly cooldownRemainingMs: number
} {
  const current = runtime.tierOverride()
  // 只能往上：往下切不叫"需要更强"，那是省成本，应该由档位自动判定去做
  if (current !== undefined && (current.tier === 'L3' || tier === current.tier)) {
    return {
      ok: false,
      note:
        current.tier === tier
          ? `已经在 ${tier} 档了（${current.reason}）。`
          : '已经是最高档，不能更高。',
      remainingBudget: defaultFor<number>('router.switch.perHour'),
      cooldownRemainingMs: 0,
    }
  }

  const policy = defaultSwitchPolicy()
  const verdict = decideSwitch({ at: new Date(), reason }, runtime.recentSwitches(), policy)
  if (!verdict.approved) {
    runtime.recordRoutingDecision({
      tier,
      source: 'switch-refused',
      confidence: 1,
      latencyMs: 0,
      switched: false,
      switchReason: reason,
      note: verdict.reason,
    })
    return { ok: false, note: verdict.reason, remainingBudget: verdict.remainingBudget, cooldownRemainingMs: verdict.cooldownRemainingMs }
  }

  const applied = current === undefined ? tier : escalate(current.tier)
  runtime.setTierOverride({ tier: applied, reason, at: new Date().toISOString(), actor: 'model' })
  runtime.recordRoutingDecision({
    tier: applied,
    source: 'switch',
    confidence: 1,
    latencyMs: 0,
    switched: true,
    switchReason: reason,
    note: `按模型请求切换（理由：${reason}）`,
  })
  runtime.log(`模型请求切换档位 → ${applied}（理由：${reason}）`)
  return {
    ok: true,
    tier: applied,
    note: `已切到 ${applied}。换模型会作废已积累的上下文缓存，所以之后尽量一次把事做完；不需要了就 revert_model。`,
    remainingBudget: verdict.remainingBudget,
    cooldownRemainingMs: 0,
  }
}

/** 角色清单（面板渲染用；放在这里避免面板硬编码）。 */
export { ROUTE_ROLES as ROUTER_ROLES }


