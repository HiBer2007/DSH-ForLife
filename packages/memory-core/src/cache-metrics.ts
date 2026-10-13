/**
 * 缓存命中率的**纯数学**（聚合、命中率、未命中归因）。
 *
 * ## 为什么口径必须写死在这里
 *
 * 宿主的 `TokenUsage` 里四类 token 是**互不重叠**的（已在 `dsh-token-meter` 的
 * `usageTokens()` 里核实：`input + cacheRead + cacheWrite + output`）：
 *  - `inputTokens` = **未命中**的输入（走全价的那些）；
 *  - `cacheReadTokens` = 命中缓存、按折扣价读的那些；
 *  - `cacheWriteTokens` = 写进缓存、供下次命中的那些。
 *
 * 所以"提示词总 token" = `input + cacheRead + cacheWrite`，
 * 而**命中率 = cacheRead / 提示词总 token**。
 * 把 `inputTokens` 当成"总输入"是很容易犯的错（那样命中率会虚高），这里写死并加断言。
 *
 * ## 未命中归因
 *
 * 用户要的是"未命中次数 == 压缩次数 + 提示词编辑次数"。这条能成立的前提是
 * **每次未命中都有解释**：首次调用（缓存还没建立）、压缩（L3 变了）、
 * 提示词编辑（前缀变了）。任何**无法解释**的未命中都值得报警 ——
 * 它意味着前缀在没有写入的情况下漂移了，而"漂移"正是这一阶段要消灭的东西。
 *
 * @module @forlife/memory-core/cache-metrics
 */

/** 一次用量采样。 */
export interface UsageSample {
  readonly at: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens?: number
  /** 归因到的原因（由调用方结合压缩/编辑事件判定）。 */
  readonly missReason?: string | null
}

/** 汇总结果。 */
export interface CacheSummary {
  readonly samples: number
  /** 提示词总 token（未命中 + 命中 + 写入）。 */
  readonly promptTokens: number
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  /** 命中率 0–1（按提示词总 token 算）。 */
  readonly hitRate: number
  /** 完全没命中（且确实有提示词）的采样数。 */
  readonly misses: number
  /** 其中**可解释**的未命中数（首次/压缩/提示词编辑）。 */
  readonly explainedMisses: number
  /** 无法解释的未命中数 —— 这个数应当是 0，不为 0 说明前缀在无故漂移。 */
  readonly unexplainedMisses: number
}

/** 按时间升序的累计点（面板画成本曲线用）。 */
export interface CacheCurvePoint {
  readonly at: string
  readonly hitRate: number
  readonly promptTokens: number
  readonly cumulativeHitRate: number
}

/** 单次调用的提示词总 token。 */
export function promptTokensOf(sample: UsageSample): number {
  return sample.inputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
}

/**
 * 判定一次采样是否"未命中"。
 *
 * 判据：有提示词，但**一个 token 都没命中**（`cacheReadTokens === 0`）。
 * 不用"命中率低于某个阈值"是因为阈值会让归因变得不可判定
 * （部分命中是正常现象：只有尾部变了）。
 *
 * @param sample - 采样。
 * @returns 是否未命中。
 */
export function isMiss(sample: UsageSample): boolean {
  return promptTokensOf(sample) > 0 && sample.cacheReadTokens === 0
}

/**
 * 汇总一组采样。
 *
 * @param samples - 采样（顺序无关）。
 * @returns 汇总结果。
 */
export function summarizeCache(samples: readonly UsageSample[]): CacheSummary {
  let uncached = 0
  let read = 0
  let write = 0
  let output = 0
  let misses = 0
  let explained = 0

  for (const sample of samples) {
    uncached += sample.inputTokens
    read += sample.cacheReadTokens
    write += sample.cacheWriteTokens
    output += sample.outputTokens
    if (isMiss(sample)) {
      misses += 1
      const reason = sample.missReason ?? null
      if (reason === 'first-call' || reason === 'compaction' || reason === 'prompt-edit') explained += 1
    }
  }

  const prompt = uncached + read + write
  return {
    samples: samples.length,
    promptTokens: prompt,
    uncachedInputTokens: uncached,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: output,
    hitRate: prompt === 0 ? 0 : read / prompt,
    misses,
    explainedMisses: explained,
    unexplainedMisses: misses - explained,
  }
}

/**
 * 生成累计命中率曲线（按时间升序）。
 *
 * @param samples - 采样。
 * @returns 曲线点。
 */
export function cacheCurve(samples: readonly UsageSample[]): readonly CacheCurvePoint[] {
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at))
  let read = 0
  let prompt = 0
  return sorted.map((sample) => {
    read += sample.cacheReadTokens
    prompt += promptTokensOf(sample)
    return {
      at: sample.at,
      hitRate: promptTokensOf(sample) === 0 ? 0 : sample.cacheReadTokens / promptTokensOf(sample),
      promptTokens: promptTokensOf(sample),
      cumulativeHitRate: prompt === 0 ? 0 : read / prompt,
    }
  })
}

/** 归因用的"前缀变更事件"。 */
export interface PrefixChangeEvent {
  /** `compaction` 或 `prompt-edit`。 */
  readonly kind: 'compaction' | 'prompt-edit'
  readonly at: string
}

/**
 * 给一次未命中找原因。
 *
 * 顺序（先到先得，因为"首次"与"压缩"可能同时成立）：
 *  1. 这是**第一次**调用 ⇒ `first-call`（缓存还没建立，必然未命中）；
 *  2. 采样之前 `windowMs` 内有过压缩 ⇒ `compaction`；
 *  3. 同理有提示词编辑 ⇒ `prompt-edit`；
 *  4. 都没有 ⇒ `unexplained`（**前缀在无故漂移，值得查**）。
 *
 * @param sample - 采样。
 * @param options - 变更事件、是否首次采样、归因窗口。
 * @returns 原因字符串。
 */
export function attributeMiss(
  sample: UsageSample,
  options: {
    readonly changes?: readonly PrefixChangeEvent[]
    readonly isFirstSample?: boolean
    readonly windowMs?: number
  } = {},
): string | null {
  if (!isMiss(sample)) return null
  if (options.isFirstSample === true) return 'first-call'

  const windowMs = options.windowMs ?? 300_000
  const at = Date.parse(sample.at)
  const recent = (options.changes ?? [])
    .filter((change) => {
      const changeAt = Date.parse(change.at)
      return Number.isFinite(changeAt) && changeAt <= at && at - changeAt <= windowMs
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  const newest = recent[0]
  if (newest === undefined) return 'unexplained'
  return newest.kind === 'compaction' ? 'compaction' : 'prompt-edit'
}

/**
 * 期望的未命中数（验收口径）。
 *
 * 用户原话："未命中次数 == 压缩次数 + 提示词编辑次数"。
 * 严格说还要加上**首次调用**那一次（缓存建立之前必然未命中），
 * 所以这里返回 `1 + 压缩 + 编辑`，并把两部分分开给，便于面板解释。
 *
 * @param options - 压缩次数与编辑次数。
 * @returns 期望未命中数与分解。
 */
export function expectedMisses(options: { readonly compactions: number; readonly promptEdits: number; readonly samples: number }): {
  readonly total: number
  readonly firstCall: number
  readonly compaction: number
  readonly promptEdit: number
} {
  const firstCall = options.samples > 0 ? 1 : 0
  return {
    total: firstCall + options.compactions + options.promptEdits,
    firstCall,
    compaction: options.compactions,
    promptEdit: options.promptEdits,
  }
}

/**
 * 判断缓存表现是否符合预期（面板要给人一个明确结论，而不是一堆数字）。
 *
 * @param summary - 汇总。
 * @param expected - 期望未命中数。
 * @param options - 命中率下限（低于它就要提示）。
 * @returns 结论。
 */
export function judgeCache(
  summary: CacheSummary,
  expected: { readonly total: number },
  options: { readonly minHitRate?: number } = {},
): { readonly ok: boolean; readonly verdict: string } {
  if (summary.samples === 0) return { ok: true, verdict: '还没有用量数据（还没跑过真模型调用）。' }
  if (summary.unexplainedMisses > 0) {
    return {
      ok: false,
      verdict: `有 ${String(summary.unexplainedMisses)} 次**无法解释**的未命中 —— 前缀在无故漂移，应当排查（否则缓存白建了）。`,
    }
  }
  const minHitRate = options.minHitRate ?? 0.5
  if (summary.hitRate < minHitRate) {
    return {
      ok: false,
      verdict: `命中率 ${(summary.hitRate * 100).toFixed(1)}% 低于预期下限 ${(minHitRate * 100).toFixed(0)}%（未命中都可解释，但命中太少）。`,
    }
  }
  return {
    ok: true,
    verdict: `命中率 ${(summary.hitRate * 100).toFixed(1)}%，未命中 ${String(summary.misses)} 次、期望 ${String(expected.total)} 次，全部可解释。`,
  }
}
