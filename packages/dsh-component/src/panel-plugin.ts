/**
 * 面板接口插件的**独立入口**（只有 web profile 会挂它）。
 *
 * ## 为什么要独立成一个插件行
 *
 * `connection` 服务**只由 `dsh-web-app` 提供**（实测：base / headless 的 profile 里
 * 一行都没有）。于是三种做法里只有第三种成立：
 *
 * | 做法 | 结果 |
 * | :--- | :--- |
 * | 主插件裸访问 `ctx.connection` | ❌ cordis 报 `cannot get property "connection" without inject` |
 * | 主插件 `inject: ['connection']` | ❌ 整个插件在没有该服务的宿主里**永不 apply**，连记忆本体都丢 |
 * | **独立插件行 + `inject: ['connection']`** | ✅ 主插件保持可移植；web profile 多挂一行即可 |
 * | `ctx.inject(['connection'], cb)` 运行时回调 | ❌ 实测在这个控制器里**静默不触发**（回调既不执行也不报错） |
 *
 * 最后一条是花了最久才定位的：日志里既没有成功也没有失败，接口 404 而毫无线索。
 * 结论就是"别依赖运行时注入回调，用显式的插件行"。
 *
 * @module forlife-memory/panel
 */
import { registerPanelRoutes, type FetchRegistryLike } from './api.ts'
import { whenRuntimeReady } from './index.ts'

/** Cordis 插件名。 */
export const name = 'forlife-memory-panel'

/** 依赖：Connection 服务（`dsh-web-app` 提供，因此本行只该出现在 web profile 里）。 */
export const inject = ['connection']

/**
 * 插件入口。
 *
 * @param ctx - 宿主上下文（此时 `ctx.connection` 已可合法访问）。
 */
export function apply(ctx: { readonly connection?: { readonly fetch?: FetchRegistryLike } }): void {
  const registry = ctx.connection?.fetch
  if (registry === undefined) {
    console.warn('[forlife] connection 服务已就绪但没有 fetch 注册表：面板接口未注册')
    return
  }
  // 主插件与面板插件谁先 apply 由服务依赖决定，顺序不保证 ⇒ 等运行时就绪再注册
  let disposeRoutes: (() => Promise<void>) | undefined
  const disposeWait = whenRuntimeReady((runtime) => {
    disposeRoutes = registerPanelRoutes(registry, runtime)
    console.log('[forlife] 已注册面板接口 /api/forlife/{state,entries,compaction,spills,health}')
  })
  // 反注册（宿主卸载本行时）
  return void disposeWait
}
