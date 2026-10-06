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










export { WAKE_CONDITION_GROUPS } from './wake.ts'


// ── 表情与媒体（阶段 6）────────────────────────────────────────────────
export { createStickerService } from './sticker-service.ts'
export type { AddStickerResult, SendStickerResult, StickerService, StickerServiceOptions } from './sticker-service.ts'
export { checkMediaBytes, checkSourceUrl, DEFAULT_MEDIA_WHITELIST, fingerprintOf, ingestSticker, MAX_MEDIA_BYTES } from './stickers.ts'
export type { IngestStickerInput, IngestStickerResult } from './stickers.ts'
export { loadSearchable, scoreSticker, searchStickers, tokenize } from './sticker-search.ts'
export type { ScoredSticker, SearchableSticker, StickerHit } from './sticker-search.ts'
export { buildStickerVisionRequest, createStickerVisionDescriber, parseStickerVisionResponse, visionConfigFromEnv } from './sticker-vision.ts'
export type { StickerVisionDescriber, StickerVisionOptions, StickerVisionResult } from './sticker-vision.ts'

// ── 端口出口（PLAN 阶段 7）──────────────────────────────────────────
// 为什么插件侧也要用：整套逻辑**只依赖 node:sqlite / node:crypto / fetch**，
// 没有 DSH 依赖，所以插件可以自己造一个实例，与网关写同一个库、配同一个 Caddy。
// （这点和压缩引擎不同 —— 那个深度绑定 DSH，网关跑不了。）
export { createCaddyClient, buildHttpRoute, caddyRouteId } from './caddy.ts'
export type { CaddyClient, CaddyClientOptions, CaddyResult } from './caddy.ts'
export { checkPortAllowed, checkRouteName, DEFAULT_PORT_WHITELIST, listActivePorts, publishPort, removePort } from './ports.ts'
export type { PublishedPortRow } from './ports.ts'
export { createPortService } from './port-service.ts'
export type { PortService } from './port-service.ts'
export { buildTcpRoute, caddyTcpRouteId, tcpServerName, TCP_SERVER_NAME } from './caddy-tcp.ts'
export type { TcpRouteInput } from './caddy-tcp.ts'

// ── 工作区沙箱（PLAN 阶段 7）──────────────────────────────────────────
// 插件侧登记监视程序时也要用：路径校验必须在**两边都做**（两边都能被绕过）。
export { isInside, resolveInWorkspace } from './workspace.ts'
export type { WorkspaceCheck, WorkspaceOptions } from './workspace.ts'
