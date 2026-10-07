/**
 * 把 `tool/call` 也喂给死循环监控 —— 补上"**不发言的循环**"那个盲区。
 *
 * ## 盲区是什么
 *
 * `agent/assistant-stream` 只看得到 **`text-delta`**（模型生成的文字）。
 * 如果模型卡在**不发言**的循环里 —— 比如反复调同一个只读工具：
 * ```
 * read_file("a.ts") → read_file("a.ts") → read_file("a.ts") → ...
 * ```
 * ——**那一层完全拦不到**（它没有文字输出）。
 *
 * ## ★ 不用新钩子：`tool/call` 走的是**已经在订阅的** `session/event`
 *
 * 查宿主类型时发现 `tool/call` / `tool/result` 是 **`SessionEvent`**，
 * 而本项目**已经在订阅 `session/event`**（为了采集缓存命中率）。
 * ⇒ **扩展现有的那一个订阅**，不新增钩子。
 *
 * **这是更稳的做法**：那条订阅**已经验证过能工作**（真机日志里有
 * `已订阅会话事件：采集缓存命中率`），而新钩子要重新验调用约定。
 *
 * ## ★ 为什么要**独立的**检测器（不能和文字共用一个）
 *
 * 正常的一轮里，文字与工具调用是**交替**的：
 * `说一句 → 调工具 → 再说一句 → 再调工具`
 * 共用一个检测器的话，这个**完全正常的模式**会被看成"重复"。
 * ⇒ **两个独立的 `LoopGuard`**：一个看文字，一个看 `name + arguments`。
 *
 * ## ★ 一条纪律：**参数要归一化掉"确实在推进"的部分**
 *
 * 模型重试时常常**参数只差一点**：
 * `read_file({path:"a.ts", offset:0})` / `read_file({path:"a.ts", offset:1})`
 * ——**那是它在推进**（在往后读），不是循环。
 *
 * 但也可能是**假推进**：`offset:0` 反复出现。
 * ⇒ 这里**不做智能判断**，直接把 `name + arguments` 原样喂进去，
 * 让 `LoopGuard` 的**相似度打转**那条规则去分辨 ——
 * 它要求"公共前后缀 ≥ 0.8 且连续 N 次"，
 * 而 `offset` 每次递增时**尾部在变**，相似度会掉下来。
 *
 * **把判断留给一处（检测器），而不是在两个地方各写一半。**
 *
 * ## ⚠️ 已知限制（**如实记**）
 *
 * **参数每次都变（哪怕只改无关字段）⇒ 工具侧判不出来。**
 * 例：`read_file({path:"same.ts", _ts:0/1/2...})` —— 那是"看起来在变、
 * 其实在原地打转"，但要判出它必须**理解参数语义**
 * （`_ts` 是无关字段，而 `offset` 是推进），**那正是本模块决定不做的事**。
 *
 * ⇒ **精确重复能抓**（绝大多数真实循环就是这样），**"每次参数都不同"抓不到**。
 * 有一条测试**专门守着这个限制**（它断言"当前确实判不出来"），
 * 哪天要补这个能力，那条测试会提醒改它。
 *
 * @module forlife-memory/tool-loop-guard
 */
import { DEFAULT_LOOP_POLICY, LoopGuard, type LoopVerdict } from '@forlife/store'

/** `tool/call` 事件的最小形状（只声明我们会读的字段）。 */
interface ToolCallEventLike {
  readonly type?: string
  readonly name?: unknown
  readonly arguments?: unknown
}

export interface ToolLoopGuard {
  /** 喂一个会话事件。**返回判定**（不是 tool/call 则 `null`）。 */
  readonly feed: (event: unknown) => LoopVerdict | null
  /** 累积了几次工具调用（测试与排障用）。 */
  readonly count: () => number
}

/**
 * 建一个工具调用侧的监控。
 *
 * **与文字侧独立** —— 见模块头的理由（正常交替会被误判成重复）。
 */
export function createToolLoopGuard(options: { readonly guard?: LoopGuard } = {}): ToolLoopGuard {
  // ★ **工具侧用一份改过的策略** —— 关掉"相似度打转"那条规则。
  //
  // 理由（**测试抓到的真缺陷**）：
  // `read_file({path:"big.ts", offset:0/100/200, limit:100})` 里变化的部分在 JSON
  // **中间**，公共前后缀几乎一样 ⇒ 那条规则把**推进**判成了循环。
  //
  // **两个领域的语义不同**：
  //  - 文字里"相似但不相同" = **换着说法重复** ⇒ 是循环；
  //  - 工具调用里"相似但不相同" = **传了不同参数** = 在做不同的事 ⇒ 是推进。
  //
  // ⇒ 工具侧只认**精确重复**，**headTailRun 设到不可能达到**。
  const guard =
    options.guard ??
    new LoopGuard({ ...DEFAULT_LOOP_POLICY, headTailRun: Number.MAX_SAFE_INTEGER })
  let n = 0

  return {
    count: () => n,
    feed: (event) => {
      const e = event as ToolCallEventLike | null
      if (e === null || typeof e !== 'object') return null
      // **只认 `tool/call`** —— `tool/result` 的重复是**结果**重复，
      // 而"结果一样"可能只是那个工具本来就返回固定内容（不是循环）。
      if (e.type !== 'tool/call') return null
      const name = typeof e.name === 'string' ? e.name : ''
      if (name === '') return null
      // `arguments` 在类型里是 `string`（已序列化的 JSON），但也可能是对象 —— 两种都收
      const args = typeof e.arguments === 'string' ? e.arguments : JSON.stringify(e.arguments ?? {})
      n += 1
      // **把"工具名 + 参数"当成一次输出喂进去** ——
      // 复用同一套检测（归一化 + 周期 + 相似度打转），不另写一套。
      return guard.feed(`${name}(${args})`)
    },
  }
}
