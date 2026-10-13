/**
 * **从契约键读出合并策略**（D8；用户 2026-10-13 裁定"BC 都实现、AB 都实现、配置时选"）。
 *
 * ## 为什么单独一个模块
 *
 * `fragment-merge.ts` 只管**算**（纯函数、不碰配置）；这里只管**读配置**。
 * 分开的好处：算的测试可以随便造策略，读配置的测试可以随便造环境变量 ——
 * ★ 而"键有没有消费者"这件事也有了**明确的一处**（`param-consumption` 那类守卫要的就是这个）。
 *
 * ## 五个键（`packages/contracts/plan-baseline.json`）
 *
 * | 键 | 默认 | 含义 |
 * | :--- | :--- | :--- |
 * | `fragment.merge.criterion` | `intersection` | B（交集 ≥ N）还是 C（Jaccard ≥ X） |
 * | `fragment.merge.minShared` | `2` | B 的 N |
 * | `fragment.merge.jaccard` | `0.5` | C 的 X —— ★ **待用真机数据标定** |
 * | `fragment.merge.hintMode` | `mechanical` | A 机械拼接 / B 模型生成 |
 * | `fragment.merge.mode` | `apply` | `apply` 真合并 / `shadow` 只记日志不落库 |
 *
 * ★ 非法值**不静默回退**：一律抛错并**说清收到的是什么**（本仓一贯的"不猜、不忽略"）。
 *   理由：一个拼错的 `criterion` 若被静默当成默认值，用户会以为"我配了 C"而其实在跑 B ——
 *   那正是最难发现的一类问题。
 *
 * @module @forlife/memory-core/fragment-merge-policy
 */
import { defaultFor } from '@forlife/contracts'

import type { MergeCriterion, MergeHintMode, MergePolicy } from './fragment-merge.ts'

/** 合并的**执行方式**。 */
export type MergeMode = 'apply' | 'shadow'

/** 完整策略（含执行方式与 token 上限）。 */
export interface MergeSettings extends MergePolicy {
  readonly mode: MergeMode
}

/**
 * 读一个字符串键，并**校验取值集合**。
 *
 * @param key - 契约键。
 * @param allowed - 允许的取值。
 * @returns 取值。
 */
function readEnum<T extends string>(key: string, allowed: readonly T[], read: ReadFn): T {
  const raw = read<string>(key)
  if (!allowed.includes(raw as T)) {
    throw new Error(`${key} 的取值非法：收到 ${JSON.stringify(raw)}，只允许 ${allowed.map((x) => JSON.stringify(x)).join(' / ')}`)
  }
  return raw as T
}

/**
 * 读一个数字键，并校验是**有限正数**（`jaccard` 另需 ≤ 1）。
 *
 * @param key - 契约键。
 * @param options - `max` 上限（含）。
 * @returns 数值。
 */
function readNumber(key: string, options: { readonly max?: number; readonly min?: number } = {}, read: ReadFn = defaultFor as ReadFn): number {
  const raw = read<number>(key)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`${key} 必须是有限数字，收到 ${JSON.stringify(raw)}`)
  }
  const min = options.min ?? Number.NEGATIVE_INFINITY
  const max = options.max ?? Number.POSITIVE_INFINITY
  if (raw < min || raw > max) {
    throw new Error(`${key} 超出范围 [${String(min)}, ${String(max)}]：收到 ${String(raw)}`)
  }
  return raw
}

/**
 * 从契约键拼出合并策略。
 *
 * @param maxHintTokens - 粗 hint 的 token 上限（★ 由调用方传 —— 与 `fragment.maxHintTokens` 同源）。
 * @returns 策略。
 */
/** ★ 读键的函数（默认 defaultFor；★ 可注入 ⇒ 测试不必去改基线文件）。 */
export type ReadFn = <T>(key: string) => T

/**
 * 从契约键拼出合并策略。
 *
 * @param maxHintTokens - 粗 hint 的 token 上限（★ 由调用方传 —— 与 ragment.maxHintTokens 同源）。
 * @param read - 读键函数（默认读契约基线；测试可注入）。
 * @returns 策略。
 */
export function mergeSettingsFromContract(maxHintTokens?: number, read: ReadFn = defaultFor as ReadFn): MergeSettings {
  const criterion = readEnum<MergeCriterion>('fragment.merge.criterion', ['intersection', 'jaccard'], read)
  const hintMode = readEnum<MergeHintMode>('fragment.merge.hintMode', ['mechanical', 'model'], read)
  const mode = readEnum<MergeMode>('fragment.merge.mode', ['apply', 'shadow'], read)
  const minShared = readNumber('fragment.merge.minShared', { min: 1 }, read)
  // ★ Jaccard 是比值 ⇒ 必须落在 (0, 1]：0 会让"什么都不合"，>1 会让"永远不合"
  const jaccard = readNumber('fragment.merge.jaccard', { min: Number.EPSILON, max: 1 }, read)
  return {
    criterion,
    minShared: Math.floor(minShared),
    jaccard,
    hintMode,
    mode,
    ...(maxHintTokens === undefined ? {} : { maxHintTokens }),
  }
}

/**
 * 一句话描述当前策略（★ 写进日志/审计，事后能回答"当时用的是哪套判据与参数"）。
 *
 * @param settings - 策略。
 * @returns 文本。
 */
export function describeMergeSettings(settings: MergeSettings): string {
  const judge =
    settings.criterion === 'intersection'
      ? `B 交集≥${String(settings.minShared)}`
      : `C Jaccard≥${String(settings.jaccard)}`
  const hint = settings.hintMode === 'mechanical' ? 'A 机械拼接' : 'B 模型生成'
  const mode = settings.mode === 'shadow' ? 'shadow（只记日志不落库）' : 'apply（真合并）'
  return `判据=${judge}；粗 hint=${hint}；模式=${mode}`
}
