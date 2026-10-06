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

import { LATEST_SCHEMA_VERSION } from '@forlife/store'

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
    readonly activeEntries: number
    readonly fragmentEntries: number
    readonly longEntries: number
    readonly activeTokens: number
    readonly fragmentTokens: number
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
  },
): Overview {
  const now = Date.now()
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const activeEntries = scalar(db, "SELECT COUNT(*) AS v FROM mid_memory_entries WHERE status = 'active'")
  const fragmentEntries = scalar(db, "SELECT COUNT(*) AS v FROM mid_memory_entries WHERE status = 'fragmented'")

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
      activeTokens: scalar(db, "SELECT COALESCE(SUM(token_count), 0) AS v FROM mid_memory_entries WHERE status = 'active'"),
      fragmentTokens: scalar(db, "SELECT COALESCE(SUM(token_count), 0) AS v FROM mid_memory_entries WHERE status = 'fragmented'"),
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
