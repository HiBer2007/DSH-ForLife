/**
 * 诊断数据：把 `@forlife/contracts` 的保真度基线汇总成可打印/可断言的一行结论。
 *
 * 之所以单独一层：宿主（facet / legacy 入口 / doctor 脚本）都要用同一份摘要，
 * 避免三处各写一遍统计逻辑而慢慢走样。
 *
 * @module forlife-memory/diagnostics
 */
import {
  DEVIATIONS,
  RULE_DEVIATIONS,
  baselineKeys,
  baselineOrigin,
  baselineTimings,
  loadBaseline,
  pendingBaselineKeys,
} from '@forlife/contracts'

/** 基线摘要。 */
export interface ContractsSummary {
  readonly baselineVersion: string
  readonly paramCount: number
  readonly docCount: number
  readonly designCount: number
  readonly timingCount: number
  readonly pendingCount: number
  readonly deviationCount: number
  readonly ruleDeviationCount: number
  readonly documents: readonly string[]
}

/** 生成基线摘要。 */
export function contractsSummary(): ContractsSummary {
  const baseline = loadBaseline()
  const keys = baselineKeys()
  const docCount = keys.filter((key) => baselineOrigin(key) === 'doc').length
  return {
    baselineVersion: baseline.meta.baselineVersion,
    paramCount: keys.length,
    docCount,
    designCount: keys.length - docCount,
    timingCount: baselineTimings().length,
    pendingCount: pendingBaselineKeys().length,
    deviationCount: DEVIATIONS.length,
    ruleDeviationCount: RULE_DEVIATIONS.length,
    documents: baseline.meta.documents,
  }
}
