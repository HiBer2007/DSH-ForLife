/**
 * 提示词文本工具 —— **实现已下沉到 `@forlife/store`**（2026-10-06）。
 *
 * 为什么：`prompt-store` 需要它们，而它要搬进 store 才能被网关（独立进程）使用。
 * 但 memory-core 依赖 store，直接搬会成环 —— 所以把这两个**零依赖的纯文本函数**
 * 下沉到最底层，两边共用。
 *
 * 保留再导出是为了让既有 import 一行都不用改（改动越小越不容易出错）。
 */
export {
  diffPromptLines,
  estimatePromptTokens,
  hashPromptText,
  normalizePromptText,
  PROMPT_VARIABLES,
  promptVariable,
  renderPromptPreview,
  validatePromptText,
  VARIABLE_NAME,
} from '@forlife/store'
export type { PromptDiffLine, PromptRenderResult, PromptValidation, PromptVariableSpec } from '@forlife/store'
