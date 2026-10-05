/**
 * 偏离登记处（**唯一**允许偏离设计文档的地方）。
 *
 * 分两类：
 *  - `DEVIATIONS`：**数值/配置**偏离（针对 `doc` 来源的基线参数）。目前为**空**，说明
 *    PLAN.MD / 模型路由.MD 里的每个可调项都按原值实现；
 *  - `RULE_DEVIATIONS`：**规则级**偏离（文档里的行为约定，没有对应的数值参数）。
 *
 * `test/fidelity.test.ts` 会校验：
 *   ① `DEVIATIONS` 的键必须存在、必须属于 `doc` 来源、值必须真的与基线不同；
 *   ② 未被登记的 `doc` 参数，生效值必须**严格等于**基线值；
 *   ③ `RULE_DEVIATIONS` 必须写清"文档怎么说 / 我们怎么做 / 为什么 / 谁批的"。
 *
 * @module @forlife/contracts/deviations
 */

/** 一条数值偏离。 */
export interface Deviation {
  /** 基线参数键（必须是 doc 来源）。 */
  readonly key: string
  /** 我们实际采用的值。 */
  readonly value: unknown
  /** 为什么要偏离。 */
  readonly reason: string
  /** 依据（文档章节 / 实测数据 / 用户决定）。 */
  readonly approvedBy: string
}

/** 一条规则级偏离：文档写了一条规则，我们有受控的例外。 */
export interface RuleDeviation {
  /** 文档里的规则（引用到章节）。 */
  readonly rule: string
  /** 我们实际的做法。 */
  readonly behavior: string
  /** 为什么必须有这个例外。 */
  readonly reason: string
  /** 谁批准的。 */
  readonly approvedBy: string
}

/**
 * 数值偏离：目前**没有**。
 *
 * 这本身是一个可断言的结论 —— "PLAN.MD 与 模型路由.MD 里的每个可调项都按原值实现"。
 */
export const DEVIATIONS: readonly Deviation[] = []

/**
 * 规则级偏离：允许受控例外，但必须显式登记。
 */
export const RULE_DEVIATIONS: readonly RuleDeviation[] = [
  {
    rule: 'PLAN.MD §8.6 / §9.2：同一逻辑轮次内模型固定，路由决策在轮次开始时做一次',
    behavior:
      '主动切换仍然禁止（§2.18.2 用"理由 + 冷却 + 预算 + 提示词明示切换贵于委派"卡住）；' +
      '仅当 provider 无额度/失败导致轮次无法完成时，允许**被动**降级到下一个模型（routing.failover），' +
      '并沿用同一风格段、对齐 temperature/maxTokens，全部落 routing_log。',
    reason:
      '"轮次内不换模型"的目的是避免语气与推理风格断裂；而 provider 不可用是硬约束，' +
      '不降级就等于整轮失败，对用户更糟。被动降级的断裂风险由"同一风格段 + 参数对齐"控制。',
    approvedBy: 'EXECUTION_PLAN §2.18.1（用户明确要求：provider 没额度/失败时按指定顺序自动切换）',
  },
]

/** 按 key 建索引，便于测试与 defaults 应用。 */
export function deviationMap(): ReadonlyMap<string, Deviation> {
  const map = new Map<string, Deviation>()
  for (const d of DEVIATIONS) {
    if (map.has(d.key)) throw new Error(`deviations 中存在重复键：${d.key}`)
    map.set(d.key, d)
  }
  return map
}
