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
export {
  decideCompaction,
  defaultCompactionThresholds,
  extractJsonObject,
  makeFragmentHint,
  parseCompactionDecision,
  planFragmentation,
  renderKeepInShort,
} from './compaction.ts'
export type {
  CompactionDecision,
  CompactionRejectionReason,
  CompactionStats,
  CompactionThresholds,
  CompactionVerdict,
  FragmentCandidate,
  FragmentationPlan,
  ParseDecisionResult,
  PushToMidEntry,
} from './compaction.ts'

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
} from './prompt-text.ts'
export type { PromptDiffLine, PromptRenderResult, PromptValidation, PromptVariableSpec } from './prompt-text.ts'


export {
  attributeMiss,
  cacheCurve,
  expectedMisses,
  isMiss,
  judgeCache,
  promptTokensOf,
  summarizeCache,
} from './cache-metrics.ts'
export type { CacheCurvePoint, CacheSummary, PrefixChangeEvent, UsageSample } from './cache-metrics.ts'


export {
  dateBounds,
  decideInjection,
  defaultClockSettings,
  describeReason,
  formatDuration,
  formatHuman,
  formatIsoWithOffset,
  formatRelative,
  isFresh,
  readingAgeMs,
  renderTimeBlock,
  zonedParts,
} from './clock.ts'
export type {
  ClockReading,
  ClockSettings,
  DateBounds,
  InjectionContext,
  InjectionDecision,
  InjectionReason,
  TimeBlockInput,
} from './clock.ts'



export { compareRegression, scoreAnswer, scoreRegression, timeQuestions } from './time-regression.ts'
export type { QuestionScore, RegressionScore, TimeQuestion } from './time-regression.ts'


export { describeDrift, extractTimeClaims, findDrift } from './time-drift.ts'
export type { DriftFinding, TimeClaim } from './time-drift.ts'

// ── 词面近似相似度（recall 的重复查询 / 喂食的查重**共用同一份实现**）──────────
// 它在这里而不是在 dsh-component 里：gateway 也要用，而依赖方向不能让 gateway 反向依赖插件。
export { normalizeForSimilarity, similarityTokens, textSimilarity } from './similarity.ts'

