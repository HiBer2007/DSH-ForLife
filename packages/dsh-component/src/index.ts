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
        }
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      log('已订阅会话事件：采集缓存命中率')
    } catch (error) {
      always(`⚠️ 无法订阅会话事件（缓存指标不可用）：${String(error)}`)
    }
  }
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














