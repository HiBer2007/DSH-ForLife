/**
 * 提示词段落注册：把**可编辑的人设/风格**与**记忆区**放进稳定前缀。
 *
 * 位置选择（§2.3 的映射表 + §2.8）：
 *  - `forlife:p1-system` → order **100**（系统提示词，用户可编辑）
 *  - `forlife:p2-style`  → order **110**（回答风格，用户可编辑）
 *  - `forlife:l2-index`  → order **120**（长期记忆手册/索引）
 *  - `forlife:l3-mid`    → order **130**（中期记忆区）
 *  - `forlife:feed-mode` → order **140**（投喂期的工作模式：「半梦半醒 · 前世记忆」）
 *  - `forlife:proactivity` → order **115**（你的主动性：主动发消息 / 提问题 / 唤醒自己）
 *  六段都落在 `DEPLOYMENT_PERSONA_PREFIX(0)` 与 `PLAN_POLICY(500)` 之间的空档，
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

/**
 * 投喂期「工作模式」段的段序（**新增于 2026-10-09**）。
 *
 * | 段 | order | 变化频率 | 变了以后谁失效 |
 * | :--- | :--- | :--- | :--- |
 * | P1 系统提示词 | 100 | 几乎不变（人设） | 它之后的全部 |
 * | P2 回答风格 | 110 | 偶尔改（语气） | 它之后的全部 |
 * | L2 记忆手册 | 120 | 很偶尔（用户改文案） | L3 与之后 |
 * | L3 中期记忆 | 130 | **每次记忆写入/压缩都变** | 只有它自己之后 |
 * | **投喂模式** | **140** | **只在投喂期非空**（空闲时是空串） | 只有它自己之后 |
 *
 * 为什么是 **140**（而不是塞进 L3 那一段里）：
 *  1. **不碰 L3 的缓存契约**：`renderView()` 承诺"同一 `(epoch, revision)` 返回同一份字节"，
 *     把投喂模式并进去就必须改它的缓存键 —— 那是记忆写入的热路径，
 *     为了一个"投喂时才出现"的状态去动它，风险远大于收益；
 *  2. **语义不同**：L3 是"记忆内容"，这一段是"现在处于什么工作模式"；
 *  3. **代价最小**：它排在 L3（130）之后 ⇒ 变化时作废的只有工具段（1000+），
 *     而投喂期 L3 本来每批都在变（`appendMidEntry` 推 revision），没有额外损失。
 *
 * 不用 500+：那落在 `PLAN_POLICY` 之后、缓存断点之后，位置契约的意义就没了。
 */
export const FEED_MODE_ORDER = 140
export const FEED_MODE_NAME = 'forlife:feed-mode'

/**
 * 「主动性」段的段序（**新增于 2026-10-09**）。
 *
 * | 段 | order | 变化频率 | 变了以后谁失效 |
 * | :--- | :--- | :--- | :--- |
 * | P1 系统提示词 | 100 | 几乎不变（人设） | 它之后的全部 |
 * | P2 回答风格 | 110 | 偶尔改（语气） | 它之后的全部 |
 * | **主动性** | **115** | **跟着工具面变**（口径必须与代码一致） | L2 与之后 |
 * | L2 记忆手册 | 120 | 很偶尔（用户改文案） | L3 与之后 |
 * | L3 中期记忆 | 130 | 每次记忆写入/压缩都变 | 只有它自己之后 |
 * | 投喂模式 | 140 | 只在投喂期非空（空闲时是空串） | 只有它自己之后 |
 *
 * 为什么是 **115**（P2 之后、L2 之前）而不是 105：
 *  1. **它比人设/语气更常变**：这一段说的是"有哪些工具、能主动做什么"，
 *     而工具面是这个仓里变得最快的东西 —— 每加/改一个工具，这里的口径就得跟着改。
 *     本文件的排序原则是"最稳的在前"（前缀缓存按字节比对，越靠前的内容变化、作废的后缀越长），
 *     所以它必须排在 P1(100)/P2(110) **之后**；
 *  2. **它比记忆稳**：L2 偶尔改、L3 每次记忆写入都变、投喂段只在投喂期非空 ——
 *     所以它排在它们**之前**。这样它变化时只作废记忆与工具段；
 *     反过来用户改人设/语气时（那是面板上会反复做的事），它仍然留在命中的前缀里；
 *  3. **不能放 500+**：那落在 `PLAN_POLICY` 之后、缓存断点之后，位置契约的意义就没了。
 *
 * 105 也能用（缓存代价的差别只有 P2 那几百字节），但 105 会让"人设 → 能力 → 语气"读起来是断的，
 * 而这一段又比语气更常变 ⇒ 选 **115**。
 */
export const PROACTIVITY_ORDER = 115
export const PROACTIVITY_NAME = 'forlife:proactivity'

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
 * 注册「投喂模式」段（**单独导出是为了能分别反注册**：守卫测试要实测
 * "空闲时注册它不改变提示词的任何一个字节" —— 见 `feed-mode-wiring.test.ts`）。
 *
 * @param systemPrompt - 宿主的 `ctx.systemPrompt`（或测试替身）。
 * @param runtime - 记忆运行时（`feedModeText()` 读投喂会话）。
 * @returns 反注册函数。
 */
export function registerFeedModeSection(systemPrompt: SystemPromptLike, runtime: MemoryRuntime): () => void {
  return systemPrompt.section({
    name: FEED_MODE_NAME,
    order: FEED_MODE_ORDER,
    text: () => runtime.feedModeText(),
    // ⚠️ **必须 false**：这段文案里有 `{{source}}` / `{{chunks}}` 这类**我们自己的**占位符
    // （由 feed-frame 替换），而宿主的插值器对未定义变量是**抛错** ——
    // 那会让整段提示词装不出来（模型就完全没有系统提示词了）。
    interpolate: false,
  })
}

/**
 * 注册「你的主动性」段（**单独导出是为了能分别反注册**，理由与投喂段相同：
 * 守卫测试要能实测"这一段真的进了渲染出来的字节"）。
 *
 * 文本来自基线 `prompt.proactivity`（与 `prompt.p1Default` / `prompt.p2Default` /
 * `feed.dreamFrame` 同一做法：**改口径改 JSON，不用改代码**）。
 *
 * 为什么它必须是**静态文本 + 每轮重算的常量**，而不是像 P1/P2 那样走库：
 * 这一段是"能力说明"，它只在**代码的工具面变化时**才该变 —— 没有"用户随手编辑"的场景。
 * 走库要多一条 `prompt_revisions` 槽位、一套后台接口与一个缓存键，
 * 而收益只是"用另一种方式改同一段文字"。
 *
 * @param systemPrompt - 宿主的 `ctx.systemPrompt`（或测试替身）。
 * @returns 反注册函数。
 */
export function registerProactivitySection(systemPrompt: SystemPromptLike): () => void {
  return systemPrompt.section({
    name: PROACTIVITY_NAME,
    order: PROACTIVITY_ORDER,
    text: () => defaultFor<string>('prompt.proactivity'),
    // ⚠️ **必须 false**：文案里有反引号包着的工具名与中文引号。
    // 宿主的插值器对 `{{...}}` 是"未注册变量即抛错"，一旦有人在文案里写成 `{{某个东西}}`，
    // **整段提示词的装配都会失败**（模型就完全没有系统提示词了）。
    // 这一段不需要任何变量 —— 工具名是字面量，不该被替换。
    interpolate: false,
  })
}

/**
 * 注册 L2 / L3 两个提示段（外加投喂期的「工作模式」段）。
 *
 * @param systemPrompt - 宿主的 `ctx.systemPrompt`（或测试替身）。
 * @param runtime - 记忆运行时。
 * @returns 反注册函数（同时撤销三段；宿主生命周期结束时调用）。
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
  const disposeFeedMode = registerFeedModeSection(systemPrompt, runtime)
  return () => {
    disposeL2()
    disposeL3()
    disposeFeedMode()
  }
}




