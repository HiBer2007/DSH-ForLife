/**
 * 日志的**落盘与保留**（用户 2026-10-10 指定）。
 *
 * ## 用户的原话
 *
 * > 「可以设置**保留事件**（retention），但是存储输出时需要**完整存储 INFO 以上的所有日志**
 * >   （默认），除非在环境变量中关闭了某些等级」
 *
 * 分级与"存哪些"的判定在 `log-levels.ts`（已落地）；**本模块只管"写到哪、留多久"**。
 *
 * ## ★ 为什么是「**按天一个文件**」而不是「一个大文件 + 定期裁剪」
 *
 * 保留期落地只有两条路：
 *
 * | 做法 | 后果 |
 * | :--- | :--- |
 * | 一个大文件，删掉开头的老记录 | 每次裁剪都要**重写整个文件** ⇒ 裁的那一刻崩了，**整份日志没了** |
 * | **按天分文件，删掉过期的那些** | 裁剪 = `unlink` 一个文件 —— **原子、不碰其他文件里的任何一条** |
 *
 * ⇒ 选后者。日志系统最不能接受的失败是"**把已经记下来的东西弄丢**"，
 * 而"重写大文件"正好是最容易造成它的做法。
 *
 * ## ★ 为什么写入是**同步**的
 *
 * 异步写意味着"进程崩溃时最后几条还在缓冲区里" —— 而**最后几条恰恰是最该看到的**
 * （崩溃现场）。本仓的日志量不高（127 个调用点，绝大多数是状态变化而非热路径），
 * 所以同步追加的代价换"崩之前的话一定在盘上"，值。
 *
 * ## 三条纪律（与 `log-levels.ts` / `log-buffer.ts` 一致）
 *
 * 1. **写失败绝不反杀调用方** —— 一次日志写失败不该让业务崩掉
 * 2. **读失败当成"没有"** —— 它在面板路径上被调
 * 3. **坏行只跳过它自己** —— 一条写了一半的记录不该让整天的日志读不出来
 *
 * @module @forlife/gateway/admin/log-store
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { type LogRecord } from './log.ts'
import { shouldStore, type LogLevel } from './log-levels.ts'

/** 文件名前缀（列出/裁剪时靠它认，别的文件绝不碰）。 */
export const LOG_FILE_PREFIX = 'forlife-'
export const LOG_FILE_SUFFIX = '.jsonl'

/**
 * 默认保留天数。
 *
 * ⚠️ 这是**默认值**，不是用户给的数（用户只说"可以设置保留事件"）。
 * 通过 `FORLIFE_LOG_RETENTION_DAYS` 改；`0` = **不裁剪**（一直留着）。
 */
export const DEFAULT_LOG_RETENTION_DAYS = 14

/** 一天一个文件：`forlife-2026-10-10.jsonl`。 */
export function logFileName(at: Date): string {
  return `${LOG_FILE_PREFIX}${at.toISOString().slice(0, 10)}${LOG_FILE_SUFFIX}`
}

/** 读环境变量给的保留天数（认不出就用默认，**不静默变成 0**）。 */
export function retentionDaysFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOG_RETENTION_DAYS
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value < 0) return DEFAULT_LOG_RETENTION_DAYS
  return Math.trunc(value)
}

/** 落盘器。 */
export interface LogStore {
  /** 写一条（**已按等级判过**；不该存的直接丢掉）。 */
  readonly write: (record: LogRecord) => void
  /** 裁剪过期文件；返回删了几个。 */
  readonly prune: () => number
  /** 读回来（面板用）。`filter` 之后按时间正序。 */
  readonly read: (filter?: LogQuery) => readonly LogRecord[]
  /** 当前在用的日志文件绝对路径（排障要能一眼看到"日志在哪"）。 */
  readonly currentFile: (now?: Date) => string
}

/** 面板筛选用的查询条件（用户要的"能筛选等级、模块等"）。 */
export interface LogQuery {
  /** 最低等级（含）。 */
  readonly min?: LogLevel
  /** 只要这些模块（空/未给 = 不限）。 */
  readonly modules?: readonly string[]
  /** 只要这些等级（未给 = 不限）。 */
  readonly levels?: readonly LogLevel[]
  /** 文本包含（大小写敏感；未给 = 不限）。 */
  readonly contains?: string
  /** 最多返回几条（**从最新往回取**，缺省 500）。 */
  readonly limit?: number
}

/** 建一个落盘器。`dir` 不存在会被创建。 */
export function createLogStore(options: {
  readonly dir: string
  readonly retentionDays?: number
  readonly disabledLevels?: ReadonlySet<LogLevel>
  readonly minLevel?: LogLevel
  readonly now?: () => Date
  readonly onError?: (message: string) => void
}): LogStore {
  const now = options.now ?? ((): Date => new Date())
  const retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS
  const report = options.onError ?? ((): void => undefined)

  const ensureDir = (): boolean => {
    try {
      mkdirSync(options.dir, { recursive: true })
      return true
    } catch (error: unknown) {
      report(`日志目录不可用（这一条只进内存，不落盘）：${String(error)}`)
      return false
    }
  }

  const listFiles = (): readonly { readonly name: string; readonly path: string }[] => {
    try {
      return readdirSync(options.dir)
        .filter((name) => name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX))
        .sort()
        .map((name) => ({ name, path: join(options.dir, name) }))
    } catch {
      return []
    }
  }

  return {
    currentFile: (at?: Date): string => join(options.dir, logFileName(at ?? now())),

    write(record: LogRecord): void {
      // 存不存：`log-levels.ts` 说了算（默认除了 debug 都存；环境变量能点名关掉）
      const store = shouldStore(record.level, {
        ...(options.minLevel === undefined ? {} : { min: options.minLevel }),
        ...(options.disabledLevels === undefined ? {} : { disabled: options.disabledLevels }),
      })
      if (!store) return
      if (!ensureDir()) return
      try {
        appendFileSync(join(options.dir, logFileName(new Date(record.at))), `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error: unknown) {
        // ★ 绝不反杀调用方
        report(`日志写盘失败（已忽略）：${String(error)}`)
      }
    },

    prune(): number {
      if (retentionDays === 0) return 0
      const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000
      let removed = 0
      for (const file of listFiles()) {
        // 按**文件名里的日期**判，而不是 mtime —— mtime 会被备份/复制改掉，
        // 而文件名是我们自己按记录时间起的，它是**内容**的一部分。
        const day = file.name.slice(LOG_FILE_PREFIX.length, LOG_FILE_PREFIX.length + 10)
        const at = Date.parse(`${day}T00:00:00.000Z`)
        if (!Number.isFinite(at)) continue
        // 保留"今天"这一天整天的文件（cutoff 按天算，不然当天的会被误删）
        if (at + 24 * 60 * 60 * 1000 < cutoff) {
          try {
            unlinkSync(file.path)
            removed += 1
          } catch (error: unknown) {
            report(`日志裁剪失败（已忽略）：${String(error)}`)
          }
        }
      }
      return removed
    },

    read(filter: LogQuery = {}): readonly LogRecord[] {
      const wanted = filter.limit ?? 500
      const out: LogRecord[] = []
      const files = listFiles()
      // 从**最新往回**取：面板要看的是"最近发生了什么"
      for (let i = files.length - 1; i >= 0 && out.length < wanted; i -= 1) {
        const file = files[i]
        if (file === undefined) continue
        let text: string
        try {
          text = readFileSync(file.path, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (let j = lines.length - 1; j >= 0 && out.length < wanted; j -= 1) {
          const record = parseRecord(lines[j])
          // ★ 坏行只跳过它自己
          if (record === undefined) continue
          if (!matches(record, filter)) continue
          out.push(record)
        }
      }
      // 面板要正序（早 → 晚），所以最后翻回来
      return out.reverse()
    },
  }
}

/** 一行 → 一条记录（坏行返回 `undefined`，**不抛**）。 */
function parseRecord(line: string | undefined): LogRecord | undefined {
  if (line === undefined || line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const level = record['level']
  const module = record['module']
  const text = record['text']
  const at = record['at']
  if (typeof module !== 'string' || typeof text !== 'string' || typeof at !== 'string') return undefined
  if (!isLevelName(level)) return undefined
  return { level, module, text, at }
}

function isLevelName(value: unknown): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'note' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'fault' ||
    value === 'crash'
  )
}

/** 面板筛选（用户要的"能筛选等级、模块等"）。 */
function matches(record: LogRecord, filter: LogQuery): boolean {
  if (filter.levels !== undefined && filter.levels.length > 0 && !filter.levels.includes(record.level)) return false
  if (filter.modules !== undefined && filter.modules.length > 0 && !filter.modules.includes(record.module)) return false
  if (filter.min !== undefined && !shouldStore(record.level, { min: filter.min })) return false
  if (filter.contains !== undefined && filter.contains !== '' && !record.text.includes(filter.contains)) return false
  return true
}

/**
 * 日志目录的解析（**可移植**：只认显式给的东西，绝不碰宿主 `~`）。
 *
 * 优先级：
 *  1. `FORLIFE_LOG_DIR`（显式指定，最高）
 *  2. **`dbPath` 参数**（调用方已知的数据库路径 ⇒ 日志放它旁边）
 *  3. `FORLIFE_DB_PATH` 环境变量（同上，只是从环境来）
 *  4. 进程目录下的 `.forlife/logs`（最后的兜底）
 *
 * ## ★ 为什么要收 `dbPath` 参数（2026-10-10 修的）
 *
 * 第一版只看环境变量。而 `createAdminServer({ dbPath })` 是**按参数**拿路径的
 * （测试就是这么用的），于是环境变量没有 ⇒ 一路掉到兜底 ⇒
 * **测试把日志写进了仓库根目录的 `.forlife/logs/`**，还被 `git add -A` 收进了提交。
 *
 * ⇒ 调用方**已经知道**库在哪，日志就该放它旁边 ——
 *   这也是容器里的正确行为（`/data/dsh/forlife/db/` 旁边的 `logs/`，
 *   与库同卷、一起被备份、一起被清理）。
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env, dbPath?: string | undefined): string {
  const explicit = env['FORLIFE_LOG_DIR']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  const fromDb = (dbPath ?? env['FORLIFE_DB_PATH'] ?? '').trim()
  if (fromDb !== '') {
    const dir = fromDb.replace(/[/\\][^/\\]*$/, '')
    return join(dir === '' ? '.' : dir, 'logs')
  }
  return join(process.cwd(), '.forlife', 'logs')
}

/** 供排障用：这个目录里现在有哪些日志文件、多大（`statSync` 失败就跳过）。 */
export function logStoreStats(dir: string): readonly { readonly name: string; readonly bytes: number }[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX))
      .sort()
      .flatMap((name) => {
        try {
          return [{ name, bytes: statSync(join(dir, name)).size }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
