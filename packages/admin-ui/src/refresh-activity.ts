/**
 * 「刷新活动」的**只读投影** —— 顶部菜单栏那颗指示器与"最后刷新时间"的数据源。
 *
 * ## 为什么要有它，以及它**不是**第二套状态
 *
 * "正在刷新"与"上次刷新成功于何时"这两件事**已经存在了**：
 * `useAsyncData()` 每个数据源都持有 `loading` 与 `updatedAt`（`AsyncData` 接口）。
 * 问题是它们散在**每个页面**手里，外壳（`App.vue` 的顶栏）看不见。
 *
 * 所以这里只做一件事：给 `useAsyncData` 一个**汇** —— 数据源 setup 时 `register()`、
 * 卸载时 `unregister()`、每次状态变化时 `setLoading()` / `setSuccess()`，
 * 然后把这些条目**聚合**成一个数。
 *
 * ⚠️ **它自己不轮询、不问接口、不持有任何时间戳**：`loading` 与"上次成功时间"
 * 永远只有 `useAsyncData` 一个真源，这里存的是它的**投影**。
 * 谁要是绕过 `useAsyncData` 直接往这里写，那就是在造第二套状态 —— 别这么干
 * （本仓在"面板数字与生效值不一致"上已经吃过一次亏）。
 *
 * ## 为什么刻意不 import vue
 *
 * `poll-schedule.ts` 定下的规矩：节奏与聚合这类**策略**要是纯的，才能在 `node:test`
 * 里直接跑（`refresh-activity.test.ts` 就是证据）。Vue 的绑定放在
 * `composables/useRefreshActivity.ts` 里，本文件一行 Vue 都不碰。
 *
 * @module @forlife/admin-ui/refresh-activity
 */

/** 一个数据源对外的两个事实（**形状刻意与 `AsyncData` 对齐**）。 */
export interface RefreshSourceState {
  readonly loading: boolean
  readonly updatedAt: number | undefined
}

/** 聚合结果（顶栏要的全部信息）。 */
export interface RefreshActivity {
  /** 当前有没有数据源正在刷新。 */
  readonly refreshing: boolean
  /**
   * **最近一次**成功刷新的时刻（毫秒时间戳）；一个都没成功过时为 `undefined`。
   *
   * 聚合口径是 **max**（最新的那块数据有多新），不是 min：
   * 页面上有 `/overview`(15s) 与 `/series`(60s) 两块时，用户想知道的是
   * "这页上的数字有多新" —— min 会让整页看起来一直很旧，
   * 而"这一页彻底不刷新了"（时间冻住不动）仍然是看得出来的。
   */
  readonly lastSuccessAt: number | undefined
  /** 当前登记着的数据源个数（0 = 这一页没有自动刷新的数据源）。 */
  readonly sources: number
}

/** 登记表：页面上还活着的那些轮询数据源。 */
export class RefreshRegistry {
  readonly #states = new Map<number, { loading: boolean; updatedAt: number | undefined }>()
  readonly #listeners = new Set<() => void>()
  #nextId = 1

  /**
   * 登记一个数据源。
   *
   * **必须**在数据源卸载时 `unregister(id)`（`useAsyncData` 用 `onScopeDispose` 做）——
   * 页面卸载后还留在表里的话，顶栏会报一个**已经不在屏幕上的**数据源的新鲜度，
   * 而且切页几次就会越攒越多。
   *
   * @returns 这个数据源的 id（注销与更新都用它）。
   */
  register(): number {
    const id = this.#nextId
    this.#nextId += 1
    this.#states.set(id, { loading: false, updatedAt: undefined })
    this.#notify()
    return id
  }

  /** 注销（幂等）：数据源卸载时调用。 */
  unregister(id: number): void {
    if (this.#states.delete(id)) this.#notify()
  }

  /** 正在刷新 / 刷新结束。**值没变就不通知**（每秒一次的空转不该惊动界面）。 */
  setLoading(id: number, loading: boolean): void {
    const state = this.#states.get(id)
    if (state === undefined || state.loading === loading) return
    state.loading = loading
    this.#notify()
  }

  /** 刷新成功，记下时刻。 */
  setSuccess(id: number, at: number): void {
    const state = this.#states.get(id)
    if (state === undefined) return
    state.updatedAt = at
    this.#notify()
  }

  /** 某个数据源当前的状态（测试用；界面请用 `activity`）。 */
  stateOf(id: number): RefreshSourceState | undefined {
    return this.#states.get(id)
  }

  /** 聚合。 */
  get activity(): RefreshActivity {
    let refreshing = false
    let lastSuccessAt: number | undefined
    for (const state of this.#states.values()) {
      if (state.loading) refreshing = true
      if (state.updatedAt !== undefined && (lastSuccessAt === undefined || state.updatedAt > lastSuccessAt)) {
        lastSuccessAt = state.updatedAt
      }
    }
    return { refreshing, lastSuccessAt, sources: this.#states.size }
  }

  /**
   * 订阅变化（`App.vue` 用它把纯聚合搬进 Vue 的响应式）。
   *
   * @param listener - 任何状态变化都会叫它一次。
   * @returns 取消订阅（**必须**在组件卸载时调用，否则监听器会越攒越多）。
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    // 复制一份再遍历：监听器里可能又触发变化（例如 computed 里的连锁），别边遍历边改集合
    for (const listener of [...this.#listeners]) listener()
  }
}

/** 全应用共用一个（单页应用，一份就够 —— 换页时由 `unregister` 自然收敛）。 */
export const refreshActivity = new RefreshRegistry()

/**
 * "上次刷新于何时"的文案。
 *
 * ## 三条约束（都对应一个真实的难看结果）
 *  - **必须能自己走**（`刚刚` → `12 秒前` → `13:45:02`）：时间冻住的话，
 *    "轮询死了"这个故障在界面上就看不出来了；
 *  - **必须够短**：顶栏只有 56px 高，旁边还有标题；
 *  - **不许留下"NaN"/"undefined"**：界面上出现这两个词最伤信任（本仓 `format.ts` 的同一条规矩）。
 *
 * 超过 1 小时改用**绝对时刻**（`13:45:02`）：`87 分钟前` 这种读起来没有意义，
 * 而且绝对时刻是定宽的 —— 不会把顶栏推来推去。
 *
 * @param at - 上次成功的毫秒时间戳；`undefined` = 还没成功过。
 * @param now - 当前毫秒时间戳（由调用方每秒喂一次，所以这个函数是纯的、可测的）。
 * @returns 文案。
 */
export function formatRefreshAge(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at)) return '—'
  const diff = now - at
  // 时钟回拨 / 服务端时间略微超前：说"刚刚"，别说"-3 秒前"
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${String(Math.floor(diff / 1000))} 秒前`
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))} 分钟前`
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
