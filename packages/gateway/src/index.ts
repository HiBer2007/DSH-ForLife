/**
 * `@forlife/gateway` —— SQ 生命体的伴生服务：QQ 适配、队列、轮次驱动、后台与触发引擎。
 *
 * 与 `@forlife/memory-core` 的分工：那边是**记忆的纯逻辑**，这边是**与外界打交道的一切**。
 * 两者都不直接依赖 DSH；只有 `forlife-memory` 组件包做宿主适配。
 *
 * @module @forlife/gateway
 */
export { classifyNoise, Debouncer, DEFAULT_NOISE_RULES, KeyedMutex } from './timing.ts'
export { createOneBotTransport, OneBotTransport } from './onebot.ts'
export type { OneBotTransportOptions } from './onebot.ts'
export {
  decideWake,
  defaultWakeRules,
  listWakeRules,
  pendingStats,
  readPending,
  recordPending,
  resolveWakeRule,
  seedWakeRules,
  setWakeRule,
  WAKE_CONDITIONS,
} from './wake.ts'
export type { PendingItem, WakeCondition, WakeDecisionOptions, WakeReason, WakeRequest, WakeRule, WakeVerdict } from './wake.ts'
export {
  claimPendingOutbound,
  confirmOutbound,
  enqueueOutbound,
  failOutbound,
  getOutbound,
  listOutbound,
  outboxStats,
  reclaimStaleOutbound,
  waitForConfirmation,
} from './outbox.ts'
export type { ConfirmationResult, EnqueueInput, OutboundKind, OutboxRow } from './outbox.ts'
export {
  FakeTurnDriver,
  HeadlessTurnDriver,
  LongConnectionTurnDriver,
  createDriver,
  newTurnId,
  parseNdjson,
} from './driver.ts'
export type { FakeScript, HeadlessDriverOptions, LongConnectionDriverOptions } from './driver.ts'
export { buildTurnPrompt, defaultConditionOf, defaultScopeOf, TurnRunner } from './turns.ts'
export type { TurnDriver, TurnOutcome, TurnRequest, TurnRunResult, TurnRunnerOptions } from './turns.ts'
export {
  clearSystemStatus,
  currentStatus,
  failurePresetText,
  recordWakeAttempt,
  setModelStatus,
  setStatusPreset,
  setSystemStatus,
} from './status.ts'
export type { CurrentStatus, SetStatusResult, StatusSource, StatusState } from './status.ts'
export {
  affectsModel,
  ALLOWED_SOURCES,
  assertReportSource,
  collectReportable,
  decideDelivery,
  FORBIDDEN_SOURCES,
  isAwake,
  markReported,
  recordAdminAction,
  renderReport,
  runReportCycle,
} from './reports.ts'
export type { DeliveryDecision, ForlifeSource, ReportableEffect, ReportBatch } from './reports.ts'
export {
  ADMIN_CHAT_KEY,
  appendModelReply,
  buildAdminPrompt,
  listAdminChat,
  markHandled,
  pendingAdminCount,
  postHumanMessage,
  takePendingHumanMessages,
} from './admin-chat.ts'
export type { AdminChatMessage } from './admin-chat.ts'
export { Gateway } from './gateway.ts'
export type { GatewayOptions, GatewayState } from './gateway.ts'
export { CONDITION_PRIORITY, TurnScheduler } from './scheduler.ts'
export type { ScheduleEnqueue, ScheduleItem, SchedulerOptions, SchedulerSnapshot } from './scheduler.ts'
export { conversationKey, parseConversationKey } from './transport.ts'
export type {
  ConversationKind,
  ConversationRef,
  InboundEvent,
  InboundMessage,
  OutboundSegment,
  QqTransport,
  SendResult,
  TransportStatus,
} from './transport.ts'
export type { NoiseFilterOptions, NoiseMessage, NoiseRule, NoiseVerdict, DebounceOptions } from './timing.ts'









