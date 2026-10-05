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
  appendMidEntry,
  bumpEpoch,
  currentEpoch,
  currentRevision,
  fragmentMidEntry,
  getSpill,
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
import { renderMidMemory, estimateTokens, type RenderedView } from '@forlife/memory-core'
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
  private readonly log: (message: string) => void
  private cache?: { readonly key: string; readonly view: RenderedView }
  private turnsThisCycle = 1
  private recallThisTurn = 0
  private recallThisCycle = 0

  constructor(options: MemoryRuntimeOptions) {
    this.config = options.config
    this.log = options.log ?? ((): void => {})
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
    readonly summary: string
    readonly content?: string
    readonly entities?: readonly string[]
    readonly sourceScope?: string | null
    readonly sourceShortIds?: readonly string[]
  }): { readonly id: string; readonly revision: number; readonly windowOffset: number; readonly tokenCount: number } {
    const id = `mid_${createHash('sha1').update(`${String(Date.now())}:${input.summary}`).digest('hex').slice(0, 12)}`
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

  /** 面板用：列条目（可按 epoch / status 过滤）。 */
  listEntries(options: { readonly epoch?: number; readonly status?: readonly ('active' | 'fragment' | 'fragmented' | 'archived')[] } = {}): readonly MidEntryRow[] {
    const epoch = options.epoch ?? this.epoch()
    const rows = this.db
      .prepare('SELECT * FROM mid_memory_entries WHERE compaction_epoch = ? ORDER BY window_offset ASC')
      .all(epoch) as unknown as MidEntryRow[]
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

  /** 轮次边界：重置"每轮"额度的计数（压缩后重置整周期额度，阶段 4 接 T11）。 */
  beginTurn(): void {
    this.recallThisTurn = 0
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


