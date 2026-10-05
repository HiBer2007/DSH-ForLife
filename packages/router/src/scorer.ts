/**
 * L1 评分器（模型路由.MD §5.3 第二层）与三种后端。
 *
 * ## 三种后端（同一个接口）
 *
 * | 后端 | 用途 | 特点 |
 * | :--- | :--- | :--- |
 * | `local-container` | 本地 0.5B 容器（默认） | 5–30ms，常驻、预热 |
 * | `external-endpoint` | **外挂自建端点** | 同一套语义，来源可替换（验收项） |
 * | `heuristic` | 兜底 | <1ms，永远可用 |
 *
 * 「**把评分器从本地容器切到外挂自建端点，路由功能不变**」是验收项，
 * 所以这三个后端必须**只有构造参数不同**，行为契约完全一致 —— 接口同名同形。
 *
 * ## 50ms 超时是硬约束
 *
 * 评分在主流程的**关键路径**上：超时就降级，绝不等待。
 * 所以这里用 `AbortController` + `Promise.race`，且**超时不当异常往上抛** ——
 * 调用方拿到的是一个"降级"结果，而不是一个要处理的错误。
 *
 * @module @forlife/router/scorer
 */
import { defaultFor } from '@forlife/contracts'

import type { Tier } from './guards.ts'
import { heuristicScore, type HeuristicInput } from './heuristic.ts'

/** 评分结果。 */
export interface ScoreResult {
  readonly tier: Tier
  /** 置信度 0–1（启发式兜底给固定值，见下）。 */
  readonly confidence: number
  /** 哪个后端给的（进 routing_log；面板要能看出"这次是谁判的"）。 */
  readonly backend: string
  /** 是否走了降级路径。 */
  readonly degraded: boolean
  /** 降级原因（超时/报错/未配置）。 */
  readonly degradeReason?: string
  /** 耗时（毫秒）。 */
  readonly latencyMs: number
}

/** 评分后端接口。 */
export interface TierScorer {
  readonly kind: 'local-container' | 'external-endpoint' | 'heuristic'
  /** 是否可用（未配置/未就绪时为 false ⇒ 直接降级，不发请求）。 */
  available(): boolean
  /** 真正打分（不含超时控制，超时由调用方统一管）。 */
  score(input: ScoringInput, signal: AbortSignal): Promise<{ tier: Tier; confidence: number }>
}

/** 评分输入。 */
export interface ScoringInput extends HeuristicInput {
  /** 最近几轮对话的简短上下文（评分模型要看到"这是在什么场景下说的"）。 */
  readonly recentContext?: string
}

/** 评分提示词（模型路由.MD §4.1/§4.2/§4.3）。 */
export interface ScoringPrompt {
  readonly system: string
  readonly userTemplate: (input: ScoringInput) => string
  readonly maxTokens: number
}

/**
 * 默认评分提示词。
 *
 * **系统提示固定不变**是实现 §8.1「KV 缓存复用」的前提：
 * 只有用户消息变化，系统提示的 KV 才能被反复命中。
 * 所以这里刻意不给系统提示加任何动态内容（时间、会话 id 都不行）。
 *
 * @returns 提示词三件套。
 */
export function defaultScoringPrompt(): ScoringPrompt {
  const maxTokens = defaultFor<number>('router.scorer.maxTokens')
  return {
    system: [
      '你是复杂度评分器。判断用户这条消息需要多强的模型来处理。',
      '',
      '档位定义：',
      '- L1：闲聊、招呼、简单事实问答、纯情绪表达。不需要推理或规划。',
      '- L2：一般任务。需要一些分析、多步思考，但不需要深度规划。',
      '- L3：复杂任务。需要架构设计、长链推理、代码重构、多步规划、权衡取舍。',
      '',
      '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：',
      '{"tier":"L1|L2|L3","confidence":0.0-1.0}',
      '',
      'confidence 是你对判断的把握：明显场景给 0.9 以上，模棱两可给 0.5 左右。',
    ].join('\n'),
    userTemplate: (input) => {
      const parts = [`消息：${input.text}`]
      if (input.recentContext !== undefined && input.recentContext !== '') parts.push(`最近上下文：${input.recentContext}`)
      if (input.estimatedToolChain !== undefined) parts.push(`预估工具链步数：${String(input.estimatedToolChain)}`)
      return parts.join('\n')
    },
    maxTokens,
  }
}

/**
 * 严格解析评分输出（模型路由.MD §4.3 输出约束）。
 *
 * 容忍三种常见偏差（模型不是编译器，硬要求"绝对干净"只会让降级率飙升）：
 *  ① 外面包了 markdown 代码块；
 *  ② 前后有多余文字（抓第一个 `{...}`）；
 *  ③ confidence 写成字符串或百分数。
 *
 * 但**档位必须合法** —— 非法档位一律判为解析失败（宁可降级，不要瞎猜）。
 *
 * @param raw - 模型原始输出。
 * @returns 解析结果，或 undefined（解析失败）。
 */
export function parseScoringOutput(raw: string): { tier: Tier; confidence: number } | undefined {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const record = parsed as Record<string, unknown>
  const rawTier = String(record['tier'] ?? '').trim().toUpperCase()
  if (rawTier !== 'L1' && rawTier !== 'L2' && rawTier !== 'L3') return undefined

  let confidence = 0.5
  const rawConfidence = record['confidence']
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) confidence = rawConfidence
  else if (typeof rawConfidence === 'string') {
    const numeric = Number(rawConfidence.replace('%', ''))
    if (Number.isFinite(numeric)) confidence = rawConfidence.includes('%') ? numeric / 100 : numeric
  }
  // 夹到合法区间：模型偶尔给 1.5 或 -0.2，那是噪音不是信号
  confidence = Math.max(0, Math.min(1, confidence))
  return { tier: rawTier as Tier, confidence }
}

/** HTTP 评分后端的配置。 */
export interface HttpScorerOptions {
  /** 服务地址（OpenAI 兼容的 `/v1/chat/completions`）。 */
  readonly baseUrl: string
  readonly model?: string
  /** 系统提示（固定不变 ⇒ KV 缓存友好）。 */
  readonly prompt?: ScoringPrompt
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
}

/** 基于 OpenAI 兼容 HTTP 接口的评分后端（本地容器与外挂端点共用这一份实现）。 */
export class HttpTierScorer implements TierScorer {
  readonly kind: 'local-container' | 'external-endpoint'
  private readonly options: HttpScorerOptions
  private readonly prompt: ScoringPrompt

  constructor(kind: 'local-container' | 'external-endpoint', options: HttpScorerOptions) {
    this.kind = kind
    this.options = options
    this.prompt = options.prompt ?? defaultScoringPrompt()
  }

  available(): boolean {
    return this.options.baseUrl.trim() !== ''
  }

  async score(input: ScoringInput, signal: AbortSignal): Promise<{ tier: Tier; confidence: number }> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model ?? defaultFor<string>('router.scorer.model'),
        messages: [
          { role: 'system', content: this.prompt.system },
          { role: 'user', content: this.prompt.userTemplate(input) },
        ],
        max_tokens: this.prompt.maxTokens,
        temperature: 0,
        // 约束解码：优先用服务端支持的语法约束（vLLM 的 guided_json）
        ...(defaultFor<boolean>('router.scorer.prefixCache') ? { guided_json: { type: 'object', properties: { tier: { enum: ['L1', 'L2', 'L3'] }, confidence: { type: 'number' } }, required: ['tier'] } } : {}),
      }),
      signal,
    })
    if (!response.ok) throw new Error(`评分端点返回 HTTP ${String(response.status)}`)
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content ?? ''
    const parsed = parseScoringOutput(content)
    if (parsed === undefined) throw new Error(`评分输出无法解析：${content.slice(0, 80)}`)
    return parsed
  }
}

/** 启发式"后端"：把第三层包装成同一个接口，让降级路径与主路径同形。 */
export class HeuristicTierScorer implements TierScorer {
  readonly kind = 'heuristic' as const

  available(): boolean {
    return true
  }

  async score(input: ScoringInput): Promise<{ tier: Tier; confidence: number }> {
    const result = heuristicScore(input)
    // 启发式的"置信度"语义与模型不同：它不是"我有多确定"，而是"这个分数离阈值有多远"。
    // 取 0.55 是刻意的保守值：**低于低置信度阈值(0.6) ⇒ 一定会触发"升一档"** ——
    // 降级路径本来就该更保守（我们不知道它在复杂还是简单，多花点 token 比答错好）。
    const distance = Math.min(Math.abs(result.score - 0.35), Math.abs(result.score - 0.7))
    return { tier: result.tier, confidence: result.score === 0 ? 0.3 : Math.min(0.55, 0.4 + distance) }
  }
}
