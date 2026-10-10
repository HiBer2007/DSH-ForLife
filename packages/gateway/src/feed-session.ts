/**
 * 投喂**会话**的记账：让"现在在消化记忆"这件事**跨进程可见**。
 *
 * ## 为什么要有它（不是一个进度日志）
 *
 * 投喂时模型需要知道自己在什么工作模式下（用户 2026-10-09 的要求）：
 * 那些内容**是她的过去（前世的记忆）**，不是"刚刚发生的事"。
 * 而投喂的四个入口分属**不同进程**：
 *
 * | 入口 | 谁在跑 | 模型那一侧的进程 |
 * | :--- | :--- | :--- |
 * | CLI（`scripts/feed-memory.ts`） | 命令行 | **不是** DSH 会话 |
 * | 后台 `POST /api/admin/feed` | gateway | **不是** DSH 会话 |
 * | 面板 `POST /api/forlife/feed` | DSH 插件 | 是同一个进程 |
 * | 模型工具 `feed_memory` | DSH 插件 | 是同一个进程 |
 *
 * ⇒ 一个**内存里的标志**只能覆盖后两条入口；前两条（恰好是"用户自己塞巨量记忆"最常用的
 * 那两条）模型永远看不到。所以状态落在**既有**的 `forlife_state` 表上
 * （`render_revision` / `compaction_epoch` 就住那儿，**没有加表、没有加字段**），
 * DSH 那一侧渲染提示词时直接读它。
 *
 * ## 为什么读完不删、只忽略（陈旧判定）
 *
 * 投喂进程可能**中途崩掉**（或者被 Ctrl-C）。如果"读的人"负责清理，它就得写库 ——
 * 而"渲染提示词"这条路径**只读不写**是本仓的一条硬线（渲染的热路径不该改库）。
 * 所以：**写的人**在 `finally` 里收尾（`endFeedSession`），
 * **读的人**只判断"这条记录是不是太旧了"（超过 `feed.sessionStaleMs` 就当没有）。
 * 崩在最坏的情况下也只是多显示一小会儿"我在消化记忆"，而不是**永远**半梦半醒。
 *
 * ## 已知取舍
 *
 * 会话记录是**一行覆盖**的：两个进程同时投喂会互相盖掉进度（后写的赢）。
 * 投喂是低频人工动作，为此上一个"多会话表"不值当 —— 而且那会变成第二张状态表。
 * 这里如实记下这条取舍，而不是假装它不存在。
 *
 * @module @forlife/gateway/feed-session
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import type { FeedKind } from './feed.ts'
import type { FeedRefreshOutcome } from './feed-refresh.ts'

/** `forlife_state` 里的键名（用常量而不是裸字符串：拼错会静默失效）。 */
export const FEED_SESSION_KEY = 'feed_session'

/**
 * 会话里记的**源版本**（"这次投喂基于哪个版本的源"）。
 *
 * 用户 2026-10-09 的要求：投喂前必须先更新源，而"基于哪一版"必须能事后追溯 ——
 * 尤其是"清空重喂"这种破坏性动作之后，要能回答"我当时到底基于哪一份"。
 */
export interface FeedSessionRefresh {
  /** `none` = 无外部源（输入本身就是内容）；`command` = 跑过刷新命令。 */
  readonly kind: 'none' | 'command'
  readonly reason: string
  readonly at: string
  /** 脚本报的条数 / 上一次的条数 / 差值（"旧 281 → 新 287（+6）"就是这三项）。 */
  readonly items?: number
  readonly previousItems?: number
  readonly delta?: number
  readonly version?: string
  /** 是在**接受陈旧/可疑源**的前提下继续的。 */
  readonly stale?: boolean
}

/**
 * 把刷新结果收成会话里记的那几项。
 *
 * 刻意**不记命令原文与输出**：会话记录会被渲染/被面板看，而命令里可能有路径与参数；
 * 台账那一侧也只存命令的哈希与可读尾名（见 `feed-refresh.ts`）。
 */
export function sessionRefreshOf(refresh: FeedRefreshOutcome | undefined): FeedSessionRefresh | undefined {
  if (refresh === undefined) return undefined
  return {
    kind: refresh.kind,
    reason: refresh.reason,
    at: refresh.at,
    ...(refresh.items === undefined ? {} : { items: refresh.items }),
    ...(refresh.previousItems === undefined ? {} : { previousItems: refresh.previousItems }),
    ...(refresh.delta === undefined ? {} : { delta: refresh.delta }),
    ...(refresh.version === undefined ? {} : { version: refresh.version }),
    ...(refresh.stale === undefined ? {} : { stale: refresh.stale }),
  }
}

/**
 * **本轮的批次指针**（用户 2026-10-10：「以**单个轮次**为界，每一个轮次结束就传输下一批次」）。
 *
 * ## 为什么是指针，不是内容
 *
 * 模型驱动路径里，素材是**模型自己去 `read`** 的（`feed_memory` 的描述就写着
 * "模型自己 read 完一坨资料再喂"；用户指定的白名单里也正好有 `read`/`write`/`edit`
 * —— 那是它**取素材的手**）。所以系统每轮只需告诉它「**下一段是哪一段**」，
 * 而**不是**把内容塞进提示词。
 *
 * 这与那条边界一致（`feed-frame.ts` 头里写的）：投喂只产出**提示词文本**，
 * 不碰消息流 —— 而"指针"就是最轻的那种文本。
 *
 * ⚠️ 指针是**给人看与给模型看**的进度说明，**不是正确性机制**：
 * 真正决定"哪些已喂"的是游标（`feed-cursor.ts`），而重复投喂是幂等的。
 */
export interface FeedSessionBatch {
  /** 本轮该喂的起始段（含）。 */
  readonly from: number
  /** 本轮该喂的结束段（含）。 */
  readonly to: number
  /** 这份素材一共几段。 */
  readonly total: number
}

/** 一次投喂会话的现状（落库的 JSON 就是它）。 */
export interface FeedSession {
  /** 当前正在喂的来源（目录扫描时每个文件一个来源）。 */
  readonly source: string
  readonly as: FeedKind
  /** 已经投入的段数（= 已经写进记忆的条数，含判重跳过的那些）。 */
  readonly chunks: number
  /** 已经完成的批数。 */
  readonly batches: number
  readonly tokens: number
  readonly startedAt: string
  readonly updatedAt: string
  /** ★ 这次投喂基于**哪个版本的源**（CLI 上那行"旧 N → 新 M"就是它）。 */
  readonly refresh?: FeedSessionRefresh
  /** ★ 本轮该喂第几到第几段（提示段用它告诉模型"接下来读哪一段"）。 */
  readonly batch?: FeedSessionBatch
}

/** 写一行会话状态（`forlife_state` 是 key/value 表，没有别的字段）。 */
function write(db: DatabaseSync, session: FeedSession): void {
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(FEED_SESSION_KEY, JSON.stringify(session))
}

/** 开一次投喂会话（同一进程重复开 = 覆盖上一条，见模块头的取舍）。 */
export function beginFeedSession(
  db: DatabaseSync,
  input: {
    readonly source: string
    readonly as: FeedKind
    readonly now?: Date
    readonly refresh?: FeedRefreshOutcome | undefined
    readonly batch?: FeedSessionBatch | undefined
  },
): FeedSession {
  const at = (input.now ?? new Date()).toISOString()
  const refresh = sessionRefreshOf(input.refresh)
  const session: FeedSession = {
    source: input.source,
    as: input.as,
    chunks: 0,
    batches: 0,
    tokens: 0,
    startedAt: at,
    updatedAt: at,
    ...(refresh === undefined ? {} : { refresh }),
    ...(input.batch === undefined ? {} : { batch: input.batch }),
  }
  write(db, session)
  return session
}

/** 推进一步（每批一次）。返回写进去的那条，方便调用方直接拿去渲染。 */
export function advanceFeedSession(
  db: DatabaseSync,
  patch: {
    readonly source: string
    readonly as: FeedKind
    readonly chunks: number
    readonly batches: number
    readonly tokens: number
    readonly now?: Date
    /** 本轮该喂第几到第几段（不给 = 沿用上一条会话里的指针）。 */
    readonly batch?: FeedSessionBatch | undefined
  },
): FeedSession {
  const previous = readFeedSession(db, { now: patch.now, ignoreStale: true })
  const at = (patch.now ?? new Date()).toISOString()
  // 指针：本次没给就沿用上一次的（"轮次之间只在结束那一刻推进"很常见）
  const batch = patch.batch ?? previous?.batch
  const session: FeedSession = {
    source: patch.source,
    as: patch.as,
    chunks: patch.chunks,
    batches: patch.batches,
    tokens: patch.tokens,
    startedAt: previous?.startedAt ?? at,
    updatedAt: at,
    ...(batch === undefined ? {} : { batch }),
  }
  write(db, session)
  return session
}

/**
 * 结束投喂会话（**醒来**）。
 *
 * 为什么是删掉而不是写一个 `phase: 'done'`：措辞里的"半梦半醒 vs 醒来"这条线
 * **就是"记忆 vs 现在"那条边界**（用户口径）。留一条"已经结束"的记录会让提示词里
 * 继续出现"你在消化记忆"，而那是**错的** —— 边界必须干净。
 * 投喂刚结束时想让模型看到一句"你刚醒"，那是另一件事（见报告里的待定项）。
 */
export function endFeedSession(db: DatabaseSync): void {
  db.prepare('DELETE FROM forlife_state WHERE key = ?').run(FEED_SESSION_KEY)
}

/** 读会话时的选项。 */
export interface ReadFeedSessionOptions {
  /** `undefined` 表示"用当前时间"（测试会注入固定时间）。 */
  readonly now?: Date | undefined
  /** 陈旧上限（默认读基线 `feed.sessionStaleMs`）。 */
  readonly staleMs?: number | undefined
  /** 忽略陈旧判定（写的人自己读回来时用：它刚写完，不该被自己的判定挡掉）。 */
  readonly ignoreStale?: boolean | undefined
}

/**
 * 读当前投喂会话。
 *
 * **任何异常路径都返回 `undefined`**（缺键 / 坏 JSON / 字段不全 / 太旧）：
 * 这个函数会在**渲染提示词的热路径**上被调用，那里抛异常 = 整个提示词装配失败 =
 * 模型完全没有系统提示词（宿主对未定义变量就是抛错，本仓栽过）。
 * 少显示一段"我在消化记忆"是小事，装不出提示词是大事。
 *
 * @param db - 数据库连接。
 * @param options - 见 {@link ReadFeedSessionOptions}。
 * @returns 会话现状；没有/不可信时为 `undefined`。
 */
export function readFeedSession(db: DatabaseSync, options: ReadFeedSessionOptions = {}): FeedSession | undefined {
  let raw: string | undefined
  try {
    const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(FEED_SESSION_KEY) as
      | { value?: string }
      | undefined
    raw = row?.value
  } catch {
    return undefined
  }
  if (raw === undefined || raw.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const source = typeof record['source'] === 'string' ? record['source'] : ''
  const as = record['as']
  const updatedAt = typeof record['updatedAt'] === 'string' ? record['updatedAt'] : ''
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : updatedAt
  if (source === '' || updatedAt === '' || (as !== 'knowledge' && as !== 'experience')) return undefined

  if (options.ignoreStale !== true) {
    const staleMs = options.staleMs ?? defaultFor<number>('feed.sessionStaleMs')
    const updated = Date.parse(updatedAt)
    const now = (options.now ?? new Date()).getTime()
    // 时间戳坏掉（NaN）也按"不可信"处理：宁可不说，也不要让一条坏记录**永远**生效
    if (!Number.isFinite(updated) || !Number.isFinite(now) || now - updated > staleMs) return undefined
  }

  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const sessionRefresh = readSessionRefresh(record['refresh'])
  const sessionBatch = readSessionBatch(record['batch'])
  return {
    source,
    as,
    chunks: count(record['chunks']),
    batches: count(record['batches']),
    tokens: count(record['tokens']),
    startedAt,
    updatedAt,
    ...(sessionRefresh === undefined ? {} : { refresh: sessionRefresh }),
    ...(sessionBatch === undefined ? {} : { batch: sessionBatch }),
  }
}

/**
 * 读会话里那个**批次指针**（同样是"坏数据当没有"）。
 *
 * 为什么不让坏指针把整条会话判死：指针是**进度说明**，
 * 它坏掉不该让"我正在消化记忆"这件事也一起消失（与 `readSessionRefresh` 同一条理由）。
 */
function readSessionBatch(value: unknown): FeedSessionBatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const num = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : undefined
  const from = num(record['from'])
  const to = num(record['to'])
  const total = num(record['total'])
  if (from === undefined || to === undefined || total === undefined) return undefined
  if (to < from) return undefined
  return { from, to, total }
}

/**
 * 读会话里那截源版本（**同样是"坏数据当没有"**）。
 *
 * 为什么不让坏数据把整条会话判死：源版本是**追溯用**的附加信息，
 * 它坏掉不该让"我正在消化记忆"这件事也一起消失。
 */
function readSessionRefresh(value: unknown): FeedSessionRefresh | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const kind = record['kind']
  const at = typeof record['at'] === 'string' ? record['at'] : ''
  const reason = typeof record['reason'] === 'string' ? record['reason'] : ''
  if ((kind !== 'none' && kind !== 'command') || at === '') return undefined
  const num = (raw: unknown): number | undefined => (typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined)
  const items = num(record['items'])
  const previousItems = num(record['previousItems'])
  const delta = num(record['delta'])
  const version = typeof record['version'] === 'string' ? record['version'] : undefined
  return {
    kind,
    reason,
    at,
    ...(items === undefined ? {} : { items }),
    ...(previousItems === undefined ? {} : { previousItems }),
    ...(delta === undefined ? {} : { delta }),
    ...(version === undefined ? {} : { version }),
    ...(record['stale'] === true ? { stale: true } : {}),
  }
}
