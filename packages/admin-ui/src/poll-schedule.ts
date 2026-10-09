/**
 * 轮询节奏的**纯策略**（除了一个可替换的定时器接缝，不碰浏览器 API，所以能被完整测试）。
 *
 * ## 为什么把这段逻辑从页面里抽出来
 *
 * 「定时刷新」以前是**手写在总览页里的**（`OverviewView.vue` 的 `setInterval` +
 * `visibilitychange`）。手写的结果是：
 *  - 定时器里**只刷了 `/overview`**，而页面上的「运行图表」来自另一个接口 `/series`——
 *    它从打开页面起再也没刷过（页面上最大的一块就此变成一张静止的照片）；
 *  - 清理、可见性、失败退避全靠页面作者自觉，页数一多必然写歪。
 *
 * ⇒ 把"什么时候该再拉一次"收敛成一个**可测的状态机**；页面只负责说
 * `useAsyncData(loader, { pollMs })`。加数据源就不可能再漏掉刷新。
 *
 * ## 三条必须成立的规矩（每条都对应一个真实的坏结果）
 *
 * 1. **不可见就别拉**（`pause()`）—— 手机后台标签页对着接口一直打，费电又费流量；
 * 2. **失败要退避**（base → 2×base → … 封顶）—— 后端已经倒下时，固定间隔轮询
 *    就是**持续对着倒下的后端输出**；恢复后必须**立刻回到正常间隔**，否则会一直慢下去；
 * 3. **`stop()` 之后一个请求都不许再发**（连"在飞的那次回来再排一次"也不行）——
 *    组件卸载后还留定时器是前端最常见的泄漏之一。
 *
 * @module @forlife/admin-ui/poll-schedule
 */

/** 定时器接缝：测试里换成假时钟，就能精确验证"隔多久发一次"。 */
export interface PollClock {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
}

/** 真定时器（浏览器 / 宿主都有的那一套）。 */
const REAL_CLOCK: PollClock = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id)
  },
}

/** 退避倍率的指数上限：`baseMs * 2**16` 早已超过任何有意义的 `maxMs`，这里只是防溢出。 */
const MAX_BACKOFF_EXPONENT = 16

export interface PollerOptions {
  /** 正常间隔（毫秒）。 */
  readonly baseMs: number
  /** 退避上限（毫秒）；默认 `baseMs * 8`（失败时最多慢到 8 倍）。 */
  readonly maxMs?: number
  /** 真去拉一次：`true` = 成功，`false` = 失败（走退避）。 */
  readonly task: () => Promise<boolean>
  /**
   * 现在能不能发请求（默认恒真）。
   *
   * 页面不可见时**不该**发请求 —— 调用方通常会 `pause()`，
   * 这里再留一道闸：调用方忘了接 `visibilitychange` 也不会把接口打爆。
   */
  readonly canPoll?: () => boolean
  /** 定时器接缝（测试传假时钟）。 */
  readonly clock?: PollClock
  /** 每跑完一次通知一下（可以显示"失败 N 次，已退避到 X 秒"）。 */
  readonly onRun?: (result: { readonly ok: boolean; readonly delayMs: number }) => void
}

/**
 * 定时拉取。
 *
 * 用法：`start()` 排程（**不立即拉** —— 首次取数由 `useAsyncData` 自己负责，
 * 否则开局会对同一个接口打两次）；`pause()` / `resume()` 接可见性；`stop()` 卸载。
 */
export class Poller {
  readonly #baseMs: number
  readonly #maxMs: number
  readonly #task: () => Promise<boolean>
  readonly #canPoll: () => boolean
  readonly #clock: PollClock
  readonly #onRun: ((result: { readonly ok: boolean; readonly delayMs: number }) => void) | undefined

  #failures = 0
  #timer: number | undefined
  /** 上一次还没回来（慢接口 + 短间隔时，**不叠着发**）。 */
  #inFlight = false
  #paused = false
  #stopped = false

  constructor(options: PollerOptions) {
    this.#baseMs = Math.max(1, Math.floor(options.baseMs))
    this.#maxMs = Math.max(this.#baseMs, Math.floor(options.maxMs ?? this.#baseMs * 8))
    this.#task = options.task
    this.#canPoll = options.canPoll ?? ((): boolean => true)
    this.#clock = options.clock ?? REAL_CLOCK
    this.#onRun = options.onRun
  }

  /** 连续失败次数（成功归零）。 */
  get failures(): number {
    return this.#failures
  }

  /** 下一次要等多久（按连续失败次数退避，封顶 `maxMs`）。 */
  get delayMs(): number {
    return Math.min(this.#baseMs * 2 ** Math.min(this.#failures, MAX_BACKOFF_EXPONENT), this.#maxMs)
  }

  /** 还在排程吗（`false` = 已停或已暂停）。 */
  get running(): boolean {
    return !this.#stopped && !this.#paused
  }

  /** 开始排程。**幂等**（重复调用不会排出两个定时器）。 */
  start(): void {
    if (this.#stopped) return
    this.#paused = false
    this.#schedule()
  }

  /** 页面不可见：**连定时器一起清掉**（不是留着空转再判断）。 */
  pause(): void {
    this.#paused = true
    this.#clear()
  }

  /** 页面又可见了：**立刻补一次**（等一整个间隔的话，用户看到的是旧数字）。 */
  resume(): void {
    if (this.#stopped) return
    this.#paused = false
    void this.#run()
  }

  /** 卸载：彻底停（幂等）。停了之后连在飞的那次回来也不会再排程。 */
  stop(): void {
    this.#stopped = true
    this.#clear()
  }

  #clear(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #schedule(): void {
    this.#clear()
    if (this.#stopped || this.#paused) return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.#run()
    }, this.delayMs)
  }

  async #run(): Promise<void> {
    if (this.#stopped || this.#paused) return
    // 上一次还没回来：不叠着发 —— 它回来时自然会重排下一次
    if (this.#inFlight) return
    if (!this.#canPoll()) {
      // 不可见时"跳过这一拍"，但**必须留下一次** ——
      // 直接不排的话，回到前台就再也不会刷了（静默死掉比不刷更难查）。
      this.#schedule()
      return
    }

    this.#inFlight = true
    let ok = false
    try {
      ok = await this.#task()
    } catch {
      // 取数层通常自己吞异常（错误显示在页面上）；这里兜底：抛出来一律算失败
      ok = false
    } finally {
      this.#inFlight = false
    }

    if (ok) this.#failures = 0
    else this.#failures += 1
    this.#onRun?.({ ok, delayMs: this.delayMs })
    this.#schedule()
  }
}
