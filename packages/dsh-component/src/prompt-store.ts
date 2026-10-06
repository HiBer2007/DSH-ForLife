/**
 * 提示词版本管理 —— **实现已下沉到 `@forlife/store`**（2026-10-06）。
 *
 * 为什么：网关要能编辑提示词，而它**不能依赖插件**
 * （插件的 HTTP 接口只在 DSH 宿主跑着插件时才存在，网关是独立进程）。
 * 放在 store 后两边共用同一份，不会分叉。
 *
 * 保留再导出，既有 import 一行都不用改。
 */
export {
  activePrompt,
  clearPromptOverride,
  listPromptOverrides,
  listPromptRevisions,
  promptEditCount,
  promptRevisionById,
  promptStatus,
  PROMPT_SLUGS,
  resolvePrompt,
  rollbackPrompt,
  savePromptRevision,
  seedDefaultPrompts,
  setPromptOverride,
} from '@forlife/store'
export type { PromptRevision, PromptSlug, SavePromptResult } from '@forlife/store'
