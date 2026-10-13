/**
 * 把死循环监控**挂到宿主上** —— 本包唯一"接线"的地方。
 *
 * ## 挂什么（两条腿）
 *
 * | 腿 | 事件 | 看什么 | 越线时 |
 * |---|---|---|---|
 * | 文字 | `agent/assistant-stream` | `text-delta` 累积成的整段输出 | `agent.cancel({kind:'hook'})` |
 * | 工具 | `session/event` 的 `tool/call` | `工具名(参数)` | 同上（用**该会话**的 agent） |
 *
 * 两条腿**各自一个检测器**（正常一轮里文字与工具是交替的 —— 共用会把
 * 完全正常的模式看成重复，见 `tool.ts` 模块头）。
 *
 * ## ★★ 为什么"工具腿"要按会话找 agent（2026-10-11 修的）
 *
 * 宿主的两条钩子给的句柄不一样：
 * - `agent/assistant-stream` ⇒ **给 agent**（`payload.agent`）；
 * - `session/event` ⇒ 给 **session**（`session.id`），**没有 agent**。
 *
 * 而这一版之前的实现**只记日志、不中止**（那时候还挂在
 * `forlife-memory` 的用量采集那个 `try` 里，见下），
 * ⇒ "工具侧监控"名义上在跑，实际**从不停下任何东西**。
 *
 * 宿主类型里 `Agent.id` 就是 `SessionId`（`dsh-agent/lib/types/types.d.ts`：
 * `interface Agent { readonly id: SessionId }`）⇒ 文字腿看到的 agent
 * **可以按 id 存起来**，工具腿用 `session.id` 去取它，就能真的 `cancel`。
 *
 * ## ★★ 这一版顺带修掉的一个真缺陷（**在 `forlife-memory` 里**）
 *
 * 迁移前，工具腿的 `feed` 被写在 `forlife-memory/src/index.ts` 的
 * **`catch (error)` 块里**（用量采集失败才会执行）⇒
 * **生产里几乎永远不跑**，而且**没有任何测试抓到**（那条 e2e 只喂了文字帧）。
 * ⇒ 抽出来之后两条腿各有一条**行为测试**（`test/install.test.ts` +
 * `packages/dsh-component/test/loop-guard-e2e.test.ts` 的工具帧那条），
 * 结构上也不可能再"躲在 catch 里"。
 *
 * ## 三条纪律（都来自本项目的教训）
 *
 * 1. **绝不抛异常** —— 监控跑在**每一次模型输出/每次工具调用**上，
 *    它抛错会**毁掉整轮**（与 `vision-bridge` 同源的理由）；
 * 2. **拿不到钩子要明说**（`⚠️`），**不能静默** ——
 *    静默的话，"监控在跑"和"监控没挂上"从日志上看一模一样；
 * 3. **必须能反注册**（`disposers`），否则热重载会**重复挂载** ⇒
 *    一次输出被喂两遍 ⇒ **正常内容被判成重复**（那是最冤的误杀）。
 *
 * @module @forlife/loop-guard/install
 */
import { createLoopGuardHook, type StreamFrameLike } from './hook.ts'
import { createToolLoopGuard } from './tool.ts'

/** 与宿主 `Context` 结构兼容（只声明我们会用的部分）。 */
interface RegisterableContext {
  on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined
}

/** 带 id 的 agent：`Agent.id` 就是 `SessionId`（见模块头）。 */
interface AgentLike {
  readonly id?: unknown
  cancel?: (cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }) => void
}

export interface LoopGuardOptions {
  readonly log: (message: string) => void
  /** `⚠️` 级别（拿不到钩子这类**必须让人看见**的事）。 */
  readonly always: (message: string) => void
  /** 反注册器收集处（与宿主插件里的 `disposers` 同一个数组）。 */
  readonly disposers: (() => void)[]
  /** 读环境变量（测试用；不传则读 `process.env`）。 */
  readonly env?: Record<string, string | undefined>
}

export interface LoopGuardInstall {
  /** **两条腿有一条挂上**就算挂上了（`text || tool`）。 */
  readonly mounted: boolean
  /** 文字腿（`agent/assistant-stream`）挂上了吗。 */
  readonly text: boolean
  /** 工具腿（`session/event`）挂上了吗。 */
  readonly tool: boolean
  /** 没挂上（或跳过了）的原因 —— **要能解释**。 */
  readonly reason?: string
}

/** 环境开关：显式关掉（`FORLIFE_LOOP_GUARD=off`）。 */
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled'])

/**
 * 已经挂过的宿主上下文。
 *
 * ★ 为什么需要：`forlife-memory` 与**独立的**本插件包**可以同时被装进一个
 * profile**（那正是抽出来的目的：不装记忆也能单装守卫）。
 * 两边都调 `installLoopGuard` 的话，同一个 ctx 会被挂两遍 ⇒
 * 一次输出喂两遍（重复判定的风险 + 白做功）。
 *
 * ⚠️ **它只挡得住"同一个 ctx 对象"**：宿主给不同插件的 ctx 可能不是同一个对象
 * （cordis 的 fork 作用域），那种情况下两边会各挂一套 —— **那是无害的**
 * （各自独立的检测器状态；`cancel` 本身是幂等的），
 * 但**部署时不要主动两处都装**（见包 README 的说明）。
 */
const mountedContexts = new WeakSet<object>()

/** agent 记忆的容量上限（长跑进程里不能只增不减）。 */
const maxRememberedAgents = 64

/**
 * 挂上死循环监控。**返回两条腿各自的挂载结果**（测试要看）。
 *
 * 挂不上**不是致命错误** —— 死循环监控是**加固**，不是任何插件的主体。
 * 但**必须让人看见**（`always`）。
 */
export function installLoopGuard(ctx: unknown, options: LoopGuardOptions): LoopGuardInstall {
  const env = options.env ?? (process.env as Record<string, string | undefined>)

  // ── ① 环境开关（显式关掉时**要说出来**，不能静默不干活）──
  const flag = (env.FORLIFE_LOOP_GUARD ?? '').trim().toLowerCase()
  if (OFF_VALUES.has(flag)) {
    options.log('死循环监控已按 FORLIFE_LOOP_GUARD 关闭（本轮不挂载）')
    return { mounted: false, text: false, tool: false, reason: 'env-disabled' }
  }

  // ── ② 宿主得有 `on`（没有就明说）──
  const contextOn = ctx as RegisterableContext
  if (typeof contextOn.on !== 'function') {
    options.always('⚠️ 宿主没有 ctx.on ⇒ **死循环监控未挂载**（不影响插件本体）')
    return { mounted: false, text: false, tool: false, reason: 'no-ctx-on' }
  }

  // ── ③ 同一个 ctx 不重复挂（见 `mountedContexts` 的说明）──
  if (ctx !== null && typeof ctx === 'object' && mountedContexts.has(ctx)) {
    options.log('死循环监控这个上下文已经挂过了（跳过重复挂载）')
    return { mounted: true, text: true, tool: true, reason: 'already-mounted' }
  }

  const hook = createLoopGuardHook({ log: (message) => options.log(message) })
  const toolGuard = createToolLoopGuard()

  /**
   * 会话 id ⇒ 该会话**最近一次**在文字流里见到的 agent。
   *
   * 工具腿只有 `session`、没有 agent，靠这张表把它接上（见模块头）。
   * `Map` 的插入序 + 容量上限 ⇒ 长跑进程里不会无限增长。
   */
  const agentsBySession = new Map<string, AgentLike>()

  const rememberAgent = (agent: AgentLike): void => {
    const id = typeof agent.id === 'string' ? agent.id : ''
    if (id === '') return
    // 已存在时先删再插 ⇒ 它变成"最新"的那一条（淘汰时先丢最久没动的）
    agentsBySession.delete(id)
    agentsBySession.set(id, agent)
    if (agentsBySession.size > maxRememberedAgents) {
      const oldest = agentsBySession.keys().next()
      if (!oldest.done) agentsBySession.delete(oldest.value)
    }
  }

  /** 统一的"中止本轮"（两条腿共用一处，免得两边行为分叉）。 */
  const cancelOf = (agent: AgentLike, reason: string): boolean => {
    if (typeof agent.cancel !== 'function') return false
    try {
      agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
      return true
    } catch (error) {
      // **绝不抛异常**：这个 handler 跑在模型输出/工具调用上
      options.log(`中止本轮失败（已忽略）：${String(error)}`)
      return false
    }
  }

  /** 从参数里**两种约定都试**地解出 `(agent, frame)`。 */
  const parse = (args: unknown[]): { agent: unknown; frame: unknown } | null => {
    const first = args[0]
    // 约定 A：一个 payload `{ agent, frame }`
    if (first !== null && typeof first === 'object' && 'frame' in first) {
      const p = first as { agent?: unknown; frame?: unknown }
      return { agent: p.agent, frame: p.frame }
    }
    // 约定 B：两个参数 `(agent, frame)`
    const second = args[1]
    if (second !== null && typeof second === 'object' && 'type' in (second as object)) {
      return { agent: first, frame: second }
    }
    return null
  }

  const disposers: (() => void)[] = []
  let text = false
  let tool = false

  // ── ④ 文字腿：`agent/assistant-stream`（能看到模型刚生成的原文）──
  try {
    const dispose = contextOn.on('agent/assistant-stream', (...args: unknown[]) => {
      try {
        const parsed = parse(args)
        if (parsed === null) return
        const agent = (parsed.agent ?? {}) as AgentLike
        rememberAgent(agent)
        // `createLoopGuardHook` 自己会 `cancel`（它拿得到 agent）——
        // 这里只负责"把帧喂进去"，不重复中止。
        hook.onFrame(agent, parsed.frame as StreamFrameLike)
      } catch (error) {
        options.log(`死循环监控单帧处理失败（已忽略）：${String(error)}`)
      }
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    text = true
  } catch (error) {
    options.always(`⚠️ 无法订阅模型输出流（文字侧死循环监控不可用）：${String(error)}`)
  }

  // ── ⑤ 工具腿：`session/event` 的 `tool/call`（补"不发言的循环"）──
  try {
    const dispose = contextOn.on('session/event', (...args: unknown[]) => {
      try {
        const session = args[0] as { id?: unknown } | undefined
        const key = typeof session?.id === 'string' ? session.id : ''
        const verdict = toolGuard.feed(key, args[1])
        if (verdict === null || verdict.action !== 'stop-and-restart') return
        options.always(`⚠️ **检测到工具调用死循环**：${verdict.reason}`)
        const agent = agentsBySession.get(key)
        if (agent === undefined) {
          // **别静默**：判出来了却下不了手，必须让人看见（那说明这条腿没接全）
          options.always(
            `⚠️ 工具调用死循环已判定，但**这个会话还没有挂上 agent**（无法中止本轮）：${key === '' ? '(无会话 id)' : key}`,
          )
          return
        }
        if (cancelOf(agent, `工具调用死循环：${verdict.reason}`)) {
          options.always(`**检测到工具调用死循环，已中止本轮**：${verdict.reason}`)
        } else {
          // ★ 「判出来了却下不了手」的**第二种**成因（第一种是上面那条"这个会话还没挂上 agent"）：
          //   agent 拿到了，但它**没有 `cancel` 接口**（宿主版本不同 / 形状不符）。
          //   ⇒ 同理：**必须让人看见**，不能静默地什么都不做。
          options.always('⚠️ 工具调用死循环已判定，但 agent 没有 cancel 接口（无法中止本轮）')
        }
      } catch (error) {
        options.log(`死循环监控工具事件处理失败（已忽略）：${String(error)}`)
      }
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    tool = true
  } catch (error) {
    options.always(`⚠️ 无法订阅会话事件（工具侧死循环监控不可用）：${String(error)}`)
  }

  if (text) {
    options.log('已订阅模型输出流：死循环监控（越线时中止本轮）')
  }
  if (tool) {
    // 与文字侧对称：**挂上时要留一行** ——
    // 静默的话，"工具侧监控在跑"和"没挂上"从日志上看一模一样。
    options.log('已订阅工具调用事件：死循环监控（不发言的循环）')
  }
  if (!text && !tool) {
    options.always('⚠️ 死循环监控**一条腿都没挂上**（宿主拒绝了订阅）')
  }

  for (const dispose of disposers) options.disposers.push(dispose)
  if (ctx !== null && typeof ctx === 'object' && text && tool) {
    // **只有两条腿都挂上**才登记 —— 否则"部分挂上"会被后续调用当成"已挂过"而跳过
    mountedContexts.add(ctx)
  }

  return {
    mounted: text || tool,
    text,
    tool,
    // **"部分挂上"与"完全没挂上"要能区分** —— 否则排障时看返回值看不出是哪种
    ...(text && tool ? {} : { reason: text || tool ? 'partial' : 'subscription-refused' }),
  }
}
