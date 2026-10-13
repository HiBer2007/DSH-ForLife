/**
 * 「记忆」与「压缩」两个板块的只读查询。
 *
 * ## 为什么单独一个文件、而且只读
 *
 * 面板要回答的是两个**历史问题**：「模型现在记得什么」「它的记忆被谁动过」。
 * 这两类数据全部落在同一份 SQLite 里（网关与 DSH 进程共享同一个库文件，见 store/db.ts 的 WAL 说明），
 * 所以这里直接读库，不经过任何业务层 —— 后台"看一眼"绝不该触发压缩、沉降或缓存预热。
 * 推论：本文件的函数**只发 SELECT**，没有事务、没有写入。一旦有人在里面加 UPDATE，
 * 面板就从"观察窗"变成了"能改模型记忆的东西"，那是另一套审计要求（effects/三写）。
 *
 * ## 列名从哪来
 *
 * 一律以 `packages/store/src/migrations.ts` 的建表语句为准（并用 `PRAGMA table_info` 复核过实际库）。
 * 特别地：`mid_memory_entries` **没有**命中次数字段（只有 `last_accessed_at`），
 * 所以条目视图里没有 `hitCount` —— 面板上少一个格子，远好过编一个列名把接口打成 500。
 * 同理，`compaction_runs` 里也没有"压缩前 token"，那个数只在 `compaction_log` 里。
 *
 * ## 与总览页的口径必须一致
 *
 * `long` 计数与 `stats.tokensBefore/tokensAfter` 刻意与 `admin/overview.ts` 用同一口径：
 * 同一个数在两个页面显示成两个值，比没有这个数更糟（看的人会开始怀疑所有数字）。
 *
 * @module @forlife/gateway/admin/queries-memory
 */
import type { DatabaseSync } from 'node:sqlite'

/** 面板默认取多少条中期记忆。 */
const DEFAULT_ENTRY_LIMIT = 50
/** 面板默认取多少条压缩运行 / 日志（两者共用一个 limit）。 */
const DEFAULT_RUN_LIMIT = 30

/**
 * `limit` 的硬上限。
 *
 * 存在的理由：这些查询是**同步**跑在网关进程里的，`LIMIT` 直接决定一次请求从库里搬多少
 * `content`（中期记忆的 content 是整段原文）出来。没有上限时，一个手写的
 * `?limit=100000` 就能让网关卡在 `all()` 上。500 条 × 200 字符预览 ≈ 100KB 量级，
 * 是"人还能看"和"进程还能扛"的交点。
 */
const MAX_LIMIT = 500

/** 预览截断长度（UTF-16 码元）。 */
const PREVIEW_CHARS = 200

/**
 * 把调用方给的 limit 夹到 `[1, MAX_LIMIT]`。
 *
 * 为什么不直接信任调用方：HTTP query 传进来的永远是字符串，`Number('abc')` 是 NaN，
 * 而 `NaN` 绑进 `LIMIT ?` 之后 SQLite 会把它当成 NULL ⇒ **不报错但返回整表**
 * （正是这里最想避免的结果）。所以非有限数一律回落到默认值，小数向下取整。
 *
 * `0` 和负数一律抬到 1 而不是当成"不要数据"：面板上没有"显示 0 条"这种需求，
 * 返回 1 条能让人立刻看出参数传错了，静默返回 50 条则看不出来。
 */
function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < 1) return 1
  return Math.min(floored, MAX_LIMIT)
}

/**
 * SQLite 的读数转 number。
 *
 * `node:sqlite` 在整数超出安全范围（或开了 `readBigInts`）时给的是 bigint，
 * 直接进算术会抛 `TypeError`。只读面板没必要引入 bigint：统一收敛成 number，
 * 计数真到这个量级时人眼也只需要数量级（精度损失不影响"要不要清库"的判断）。
 */
function toNumber(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'bigint' ? Number(value) : value
}

/**
 * 截断到 `max` 个 UTF-16 码元。
 *
 * 为什么在 JS 侧截而不是 SQL 侧 `substr`：SQLite 的 `substr` 按**码点**数，
 * JS 的 `slice` 按**码元**数，中文两者一致、emoji 会差一点 —— 这个差异本身无所谓，
 * 真正的原因是截断规则留在 JS 里**可测**（测试能直接钉住 200 这个数），
 * 把常量埋进 SQL 字符串里就只能靠读代码来确认。
 *
 * 唯一的坑：截断点正好落在代理对中间会切出**孤立代理**，`JSON.stringify` 之后
 * 前端渲染成 `�`。所以发现最后一个是高位代理（0xD800-0xDBFF）就少取一个码元。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastUnit = cut.charCodeAt(max - 1)
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, max - 1) : cut
}

/**
 * `forlife_state` 里的整数键。
 *
 * 缺失、空串、`Number()` 出 NaN 一律给 0：迁移 1 只保证插入了这两行，
 * 值仍可能是脏的（手工改库、将来换了别的写法）。给 NaN 会让整个面板的
 * epoch 变成 `null`（JSON 序列化时 NaN → null），那比 0 更难排查。
 */
function stateNumber(db: DatabaseSync, key: string): number {
  const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value?: string } | undefined
  const raw = row?.value
  if (raw === undefined) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 单值字符串查询（没有行或为 NULL 都给 undefined）。 */
function scalarText(db: DatabaseSync, sql: string): string | undefined {
  const row = db.prepare(sql).get() as { v?: string | null } | undefined
  return row?.v ?? undefined
}

/**
 * 取两个可空时间戳里更晚的那个。
 *
 * ISO-8601 UTC 定长字符串的**字典序等于时间序**（全库统一存 UTC ISO 的红利），
 * 所以直接比字符串，不用 `Date` 解析：解析失败会得到 NaN，而 NaN 参与的比较**全是 false**，
 * 那会静默给出一个错误的答案（最坏的一类 bug）。
 */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

/** 一行 `GROUP BY` 聚合的原始读数（`SUM` 在空分组时是 NULL，`COUNT` 不会是）。 */
interface GroupRow {
  readonly key: string | null
  readonly n: number | bigint | null
  readonly t?: number | bigint | null
}

/** 从分组结果里取一个键的读数：键不存在 ⇒ 0/0（面板要的是"没有就是 0"，不是缺字段）。 */
function groupOf(rows: readonly GroupRow[], key: string): { readonly count: number; readonly tokens: number } {
  const row = rows.find((candidate) => candidate.key === key)
  return { count: toNumber(row?.n), tokens: toNumber(row?.t) }
}

// ── 记忆 ──────────────────────────────────────────────────────────────────────

/** `mid_memory_entries.entry_type` 的取值（migrations.ts 的注释：semantic / fragment）。 */
export type MemoryEntryType = 'semantic' | 'fragment'

/** `mid_memory_entries.status` 的取值（active / fragmented / archived）。 */
export type MemoryEntryStatus = 'active' | 'fragmented' | 'archived'

/**
 * 面板里的一行中期记忆。
 *
 * 可选/可空的处理遵循全模块同一条规矩（与 `queries-qq.ts` 的 `toBool`/`num` 一致）：
 * **接口上只暴露"真 JS 值"，不暴露 SQLite 的存储细节** ——
 *  - 列是 NULL 的可选字段（`lastAccessedAt` / `sourceScope`）**整个省略**，而不是给 `null`：
 *    前端只要判断一次 `=== undefined`，不必同时处理 null 与 undefined 两种"没有值"；
 *  - 0/1 布尔列转真 `boolean`（否则模板会渲染出 1/0）。
 * `sourceScope` 这条尤其要守住：它表示"这条记忆是哪个群/谁写的"，
 * "没有来源"必须是一个能被识别出来的状态（前端一次 `undefined` 判断），
 * 否则界面上的空白既可能是"没记"也可能是"没写"，就没人敢据此下结论了。
 */
export interface MemoryEntryView {
  readonly id: string
  readonly entryType: MemoryEntryType
  readonly status: MemoryEntryStatus
  readonly summary: string
  /** `content` 的前 200 个码元；原文为空（fragment 的常态）时是空串。 */
  readonly contentPreview: string
  readonly tokenCount: number
  readonly windowOffset: number
  readonly compactionEpoch: number
  readonly sourceScope?: string
  readonly createdAt: string
  readonly lastAccessedAt?: string
}

/** 「记忆」板块的一次性快照（与 `admin-ui/src/api/types.ts` 的 `MemoryOverview` 一一对应）。 */
export interface MemoryOverview {
  /** 当前压缩 epoch（`forlife_state.compaction_epoch`，缺失为 0）。 */
  readonly epoch: number
  /** 全局渲染修订号（`forlife_state.render_revision`，缺失为 0）。 */
  readonly revision: number
  readonly counts: {
    readonly active: number
    readonly fragmented: number
    readonly archived: number
    /** 长期记忆总条数（含 archived）——与总览页 `memory.longEntries` 同一口径。 */
    readonly long: number
  }
  readonly tokens: {
    readonly active: number
    readonly fragment: number
  }
  readonly entries: readonly MemoryEntryView[]
}

/** `mid_memory_entries` 的原始行（只声明本文件真正用到的列）。 */
interface RawMidRow {
  readonly id: string
  readonly entry_type: MemoryEntryType
  readonly content: string | null
  readonly summary: string
  readonly token_count: number
  readonly window_offset: number
  readonly status: MemoryEntryStatus
  readonly compaction_epoch: number
  readonly created_at: string
  readonly last_accessed_at: string | null
  readonly source_scope: string | null
}

/**
 * 读「记忆」板块。
 *
 * 纯 SELECT；空库时各计数为 0、`entries` 为空数组，绝不抛异常
 * （面板在全新部署上必须能打开，第一印象就是"这里什么都没有"，而不是一屏红字）。
 *
 * @param db - 已迁移的数据库连接。
 * @param options - `limit`：返回多少条中期记忆（默认 50，夹在 1..500）。
 * @returns 记忆总览。
 */
export function queryMemory(db: DatabaseSync, options: { readonly limit?: number } = {}): MemoryOverview {
  const limit = clampLimit(options.limit, DEFAULT_ENTRY_LIMIT)

  // 一次分组查询拿全三种状态的条数与 token：状态只有三种，扫一遍胜过发三条 COUNT。
  // 未知状态**故意忽略**：那是脏数据，把它算进"碎片"或"归档"都是在编数字。
  const groups = db
    .prepare(
      `SELECT status AS key, COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS t
         FROM mid_memory_entries
        GROUP BY status`,
    )
    .all() as unknown as GroupRow[]
  const active = groupOf(groups, 'active')
  const fragmented = groupOf(groups, 'fragmented')

  // 长期记忆按"有多少行"数，**不**按 status 过滤：`long_memory_entries.status` 可空，
  // 早期写入的行可能是 NULL，`WHERE status = 'active'` 会把它们从总数里悄悄抹掉。
  const longRow = db.prepare('SELECT COUNT(*) AS n FROM long_memory_entries').get() as
    | { n?: number | bigint | null }
    | undefined

  // 排序：`window_offset DESC` 让最近的记忆在最上面；带一个 `id` 兜底是为了**确定性** ——
  // window_offset 由"当前 epoch 内 max+1"生成、本应唯一，但回滚/导入之后可能出现重复，
  // 没有兜底键时同样两次请求可能给出不同顺序（面板上表现为行乱跳）。
  //
  // 用显式列清单而不是 `SELECT *`：要让"哪些列参与前端契约"一眼可见，
  // 将来给表加列时也不会莫名其妙多传一段原文出来。
  const rows = db
    .prepare(
      `SELECT id, entry_type, content, summary, token_count, window_offset, status,
              compaction_epoch, created_at, last_accessed_at, source_scope
         FROM mid_memory_entries
        ORDER BY window_offset DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as RawMidRow[]

  const entries = rows.map((row): MemoryEntryView => {
    // 先收窄成局部变量再条件展开：`exactOptionalPropertyTypes` 下可选属性**不能**被赋 undefined，
    // 而直接写 `...(x === null ? {} : { k: x })` 时 x 若还是 `T | null` 会编译失败。
    const lastAccessedAt = row.last_accessed_at
    const sourceScope = row.source_scope
    return {
      id: row.id,
      entryType: row.entry_type,
      status: row.status,
      summary: row.summary,
      contentPreview: truncate(row.content ?? '', PREVIEW_CHARS),
      tokenCount: toNumber(row.token_count),
      windowOffset: toNumber(row.window_offset),
      compactionEpoch: toNumber(row.compaction_epoch),
      createdAt: row.created_at,
      ...(sourceScope === null ? {} : { sourceScope }),
      ...(lastAccessedAt === null ? {} : { lastAccessedAt }),
    }
  })

  return {
    epoch: stateNumber(db, 'compaction_epoch'),
    revision: stateNumber(db, 'render_revision'),
    counts: {
      active: active.count,
      fragmented: fragmented.count,
      archived: groupOf(groups, 'archived').count,
      long: toNumber(longRow?.n),
    },
    tokens: { active: active.tokens, fragment: fragmented.tokens },
    entries,
  }
}

// ── 压缩 ──────────────────────────────────────────────────────────────────────

/** `compaction_runs.phase` 的取值（store/compaction-runs.ts 只写这三个）。 */
export type CompactionPhase = 'started' | 'committed' | 'aborted'

/**
 * 一次压缩事务在面板上的样子。
 *
 * `plan` 列**故意不取**：它是回滚依据（要写清所有将被改动的 id，可能很大），
 * 对"发生了什么"没有展示价值；面板要看的是 `detail`（实际结果）与 `error`。
 */
export interface CompactionRunView {
  readonly id: string
  readonly phase: CompactionPhase
  readonly epochFrom: number
  /** 提交前不存在"目标 epoch"，所以可空（注意不是 0 —— epoch 0 是合法值）。 */
  readonly epochTo?: number
  readonly startedAt: string
  readonly endedAt?: string
  readonly error?: string
  /** `detail`（JSON 文本）的前 200 个码元，**仅供显示**：截断后的 JSON 解析不了。 */
  readonly detailPreview?: string
}

/**
 * 一条压缩决策日志（PLAN §4.5 的字段投影）。
 *
 * `approved` 转成真 `boolean`：库里的列是 INTEGER 布尔，PLAN §4.4 的裁决 JSON 也写 `"approved": false`。
 * 注意 `admin-ui/src/api/types.ts` 里这一格暂时还写着 `number` —— 面板渲染 1/0 只会让人以为
 * 那是计数而不是"批准与否"，那一处应当跟着本模块改成 `boolean`。
 */
export interface CompactionLogView {
  readonly id: string
  readonly timestamp: string
  /** model / system；列可空，没记录就省略。 */
  readonly requestedBy?: string
  /** `null`（没记录）→ 字段省略，**不是** false —— 不能替库下"被拒绝"的结论。 */
  readonly approved?: boolean
  readonly reasonIfRejected?: string
  /** 列可空，但面板契约要 number：NULL 按 0 处理（见实现处的说明）。 */
  readonly shortTokensBefore: number
  readonly keptInShortTokens: number
  readonly modelUsed?: string
}

/** 压缩的累计与最近读数。 */
export interface CompactionStats {
  readonly committed: number
  readonly aborted: number
  /**
   * 还停在 `started` 的事务数。
   *
   * 这个数 >0 是**需要报警的信号**，不是普通统计：它意味着上一次压缩没走完就到了重启，
   * 启动回滚（`recoverPendingCompactions`）还没跑或没跑成功 —— 库里可能残留半写的条目。
   */
  readonly started: number
  /** 最近一次压缩**活动**的时间：run 与 log 里更晚的那个（含被拒绝与未完成的）。 */
  readonly lastAt?: string
  /** 最近一次压缩前 / 后的短期窗口 token（取自最新一行日志）。 */
  readonly tokensBefore?: number
  readonly tokensAfter?: number
}

/** 「压缩」板块的一次快照（与 `admin-ui/src/api/types.ts` 的 `CompactionOverview` 一一对应）。 */
export interface CompactionOverview {
  readonly runs: readonly CompactionRunView[]
  readonly log: readonly CompactionLogView[]
  readonly stats: CompactionStats
}

/** `compaction_runs` 的原始行。 */
interface RawRunRow {
  readonly id: string
  readonly phase: CompactionPhase
  readonly epoch_from: number
  readonly epoch_to: number | null
  readonly detail: string | null
  readonly error: string | null
  readonly started_at: string
  readonly ended_at: string | null
}

/** `compaction_log` 的原始行。 */
interface RawLogRow {
  readonly id: string
  readonly timestamp: string
  readonly requested_by: string | null
  readonly approved: number | null
  readonly reason_if_rejected: string | null
  readonly short_tokens_before: number | null
  readonly kept_in_short_tokens: number | null
  readonly model_used: string | null
}

/**
 * 读「压缩」板块。
 *
 * 时间线（`runs`）回答"每次压缩走到哪一步了"；`log` 回答"当时为什么决定压"；
 * `stats` 是给仪表盘用的汇总。三者来自两张表，**不做 join**：
 * `compaction_runs.id` 与 `compaction_log.id` 目前确实是同一个 id
 * （dsh-component 的压缩引擎用 run.id 写日志），但那是调用方的约定而不是外键，
 * join 会让"日志写了、run 没提交"这种异常状态从面板上消失 —— 而那种状态恰恰最该被看见。
 *
 * @param db - 已迁移的数据库连接。
 * @param options - `limit`：runs 与 log 各取多少条（默认 30，夹在 1..500）。
 * @returns 压缩总览。
 */
export function queryCompaction(db: DatabaseSync, options: { readonly limit?: number } = {}): CompactionOverview {
  const limit = clampLimit(options.limit, DEFAULT_RUN_LIMIT)

  const runRows = db
    .prepare(
      `SELECT id, phase, epoch_from, epoch_to, detail, error, started_at, ended_at
         FROM compaction_runs
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as RawRunRow[]

  const runs = runRows.map((row): CompactionRunView => {
    const epochTo = row.epoch_to
    const endedAt = row.ended_at
    const error = row.error
    const detail = row.detail
    return {
      id: row.id,
      phase: row.phase,
      epochFrom: toNumber(row.epoch_from),
      startedAt: row.started_at,
      // 判断用 `=== null` 而不是真值判断：epoch 0 是合法值，`if (!epochTo)` 会把 0 当不存在。
      ...(epochTo === null ? {} : { epochTo }),
      ...(endedAt === null ? {} : { endedAt }),
      ...(error === null ? {} : { error }),
      ...(detail === null ? {} : { detailPreview: truncate(detail, PREVIEW_CHARS) }),
    }
  })

  const logRows = db
    .prepare(
      `SELECT id, timestamp, requested_by, approved, reason_if_rejected,
              short_tokens_before, kept_in_short_tokens, model_used
         FROM compaction_log
        ORDER BY timestamp DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as RawLogRow[]

  const log = logRows.map((row): CompactionLogView => {
    const reason = row.reason_if_rejected
    const model = row.model_used
    const requestedBy = row.requested_by
    const approved = row.approved
    return {
      id: row.id,
      timestamp: row.timestamp,
      // NULL 一律"省略字段"：老行或手工插入的行可能没写这些列，
      // 读成 null/false 等于替库编了一个"被拒绝"的结论。
      ...(requestedBy === null ? {} : { requestedBy }),
      ...(approved === null ? {} : { approved: approved !== 0 }),
      // 这两列可空，但面板契约（admin-ui 的 CompactionLogRow）要求 number：
      // NULL 按 0 处理 —— 与 queries-qq 的 `num()` 同一取舍（聚合/NULL 都给 0），
      // 实际写入方 `recordCompaction` 的入参是非空 number，NULL 只会出现在手工插入的行上。
      shortTokensBefore: toNumber(row.short_tokens_before),
      keptInShortTokens: toNumber(row.kept_in_short_tokens),
      ...(reason === null ? {} : { reasonIfRejected: reason }),
      ...(model === null ? {} : { modelUsed: model }),
    }
  })

  // 分组一次拿全三种 phase 的计数；同样忽略未知取值（脏数据不该污染这三个数）。
  const phaseGroups = db
    .prepare('SELECT phase AS key, COUNT(*) AS n FROM compaction_runs GROUP BY phase')
    .all() as unknown as GroupRow[]

  // `lastAt` 取两个来源里更晚的那个：只取 run 会漏掉"日志已写但事务没提交"，
  // 只取 log 会漏掉"事务已开始但还没写日志"——两个都漏一个，就都不算数。
  const lastAt = laterOf(
    scalarText(db, 'SELECT MAX(started_at) AS v FROM compaction_runs'),
    scalarText(db, 'SELECT MAX(timestamp) AS v FROM compaction_log'),
  )

  // tokensBefore/After 取**最新一行日志**，与总览页 compaction 卡片同一口径：
  // 累计和对"上下文窗口还剩多少"毫无意义（窗口是瞬态的，加总不出任何真实量）。
  //
  // 已知坑：目前唯一的写入方（dsh-component 的压缩引擎）把 short_tokens_before 写死成 0，
  // 所以这两个数现在经常是 0。读侧**照实返回、不去猜**（猜出来的数字会让人以为压缩前
  // 上下文里真的一个 token 都没有）；等写入方补上真实值，这里不用改。
  // 另一个坑：如果将来有写入方为"被拒绝"的请求也记一行，这里会取到那一行 ——
  // 到那时需要加 `WHERE approved = 1`，现在加了反而会让最新（成功）那条被过滤掉。
  const lastLogRow = db
    .prepare(
      `SELECT short_tokens_before AS before, kept_in_short_tokens AS after
         FROM compaction_log
        ORDER BY timestamp DESC, id DESC
        LIMIT 1`,
    )
    .get() as { before?: number | null; after?: number | null } | undefined
  const tokensBefore = lastLogRow?.before ?? undefined
  const tokensAfter = lastLogRow?.after ?? undefined

  return {
    runs,
    log,
    stats: {
      committed: groupOf(phaseGroups, 'committed').count,
      aborted: groupOf(phaseGroups, 'aborted').count,
      started: groupOf(phaseGroups, 'started').count,
      ...(lastAt === undefined ? {} : { lastAt }),
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
    },
  }
}
