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














