/**
 * 总览的运行图表数据 —— 按小时分桶的时序。
 *
 * ## 为什么在 SQL 里按 `substr(at, 1, 13)` 分桶
 *
 * 时间列统一是 ISO-8601 UTC（`2026-10-06T03:00:00.000Z`），取前 13 个字符就是
 * `2026-10-06T03`，**天然按小时对齐**且字典序等于时间序。
 * 比 `strftime` 稳：不依赖 SQLite 对带 `Z` 后缀的解析行为（不同版本有差异）。
 *
 * ## 为什么"空桶也要补零"
 *
 * 图表最忌讳"跳过没有数据的时段"——那会把"某小时完全没消息"画成"连续有消息"，
 * 让人对趋势产生错误印象。所以这里在 JS 侧补齐每一个桶。
 *
 * @module @forlife/gateway/admin/series
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一个可画的时间序列。 */
export interface SeriesPayload {
  /** 每个桶的起点（ISO）。 */
  readonly buckets: readonly string[]
  /** 桶宽度（分钟）。 */
  readonly bucketMinutes: number
  /** 覆盖的总小时数。 */
  readonly hours: number
  /** 每个指标的等长数组（与 buckets 一一对应，缺失补 0）。 */
  readonly metrics: {
    /** 入站消息数。 */
    readonly messages: readonly number[]
    /** 轮次数。 */
    readonly turns: readonly number[]
    /** 路由决策数。 */
    readonly routing: readonly number[]
    /** 其中降级的次数。 */
    readonly degraded: readonly number[]
    /** 提示词 token（未命中输入 + 缓存读 + 缓存写）。 */
    readonly promptTokens: readonly number[]
    /** 缓存命中率（0..1）；该桶没有调用时为 null（**不是 0**，0 会画成"命中率暴跌"）。 */
    readonly cacheHitRate: readonly (number | null)[]
    /** 出站发送成功数。 */
    readonly outboxSent: readonly number[]
    /** 出站失败数。 */
    readonly outboxFailed: readonly number[]
  }
}

/** 把时间截成小时键（与 SQL 侧一致）。 */
function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13)
}

/** 生成从 `hours` 小时前到现在的连续桶键。 */
function bucketKeys(hours: number, now: number): string[] {
  const keys: string[] = []
  const end = new Date(now)
  end.setUTCMinutes(0, 0, 0)
  for (let i = hours - 1; i >= 0; i -= 1) {
    keys.push(hourKey(new Date(end.getTime() - i * 3_600_000)))
  }
  return keys
}

/** 查一组「桶键 → 数值」，然后按 keys 顺序展开（缺失补 0）。 */
function expand(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number)[],
  keys: readonly string[],
  transform: (row: Record<string, number | null>) => number,
): number[] {
  const rows = db.prepare(sql).all(...params) as Record<string, number | null>[]
  const byKey = new Map<string, number>()
  for (const row of rows) {
    const bucket = row['bucket']
    if (typeof bucket === 'string') byKey.set(bucket, transform(row))
  }
  return keys.map((key) => byKey.get(key) ?? 0)
}

/** 组装时序数据。`hours` 会被限制在 1..168（一周）。 */
export function buildSeries(db: DatabaseSync, options: { readonly hours?: number; readonly now?: number } = {}): SeriesPayload {
  const hours = Math.min(168, Math.max(1, Math.floor(options.hours ?? 24)))
  const now = options.now ?? Date.now()
  const keys = bucketKeys(hours, now)
  const since = `${keys[0] ?? hourKey(new Date(now))}:00:00.000Z`

  const messages = expand(
    db,
    "SELECT substr(received_at, 1, 13) AS bucket, COUNT(*) AS n FROM qq_inbox WHERE received_at >= ? GROUP BY bucket",
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  const turns = expand(
    db,
    'SELECT substr(started_at, 1, 13) AS bucket, COUNT(*) AS n FROM qq_turns WHERE started_at >= ? GROUP BY bucket',
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  const routing = expand(
    db,
    'SELECT substr(at, 1, 13) AS bucket, COUNT(*) AS n FROM routing_log WHERE at >= ? GROUP BY bucket',
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  const degraded = expand(
    db,
    'SELECT substr(at, 1, 13) AS bucket, COUNT(*) AS n FROM routing_log WHERE at >= ? AND degraded = 1 GROUP BY bucket',
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  // 提示词总 token = 未命中输入 + 缓存读 + 缓存写（三者互不重叠，见 cache_metrics 的迁移注释）
  const promptTokens = expand(
    db,
    `SELECT substr(at, 1, 13) AS bucket,
            COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS n
       FROM cache_metrics WHERE at >= ? GROUP BY bucket`,
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  const cacheReads = expand(
    db,
    `SELECT substr(at, 1, 13) AS bucket,
            COALESCE(SUM(cache_read_tokens), 0) AS read_tokens,
            COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens
       FROM cache_metrics WHERE at >= ? GROUP BY bucket`,
    [since],
    keys,
    (row) => Number(row['read_tokens'] ?? 0),
  )
  const cacheTotals = expand(
    db,
    `SELECT substr(at, 1, 13) AS bucket,
            COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS n
       FROM cache_metrics WHERE at >= ? GROUP BY bucket`,
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )
  const cacheHitRate = keys.map((_, index) => {
    const total = cacheTotals[index] ?? 0
    if (total === 0) return null // 没有调用 ≠ 命中率 0
    return (cacheReads[index] ?? 0) / total
  })

  const outboxSent = expand(
    db,
    "SELECT substr(sent_at, 1, 13) AS bucket, COUNT(*) AS n FROM qq_outbox WHERE sent_at >= ? AND confirmed = 1 GROUP BY bucket",
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  const outboxFailed = expand(
    db,
    'SELECT substr(sent_at, 1, 13) AS bucket, COUNT(*) AS n FROM qq_outbox WHERE sent_at >= ? AND error IS NOT NULL GROUP BY bucket',
    [since],
    keys,
    (row) => Number(row['n'] ?? 0),
  )

  return {
    buckets: keys.map((key) => `${key}:00:00.000Z`),
    bucketMinutes: 60,
    hours,
    metrics: { messages, turns, routing, degraded, promptTokens, cacheHitRate, outboxSent, outboxFailed },
  }
}
