/**
 * 压缩协议的**纯逻辑层**：裁决（PLAN §4.4）、输出解析与质量约束（§4.2/§4.3）、
 * 碎片规划（§5.3）。
 *
 * 这一层不碰数据库、不碰网络、不读时钟 —— 所有输入都由调用方传入，
 * 因此"阈值逐字段一致"可以用测试钉死。
 *
 * @module @forlife/memory-core/compaction
 */
import { defaultFor } from '@forlife/contracts'
import { estimateTokens } from './tokens.ts'

// ── §4.4 约束裁决 ───────────────────────────────────────────────────────────

/** 裁决输入：当前状态 + 距上次压缩的增量。 */
export interface CompactionStats {
  /** 短期记忆当前 token 数。 */
  readonly shortTokens: number
  /** 自上次压缩以来的轮次数。 */
  readonly turnsSinceLast: number
  /** 自上次压缩以来的工具调用次数。 */
  readonly toolCallsSinceLast: number
  /** 自上次压缩以来的 token 增量。 */
  readonly tokenDeltaSinceLast: number
  /** 距上次压缩的真实时间（毫秒）。 */
  readonly timeSinceLastMs: number
  /** 短期记忆占上下文上限的比例（0–1）。 */
  readonly shortRatio: number
  /**
   * 此前是否成功压缩过。
   *
   * 为 `false` 时冷却期**整体不适用** —— "距上次压缩的轮次/时间/增量"在从未压缩过时没有意义
   * （否则第一次压缩会被冷却期永远卡住，而这正是最需要压缩的时候）。
   */
  readonly hasPreviousCompaction?: boolean
}

/** 拒绝原因码。 */
export type CompactionRejectionReason = 'too_thin' | 'too_frequent'

/** 裁决结果（拒绝时字段与 PLAN §4.4 的反馈 JSON 逐字段一致）。 */
export interface CompactionVerdict {
  readonly approved: boolean
  readonly reason?: CompactionRejectionReason
  readonly current: { readonly tokens: number; readonly turns: number; readonly tool_calls: number }
  readonly required: { readonly tokens: number; readonly turns: number; readonly tool_calls: number }
  readonly hint?: string
  /** 命中的豁免（供日志与面板解释"为什么这次能过"）。 */
  readonly waiver?: 'token_threshold' | 'context_pressure'
}

/** 生效阈值（全部来自保真度基线）。 */
export interface CompactionThresholds {
  readonly minTokens: number
  readonly minTurns: number
  readonly minToolCalls: number
  readonly waiveMinTurnsAboveTokens: number
  readonly cooldownTurns: number
  readonly cooldownMs: number
  readonly cooldownTokenDelta: number
  readonly emergencyBypassRatio: number
}

/** 从基线取阈值（不传则用默认；测试可注入）。 */
export function defaultCompactionThresholds(): CompactionThresholds {
  return {
    minTokens: defaultFor<number>('compaction.minTokens'),
    minTurns: defaultFor<number>('compaction.minTurns'),
    minToolCalls: defaultFor<number>('compaction.minToolCalls'),
    waiveMinTurnsAboveTokens: defaultFor<number>('compaction.waiveMinTurnsAboveTokens'),
    cooldownTurns: defaultFor<number>('compaction.cooldownTurns'),
    cooldownMs: defaultFor<number>('compaction.cooldownMs'),
    cooldownTokenDelta: defaultFor<number>('compaction.cooldownTokenDelta'),
    emergencyBypassRatio: defaultFor<number>('compaction.emergencyBypassRatio'),
  }
}

/**
 * 裁决一次压缩请求（**模型自主压缩的约束由系统执行**）。
 *
 * 判定顺序刻意如此：先看豁免（占比过高 → 冷却失效），再看"太薄"，最后看冷却。
 * 否则"上下文快满了但刚压缩过"会被冷却期卡死，那是危险的。
 *
 * @param stats - 当前状态与增量。
 * @param options - 阈值覆盖。
 * @returns 裁决结果。
 */
export function decideCompaction(
  stats: CompactionStats,
  options: { readonly thresholds?: CompactionThresholds } = {},
): CompactionVerdict {
  const t = options.thresholds ?? defaultCompactionThresholds()
  const current = { tokens: stats.shortTokens, turns: stats.turnsSinceLast, tool_calls: stats.toolCallsSinceLast }
  const required = { tokens: t.minTokens, turns: t.minTurns, tool_calls: t.minToolCalls }

  // ── 豁免 1：短期占比 ≥ 75% ⇒ 强制绕过冷却期（PLAN §4.4）
  const pressure = stats.shortRatio >= t.emergencyBypassRatio

  // ── 最小内容阈值（防太薄）
  const tokenOk = stats.shortTokens >= t.minTokens
  // 豁免 2：token ≥ 6000 绕过轮次约束
  const turnWaived = stats.shortTokens >= t.waiveMinTurnsAboveTokens
  const turnsOk = turnWaived || stats.turnsSinceLast >= t.minTurns
  const toolsOk = stats.toolCallsSinceLast >= t.minToolCalls

  if (!tokenOk || !turnsOk || !toolsOk) {
    // 占比告急时即便"薄"也放行：宁可压缩得薄一点，也不能让上下文爆掉
    if (!pressure) {
      return {
        approved: false,
        reason: 'too_thin',
        current,
        required,
        hint: buildThinHint(current, required),
      }
    }
  }

  // ── 冷却期（防太密）—— 占比告急时整体绕过；从未压缩过时整体不适用
  if (!pressure && stats.hasPreviousCompaction !== false) {
    const turnsSinceOk = stats.turnsSinceLast >= t.cooldownTurns
    const timeOk = stats.timeSinceLastMs >= t.cooldownMs
    const deltaOk = stats.tokenDeltaSinceLast >= t.cooldownTokenDelta
    if (!turnsSinceOk || !timeOk || !deltaOk) {
      return {
        approved: false,
        reason: 'too_frequent',
        current,
        required,
        hint: buildCooldownHint(stats, t),
      }
    }
  }

  const waiver: CompactionVerdict['waiver'] = pressure
    ? 'context_pressure'
    : turnWaived
      ? 'token_threshold'
      : undefined
  return { approved: true, current, required, ...(waiver === undefined ? {} : { waiver }) }
}

/** 拒绝提示（"再完成至少 N 轮或累积 M token"）—— 字段来自 §4.4 的示例语义。 */
function buildThinHint(
  current: { tokens: number; turns: number; tool_calls: number },
  required: { tokens: number; turns: number; tool_calls: number },
): string {
  const turnsNeed = Math.max(0, required.turns - current.turns)
  const tokensNeed = Math.max(0, required.tokens - current.tokens)
  const toolsNeed = Math.max(0, required.tool_calls - current.tool_calls)
  if (turnsNeed > 0 || tokensNeed > 0) {
    return `再完成至少 ${String(turnsNeed)} 轮对话或累积 ${String(tokensNeed)} token 后可再次请求`
  }
  return `再完成至少 ${String(toolsNeed)} 次工具调用后可再次请求`
}

/** 冷却期拒绝提示：说清三个维度各差多少。 */
function buildCooldownHint(stats: CompactionStats, t: CompactionThresholds): string {
  const missing: string[] = []
  if (stats.turnsSinceLast < t.cooldownTurns) missing.push(`再 ${String(t.cooldownTurns - stats.turnsSinceLast)} 轮`)
  if (stats.timeSinceLastMs < t.cooldownMs) {
    missing.push(`再等 ${String(Math.ceil((t.cooldownMs - stats.timeSinceLastMs) / 1000))} 秒`)
  }
  if (stats.tokenDeltaSinceLast < t.cooldownTokenDelta) {
    missing.push(`再累积 ${String(t.cooldownTokenDelta - stats.tokenDeltaSinceLast)} token`)
  }
  return `距上次压缩太近：${missing.join('，')}；或等短期占比达到 ${String(Math.round(t.emergencyBypassRatio * 100))}% 后可强制压缩`
}

// ── §4.2 输出解析 + §4.3 质量约束 ───────────────────────────────────────────

/** 一条待写入中期记忆的条目。 */
export interface PushToMidEntry {
  readonly content: string
  readonly summary: string
  readonly entities: readonly string[]
  readonly importance: number
}

/** 模型输出的结构化决策。 */
export interface CompactionDecision {
  readonly push_to_mid: readonly PushToMidEntry[]
  readonly keep_in_short: readonly string[]
  readonly fragment_mid: readonly string[]
  readonly reasoning: string
}

/** 解析结果。 */
export type ParseDecisionResult =
  | { readonly ok: true; readonly decision: CompactionDecision; readonly warnings: readonly string[]; readonly dropped: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly raw: string }

/** §4.3 的硬违规（条目必须被丢弃，不能进记忆）。 */
const BACK_REFERENCE = /(见上文|如上所述|如前所述|见前面|同上|接上文|as (?:mentioned|described) above)/i
/** §4.3：禁止 push 纯工具调用记录。 */
const TOOL_RECORD = /^(\[?(tool|工具)\s*(call|调用|结果|result)|调用\s*\w+\s*工具)/i

/**
 * 解析并校验压缩输出。
 *
 * 容忍常见的模型包装（```json 代码块、前后说明文字），但**不接受**结构不合规的输出：
 * 宁可报错让上层重试，也不要写进半成品记忆。
 *
 * @param raw - 模型原始输出。
 * @returns 解析结果（含被丢弃条目与告警）。
 */
export function parseCompactionDecision(raw: string): ParseDecisionResult {
  const json = extractJsonObject(raw)
  if (json === undefined) return { ok: false, error: '输出里找不到 JSON 对象', raw }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${String(error)}`, raw }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'JSON 根节点不是对象', raw }
  const record = parsed as Record<string, unknown>

  const warnings: string[] = []
  const dropped: string[] = []

  // push_to_mid
  const push: PushToMidEntry[] = []
  const rawPush = record['push_to_mid']
  if (rawPush !== undefined && !Array.isArray(rawPush)) return { ok: false, error: 'push_to_mid 必须是数组', raw }
  for (const [index, item] of (rawPush ?? []).entries()) {
    if (typeof item !== 'object' || item === null) {
      dropped.push(`push_to_mid[${String(index)}]：不是对象`)
      continue
    }
    const entry = item as Record<string, unknown>
    const summary = typeof entry['summary'] === 'string' ? entry['summary'].trim() : ''
    const content = typeof entry['content'] === 'string' ? entry['content'].trim() : ''
    if (summary === '' && content === '') {
      dropped.push(`push_to_mid[${String(index)}]：summary 与 content 都为空`)
      continue
    }
    // §4.3 硬约束
    if (BACK_REFERENCE.test(summary) || BACK_REFERENCE.test(content)) {
      dropped.push(`push_to_mid[${String(index)}]：含指代（"见上文"类），不满足"可独立理解"`)
      continue
    }
    if (TOOL_RECORD.test(summary)) {
      dropped.push(`push_to_mid[${String(index)}]：疑似纯工具调用记录`)
      continue
    }
    const entitiesRaw = entry['entities']
    const entities = Array.isArray(entitiesRaw)
      ? entitiesRaw.filter((e): e is string => typeof e === 'string' && e.trim() !== '').slice(0, defaultFor<number>('fragment.maxEntities'))
      : []
    if (Array.isArray(entitiesRaw) && entitiesRaw.length > entities.length) {
      warnings.push(`push_to_mid[${String(index)}]：entities 超过 ${String(defaultFor<number>('fragment.maxEntities'))} 个，已截断`)
    }
    const importanceRaw = entry['importance']
    const importance =
      typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
        ? Math.min(1, Math.max(0, importanceRaw))
        : 0.5
    push.push({ content: content === '' ? summary : content, summary: summary === '' ? content : summary, entities, importance })
  }

  // keep_in_short
  const rawKeep = record['keep_in_short']
  if (rawKeep !== undefined && !Array.isArray(rawKeep)) return { ok: false, error: 'keep_in_short 必须是字符串数组', raw }
  const keep = (rawKeep ?? []).filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())

  // fragment_mid
  const rawFragment = record['fragment_mid']
  if (rawFragment !== undefined && !Array.isArray(rawFragment)) {
    return { ok: false, error: 'fragment_mid 必须是字符串数组', raw }
  }
  const fragment = (rawFragment ?? []).filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim())

  const reasoning = typeof record['reasoning'] === 'string' ? record['reasoning'].trim() : ''
  if (reasoning === '') warnings.push('缺少 reasoning（不阻塞，但会让压缩日志缺少理由）')

  // §4.3 明确允许 push 空列表 —— "压缩不等于必须产生中期记忆"
  return { ok: true, decision: { push_to_mid: push, keep_in_short: keep, fragment_mid: fragment, reasoning }, warnings, dropped }
}

/** 从可能带包装的输出里抠出第一个完整 JSON 对象。 */
export function extractJsonObject(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidate = fenced?.[1] ?? raw
  const start = candidate.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return undefined
}

/** 把 keep_in_short 渲染成替换用的摘要节点文本。 */
export function renderKeepInShort(keep: readonly string[], reasoning?: string): string {
  if (keep.length === 0) return '（上一段对话已被压缩；当前没有需要保留的进行中任务状态。）'
  const lines = ['（以下为压缩后的当前状态）', ...keep.map((k) => `- ${k}`)]
  if (reasoning !== undefined && reasoning !== '') lines.push(`压缩说明：${reasoning}`)
  return lines.join('\n')
}

// ── §5.3 碎片索引 ───────────────────────────────────────────────────────────

/** 一个可碎片化的候选（来自中期条目）。 */
export interface FragmentCandidate {
  readonly id: string
  readonly summary: string
  readonly entities: readonly string[]
  /** 碎片化**前**占用的 token（决定活跃池会释放多少）。 */
  readonly tokenCount: number
  /** 碎片化**后**将占用的 token（= hint 的 token 数，≤ 80）。不传则按 summary 现算。 */
  readonly hintTokens?: number
  readonly lastAccessedAt: string | null
  readonly createdAt: string
}

/** 碎片规划结果。 */
export interface FragmentationPlan {
  /** 建议碎片化的条目标题（按优先级排序）。 */
  readonly toFragment: readonly string[]
  /** 建议合并的碎片组（entities 重叠）。 */
  readonly mergeGroups: readonly (readonly string[])[]
  /** 建议淘汰（archived）的碎片 id。 */
  readonly toArchive: readonly string[]
  /** 为什么不做/做了什么的解释，进日志。 */
  readonly notes: readonly string[]
}

/**
 * 生成碎片提示（§5.3 的单条限制：`hint` ≤ 80 token，`entities` ≤ 5 个）。
 *
 * @param summary - 条目摘要。
 * @param entities - 关键词。
 * @returns 裁剪后的 hint 与 entities。
 */
export function makeFragmentHint(
  summary: string,
  entities: readonly string[],
): { readonly hint: string; readonly entities: readonly string[] } {
  const maxHint = defaultFor<number>('fragment.maxHintTokens')
  const maxEntities = defaultFor<number>('fragment.maxEntities')
  const kept = entities.filter((e) => e.trim() !== '').slice(0, maxEntities)

  let hint = summary.trim()
  if (estimateTokens(hint) > maxHint) {
    // 按 token 预算裁剪（CJK 与拉丁混排时按字符逐步退，保证不超）
    const chars = [...hint]
    while (chars.length > 0 && estimateTokens(chars.join('')) > maxHint) chars.pop()
    hint = `${chars.join('').trimEnd()}…`
  }
  return { hint, entities: kept }
}

/**
 * 规划碎片化（§5.3 的第 2/3/4 层限制）。
 *
 * @param candidates - 候选条目（通常是"最久未访问"的一批）。
 * @param stats - 当前 L3 统计（决定还能容纳多少碎片）。
 * @param options - 上限覆盖。
 * @returns 规划结果（只描述意图，不动数据）。
 */
export function planFragmentation(
  candidates: readonly FragmentCandidate[],
  stats: { readonly activeTokens: number; readonly fragmentTokens: number; readonly fragmentCount: number },
  options: { readonly maxCount?: number; readonly maxAreaRatio?: number } = {},
): FragmentationPlan {
  const maxCount = options.maxCount ?? defaultFor<number>('fragment.maxCount')
  const maxAreaRatio = options.maxAreaRatio ?? defaultFor<number>('fragment.maxAreaRatio')
  const notes: string[] = []

  const totalTokens = stats.activeTokens + stats.fragmentTokens
  const currentRatio = totalTokens === 0 ? 0 : stats.fragmentTokens / totalTokens
  if (stats.fragmentCount >= maxCount) {
    notes.push(`碎片已达绝对上限 ${String(maxCount)} 条，不再新增（应先淘汰或合并）`)
    return { toFragment: [], mergeGroups: [], toArchive: pickEvictions(candidates), notes }
  }
  if (currentRatio >= maxAreaRatio) {
    notes.push(
      `碎片占比 ${(currentRatio * 100).toFixed(1)}% 已达上限 ${(maxAreaRatio * 100).toFixed(0)}%，不再新增（应先淘汰或合并）`,
    )
    return { toFragment: [], mergeGroups: [], toArchive: pickEvictions(candidates), notes }
  }

  // 按 token 预算挑选：碎片化会**把条目的 token 数缩小成 hint 的 token 数**
  // （§5.3：碎片只留 hint ≤ 80 token，全文搬去长期记忆），
  // 所以这里必须按"缩小后"的规模算占比，否则大条目永远无法碎片化。
  const toFragment: string[] = []
  let projectedFragmentTokens = stats.fragmentTokens
  let projectedActiveTokens = stats.activeTokens
  for (const candidate of candidates) {
    const hintTokens = candidate.hintTokens ?? estimateTokens(makeFragmentHint(candidate.summary, candidate.entities).hint)
    const nextFragment = projectedFragmentTokens + hintTokens
    const nextActive = Math.max(0, projectedActiveTokens - candidate.tokenCount)
    const nextTotal = nextFragment + nextActive
    if (nextTotal === 0) break
    if (nextFragment / nextTotal > maxAreaRatio) {
      notes.push(`停在第 ${String(toFragment.length + 1)} 个候选：再碎片化会让占比超过 ${(maxAreaRatio * 100).toFixed(0)}%`)
      break
    }
    toFragment.push(candidate.id)
    projectedFragmentTokens = nextFragment
    projectedActiveTokens = nextActive
  }

  return {
    toFragment,
    mergeGroups: findMergeGroups(candidates),
    toArchive: [],
    notes,
  }
}

/** 找出 entities 重叠的碎片组（§5.3 合并规则）。 */
function findMergeGroups(candidates: readonly FragmentCandidate[]): readonly (readonly string[])[] {
  const groups: string[][] = []
  const used = new Set<string>()
  for (const a of candidates) {
    if (used.has(a.id)) continue
    const group = [a.id]
    for (const b of candidates) {
      if (b.id === a.id || used.has(b.id)) continue
      if (a.entities.some((e) => b.entities.includes(e))) {
        group.push(b.id)
        used.add(b.id)
      }
    }
    if (group.length > 1) {
      used.add(a.id)
      groups.push(group)
    }
  }
  return groups
}

/** 淘汰候选：最久未访问的碎片（§5.3 淘汰规则；具体泛化判断由上层做）。 */
function pickEvictions(candidates: readonly FragmentCandidate[], limit = 5): readonly string[] {
  return [...candidates]
    .sort((a, b) => (a.lastAccessedAt ?? a.createdAt).localeCompare(b.lastAccessedAt ?? b.createdAt))
    .slice(0, limit)
    .map((c) => c.id)
}


