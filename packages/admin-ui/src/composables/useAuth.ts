/**
 * 会话与登录态。
 *
 * 设计要点：
 *  - 令牌只存在于 **HttpOnly cookie** 里，前端拿不到也不该拿；前端只问"我是谁"；
 *  - `state` 三态：`unknown`（还没问）/ `anonymous`（未登录）/ `authenticated`；
 *    "还没问"必须与"未登录"分开，否则首屏会闪一下登录页；
 *  - 任何接口抛 `UnauthorizedError` 时，调用 `markAnonymous()` 即可让外壳切到登录页 ——
 *    不需要每个页面各自处理。
 */
import { computed, ref, type ComputedRef } from 'vue'

import { api, UnauthorizedError } from '../api/client.ts'

export interface AdminIdentity {
  readonly authenticated: boolean
  /** 会话有效期（ISO），未登录时为空。 */
  readonly expiresAt?: string
  /** 是否需要首次设置口令（服务端没有口令哈希时）。 */
  readonly needsSetup?: boolean
}

type SessionState = 'unknown' | 'anonymous' | 'authenticated'

const state = ref<SessionState>('unknown')
const identity = ref<AdminIdentity>({ authenticated: false })

/** 只查一次"我是谁"，多个组件并发调用时共用一个请求。 */
let inflight: Promise<void> | undefined

async function refresh(): Promise<void> {
  if (inflight !== undefined) return inflight
  inflight = (async () => {
    try {
      const me = await api.get<AdminIdentity>('/session')
      identity.value = me
      state.value = me.authenticated ? 'authenticated' : 'anonymous'
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        identity.value = { authenticated: false }
        state.value = 'anonymous'
        return
      }
      // 网络/服务异常：当成未登录，但把错误留给调用方页面去显示
      identity.value = { authenticated: false }
      state.value = 'anonymous'
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

export function useAuth(): {
  readonly state: ComputedRef<SessionState>
  readonly identity: ComputedRef<AdminIdentity>
  readonly isAuthenticated: ComputedRef<boolean>
  readonly needsSetup: ComputedRef<boolean>
  refresh: () => Promise<void>
  login: (password: string) => Promise<void>
  setup: (password: string) => Promise<void>
  logout: () => Promise<void>
  markAnonymous: () => void
} {
  return {
    state: computed(() => state.value),
    identity: computed(() => identity.value),
    isAuthenticated: computed(() => state.value === 'authenticated'),
    needsSetup: computed(() => identity.value.needsSetup === true),
    refresh,
    async login(password) {
      await api.post<AdminIdentity>('/login', { password })
      await refresh()
    },
    async setup(password) {
      await api.post<AdminIdentity>('/setup', { password })
      await refresh()
    },
    async logout() {
      try {
        await api.post('/logout')
      } finally {
        identity.value = { authenticated: false }
        state.value = 'anonymous'
      }
    },
    markAnonymous() {
      identity.value = { authenticated: false }
      state.value = 'anonymous'
    },
  }
}
