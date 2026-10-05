/**
 * `@forlife/memory-core` —— 记忆的纯逻辑层（无 DSH 依赖，可独立单测）。
 *
 * 这一层不碰数据库、不碰网络、不读时钟：所有输入都由调用方传入，
 * 因此"表是权威、窗口是渲染"这条原则可以被测试钉死。
 *
 * @module @forlife/memory-core
 */
export { DEFAULT_HEADER, formatAge, renderMidMemory } from './render.ts'
export type { RenderOptions, RenderedView } from './render.ts'
export { estimateTokens } from './tokens.ts'
