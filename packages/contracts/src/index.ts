/**
 * `@forlife/contracts` —— 全项目唯一真源。
 *
 * 三样东西：
 *  1. **保真度基线**（`plan-baseline.json`）：PLAN.MD / 模型路由.MD 的每个参数与时机；
 *  2. **默认值派生**（`defaultFor`）：代码只能从这里取默认值，不允许别处硬编码；
 *  3. **偏离登记**（`DEVIATIONS` / `RULE_DEVIATIONS`）：唯一允许的偏离出口，带理由与依据。
 *
 * `doc` 来源 = 设计文档给的（受"一比一"约束）；`design` 来源 = 我们自己的设计参数。
 *
 * @module @forlife/contracts
 */
export type { Baseline, BaselineParam, BaselineTiming } from './baseline.ts'
export {
  baselineKeys,
  baselineOrigin,
  baselineParam,
  baselineTimings,
  baselineValue,
  docOriginKeys,
  loadBaseline,
} from './baseline.ts'
export type { Deviation, RuleDeviation } from './deviations.ts'
export { DEVIATIONS, RULE_DEVIATIONS, deviationMap } from './deviations.ts'
export { allDefaults, defaultFor, defaultsWithPrefix, pendingBaselineKeys } from './defaults.ts'
// 外部推理接入点。单独一个模块的理由见文件头：UA / 会话头 / 协议选择 / 免费模型 fail-closed
// 这四件事散落在调用处一定会漏。
export {
  buildHeaders,
  endpointModelsJson,
  isModelUsable,
  modelUrl,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_KEY_ENV,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_SESSION_HEADER,
  OPENCODE_GO_USER_AGENT,
  planOpenCodeGoRoutes,
  protocolPath,
  usableModels,
} from './opencode-go.ts'
export type { ModelUsability, OpenCodeModel, OpenCodeProtocol, OpenCodeRoutePlan } from './opencode-go.ts'

export type { ReasoningEffort } from './opencode-go.ts'
