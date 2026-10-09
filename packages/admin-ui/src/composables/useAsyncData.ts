/**
 * 页面取数的统一写法 —— 所有页面都用它，不要各写各的 loading/error。
 *
 * 为什么值得抽出来：
 *  - `loading` / `error` / `refresh` 三件事每个页面都要，重复写必然写歪；
 *  - **401 要统一处理**：任何接口返回未登录，这里直接切到登录页，
 *    页面代码里一行都不用管；
 *  - 组件卸载后不再写状态（手机上切页很快，晚到的响应写进已卸载组件是常见的内存与 UI 错乱来源）；
 *  - **定时刷新也在这里**（`pollMs`）：一个页面往往有多个数据源，
 *    定时器写在页面里就一定会漏（总览页原来就是这么漏掉「运行图表」的 `/series` 的）。
 */
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'

import { UnauthorizedError } from '../api/client.ts'
import { Poller } from '../poll-schedule.ts'
import { refreshActivity } from '../refresh-activity.ts'
import { useAuth } from './useAuth.ts'

export interface AsyncData<T> {
  readonly data: Ref<T | undefined>
  readonly error: Ref<string | undefined>
  readonly loading: Ref<boolean>
  /** 上一次成功刷新的时间（本地时钟），用于界面显示"数据新鲜度"。 */
  readonly updatedAt: Ref<number | undefined>
  /** 手动拉一次。返回 `false` = 这次没成功（轮询靠它决定要不要退避）。 */
  refresh: () => Promise<boolean>
}

/** 取数选项。 */
export interface AsyncDataOptions {
  /**
   * 自动刷新间隔（毫秒）；不传 = 只拉一次。
   *
   * 间隔是**每个数据源各自**的：总览的指标卡和按小时聚合的图表不该用同一个节奏。
   */
  readonly pollMs?: number | undefined
  /** 退避上限（默认 `pollMs * 8`）。 */
  readonly pollMaxMs?: number | undefined
}

export function useAsyncData<T>(loader: () => Promise<T>, options: AsyncDataOptions = {}): AsyncData<T> {
  const auth = useAuth()
  const data = shallowRef<T>()
  const error = ref<string>()
  const loading = ref(false)
  const updatedAt = ref<number>()

  let alive = true
  let seq = 0

  // ── 上报给顶栏（`refresh-activity.ts`）────────────────────────────────────
  //
  // 顶栏的「刷新指示器 + 最后刷新时间」读的就是这两个事实（`loading` / 上次成功时间）。
  // **刻意不新开一份状态**：`refreshActivity` 是**只读投影**，这里写进去的是
  // 上面那两个 ref 的同一批值。
  // 卸载时**必须注销**：留着的话顶栏会报一个已经不在屏幕上的数据源的新鲜度，
  // 切页几次还会越攒越多。
  const activityId = refreshActivity.register()
  onScopeDispose(() => {
    refreshActivity.unregister(activityId)
  })

  async function refresh(): Promise<boolean> {
    const mine = ++seq
    loading.value = true
    refreshActivity.setLoading(activityId, true)
    try {
      const next = await loader()
      // 只认最后一次请求的结果：连点两次刷新时，先发的晚到也不该覆盖后发的。
      // 被取代**不算失败**（返回 true）：否则轮询会为了一次自己造成的重入而退避。
      if (!alive || mine !== seq) return true
      data.value = next
      error.value = undefined
      updatedAt.value = Date.now()
      refreshActivity.setSuccess(activityId, updatedAt.value)
      return true
    } catch (caught) {
      if (!alive || mine !== seq) return true
      if (caught instanceof UnauthorizedError) {
        auth.markAnonymous()
        return false
      }
      error.value = caught instanceof Error ? caught.message : String(caught)
      return false
    } finally {
      if (alive && mine === seq) {
        loading.value = false
        refreshActivity.setLoading(activityId, false)
      }
    }
  }

  onScopeDispose(() => {
    alive = false
  })

  void refresh()

  // ── 定时刷新 ────────────────────────────────────────────────────────────
  //
  // 定时器**只写在这一处**：页面各写各的 `setInterval` 一定会漏数据源
  // （总览页原来就在定时器里只刷 `/overview`，图表用的 `/series` 一次都没刷过）。
  if (options.pollMs !== undefined) {
    const poller = new Poller({
      baseMs: options.pollMs,
      ...(options.pollMaxMs === undefined ? {} : { maxMs: options.pollMaxMs }),
      // 不可见时 `pause()` 会连定时器一起清掉；这里再确认一次"真的可见"才发请求
      canPoll: () => document.visibilityState === 'visible',
      // `refresh` 自己把错误显示在页面上，返回的布尔值只用来决定退避
      task: refresh,
    })
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poller.resume()
      else poller.pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    poller.start()
    // 卸载必须收干净：摘监听 + 停定时器（否则切页几次就攒下一堆定时器在打接口）
    onScopeDispose(() => {
      document.removeEventListener('visibilitychange', onVisibility)
      poller.stop()
    })
  }

  return { data, error, loading, updatedAt, refresh }
}
