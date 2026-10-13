/**
 * **存储库指标**（`FIX_PLAN.md` §57 待办⑥）—— 让"库在退化"这件事**在日志里看得见**。
 *
 * ## 为什么需要它
 *
 * 库的大小 / WAL / 空闲页**面板上本来就有**（`queries-storage.ts` 给存储页算的），
 * ★ 但那要**有人去打开面板**才看得见。于是：
 *
 * - WAL 没被 checkpoint 掉（一直涨）⇒ 没人知道，直到磁盘满；
 * - 空闲页越积越多（删过很多行）⇒ 文件只涨不缩，也没人知道；
 * - 面板某个页面开始变慢（库在退化）⇒ 只会被当成"网络慢"。
 *
 * ⇒ 本模块把这些**挑几个指标**定期读出来、**只在跨过阈值时**写一条日志
 *   （模块 `storage`，与其它模块一样能在面板上按模块筛）。
 *
 * ## ★ 指标是"选过的"，不是"能拿到的全拿"
 *
 * | 指标 | 为什么值得记 | 代价 |
 * | :--- | :--- | :--- |
 * | `-wal` 文件大小 | ★ WAL 涨起来 = **checkpoint 没在做**，磁盘会满 | 一次 `stat` |
 * | 空闲页比例（`freelist_count`/`page_count`） | 删过很多行 ⇒ 文件只涨不缩，是 `VACUUM` 的判据 | 两条 `PRAGMA` |
 * | 库文件大小（相对基线） | 增长趋势；★ 单看绝对值没有意义，**要有基线** | 一次 `stat` |
 * | 慢查询（调用方计时后传进来） | 库退化的**第一手症状** | 调用方一个计时器 |
 *
 * ★ **不做**的事：`PRAGMA integrity_check`（全库扫描，秒级到分钟级）——
 *   那是备份流程的活（`backup.ts` 已经在做），不是这里每分钟跑的东西。
 *
 * ## ★ 边沿检测（本仓反复出现的一条纪律）
 *
 * 指标是**持续**的（WAL 大就一直大）⇒ 每轮都写日志会把库灌满、把面板淹掉。
 * 所以只在**跨过阈值**时写一条，回落到阈值一半以下时再写一条"恢复了"。
 *
 * @module @forlife/gateway/admin/storage-metrics
 */
import { statfsSync, statSync } from 'node:fs'

import type { DatabaseSync } from 'node:sqlite'

import type { LoggerLike } from './log.ts'

/** 读出来的指标（都是**只读**、便宜的）。 */
export interface StorageMetrics {
  /** `journal_mode`（正常是 `wal`）。 */
  readonly journalMode: string
  /** 页大小（字节）。 */
  readonly pageSize: number
  /** 总页数。 */
  readonly pageCount: number
  /** 空闲页数（删行留下的洞）。 */
  readonly freelistCount: number
  /** 库文件字节数（拿不到 = `0`，例如内存库）。 */
  readonly dbBytes: number
  /** `-wal` 文件字节数（没有 = `0`）。 */
  readonly walBytes: number
  /** `busy_timeout`（毫秒）—— 多进程同机时它决定"锁等待能忍多久"。 */
  readonly busyTimeoutMs: number
  /**
   * ★★ 库所在**文件系统的剩余字节**（`undefined` = **取不到**）。
   *
   * ★ 为什么单列一个：§70 真出过**磁盘被写满**，而 `tiering.warnFreeBytes`（5GB）
   *   在契约里躺着、**没有任何代码读它** ⇒ 这条阈值从来没起过作用。
   *
   * ★ `undefined` 与 0 是**两件事**：取不到不许当成"没空间"（那会误报），
   *   也不许当成"健康"（那会漏报）—— 如实报"没查到"（与 `checkDisk` 同一条纪律）。
   */
  readonly freeBytes: number | undefined
  /** 文件系统总字节（`undefined` = 取不到）。 */
  readonly totalBytes: number | undefined
}

/** 空闲页占比（0..1）；页数为 0 时给 0（不造 NaN）。 */
export function freeRatio(metrics: StorageMetrics): number {
  return metrics.pageCount === 0 ? 0 : metrics.freelistCount / metrics.pageCount
}

/** 一次 `stat`，失败给 `0`（文件不存在是**正常**的：没有 WAL 说明刚 checkpoint 过）。 */
function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 读一条 `PRAGMA`，拿第一个数字字段。 */
function pragmaNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined
  if (row === undefined) return 0
  const first = Object.values(row)[0]
  return typeof first === 'number' ? first : Number(first ?? 0) || 0
}

/** 读一条 `PRAGMA`，拿第一个字符串字段。 */
function pragmaText(db: DatabaseSync, sql: string): string {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined
  if (row === undefined) return ''
  const first = Object.values(row)[0]
  return typeof first === 'string' ? first : String(first ?? '')
}

/**
 * 读库所在文件系统的剩余空间。
 *
 * ★ 与 `wake-system-monitor.ts` 的 `checkDisk` 同一条纪律：**取不到不算健康、也不算坏了**，
 *   如实返回 `undefined`（调用方在日志里说"没查到"）。
 *
 * @param mountPath - 要看的路径（生产里给库文件所在目录）。
 * @returns `{ freeBytes, totalBytes }`；拿不到给 `undefined`。
 */
export function readFreeSpace(mountPath: string): { readonly freeBytes: number; readonly totalBytes: number } | undefined {
  try {
    const stats = statfsSync(mountPath)
    // 有些文件系统 `bavail` 会是 0 或异常值 —— 用总块数兜底（照 `checkDisk` 的做法）
    const total = stats.blocks
    const free = stats.bavail
    if (total <= 0) return undefined
    const blockSize = stats.bsize > 0 ? stats.bsize : 4096
    return { freeBytes: free * blockSize, totalBytes: total * blockSize }
  } catch {
    return undefined
  }
}

/**
 * 读出当前指标。
 *
 * @param db - 已打开的库。
 * @param dbPath - 库文件路径（`-wal` 由它推出来）；`:memory:` 时给 `undefined`。
 * @returns 指标（★ 任何一条读不到都给 0/空串，**不抛** —— 指标读失败不该反杀进程）。
 */
export function readStorageMetrics(db: DatabaseSync, dbPath?: string): StorageMetrics {
  const pageSize = pragmaNumber(db, 'PRAGMA page_size')
  const pageCount = pragmaNumber(db, 'PRAGMA page_count')
  const freelistCount = pragmaNumber(db, 'PRAGMA freelist_count')
  const busyTimeoutMs = pragmaNumber(db, 'PRAGMA busy_timeout')
  const journalMode = pragmaText(db, 'PRAGMA journal_mode')
  const realPath = dbPath === undefined || dbPath === ':memory:' ? undefined : dbPath
  const space = realPath === undefined ? undefined : readFreeSpace(realPath)
  return {
    journalMode,
    pageSize,
    pageCount,
    freelistCount,
    dbBytes: realPath === undefined ? 0 : size(realPath),
    walBytes: realPath === undefined ? 0 : size(`${realPath}-wal`),
    busyTimeoutMs,
    freeBytes: space?.freeBytes,
    totalBytes: space?.totalBytes,
  }
}

/** 一行摘要（日志与面板都能用）。 */
export function describeStorageMetrics(metrics: StorageMetrics): string {
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`
  // ★ 剩余空间：取不到就**明说"没查到"**（既不显示成 0，也不省略 —— 省略会让人以为没这项）
  const free =
    metrics.freeBytes === undefined
      ? '剩余空间=没查到'
      : `剩余=${mb(metrics.freeBytes)}${metrics.totalBytes === undefined ? '' : `/${mb(metrics.totalBytes)}`}`
  return (
    `journal=${metrics.journalMode} 库=${mb(metrics.dbBytes)} WAL=${mb(metrics.walBytes)}` +
    ` 页=${String(metrics.pageCount)}（空闲 ${String(metrics.freelistCount)}，${(freeRatio(metrics) * 100).toFixed(1)}%）` +
    ` busy_timeout=${String(metrics.busyTimeoutMs)}ms ${free}`
  )
}

/** 阈值（★ 默认值是"该有人看一眼"的量级，不是"精确的工程常数"）。 */
export interface StorageThresholds {
  /** `-wal` 超过它就 `warn`（默认 64MB：WAL 到这个量级说明 checkpoint 没跟上）。 */
  readonly walWarnBytes?: number
  /** 空闲页占比超过它就 `note`（默认 0.2：两成是洞，值得 VACUUM）。 */
  readonly freeRatioWarn?: number
  /** 库相对基线长这么多倍才 `note`（默认 0.5 = 长了一半）。 */
  readonly growthWarnRatio?: number
  /** 增长告警的绝对下限（默认 100MB：小库长一半不值得半夜叫人）。 */
  readonly growthWarnBytes?: number
  /**
   * ★★ 剩余空间低于它就 `warn`（默认 5GB —— **与契约里的 `tiering.warnFreeBytes` 一致**）。
   *
   * ★ 生产里应当由调用方传 `defaultFor('tiering.warnFreeBytes')`：这个键在契约里躺了很久，
   *   而**没有任何代码读它** ⇒ §70 真出过磁盘被写满、这条阈值一次都没生效。
   */
  readonly freeWarnBytes?: number
  /** 剩余空间低于它就 `fault`（默认 1GB：到这个量级，写盘随时会失败）。 */
  readonly freeFaultBytes?: number
}

/** 监视循环选项。 */
export interface StorageWatchOptions {
  readonly db: DatabaseSync
  readonly dbPath?: string
  readonly logger?: LoggerLike
  /** 退路：没给 `logger` 时用它。 */
  readonly log?: (message: string) => void
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly thresholds?: StorageThresholds
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
}

/** 循环句柄。 */
export interface StorageWatch {
  /** 跑一次（测试直接调它）。 */
  readonly tick: () => StorageMetrics
  /** 当前是否处于"WAL 告警"状态（排障用）。 */
  readonly walWarned: () => boolean
  readonly stop: () => void
}

const DEFAULT_WAL_WARN_BYTES = 64 * 1024 * 1024
const DEFAULT_FREE_RATIO_WARN = 0.2
const DEFAULT_GROWTH_WARN_RATIO = 0.5
const DEFAULT_GROWTH_WARN_BYTES = 100 * 1024 * 1024
/** ★ 与契约 	iering.warnFreeBytes 同一个值（生产由调用方显式传，这里只是兜底）。 */
const DEFAULT_FREE_WARN_BYTES = 5 * 1024 * 1024 * 1024
/** 到这个量级，写盘随时会失败。 */
const DEFAULT_FREE_FAULT_BYTES = 1024 * 1024 * 1024

/**
 * 一条都没读到时的返回值（**只有第一次读就失败**才会用到）。
 *
 * ★ 为什么给"全 0"而不是抛：调用方（面板/监视）要的是一个**可打印的东西**，
 *   而"读不到"这件事已经由那条 `warn` 说清了 —— 让它抛只会再杀一个循环。
 */
const EMPTY_METRICS: StorageMetrics = {
  journalMode: '',
  pageSize: 0,
  pageCount: 0,
  freelistCount: 0,
  dbBytes: 0,
  walBytes: 0,
  busyTimeoutMs: 0,
  freeBytes: undefined,
  totalBytes: undefined,
}

/**
 * 启动存储指标监视。
 *
 * ★ 第一条日志是**基线**（`note`）：不记基线的话，"库变大了"这句话没有参照
 *   （下一次进程重启就没人知道起点在哪）。
 *
 * @param options - 见 {@link StorageWatchOptions}。
 * @returns 句柄。
 */
export function startStorageWatch(options: StorageWatchOptions): StorageWatch {
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): Date => new Date())
  const intervalMs = Math.max(10_000, options.intervalMs ?? 5 * 60_000)
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))
  const walWarnBytes = options.thresholds?.walWarnBytes ?? DEFAULT_WAL_WARN_BYTES
  const freeRatioWarn = options.thresholds?.freeRatioWarn ?? DEFAULT_FREE_RATIO_WARN
  const growthWarnRatio = options.thresholds?.growthWarnRatio ?? DEFAULT_GROWTH_WARN_RATIO
  const growthWarnBytes = options.thresholds?.growthWarnBytes ?? DEFAULT_GROWTH_WARN_BYTES
  const freeWarnBytes = options.thresholds?.freeWarnBytes ?? DEFAULT_FREE_WARN_BYTES
  const freeFaultBytes = options.thresholds?.freeFaultBytes ?? DEFAULT_FREE_FAULT_BYTES

  const emit = (level: 'note' | 'warn' | 'fault', message: string): void => {
    const target = options.logger?.[level]
    if (target !== undefined) target(message)
    else log(message)
  }

  let baseline: number | undefined
  let walWarned = false
  let freeWarned = false
  /** ★ 剩余空间的边沿状态（ok / warn / ault）。 */
  let spaceState: 'ok' | 'warn' | 'fault' | undefined
  /** 最近一次**成功**读到的指标（读失败时返回它，并说明"这次没读到"）。 */
  let last: StorageMetrics | undefined

  const readOnce = (): StorageMetrics => {
    const metrics = readStorageMetrics(options.db, options.dbPath)
    last = metrics
    return metrics
  }

  const tick = (): StorageMetrics => {
    let metrics: StorageMetrics
    try {
      metrics = readOnce()
    } catch (error) {
      // ★★ 读失败**不许反杀循环**：定时器里抛异常会静默杀死整个监视
      //   （"从此再也没有存储指标"而没人知道）。如实报，并退回上一次的值。
      emit('warn', `存储指标读取失败（已忽略，下一轮再试）：${String(error).slice(0, 200)}`)
      return last ?? EMPTY_METRICS
    }
    const at = now().toISOString()

    // ① 基线：只记一次
    if (baseline === undefined) {
      baseline = metrics.dbBytes
      emit('note', `[${at}] 存储基线：${describeStorageMetrics(metrics)}`)
    }

    // ② WAL 跨过阈值 ⇒ warn；回落到阈值一半以下 ⇒ 报恢复（★ 边沿检测，不刷屏）
    if (metrics.walBytes >= walWarnBytes) {
      if (!walWarned) {
        walWarned = true
        emit(
          'warn',
          `[${at}] WAL 涨到 ${(metrics.walBytes / 1024 / 1024).toFixed(1)}MB（阈值 ${(walWarnBytes / 1024 / 1024).toFixed(0)}MB）` +
            ` ⇒ checkpoint 没跟上，磁盘会被吃掉：${describeStorageMetrics(metrics)}`,
        )
      }
    } else if (walWarned && metrics.walBytes < walWarnBytes / 2) {
      walWarned = false
      emit('note', `[${at}] WAL 回落到 ${(metrics.walBytes / 1024 / 1024).toFixed(1)}MB（checkpoint 跟上了）`)
    }

    // ③ 空闲页比例（VACUUM 的判据）
    const ratio = freeRatio(metrics)
    if (ratio >= freeRatioWarn) {
      if (!freeWarned) {
        freeWarned = true
        emit(
          'note',
          `[${at}] 空闲页占比 ${(ratio * 100).toFixed(1)}%（${String(metrics.freelistCount)}/${String(metrics.pageCount)} 页）` +
            ` ⇒ 删过不少行、文件只涨不缩，可以考虑 VACUUM：${describeStorageMetrics(metrics)}`,
        )
      }
    } else if (freeWarned && ratio < freeRatioWarn / 2) {
      freeWarned = false
      emit('note', `[${at}] 空闲页占比回落到 ${(ratio * 100).toFixed(1)}%`)
    }

    // ④ 库文件相对基线增长（★ 两个条件都要满足：比例与绝对值 —— 小库长一半不值得叫人）
    const grew = metrics.dbBytes - baseline
    if (baseline > 0 && grew >= growthWarnBytes && grew >= baseline * growthWarnRatio) {
      const from = baseline
      baseline = metrics.dbBytes
      emit(
        'note',
        `[${at}] 库从 ${(from / 1024 / 1024).toFixed(1)}MB 长到 ${(metrics.dbBytes / 1024 / 1024).toFixed(1)}MB` +
          `（+${(grew / 1024 / 1024).toFixed(1)}MB）：${describeStorageMetrics(metrics)}`,
      )
    }

    // ⑤ ★★ 剩余空间（§70 的活教训：`tiering.warnFreeBytes` 在契约里躺着，
    //    而**没有任何代码读它** ⇒ 磁盘真被写满过一次，这条阈值一次都没生效）
    //
    //    ★ 取不到（`undefined`）⇒ **不报**，但基线里会写"没查到"（取不到不等于坏了）
    if (metrics.freeBytes !== undefined) {
      const next: 'ok' | 'warn' | 'fault' =
        metrics.freeBytes < freeFaultBytes ? 'fault' : metrics.freeBytes < freeWarnBytes ? 'warn' : 'ok'
      if (next !== spaceState) {
        const from = spaceState
        spaceState = next
        const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
        if (next === 'fault') {
          emit(
            'fault',
            `[${at}] ★ 剩余空间只剩 ${gb(metrics.freeBytes)}（危险线 ${gb(freeFaultBytes)}）` +
              ` ⇒ 写盘随时会失败，先清冷层/日志：${describeStorageMetrics(metrics)}`,
          )
        } else if (next === 'warn') {
          emit(
            'warn',
            `[${at}] 剩余空间 ${gb(metrics.freeBytes)} 低于警戒线 ${gb(freeWarnBytes)}` +
              `（来自 tiering.warnFreeBytes）：${describeStorageMetrics(metrics)}`,
          )
        } else if (from !== undefined) {
          emit('note', `[${at}] 剩余空间回到 ${gb(metrics.freeBytes)}（高于警戒线）`)
        }
      }
    }

    return metrics
  }

  const handle = setIntervalFn(() => {
    // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环（监视从此失效而没人知道）
    try {
      tick()
    } catch (error) {
      emit('warn', `存储指标读取失败（已忽略，下一轮再试）：${String(error).slice(0, 200)}`)
    }
  }, intervalMs)
  handle.unref?.()

  // ★★ 立刻先跑一次（不等第一个间隔）。
  //
  //   为什么：① 基线要**当场**记下来（否则要等 5 分钟，中间一重启就永远没有基线 ——
  //   真机第一次部署就是这样：库里一条 `storage` 都没有）；
  //   ② ★ 它同时是"这个监视真的活着"的凭据 —— 只有周期性日志的话，
  //     "没日志"既可能是没跨阈值、也可能是循环根本没起来，两者分不开。
  //   ★ `tick()` 自己接异常，所以这里不会因为读失败而挡住启动。
  tick()

  return {
    tick,
    walWarned: () => walWarned,
    stop: () => {
      clearIntervalFn(handle)
    },
  }
}
