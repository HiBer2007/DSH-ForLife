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

// ── 手动喂食记忆资料（投喂子系统 + 唯一写入核心）──────────────────────
// CLI（scripts/feed-memory.ts）、DSH 面板接口（/api/forlife/feed）、
// 后台接口（/api/admin/feed）与模型工具（feed_memory）都走 `feedInput`（子系统：
// 输入形态/附件决策/切分/分批/批间让出/会话记账），它**每一批**调一次 `feedMemory`。
// 它**不自己实现**分块/去重/删除：分块只做朴素段落切 + 单条天花板，
// 去重复用既有 FTS 检索 + 同一份近似判据，删除指向既有的长期记忆管理
// （见 feed.ts / feed-batch.ts 的模块头与 §2.19）。
export {
  FEED_DELETE_HINT,
  FEED_KINDS,
  FEED_SCOPE_PREFIX,
  archiveFeedLeftovers,
  deriveFeedSource,
  deriveFeedSummary,
  feedIdFor,
  feedMemory,
  feedScopeOf,
  isFeedKind,
  resolveFeedDbPath,
  splitIntoFeedChunks,
} from './feed.ts'
export type { FeedAction, FeedChunkResult, FeedItem, FeedKind, FeedOptions, FeedResult } from './feed.ts'
export { firstFeedResult, feedInput } from './feed-batch.ts'
export type { FeedProgress, FeedRequest, FeedRunResult, FeedSkip, FeedUnitResult } from './feed-batch.ts'
export { refineFeedChunk, streamFeedChunks, withPieceSuffix } from './feed-chunk.ts'
export type { FeedPiece } from './feed-chunk.ts'
export { FEED_FRAME_PLACEHOLDERS, feedDigestNote, feedKindLabel, feedModeText, renderFeedFrame } from './feed-frame.ts'
export { FEED_READ_CHUNK_CHARS, FEED_SKIP_DIRS, FEED_TEXT_EXTENSIONS, FeedBinaryError, listFeedFiles, readFeedFilePieces, sourceOfFeedFile } from './feed-ingest.ts'
export { FEED_SESSION_KEY, advanceFeedSession, beginFeedSession, endFeedSession, readFeedSession, sessionRefreshOf } from './feed-session.ts'
export type { FeedSession, FeedSessionRefresh, FeedSessionBatch } from './feed-session.ts'

// ── 日志：七级 + 模块 logger 工厂（用户 2026-10-10 指定的分级制度）──────────
// `atLevel` 是**迁移期的桥**：注入进来的日志函数若是 `createLogger()` 的产物，
// 就走真级别；若只是个普通 `(m) => …`，就退化成调它自己（**功能不变**）。
// ⇒ 这让 161 处调用点可以**一个文件一个文件地补级别**，不必一次改完。
export { atLevel, createLogger, currentLogSink, installLogSink, logSinkCount } from './admin/log.ts'
export type { LogRecord, Logger, LoggerLike, LogSink } from './admin/log.ts'
export {
  DEFAULT_STORE_LEVEL,
  LOG_LEVELS,
  LOG_LEVEL_RANK,
  atLeast,
  disabledLevelsFromEnv,
  isLogLevel,
  shouldStore,
} from './admin/log-levels.ts'
export type { LogLevel } from './admin/log-levels.ts'
export { DEFAULT_LOG_RETENTION_DAYS, createLogStore, logStoreStats, resolveLogDir, retentionDaysFromEnv } from './admin/log-store.ts'
export type { LogQuery, LogStore } from './admin/log-store.ts'
export { LEGACY_LOG_MODULE, LogBuffer, guessLevel } from './admin/log-buffer.ts'
export type { LogLine } from './admin/log-buffer.ts'

// ── 投喂：断点续传 / 一轮一批 / 模型驱动（用户 2026-10-10 指定）───────────────
export {
  FEED_CURSOR_PREFIX,
  advanceFeedCursor,
  clearFeedCursor,
  feedCursorKey,
  listFeedCursors,
  readFeedCursor,
  writeFeedCursor,
} from './feed-cursor.ts'
export type { FeedCursor } from './feed-cursor.ts'
export { describeFeedPlan, nextFeedTurn, pendingFeedTurns } from './feed-plan.ts'
export type { FeedPlan, FeedPlanOptions, FeedTurnRange } from './feed-plan.ts'
export { DEFAULT_FEED_TURN_TIMEOUT_MS, runFeedTurn } from './feed-turn.ts'
export type { FeedBatchFn, FeedTurnOptions, FeedTurnOutcome, FeedTurnTools } from './feed-turn.ts'
export {
  FEED_RUN_KEY,
  describeFeedRunBatch,
  endFeedRun,
  readFeedRun,
  sliceSegments,
  startFeedRun,
} from './feed-run.ts'
export type { FeedRun, FeedRunSegment } from './feed-run.ts'
// ── 「投喂前更新」（源刷新）────────────────────────────────────────────
// 任何入口（工具 / HTTP / CLI）在写入之前都必须经过这道闸（闸门在 `feedInput()` 里）；
// 命令与凭据由**部署**给（环境变量 `FORLIFE_FEED_REFRESH_COMMAND`），**不进仓库**。
export {
  configuredRefreshCommand,
  feedSourceLedgerKey,
  parseRefreshMarkers,
  readFeedSourceState,
  resolveFeedRefresh,
  runFeedRefresh,
  splitCommandLine,
  writeFeedSourceState,
} from './feed-refresh.ts'
export type { FeedRefreshOutcome, FeedRefreshSpec, FeedSourceState } from './feed-refresh.ts'

// ── 工作区沙箱（PLAN 阶段 7）──────────────────────────────────────────
// 插件侧登记监视程序时也要用：路径校验必须在**两边都做**（两边都能被绕过）。
export { isInside, resolveInWorkspace } from './workspace.ts'
export type { WorkspaceCheck, WorkspaceOptions } from './workspace.ts'

// ── 合并转发（任务①）────────────────────────────────────────────────
// 「收」与「发」共用同一份结构知识（NapCat 实读，见 forward.ts 的模块头）。
export {
  buildForwardNodes,
  buildForwardNodesFromIds,
  extractForwardMessages,
  forwardPlaceholder,
  parseForwardMessages,
} from './forward.ts'
export type { ForwardNodeInput, ParsedForward } from './forward.ts'

// ── 离线积压（任务②）────────────────────────────────────────────────
// ★ `pending_backlog` 这一组参数没有进 `wake.ts` 的 `WAKE_CONDITIONS`
//   （那个文件属于另一个在跑的改动），而是用同一张 `wake_rules` 表注册。
//   理由与"该怎么并回去"写在 backlog.ts 的注释里。
export {
  BACKLOG_WAKE_CONDITION,
  backlogNotice,
  countUnread,
  decideBacklogWake,
  listBacklogWakeRule,
  readBacklog,
  renderBacklogNotice,
  seedBacklogWakeRule,
} from './backlog.ts'
export type { BacklogNotice, BacklogReadResult, BacklogScopeSummary, BacklogWakeDecision, BacklogWakeRule } from './backlog.ts'

// ── 两个方向的限制（任务②d）─────────────────────────────────────────
export { backlogReadQuota, consumeBacklogRead, currentTurnId, decideSendQuota, deliverPacing } from './limits.ts'
export type { BacklogReadQuota, SendQuotaDecision } from './limits.ts'

// ── 好友/群请求（任务③）─────────────────────────────────────────────
// 复用 `effects` 表（**不新建表**）：见 requests.ts 的模块头。
export { listPendingRequests, markRequestHandled, recordInboundRequest, renderRequestNotice, requestNotice } from './requests.ts'
export type { InboundRequest, PendingRequest, RequestKind, RequestNotice } from './requests.ts'

// ── 跨进程只读查询（工具进程 ↔ 网关进程）─────────────────────────────
export { PROBE_ACTIONS, clearProbeResult, isProbeAction, probeStateKey, readProbeResult, runProbe, writeProbeResult } from './probe.ts'
export type { ProbeAction, ProbeResult } from './probe.ts'

// ── 入站媒体：图片 → 视觉描述（P1-1）/ 语音 → 转写（P1-2）/ 文件 → 真取信息（P2-b）
//    ★ `VisionBridge` **搬到了这里**：它原来在 dsh-component，而全仓只被自己的测试引用
//    （"写好了零调用"的标本）。图片描述真正该发生的位置是"入站消息刚要交给模型"，
//    那一步在**网关进程**里 —— 而网关不能反向依赖 DSH 组件（依赖方向 dsh-component → gateway）。
export { VisionBridge, describeSourceMark, placeholderText } from './vision-bridge.ts'
export type { VisionBridgeHost, VisionBridgeOptions, VisionBridgeResult, VisionDescriber } from './vision-bridge.ts'
export { attachmentPathFor, createAttachmentReader, createHttpVisionDescriber, sniffImageMime, writeAttachment } from './vision-describer.ts'
export type { AttachmentReader, VisionEndpoint, VisionFetchLike } from './vision-describer.ts'
export { createVisionFromEnv } from './vision-wiring.ts'
export type { VisionWiring } from './vision-wiring.ts'
export {
  FILE_PLACEHOLDER,
  IMAGE_PLACEHOLDER,
  VOICE_PLACEHOLDER,
  createImageDownloader,
  decideLookAtImage,
  defaultAttachmentRoot,
  resolveMediaBatch,
  skippedImagePlaceholder,
  splicePlaceholders,
} from './media-resolve.ts'
export type {
  BinaryFetchLike,
  ImageFetchOutcome,
  ImageScreenDecision,
  ImageVisionPort,
  MediaResolveOptions,
  MediaResolveResult,
  MediaResolveStats,
  MediaTransport,
} from './media-resolve.ts'

// ── 「对方正在输入」的瞬时状态（P1-4 事件 → `read_pending` 的 `typing`）
//    为什么不用新表/新列：它是**几秒就过期**的信号，混进待办队列会让"还剩 N 条"失真。
export { TYPING_STATE_PREFIX, isPeerTyping, recordTyping, typingConversations, typingStateKey } from './typing-state.ts'
