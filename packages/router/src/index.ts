/**
 * `@forlife/router` —— 复杂度评分与模型路由。
 *
 * 三层结构（模型路由.MD §5.1）：守卫规则（<1ms）→ L1 评分器（5–30ms）→ 启发式兜底（<1ms）。
 * 与 `@forlife/gateway` 的分工：那边管"要不要理它"，这边管"用多强的脑子理它"。
 *
 * @module @forlife/router
 */
export { DEFAULT_GUARDS, runGuards } from './guards.ts'
export type { GuardContext, GuardRule, GuardVerdict, Tier } from './guards.ts'

export { hasCodeBlock, hasPlanningKeywords, heuristicScore, heuristicTier } from './heuristic.ts'
export type { HeuristicInput, HeuristicScore } from './heuristic.ts'

export { defaultScoringPrompt, HeuristicTierScorer, HttpTierScorer, parseScoringOutput } from './scorer.ts'
export type { HttpScorerOptions, ScoreResult, ScoringInput, ScoringPrompt, TierScorer } from './scorer.ts'

export { deescalate, describeDecision, escalate, routeBatch, Router, startPreScore } from './pipeline.ts'
export type { RouterOptions, RoutingDecision } from './pipeline.ts'

export {
  assertNotSubagentSwitch,
  assertTierForTurn,
  decideSwitch,
  defaultRouteEntries,
  defaultSwitchPolicy,
  emptyFallbackState,
  lockTierForTurn,
  recordRouteFailure,
  recordRouteSuccess,
  ROUTE_ROLES,
  selectRoute,
} from './routes.ts'
export type {
  FallbackState,
  RouteEntry,
  RouteRole,
  RouteSelection,
  SelectionContext,
  SwitchPolicy,
  SwitchVerdict,
  TurnRouteState,
} from './routes.ts'

export { reviewCases, summarizeReview } from './review.ts'
export type { ReviewCase, SuggestionKind, TuningSuggestion } from './review.ts'


export {
  ACCELERATOR_BACKENDS,
  candidateModels,
  emptyDeviceProbe,
  ENDPOINT_TYPES,
  planBackend,
  RUN_MODES,
  suggestBackend,
  suggestSizing,
  validateEndpoint,
} from './endpoints.ts'
export type {
  AcceleratorBackend,
  Architecture,
  BackendPlan,
  BackendPlanInput,
  CandidateModel,
  DeviceProbe,
  EndpointHealth,
  EndpointLimits,
  EndpointType,
  InferenceEndpoint,
  ModelCapability,
  Quantization,
  RunMode,
  SizingAdvice,
  ValidationIssue,
} from './endpoints.ts'

export { checkRemoteGuard, estimateContainerMemoryMb, planDeploy, runDeploy } from './deploy.ts'
export type {
  DeployExecutor,
  DeployPlan,
  DeployResult,
  DeploySpec,
  DeployStep,
  DeployStepKind,
  DeployTarget,
  DeployTargetKind,
  ExternalApiTarget,
  LocalDockerTarget,
  PreflightResult,
  RemoteGuard,
  RemoteSshTarget,
  StepResult,
} from './deploy.ts'

export { fileSha256, resumableDownload, sameSha256 } from './download.ts'
export type { DownloadOptions, DownloadProgress, DownloadResult } from './download.ts'
