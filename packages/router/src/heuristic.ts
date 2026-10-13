/**
 * 启发式兜底（模型路由.MD §5.4 第三层）。
 *
 * 「启发式不再作为主路径，只是**降级保护**。」——所以这里的唯一职责是：
 * 当 L1 评分模型超时/崩溃/显存不足时，**给出一个不阻塞主流程**的答案。
 *
 * 权重与阈值全部从保真度基线取（`router.heuristic.*`），不在这里硬编码 ——
 * 那是"一比一实现"的强制点。
 *
 * @module @forlife/router/heuristic
 */
import { defaultFor } from '@forlife/contracts'

import type { Tier } from './guards.ts'

/** 启发式输入。 */
export interface HeuristicInput {
  readonly text: string
  /** 估算的工具链长度（步数）。 */
  readonly estimatedToolChain?: number
}

/** 规划类关键词（中文与英文都认）。 */
const PLANNING_KEYWORDS = [
  '设计',
  '架构',
  '方案',
  '规划',
  '为什么',
  '分析',
  '对比',
  '权衡',
  '重构',
  '优化',
  '排查',
  '调试',
  '实现',
  '写一个',
  '帮我写',
  '怎么做到',
  '如何实现',
  'plan',
  'design',
  'architect',
  'why',
  'analyze',
  'compare',
  'tradeoff',
  'refactor',
  'debug',
]

/** 是否含规划类关键词。 */
export function hasPlanningKeywords(text: string): boolean {
  const lower = text.toLowerCase()
  return PLANNING_KEYWORDS.some((keyword) => lower.includes(keyword))
}

/** 是否含代码块（三反引号或缩进代码）。 */
export function hasCodeBlock(text: string): boolean {
  return /```/.test(text) || /(?:^|\n)(?: {4}|\t)\S/.test(text)
}

/** 逐项打分明细（可解释：复盘时要能看清"为什么落到这一档"）。 */
export interface HeuristicScore {
  readonly score: number
  readonly tier: Tier
  readonly parts: readonly { readonly name: string; readonly value: number }[]
}

/**
 * 启发式评分（< 1ms）。
 *
 * 公式逐项对应模型路由.MD §5.4：
 * ```
 * score += 0.25 if 含规划关键词
 * score += 0.20 if 含代码块
 * score += 0.15 * min(len/2000, 1)
 * score += 0.20 if 工具链 > 3
 * < 0.35 → L1 ；< 0.70 → L2 ；否则 L3
 * ```
 *
 * @param input - 输入。
 * @returns 分数、明细与档位。
 */
export function heuristicScore(input: HeuristicInput): HeuristicScore {
  const wPlanning = defaultFor<number>('router.heuristic.wPlanning')
  const wCode = defaultFor<number>('router.heuristic.wCode')
  const wLength = defaultFor<number>('router.heuristic.wLength')
  const wToolChain = defaultFor<number>('router.heuristic.wToolChain')
  const thresholdL1 = defaultFor<number>('router.heuristic.thresholdL1')
  const thresholdL2 = defaultFor<number>('router.heuristic.thresholdL2')

  const length = [...input.text].length
  const planning = hasPlanningKeywords(input.text) ? wPlanning : 0
  const code = hasCodeBlock(input.text) ? wCode : 0
  // 长度项是**连续**的：越长的消息越可能复杂，但封顶（避免"话多=难"的荒谬推断）
  const lengthScore = wLength * Math.min(length / 2000, 1)
  const toolChain = (input.estimatedToolChain ?? 0) > 3 ? wToolChain : 0

  const score = planning + code + lengthScore + toolChain
  return {
    score,
    tier: score < thresholdL1 ? 'L1' : score < thresholdL2 ? 'L2' : 'L3',
    parts: [
      { name: '规划关键词', value: planning },
      { name: '代码块', value: code },
      { name: '长度', value: lengthScore },
      { name: '工具链', value: toolChain },
    ],
  }
}

/** 只要档位（便捷）。 */
export function heuristicTier(input: HeuristicInput): Tier {
  return heuristicScore(input).tier
}
