/**
 * 日志流：**SSE 优先，失败回退轮询**。
 *
 * ## 为什么必须有回退（这是这一层存在的理由）
 *
 * SSE 比轮询好（延迟低、不空转），但**它比轮询脆弱**：
 * - 中间的反代可能不支持流式（或被配成缓冲）；
 * - 某些企业代理会掐长连接；
 * - 服务重启、网络抖动。
 *
 * **如果 SSE 挂了而面板没有回退，结果不是"慢一点"，而是"日志完全不更新"** ——
 * 用户会以为**系统没日志**，而真相是**面板瞎了**。
 *
 * ⇒ **回退不是可选项。** 宁可慢一点（轮询），也不能瞎。
 *
 * ## ★ 一条纪律：**回退之后要能回到 SSE**
 *
 * 只在"第一次失败"时降级、**永不重试**的话，一次瞬时抖动就把这个标签页
 * **永久锁在轮询上**（而用户完全不知道）。
 * ⇒ 降级后**定期试着重连 SSE**（退避：越试越慢，避免风暴）。
 *
 * ## ★ 另一条：**状态要能看见**
 *
 * "当前在用 SSE 还是轮询"**必须能从界面上看出来** ——
 * 否则排障时没人知道"日志慢"是因为**回退到轮询了**。
 *
 * @module @forlife/admin-ui/log-stream
 */

/** 当前传输方式。 */
export type LogTransport = 'sse' | 'poll'

/** 一次连接尝试的结果。 */
export interface StreamAttempt {
  readonly ok: boolean
  /** 失败原因（**要能显示给人看** —— 不然没人知道为什么降级了）。 */
  readonly reason?: string
}

/** 回退状态机（**纯逻辑，不碰浏览器 API** —— 这样它能被完整测试）。 */
export class LogStreamFallback {
  readonly #retryBaseMs: number
  readonly #retryMaxMs: number
  #transport: LogTransport = 'sse'
  #failures = 0
  /** 距离下次可以重试 SSE 还要等多久（毫秒）；0 = 现在就可以试。 */
  #cooldownMs = 0
  #lastReason: string | null = null

  constructor(options: { retryBaseMs?: number; retryMaxMs?: number } = {}) {
    this.#retryBaseMs = options.retryBaseMs ?? 5_000
    this.#retryMaxMs = options.retryMaxMs ?? 120_000
  }

  get transport(): LogTransport {
    return this.#transport
  }

  /** 上次降级的原因（**要显示出来**）。 */
  get lastReason(): string | null {
    return this.#lastReason
  }

  get failures(): number {
    return this.#failures
  }

  get cooldownMs(): number {
    return this.#cooldownMs
  }

  /** 一次 SSE 尝试的结果。 */
  report(attempt: StreamAttempt): void {
    if (attempt.ok) {
      this.#transport = 'sse'
      this.#failures = 0
      this.#cooldownMs = 0
      this.#lastReason = null
      return
    }
    this.#failures += 1
    this.#lastReason = attempt.reason ?? '未知原因'
    // **降级到轮询** —— 但**不是永久**：退避后还会再试 SSE
    this.#transport = 'poll'
    // 退避：5s / 10s / 20s / … 上限 120s（**避免"一直失败一直重连"的风暴**）
    this.#cooldownMs = Math.min(this.#retryBaseMs * 2 ** (this.#failures - 1), this.#retryMaxMs)
  }

  /** 经过 `elapsedMs` 之后，现在能不能试 SSE 了？ */
  tick(elapsedMs: number): boolean {
    if (this.#cooldownMs <= 0) return this.#transport === 'sse'
    this.#cooldownMs = Math.max(0, this.#cooldownMs - elapsedMs)
    return this.#cooldownMs === 0
  }

  /** 给人看的一行说明。 */
  describe(): string {
    if (this.#transport === 'sse') return '实时推送（SSE）'
    const secs = Math.ceil(this.#cooldownMs / 1000)
    return `**已回退到轮询**（${this.#lastReason ?? '未知原因'}）—— ${String(secs)} 秒后重试实时推送`
  }
}
