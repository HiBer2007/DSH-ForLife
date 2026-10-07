/**
 * 冷数据按需加载 + 延迟记录（阶段 9 验收标准 #3）。
 *
 * ## 验收标准在说什么
 *
 * PLAN 原文：「`recall_longterm` 命中 HDD 条目时**按需加载**，
 * **延迟记录在案**（冷数据可接受）」。
 *
 * 这句话有三层意思，缺一层就不成立：
 *  1. **命中冷层时要去读**（而不是"查不到"或"读到空"）；
 *  2. **延迟要被记下来**（否则"可接受"是感觉，不是事实）；
 *  3. **要有对比**（只记 cold 的话，没人知道 3ms 算快还是慢）。
 *
 * ## 一个必须说清的前提
 *
 * **当前实现里 `long_memory_entries.content` 就在库里** ——
 * 也就是说"冷层条目"的**正文并没有真的搬到 HDD 上**，
 * 只有它的 `archive_path` 指向归档文件（归档是**副本**，见 `archive.ts`）。
 *
 * 所以这里的"按需加载"做的是：
 *  - **`archive_path` 有值** ⇒ 从归档文件读（那才是真的"按需"，
 *    而且**读不到就明确报错**，不悄悄回落到库里的副本）；
 *  - **`archive_path` 为空** ⇒ 从库里读（正文本来就在库里）。
 *
 * ⚠️ **这条区别必须写在返回值里**（`source: 'archive' | 'db'`）——
 * 否则"按需加载"会被误读成"正文在 HDD 上"，而实际不是。
 * **不假装做了一件没做的事。**
 *
 * @module @forlife/store/cold-load
 */
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'

/** 慢到"不可接受"的阈值（毫秒）。 */
export const SLOW_LOAD_MS = 500

/** 一次加载的结果。 */
export interface ColdLoadResult {
  readonly found: boolean
  readonly content?: string
  readonly tier: string
  /** **正文是从哪读的** —— `archive` 才是真的"按需加载"。 */
  readonly source: 'archive' | 'db' | 'none'
  readonly latencyMs: number
  readonly note: string
}

/** 读文件的替身（测试用）。 */
export type ReadTextFile = (path: string) => Promise<string>

/** 默认的读文件实现。 */
const defaultRead: ReadTextFile = (path) => readFile(path, 'utf8')

/**
 * 按需加载一条长期记忆，并**记录延迟**。
 *
 * **延迟是"不管成功失败都记"** —— 失败的那次往往才是最慢的
 * （磁盘坏了会超时重试），只记成功的话会把最坏情况藏起来。
 */
export async function loadLongEntry(options: {
  readonly db: DatabaseSync
  readonly id: string
  readonly readFile?: ReadTextFile
  readonly now?: () => number
  readonly slowMs?: number
}): Promise<ColdLoadResult> {
  const nowMs = options.now ?? ((): number => Date.now())
  const read = options.readFile ?? defaultRead
  const slowMs = options.slowMs ?? SLOW_LOAD_MS
  const started = nowMs()

  const row = options.db
    .prepare('SELECT id, content, storage_tier, archive_path FROM long_memory_entries WHERE id = ?')
    .get(options.id) as
    | { id: string; content: string; storage_tier: string; archive_path: string | null }
    | undefined

  if (row === undefined) {
    const latencyMs = Math.max(0, Math.round(nowMs() - started))
    // **失败也记**（失败的那次往往最慢）
    recordLoad(options.db, 'none', latencyMs, slowMs, options.now ?? ((): number => Date.now()))
    return { found: false, tier: 'none', source: 'none', latencyMs, note: `没有这条长期记忆：${options.id}` }
  }

  const tier = row.storage_tier

  // `archive_path` 有值 ⇒ 从归档读（**那才是真的"按需"**）
  if (row.archive_path !== null && row.archive_path !== '') {
    try {
      const text = await read(row.archive_path)
      const latencyMs = Math.max(0, Math.round(nowMs() - started))
      recordLoad(options.db, tier, latencyMs, slowMs, options.now ?? ((): number => Date.now()))
      return {
        found: true,
        content: text,
        tier,
        source: 'archive',
        latencyMs,
        note: `从归档按需加载（${String(latencyMs)}ms）`,
      }
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(nowMs() - started))
      recordLoad(options.db, tier, latencyMs, slowMs, options.now ?? ((): number => Date.now()))
      // **不悄悄回落到库里的副本** —— 那会掩盖"归档坏了"这件事，
      // 而归档坏了正是最该被发现的事（它是"很久以后才回来读"的东西）
      return {
        found: false,
        tier,
        source: 'archive',
        latencyMs,
        note: `归档读不出来（**没有回落到库内副本**，因为那会掩盖"归档坏了"）：${String(error).slice(0, 120)}`,
      }
    }
  }

  // 正文本来就在库里 ⇒ 从库里读（**如实报 source: 'db'**）
  const latencyMs = Math.max(0, Math.round(nowMs() - started))
  recordLoad(options.db, tier, latencyMs, slowMs, options.now ?? ((): number => Date.now()))
  return {
    found: true,
    content: row.content,
    tier,
    source: 'db',
    latencyMs,
    note: `${tier} 层，正文在库内（**没有归档文件**，所以这不算"从 HDD 按需加载"）`,
  }
}

/** 累加延迟统计（按 tier 分行）。 */
export function recordLoad(
  db: DatabaseSync,
  tier: string,
  latencyMs: number,
  slowMs: number = SLOW_LOAD_MS,
  now: () => number = (): number => Date.now(),
): void {
  const isSlow = latencyMs >= slowMs ? 1 : 0
  db.prepare(
    `INSERT INTO cold_load_stats (tier, loads, total_ms, max_ms, last_ms, last_at, slow_loads)
     VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(tier) DO UPDATE SET
       loads = loads + 1,
       total_ms = total_ms + excluded.total_ms,
       -- **max 要取较大者** —— 只累加的话"最慢的那次"会被平均掉
       max_ms = MAX(max_ms, excluded.max_ms),
       last_ms = excluded.last_ms,
       last_at = excluded.last_at,
       slow_loads = slow_loads + excluded.slow_loads`,
  ).run(tier, latencyMs, latencyMs, latencyMs, new Date(now()).toISOString(), isSlow)
}

/** 读延迟统计（面板用）。 */
export function loadStats(db: DatabaseSync): readonly {
  readonly tier: string
  readonly loads: number
  readonly avgMs: number
  readonly maxMs: number
  readonly lastMs: number
  readonly lastAt: string | null
  readonly slowLoads: number
}[] {
  const rows = db
    .prepare('SELECT * FROM cold_load_stats ORDER BY tier')
    .all() as unknown as readonly {
    tier: string
    loads: number
    total_ms: number
    max_ms: number
    last_ms: number
    last_at: string | null
    slow_loads: number
  }[]
  return rows.map((r) => ({
    tier: r.tier,
    loads: Number(r.loads),
    // **平均要现算**（存平均值的话，增量更新会算错）
    avgMs: Number(r.loads) === 0 ? 0 : Math.round(Number(r.total_ms) / Number(r.loads)),
    maxMs: Number(r.max_ms),
    lastMs: Number(r.last_ms),
    lastAt: r.last_at,
    slowLoads: Number(r.slow_loads),
  }))
}
