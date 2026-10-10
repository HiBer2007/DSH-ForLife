/**
 * **投喂期的工具收窄**（用户 2026-10-10 指定）。
 *
 * ## 用户的原话
 *
 * > 「应该我们主动限制工具调用，**只开放有关于记忆和文件读写的工具**，
 * >   其他的比如 **QQ、沙箱**等都不开放**以限制其不允许干别的**」
 *
 * ⇒ 投喂那一轮里，她**只能记东西、只能读写文件** —— 不能发 QQ 消息、不能跑命令。
 *
 * ## 机制：`ctx.tools.restrict()`（DSH 原生，**不是我们硬拦**）
 *
 * `dsh-tools/README.zh.md:81` 逐字：
 *
 * > `ctx.tools.restrict(filter)` 对**单个 agent** 继承的全局工具应用**允许或拒绝掩码**；
 * > 掩码**取交集**，作用域注册保持可见，**限制在 dispose（资源释放）时解除**。
 *
 * 判据在 `dsh-tools/lib/index.js` 里（**读产物读到的**，不是猜的）：
 *
 * ```js
 * if (filter.allow !== void 0 && !filter.allow.has(name) ||
 *     filter.deny  !== void 0 &&  filter.deny.has(name)) return false;
 * ```
 *
 * ⇒ `filter = { allow?: Set<string>, deny?: Set<string> }`，装的是**工具名**；
 *   放行 ⟺ `(allow 未给 或 allow.has(name)) 且 (deny 未给 或 !deny.has(name))`。
 *
 * **为什么走它而不是自己拦**：三个性质刚好都是我们要的 ——
 *  ① **按单个 agent** ⇒ 投喂那个收窄，别的 agent 不受影响；
 *  ② **取交集** ⇒ 多重限制叠加**不会互相放开**（叠加限制最容易出的洞）；
 *  ③ **dispose 时解除** ⇒ 喂完自动恢复，**不需要我们记着还原**（少一个"忘了还原"的故障模式）。
 *
 * ## ★ 白名单是**唯一**的真源，且由测试从两侧钉住
 *
 * - **正面**：白名单里的每一个名字都必须真的存在（拼错的名字会让"限制"静默失效）
 * - **反面**：★ **QQ / 沙箱 / 执行类工具一个都不许在里面** ——
 *   这是用户那句"不允许干别的"的**可执行形式**
 *
 * @module forlife-memory/feed-restrict
 */

/**
 * 投喂期**唯一**允许的工具。
 *
 * 分两组，各有理由：
 *
 * **记忆那一族**（我们自己注册的）：投喂的目的就是"把资料记进去"，
 * 所以"记"与"查"都得开着 —— 她需要**回看自己刚记了什么**才能条目化/总结化/印象化。
 *
 * **文件读写那一族**（宿主自带的 `dsh-tool-fs`）：用户明确点了"文件读写"。
 * 名字取自那个包的 README 表格（`:46-49`）：`read` / `read_image` / `write` / `edit`。
 *
 * ⚠️ **刻意不含**：`qq_*`（发消息/表情/文件/撤回/群公告…）、`pwsh`（执行命令）、
 * 子代理与工作流类、`sticker_*`、`set_status` / `clear_system_status`（会改她的状态）、
 * `schedule_wake` / `register_watcher`（会排未来的事）——
 * 它们都属于用户说的"**别的**"。这条**由测试反面钉住**（见 `feed-restrict.test.ts`）。
 */
export const FEED_ALLOWED_TOOLS: readonly string[] = [
  // ── 记忆：写入 ──────────────────────────────────────────────
  'remember', // 记"关于对话/用户的一件事"
  'push_mid_memory', // 往中期记忆推一条
  'feed_memory', // ★ 本次投喂的主工具（整块投喂就靠它）
  // ── 记忆：回看（条目化/总结化要用）─────────────────────────
  'recall_longterm',
  'recall_full',
  'recall_mid', // ★ P0-a 加的那个：按 id 取中期正文
  // ── 文件读写（用户点名的那一族）────────────────────────────
  'read',
  'read_image',
  'write',
  'edit',
] as const

/**
 * 用户明确点名**不许开**的那几类 —— 写成清单是为了让反面测试**逐条有据**，
 * 而不是"随便挑几个名字试试"。
 */
export const FEED_FORBIDDEN_PREFIXES: readonly string[] = [
  'qq_', // QQ 那一族：发消息/表情/文件/撤回/群公告/处理请求…
  'sticker_', // 表情包
] as const

/** 额外点名的（没有统一前缀的那些）。 */
export const FEED_FORBIDDEN_EXACT: readonly string[] = [
  'pwsh', // ★ 沙箱/执行 —— 用户原话点名的"沙箱"
  'workflow', // 大规模多代理编排
  'subagent',
  'subagent_fork',
  'set_status',
  'clear_system_status',
  'schedule_wake',
  'register_watcher',
  'list_wakes',
  'cancel_wake',
  'wake_now',
  'defer_turn',
  'read_pending',
  'set_wake_rule',
  'list_wake_rules',
  'switch_model',
  'revert_model',
  'now',
  'get_clock',
  'set_clock',
  'list_clocks',
] as const

/** `restrict` 的过滤器形状（照 `dsh-tools/lib/index.js` 的判据写）。 */
export interface ToolRestrictFilter {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/**
 * 宿主 `ctx.tools` 里我们要用的那一个方法（**窄接口**，便于注入与测试）。
 *
 * ⚠️ 只声明 `restrict` —— 我们不该、也不需要碰工具注册表的其余部分。
 */
export interface ToolRestrictHost {
  readonly restrict: (filter: ToolRestrictFilter) => { readonly dispose: () => void }
}

/**
 * 给**一个 agent** 套上投喂期的工具掩码。
 *
 * @returns **解除函数** —— 投喂结束（无论成功、失败、超时）都必须调到它。
 *   调用方请放进 `finally`，别依赖"正常路径会走到"。
 */
export function restrictToolsForFeed(
  tools: ToolRestrictHost,
  log: (message: string) => void = () => undefined,
): () => void {
  // 用 `allow` 白名单，**不用** `deny` 黑名单：黑名单必然漏（DSH 以后加一个新工具，
  // 我们没听说过它 ⇒ 它就自动被放行了）。白名单的失败方向是"少给了一个工具"，
  // 那是可见且可修的；黑名单的失败方向是"悄悄多给了一个能发 QQ 消息的工具"。
  const handle = tools.restrict({ allow: new Set(FEED_ALLOWED_TOOLS) })
  log(
    `投喂期工具已收窄：只保留 ${String(FEED_ALLOWED_TOOLS.length)} 个（记忆 + 文件读写）` +
      `；QQ / 沙箱 / 子代理 / 状态类一律不可用（用户 2026-10-10 指定）`,
  )

  let disposed = false
  return () => {
    // 幂等：解除函数可能被 `finally` 和超时路径各调一次，第二次不许炸
    if (disposed) return
    disposed = true
    handle.dispose()
    log('投喂期工具已恢复（掩码已解除）')
  }
}
