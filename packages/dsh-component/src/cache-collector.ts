/**
 * 会话事件 → 缓存用量的采集器。
 *
 * ## 为什么单独一个模块
 *
 * 事件形状是**宿主的事实**（`assistant/message` 带 `usage`），而"怎么归因、怎么落库"
 * 是我们的策略。把两者分开，宿主改了事件形状时只需要改 `extractUsage()` 一个函数，
 * 而它有 6 条测试盯着 —— 不用去动归因逻辑。
 *
 * ## 为什么容忍多种形状
 *
 * 我们已经核实 `assistant/message` 事件带 `usage?: TokenUsage`，
 * 但**未来版本可能改**。这里按"能取到就记"的宽容策略：
 * 取不到就跳过（不报错、不写垃圾行），并在第一次遇到未知形状时记一条审计，
 * 这样"采集突然没数据了"这件事是**可见**的，而不是静默失效。
 *
 * @module forlife-memory/cache-collector
 */
import { attributeMiss, isMiss, type PrefixChangeEvent, type UsageSample } from '@forlife/memory-core'
import { cacheUsageCount, recordCacheUsage, setMissReason } from '@forlife/store'
import type { DatabaseSync } from 'node:sqlite'

/** 从会话事件里取出的用量。 */
export interface ExtractedUsage {
  readonly usage: UsageSample & { readonly turn?: number; readonly step?: number }
  readonly sessionId?: string
}

/** 判断是不是"带用量的助手消息事件"。 */
export function isUsageEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const record = event as Record<string, unknown>
  const type = record['type']
  return type === 'assistant/message' || type === 'assistant/attempt'
}

/**
 * 从会话事件里抽出用量。
 *
 * @param event - 会话事件。
 * @param sessionId - 会话 id（可选，用于关联）。
 * @returns 抽出的用量，或 undefined（该事件不带用量）。
 */
export function extractUsage(event: unknown, sessionId?: string): ExtractedUsage | undefined {
  if (!isUsageEvent(event)) return undefined
  const record = event as Record<string, unknown>
  const usage = (record['usage'] ?? (record['message'] as Record<string, unknown> | undefined)?.['usage']) as
    | Record<string, unknown>
    | undefined
  if (usage === undefined || typeof usage !== 'object') return undefined

  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const inputTokens = num(usage['inputTokens'])
  const outputTokens = num(usage['outputTokens'])
  const cacheReadTokens = num(usage['cacheReadTokens'])
  const cacheWriteTokens = num(usage['cacheWriteTokens'])
  // 四个都是 0 ⇒ 适配器没报账，记了也没意义
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined

  const optional = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const reasoning = optional(usage['reasoningTokens'])
  const turn = optional(record['turn'])
  const step = optional(record['step'])
  const at = typeof record['at'] === 'string' ? record['at'] : new Date().toISOString()

  return {
    usage: {
      at,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** 收集"前缀变更事件"（压缩与提示词编辑），用于未命中归因。 */
export function collectPrefixChanges(db: DatabaseSync, sinceHours = 24): readonly PrefixChangeEvent[] {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString()
  const changes: PrefixChangeEvent[] = []

  // 压缩：以 `compaction_runs` 里**已提交**的事务为准，而不是 `compaction_log`。
  // 理由：log 是"裁决与结果"的业务记录，runs 是"动手前后"的事务记录 ——
  // 只有 committed 的那些真的改变了前缀（aborted 的改动已被回滚）。
  const compactions = db
    .prepare("SELECT ended_at FROM compaction_runs WHERE phase = 'committed' AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at")
    .all(since) as unknown as { ended_at: string }[]
  for (const row of compactions) changes.push({ kind: 'compaction', at: row.ended_at })

  // 提示词编辑：只算**用户/模型改的**，内置默认值播种不算（它发生在首次调用之前）
  const edits = db
    .prepare("SELECT created_at FROM prompt_revisions WHERE created_by != 'system' AND created_at >= ? ORDER BY created_at")
    .all(since) as unknown as { created_at: string }[]
  for (const row of edits) changes.push({ kind: 'prompt-edit', at: row.created_at })

  return changes.sort((a, b) => a.at.localeCompare(b.at))
}

/** 采集结果。 */
export interface CollectResult {
  readonly recorded: boolean
  readonly id?: string
  readonly missReason?: string | null
}

/**
 * 采集一条会话事件（幂等：同一条事件重复投递不会写两次）。
 *
 * @param db - 数据库。
 * @param event - 会话事件。
 * @param options - 会话 id 与归因窗口。
 * @returns 采集结果。
 */
export function collectUsageFromEvent(
  db: DatabaseSync,
  event: unknown,
  options: { readonly sessionId?: string; readonly windowMs?: number } = {},
): CollectResult {
  const extracted = extractUsage(event, options.sessionId)
  if (extracted === undefined) return { recorded: false }

  const { usage } = extracted
  const firstSample = cacheUsageCount(db) === 0
  const changes = collectPrefixChanges(db)
  const missReason = attributeMiss(usage, {
    changes,
    isFirstSample: firstSample,
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
  })

  const id = recordCacheUsage(db, {
    sessionId: options.sessionId ?? null,
    turn: usage.turn ?? null,
    step: usage.step ?? null,
    at: usage.at,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    source: 'session',
    missReason,
  })

  // 归因是"算出来的"而不是"插入时定死的"：将来重算归因时这条不用重写
  if (missReason === null && isMiss(usage)) setMissReason(db, id, null)
  return { recorded: true, id, missReason }
}
