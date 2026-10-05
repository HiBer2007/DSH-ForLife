/**
 * 提示词段落注册：把记忆区放进**稳定前缀**。
 *
 * 位置选择（§2.3 的映射表）：
 *  - `forlife:l2-index` → order **100**（长期记忆手册/索引）
 *  - `forlife:l3-mid`   → order **110**（中期记忆区）
 *  两者都落在 `DEPLOYMENT_PERSONA_PREFIX(0)` 与 `PLAN_POLICY(500)` 之间的空档，
 *  即**在所有工具段（1000–3100）之前**，并且都在缓存断点之前。
 *
 * 关键实现细节：`text` 传的是**函数**，宿主每次装配都会重新求值 ——
 * 而我们的 `runtime.renderView()` 在同一 `(epoch, revision)` 下返回同一份字节，
 * 所以"没有写操作时前缀逐字节稳定"这条由**缓存**而不是由"不注册"来保证。
 *
 * @module forlife-memory/prompt
 */
import type { MemoryRuntime } from './runtime.ts'

/** 段落顺序常量（可被测试引用，避免魔法数字散落）。 */
export const L2_ORDER = 100
export const L3_ORDER = 110
export const L2_NAME = 'forlife:l2-index'
export const L3_NAME = 'forlife:l3-mid'

/** 宿主 SystemPrompt 服务的最小结构（只依赖我们真正用到的部分）。 */
export interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: unknown) => string)
    readonly interpolate?: boolean
  }): () => void
}

/**
 * 注册 L2 / L3 两个提示段。
 *
 * @param systemPrompt - 宿主的 `ctx.systemPrompt`（或测试替身）。
 * @param runtime - 记忆运行时。
 * @returns 反注册函数（同时撤销两段；宿主生命周期结束时调用）。
 */
export function registerMemorySections(systemPrompt: SystemPromptLike, runtime: MemoryRuntime): () => void {
  const disposeL2 = systemPrompt.section({
    name: L2_NAME,
    order: L2_ORDER,
    text: () => runtime.l2Text(),
    // L2 文本里可能含 `{{...}}` 之类的字面量，不做变量插值，避免被宿主替换掉
    interpolate: false,
  })
  const disposeL3 = systemPrompt.section({
    name: L3_NAME,
    order: L3_ORDER,
    text: () => runtime.renderView().text,
    interpolate: false,
  })
  return () => {
    disposeL2()
    disposeL3()
  }
}
