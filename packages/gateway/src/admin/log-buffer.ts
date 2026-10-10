/**
 * 日志环形缓冲 —— 给面板的「实时日志」页用。
 *
 * ## 为什么不直接读日志文件
 *
 * 三个理由，每个都实际会绊人：
 *  1. **文件位置不固定**：本地是 `.runtime/admin.log`，容器里是别的路径（甚至只输出到 stdout）。
 *     读文件等于把"部署形态"焊死进代码。
 *  2. **文件会轮转/被删**：读的时候可能正好被截断，拿到半行。
 *  3. **我们真正想要的是"进程现在在想什么"**，不是"磁盘上有什么"——
 *     内存里留最近若干条，语义正好。
 *
 * ## 容量与代价
 *
 * 固定容量（默认 500 条）的环形缓冲：内存占用可预测，永不增长。
 * 超过容量就丢最旧的 —— 排障时最需要的是**最近**发生了什么。
 *
 * ## ★ 2026-10-10 改：级别从"猜"变成"真的"，模块也有了
 *
 * 用户指定了七级 `DEBUG INFO NOTE WARN ERROR FAULT CRASH` 并要求面板能按**等级、模块**筛选。
 * 但 `gateway/src` 里有 **127 处 `log('一句话')`**，它们**没有**级别与模块。
 *
 * ⇒ 两条路并存，而不是"不改完就编译不过"：
 *
 * | 入口 | 级别 | 模块 |
 * | :--- | :--- | :--- |
 * | `pushRecord(record)`（新的 `createLogger` 走这条） | **真的** | **真的** |
 * | `push(text)`（127 处旧调用点） | **猜的** | `'gateway'` |
 *
 * ## ★★ 猜测**绝不猜 `fault` / `crash`**
 *
 * 那两级的定义是「**一个子系统**坏了」与「**整个进程**要没了」——
 * 那是**影响范围**的判断，**正则看不出来**。
 *
 * 猜错的代价不对称：把一条普通的 `error` 猜成 `crash`，会让面板与告警
 * 出现**最高等级的假警报** —— 而假警报会训练人忽略这一级，
 * 于是**真的 crash 也没人看**。所以猜测只覆盖 `info`/`warn`/`error` 三级。
 *
 * @module @forlife/gateway/admin/log-buffer
 */
import { type LogLevel } from './log-levels.ts'
import type { LogRecord } from './log.ts'

/** 一条日志。 */
export interface LogLine {
  /** 序号（单调递增，便于前端判断"有没有新行"）。 */
  readonly seq: number
  readonly at: string
  /**
   * 级别。
   *
   * ⚠️ 旧调用点（`push(text)`）这里是**猜**的，只可能是 `info`/`warn`/`error`
   * —— 见模块头"猜测绝不猜 fault / crash"。
   */
  readonly level: LogLevel
  /** 模块名；旧调用点一律是 `'gateway'`（至少能按"整块"筛掉）。 */
  readonly module: string
  readonly text: string
}

/**
 * 从一行文本里猜级别（关键字命中即算）。
 *
 * ★ **只覆盖 `info`/`warn`/`error`** —— `debug`/`note`/`fault`/`crash` 猜不出来，
 * 也不该猜（见模块头）。特别是后两个：那是**影响范围**的判断。
 */
export function guessLevel(text: string): LogLevel {
  if (/\b(error|失败|异常|✖|failed)\b/i.test(text)) return 'error'
  if (/\b(warn|警告|⚠|重试|降级)\b/i.test(text)) return 'warn'
  return 'info'
}

/** 旧调用点的模块名（它们没有模块信息，但"至少是网关这一块"是真的）。 */
export const LEGACY_LOG_MODULE = 'gateway'

/**
 * 环形缓冲。
 *
 * 刻意**不**做日志脱敏：脱敏属于写入侧的职责（密钥根本不该进日志）。
 * 在展示侧做脱敏会给人"已经安全了"的错觉，而真正的泄露早就发生了。
 */
export class LogBuffer {
  readonly #capacity: number
  readonly #lines: LogLine[] = []
  #seq = 0
  /** 订阅者（SSE 客户端）。**用 Set** —— 退订是 O(1)，且不会重复。 */
  readonly #subs = new Set<(line: LogLine) => void>()

  constructor(capacity = 500) {
    this.#capacity = Math.max(10, capacity)
  }

  /**
   * 记一行（**旧签名**：级别是猜的、模块固定 `gateway`）。
   *
   * 保留它是为了让 127 处能**分批迁移**；新代码请走 {@link pushRecord}。
   */
  push(text: string, at: Date = new Date()): void {
    this.#accept(at.toISOString(), guessLevel(text), LEGACY_LOG_MODULE, text)
  }

  /**
   * 记一条**结构化**记录（`createLogger` 走这条）—— 级别与模块都是**真的**。
   *
   * @returns 落进缓冲的那一行（调用方可以直接推给 SSE，省一次查找）。
   */
  pushRecord(record: LogRecord): LogLine | undefined {
    return this.#accept(record.at, record.level, record.module, record.text)
  }

  /** 一条记录进缓冲的**唯一**路径（序号、容量、通知都只在这里做一次）。 */
  #accept(at: string, level: LogLevel, module: string, text: string): LogLine | undefined {
    this.#seq += 1
    const line: LogLine = { seq: this.#seq, at, level, module, text }
    this.#lines.push(line)
    if (this.#lines.length > this.#capacity) this.#lines.splice(0, this.#lines.length - this.#capacity)
    // ★ **通知订阅者**（SSE 靠它推送）——
    // **绝不让它影响写日志**：订阅者抛错就吞掉（日志写不进去比丢一条推送严重得多）。
    for (const sub of this.#subs) {
      try {
        sub(line)
      } catch {
        // 故意吞掉：见上
      }
    }
    return line
  }

  /**
   * 清空缓冲。
   *
   * **序号继续递增**（不归零）：前端靠 `since(seq)` 增量拉取，
   * 序号归零会让它以为"所有日志都是新的"，于是把旧内容又拉一遍 ——
   * 表现为"清空之后日志反而变多了"。
   *
   * @returns 清掉的条数（审计要用）。
   */
  clear(): number {
    const removed = this.#lines.length
    this.#lines.length = 0
    return removed
  }

  /** 取最近若干条（按时间正序返回，便于直接从上往下读）。 */
  tail(limit = 200): readonly LogLine[] {
    const count = Math.min(Math.max(1, limit), this.#capacity)
    return this.#lines.slice(-count)
  }

  /** 自某个序号之后的新行（前端增量拉取用）。 */
  since(seq: number, limit = 500): readonly LogLine[] {
    return this.#lines.filter((line) => line.seq > seq).slice(0, limit)
  }

  /**
   * 按**等级 / 模块**筛选（用户 2026-10-10：「在管理面板的日志区能筛选**等级、模块**等」）。
   *
   * 内存这一侧只做筛选，**不做分页** —— 缓冲本来就小（默认 500 条）。
   * 要翻更久远的，走 `log-store.ts` 的落盘那份。
   */
  query(filter: {
    readonly levels?: readonly LogLevel[]
    readonly modules?: readonly string[]
    readonly contains?: string
    readonly limit?: number
  } = {}): readonly LogLine[] {
    const wanted = filter.levels ?? []
    const modules = filter.modules ?? []
    const out = this.#lines.filter((line) => {
      if (wanted.length > 0 && !wanted.includes(line.level)) return false
      if (modules.length > 0 && !modules.includes(line.module)) return false
      if (filter.contains !== undefined && filter.contains !== '' && !line.text.includes(filter.contains)) return false
      return true
    })
    const limit = filter.limit ?? 500
    // 与落盘那份同一条口径：**从最新往回取**（面板要看"最近发生了什么"）
    return out.slice(-Math.max(1, limit))
  }

  /**
   * 订阅新行（SSE 用）。**返回退订函数**。
   *
   * ★ **必须退订** —— 不退的话 `push()` 每次都遍历一堆死订阅者
   * （**内存与 CPU 双漏**）。
   *
   * **不做缓冲** —— 缓冲的责任在调用方（SSE 那边有有界队列），
   * 因为"多大的缓冲合适"取决于那个连接，而不是日志缓冲该管的事。
   */
  subscribe(listener: (line: LogLine) => void): () => void {
    this.#subs.add(listener)
    return (): void => {
      this.#subs.delete(listener)
    }
  }

  /** 当前订阅者数（排障用：**连接漏了会在这里显形**）。 */
  get subscriberCount(): number {
    return this.#subs.size
  }

  /** 当前序号（前端记住它，下次只要新的）。 */
  get sequence(): number {
    return this.#seq
  }

  /** 总行数（用于显示"缓冲里有多少"）。 */
  get size(): number {
    return this.#lines.length
  }

  get capacity(): number {
    return this.#capacity
  }

  /** 缓冲里出现过的模块（面板的模块筛选下拉用它，免得手打拼错）。 */
  modules(): readonly string[] {
    return [...new Set(this.#lines.map((line) => line.module))].sort()
  }
}
