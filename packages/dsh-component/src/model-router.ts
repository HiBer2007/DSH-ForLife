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
import { initialRoute } from '@forlife/router'
import { atLevel } from '@forlife/gateway'

/**
 * 从宿主的 `messages` 里取出**这一轮的输入**（判档要的就是它）。
 *
 * ## 为什么单独一个函数（而不是内联三行）
 *
 * 因为这是**唯一一处"猜宿主载荷形状"**的地方 —— 而本仓栽过好几次
 * （`agent/pre-step` 那条瀑布事件就栽过：只写了 `(payload) => {}`，把整轮干掉了）。
 * 把它抽出来 ⇒ **可以单独喂各种形状去测**，而不是等真机上炸。
 *
 * ## 刻意的宽容
 *
 * 返回 `undefined` 表示"**取不到**"，调用方据此跳过判档（并打一条 `debug`）——
 * **宁可这一轮不判档，也不要猜一个错的文本去定档**：档位会决定用哪个模型，
 * 而"用错模型"是花钱的事，且**从结果上很难看出来**（她照样会回话）。
 */
export function extractTurnText(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  // 从后往前找**最后一条** role=user 的（最后一条用户输入才是这一轮的输入）
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null | undefined
    if (m === null || typeof m !== 'object') continue
    if (m.role !== 'user') continue
    const text = textOf(m.content)
    if (text !== undefined && text.trim() !== '') return text
  }
  return undefined
}

/** 内容可能是字符串、`{text}`、或它们的数组 —— 三种都认。 */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const one = textOfBlock(block)
      if (one !== undefined) parts.push(one)
    }
    return parts.length === 0 ? undefined : parts.join('\n')
  }
  return textOfBlock(content)
}

function textOfBlock(block: unknown): string | undefined {
  if (typeof block === 'string') return block
  if (block === null || typeof block !== 'object') return undefined
  const b = block as { type?: unknown; text?: unknown }
  // 只取**文本**块：图片/工具调用那些不参与判档（判档看的是"这一轮要干什么"）
  return typeof b.text === 'string' ? b.text : undefined
}

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
      // 订阅失败是**一次操作没兜住** ⇒ error（若三个都失败，下面 :243 会升级成 fault）
      atLevel(log, 'error')('订阅 ' + event + ' 失败：' + String(error).slice(0, 120))
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
      // ★ 教科书级的 `debug`：这是**过程细节**（某一步的载荷长什么样），
      //   只有排障时才有意义。默认存储策略**不收 debug**（用户指定："除了 debug 都存"）
      //   ⇒ 它在生产里不再刷屏，但需要时把环境变量一改就能看到。
      atLevel(log, 'debug')('👀 agent/created  sessionId=' + id + '（已观察 ' + String(observed.size) + ' 个）')
      if (mode === 'apply') {
        // ★ 真正的装配在下一步做（先验证钩子响不响）
        // ★ **warn**：这不是"过程细节"，而是**一条"这个功能还没实现"的实情**。
        //   压成 debug 会让"开了 apply 却什么都没发生"变得无从解释 —— 那正是
        //   本仓栽过 18 次的那类问题（写了没接、而日志一片安静）。
        atLevel(log, 'warn')('   ↳ apply 模式：装配 ModelSelectionRef 的逻辑**尚未实现**（先过 observe）')
      }
    } catch (error) {
      atLevel(log, 'error')('agent/created 处理出错：' + String(error).slice(0, 120))
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

  // ── 轮次路由锁（`apply` 才用）────────────────────────────────────────────
  //
  // ⚠️ **刻意放在函数内部**，不是模块级常量：本仓的测试是**单进程共享**的
  //   （`node --test --experimental-test-isolation=none`）——
  //   模块级的可变 `Map` 会**在测试文件之间串味**（`installLogSink` 那次栽过：
  //   一个测试的 sink 顶掉了另一个的，症状是"e2e 莫名其妙 0 !== 8192"）。
  //
  // 键是 `sessionId:turn`：同一轮里**只认第一次判出来的那条**（§8.6 轮次内不换档），
  // 换轮时才丢。**不用 TTL** —— 投喂那种长轮次里 TTL 会让同一轮中途悄悄换档，
  // 而那正是"轮次内不换档"要防的。
  //
  // ⚠️ 上限 `MAX_LOCKED`：`agent/turn-stopping` 不一定每轮都到（进程被杀、轮次中断），
  //   只靠它清理会让这张表慢慢长大 ⇒ 再加一道"最多留这么多轮"的兜底。
  const MAX_LOCKED = 64
  const lockedRoutes = new Map<string, { readonly provider: string; readonly model: string; readonly effort: string }>()
  const routeKey = (sessionId: string, turn: unknown): string => sessionId + ':' + String(turn ?? '?')

  const forgetRoutesExcept = (sessionId: string, turn: unknown): void => {
    const keep = routeKey(sessionId, turn)
    for (const key of [...lockedRoutes.keys()]) {
      if (key !== keep) lockedRoutes.delete(key)
    }
  }

  const rememberRoute = (
    sessionId: string,
    turn: unknown,
    decided: { readonly provider: string; readonly model: string; readonly reasoningEffort: string },
  ): void => {
    const key = routeKey(sessionId, turn)
    if (lockedRoutes.has(key)) return // ★ 同一轮里**只认第一次**（轮次内不换档）
    lockedRoutes.set(key, { provider: decided.provider, model: decided.model, effort: decided.reasoningEffort })
    while (lockedRoutes.size > MAX_LOCKED) {
      const oldest = lockedRoutes.keys().next().value
      if (oldest === undefined) break
      lockedRoutes.delete(oldest)
    }
  }
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
        atLevel(log, 'debug')(
          '👀 agent/pre-step  sessionId=' + id +
            ' turn=' + String(p.turn ?? '?') +
            ' step=' + String(p.step ?? '?') +
            ' messages=' + String(n) + ' 条',
        )
      } else if (preStepCount === 6) {
        atLevel(log, 'debug')('👀 agent/pre-step  （后续不再逐条打，只计数）')
      }
      // ★ 新的一轮 ⇒ **丢掉别的轮次**（防粘性）。
      //   只锁不清 ⇒ 某轮判成 L3 之后所有轮次都粘在 L3，成本悄悄翻倍而没人发现
      //   （`routes.ts:163-164` 那句注释说的就是这个）。
      forgetRoutesExcept(id, p.turn)
      // ★★ **判档**（中介层第 ① 块）：真的算一遍。
      //
      //   ⚠️⚠️ 这里**不再有 `preStepCount <= 5` 的节流**：
      //   原来那个节流同时管着"打日志"和"算"，而 `apply` 需要**每一步**都有路由
      //   ⇒ 第 6 步之后会没有路由可用，**而日志上看不出任何异常**
      //   （正好是本仓最贵的那类问题）。现在**照常算**（纯函数，便宜），只把日志节流。
      //
      //   ⚠️ 取不到这一轮的输入 ⇒ **跳过判档，不猜**。档位决定用哪个模型，
      //   用错模型是花钱的事，而且**从结果上很难看出来**（她照样会回话）。
      if (input.getCatalog !== undefined) {
        const turnText = extractTurnText(p.messages)
        if (turnText === undefined) {
          if (preStepCount <= 5) {
            atLevel(log, 'debug')('   ↳ 判档跳过：这一轮的 messages 里取不到 user 文本（**不猜**）')
          }
        } else {
          const catalog = await input.getCatalog()
          if (catalog === undefined) {
            if (preStepCount <= 5) {
              atLevel(log, 'note')('   ↳ 判档跳过：模型表还没就绪（getCatalog() 给了 undefined）')
            }
          } else {
            // 纯函数、不碰网络：守卫 → 预评分（没接）→ 启发式兜底
            const decided = initialRoute({ turnText, catalog })
            if (decided === undefined) {
              if (preStepCount <= 5) {
                atLevel(log, 'note')(
                  '   ↳ 判档**没得出结果**：模型表里没有可达的模型 —— ' +
                    '注意这不是"这一轮简单"，而是"**没人可用**"（路由会静默不生效）',
                )
              }
            } else {
              rememberRoute(id, p.turn, decided)
              if (preStepCount <= 5) {
                log(
                  '🎚️ 判档（' + (mode === 'apply' ? 'apply' : 'observe，**不改模型**') + '）：' + decided.tier +
                    '（来源 ' + decided.tierSource + '）⇒ ' +
                    (mode === 'apply' ? '本轮就用 ' : '会选 ') +
                    decided.provider + '/' + decided.model +
                    '（强度 ' + decided.reasoningEffort + '，' + String(decided.alternatives.length) + ' 个备选）',
                )
                atLevel(log, 'debug')('   ↳ 凭什么：' + decided.why)
              }
            }
          }
        }
      }
    } catch (error) {
      atLevel(log, 'error')('agent/pre-step 处理出错：' + String(error).slice(0, 120))
    }
    // ★ 只观察 ⇒ 决定**一个字都不改**地传回去
    return decision
  })

  // ── ④ agent/request：**真正落地的地方**（只有 `apply` 会改东西）
  //
  //   为什么判档在 `pre-step`、落地在 `request`：
  //   **只有 `pre-step` 的载荷里有 `messages`**（判档要的那一轮输入），
  //   而**只有 `request` 的 `next()` 给得出 `LlmCallConfig{provider, model, …}`**
  //   （改它 = 改这一请求用哪个模型）。
  //   两个条件凑不到一个事件上 ⇒ 中间靠那个轮次路由锁连着。
  //
  //   ⚠️ 这是**瀑布**事件：必须 `await next()` 并把它的结果**原样**带下去
  //   （除非我们要改）—— 少了 `next()` 会把整轮干掉，
  //   `dsh-plan-mode` 那次 `decision.kind` 的 TypeError 就是这么来的。
  on('agent/request', async (payload, next) => {
    const config = (await next()) as { readonly provider?: unknown; readonly model?: unknown }
    try {
      // observe / off ⇒ **一个字都不改**（这是"先 observe 再 apply"的全部意义）
      if (mode !== 'apply') return config
      const p = (payload ?? {}) as AgentPayload
      const locked = lockedRoutes.get(routeKey(sessionIdOf(p.agent), p.turn))
      if (locked === undefined) return config
      // 已经是那个模型 ⇒ 原样返回（少造一个对象，也让日志干净）
      if (config.provider === locked.provider && config.model === locked.model) return config
      return {
        ...(config as Record<string, unknown>),
        provider: locked.provider,
        model: locked.model,
        reasoningEffort: locked.effort,
      }
    } catch (error) {
      // ★ 路由装配失败 ⇒ **放行宿主原本的配置**（绝不因为我们的问题让这一轮跑不起来）
      atLevel(log, 'error')('agent/request 路由装配出错（已放行宿主的配置）：' + String(error).slice(0, 120))
      return config
    }
  })

  // ── ③ agent/turn-stopping：轮次即将结束（收"建议下次用什么"）
  let turnStoppingCount = 0
  on('agent/turn-stopping', (payload) => {
    try {
      const p = (payload ?? {}) as AgentPayload
      turnStoppingCount += 1
      if (turnStoppingCount <= 5) {
        atLevel(log, 'debug')('👀 agent/turn-stopping  sessionId=' + sessionIdOf(p.agent) + ' turn=' + String(p.turn ?? '?'))
      }
    } catch (error) {
      atLevel(log, 'error')('agent/turn-stopping 处理出错：' + String(error).slice(0, 120))
    }
  })

  log('模型路由：已订阅 ' + String(disposers.length) + ' 个事件（期望 4 个）')
  if (disposers.length < 4) {
    // ★★ **fault**：这不是"一次订阅失败"（那是 error），而是
    //   **路由这一整个子系统实际不工作** —— 事件名与宿主对不上时，
    //   它会**安静地什么都不做**，而外面看起来一切正常。这正是本仓
    //   最贵的一类问题（D6「沉降循环曾完全沉默」是同一个形状）。
    atLevel(log, 'fault')(
      '只装上了 ' + String(disposers.length) + ' 个监听器 —— 事件名可能与宿主对不上，**路由不会生效**' +
        '（这不是"少了一条日志"，是这个功能根本没在跑）',
    )
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
