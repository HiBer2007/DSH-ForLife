/**
 * `@forlife/store` —— 记忆的持久层（自持 `node:sqlite`）。
 *
 * 为什么不用宿主的 `ctx.storageDomain`：它是 zod 域模型，**没有 SQL、没有 joins、没有迁移钩子**；
 * 而我们需要关系表、FTS5 与跨进程共享（网关与 DSH 同机读同一个库）。
 *
 * @module @forlife/store
 */
export { DEFAULT_DB_FILENAME, SCHEMA_VERSION, backupDatabase, currentVersion, migrationList, openDatabase } from './db.ts'
export type { OpenOptions, OpenedDatabase } from './db.ts'
export { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts'
export { FLAG_QQ_TAKEOVER, getFlag, setFlag } from './flags.ts'
export { markStickerOurs,
  describeStickerOnce,
  evictLearnedStickers,
  findStickerBySha,
  findStickerDescription,
  getStickerAsset,
  listStickerAssets,
  rejectStickerAsset,
  saveStickerDescription,
  touchStickerUse,
  upsertStickerAsset,
} from './stickers.ts'
export type {
  DescribeOnceResult,
  StickerAssetRow,
  StickerDescriptionRow,
  StickerSource,
  UpsertStickerInput,
  UpsertStickerResult,
} from './stickers.ts'
export {
  abortCompactionRun,
  beginCompactionRun,
  commitCompactionRun,
  getCompactionRun,
  listCompactionRuns,
  pendingCompactionRuns,
  recoverPendingCompactions,
  rollbackCompactionRun,
} from './compaction-runs.ts'
export type { CompactionPlan, CompactionRunRow, RollbackResult } from './compaction-runs.ts'
export { getEffect, listEffects, listUnreportedEffects, markEffectsReported, recordEffect } from './effects.ts'
export type { EffectRow } from './effects.ts'
export type { Migration } from './migrations.ts'
export {
  appendMidEntry,
  currentEpoch,
  currentRevision,
  fragmentMidEntry,
  getSpill,
  getLongEntry,
  getMidEntry,
  getState,
  setState,
  insertLongEntry,
  insertSpill,
  lastSuccessfulCompaction,
  listCompactionLog,
  listRenderableMidEntries,
  listSettleCandidates,
  listSpills,
  markLongRecovered,
  markLongSettled,
  midStats,
  nowIso,
  recordCompaction,
  searchLongFts,
  searchMidFts,
  touchLongEntry,
  touchMidEntry,
  bumpEpoch,
} from './repository.ts'
export type {
  AppendMidInput,
  AppendMidResult,
  CompactionLogInput,
  LongEntryRow,
  MidEntryRow,
  MidStats,
  SpillRow,
} from './repository.ts'






export {
  attachUsageToTurn,
  cacheUsageCount,
  lastCacheUsageAt,
  listCacheUsage,
  recordCacheUsage,
  setMissReason,
  unattrributedMisses,
} from './cache-metrics.ts'
export type { CacheMetricRow } from './cache-metrics.ts'


export {
  lastTimeReading,
  listTimeDrift,
  listTimeReadings,
  recordTimeDrift,
  recordTimeReading,
  timeDriftStats,
  timeReadingStats,
  timeReadingTokens,
} from './time-readings.ts'
export type { TimeReadingRow } from './time-readings.ts'


export {
  acceptClockSuggestion,
  clearConversationClock,
  getClockSuggestion,
  getConversationClock,
  listClockSuggestions,
  listConversationClocks,
  setClockSuggestion,
  setConversationClock,
  sourceRank,
  TIMEZONE_SOURCES,
} from './conversation-clocks.ts'
export type { ClockSuggestion, ConversationClock, TimezoneSource } from './conversation-clocks.ts'


export {
  deleteModelRoute,
  listModelRoutes,
  listRoutingLog,
  markCaseReviewed,
  pendingUncertainCases,
  recordRoutingDecision,
  recordUncertainCase,
  routingStats,
  uncertainStats,
  upsertModelRoute,
} from './routing.ts'
export type { ModelRouteRow } from './routing.ts'


export {
  deleteEndpoint,
  endpointOverview,
  getEndpoint,
  lastEndpointProbe,
  listEndpointProbes,
  listEndpoints,
  listModeSwitches,
  recordEndpointHealth,
  recordEndpointProbe,
  recordModeSwitch,
  setEndpointMode,
  upsertEndpoint,
} from './endpoints.ts'
export type { EndpointInput, EndpointRow } from './endpoints.ts'


export {
  getImageDescription,
  lastVisionCallAt,
  recordVisionCall,
  saveImageDescription,
  visionCallsFor,
  visionStats,
} from './vision.ts'
export type { ImageDescriptionRow } from './vision.ts'



export {
  getConversationProfile,
  listConversationProfiles,
  renderProfileForPrompt,
  setConversationImpression,
  setConversationNote,
} from './conversation-profile.ts'
export type { ConversationProfileRow } from './conversation-profile.ts'

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
} from './prompt-store.ts'
export type { PromptRevision, PromptSlug, SavePromptResult } from './prompt-store.ts'
export {
  countFiredToday,
  createWakeTrigger,
  decideWake,
  DEFAULT_MERGE_WINDOW_MS,
  deleteWakeTrigger,
  getWakeTrigger,
  isWakePaused,
  listDueTimers,
  listWakeEvents,
  listWakeTriggers,
  markFired,
  MAX_CASCADE_DEPTH,
  recordWakeEvent,
  setWakePaused,
  updateWakeTrigger,
  WAKE_PAUSED_KEY,
} from './wake-triggers.ts'
export type {
  CreateWakeTriggerInput,
  CreateWakeTriggerResult,
  GateDecision,
  GateInput,
  WakeTriggerKind,
  WakeTriggerRow,
} from './wake-triggers.ts'
