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
 * @module @forlife/gateway/admin/log-buffer
 */

/** 一条日志。 */
export interface LogLine {
  /** 序号（单调递增，便于前端判断"有没有新行"）。 */
  readonly seq: number
  readonly at: string
  /** 级别：从文本里推断（我们没有结构化日志，这是务实的做法）。 */
  readonly level: 'info' | 'warn' | 'error'
  readonly text: string
}

/** 从一行文本里猜级别（关键字命中即算）。 */
function guessLevel(text: string): LogLine['level'] {
  if (/\b(error|失败|异常|✖|failed)\b/i.test(text)) return 'error'
  if (/\b(warn|警告|⚠|重试|降级)\b/i.test(text)) return 'warn'
  return 'info'
}

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

  constructor(capacity = 500) {
    this.#capacity = Math.max(10, capacity)
  }

  /** 记一行。 */
  push(text: string, at: Date = new Date()): void {
    this.#seq += 1
    this.#lines.push({ seq: this.#seq, at: at.toISOString(), level: guessLevel(text), text })
    if (this.#lines.length > this.#capacity) this.#lines.splice(0, this.#lines.length - this.#capacity)
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
}
