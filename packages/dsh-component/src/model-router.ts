/**
 * ★★ **模型路由的接线层**（中介层第 ③' 块）。
 *
 * ## 它插在哪
 *
 * ```
 * [ 接入提供方 ]  ── listProviders/listModels ──▶ catalog.ts（模型表 + 可达性）
 *                                                        │
 *   宿主发的 agent/pre-step（带 messages = 轮次输入）──────┤
 *                                                        ▼
 *                              initial.ts：定档 + 挑可达模型
 *                                                        │
 *                                        ModelSelection {provider, model, effort}
 *                                                        ▼
 *                        installModelSelection(agent.ctx, ref)  ⇒  ref.current = …
 *                                                        │
 * [ 实际调用位置 ]  ◀── DSH 的提示词装配在这里 snapshot（**下一步**生效）
 * ```
 *
 * ## 为什么分两步上（**先观察、后行动**）
 *
 * 本项目已经栽过 **18 次**"写好了但没接上/接错了"：
 * 最惨的一次是 `profile patch` 的 `id` 写成包名 ⇒ **整段被静默丢弃**，
 * 而容器一直 `healthy`、插件一直 `0 failed to import`。
 *
 * ⇒ 所以这一层**先以"观察模式"上线**：
 * 订阅三个事件、**打日志、什么都不改**。
 * **确认钩子真的响、载荷真的长这样**，再把 `ref.current` 写进去。
 *
 * ## 它订阅哪三个事件（名字与载荷都从 `dsh-agent` 的 `.d.ts` 抄的）
 *
 * | 事件 | 载荷 | 我们拿它干什么 |
 * | :--- | :--- | :--- |
 * | `agent/created` | `{ agent }` | 给这个 agent **装**一份 `ModelSelectionRef` |
 * | `agent/pre-step` | `{ agent, messages, turn, step, signal }` | ★ **轮次输入就在 `messages` 里** ⇒ 每轮路由 |
 * | `agent/turn-stopping` | `{ agent, turn, signal }` | 轮末 —— 收主模型"建议下次用什么" |
 *
 * ## 观察模式怎么开
 *
 * 环境变量 `FORLIFE_ROUTER_MODE`：
 * - `off`（默认）—— 完全不订阅
 * - `observe` —— **只打日志，不改任何东西** ← 先跑这个
 * - `apply` —— 真的写 `ref.current`（**等 observe 验证过再开**）
 *
 * ⇒ **默认 `off`**：不能让一个没验证过的接线在用户不知情时开始改模型。
 */
import type { Context } from '@deepseek-ai/cordis'

import type { ModelCatalog } from '@forlife/router'

/** 观察模式。 */
export type RouterMode = 'off' | 'observe' | 'apply'

/** 读环境变量决定模式（默认 `off`）。 */
export function resolveRouterMode(env: Record<string, string | undefined> = process.env): RouterMode {
  const raw = (env['FORLIFE_ROUTER_MODE'] ?? 'off').trim().toLowerCase()
  return raw === 'observe' || raw === 'apply' ? raw : 'off'
}

/** 装好之后的句柄。 */
export interface ModelRouterHandle {
  /** 实际用的模式。 */
  readonly mode: RouterMode
  /** 装了几个监听器（0 ⇒ 一个都没装上，那本身就是故障）。 */
  readonly listeners: number
  /** 拆掉（插件卸载时）。 */
  dispose(): void
}

/** 观察到的 agent（按 sessionId 记）。 */
interface ObservedAgent {
  readonly sessionId: string
  readonly agent: unknown
}

/** `agent/created` / `agent/pre-step` 共用的最小载荷形状。 */
interface AgentPayload {
  readonly agent?: unknown
  readonly messages?: readonly unknown[]
  readonly turn?: number
  readonly step?: number
}

/** 从 agent 对象里尽量抠出 sessionId（抠不到就 `?`，**不猜**）。 */
function sessionIdOf(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return '?'
  const rec = agent as Record<string, unknown>
  const session = rec['session']
  if (typeof session === 'object' && session !== null) {
    const id = (session as Record<string, unknown>)['id']
    if (typeof id === 'string') return id
  }
  const id = rec['id']
  return typeof id === 'string' ? id : '?'
}

/**
 * 装模型路由。
 *
 * **这个函数不抛** —— 路由是旁路，它挂掉不该把主流程带走。
 *
 * @param ctx - 插件上下文（用来订阅事件）。
 * @param input.log - 日志函数。
 * @param input.getCatalog - 拿当前模型目录（观察模式下**不调**它，避免无谓的枚举开销）。
 * @param input.env - 环境变量（便于测试）。
 */
export function installModelRouter(
  ctx: Context,
  input: {
    readonly log: (message: string) => void
    readonly getCatalog?: () => ModelCatalog | undefined
    readonly env?: Record<string, string | undefined>
  },
): ModelRouterHandle {
  const mode = resolveRouterMode(input.env ?? process.env)
  const log = input.log
  const disposers: (() => void)[] = []
  const observed = new Map<string, ObservedAgent>()

  /**
   * 安全订阅（事件名对不上、或宿主没有这个事件时不炸）。
   *
   * ★★ **两种事件，签名不一样，别搞混**（2026-10-09 真机血案）：
   *
   *  - **瀑布 / waterfall**（`agent/pre-step`）：宿主用 `dispatch.waterfall(...)` 派发，
   *    链上每个监听器都长成 `(payload, next) => …`。**必须调用 `next()` 并把它
   *    返回的决定原样传回去** —— 少一个环节，上个监听器就拿到 `undefined`。
   *  - **通知 / serial**（`agent/created`、`agent/turn-stopping`）：
   *    宿主用 `dispatch.serial(...)` / `ctx.serial(...)` 派发，**不传 `next`**，
   *    返回值也没人要。这里写 `(payload) => {…}` 是对的。
   *
   * `next` 只在瀑布事件里存在；通知事件里它是 `undefined`。
   */
  const on = (
    event: string,
    handler: (payload: unknown, next: () => Promise<unknown>) => unknown,
  ): void => {
    try {
      const off = (
        ctx as unknown as {
          on(name: string, fn: (p: unknown, n: () => Promise<unknown>) => unknown): () => void
        }
      ).on(event, handler)
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      log('⚠️ 订阅 ' + event + ' 失败：' + String(error).slice(0, 120))
    }
  }

  if (mode === 'off') {
    return {
      mode,
      listeners: 0,
      dispose: () => {
        /* 没装就没得拆 */
      },
    }
  }

  log('模型路由：模式=' + mode + '（observe 只观察；apply 才真的改模型）')

  // ── ① agent/created：新 agent 出现
  on('agent/created', (payload) => {
    try {
      const p = (payload ?? {}) as AgentPayload
      const id = sessionIdOf(p.agent)
      observed.set(id, { sessionId: id, agent: p.agent })
      log('👀 agent/created  sessionId=' + id + '（已观察 ' + String(observed.size) + ' 个）')
      if (mode === 'apply') {
        // ★ 真正的装配在下一步做（先验证钩子响不响）
        log('   ↳ apply 模式：装配 ModelSelectionRef 的逻辑**尚未实现**（先过 observe）')
      }
    } catch (error) {
      log('⚠️ agent/created 处理出错：' + String(error).slice(0, 120))
    }
  })

  // ── ② agent/pre-step：每一步之前（**轮次输入就在 messages 里**）
  //
  // ★★ 这是**瀑布（waterfall）**事件，不是通知 —— 宿主用
  //    `this.dispatch.waterfall("agent/pre-step", …)` 派发
  //    （`dsh-agent-loop/lib/index.js:911`），链上每个监听器都长成 `(payload, next) => …`。
  //
  //    我们原来只写了 `(payload) => {…}`：**既不接 `next`、也不返回决定**
  //    ⇒ 瀑布在这一环断掉，**上一个监听器 `await next()` 拿到 `undefined`**。
  //
  //    真机后果（2026-10-09 实测，靠给 `dsh-agent-loop` 临时补打印堆栈才挖出来）：
  //      `dsh-plan-mode/lib/index.js:155`：`if (decision.kind === "reject" …)`
  //      ⇒ TypeError: Cannot read properties of undefined (reading 'kind')
  //      ⇒ **整轮直接失败**，而且报错是 `dsh: UNKNOWN: …`、**连堆栈都没有**。
  //
  //    一句话：一个"只是观察一下"的订阅，把整个 agent 跑回合的能力干掉了；
  //    而且症状（一开回合就 UNKNOWN）离原因（少了个 next）十万八千里。
  //    **凡是接瀑布事件，就必须把决定原样传下去。**
  let preStepCount = 0
  on('agent/pre-step', async (payload, next) => {
    // ★ `next()` 放在 try **外面**：链上后面那几环抛错时，
    //   必须让异常穿过去，不能被我们"观察失败"的 catch 吞掉。
    const decision = await next()
    try {
      const p = (payload ?? {}) as AgentPayload
      preStepCount += 1
      const id = sessionIdOf(p.agent)
      const n = p.messages?.length ?? 0
      // ★ 只在头几次详细打，免得刷屏
      if (preStepCount <= 5) {
        log(
          '👀 agent/pre-step  sessionId=' + id +
            ' turn=' + String(p.turn ?? '?') +
            ' step=' + String(p.step ?? '?') +
            ' messages=' + String(n) + ' 条',
        )
      } else if (preStepCount === 6) {
        log('👀 agent/pre-step  （后续不再逐条打，只计数）')
      }
      if (mode === 'apply' && input.getCatalog !== undefined) {
        // ★ 真正的路由在这里（尚未实现 —— 先过 observe）
        log('   ↳ apply 模式：initialRoute() 接线**尚未实现**（先过 observe）')
      }
    } catch (error) {
      log('⚠️ agent/pre-step 处理出错：' + String(error).slice(0, 120))
    }
    // ★ 只观察 ⇒ 决定**一个字都不改**地传回去
    return decision
  })

  // ── ③ agent/turn-stopping：轮次即将结束（收"建议下次用什么"）
  let turnStoppingCount = 0
  on('agent/turn-stopping', (payload) => {
    try {
      const p = (payload ?? {}) as AgentPayload
      turnStoppingCount += 1
      if (turnStoppingCount <= 5) {
        log('👀 agent/turn-stopping  sessionId=' + sessionIdOf(p.agent) + ' turn=' + String(p.turn ?? '?'))
      }
    } catch (error) {
      log('⚠️ agent/turn-stopping 处理出错：' + String(error).slice(0, 120))
    }
  })

  log('模型路由：已订阅 ' + String(disposers.length) + ' 个事件（期望 3 个）')
  if (disposers.length < 3) {
    log('⚠️ 只装上了 ' + String(disposers.length) + ' 个监听器 —— 事件名可能与宿主对不上，路由不会生效')
  }

  return {
    mode,
    listeners: disposers.length,
    dispose: () => {
      for (const off of disposers) {
        try {
          off()
        } catch {
          // 拆的时候出错无所谓
        }
      }
      disposers.length = 0
      observed.clear()
    },
  }
}
