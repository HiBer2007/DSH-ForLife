/**
 * token 估算。
 *
 * 记忆系统到处需要 token 数（压缩阈值、碎片上限、预算），而 `memory-core` 必须能
 * **脱离 DSH 独立跑测试**，所以不能直接依赖宿主的 `ctx.tokenMeter`。
 *
 * 策略：内置一个**保守启发式**，并允许注入宿主实现（`countTokens` 选项）。
 * 启发式的取舍：宁可略微高估（提前触发压缩比爆上下文好）。
 *
 * @module @forlife/memory-core/tokens
 */

/** CJK 与全角标点：按 1 字 ≈ 1 token 计。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/g

/**
 * 估算文本 token 数。
 *
 * 规则：CJK 字符按 1 token/字；其余非空白文本按 4 字符/token；空白不计。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  const cjkCount = (text.match(CJK) ?? []).length
  const rest = text.replace(CJK, ' ').replace(/\s+/g, '')
  return cjkCount + Math.ceil(rest.length / 4)
}
