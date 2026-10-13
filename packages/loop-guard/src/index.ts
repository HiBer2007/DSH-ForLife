/**
 * `@forlife/loop-guard` —— **独立的模型输出监控**（用户 2026-10-11 裁定抽出来）。
 *
 * ## 它是什么
 *
 * 盯着模型的输出，**陷入死循环就停掉本轮**（`agent.cancel({kind:'hook'})`，
 * 之后由宿主自己开新一轮）。两条腿：
 *
 * | 腿 | 事件 | 抓什么 |
 * |---|---|---|
 * | 文字 | `agent/assistant-stream` | 「Let me do it. / Let me search.」这种**文字打转** |
 * | 工具 | `session/event` 的 `tool/call` | 反复调同一个工具（**不发言的循环**） |
 *
 * ## 两种用法（**一套实现**，不是两份）
 *
 * 1. **独立插件**：把本包加进 profile 的 `dsh.profile.bundles` ⇒
 *    宿主加载本文件（`name` / `inject` / `apply`），不需要任何配置；
 * 2. **被别的插件当库用**：`import { installLoopGuard } from '@forlife/loop-guard'`
 *    （`forlife-memory` 就是这么用的 —— 它传自己的 logger 进来）。
 *
 * ⚠️ **同一个 profile 里不要两处都装**：两边都挂会对同一个宿主挂两遍。
 * 包内有一个按 ctx 的去重（`install.ts` 的 `mountedContexts`），
 * 但宿主给不同插件的 ctx 未必是同一个对象 ⇒ **别赌它**。
 *
 * ## 为什么它值得独立（用户原话的意思）
 *
 * 抽出来之前它住在 `forlife-memory` 里，而那个包**无条件**注册它 ⇒
 * "想要守卫就得背上整套记忆系统（SQLite + 配置 + 数据目录 + **会写记忆**）"。
 * 现在本包**零依赖**（不 import 任何别的包、不写任何库）。
 *
 * @module @forlife/loop-guard
 */
import { installLoopGuard, type LoopGuardInstall, type LoopGuardOptions } from './install.ts'

// ── 库的对外面（给"当库用"的那条路）────────────────────────────────
export { DEFAULT_LOOP_POLICY, LoopGuard, normalizeForLoop, scanForLoop, similarity } from './detector.ts'
export type { LoopPolicy, LoopVerdict } from './detector.ts'
export { createLoopGuardHook } from './hook.ts'
export type { CancelableAgent, LoopGuardHook, LoopGuardHookOptions, StreamFrameLike } from './hook.ts'
export { createToolLoopGuard } from './tool.ts'
export type { ToolLoopGuard, ToolLoopGuardOptions } from './tool.ts'
export { installLoopGuard } from './install.ts'
export type { LoopGuardInstall, LoopGuardOptions } from './install.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'forlife-loop-guard'

/**
 * 需要的服务：**一个都不要**。
 *
 * ★ 这正是这个包存在的意义 —— 它只用宿主的事件钩子，
 * 不 inject 工具/存储/连接，所以在任何宿主里都能装起来。
 */
export const inject: string[] = []

/** 插件配置（**故意没有 schemastery schema**：它没有任何"部署相关"的必填项）。 */
export interface LoopGuardPluginConfig {
  /** 静默模式：只留 `⚠️`（拿不到钩子这类**必须看见**的事）。 */
  readonly quiet?: boolean
}

/**
 * 插件入口（宿主加载点）。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 可选配置（`quiet`）。
 */
export function apply(ctx: unknown, config?: LoopGuardPluginConfig): LoopGuardInstall {
  const quiet = config?.quiet === true
  const log = (message: string): void => {
    if (!quiet) console.log(`[forlife-loop-guard] ${message}`)
  }
  const always = (message: string): void => {
    console.log(`[forlife-loop-guard] ${message}`)
  }

  const disposers: (() => void)[] = []
  const options: LoopGuardOptions = { log, always, disposers }
  const result = installLoopGuard(ctx, options)

  // 用宿主的生命周期收尾（与 `forlife-memory` 同一套写法）
  // —— 反注册器不收好的话，热重载会**重复挂载**（那是最冤的误杀）。
  const context = ctx as {
    effect?: (callback: () => void | (() => void)) => unknown
    on?: (event: string, callback: () => void) => unknown
  }
  const cleanup = (): void => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log(`反注册失败：${String(error)}`)
      }
    }
  }
  if (typeof context.effect === 'function') context.effect(() => cleanup)
  else if (typeof context.on === 'function') context.on('dispose', cleanup)

  return result
}
