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
  /** 订阅者（SSE 客户端）。**用 Set** —— 退订是 O(1)，且不会重复。 */
  readonly #subs = new Set<(line: LogLine) => void>()

  constructor(capacity = 500) {
    this.#capacity = Math.max(10, capacity)
  }

  /** 记一行。 */
  push(text: string, at: Date = new Date()): void {
    this.#seq += 1
    this.#lines.push({ seq: this.#seq, at: at.toISOString(), level: guessLevel(text), text })
    if (this.#lines.length > this.#capacity) this.#lines.splice(0, this.#lines.length - this.#capacity)
    // ★ **通知订阅者**（SSE 靠它推送）——
    // **绝不让它影响写日志**：订阅者抛错就吞掉（日志写不进去比丢一条推送严重得多）。
    const line = this.#lines[this.#lines.length - 1]
    if (line !== undefined) {
      for (const sub of this.#subs) {
        try {
          sub(line)
        } catch {
          // 故意吞掉：见上
        }
      }
    }
  }

  /** 取最近若干条（按时间正序返回，便于直接从上往下读）。 */
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

  tail(limit = 200): readonly LogLine[] {
    const count = Math.min(Math.max(1, limit), this.#capacity)
    return this.#lines.slice(-count)
  }

  /** 自某个序号之后的新行（前端增量拉取用）。 */
  since(seq: number, limit = 500): readonly LogLine[] {
    return this.#lines.filter((line) => line.seq > seq).slice(0, limit)
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
}
