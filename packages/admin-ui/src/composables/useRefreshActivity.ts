/**
 * 把 `refresh-activity.ts` 的**纯聚合**搬进 Vue 的响应式。
 *
 * ⚠️ 这里**不产生任何新状态**：读到的永远是 `useAsyncData()` 写进登记表的那两个事实
 * （`loading` 与"上次成功时间"）。本文件只负责"变化时让界面重算"与"卸载时收干净"。
 *
 * @module @forlife/admin-ui/composables/useRefreshActivity
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'

import { refreshActivity, type RefreshActivity } from '../refresh-activity.ts'

/** 顶栏要的聚合状态（数据源变化时自动重算）。 */
export function useRefreshActivity(): ComputedRef<RefreshActivity> {
  // 用一个自增版本号把"纯登记表通知"翻译成"Vue 依赖变化"：
  // `activity` 是个普通 getter，本身不可追踪，必须靠这个 ref 建依赖。
  const version = ref(0)
  const unsubscribe = refreshActivity.subscribe(() => {
    version.value += 1
  })
  onScopeDispose(unsubscribe)
  return computed(() => {
    void version.value // 建依赖，别删
    return refreshActivity.activity
  })
}

/**
 * 每 `intervalMs` 走一次的"现在"。
 *
 * 为什么需要它：`12 秒前` 这类文案必须**自己走**，否则"轮询死了"在界面上看不出来。
 *
 * 两条克制：
 *  - 页面不可见时不更新时间（后台标签页没必要每秒叫醒 Vue；浏览器本来也会节流定时器）；
 *  - 卸载时清掉定时器（外壳虽然常驻，但别把"谁开的谁关"这条规矩破掉）。
 *
 * @param intervalMs - 走动间隔（毫秒），默认 1 秒。
 * @returns 当前毫秒时间戳的 ref。
 */
export function useNow(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now())
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') now.value = Date.now()
  }, intervalMs)
  onScopeDispose(() => {
    window.clearInterval(timer)
  })
  return now
}
