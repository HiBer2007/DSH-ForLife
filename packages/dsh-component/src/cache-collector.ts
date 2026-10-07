/**
 * 会话事件 → 缓存用量的采集器。
 *
 * ## 事件形状是**宿主的事实**（下面每条都在测试里加了源码守卫）
 *
 * `session/event` 给的是**信封**：`{ type, seq, time, data }` —— **载荷在 `data` 里**：
 *  - `@deepseek-ai/dsh-session/lib/index.js` 的 `append()` 组装的就是
 *    `deepFreeze({ type, seq, time, data: dataSnapshot, ...surfaceMetadata })`；
 *  - `@deepseek-ai/dsh-agent-loop/lib/index.js` 把账放进 **`append()` 的第二个参数**
 *    （`session.append('assistant/message', { turn, step, message, usage, stream })`）
 *    ⇒ 于是落在 `event.data.usage`；
 *  - 第一方消费者 `@deepseek-ai/dsh-token-meter` 的 `usageOf()` 读的正是
 *    `event.data.usage` / `event.data.stream`。
 *
 * ⚠️ **曾经这里读的是顶层** `event.usage` / `event.message.usage` ——
 * 那是"想象中的形状"，生产里一个都取不到 ⇒ `cache_metrics` 永远是空的，
 * 而测试全绿（测试喂的也是那个想象形状）。
 * 所以现在**只认宿主形状**：顶层平铺的 `usage` 一律**不接收**
 * （"宽容地接受想象形状"正是这个 bug 能活下来的原因 —— 见
 * `docs/audit/PLAN_FIDELITY_AUDIT.md` §7.3）。
 *
 * ## `data` 里的两个位置：与宿主**同口径**，不是自创
 *
 *  - `assistant/message`：`data.usage` 优先，退化到 `data.stream` 里最后一条 `usage` chunk；
 *  - `assistant/attempt`：宿主的 `SessionEventMap` 里它**没有** `usage` 字段 ——
 *    账**只在** stream 里。而重试/取消的尝试照样计费（`dsh-headless` 的原话：
 *    "A retried attempt keeps its usage only in its `assistant/attempt` stream"），
 *    只读 `data.usage` 会低报。
 *
 * 这段口径与 `dsh-token-meter/lib/types/usage-projection.js` 的 `usageOf()` 一字不差；
 * 宿主改了读法，我们的形状守卫测试会先变红。
 *
 * ## 绝不抛异常
 *
 * 这个采集器跑在**每一次会话事件**上：任何形状问题都只能表现为"这条不记"，
 * 绝不能把异常抛回宿主的 `session/event` 分发器。
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

/** 收窄成普通对象（数组不算 —— 信封与载荷都是对象）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 判断是不是"可能带用量的助手结算事件"。
 *
 * 只认**类型**；能不能真取到账由 {@link extractUsage} 决定
 * （`assistant/attempt` 的账只在 stream 里，不是每个 attempt 都报账）。
 *
 * @param event - 会话事件（宿主的 `session/event` 信封）。
 * @returns 是否可能是带用量的事件。
 */
export function isUsageEvent(event: unknown): boolean {
  try {
    const type = asRecord(event)?.['type']
    return type === 'assistant/message' || type === 'assistant/attempt'
  } catch {
    return false
  }
}

/**
 * 从 `data.stream` 里取**最后一条** `usage` chunk 的用量。
 *
 * 等价于宿主的 `lastAssistantStreamChunk(stream, 'usage')?.usage`
 * （`@deepseek-ai/dsh-llm/lib/types/assistant-stream.js`）：
 * 倒着扫、**停在第一条命中的 `usage` chunk 上**（哪怕它载荷是坏的也不回头找更早的）——
 * 与宿主完全一致，免得我们的账目和宿主的对不上。
 *
 * @param stream - `assistant/message` / `assistant/attempt` 的 `data.stream`。
 * @returns 用量（拿不到就 undefined）。
 */
function usageFromStream(stream: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = asRecord(stream[index])
    if (record === undefined || record['type'] !== 'chunk') continue
    const chunk = asRecord(record['chunk'])
    if (chunk === undefined || chunk['type'] !== 'usage') continue
    return asRecord(chunk['usage'])
  }
  return undefined
}

/**
 * 取一条助手结算事件 `data` 里的用量（宿主口径：`data.usage` 优先，stream 退化）。
 *
 * @param data - 事件的载荷。
 * @returns 用量（拿不到就 undefined）。
 */
function usageOfData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(data['usage']) ?? usageFromStream(data['stream'])
}

/**
 * 把宿主信封的 `time`（`Date.now()` 毫秒）转成 ISO 串。
 *
 * @param time - 信封的 `time` 字段。
 * @returns ISO 时间串（不是合法时间就 undefined）。
 */
function isoFromTime(time: unknown): string | undefined {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return undefined
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/**
 * 从会话事件里抽出用量（真实现；异常由 {@link extractUsage} 兜住）。
 *
 * @param event - 会话事件。
 * @param sessionId - 会话 id（可选，用于关联）。
 * @returns 抽出的用量，或 undefined（该事件不带用量）。
 */
function extractUsageInner(event: unknown, sessionId?: string): ExtractedUsage | undefined {
  if (!isUsageEvent(event)) return undefined
  const envelope = asRecord(event)
  const data = asRecord(envelope?.['data'])
  // ★ 只认宿主形状：`session/event` 的信封把载荷放在 `data` 里。
  // 顶层平铺的 `usage` / `message.usage` **故意不接收**（见模块注释）。
  if (data === undefined) return undefined
  const usage = usageOfData(data)
  if (usage === undefined) return undefined

  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const inputTokens = num(usage['inputTokens'])
  const outputTokens = num(usage['outputTokens'])
  const cacheReadTokens = num(usage['cacheReadTokens'])
  const cacheWriteTokens = num(usage['cacheWriteTokens'])
  // 四个都是 0 ⇒ 适配器没报账，记了也没意义
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined

  const optional = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const reasoning = optional(usage['reasoningTokens'])
  const turn = optional(data['turn'])
  const step = optional(data['step'])
  // 时间取**宿主信封的 `time`**（事件发生时刻），而不是"我们处理的时刻"：
  // 归因要拿它跟压缩/提示词编辑的时间比，用处理时刻会让窗口判定偏。
  const at = isoFromTime(envelope?.['time']) ?? new Date().toISOString()

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

/**
 * 从会话事件里抽出用量。
 *
 * **绝不抛异常**：这个采集器跑在每一次会话事件上，任何形状问题都只能表现为"这条不记"。
 * 形状事实（`{type, seq, time, data}` 信封、`data.usage` / `data.stream`）见模块注释，
 * 并有源码守卫测试盯着。
 *
 * @param event - 会话事件（宿主 `session/event` 的信封）。
 * @param sessionId - 会话 id（可选，用于关联）。
 * @returns 抽出的用量，或 undefined（该事件不带用量 / 形状不认识）。
 */
export function extractUsage(event: unknown, sessionId?: string): ExtractedUsage | undefined {
  try {
    return extractUsageInner(event, sessionId)
  } catch {
    return undefined
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
 * 采集一条会话事件。
 *
 * ⚠️ **不幂等**：`session/event` 每条投递一次，同一条事件重复投递会写两行
 * （`recordCacheUsage` 是普通 INSERT，表上也没有唯一约束）。
 * 采集器不自己造去重键 —— 那需要一个宿主侧稳定的事件 id，而信封没有
 * （`seq` 只在单个会话内唯一）。真要重放补数据，调用方必须先自己想清去重口径。
 *
 * @param db - 数据库。
 * @param event - 会话事件（宿主 `session/event` 的信封 `{type, seq, time, data}`）。
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
