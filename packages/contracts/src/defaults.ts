/**
 * 运行时默认配置：**从基线派生**，再叠加已登记的偏离。
 *
 * 这是"一比一实现"的强制点：任何地方需要默认阈值，都必须经 `defaultFor(...)` 取值，
 * 不允许在别处硬编码（code review + `test/fidelity.test.ts` 双重保证）。
 *
 * @module @forlife/contracts/defaults
 */
import { baselineValue, baselineKeys } from './baseline.ts'
import { deviationMap } from './deviations.ts'

/** 取某配置键的生效默认值（基线 + 已登记偏离）。 */
export function defaultFor<T = unknown>(key: string): T {
  const deviation = deviationMap().get(key)
  if (deviation !== undefined) return deviation.value as T
  return baselineValue(key) as T
}

/** 按前缀批量取值（例：`defaultsWithPrefix('compaction.')`）。 */
export function defaultsWithPrefix(prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of baselineKeys()) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = defaultFor(key)
  }
  return out
}

/** 全部生效默认值（基线 + 偏离），扁平点分键。 */
export function allDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of baselineKeys()) out[key] = defaultFor(key)
  return out
}

/** 未定值（`status: 'tbd'`）的参数键——这些必须在对应阶段实测后补齐。 */
export function pendingBaselineKeys(): readonly string[] {
  return baselineKeys().filter((key) => {
    const value = baselineValue(key)
    return value === null
  })
}
