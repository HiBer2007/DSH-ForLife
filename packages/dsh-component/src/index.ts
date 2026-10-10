/**
 * legacy cordis 入口（宿主插件的真实加载点）。
 *
 * 双入口策略（EXECUTION_PLAN §1.1）：
 *  - **本文件**：legacy cordis 形态（`name` / `inject` / `Config` / `apply`），
 *    任何 DSH 版本都能加载，也是当前 profile 实际走的路；
 *  - `./facet.ts`：dsh-std 便携形态（`lifecycle.dsh/v1alpha1` 的 FacetModule）。
 *
 * 服务获取策略：核心服务（`systemPrompt` / `tools`）用 `inject` 等待；
 * 可选服务（`connection`）用 `ctx.inject([...], cb)` 延迟获取 —— 这样在
 * **没有 web 服务的宿主（如 dsh-tui / 裸测试台）里也能正常加载**，只是不暴露面板接口。
 *
 * `DSH_HOME` 解析顺序（实测 `dsh-home-paths`）：显式配置 > `$DSH_HOME` > `~/.dsh`。
 * 我们**只读环境变量**，绝不写宿主默认目录。
 *
 * @module forlife-memory
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolveInWorkspace } from '@forlife/gateway'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { Config, resolveConfig, type ForlifeConfig } from './config.ts'
import { contractsSummary } from './diagnostics.ts'
import { registerMemorySections, registerProactivitySection, registerPromptSections, type SystemPromptLike } from './prompt.ts'
import { seedDefaultPrompts } from './prompt-store.ts'
import { seedDefaultRoutes, seedDeepSeekFallback, seedOpenCodeGoRoutes } from './route-seed.ts'
import { probeLlm } from './llm-probe.ts'
import { fetchHostCatalog } from './llm-host.ts'
import { installModelRouter } from './model-router.ts'
import { collectUsageFromEvent } from './cache-collector.ts'
import { buildClockTools } from './clock-tools.ts'
import { buildRouterTools } from './router-tools.ts'
import { buildPortTools, portToolOptionsFromEnv } from './port-tools.ts'
import { getWakeTrigger, markSystemTriggersDue, recoverPendingCompactions, updateWakeTrigger } from '@forlife/store'
import { onCompactionFailure } from './compaction-engine.ts'
import { buildWakeTools, type WakeToolHost } from './wake-tools.ts'
import { registerWakeEndpoint, type WakeHost } from './wake-bridge-endpoint.ts'
// ★ D7 / D-B：唤醒桥的**自建宿主**（DSH 的 webServer 只绑回环，gateway 够不到）
import { startWakeHost } from './wake-host.ts'
// ★ 投喂的轮次钩子（用户 2026-10-10：「以单个轮次为界」）
import { createFeedTurnHook } from './feed-turn-hook.ts'
import type { ToolRestrictHost } from './feed-restrict.ts'
import { registerLoopGuard } from './loop-guard-register.ts'
import { registerToolResultSpill } from './tool-spill.ts'
import { createToolLoopGuard } from './tool-loop-guard.ts'
import { MemoryRuntime, resolveDbPath, startSettleTimer } from './runtime.ts'
export type { MemoryRuntime } from './runtime.ts'
import { buildMemoryTools, type DefineToolLike } from './tools.ts'
import { buildQqTools } from './qq-tools.ts'
// 手动喂食记忆资料（模型可调的工具面）：与 CLI/HTTP 共用 gateway 的 `feedMemory`
import { buildFeedTools } from './feed-tools.ts'
import { emitForlifeEvent, type SessionLike } from './events.ts'
export { adminMessage, createForlifeMessage, FORLIFE_SOURCES, qqMessage, systemMessage } from './sources.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'forlife-memory'

/**
 * 工具定义器：**顶层 await 动态导入**，而不是静态 import。
 *
 * 原因：`@deepseek-ai/dsh-tools` 是可选 peer —— 静态 import 会让
 * "宿主没装这个包"直接变成"插件加载失败"，那就丧失了可移植性；
 * 全部自己实现又会与宿主行为分叉（schema 编译必须与宿主一致）。
 * 动态导入 + 失败降级是唯一同时满足两者的方案。
 */
let defineToolImpl: DefineToolLike | undefined
try {
  const module = (await import('@deepseek-ai/dsh-tools')) as unknown as { defineTool?: DefineToolLike }
  defineToolImpl = module.defineTool
} catch {
  defineToolImpl = undefined
}

/**
 * 需要的核心服务。
 *
 * 刻意**不 inject** `tools` / `connection`：前者在无工具宿主里可能不存在，
 * 后者只在 web 宿主存在。我们用 `ctx.get()` 探测式获取，缺失就降级跳过，
 * 这样"同一个包在任何宿主上都能装、都能看见为什么没生效"。
 */
export const inject: string[] = []

export { Config }
export type { ForlifeConfig } from './config.ts'

/** 宿主上下文的最小结构（我们真正用到的部分）。 */
interface ContextLike {
  readonly [key: string]: unknown
  get(name: string): unknown
  inject?(names: string[], callback: (ctx: ContextLike) => void): unknown
  effect?(callback: () => void | (() => void)): unknown
  plugin?(plugin: unknown): unknown
  on?(event: string, callback: (...args: never[]) => void): unknown
}

/** 解析 `DSH_HOME`（只读；优先环境变量，其次宿主默认目录）。 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return isAbsolute(fromEnv) ? fromEnv : join(process.cwd(), fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 已由 schemastery 解析的配置。
 */
/** 活动运行时登记表（键 = 数据库绝对路径）。 */
const runtimeRegistry = new Map<string, MemoryRuntime>()

/**
 * 取当前进程里已加载的记忆运行时。
 *
 * 用途：面板、orlife doctor、测试都需要触达运行时；而 cordis 上下文对自定义属性只读，
 * 挂 ctx.forlife 会失败（实测），所以用模块级登记表 —— 同一个库文件不会被重复打开。
 *
 * @returns 运行时数组（按注册顺序）。
 */
export function activeRuntimes(): readonly MemoryRuntime[] {
  return [...runtimeRegistry.values()]
}

/** 按数据库路径取运行时。 */
/** 等待运行时就绪的回调（主插件与面板插件谁先 apply 不保证，用它对齐顺序）。 */
const runtimeWaiters: ((runtime: MemoryRuntime) => void)[] = []

/**
 * 在记忆运行时就绪时回调（已就绪则同步立即回调）。
 *
 * @param callback - 收到运行时的回调。
 * @returns 取消等待的函数。
 */
export function whenRuntimeReady(callback: (runtime: MemoryRuntime) => void): () => void {
  const existing = activeRuntimes()[0]
  if (existing !== undefined) {
    callback(existing)
    return () => {}
  }
  runtimeWaiters.push(callback)
  return () => {
    const index = runtimeWaiters.indexOf(callback)
    if (index >= 0) runtimeWaiters.splice(index, 1)
  }
}

export function runtimeFor(dbPath: string): MemoryRuntime | undefined {
  return runtimeRegistry.get(dbPath)
}

/**
 * 唤醒工具的宿主能力。
 *
 * `wake_now` **不直接调引擎** —— 工具跑在插件进程、引擎跑在 gateway 进程，
 * 两者不能直接调函数。通道是**它们已经在共享的那个数据库**：
 * 把 `next_fire_at` 设成"现在"，gateway 的下一次 tick（≤1 秒）就会扫到它。
 * **不需要第二条通信路径** —— 多一条就多一处会不一致的地方。
 */
function wakeToolHost(runtime: MemoryRuntime): WakeToolHost {
  return {
    fireNow: async (triggerId) => {
      const row = getWakeTrigger(runtime.db, triggerId)
      if (row === undefined) return { decision: "failed", reason: `没有这条唤醒：${triggerId}` }
      if (row.enabled !== 1) return { decision: "failed", reason: "这条唤醒已停用，先启用它" }
      // 设成"现在" ⇒ 下一次 tick 就会扫到（对**所有类型**都有效，不只 timer）
      updateWakeTrigger(runtime.db, triggerId, { nextFireAt: new Date().toISOString() })
      return { decision: "fired", reason: "已请求立刻执行（gateway 侧下一次 tick 处理，≤1 秒）" }
    },
    // **登记监视程序**：写一条 wake_programs 行（含**登记时**算出的脚本指纹），
    // gateway 的运行层 tick 会捡起来跑。
    // 指纹在**登记这一刻**算 —— 那是"认可的是哪一版"的唯一凭据。
    registerProgram: (input) => {
      const root = process.env.FORLIFE_WORKSPACE_ROOT
      if (root === undefined || root === "") {
        return { ok: false, reason: "未配置 FORLIFE_WORKSPACE_ROOT，无法登记监视程序（路径没有沙箱根可比）" }
      }

      const resolved = resolveInWorkspace(root, input.path)
      if (!resolved.ok) return { ok: false, reason: `路径不合法：${resolved.reason}` }

      let sha256: string
      try {
        sha256 = createHash("sha256").update(readFileSync(resolved.absolutePath)).digest("hex")
      } catch (error) {
        // 登记一个不存在的路径，会在第一次 tick 时才失败 ——
        // 而那时模型已经以为"监视在跑了"
        return { ok: false, reason: `读不到脚本（${input.path}）：${String(error).slice(0, 120)}` }
      }

      const now = new Date().toISOString()
      const id = `wp_${randomUUID()}`
      try {
        runtime.db
          .prepare(
            `INSERT INTO wake_programs (id, name, contract, path, sha256, enabled, status, restart_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 'stopped', 0, ?, ?)`,
          )
          .run(id, input.name, input.contract, input.path, sha256, now, now)
      } catch (error) {
        // 重名（name 上有 UNIQUE）会走到这里 —— 说清楚，而不是笼统的"失败了"
        const message = String(error)
        if (/UNIQUE|constraint/i.test(message)) {
          return { ok: false, reason: `已经有一个叫「${input.name}」的监视程序（名字要唯一）` }
        }
        return { ok: false, reason: `登记失败：${message.slice(0, 160)}` }
      }
      return { ok: true, reason: `已登记（指纹 ${sha256.slice(0, 12)}…）` }
    },
  }
}

/**
 * 挂上唤醒桥端点（**缺任何一样就不挂**）。
 *
 * 为什么 fail-closed：这个端点的作用是"叫醒模型并让它执行一段提示词"，
 * 而 `ctx.webServer` 自身无 TLS、无认证 —— 没有密钥校验的话，
 * 它是**本机任何进程都能利用的提权入口**。
 *
 * 缺服务时挂上去也没用（只会让 gateway 收到一堆 500，
 * 而那看起来像"桥不通"，排查方向会完全错），所以**明确不挂 + 说清缺什么**。
 */
function registerWakeBridge(
  ctx: ContextLike,
  disposers: (() => void | Promise<void>)[],
  log: (message: string) => void,
): void {
  const secret = process.env.FORLIFE_WAKE_BRIDGE_SECRET
  if (secret === undefined || secret.trim() === '') {
    log('⚠️ 未配置 FORLIFE_WAKE_BRIDGE_SECRET：唤醒桥端点未挂载（没有密钥的唤醒端点 = 本机提权入口）。')
    return
  }

  // ★ **必须用 inject 延迟获取，不能用 ctx.get()**
  //
  // 实测（2026-10-06 真机）：`ctx.get('webServer')` 在 forlife-web profile 里
  // 返回 `undefined` ⇒ 端点从未挂载 ⇒ gateway 发唤醒得到 **HTTP 405**。
  //
  // 原因是 `ctx.get()` **只能拿到"已经加载好"的服务**，而 webServer
  // 在插件 `apply()` 执行时还没就绪。本文件头部早就写着这条策略：
  // 「核心服务用 inject 等待；**可选服务用 ctx.inject([...], cb) 延迟获取**」。
  //
  // 这个坑很隐蔽：fail-closed 的实现在日志里只留一行警告，
  // 而那一行是**中文**的 —— 在本机（GBK 控制台 + UTF-8 日志）会变成乱码，
  // 中文 grep 一条都匹配不上。我因此连续两轮以为"日志没出现"。
  if (ctx.inject === undefined) {
    log('⚠️ 宿主没有 ctx.inject：唤醒桥端点未挂载（无法延迟获取 webServer）。')
    return
  }
  ctx.inject(['webServer', 'sessionController', 'sessions', 'agents'], (ready) => {
    mountWakeEndpoint(ready, secret, disposers, log)
  })

  // ★★ 2026-10-10（D7 / 用户裁定 D-B）：**并行**再起一条我们自己的监听。
  //
  //   为什么必须有它：DSH 的 webServer **只绑回环** ⇒ 同网络的 gateway 够不到
  //   （面板那张卡一直显示"未配置/连接超时"的根因）。DSH 硬禁 `--host 0.0.0.0`
  //   （理由是 /api 暴露 = RCE），**那是它的边界，该尊重** ⇒ 我们自己起一个。
  //
  //   ⚠️ **不是降级**：上面那条继续服务 DSH 自己的 UI 面板，两条互不影响。
  //   ⚠️ 端口来自环境变量（与 secret 同一套 fail-closed 风格）——
  //      **不在代码里写 magic number**，没配就明确说没起、而不是偷偷用一个默认口。
  const port = Number(process.env.FORLIFE_WAKE_BRIDGE_PORT ?? '')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    log(
      '⚠️ 未配置 FORLIFE_WAKE_BRIDGE_PORT（或不是合法端口）：唤醒桥**自建监听**未起' +
        '（gateway 仍够不到 DSH 的回环 webServer ⇒ 面板会显示"DSH 后端未配置/连接超时"）。',
    )
    return
  }
  ctx.inject(['sessionController', 'sessions', 'agents'], (ready) => {
    mountOwnWakeHost(ready, secret, port, disposers, log)
  })
}

/**
 * 真正挂载端点（在 `inject` 回调里跑 —— 那时服务才就绪）。
 *
 * 从 `registerWakeBridge` 拆出来是因为 `inject` 是**回调式**的：
 * 挂载必须发生在回调里，而不是 `apply()` 的同步流程里。
 */
function mountWakeEndpoint(
  ctx: ContextLike,
  secret: string,
  disposers: (() => void | Promise<void>)[],
  log: (message: string) => void,
): void {
  const webServer = ctx.get('webServer') as
    | { register(route: unknown): () => void }
    | undefined
  if (webServer === undefined) {
    log('⚠️ 未找到 webServer 服务：唤醒桥端点未挂载（gateway 无法唤醒模型）。')
    return
  }

  const host = wakeHostOf(ctx, log)
  if (host === undefined) return

  const dispose = registerWakeEndpoint(webServer as never, { secret, log, host })
  disposers.push(dispose)
  log(
    `✅ 唤醒桥端点已挂载（DSH webServer / **只绑回环**）：${process.env.FORLIFE_WAKE_BRIDGE_PATH ?? '/forlife/wake'}`,
  )
}

/**
 * ★★ 2026-10-10（`FIX_PLAN.md` D7，用户裁定 **D-B**）：起**我们自己的**监听。
 *
 * ## 为什么另起一条，而不是"修好 webServer 那条"
 *
 * DSH 的 `webServer` **只绑回环** —— 它的作者在代码里硬禁了 `--host 0.0.0.0`
 * （理由：`/api` 被网络上任何东西碰到 = 交出 RCE）。**那是 DSH 的边界，该尊重。**
 * 于是同在一个 docker 网络里的 gateway **也够不到它**。
 *
 * ⇒ 所以这一条**与 webServer 那条并行**、互不影响：
 *   webServer 继续服务 DSH 自己的 UI 面板（回环），这条只服务 gateway 的唤醒（容器网卡）。
 *   ⚠️ **不是 if/else 降级** —— 上面那条的失败分支（没 webServer / 缺服务）**一句没改**。
 */
function mountOwnWakeHost(
  ctx: ContextLike,
  secret: string,
  port: number,
  disposers: (() => void | Promise<void>)[],
  log: (message: string) => void,
): void {
  // 与 webServer 那条**共用同一份宿主适配**（`wakeHostOf`）—— 绝不复制粘贴，那会漂移
  const host = wakeHostOf(ctx, log)
  if (host === undefined) return

  const own = startWakeHost({ port, log })
  disposers.push(() => own.close())
  // 鉴权/幂等/唤醒逻辑全在 `registerWakeEndpoint` 里 —— **这里没有第二套**
  disposers.push(registerWakeEndpoint(own, { secret, log, host }))
}

/**
 * 解析唤醒要用的宿主能力。
 *
 * **两条路共用这一份**（webServer 与自建监听）—— 复制粘贴会让两边的
 * `createMessage` / `withoutInitiator` 适配漂移，而漂移的那一套就是
 * "唤醒发不出去"或"归因到错误的人"的根源。
 */
function wakeHostOf(ctx: ContextLike, log: (message: string) => void): WakeHost | undefined {
  const sessionController = ctx.get('sessionController') as
    | { resolveAgent(sessionId: string): Promise<unknown> }
    | undefined
  const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<boolean> } | undefined
  const agents = ctx.get('agents') as { withoutInitiator<T>(fn: () => Promise<T>): Promise<T> } | undefined
  const missing = [
    ...(sessionController === undefined ? ['sessionController'] : []),
    ...(sessions === undefined ? ['sessions'] : []),
    ...(agents === undefined ? ['agents'] : []),
  ]
  if (missing.length > 0) {
    log(`⚠️ 缺少服务 ${missing.join('、')}：唤醒桥端点未挂载（挂上去也只会让 gateway 收到一堆 500）。`)
    return undefined
  }

  return {
    // 冷会话会被 resume —— 这是"给一个很久没说话的会话安排唤醒"能工作的前提
    resolveAgent: async (sessionId: string) => {
      const resolved = (await sessionController!.resolveAgent(sessionId)) as
        | { agent?: { status?: string; followup?: (m: unknown) => void; session?: unknown } }
        | undefined
      const agent = resolved?.agent
      if (agent === undefined || typeof agent.followup !== 'function') return undefined
      return {
        agent: {
          status: String(agent.status ?? 'idle'),
          followup: agent.followup.bind(agent),
          session: agent.session,
        },
      }
    },
    flush: (session: unknown) => sessions!.flush(session),
    // **构造一条"不是用户发的"消息** —— sourceKind 由调用方给（wake-timer 等）。
    // 绝不用 sessionController.prompt()：它把 source 硬编码成 {kind:'user'}。
    createMessage: (input: { readonly text: string; readonly sourceKind: string; readonly summary: string }) => ({
      text: input.text,
      source: { kind: input.sourceKind, summary: input.summary },
    }),
    withoutInitiator: (fn) => agents!.withoutInitiator(fn),
  }
}

/** 会话事件信封的最小形状：**载荷在 `data` 里**（宿主 `Session.append` 造的是 `{type, seq, time, data}`）。 */
interface SessionEventEnvelope {
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * 从一次模型调用的 `usage` 里算"当时短期上下文有多少 token"。
 *
 * 口径与宿主 `dsh-token-meter` 的 `totalTokens`（"request-and-response pressure"）一致：
 * **整通调用**的 token 数 —— 也就是下一次请求要背的上下文大小。
 *
 * `TokenUsage` 的四类计数是**互不重叠**的（已在 `@deepseek-ai/dsh-llm` 的类型注释里核实：
 * `inputTokens` 只是**未命中缓存的**输入，计费输入 = input + cacheRead + cacheWrite），
 * 所以直接相加即可；`totalTokens`（provider 报的整通总量）存在时优先用它。
 *
 * @param usage - 事件里的 `usage` 字段（形状不认识就返回 `undefined`）。
 * @returns token 数；拿不到就返回 `undefined`（**绝不编一个数出来**）。
 */
export function shortTokensFromUsage(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
  const total = num(record['totalTokens'])
  if (total !== undefined) return total
  const parts = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map((key) => num(record[key]))
  if (parts.every((part) => part === undefined)) return undefined
  const sum = parts.reduce<number>((acc, part) => acc + (part ?? 0), 0)
  return sum > 0 ? sum : undefined
}

/** `registerTurnAccounting` 的选项（与 `registerLoopGuard` 同形）。 */
export interface TurnAccountingOptions {
  readonly log: (message: string) => void
  /** `⚠️` 级别（拿不到钩子这类**必须让人看见**的事）。 */
  readonly always: (message: string) => void
  /** 反注册器收集处（`apply()` 里的那个数组）。 */
  readonly disposers: (() => void)[]
}

/**
 * 把**轮次记账**接到真实的会话生命周期上（本轮修的 A + B 两条都靠它）。
 *
 * ## 为什么必须有这一层
 *
 * `MemoryRuntime.beginTurn()` 与 `observeShortTokens()` 以前**只被测试调用**，
 * 生产路径上零调用 ⇒
 *  - `acct_short_tokens` 恒为 0、`acct_turns_since_compaction` 恒为 0
 *    ⇒ `decideCompaction` 一律 `too_thin` ⇒ **PLAN §4.4 的"模型自主压缩"不可用**；
 *  - `recallThisTurn` 永不归零 ⇒ 累计 2 次 `recall_longterm` 之后**永久失效**
 *    （跑一会儿之后模型再也想不起长期记忆）。
 *
 * ## 接在哪两个点上（宿主 `agent-loop` 的权威事件）
 *
 * 宿主的 `agent-loop` 在每一轮开始时 `session.append('turn/start')`、
 * 结束时 `session.append('turn/end')`，两者都会通过 `session/event` 发出来 ——
 * 而这条订阅**本项目早就在用**（缓存采集）。所以**不新增钩子**：
 *  - `turn/start` ⇒ `beginTurn()`（重置每轮额度 + 推进"自上次压缩以来的轮次"）；
 *  - `turn/end` ⇒ `observeShortTokens(n)`，`n` 取**真实读数**：
 *    ① 宿主 `tokenMeter.measure(session).totalTokens`（权威计量，拿不到就跳过）；
 *    ② 退化到本轮最后一条 `assistant/message` 的 `usage`（provider 报的账）。
 *
 * **拿不到真实读数时宁可不写**：写 0 会让 `decideCompaction` 判 `too_thin`，
 * 那正是我们要修的病（"没有数据"和"上下文是空的"是两回事）。
 *
 * 三条纪律：**绝不抛异常**（这个 handler 跑在每一次会话事件上）、
 * **拿不到钩子要明说**（静默的话"在跑"和"没挂上"从日志上看一模一样）、
 * **必须能反注册**（否则热重载会重复挂载 ⇒ 每轮被记两次）。
 *
 * @param ctx - 宿主上下文。
 * @param runtime - 记忆运行时。
 * @param options - 日志与反注册器收集处。
 * @returns 是否挂上（测试要看）。
 */
export function registerTurnAccounting(
  ctx: ContextLike,
  runtime: MemoryRuntime,
  options: TurnAccountingOptions,
): boolean {
  const contextOn = ctx as unknown as {
    on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined
  }
  if (typeof contextOn.on !== 'function') {
    options.always(
      '⚠️ 宿主没有 ctx.on ⇒ **轮次记账未挂载**：模型自主压缩会被判 too_thin、recall 每轮额度不会重置（记忆本体不受影响）',
    )
    return false
  }

  /** 最近一次 provider 报的真实用量（轮末读数的退化来源）。 */
  let lastUsageTokens: number | undefined
  /** 已写读数轮数（只在第一轮报一次日志，避免每轮刷屏）。 */
  let observedTurns = 0

  /**
   * ★★ 投喂的**轮次钩子**（用户 2026-10-10：「以单个轮次为界，每一个轮次结束就传输下一批次」）。
   *
   * 它把投喂那条链串成闭环：`turn/start` 排产 + 写"本轮范围" + 收窄工具；
   * `turn/end` 按**实际喂进去的段数**推进游标 + 解除掩码 + 喂完收尾（醒来）。
   *
   * `tools` 从这里取（`ctx.get('tools')`）：拿不到就**不收窄**，
   * 而钩子内部会如实记一行 —— 不假装"限制住了"。
   */
  const feedTurn = createFeedTurnHook({
    db: runtime.db,
    tools: ctx.get('tools') as ToolRestrictHost | undefined,
    log: options.log,
  })

  /** 用宿主 tokenMeter 量当前短期压力（拿不到就 `undefined` —— 绝不用估算值冒充真实读数）。 */
  const measureShortTokens = (session: unknown): number | undefined => {
    const meter = ctx.get('tokenMeter') as { measure?: (subject: unknown) => unknown } | undefined
    if (meter === undefined || typeof meter.measure !== 'function') return undefined
    try {
      const measurement = meter.measure(session) as { readonly totalTokens?: unknown } | undefined
      const total = measurement?.totalTokens
      return typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.trunc(total) : undefined
    } catch (error) {
      options.log(`tokenMeter 测量失败（已忽略，改用 usage 退化）：${String(error).slice(0, 160)}`)
      return undefined
    }
  }

  try {
    const dispose = contextOn.on('session/event', (...args: unknown[]) => {
      // ★ **绝不抛异常** —— 这个 handler 跑在**每一次会话事件**上
      try {
        const session = args[0]
        const envelope = args[1] as SessionEventEnvelope | undefined
        const type = typeof envelope?.type === 'string' ? envelope.type : undefined
        if (type === undefined) return
        const data = (
          typeof envelope?.data === 'object' && envelope.data !== null ? envelope.data : {}
        ) as Record<string, unknown>

        // ① 轮次开始 ⇒ 重置"每轮"额度 + 推进"自上次压缩以来的轮次"（PLAN §4.4 记账）
        if (type === 'turn/start') {
          runtime.beginTurn()
          // ★ 投喂轮次的开始（不是投喂轮就什么都不做，但会顺手解除遗留的掩码）
          const turn = feedTurn.onTurnStart()
          if (turn.active) {
            options.log(
              `投喂轮次：${turn.note}｜本轮读 ${String(turn.segments.length)} 段` +
                `（${turn.segments.map((s) => s.path).join('、')}）`,
            )
          }
          return
        }

        // ② 记下 provider 报的真实用量（轮末读数的退化来源）
        if (type === 'assistant/message') {
          const tokens = shortTokensFromUsage(data['usage'])
          if (tokens !== undefined) lastUsageTokens = tokens
          return
        }

        // ③ 轮次结束 ⇒ 写真实短期读数
        if (type === 'turn/end') {
          // ★★ 投喂的轮末收尾**必须最先做**，而且**绝不能**被下面那条 early return 跳过。
          //
          //   下面在"拿不到 token 读数"时会 `return` —— 若把投喂收尾放在它之后，
          //   "读数拿不到"就会连带让**掩码永远留着**，而那是
          //   "她的正常对话从此发不出 QQ 消息、且没人会发现"的那条故障。
          //
          //   `consumeFedSegments()` 是**取走**（清零）：轮末推进游标必须只发生一次，
          //   两条路径各读一次会让游标**跳段**。
          feedTurn.onTurnEnd({ fedCount: runtime.consumeFedSegments() })
          const tokens = measureShortTokens(session) ?? lastUsageTokens
          if (tokens === undefined) {
            options.log('轮次结束但拿不到短期 token 真实读数（tokenMeter 与 usage 都没有）—— 保留上次读数')
            return
          }
          runtime.observeShortTokens(tokens)
          observedTurns += 1
          if (observedTurns === 1) {
            // **用 `always`（不是 verbose 才打的 log）**：这是"记账真的活了"的唯一凭据 ——
            // 而它以前是死的（模型自主压缩因此永久被拒）。一次进程只打一行，不吵。
            options.always(
              `✅ 轮次记账已生效：第 1 轮写入真实短期读数 ${String(tokens)} token（此后每轮结束时更新，压缩裁决不再恒判 too_thin）`,
            )
          }
        }
      } catch (error) {
        options.log(`轮次记账单事件处理失败（已忽略）：${String(error).slice(0, 160)}`)
      }
    })
    if (typeof dispose === 'function') options.disposers.push(dispose)
    options.log('已订阅会话事件：轮次记账（turn/start ⇒ beginTurn；turn/end ⇒ observeShortTokens 真实读数）')
    return true
  } catch (error) {
    options.always(`⚠️ 无法订阅会话事件（轮次记账不可用：模型自主压缩会被判 too_thin）：${String(error)}`)
    return false
  }
}

export function apply(ctx: ContextLike, rawConfig: Partial<ForlifeConfig> = {}): void {
  // volatile 字段在解析结果里是引用对象，必须先取快照再当纯数据用
  const config = resolveConfig(rawConfig)
  const log = (message: string): void => {
    if (config.verbose) console.log(`[forlife] ${message}`)
  }
  const always = (message: string): void => console.log(`[forlife] ${message}`)

  // ① 打开记忆库
  const dshHome = resolveDshHome()
  const dbPath = resolveDbPath(config, dshHome)
  let runtime: MemoryRuntime
  try {
    runtime = new MemoryRuntime({ config, dbPath, log })
  } catch (error) {
    // 存储起不来是**系统性故障**（§2.17.6 的"我方系统故障"）：要显式喊出来，不能静默
    always(`❌ 记忆库打开失败：${String(error)}（路径 ${dbPath}）`)
    always('   插件以禁用状态继续加载；记忆相关工具与提示段均未注册。')
    return
  }
  const summary = contractsSummary()
  always(
    `记忆库就绪：${dbPath}｜契约基线 v${summary.baselineVersion}（参数 ${String(summary.paramCount)}，doc ${String(summary.docCount)}）`,
  )
  if (runtime.appliedMigrations().length > 0) {
    always(`已应用迁移：${runtime.appliedMigrations().map((v) => `v${String(v)}`).join(', ')}`)
  }

  // ①b 启动回滚（PLAN §15）：**开库之后、注册任何工具之前**。
  //
  // 上一次进程如果在"压缩事务动手到一半"时死掉，库里会残留 `phase='started'` 的运行
  // （可能已经推进过 epoch、写过中期条目）。不在启动时回滚到上一个完整 epoch 的话，
  // 模型会在一个**半写**的库上做决策 —— 而面板一直在提示这件事
  // （`admin/queries-memory.ts` 的"启动回滚还没跑成功"），只是**从来没有人真的调过它**。
  //
  // 它放在这里而不是 `openDatabase()` 里的理由：回滚是**带业务语义**的动作
  // （要按 epoch 逐条撤销），存储层不该替调用方决定什么时候做。
  try {
    const recovered = recoverPendingCompactions(runtime.db)
    if (recovered.length === 0) {
      log('启动回滚：没有未完成的压缩事务（库是完整的）')
    } else {
      always(`⚠️ 启动回滚：${String(recovered.length)} 个未完成的压缩事务已回滚到上一个完整 epoch`)
      for (const rolled of recovered) {
        log(
          `  · ${rolled.runId}：删中期 ${String(rolled.deletedMidEntries)} 条、恢复碎片 ${String(rolled.restoredFragments)} 个、` +
            `删长期 ${String(rolled.deletedLongEntries)} 条、epoch 回到 ${String(rolled.epochRestoredTo)}`,
        )
      }
    }
  } catch (error) {
    // 回滚失败意味着"库里可能还有半写的条目"——这是**系统性故障**，必须显式喊出来。
    // 但**不阻止插件加载**：记忆的读写仍然有价值，静默降级比直接不加载好。
    always(`❌ 启动回滚失败：${String(error)}（库里可能残留半写的压缩事务）`)
  }

  runtimeRegistry.set(dbPath, runtime)
  for (const waiter of runtimeWaiters.splice(0)) waiter(runtime)
  const disposers: (() => void | Promise<void>)[] = []

  // ② 提示段（L2 + L3）
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (config.registerPromptSections && systemPrompt !== undefined) {
    // 先播种默认提示词（幂等），再注册段：这样首次启动看到的不是空白框，而是真正生效的内容
    const seeded = seedDefaultPrompts(runtime.db)
    // 档位映射也要播种：路由表是"档位 → 具体模型"的唯一真源，空表等于降级链没有候选
    const defaultRoute = runtime.defaultRouteModel()
    const seededRoutes = seedDefaultRoutes(runtime.db, { provider: defaultRoute.provider, model: defaultRoute.model })
    if (seededRoutes.seeded) log(`已播种档位映射：${seededRoutes.reason}`)
    else log(`档位映射未改动：${seededRoutes.reason}`)

    // ★★ 2026-10-08 真机实测（**第 15 处缺陷**）：**面板里的路由表永远是旧的**。
    //
    //   现象：在面板「路由」页看到的 L1/L2/L3/minimum **全是 `deepseek-official`**，
    //   而我们实际用的是 `opencode-go`。
    //
    //   根因：路由表的**唯一真源是库里的 `model_routes` 表**（不是 profile）。
    //   而两个播种函数的接线状态完全不同：
    //     - `seedDefaultRoutes()`      ⇐ **这里真的调了** ⇒ 库里落下内置默认
    //     - `seedOpenCodeGoRoutes()`   ⇐ **生产路径零调用**（只有测试调）
    //   ⇒ 于是库里**永远停在内置种子**，`opencode-go` 那个接入点从来没被播种过。
    //
    //   ★ 这是本项目**第 8 次**踩到同一个模式：
    //     **库代码写好了、单元测试过了、生产路径上零调用。**
    //
    //   修法：**有 key 就以 opencode-go 为准**（用 `replace: true`）。
    //   它只删 `updated_by = 'system'` 的行 —— **手工在面板配的一律保留**，
    //   那才是人的意图（与该函数自己的文档一致）。
    const goKeyRef = 'FORLIFE_OPENCODE_GO_KEY'
    if ((process.env[goKeyRef] ?? '') !== '') {
      const goSeeded = seedOpenCodeGoRoutes(runtime.db, { replace: true, apiKeyRef: goKeyRef })
      if (goSeeded.seeded) log(`已切换档位映射到 opencode-go：${goSeeded.reason}`)
      else log(`档位映射未切到 opencode-go：${goSeeded.reason}`)
    } else {
      log('档位映射保持内置默认：没有设 ' + goKeyRef + '（设了才会切到 opencode-go）')
    }

      // ★ 用户 2026-10-08 要求：**给 L2/L3/scorer 补上 DS 官方的兜底**（跨 provider）。
      //   单独一个函数而不是塞进 planOpenCodeGoRoutes —— 那个是 opencode-go 的计划，
      //   往里塞别的 provider 会让名字与内容不符。
      //   没有 DEEPSEEK_API_KEY 时它**不播种**（播了也是死候选）。
      const dsFallback = seedDeepSeekFallback(runtime.db)
      if (dsFallback.seeded) log(`已追加 DS 官方兜底：${dsFallback.reason}`)
      else log(`DS 官方兜底未追加：${dsFallback.reason}`)

      // ★★ 2026-10-08 中介层的**探针**（只读）：宿主 LLM 服务能枚举出什么、当前默认模型是什么。
      //   **为什么先探**：`listProviders()` / `saveSelection()` 是从宿主 `.d.ts` 读出来的签名，
      //   **签名对不等于运行期拿得到**（服务名可能不同、可能没加载）。
      //   ⇒ 拿得到才写正式的中介层，否则又是「照文档写完发现接口对不上」。
      //   它**只读**（不调 saveSelection）—— 改模型是正式代码的事。
      //   失败**不影响插件加载**：探针内部全部 try/catch。
      void probeLlm(ctx as never).then((report) => {
        always('[forlife] LLM 探针：' + report.summary)
        if (report.providers !== undefined) {
          for (const p of report.providers) {
            const n = p.models?.length ?? 0
            log('  provider ' + p.id + (p.label === undefined ? '' : '（' + p.label + '）') + '：' + String(n) + ' 个模型' + (p.modelsError === undefined ? '' : '  ⚠️ ' + p.modelsError))
          }
        }
        if (report.providersError !== undefined) always('[forlife] 探针：provider 枚举失败 —— ' + report.providersError)
        if (report.currentSelectionError !== undefined) always('[forlife] 探针：' + report.currentSelectionError)
      }).catch((error: unknown) => {
        always('[forlife] LLM 探针异常（不影响插件）: ' + String(error).slice(0, 160))

      })

        // ★★ 2026-10-08 中介层的**取数层**：从宿主 llm 拿 provider/model ⇒ 整理成决策表。
        //   这一步**只读**（不改模型）—— 先把“看得见什么”落到日志里，
        //   下一步的初始路由才有东西可选。
        //   失败**不影响插件加载**（取数层内部全部 try/catch）。
        void fetchHostCatalog(ctx as never).then((result) => {
          if (result.unavailableReason !== undefined) {
            always('[forlife] 模型目录取不到：' + result.unavailableReason)
            return
          }
          always('[forlife] 模型目录：' + result.catalog.summary)
          for (const p of result.providers) {
            const tail = p.error === undefined ? '' : '  ⚠️ ' + p.error
            log('  ' + p.id + '：' + String(p.models.length) + ' 个模型' + tail)
          }
          for (const e of result.catalog.entries) {
            const marks = e.marks.length === 0 ? '' : ' [' + e.marks.join('/') + ']'
            log('    ' + (e.reachable ? '✅' : '❌') + ' ' + e.provider + '/' + e.model + marks + ' ' + e.name + (e.description === undefined ? '' : ' — ' + e.description))
          }
        }).catch((error: unknown) => {
          always('[forlife] 模型目录取数异常（不影响插件）: ' + String(error).slice(0, 160))
        })
    if (seeded.length > 0) always(`已播种内置提示词：${seeded.join(', ')}`)
    disposers.push(registerPromptSections(systemPrompt, runtime, config.promptVariables))
    // ★ 「你的主动性」段（2026-10-09 用户要求）：主动发消息 / 提问题 / 唤醒自己的能力与边界。
    //   **必须在这里注册**（而不是只导出函数）：本仓栽过 20+ 次"库写好了、测试全绿、
    //   生产路径零调用"，所以这条注册由 wiring.test.ts（按 apply 的真实注册表断言）
    //   与 proactivity-wiring.test.ts（真宿主字节级）两处守着。
    disposers.push(registerProactivitySection(systemPrompt))
    disposers.push(registerMemorySections(systemPrompt, runtime))

    // ★★ 2026-10-08 中介层第 ③' 块：**把路由接进调用链**。
    //   订阅 host 的 agent/created · agent/pre-step · agent/turn-stopping。
    //   ★ 默认 **off**：不能让一个没验证过的接线在用户不知情时开始改模型。
    //   先跑 `FORLIFE_ROUTER_MODE=observe`（**只打日志不改**）确认钩子真的响、载荷对得上，再开 `apply`。
    const modelRouter = installModelRouter(ctx as never, { log: always })
    disposers.push(() => { modelRouter.dispose() })
    if (modelRouter.mode === 'off') {
      log('模型路由：未启用（设 FORLIFE_ROUTER_MODE=observe 可先观察）')
    }
    // ⚠️ 这份清单必须与 `prompt.ts` 里真正注册的段**一一对应**（它出现在启动日志里，
    //    少写一个就是日志撒谎 —— 而"日志说法与实际不符"正是这个项目最贵的一类问题）。
    log(
      '已注册提示段 forlife:p1-system(100) / forlife:p2-style(110) / forlife:proactivity(115) / ' +
        'forlife:l2-index(120) / forlife:l3-mid(130) / forlife:feed-mode(140，只在投喂期非空)',
    )
  } else if (config.registerPromptSections) {
    always('⚠️ 未找到 systemPrompt 服务：记忆区不会进入系统提示词（只写库不生效）。')
  }

  // ③ 工具
  const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
  if (config.registerTools && tools !== undefined) {
      // ★★ 2026-10-07 真机部署发现：这里原来**没有收集器** ——
      //   末尾那行"已注册工具 …"是**硬编码字符串**，不管实际注册了什么。
      //   ⇒ 加了工具它也不变（代码到 13 个时它还说 11 个），
      //     而我们**拿它当"生产里注册了什么"的证据** ⇒ 差点得出错误结论。
      //   ⇒ **一个会说谎的证据源比没有证据更危险。**
      const registeredNames: string[] = []
      /** 注册一个定义，并**记下它的名字**（日志要用真实数据，不能写死）。 */
      const registerOne = (definition: unknown): void => {
        const dispose = tools.register(definition as never)
        disposers.push(dispose)
        const name = (definition as { name?: unknown }).name
        if (typeof name === 'string') registeredNames.push(name)
      }
    if (defineToolImpl === undefined) {
      always('⚠️ 未找到 @deepseek-ai/dsh-tools 的 defineTool：记忆工具未注册（记忆仍在写入，但模型看不到工具）。')
    } else {
      for (const definition of buildMemoryTools(defineToolImpl, runtime)) {
        registerOne(definition)
      }
      // 时间工具（阶段 4）：`now()` 是"主动看时间"的唯一实现方式（§2.15.1 根因 4）
      for (const definition of buildClockTools(defineToolImpl, runtime)) {
        registerOne(definition)
      }
      // 路由工具（阶段 5 §2.18）：switch_model / revert_model / router_status。
      // **主代理才有** —— 子代理连工具都拿不到（第一道防线）
      for (const definition of buildRouterTools(defineToolImpl, runtime)) {
        registerOne(definition)
      }

  // 端口出口工具（PLAN 阶段 7）。**未配置 Caddy 时返回空数组** ——
  // 注册了只会让模型调用一个注定失败的工具，而它会把这个失败当成"我操作错了"，反复重试。
  for (const definition of buildPortTools(defineToolImpl, runtime, portToolOptionsFromEnv(process.env))) {
    registerOne(definition)
  }

      // 唤醒工具（PLAN 阶段 8）。**总是注册** —— 它们只写数据库，不需要外部配置就能成功；
      // "安排一个唤醒"在 gateway 侧引擎起来之前也是有效的，只是暂时不会响。
      // （对比端口工具：没有 Caddy 时注定失败，所以那种才"没配就不注册"。）
      for (const definition of buildWakeTools(defineToolImpl, runtime, wakeToolHost(runtime))) {
        registerOne(definition)
      }

      // ★ QQ 工具（PLAN §8.1）。**总是注册** —— 与唤醒工具同理：
      // 它们只写数据库（`qq_outbox` / `qq_sessions`），不需要外部配置就能成功；
      // gateway 没起来时消息只是**排在队列里**（不会丢，也不会假装送达）。
      //
      // ⚠️ **这一行曾经漏了** —— `buildQqTools` 写好了、测试全绿，
      // 而**生产路径上零调用** ⇒ `qq_reply` 等 9 个工具在生产里不存在 ⇒
      // **模型无法回复任何 QQ 消息**。
      //
      // **为什么测试没抓到**：测试**直接调 `buildQqTools`**（绕过注册这一步）；
      // 而验收① 验的是**唤醒**（`buildWakeTools` 注册了，所以那条链路真的通）。
      // ⇒ 典型的「接线断了但测试全绿」。
      // 守卫见 `test/qq-tools-wiring.test.ts`。
      for (const definition of buildQqTools(defineToolImpl, runtime)) {
        registerOne(definition)
      }

      // 手动喂食记忆资料（用户 2026-10-07 要求）。**总是注册** —— 与唤醒/QQ 工具同理：
      // 它只写数据库，不需要任何外部配置就能成功；"由模型自己决定记成知识还是经历"
      // 正是这个工具存在的理由（没有它，模型只能等人来喂）。
      //
      // ⚠️ 必须走 `registerOne`（不是直接 `tools.register`）：`registeredNames` 是
      // 生产日志里"到底注册了哪些工具"的**唯一**证据源 —— 绕过它，日志里的工具数就会说谎
      // （本仓为此栽过一次：日志自称 11 个，实际 13 个）。
      for (const definition of buildFeedTools(defineToolImpl, runtime)) {
        registerOne(definition)
      }

      // 唤醒桥端点（PLAN 阶段 8）。**缺任何一样就不挂** ——
      // 这个端点的作用是"叫醒模型并让它执行一段提示词"，
      // 而 ctx.webServer 自身无 TLS、无认证：没有密钥校验的话，
      // 它是**本机任何进程都能利用的提权入口**。
      registerWakeBridge(ctx, disposers, always)

      // 压缩事务失败 ⇒ **直接写库**（数据库即通道）。
      //
      // 为什么不能调 gateway 的 systemHooks：压缩发生在**插件进程**，
      // 而 systemHooks 在 **gateway 进程** —— 两者不能直接调函数。
      // 通道是它们共享的那个数据库：把匹配的 system 触发器标记为"到点"，
      // gateway 的下一次 tick（≤1 秒）就会扫到。与 wake_now 走的是同一条路。
      onCompactionFailure((detail) => {
        try {
          const marked = markSystemTriggersDue(runtime.db, 'compaction.failed')
          if (marked.triggered.length > 0) {
            always(`压缩失败已触发 ${String(marked.triggered.length)} 条唤醒：${detail.slice(0, 120)}`)
          }
        } catch (error) {
          // **观察者不能带崩压缩流程** —— 回滚已经做完了，那比上报重要
          always(`压缩失败上报失败（已忽略）：${String(error).slice(0, 160)}`)
        }
      })
      log(`已注册工具（${String(registeredNames.length)} 个）：${registeredNames.join(' / ')}`)
    }
  }

  // ③b 缓存用量采集（阶段 4 交付物 6）
  //
  // 数据来源是宿主的 `assistant/message` 事件（带 `usage`）。
  // 用 ctx.on 订阅会话事件 —— 这是第一方插件普遍的做法（已核实 dsh-token-meter 等）。
  // 采集失败**不能让插件挂掉**：拿不到用量只是少了个指标，不该影响记忆本体。
  // 工具调用侧的检测器（**独立于文字侧** —— 见 tool-loop-guard.ts 的模块头）
  const toolLoopGuard = createToolLoopGuard()

  const contextOn = ctx as unknown as { on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined }
  if (typeof contextOn.on === 'function') {
    try {
      const dispose = contextOn.on('session/event', (...args: unknown[]) => {
        const session = args[0] as { id?: string } | undefined
        const event = args[1]
        try {
          const result = collectUsageFromEvent(runtime.db, event, {
            ...(typeof session?.id === 'string' ? { sessionId: session.id } : {}),
          })
          if (result.recorded && result.missReason === 'unexplained') {
            always(`⚠️ 检测到一次无法解释的缓存未命中（前缀在无故漂移）：${result.id ?? ''}`)
          }
        } catch (error) {
          log(`用量采集失败（已忽略）：${String(error)}`)

        // ── ★ 工具调用侧的死循环监控（补"不发言的循环"盲区）──────────
        //
        // `agent/assistant-stream` 只看得到**文字**；模型反复调同一个
        // 只读工具时**一个字都不说**，那一层完全拦不到。
        //
        // `tool/call` 是 `SessionEvent` ⇒ **复用这条已经在跑的订阅**，
        // 不新增钩子（新钩子要重新验调用约定，而这条已验证过）。
        //
        // **独立的检测器** —— 正常一轮里文字与工具是交替的，
        // 共用一个会把那个**完全正常的模式**看成重复。
        const toolVerdict = toolLoopGuard.feed(event)
        if (toolVerdict !== null && toolVerdict.action === 'stop-and-restart') {
          always(`⚠️ **检测到工具调用死循环**：${toolVerdict.reason}`)
        }
        }
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      log('已订阅会话事件：采集缓存命中率')
      // 与文字侧对称：**挂上时要留一行** ——
      // 静默的话，"工具侧监控在跑"和"没挂上"从日志上看一模一样。
      log('已订阅工具调用事件：死循环监控（不发言的循环）')
    } catch (error) {
      always(`⚠️ 无法订阅会话事件（缓存指标不可用）：${String(error)}`)
    }
  }
  // ③c 死循环监控（用户要求：重复输出 ⇒ 停本轮 + 重启）
  //
  // 挂宿主的 `agent/assistant-stream` —— 那能看到**模型刚生成的原文**，
  // 并用 `agent.cancel({kind:'hook'})` **真正中止本轮**。
  //
  // **拿不到钩子不是致命错误**（监控是加固，不是记忆本体），
  // 但**必须让人看见** —— 静默的话，"在跑"和"没挂上"从日志上看一模一样。
  registerLoopGuard(ctx, { log, always, disposers })

  // ③d 大工具结果截断层（PLAN §3.2）——
  //
  // **这是唯一能覆盖宿主自带工具的接缝**（`tools/post-execute` + `prepend: true`）——
  // 也就是真正会产出"完整日志 / 完整列表 / 原始报错"的那些工具
  // （`pwsh` / `read` / `web_fetch` / 子代理输出）。
  //
  // 不挂的话：宿主工具的大结果**整段进上下文**，而 `recall_full` 永远 `found:false`。
  registerToolResultSpill(ctx, runtime, { log, always, disposers })

  // ③d 轮次记账（本轮修复的 A + B 两条的**唯一接线点**）
  //
  // `beginTurn()` / `observeShortTokens()` 以前只被测试调用 ⇒ 生产里
  // `acct_short_tokens`、`acct_turns_since_compaction`、`recallThisTurn` 全是死的
  // ⇒ 模型自主压缩一律 `too_thin`、recall 额度永不重置。
  // 这里把它们接到宿主的 `turn/start` / `turn/end` 上（见该函数的模块注释）。
  registerTurnAccounting(ctx, runtime, { log, always, disposers })

  // ③e 沉降定时循环（E 的"中期 → 长期自动沉降"那一半）
  //
  // `runtime.settle()` 以前只有验收测试在调 —— 也就是说"沉降"只存在于测试里。
  // 这里起一个**插件侧**的低频维护循环（与 gateway 的 blob 沉降循环分工不同：
  // 那边搬文件、这边搬库里的条目）。反注册器进 disposers ⇒ 卸载时真的停表。
  const settleTimer = startSettleTimer(runtime, { log, always, env: process.env })
  disposers.push(settleTimer.stop)

  // ④ 面板接口**不在这里注册** —— 它需要 `connection` 服务，而该服务只由 `dsh-web-app` 提供。
  //    见 `./panel-plugin.ts`：那是独立的一行插件，由 web profile 显式挂载。
  //    这样主插件在 base / headless 宿主里照样能 apply（记忆本体不受影响）。

  // ⑤ 生命周期收尾：反注册 + 关库（checkpoint）
  const cleanup = (): void => {
    for (const dispose of disposers) {
      try {
        void dispose()
      } catch (error) {
        log(`反注册失败：${String(error)}`)
      }
    }
    try {
      runtimeRegistry.delete(dbPath)
      runtime.close()
      log('记忆库已 checkpoint 并关闭')
    } catch (error) {
      log(`关库失败：${String(error)}`)
    }
  }
  if (ctx.effect !== undefined) ctx.effect(() => cleanup)
  else if (ctx.on !== undefined) ctx.on('dispose', cleanup)

  // ⑥ 登记活动运行时：cordis 上下文对自定义属性只读，所以走模块级登记表
  //    （面板、doctor、测试都从这里取，避免四处各自开库连接）
  log(`活动运行时登记：${dbPath}`)
}














