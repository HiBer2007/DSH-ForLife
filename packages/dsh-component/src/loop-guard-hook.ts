/**
 * 死循环监控：挂宿主钩子 + **真正中止本轮**。
 *
 * ## 上一版为什么不够（如实记）
 *
 * 上一版接在 `qq_reply` 里 —— 因为**当时没找到输出侧钩子**。
 * 它的盲区是：**模型卡在"不发言"的循环里就拦不到**（比如反复调只读工具）。
 *
 * ## 这一版找到了宿主真正的钩子
 *
 * 在 `@deepseek-ai/dsh-agent` 的 `lib/types/runtime-types.d.ts` 里
 * （本机包在 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`）：
 *
 * | 钩子 | 模式 | 拿到什么 |
 * |---|---|---|
 * | `agent/assistant-stream` | `emit` | `frame.chunk`，其中 `{type:'text-delta', text}` 是**模型刚生成的原文** |
 * | `agent/turn-stopping` | `serial` | `signal`（本轮的 abort signal） |
 *
 * 而 **`agent.cancel(cause)`** 是**正式的"停本轮"接口**，
 * `AgentCancelCause` 里有 `{kind:'hook', reason}` —— **那一档就是给插件用的**
 * （`user` / `parent` / `disposed` 都不是我们）。
 *
 * ## 这一版补上了什么
 *
 * 1. **看得到原文**（不是只看它发出去的消息）⇒ 模型**在思考里**打转也能发现；
 * 2. **能真正中止本轮**（`cancel`），而不是只回一句"你被中止了"；
 * 3. **中止之后由宿主自己开新一轮** —— 那正是用户要的"**停之本轮次然后重启**"。
 *
 * ## ★ 一条纪律：喂进去的必须是**一条完整的输出**，不是每帧的碎片
 *
 * `text-delta` 是**增量**（每次几个字），而 `LoopGuard.feed()` 期望
 * **一条完整的输出**。
 * ⇒ **按帧累积**，累积到一定量（或输出结束）才喂一次。
 * **每帧都喂的话，检测器看到的全是碎片，永远判不出重复。**
 *
 * @module forlife-memory/loop-guard-hook
 */
import { LoopGuard, type LoopVerdict } from '@forlife/store'

/** 流式帧的最小形状（只声明我们**真的会读**的字段）。 */
export interface StreamFrameLike {
  readonly type?: string
  readonly chunk?: { readonly type?: string; readonly text?: string }
}

/** 中止接口的最小形状（宿主 `Agent.cancel` 的结构子集）。 */
export interface CancelableAgent {
  cancel?: (cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }) => void
}

export interface LoopGuardHookOptions {
  readonly log?: (message: string) => void
  /** 注入检测器（测试用；不传则每个 agent 自己建一个）。 */
  readonly guard?: LoopGuard
  /** 真的中止（测试用；不传则调 `agent.cancel`）。 */
  readonly cancel?: (agent: CancelableAgent, reason: string) => void
}

export interface LoopGuardHook {
  /** 处理一帧。**返回判定**（没到判定点则 `null`）。 */
  readonly onFrame: (agent: CancelableAgent, frame: StreamFrameLike) => LoopVerdict | null
  /** 累积到多少字符就先看一眼（**及时止损** —— 等整条输出完可能已经烧了很多 token）。 */
  readonly flushAt: number
}

/**
 * 建一个**按 agent 隔离**的监控器。
 *
 * ## 为什么按 agent 隔离
 *
 * 用户要的是"**一个模型窗口同时处理多个会话**"（见 `qq-tools` 的模块头）。
 * **共用一个检测器的话**，两个会话交替发言会被算成"重复" ——
 * **那是误杀**（而且是最冤的那种：两个正常会话被对方的正常内容判成循环）。
 *
 * ⇒ **每个 agent 一个检测器**，用 `WeakMap` 存（agent 回收时自动清）。
 */
export function createLoopGuardHook(options: LoopGuardHookOptions = {}): LoopGuardHook {
  const guards = new WeakMap<object, { guard: LoopGuard; buffer: string }>()
  const flushAt = 400

  const cancelOf =
    options.cancel ??
    ((agent: CancelableAgent, reason: string): void => {
      agent.cancel?.({ kind: 'hook', reason }, { keepInbox: true })
    })

  /** 判定 + 必要时中止。**中止与记录都在一处**，免得两处不一致。 */
  const judge = (
    agent: CancelableAgent,
    entry: { guard: LoopGuard; buffer: string },
  ): LoopVerdict | null => {
    if (entry.buffer === '') return null
    const verdict = entry.guard.feed(entry.buffer)
    entry.buffer = ''
    if (verdict.action === 'stop-and-restart') {
      cancelOf(agent, verdict.reason)
      options.log?.(`**检测到死循环，已中止本轮**：${verdict.reason}`)
    }
    return verdict
  }

  return {
    flushAt,
    onFrame: (agent, frame) => {
      const key = agent as unknown as object
      let entry = guards.get(key)
      if (entry === undefined) {
        entry = { guard: options.guard ?? new LoopGuard(), buffer: '' }
        guards.set(key, entry)
      }

      // ── ① 新的输出开始 ⇒ 把上一次累积的**结算**掉 ──
      if (frame.type === 'start') return judge(agent, entry)

      // ── ② 文本增量 ⇒ 累积（**不是每帧都喂** —— 那样看到的全是碎片）──
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
        entry.buffer += frame.chunk.text ?? ''
        if (entry.buffer.length >= flushAt) return judge(agent, entry)
        return null
      }

      // ── ③ 输出结束 ⇒ 把剩下的结算掉 ──
      if (frame.type === 'end') return judge(agent, entry)

      return null
    },
  }
}
