/**
 * 提示词段落注册：把**可编辑的人设/风格**与**记忆区**放进稳定前缀。
 *
 * 位置选择（§2.3 的映射表 + §2.8）：
 *  - `forlife:p1-system` → order **100**（系统提示词，用户可编辑）
 *  - `forlife:p2-style`  → order **110**（回答风格，用户可编辑）
 *  - `forlife:l2-index`  → order **120**（长期记忆手册/索引）
 *  - `forlife:l3-mid`    → order **130**（中期记忆区）
 *  四段都落在 `DEPLOYMENT_PERSONA_PREFIX(0)` 与 `PLAN_POLICY(500)` 之间的空档，
 *  即**在所有工具段（1000–3100）之前**，并且都在缓存断点之前。
 *
 * 关键实现细节：`text` 传的是**函数**，宿主每次装配都会重新求值 ——
 * 这带来两个好处：① 后台改提示词**下一轮就生效**（不用重启）；
 * ② 而我们的 `runtime.renderView()` 在同一 `(epoch, revision)` 下返回同一份字节，
 * 所以"没有写操作时前缀逐字节稳定"这条由**缓存**而不是由"不注册"来保证。
 *
 * @module forlife-memory/prompt
 */
import { defaultFor } from '@forlife/contracts'
import { PROMPT_VARIABLES } from '@forlife/memory-core'

import type { MemoryRuntime } from './runtime.ts'

/** persona_name → personaName（基线键是驼峰）。 */
function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase())
}

/** 段落顺序常量（可被测试引用，避免魔法数字散落）。 */
/** P1 系统提示词的段名。 */
export const P1_NAME = 'forlife:p1-system'
/** P1 段序。 */
export const P1_ORDER = 100
/** P2 回答风格的段名。 */
export const P2_NAME = 'forlife:p2-style'
/** P2 段序。 */
export const P2_ORDER = 110

/**
 * 段序（**稳定内容在前**，这是缓存命中的关键）。
 *
 * | 段 | order | 变化频率 | 变了以后谁失效 |
 * | :--- | :--- | :--- | :--- |
 * | P1 系统提示词 | 100 | 几乎不变（人设） | 它之后的全部 |
 * | P2 回答风格 | 110 | 偶尔改（语气） | 它之后的全部 |
 * | L2 记忆手册 | 120 | 很偶尔（用户改文案） | L3 与之后 |
 * | L3 中期记忆 | 130 | **每次记忆写入/压缩都变** | 只有它自己之后 |
 *
 * 把最稳的放最前面不是审美：前缀缓存按字节比对，
 * 越靠前的内容变化，作废的后缀就越长。记忆是这里变得最勤的，所以它排最后。
 *
 * 阶段 1 时 L2/L3 曾在 100/110；阶段 4 把 100/110 让给 P1/P2（EXECUTION_PLAN §2.8 指定），
 * 换来的是"记忆写入不再作废人设前缀"。
 */
export const L2_ORDER = 120
export const L3_ORDER = 130
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
  /**
   * 注册一个 `{{variable}}` 的取值提供者。
   *
   * 宿主的 `renderPrompt` 对**未定义变量会抛错**（比静默留空安全），
   * 所以可编辑提示词里用到的每个变量都必须在这里注册，
   * 否则整段装配会失败。白名单校验（保存前）与这里的注册是同一份清单的两端。
   */
  variable?(name: string, provider: (context: unknown) => string | undefined): () => void
}

/**
 * 注册 P1/P2 两个**可编辑**段 + 变量取值提供者。
 *
 * 热生效靠函数型 section：宿主每次装配都重算 `text`，
 * 所以后台保存后**下一轮就生效**，不需要重启（§2.8 核实的宿主事实）。
 *
 * @param systemPrompt - 宿主的 `ctx.systemPrompt`（或测试替身）。
 * @param runtime - 记忆运行时（提供提示词文本）。
 * @param variables - 稳定变量的取值（`{{persona_name}}` 这类）。
 * @returns 反注册函数。
 */
export function registerPromptSections(
  systemPrompt: SystemPromptLike,
  runtime: MemoryRuntime,
  variables: Readonly<Record<string, string>>,
): () => void {
  const disposers: (() => void)[] = []

  // 变量取值提供者：宿主装配时按需调用。
  //
  // **注册白名单里的全部稳定变量**，而不只是配置里给了值的那些：
  // 宿主的 `renderPrompt` 对未定义变量**抛错**，一旦抛错模型就**完全没有系统提示词**了。
  // 用户少配一个变量（或换了份配置文件）不该造成这种后果 ——
  // 缺值就用基线里的默认值补上，装配永远能成功。
  if (systemPrompt.variable !== undefined) {
    for (const spec of PROMPT_VARIABLES) {
      if (spec.dynamic) continue // 动态变量不进前缀，也就不在这里注册
      const value = variables[spec.name] ?? defaultFor<string>(`prompt.variables.${camel(spec.name)}`)
      disposers.push(systemPrompt.variable(spec.name, () => value))
    }
  }

  disposers.push(
    systemPrompt.section({
      name: P1_NAME,
      order: P1_ORDER,
      text: () => runtime.promptText('p1-system'),
      // **必须插值**：可编辑提示词里的 {{persona_name}} 要靠宿主替换
      interpolate: true,
    }),
  )
  disposers.push(
    systemPrompt.section({
      name: P2_NAME,
      order: P2_ORDER,
      text: () => runtime.promptText('p2-style'),
      interpolate: true,
    }),
  )

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
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




