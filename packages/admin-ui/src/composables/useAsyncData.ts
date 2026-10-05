/**
 * 页面取数的统一写法 —— 所有页面都用它，不要各写各的 loading/error。
 *
 * 为什么值得抽出来：
 *  - `loading` / `error` / `refresh` 三件事每个页面都要，重复写必然写歪；
 *  - **401 要统一处理**：任何接口返回未登录，这里直接切到登录页，
 *    页面代码里一行都不用管；
 *  - 组件卸载后不再写状态（手机上切页很快，晚到的响应写进已卸载组件是常见的内存与 UI 错乱来源）。
 */
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'

import { UnauthorizedError } from '../api/client.ts'
import { useAuth } from './useAuth.ts'

export interface AsyncData<T> {
  readonly data: Ref<T | undefined>
  readonly error: Ref<string | undefined>
  readonly loading: Ref<boolean>
  /** 上一次成功刷新的时间（本地时钟），用于界面显示"数据新鲜度"。 */
  readonly updatedAt: Ref<number | undefined>
  refresh: () => Promise<void>
}

export function useAsyncData<T>(loader: () => Promise<T>): AsyncData<T> {
  const auth = useAuth()
  const data = shallowRef<T>()
  const error = ref<string>()
  const loading = ref(false)
  const updatedAt = ref<number>()

  let alive = true
  let seq = 0

  async function refresh(): Promise<void> {
    const mine = ++seq
    loading.value = true
    try {
      const next = await loader()
      // 只认最后一次请求的结果：连点两次刷新时，先发的晚到也不该覆盖后发的
      if (!alive || mine !== seq) return
      data.value = next
      error.value = undefined
      updatedAt.value = Date.now()
    } catch (caught) {
      if (!alive || mine !== seq) return
      if (caught instanceof UnauthorizedError) {
        auth.markAnonymous()
        return
      }
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      if (alive && mine === seq) loading.value = false
    }
  }

  onScopeDispose(() => {
    alive = false
  })

  void refresh()

  return { data, error, loading, updatedAt, refresh }
}
