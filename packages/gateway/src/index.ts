/**
 * `@forlife/gateway` —— SQ 生命体的伴生服务：QQ 适配、队列、轮次驱动、后台与触发引擎。
 *
 * 与 `@forlife/memory-core` 的分工：那边是**记忆的纯逻辑**，这边是**与外界打交道的一切**。
 * 两者都不直接依赖 DSH；只有 `forlife-memory` 组件包做宿主适配。
 *
 * @module @forlife/gateway
 */
export { classifyNoise, Debouncer, DEFAULT_NOISE_RULES, KeyedMutex } from './timing.ts'
export type { NoiseFilterOptions, NoiseMessage, NoiseRule, NoiseVerdict, DebounceOptions } from './timing.ts'
