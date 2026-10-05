/**
 * 记忆运行时：把"表 / 渲染 / 检索 / 预算"收成一个与框架无关的对象。
 *
 * **为什么与框架无关**：验收要求"渲染逐字节稳定""崩溃后可重建"这类性质，
 * 必须能在**不启动 DSH** 的情况下断言；同时宿主适配层（prompt/tools/api）只做薄封装。
 *
 * 渲染缓存是这里的关键设计（§2.3 / §10.2）：
 *  - 缓存键 = `epoch:revision`；
 *  - **相对年龄在缓存刷新时算一次并冻结** —— 否则每次装配都变，字节稳定性直接破产；
 *  - 只要没有写操作（revision 不变），返回的**就是同一个对象**，SHA-256 必然相同。
 *
 * @module forlife-memory/runtime
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import {
  getClockSuggestion,
  listModelRoutes,
  recordRoutingDecision,
  getConversationClock,
  listConversationClocks,
  setClockSuggestion,
  setConversationClock,
} from '@forlife/store'

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

import { probeDevices, switchMode, type DeviceProbe, type RunMode } from '@forlife/router'
import { getEndpoint, listEndpointProbes, recordEndpointHealth, recordEndpointProbe, recordModeSwitch, setEndpointMode } from '@forlife/store'

import { defaultClockConfig } from './clock-tools.ts'
import { activePrompt, type PromptSlug } from './prompt-store.ts'
import {
  appendMidEntry,
  bumpEpoch,
  getState as readState,
  setState as writeState,
  currentEpoch,
  currentRevision,
  fragmentMidEntry,
  getSpill,
  insertLongEntry,
  insertSpill,
  listRenderableMidEntries,
  listSpills,
  midStats,
  openDatabase,
  searchLongFts,
  searchMidFts,
  touchLongEntry,
  touchMidEntry,
  type LongEntryRow,
  type MidEntryRow,
  type OpenedDatabase,
} from '@forlife/store'
import {
  decideCompaction,
  estimateTokens,
  makeFragmentHint,
  planFragmentation,
  renderMidMemory,
  type RenderedView,
} from '@forlife/memory-core'
import { defaultFor } from '@forlife/contracts'

import type { ForlifeConfig } from './config.ts'

/** recall 预算状态（阶段 1 先做最小可用版；完整预算系统在阶段 4 落地）。 */
export interface RecallBudget {
  readonly maxPerTurn: number
  readonly maxPerCycle: number
  readonly maxResults: number
  readonly usedThisTurn: number
  readonly usedThisCycle: number
  readonly remainingThisTurn: number
  readonly remainingThisCycle: number
}

/** 一次 recall 的结果。 */
export interface RecallResult {
  readonly entries: readonly LongEntryRow[]
  readonly budget: RecallBudget
  readonly note?: string
}

/** 手动档位覆盖（可撤销）。 */
export interface TierOverride {
  readonly tier: 'L1' | 'L2' | 'L3'
  readonly reason: string
  readonly at: string
  readonly actor: string
}
/** 记忆运行时的构造参数。 */
export interface MemoryRuntimeOptions {
  readonly config: ForlifeConfig
  /** 数据库绝对路径（由调用方解析 `DSH_HOME` 后传入，运行时不做路径猜测）。 */
  readonly dbPath: string
  readonly log?: (message: string) => void
}

/** 记忆运行时。 */
export class MemoryRuntime {
  readonly db: OpenedDatabase['db']
  readonly dbPath: string
  private readonly opened: OpenedDatabase
  private readonly config: ForlifeConfig
  private readonly logger: (message: string) => void
  private cache: { readonly key: string; readonly view: RenderedView } | undefined
  /** 上下文上限（用于算"短期占比"）。配置优先，其次基线默认值。 */
  private get contextWindowTokens(): number {
    return this.config.contextWindowTokens > 0
      ? this.config.contextWindowTokens
      : defaultFor<number>('context.windowTokensDefault')
  }
  private turnsThisCycle = 1
  private recallThisTurn = 0
  private recallThisCycle = 0

  constructor(options: MemoryRuntimeOptions) {
    this.config = options.config
    this.logger = options.log ?? ((): void => {})
    this.dbPath = options.dbPath
    mkdirSync(dirname(this.dbPath), { recursive: true })
    this.opened = openDatabase({ file: this.dbPath, log: this.log })
    this.db = this.opened.db
    this.log(`记忆库已打开：${this.dbPath}`)
  }

  /** 迁移结果（诊断用）。 */
  appliedMigrations(): readonly number[] {
    return this.opened.applied
  }

  /** 当前压缩 epoch。 */
  epoch(): number {
    return currentEpoch(this.db)
  }

  /** 当前渲染修订号。 */
  revision(): number {
    return currentRevision(this.db)
  }

  /**
   * 取当前中期记忆区的渲染视图（带缓存）。
   *
   * 同一 `(epoch, revision)` 下**必然返回同一份字节**，这是"缓存断点"承诺的落点。
   */
  renderView(): RenderedView {
    const key = `${String(this.epoch())}:${String(this.revision())}`
    if (this.cache !== undefined && this.cache.key === key) return this.cache.view
    const entries = listRenderableMidEntries(this.db)
    const now = new Date() // 只在缓存刷新时取一次，随后冻结在文本里
    const view = renderMidMemory(entries, {
      header: this.config.l3Header,
      relativeAges: this.config.relativeAges,
      now,
    })
    this.cache = { key, view }
    return view
  }

  /** L2 段的文本（用户可编辑，直接来自配置）。 */
  l2Text(): string {
    return this.config.l2IndexText
  }

  /** 写一条中期记忆（append 协议：表 + 修订号同事务）。 */
  append(input: {
    /** 显式 id（压缩事务要**动手前**就知道 id 才能写回滚计划）；不传则自动生成。 */
    readonly id?: string
    readonly summary: string
    readonly content?: string
    readonly entities?: readonly string[]
    readonly sourceScope?: string | null
    readonly sourceShortIds?: readonly string[]
  }): { readonly id: string; readonly revision: number; readonly windowOffset: number; readonly tokenCount: number } {
    const id = input.id ?? `mid_${createHash('sha1').update(`${String(Date.now())}:${input.summary}`).digest('hex').slice(0, 12)}`
    const tokenCount = estimateTokens([input.summary, input.content ?? '', (input.entities ?? []).join(' ')].join(' '))
    const result = appendMidEntry(this.db, {
      id,
      summary: input.summary,
      content: input.content ?? null,
      entities: input.entities ?? [],
      tokenCount,
      sourceShortIds: input.sourceShortIds ?? [],
      sourceScope: input.sourceScope ?? null,
    })
    if (this.config.verbose) this.log(`追加中期记忆 ${id}（${String(tokenCount)} token，offset ${String(result.entry.window_offset)}）`)
    return { id, revision: result.revision, windowOffset: result.entry.window_offset, tokenCount }
  }

  /** 把一条中期记忆降级为碎片（指向长期记忆）。 */
  fragment(midId: string, longId: string, hint: string): number {
    const hintTokens = estimateTokens(hint)
    const maxHint = defaultFor<number>('fragment.maxHintTokens')
    if (hintTokens > maxHint) {
      // 写入方负责截断（PLAN §5.3 的四层长度限制），这里不静默放过
      throw new Error(`碎片 hint 超过上限：${String(hintTokens)} > ${String(maxHint)} token`)
    }
    return fragmentMidEntry(this.db, midId, longId, hint, hintTokens)
  }

  /** 检索长期记忆（阶段 1 用 FTS5；向量检索在阶段 5 接入）。 */
  recallLongterm(query: string, limit?: number): RecallResult {
    const maxResults = Math.min(
      limit ?? this.config.recallMaxResults,
      defaultFor<number>('recall.maxResultsHardCap'),
    )
    const maxPerTurn = this.config.recallMaxPerTurn
    const maxPerCycle = defaultFor<number>('recall.maxPerCycle')

    if (this.recallThisTurn >= maxPerTurn) {
      return {
        entries: [],
        budget: this.budget(maxPerTurn, maxPerCycle, maxResults),
        note: `本轮 recall 次数已达上限（${String(maxPerTurn)}）。如确有必要，可说明理由后申请追加额度（阶段 4 开放）。`,
      }
    }

    this.recallThisTurn += 1
    this.recallThisCycle += 1
    const entries = searchLongFts(this.db, query, maxResults)
    for (const entry of entries) touchLongEntry(this.db, entry.id)

    // 长期库还空时，退一步查中期记忆（避免"刚开始用什么都搜不到"的挫败感）
    if (entries.length === 0) {
      const mid = searchMidFts(this.db, query, maxResults)
      for (const entry of mid) touchMidEntry(this.db, entry.id)
      if (mid.length > 0) {
        return {
          entries: [],
          budget: this.budget(maxPerTurn, maxPerCycle, maxResults),
          note: `长期记忆无命中；中期记忆里有 ${String(mid.length)} 条相关，但它们已在当前上下文中，无需检索。`,
        }
      }
      return {
        entries: [],
        budget: this.budget(maxPerTurn, maxPerCycle, maxResults),
        note: '无命中。先判断这条信息是否真的可能存在，再决定是否换关键词；不要为确认而反复检索。',
      }
    }
    return { entries, budget: this.budget(maxPerTurn, maxPerCycle, maxResults) }
  }

  /** 取回被截断的大结果全文（PLAN §3.2）。 */
  recallFull(id: string): { readonly found: boolean; readonly content?: string; readonly meta?: { toolName: string; bytes: number; lines: number } } {
    const row = getSpill(this.db, id)
    if (row === undefined) return { found: false }
    return { found: true, content: row.content, meta: { toolName: row.tool_name, bytes: row.byte_size, lines: row.line_count } }
  }

  /** 存入一份大工具结果的全文（供未来的截断层调用）。 */
  spill(input: { readonly toolName: string; readonly content: string; readonly sessionId?: string; readonly toolCallId?: string }): { readonly id: string; readonly head: string } {
    const id = `spill_${createHash('sha1').update(`${input.toolName}:${String(Date.now())}:${input.content.slice(0, 64)}`).digest('hex').slice(0, 12)}`
    const row = insertSpill(this.db, {
      id,
      toolName: input.toolName,
      content: input.content,
      sessionId: input.sessionId ?? null,
      toolCallId: input.toolCallId ?? null,
    })
    return { id, head: row.head }
  }

  /** 推进压缩 epoch（压缩事务开始时调用；阶段 2 使用）。 */
  beginEpoch(): number {
    return bumpEpoch(this.db)
  }

  /** 统计（面板与诊断用）。 */
  stats(): {
    readonly epoch: number
    readonly revision: number
    readonly activeCount: number
    readonly fragmentCount: number
    readonly activeTokens: number
    readonly fragmentTokens: number
    readonly renderedTokens: number
    readonly renderedSha256: string
    readonly violations: readonly string[]
  } {
    const view = this.renderView()
    const mid = midStats(this.db)
    return {
      epoch: this.epoch(),
      revision: this.revision(),
      ...mid,
      renderedTokens: view.tokenEstimate,
      renderedSha256: view.sha256,
      violations: view.violations,
    }
  }

  /**
   * 列条目（**默认列全部 epoch**，可按 epoch / status 过滤）。
   *
   * 为什么默认不按 epoch 过滤：L3 是跨压缩累积的，`compaction_epoch` 只是"这条产生于哪次压缩"。
   * 默认只列当前 epoch 会让"压缩后沉降旧条目"静默失效（旧条目在新 epoch 里根本找不到）——
   * 这个坑在引擎测试里被真实踩到过一次。
   */
  listEntries(options: { readonly epoch?: number; readonly status?: readonly ('active' | 'fragment' | 'fragmented' | 'archived')[] } = {}): readonly MidEntryRow[] {
    const rows =
      options.epoch === undefined
        ? (this.db.prepare('SELECT * FROM mid_memory_entries ORDER BY window_offset ASC').all() as unknown as MidEntryRow[])
        : (this.db
            .prepare('SELECT * FROM mid_memory_entries WHERE compaction_epoch = ? ORDER BY window_offset ASC')
            .all(options.epoch) as unknown as MidEntryRow[])
    const wanted = options.status
    if (wanted === undefined || wanted.length === 0) return rows
    const normalized = new Set(wanted.map((s) => (s === 'fragment' ? 'fragmented' : s)))
    return rows.filter((r) => normalized.has(r.status))
  }

  /** 面板用：溢出记录列表（不含全文）。 */
  listSpill(sessionId: string, limit = 20): readonly Omit<{ id: string; tool_name: string; byte_size: number; line_count: number; created_at: string }, never>[] {
    return listSpills(this.db, sessionId, limit) as never
  }

  /** 面板用：压缩日志。 */
  compactionLog(limit = 20): readonly Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM compaction_log ORDER BY timestamp DESC LIMIT ?').all(limit) as Record<string, unknown>[]
  }

  /** 轮次边界：重置"每轮"额度的计数，并推进"自上次压缩以来的轮次"（PLAN §4.4 记账）。 */
  beginTurn(): void {
    this.recallThisTurn = 0
    this.bumpCounter('acct_turns_since_compaction', 1)
  }

  /** 记一次工具调用（§4.4 的"自上次压缩工具调用数"）。 */
  recordToolCall(): void {
    this.bumpCounter('acct_toolcalls_since_compaction', 1)
  }

  /** 观测当前短期 token 数（宿主 tokenMeter 或网关估算）。 */
  observeShortTokens(tokens: number): void {
    this.setState('acct_short_tokens', String(Math.max(0, Math.trunc(tokens))))
  }

  /**
   * 取裁决用的统计（PLAN §4.4）。
   *
   * @param contextWindowTokens - 上下文上限（用于算占比）；不传则按 128k 估。
   * @returns 裁决输入。
   */
  compactionStats(contextWindowTokens = 128_000): {
    shortTokens: number
    turnsSinceLast: number
    toolCallsSinceLast: number
    tokenDeltaSinceLast: number
    timeSinceLastMs: number
    shortRatio: number
    hasPreviousCompaction: boolean
  } {
    const shortTokens = Number(this.getState('acct_short_tokens') ?? '0')
    const atLast = this.getState('acct_tokens_at_last_compaction')
    const lastAt = this.getState('acct_last_compaction_at')
    return {
      shortTokens,
      turnsSinceLast: Number(this.getState('acct_turns_since_compaction') ?? '0'),
      toolCallsSinceLast: Number(this.getState('acct_toolcalls_since_compaction') ?? '0'),
      tokenDeltaSinceLast: atLast === undefined ? shortTokens : Math.max(0, shortTokens - Number(atLast)),
      timeSinceLastMs: lastAt === undefined ? Number.MAX_SAFE_INTEGER : Date.now() - Date.parse(lastAt),
      shortRatio: contextWindowTokens <= 0 ? 0 : shortTokens / contextWindowTokens,
      hasPreviousCompaction: lastAt !== undefined,
    }
  }

  /**
   * 记录模型发起的压缩请求（已通过 §4.4 裁决）。
   *
   * 为什么是"入队"而不是直接压：**工具执行上下文里没有 agent**（只有 callId/signal/deferContext），
   * 而压缩必须要 agent 才能改会话表面。所以工具只负责"裁决 + 排队"，
   * 由引擎在下一次 `compactIfNeeded` 时用宿主的 `context-overflow` 语义强制执行
   * （该语义按文档就是"绕过常规阈值与保留尾部策略"，正是我们要的效果）。
   */
  requestCompaction(reason: string): void {
    this.setState('acct_pending_compaction', JSON.stringify({ reason, at: new Date().toISOString() }))
  }

  /** 取出并清空待执行的压缩请求。 */
  takePendingCompactionRequest(): { readonly reason: string; readonly at: string } | undefined {
    const raw = this.getState('acct_pending_compaction')
    if (raw === undefined) return undefined
    this.setState('acct_pending_compaction', '')
    try {
      const parsed = JSON.parse(raw) as { reason?: string; at?: string }
      return { reason: parsed.reason ?? '(未说明)', at: parsed.at ?? '' }
    } catch {
      return undefined
    }
  }

  /**
   * 用 PLAN §4.4 裁决一次压缩请求（工具与引擎共用同一套判据）。
   *
   * @param contextWindowTokens - 上下文上限；不传则用默认估值。
   * @returns 裁决结果（与 §4.4 的反馈 JSON 字段一致）。
   */
  evaluateCompactionRequest(contextWindowTokens?: number): ReturnType<typeof decideCompaction> {
    return decideCompaction(
      this.compactionStats(contextWindowTokens ?? this.contextWindowTokens),
      {},
    )
  }

  /**
   * 生效的提示词文本（P1/P2）。
   *
   * 走一层内存缓存：宿主的函数型 section **每次装配都会重算**，
   * 每次装配都去查库 + 解析版本是没必要的开销。缓存键是"当前 active 版本 id"，
   * 所以保存新版本后一次调用就会自然换新（不需要手工清缓存也能生效），
   * `invalidatePromptCache()` 只是让"立刻生效"更确定。
   *
   * @param slug - 槽位。
   * @returns 文本（没有则返回空串：宿主会丢弃空段）。
   */
  promptText(slug: PromptSlug): string {
    const active = activePrompt(this.db, slug)
    const key = `${slug}:${active?.id ?? ''}`
    const cached = this.promptCache.get(key)
    if (cached !== undefined) return cached
    const text = active?.text ?? ''
    // 只保留当前版本的缓存（版本会不断新增，不清会越攒越多）
    for (const existing of [...this.promptCache.keys()]) {
      if (existing.startsWith(`${slug}:`) && existing !== key) this.promptCache.delete(existing)
    }
    this.promptCache.set(key, text)
    return text
  }

  /** 清掉提示词缓存（保存/回滚后调用，让"下一轮生效"更确定）。 */
  invalidatePromptCache(): void {
    this.promptCache.clear()
  }

  /**
   * 当前正在处理的 QQ 会话（若有）。
   *
   * 用途：**溯源标记**（§2.17.5）。模型调 `remember` 时不必自己填 scope ——
   * 它很可能不知道该填什么。运行时从"当前 running 轮次"推出会话键，
   * 于是每条记忆天然带上"这是谁说的/在哪个群发生的"。
   *
   * 统一记忆、不做隔离：这个标记只用于标注来源与将来溯源自查，不用于隔离。
   */
  currentConversationScope(): string | undefined {
    const row = this.db
      .prepare("SELECT conversation_key FROM qq_turns WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get() as { conversation_key: string } | undefined
    return row?.conversation_key
  }

  /**
   * QQ 传输层状态（面板显示"QQ 端连没连上"）。
   *
   * 传输层活在网关进程里，而面板接口活在 DSH 进程里 —— 所以这里读的是**共享库里的事实**：
   * 最后一次入站/出站的时间。比"内存里的连接标志"更诚实：
   * 网关挂了但 DSH 还活着时，内存标志会是错的，而库里的时间戳不会撒谎。
   */
  transportStatus(): { readonly connectedEvidence: boolean; readonly lastInboundAt: string | null; readonly lastOutboundAt: string | null } {
    const inbound = this.db.prepare('SELECT max(received_at) AS at FROM qq_inbox').get() as { at: string | null }
    const outbound = this.db.prepare('SELECT max(sent_at) AS at FROM qq_outbox').get() as { at: string | null }
    const at = (value: string | null): string | null => (value === null ? null : value)
    const recent = (value: string | null): boolean => value !== null && Date.now() - Date.parse(value) < 300_000
    return {
      connectedEvidence: recent(at(inbound.at)) || recent(at(outbound.at)),
      lastInboundAt: at(inbound.at),
      lastOutboundAt: at(outbound.at),
    }
  }

  /** 提示词文本缓存（键：`slug:revisionId`）。 */
  private readonly promptCache = new Map<string, string>()

  /**
   * 生效的时钟设置（会话级覆盖 > 全局）。
   *
   * 三层时区：`systemTimezone`（记录用，**一律 UTC**）/ `conversationTimezone`（怎么理解）/
   * `displayTimezone`（给人看）。这里返回的是"与当前会话对话时该用哪一套"。
   *
   * @param conversationKey - 会话键；不给则用当前 QQ 会话。
   * @returns 生效设置与来源（来源要显示，才能解释"这个时区是谁定的"）。
   */
  clockSettings(conversationKey?: string): {
    readonly systemTimezone: string
    readonly conversationTimezone: string
    readonly displayTimezone: string
    readonly hour24: boolean
    readonly source: string
  } {
    const configured = defaultClockConfig()
    const scope = conversationKey ?? this.currentConversationScope()
    const override = scope === undefined ? undefined : getConversationClock(this.db, scope)
    return {
      systemTimezone: configured.systemTimezone,
      conversationTimezone: override?.timezone ?? configured.conversationTimezone,
      displayTimezone: configured.displayTimezone,
      hour24: override?.hour24 ?? configured.hour24,
      source: override?.source ?? 'default',
    }
  }

  /** 设置某会话的时区（带优先级保护：低优先级不能覆盖高优先级）。 */
  setConversationClock(
    scope: string,
    input: { readonly timezone: string; readonly hour24?: boolean; readonly source: 'user_set' | 'model_note' | 'small_model_suggest'; readonly reason?: string },
  ): boolean {
    return setConversationClock(this.db, {
      scope,
      timezone: input.timezone,
      ...(input.hour24 === undefined ? {} : { hour24: input.hour24 }),
      source: input.source,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
  }

  /** 写一条待确认的时钟建议（**不生效**）。 */
  setPendingClockSuggestion(
    scope: string,
    input: { readonly timezone: string; readonly confidence: string; readonly origin: string; readonly reason?: string },
  ): void {
    setClockSuggestion(this.db, {
      scope,
      timezone: input.timezone,
      confidence: input.confidence,
      origin: input.origin,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
  }

  /** 读某会话的待确认建议。 */
  pendingClockSuggestion(scope?: string): ReturnType<typeof getClockSuggestion> {
    const target = scope ?? this.currentConversationScope()
    return target === undefined ? undefined : getClockSuggestion(this.db, target)
  }

  /** 列出全部按会话设置的时区。 */
  listConversationClocks(): ReturnType<typeof listConversationClocks> {
    return listConversationClocks(this.db)
  }

  /**
   * 上一次与该会话交互（收或发）的时刻。
   *
   * 用于"距上次交互多久"这个锚点 —— 模型不必自己做时间算术（§2.15.1 根因 9）。
   *
   * @param conversationKey - 会话键。
   * @returns 时刻，或 undefined（没有记录）。
   */
  lastInteractionAt(conversationKey?: string): Date | undefined {
    const key = conversationKey ?? this.currentConversationScope()
    if (key === undefined) return undefined
    const row = this.db.prepare('SELECT max(at) AS at FROM qq_turns WHERE conversation_key = ?').get(key) as { at: string | null }
    return row.at === null ? undefined : new Date(row.at)
  }

  /** 上一次"行动"（真的发出了东西）的时刻。 */
  lastActionAt(): Date | undefined {
    const row = this.db.prepare('SELECT max(sent_at) AS at FROM qq_outbox').get() as { at: string | null }
    return row.at === null ? undefined : new Date(row.at)
  }

  /** 当前会话 id（缓存采集与读数落库要关联会话）。 */
  currentSessionId(): string | undefined {
    const row = this.db
      .prepare("SELECT session_id FROM qq_turns WHERE status = 'running' AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get() as { session_id: string } | undefined
    return row?.session_id
  }

  // ── 阶段 5：档位覆盖与路由观测 ──────────────────────────────────────────

  /** 手动档位覆盖（可撤销）。进程内状态：重启后回到自动判定（那是安全方向）。 */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  private tierOverrideValue: TierOverride | undefined

  /**
   * 写一行运行时日志（工具层要留痕：切换档位这种事必须能被看到）。
   *
   * **必须是箭头函数属性**：它会被当作回调传给 `openDatabase({ log })`，
   * 普通方法那样传会丢掉 `this`（真机启动时报 "Cannot read properties of undefined"）。
   * 刻意只暴露"写日志"而不是整个 logger：工具层不该能改日志配置。
   */
  readonly log = (message: string): void => {
    this.logger(message)
  }

  /** 当前的手动档位覆盖。 */
  tierOverride(): TierOverride | undefined {
    return this.tierOverrideValue
  }

  /** 设置手动档位覆盖。 */
  setTierOverride(override: TierOverride): void {
    this.tierOverrideValue = override
  }

  /** 撤销手动档位覆盖（回到自动判定）。 */
  clearTierOverride(): void {
    this.tierOverrideValue = undefined
  }

  /** 最近的切换记录（冷却与预算的依据）。 */
  recentSwitches(): readonly { readonly at: string }[] {
    return this.db
      .prepare("SELECT at FROM routing_log WHERE switched = 1 AND at >= ? ORDER BY at DESC")
      .all(new Date(Date.now() - 3_600_000).toISOString()) as unknown as { at: string }[]
  }

  /** 近 24 小时的路由统计（面板与 router_status 共用）。 */
  routingStats24h(): { readonly degraded: number; readonly total: number } {
    const row = this.db
      .prepare('SELECT count(*) AS total, coalesce(sum(degraded), 0) AS degraded FROM routing_log WHERE at >= ?')
      .get(new Date(Date.now() - 24 * 3600_000).toISOString()) as { total: number; degraded: number }
    return { total: row.total, degraded: row.degraded }
  }

  /** 记一条路由决策（工具与面板共用，保证字段一致）。 */
  recordRoutingDecision(input: Parameters<typeof recordRoutingDecision>[1]): void {
    recordRoutingDecision(this.db, input)
  }

  /** 列路由表。 */
  listModelRoutes(role?: string): ReturnType<typeof listModelRoutes> {
    return listModelRoutes(this.db, role)
  }

  // ── 阶段 5：端点探测、试跑与模式切换 ────────────────────────────────────

  /** 设备探测结果缓存（探测要跑外部命令，不能每轮都跑）。 */
  private deviceProbeCache: DeviceProbe | undefined

  /**
   * 探测宿主的加速能力（**懒执行 + 缓存**）。
   *
   * 为什么懒执行：nvidia-smi / clinfo 之类要几十到几百毫秒，
   * 放在启动路径上会让每次开插件都变慢；而只有在"模型与路由"页真的要看的时候才需要它。
   * 探测结果是**建议**不是判决 —— 面板上可以手动覆盖。
   */
  deviceProbe(): DeviceProbe {
    if (this.deviceProbeCache !== undefined) return this.deviceProbeCache
    const probed = probeDevices({
      platform: process.platform,
      exists: (path) => existsSync(path),
      listDir: (path) => {
        try {
          return readdirSync(path)
        } catch {
          return []
        }
      },
      run: (command, args) => {
        try {
          // 短超时：探测命令挂住会拖死面板请求
          const stdout = execFileSync(command, [...args], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] })
          return { ok: true, stdout }
        } catch {
          return { ok: false, stdout: '' }
        }
      },
    })
    this.deviceProbeCache = probed
    return probed
  }

  /** 试跑历史（面板显示"上次试跑真实延迟是多少"）。 */
  probeHistory(): readonly { readonly at: string; readonly endpointId: string; readonly ok: boolean; readonly latencyMs: number | null; readonly note: string | null }[] {
    // 读**专门的探测日志表**：第一版我从模式切换审计里捞，结果查了一个不存在的列
    // （试跑结果和模式切换是两类事件，塞一张表里迟早出这种事）
    return listEndpointProbes(this.db, 10).map((row) => ({
      at: String(row['at']),
      endpointId: String(row['endpoint_id']),
      ok: row['ok'] === 1,
      latencyMs: row['latency_ms'] === null ? null : Number(row['latency_ms']),
      note: row['note'] === null ? null : String(row['note']),
    }))
  }

  /**
   * 切换端点的运行模式（幂等 + 排水 + 失败回滚 + 审计，§2.13.2）。
   *
   * **诚实说明**：真正把容器停下/拉起需要容器执行器（阶段 10 的部署接线）。
   * 对不需要容器的端点（cloud-api / host-native / external-api）这里就是纯粹的登记切换；
   * 对本地容器端点，如果没有接上执行器，会**明确失败**而不是假装切成功 ——
   * 假装成功会让面板显示"已按需"，而容器其实还在占内存。
   *
   * @param endpointId - 端点 id。
   * @param mode - 目标模式。
   * @param reason - 理由（进审计）。
   * @returns 切换结果。
   */
  async switchEndpointMode(
    endpointId: string,
    mode: RunMode,
    reason: string,
  ): Promise<{ readonly ok: boolean; readonly effectiveMode: string; readonly drained: boolean; readonly rolledBack: boolean; readonly note: string }> {
    const endpoint = getEndpoint(this.db, endpointId)
    if (endpoint === undefined) {
      return { ok: false, effectiveMode: mode, drained: false, rolledBack: false, note: '端点不存在' }
    }

    const needsContainer = endpoint.type === 'local' || endpoint.type === 'remote-selfhost'
    const involvesContainerMode = mode === 'resident' || mode === 'on-demand' || endpoint.mode === 'resident' || endpoint.mode === 'on-demand'
    if (needsContainer && involvesContainerMode && this.containerExecutor === undefined) {
      const note =
        '容器端点的模式切换需要容器执行器（阶段 10 的部署接线）。' +
        '**没有假装切成功**：面板上的模式没有改动，容器仍在按原来的模式运行。'
      recordModeSwitch(this.db, { endpointId, from: endpoint.mode, to: mode, actor: 'admin', reason, ok: false, note })
      return { ok: false, effectiveMode: endpoint.mode, drained: false, rolledBack: false, note }
    }

    const result = await switchMode(
      { endpointId, from: endpoint.mode as RunMode, to: mode, actor: 'admin', reason },
      {
        inFlight: () => this.inFlightRequests(),
        stopAccepting: async () => {
          this.acceptingRequests = false
        },
        resumeAccepting: async () => {
          this.acceptingRequests = true
        },
        apply: async (request) => {
          if (this.containerExecutor !== undefined) await this.containerExecutor(request)
          setEndpointMode(this.db, endpointId, request.to)
        },
        audit: (entry) => {
          recordModeSwitch(this.db, {
            endpointId: entry.endpointId,
            from: entry.from,
            to: entry.to,
            actor: entry.actor,
            reason: entry.reason,
            ok: entry.ok,
            note: entry.note,
            at: entry.at,
          })
        },
      },
    )
    this.log(`端点 ${endpointId} 模式切换：${endpoint.mode} → ${mode}（${result.note}）`)
    return { ok: result.ok, effectiveMode: result.effectiveMode, drained: result.drained, rolledBack: result.rolledBack, note: result.note }
  }

  /** 容器执行器（阶段 10 接线；没接上时容器类切换会明确失败）。 */
  private containerExecutor: ((request: { readonly endpointId: string; readonly to: string }) => Promise<void>) | undefined

  /** 接上容器执行器（部署接线用）。 */
  setContainerExecutor(executor: (request: { readonly endpointId: string; readonly to: string }) => Promise<void>): void {
    this.containerExecutor = executor
  }

  /**
   * 一键试跑：真发一次最小请求，记录**真实延迟**与**实际生效的后端**。
   *
   * @param endpointId - 端点 id。
   * @param model - 指定模型（不给则用端点第一个）。
   * @returns 结果（含实际模型列表，用于发现"这个端点其实还有别的模型"）。
   */
  async probeEndpoint(
    endpointId: string,
    model?: string,
  ): Promise<{ readonly ok: boolean; readonly latencyMs?: number; readonly models?: readonly string[]; readonly error?: string; readonly note?: string }> {
    const endpoint = getEndpoint(this.db, endpointId)
    if (endpoint === undefined) return { ok: false, error: '端点不存在' }

    const base = endpoint.base_url.replace(/\/$/, '')
    const started = Date.now()
    try {
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8_000) })
      const latencyMs = Date.now() - started
      if (!response.ok) {
        recordEndpointHealth(this.db, endpointId, { ok: false, latencyMs, note: `HTTP ${String(response.status)}` })
        recordEndpointProbe(this.db, { endpointId, model: model ?? null, ok: false, latencyMs, note: `HTTP ${String(response.status)}` })
        return { ok: false, latencyMs, error: `HTTP ${String(response.status)}` }
      }
      const body = (await response.json()) as { data?: { id?: string }[] }
      const models = (body.data ?? []).map((item) => item.id ?? '').filter((id) => id !== '')
      recordEndpointHealth(this.db, endpointId, {
        ok: true,
        latencyMs,
        note: `试跑成功，发现 ${String(models.length)} 个模型`,
      })
      recordEndpointProbe(this.db, { endpointId, model: model ?? null, ok: true, latencyMs, note: `延迟 ${String(latencyMs)}ms`, models })
      return {
        ok: true,
        latencyMs,
        models,
        note: '延迟是**真实**往返时间（本地容器通常在 1–5ms，局域网外挂 1–20ms，云 provider 100ms+）',
      }
    } catch (error) {
      const latencyMs = Date.now() - started
      const note = String(error)
      recordEndpointHealth(this.db, endpointId, { ok: false, latencyMs, note })
      recordEndpointProbe(this.db, { endpointId, model: model ?? null, ok: false, latencyMs, note })
      return { ok: false, latencyMs, error: note }
    }
  }

  /** 在途请求数（排水依据；没有网关时恒为 0）。 */
  private inFlightRequestsValue = 0

  /** 当前在途请求数。 */
  inFlightRequests(): number {
    return this.inFlightRequestsValue
  }

  /** 记一次在途请求的开始/结束（网关调用）。 */
  markInFlight(delta: number): void {
    this.inFlightRequestsValue = Math.max(0, this.inFlightRequestsValue + delta)
  }

  /** 是否还在接受新请求（排水期间为 false）。 */
  acceptingRequests = true

  /** 压缩成功后重置记账基线（在压缩事务提交后调用）。 */
  resetCompactionAccounting(): void {
    const now = new Date().toISOString()
    this.setState('acct_turns_since_compaction', '0')
    this.setState('acct_toolcalls_since_compaction', '0')
    this.setState('acct_tokens_at_last_compaction', this.getState('acct_short_tokens') ?? '0')
    this.setState('acct_last_compaction_at', now)
  }

  /**
   * 沉降维护任务：把最久未访问的活跃条目降级为碎片（PLAN §4.1 的第二类压缩）。
   *
   * 与压缩的区别：**不调用模型**，纯系统维护 —— 因此可以在任意时刻跑（定时或占比触发），
   * 代价只是把全文挪进长期记忆、把一个中期条目换成一行 [F→] 指针。
   *
   * @param options - 触发条件与批量上限。
   * @returns 本次沉降统计。
   */
  settle(options: { readonly olderThanDays?: number; readonly limit?: number } = {}): {
    readonly fragmented: number
    readonly archived: number
    readonly notes: readonly string[]
  } {
    const olderThanDays = options.olderThanDays ?? defaultFor<number>('tiering.settleAfterDays')
    const limit = options.limit ?? defaultFor<number>('tiering.settleBatchSize')
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()

    const candidates = this.listEntries({ status: ['active'] })
      .filter((e) => (e.last_accessed_at ?? e.created_at) < cutoff)
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        summary: e.summary,
        entities: parseEntities(e.entities),
        tokenCount: e.token_count,
        lastAccessedAt: e.last_accessed_at,
        createdAt: e.created_at,
      }))

    if (candidates.length === 0) return { fragmented: 0, archived: 0, notes: ['没有满足沉降条件的活跃条目'] }

    const stats = this.stats()
    const withHints = candidates.map((c) => ({
      ...c,
      hintTokens: estimateTokens(makeFragmentHint(c.summary, c.entities).hint),
    }))
    const plan = planFragmentation(withHints, stats)

    let fragmented = 0
    for (const id of plan.toFragment) {
      const source = this.listEntries().find((e) => e.id === id)
      if (source === undefined) continue
      const entities = parseEntities(source.entities)
      const { hint } = makeFragmentHint(source.summary, entities)
      const longId = `long_from_${id}`
      insertLongEntry(this.db, {
        id: longId,
        content: source.content ?? source.summary,
        summary: source.summary,
        entities,
        sourceMidIds: [id],
        sourceScope: source.source_scope,
      })
      fragmentMidEntry(this.db, id, longId, hint, estimateTokens(hint))
      fragmented += 1
    }

    // 淘汰：把最久未访问的碎片标记 archived（表保留，可恢复；§5.3 第四层）
    let archived = 0
    if (stats.fragmentCount >= defaultFor<number>('fragment.maxCount')) {
      for (const id of plan.toArchive) {
        archived += Number(
          this.db.prepare("UPDATE mid_memory_entries SET status = 'archived', revision = revision + 1 WHERE id = ? AND status = 'fragmented'").run(id).changes,
        )
      }
    }

    if (fragmented > 0 || archived > 0) {
      this.db.prepare("UPDATE forlife_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'render_revision'").run()
      this.cache = undefined
    }
    return { fragmented, archived, notes: plan.notes }
  }

  /** 压缩后重置周期额度（PLAN §7.6 的 reset_policy = on_compaction）。 */
  resetCycle(): void {
    this.recallThisTurn = 0
    this.recallThisCycle = 0
    this.turnsThisCycle = 1
  }

  /** 关闭（checkpoint + 释放）。 */
  close(): void {
    this.opened.close()
  }

  /** 读一个持久化状态值（记账用；跨重启保留）。 */
  private getState(key: string): string | undefined {
    const value = readState(this.db, key)
    return value === undefined || value === '' ? undefined : value
  }

  /** 写一个持久化状态值。 */
  private setState(key: string, value: string): void {
    writeState(this.db, key, value)
  }

  /** 计数器自增。 */
  private bumpCounter(key: string, delta: number): void {
    this.setState(key, String(Number(this.getState(key) ?? '0') + delta))
  }

  private budget(maxPerTurn: number, maxPerCycle: number, maxResults: number): RecallBudget {
    return {
      maxPerTurn,
      maxPerCycle,
      maxResults,
      usedThisTurn: this.recallThisTurn,
      usedThisCycle: this.recallThisCycle,
      remainingThisTurn: Math.max(0, maxPerTurn - this.recallThisTurn),
      remainingThisCycle: Math.max(0, maxPerCycle - this.recallThisCycle),
    }
  }
}

/** 解析数据库绝对路径：`storageRoot` 相对 `DSH_HOME`，也接受绝对路径。 */
export function resolveDbPath(config: ForlifeConfig, dshHome: string): string {
  const root = isAbsolute(config.storageRoot) ? config.storageRoot : join(dshHome, config.storageRoot)
  return join(root, config.dbFile)
}






/** 宽松解析 entities（表里是 JSON 文本；坏数据不该让沉降崩掉）。 */
function parseEntities(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}















