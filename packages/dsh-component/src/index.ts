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
import { registerMemorySections, registerPromptSections, type SystemPromptLike } from './prompt.ts'
import { seedDefaultPrompts } from './prompt-store.ts'
import { seedDefaultRoutes } from './route-seed.ts'
import { collectUsageFromEvent } from './cache-collector.ts'
import { buildClockTools } from './clock-tools.ts'
import { buildRouterTools } from './router-tools.ts'
import { buildPortTools, portToolOptionsFromEnv } from './port-tools.ts'
import { getWakeTrigger, markSystemTriggersDue, updateWakeTrigger } from '@forlife/store'
import { onCompactionFailure } from './compaction-engine.ts'
import { buildWakeTools, type WakeToolHost } from './wake-tools.ts'
import { registerWakeEndpoint, type WakeHost } from './wake-bridge-endpoint.ts'
import { registerLoopGuard } from './loop-guard-register.ts'
import { createToolLoopGuard } from './tool-loop-guard.ts'
import { MemoryRuntime, resolveDbPath } from './runtime.ts'
export type { MemoryRuntime } from './runtime.ts'
import { buildMemoryTools, type DefineToolLike } from './tools.ts'
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
    return
  }

  const dispose = registerWakeEndpoint(webServer as never, {
    secret,
    log,
    host: {
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
      createMessage: (input) => ({
        text: input.text,
        source: { kind: input.sourceKind, summary: input.summary },
      }),
      withoutInitiator: (fn) => agents!.withoutInitiator(fn),
    },
  })
  disposers.push(dispose)
  log(`✅ 唤醒桥端点已挂载：${process.env.FORLIFE_WAKE_BRIDGE_PATH ?? '/forlife/wake'}`)
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
    if (seeded.length > 0) always(`已播种内置提示词：${seeded.join(', ')}`)
    disposers.push(registerPromptSections(systemPrompt, runtime, config.promptVariables))
    disposers.push(registerMemorySections(systemPrompt, runtime))
    log('已注册提示段 forlife:p1-system(100) / forlife:p2-style(110) / forlife:l2-index(120) / forlife:l3-mid(130)')
  } else if (config.registerPromptSections) {
    always('⚠️ 未找到 systemPrompt 服务：记忆区不会进入系统提示词（只写库不生效）。')
  }

  // ③ 工具
  const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
  if (config.registerTools && tools !== undefined) {
    if (defineToolImpl === undefined) {
      always('⚠️ 未找到 @deepseek-ai/dsh-tools 的 defineTool：记忆工具未注册（记忆仍在写入，但模型看不到工具）。')
    } else {
      for (const definition of buildMemoryTools(defineToolImpl, runtime)) {
        const dispose = tools.register(definition)
        disposers.push(dispose)
      }
      // 时间工具（阶段 4）：`now()` 是"主动看时间"的唯一实现方式（§2.15.1 根因 4）
      for (const definition of buildClockTools(defineToolImpl, runtime)) {
        const dispose = tools.register(definition)
        disposers.push(dispose)
      }
      // 路由工具（阶段 5 §2.18）：switch_model / revert_model / router_status。
      // **主代理才有** —— 子代理连工具都拿不到（第一道防线）
      for (const definition of buildRouterTools(defineToolImpl, runtime)) {
        const dispose = tools.register(definition)
        disposers.push(dispose)
      }

  // 端口出口工具（PLAN 阶段 7）。**未配置 Caddy 时返回空数组** ——
  // 注册了只会让模型调用一个注定失败的工具，而它会把这个失败当成"我操作错了"，反复重试。
  for (const definition of buildPortTools(defineToolImpl, runtime, portToolOptionsFromEnv(process.env))) {
    const dispose = tools.register(definition)
    disposers.push(dispose)
  }

      // 唤醒工具（PLAN 阶段 8）。**总是注册** —— 它们只写数据库，不需要外部配置就能成功；
      // "安排一个唤醒"在 gateway 侧引擎起来之前也是有效的，只是暂时不会响。
      // （对比端口工具：没有 Caddy 时注定失败，所以那种才"没配就不注册"。）
      for (const definition of buildWakeTools(defineToolImpl, runtime, wakeToolHost(runtime))) {
        const dispose = tools.register(definition)
        disposers.push(dispose)
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
      log('已注册工具 remember / push_mid_memory / recall_longterm / recall_full / now / get_clock / set_clock / list_clocks / switch_model / revert_model / router_status')
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














