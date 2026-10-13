/**
 * 「运行总览」的数据。
 *
 * 原则：**能精确算的就精确算，算不准的宁可空着**。
 *  - 数字全部来自同一个 SQLite 的聚合查询（与 DSH 内嵌面板同一份数据，不是第二套真源）；
 *  - QQ 的"是否在线"在库里的唯一痕迹是"最近收没收到消息"，那是**推断不是事实**，
 *    所以 `connected` 允许 `undefined`：服务进程真的接管了连接才填它，否则界面显示"—"。
 *    宁可显示"未知"，也不要显示一个可能骗人的绿点。
 *
 * @module @forlife/gateway/admin/overview
 */
import { statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import type { DshStatus } from '../dsh-status.ts'

import { LATEST_SCHEMA_VERSION, listRenderableMidEntries } from '@forlife/store'
import { selectMidWindow } from '@forlife/memory-core'
import { defaultFor } from '@forlife/contracts'

/** 总览数据结构（与 `packages/admin-ui/src/api/types.ts` 一一对应）。 */
export interface Overview {
  readonly at: string
  readonly build: {
    readonly schemaVersion: number
    readonly node: string
    readonly uptimeSec: number
  }
  readonly db: {
    readonly path: string
    readonly sizeBytes: number
    readonly walBytes: number
  }
  readonly memory: {
    readonly epoch: number
    readonly revision: number
    /** **全表**口径：`status='active'` 的条目数（**不等于**进上下文的条数）。 */
    readonly activeEntries: number
    /** **全表**口径：碎片条目数。 */
    readonly fragmentEntries: number
    readonly longEntries: number
    /** **全表**口径：active 的 token 之和（诊断用；真机曾达 1,505k）。 */
    readonly activeTokens: number
    /** **全表**口径：碎片的 token 之和。 */
    readonly fragmentTokens: number
    /** **窗口**口径：真正进系统提示词的条目数。 */
    readonly windowEntries: number
    /** **窗口**口径：真正进系统提示词的 token 之和 —— 面板的「活跃 token」该显示的就是它。 */
    readonly windowTokens: number
    /** 被窗口丢掉的条目数。 */
    readonly windowDroppedEntries: number
    /** 被窗口丢掉的 token 之和。 */
    readonly windowDroppedTokens: number
    /**
     * `windowDroppedEntries` 里**由条数上限造成**的那部分（0 ⇒ 是 token 预算在生效）。
     *
     * 单独给的用途：token 到顶是正常容量管理，条数到顶是**写入侧畸形**的信号 ——
     * 混成一个数字，面板上看到"丢了很多条"根本分不清该不该管。
     */
    readonly windowDroppedByCount: number
    /** 窗口的 token 预算（基线 `memory.midWindow.maxTokens`）。 */
    readonly windowMaxTokens: number
    /** 窗口的条数上限（基线 `memory.midWindow.maxCount`）。 */
    readonly windowMaxCount: number
    readonly lastWriteAt?: string
  }
  readonly compaction: {
    readonly runs: number
    readonly failedRuns: number
    readonly lastAt?: string
    readonly lastStatus?: string
    readonly tokensBefore?: number
    readonly tokensAfter?: number
  }
  readonly qq: {
    /** `undefined` = 本服务没有接管 QQ 连接，无法判断（不是"离线"）。 */
    readonly connected?: boolean
    readonly queueDepth: number
    readonly pendingItems: number
    readonly outboxPending: number
    readonly sessions: number
    readonly lastInboundAt?: string
    readonly lastTurnAt?: string
  }
  /**
   * DSH 后端连接状态。
   *
   * **为什么总览必须有它**：gateway 与 DSH 是两个进程、共享一个库。
   * DSH 挂了时**面板看起来一切正常**（QQ 在收、库在写、图表在动），
   * 但模型那一侧根本没在跑 —— 用户会以为"模型不回我"。
   */
  readonly dsh?: DshStatus
  readonly routing: {
    readonly endpoints: number
    readonly healthyEndpoints: number
    readonly total24h: number
    readonly degraded24h: number
    readonly uncertainPending: number
    readonly lastSwitchAt?: string
  }
  readonly prompts: {
    readonly slots: number
    readonly overrides: number
    readonly revisions: number
  }
  readonly time: {
    readonly authorityTz: string
    readonly driftMs?: number
    readonly lastReadingAt?: string
  }
}

/** 取值小工具：把 `SELECT ... ` 的单值结果转成数字，NULL/缺失都给 0。 */
function scalar(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { v?: number | bigint | null } | undefined
  const value = row?.v
  if (value === undefined || value === null) return 0
  return typeof value === 'bigint' ? Number(value) : value
}

/** 取值小工具：字符串（NULL 给 undefined）。 */
function scalarText(db: DatabaseSync, sql: string, ...params: (string | number)[]): string | undefined {
  const row = db.prepare(sql).get(...params) as { v?: string | null } | undefined
  return row?.v ?? undefined
}

/** `forlife_state` 里的整数键。 */
function stateNumber(db: DatabaseSync, key: string): number {
  const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value?: string } | undefined
  const parsed = row?.value === undefined ? 0 : Number(row.value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 文件大小（不存在给 0）。 */
function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 组装总览。`transportConnected` 由服务进程决定是否提供。 */
export function buildOverview(
  db: DatabaseSync,
  context: {
    readonly dbPath: string
    readonly startedAt: number
    readonly transportConnected?: boolean | undefined
      /** DSH 状态（由异步的调用方先探好再传进来 —— buildOverview 是同步的）。 */
      readonly dsh?: DshStatus
  },
): Overview {
  const now = Date.now()
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const activeEntries = scalar(db, "SELECT COUNT(*) AS v FROM mid_memory_entries WHERE status = 'active'")
  const fragmentEntries = scalar(db, "SELECT COUNT(*) AS v FROM mid_memory_entries WHERE status = 'fragmented'")

  // ── 中期**窗口**口径（2026-10-09，用户裁定 ④）─────────────────────────────
  //
  // 为什么必须在这里算：面板的「活跃 token」过去显示的是**全表** SUM(token_count)
  // （真机 10,794 条 / 1,504,850 token），而真正进系统提示词的只有**窗口**里那一段。
  // 两个数差 15 倍时，用户会以为窗口根本没生效 —— 面板在无声地骗人。
  //
  // ⚠️ 刻意调**渲染器同一个** `selectMidWindow()`、读**同一份**基线预算，
  // 而不是在 SQL 里另写一套"取最新若干条"：两套裁剪迟早会漂
  // （面板说 30 条、实际渲染 29 条），那正是本仓吃过亏的"面板数字与生效值不一致"。
  // `listRenderableMidEntries()` 也必须是同一个来源（它带 `status` 过滤与排序），
  // 否则面板算的是另一张候选集。
  const windowMaxTokens = defaultFor<number>('memory.midWindow.maxTokens')
  const windowMaxCount = defaultFor<number>('memory.midWindow.maxCount')
  const midWindow = selectMidWindow(listRenderableMidEntries(db), {
    maxTokens: windowMaxTokens,
    maxCount: windowMaxCount,
  })

  const lastRun = db
    .prepare('SELECT phase, started_at, ended_at FROM compaction_runs ORDER BY started_at DESC LIMIT 1')
    .get() as { phase: string; started_at: string; ended_at?: string | null } | undefined
  const lastLog = db
    .prepare('SELECT timestamp, short_tokens_before, kept_in_short_tokens FROM compaction_log ORDER BY timestamp DESC LIMIT 1')
    .get() as { timestamp: string; short_tokens_before?: number | null; kept_in_short_tokens?: number | null } | undefined

  const outboxPending = scalar(db, 'SELECT COUNT(*) AS v FROM qq_outbox WHERE confirmed = 0')

  // 可选字段先收窄成局部变量：`exactOptionalPropertyTypes` 下不能把 `undefined` 塞进可选属性，
  // 直接写 `...(x === undefined ? {} : { k: x })` 时 x 若还是 `T | undefined` 会编译失败。
  const lastWriteAt = scalarText(db, 'SELECT MAX(created_at) AS v FROM mid_memory_entries')
  const lastInboundAt = scalarText(db, 'SELECT MAX(at) AS v FROM qq_inbox')
  const lastTurnAt = scalarText(db, 'SELECT MAX(started_at) AS v FROM qq_turns')
  const lastSwitchAt = scalarText(db, 'SELECT MAX(at) AS v FROM routing_log WHERE switched = 1')
  const lastReadingAt = scalarText(db, 'SELECT MAX(at) AS v FROM time_readings')
  const authorityTz = scalarText(db, "SELECT value AS v FROM forlife_state WHERE key = 'authority_tz'") ?? 'Asia/Shanghai'
  const lastAt = lastLog?.timestamp ?? lastRun?.started_at
  const lastStatus = lastRun?.phase
  const tokensBefore = lastLog?.short_tokens_before ?? undefined
  const tokensAfter = lastLog?.kept_in_short_tokens ?? undefined
  const connected = context.transportConnected

  const overview: Overview = {
    at: new Date(now).toISOString(),
    build: {
      schemaVersion: LATEST_SCHEMA_VERSION,
      node: process.version,
      uptimeSec: Math.floor((now - context.startedAt) / 1000),
    },
    db: {
      path: context.dbPath,
      sizeBytes: fileSize(context.dbPath),
      walBytes: fileSize(`${context.dbPath}-wal`),
    },
    memory: {
      epoch: stateNumber(db, 'compaction_epoch'),
      revision: stateNumber(db, 'render_revision'),
      activeEntries,
      fragmentEntries,
      longEntries: scalar(db, 'SELECT COUNT(*) AS v FROM long_memory_entries'),
      // 全表口径：诊断要它（1.5M 就是从这里看出来的）。**不是**进上下文的量。
      activeTokens: scalar(db, "SELECT COALESCE(SUM(token_count), 0) AS v FROM mid_memory_entries WHERE status = 'active'"),
      fragmentTokens: scalar(db, "SELECT COALESCE(SUM(token_count), 0) AS v FROM mid_memory_entries WHERE status = 'fragmented'"),
      // 窗口口径：真正进上下文的量（面板的「活跃 token」显示的是这一组）
      windowEntries: midWindow.entries.length,
      windowTokens: midWindow.tokens,
      windowDroppedEntries: midWindow.droppedCount,
      windowDroppedTokens: midWindow.droppedTokens,
      windowDroppedByCount: midWindow.droppedByCount,
      windowMaxTokens,
      windowMaxCount,
      ...(lastWriteAt === undefined ? {} : { lastWriteAt }),
    },
    compaction: {
      runs: scalar(db, "SELECT COUNT(*) AS v FROM compaction_runs WHERE phase = 'committed'"),
      failedRuns: scalar(db, "SELECT COUNT(*) AS v FROM compaction_runs WHERE phase = 'aborted'"),
      ...(lastAt === undefined ? {} : { lastAt }),
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
    },
    qq: {
      ...(connected === undefined ? {} : { connected }),
      queueDepth: scalar(db, 'SELECT COUNT(*) AS v FROM qq_inbox WHERE processed = 0'),
      pendingItems: scalar(db, 'SELECT COUNT(*) AS v FROM pending_messages WHERE read = 0'),
      outboxPending,
      sessions: scalar(db, 'SELECT COUNT(*) AS v FROM qq_sessions'),
      ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
      ...(lastTurnAt === undefined ? {} : { lastTurnAt }),
    },
    // ★ 2026-10-09 修：这一行原来**被写在下面 `time` 对象里面**（缩进也是错的）。
    // 后果不是报错，是**彻底静默**：`Overview` 把 `dsh` 声明在顶层，展开进 `time`
    // 的那个键谁都不读 ⇒ `overview.dsh` 永远是 `undefined` ⇒ 面板永远显示
    // "DSH 状态未知"。而这个字段存在的**全部理由**就是"DSH 挂了时面板看起来一切正常"
    // （见 `dsh-status.ts` 的模块注释）—— 它失效得毫无声息，正是它要防的那种故障；
    // 探针照跑、开销照付，返回值扔进 `time` 里没人读。
    // TypeScript 也没拦住：对象字面量里的**展开**不触发多余属性检查
    // （展开的键被视为"可能存在"），所以只有测试能守住。
    // 未探到时整个字段不出现（界面显示"—"而不是假的"连不上"）。
    ...(context.dsh === undefined ? {} : { dsh: context.dsh }),
    routing: {
      endpoints: scalar(db, 'SELECT COUNT(*) AS v FROM inference_endpoints WHERE enabled = 1'),
      healthyEndpoints: scalar(db, 'SELECT COUNT(*) AS v FROM inference_endpoints WHERE enabled = 1 AND health_ok = 1'),
      total24h: scalar(db, 'SELECT COUNT(*) AS v FROM routing_log WHERE at >= ?', since24h),
      degraded24h: scalar(db, 'SELECT COUNT(*) AS v FROM routing_log WHERE at >= ? AND degraded = 1', since24h),
      uncertainPending: scalar(db, "SELECT COUNT(*) AS v FROM uncertain_cases WHERE status = 'pending'"),
      ...(lastSwitchAt === undefined ? {} : { lastSwitchAt }),
    },
    prompts: {
      slots: scalar(db, 'SELECT COUNT(*) AS v FROM prompt_revisions WHERE active = 1'),
      overrides: scalar(db, 'SELECT COUNT(*) AS v FROM prompt_overrides'),
      revisions: scalar(db, 'SELECT COUNT(*) AS v FROM prompt_revisions'),
    },
    time: {
      // 权威时区是设计决定（计划 §7c：单一权威，不随浏览器变）。库里没有该键时用已定默认值。
      authorityTz,
      ...(lastReadingAt === undefined ? {} : { lastReadingAt }),
    },
  }

  return overview
}
