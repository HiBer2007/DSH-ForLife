/**
 * OpenCode Go 接入点（**新方式**，按 https://opencode.ai/v2/docs/console/go/ 的 2026-10 版文档）。
 *
 * ## 为什么单独一个模块，而不是把 baseUrl 塞进某个配置
 *
 * 这个接入点有三条**容易被忽略但会直接影响可用性**的规矩，散落在调用处一定会漏：
 *
 * 1. **必须自带 User-Agent**。文档明确要求"用自己的 UA（如 `my-coding-agent/1.0`），
 *    而不是通用 SDK 或 HTTP 库的名字" —— 用默认 UA 会被当成滥用流量。
 * 2. **每个会话必须带 `x-opencode-session`**（稳定的会话 id）。它影响路由与**提示词缓存**：
 *    不带就等于放弃缓存命中，成本与延迟都变差（我们的缓存命中率面板会直接反映出来）。
 * 3. **不同模型走不同协议**：`/chat/completions`（OpenAI 兼容）、`/responses`、
 *    `/messages`（Anthropic）。按模型选错协议会 404 或 400，且错误信息不会告诉你是协议问题。
 *
 * ## 免费模型：fail-closed，而不是"先信任"
 *
 * 文档里 `Space Bunny Free` 与 `LongCat 2.5 Preview Free` 都标着 **limited time**。
 * 我们**无法程序化地知道**它们什么时候不再免费（没有这样的接口），
 * 所以采取的策略是：**记录复核时间 + 到期即禁用**。
 * 宁可暂时用不上免费模型，也不能在它悄悄开始计费之后继续拿它跑量。
 *
 * @module @forlife/contracts/opencode-go
 */

/** Go 的 API 基址（v1）。 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

/**
 * 客户端标识。
 *
 * 文档要求"自己的 UA"，所以这里写死我们自己的名字与版本 —— 不要改成 `openai-node` 之类。
 */
export const OPENCODE_GO_USER_AGENT = 'dsh-forlife/0.1'

/** 会话头名（文档指定）。 */
export const OPENCODE_GO_SESSION_HEADER = 'x-opencode-session'

/** API key 的**引用名**：密钥本身绝不入库（表里只有 `api_key_ref`）。 */
export const OPENCODE_GO_KEY_ENV = 'FORLIFE_OPENCODE_GO_KEY'

/** 三种协议。 */
export type OpenCodeProtocol = 'chat' | 'responses' | 'messages'

/** 一个模型的登记项。 */
export interface OpenCodeModel {
  readonly id: string
  readonly label: string
  readonly protocol: OpenCodeProtocol
  /**
   * 免费模型的复核要求。
   *
   * `verifiedAt` 是我们**最后一次确认它免费**的时间；超过 `recheckDays` 未复核即自动禁用。
   * 付费模型没有这个字段。
   */
  readonly free?: { readonly verifiedAt: string; readonly recheckDays: number }
  /** 用途说明（写清楚为什么给它这个档位）。 */
  readonly note: string
}

/**
 * 允许使用的模型清单。
 *
 * 范围由用户明确授权：**deepseek-v4.1-flash、MiMo-V2.6-Flash、GLM-5.3-Flash
 * 三个付费模型 + 两个限时免费模型**。清单之外的模型一律不登记 ——
 * "能用"与"允许用"是两件事，Go 的模型列表里有几十个，我们只登记被授权的。
 */
export const OPENCODE_GO_MODELS: readonly OpenCodeModel[] = [
  {
    id: 'mimo-v2.6-flash',
    label: 'MiMo-V2.6-Flash',
    protocol: 'chat',
    note: '最便宜的一档（$0.14/$0.28，月额度 $60）：给 L1 闲聊与简单问答',
  },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    protocol: 'chat',
    note: '主力（$0.15/$0.60 谷时，月额度 $60，且文档标注 0 天留存）：给 L2/L3',
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM-5.3-Flash',
    protocol: 'chat',
    note: '便宜且额度高（$60）：给评分器与降级链第二候选',
  },
  {
    id: 'space-bunny-free',
    label: 'Space Bunny Free',
    protocol: 'chat',
    free: { verifiedAt: '2026-10-06', recheckDays: 7 },
    note: '限时免费（文档原文 limited time）：只做最后兜底，**到期未复核即禁用**',
  },
  {
    id: 'longcat-2.5-preview-free',
    label: 'LongCat 2.5 Preview Free',
    protocol: 'chat',
    free: { verifiedAt: '2026-10-06', recheckDays: 7 },
    note: '限时免费（文档原文 limited time）：同上',
  },
]

/** 协议 → 路径。 */
export function protocolPath(protocol: OpenCodeProtocol): string {
  switch (protocol) {
    case 'chat':
      return '/chat/completions'
    case 'responses':
      return '/responses'
    case 'messages':
      return '/messages'
  }
}

/** 模型 id → 完整 URL。 */
export function modelUrl(modelId: string): string {
  const model = OPENCODE_GO_MODELS.find((item) => item.id === modelId)
  const protocol = model?.protocol ?? 'chat'
  return `${OPENCODE_GO_BASE_URL}${protocolPath(protocol)}`
}

/**
 * 构造请求头。
 *
 * `sessionId` **必须**由调用方给出（通常是会话键）：文档要求"每个会话一个稳定 id"，
 * 每次请求现随机生成一个等于没有 —— 缓存与路由优化都建立在"同一会话稳定"之上。
 */
export function buildHeaders(input: {
  readonly apiKey: string
  readonly sessionId: string
  readonly extra?: Record<string, string>
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${input.apiKey}`,
    'user-agent': OPENCODE_GO_USER_AGENT,
    [OPENCODE_GO_SESSION_HEADER]: input.sessionId,
    ...input.extra,
  }
}

/** 可用性判定结果。 */
export interface ModelUsability {
  readonly usable: boolean
  /** 不可用时说明原因（面板要显示，所以必须是人话）。 */
  readonly reason: string
}

/**
 * 判断某个模型现在能不能用。
 *
 * 免费模型到期即**不可用**（fail-closed）：我们没有接口去问"它现在还免费吗"，
 * 所以只能要求定期人工/脚本复核；未复核就停用，而不是继续跑。
 */
export function isModelUsable(modelId: string, now: Date = new Date()): ModelUsability {
  const model = OPENCODE_GO_MODELS.find((item) => item.id === modelId)
  if (model === undefined) {
    return { usable: false, reason: `不在授权清单里（清单只有 ${String(OPENCODE_GO_MODELS.length)} 个模型）` }
  }
  if (model.free === undefined) return { usable: true, reason: '付费模型，在授权清单内' }

  const verified = Date.parse(`${model.free.verifiedAt}T00:00:00Z`)
  if (Number.isNaN(verified)) {
    return { usable: false, reason: '免费复核时间无法解析，按不可用处理' }
  }
  const ageDays = (now.getTime() - verified) / 86_400_000
  if (ageDays > model.free.recheckDays) {
    return {
      usable: false,
      reason: `免费状态已 ${String(Math.floor(ageDays))} 天未复核（上限 ${String(model.free.recheckDays)} 天），按"可能已开始计费"禁用`,
    }
  }
  return { usable: true, reason: `免费状态 ${String(Math.floor(ageDays))} 天前复核过，仍在有效期内` }
}

/** 当前可用的模型（面板与播种都用它）。 */
export function usableModels(now: Date = new Date()): readonly OpenCodeModel[] {
  return OPENCODE_GO_MODELS.filter((model) => isModelUsable(model.id, now).usable)
}

/** 一条路由计划（与 `model_routes` 的字段对齐，但这里是纯数据，便于测试）。 */
export interface OpenCodeRoutePlan {
  readonly role: string
  readonly rank: number
  readonly model: string
  readonly reasoningEffort: 'low' | 'medium' | 'high' | null
  readonly note: string
}

/**
 * 生成档位 → 模型的分配计划。
 *
 * 分配理由（都不是随手排的）：
 *  - **L1** 用最便宜的 MiMo-Flash：闲聊占绝大多数请求量，省钱优先；
 *  - **L2/L3** 用 DeepSeek V4.1 Flash：它是三个授权付费模型里综合能力最强的，
 *    且文档标注 0 天留存（隐私上更放心）；
 *  - **L3 与 L2 同模型但 effort=high**：档位只影响推理强度，这是既有设计（见 route-seed）；
 *  - **scorer** 用 GLM-5.3-Flash：评分是高频小请求，要便宜且快；
 *  - 每个角色都**排出降级链**（rank 递增）：provider 抖动时能自动往下换，
 *    否则一个模型挂掉就是整轮失败；
 *  - 免费模型只放在**最后兜底**：它们随时可能消失，不该承担主路径。
 */
export function planOpenCodeGoRoutes(now: Date = new Date()): readonly OpenCodeRoutePlan[] {
  const usable = new Set(usableModels(now).map((model) => model.id))
  const plan: OpenCodeRoutePlan[] = []
  const add = (role: string, rank: number, model: string, effort: OpenCodeRoutePlan['reasoningEffort'], note: string): void => {
    // 不可用的模型**不进计划**：计划是要被写进库的，写进去就等于承诺可用
    if (!usable.has(model)) return
    plan.push({ role, rank, model, reasoningEffort: effort, note })
  }

  add('L1', 0, 'mimo-v2.6-flash', 'low', '闲聊与简单问答：最便宜的一档')
  add('L1', 1, 'glm-5.3-flash', 'low', '降级候选：额度高，抖动时顶上')
  add('L1', 2, 'space-bunny-free', 'low', '最后兜底：限时免费，随时可能消失')

  add('L2', 0, 'deepseek-v4.1-flash', 'medium', '一般任务：授权清单里综合最强')
  add('L2', 1, 'glm-5.3-flash', 'medium', '降级候选')

  add('L3', 0, 'deepseek-v4.1-flash', 'high', '复杂任务：同模型但拉满推理强度')
  add('L3', 1, 'glm-5.3-flash', 'high', '降级候选')

  add('scorer', 0, 'glm-5.3-flash', 'low', '复杂度评分器：高频小请求，要便宜且快')
  add('scorer', 1, 'mimo-v2.6-flash', 'low', '降级候选')

  return plan
}

/** provider 名（写进 `model_routes.provider`，与 DSH 侧的 provider 标识一致）。 */
export const OPENCODE_GO_PROVIDER = 'opencode-go'

/** 端点登记用的能力描述（`inference_endpoints.models` 是 JSON）。 */
export function endpointModelsJson(now: Date = new Date()): readonly { id: string; image: boolean }[] {
  // 哪些模型能看图：**实测过的**才算。
  // deepseek-v4.1-flash 由用户纠正 + 我用真图实测确认（HTTP 200，
  // prompt_tokens 241 说明图片确实进了上下文，且它按要求的 JSON 格式回了描述）。
  // 注意它同时是推理模型：max_tokens 给小了会把预算全花在 reasoning 上、
  // 正文返回**空字符串**（不是报错）—— 这种静默失败必须在调用侧挡住。
  const VISION_CAPABLE = new Set(['deepseek-v4.1-flash'])
  return usableModels(now).map((model) => ({ id: model.id, image: VISION_CAPABLE.has(model.id) }))
}
