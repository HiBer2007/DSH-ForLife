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
import { registerMemorySections, type SystemPromptLike } from './prompt.ts'
import { MemoryRuntime, resolveDbPath } from './runtime.ts'
import { buildMemoryTools, type DefineToolLike } from './tools.ts'
import { registerPanelRoutes, type FetchRegistryLike } from './api.ts'
import { emitForlifeEvent, type SessionLike } from './events.ts'

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
  const disposers: (() => void | Promise<void>)[] = []

  // ② 提示段（L2 + L3）
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (config.registerPromptSections && systemPrompt !== undefined) {
    disposers.push(registerMemorySections(systemPrompt, runtime))
    log('已注册提示段 forlife:l2-index / forlife:l3-mid')
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
      log('已注册工具 remember / push_mid_memory / recall_longterm / recall_full')
    }
  }

  // ④ 面板接口（可选服务：没有 connection 就跳过，不影响其它能力）
  if (config.exposePanelApi && ctx.inject !== undefined) {
    ctx.inject(['connection'], (scoped) => {
      const connection = scoped.get('connection') as { fetch?: FetchRegistryLike } | undefined
      const registry = connection?.fetch
      if (registry === undefined) {
        log('connection 服务存在但没有 fetch 注册表：跳过面板接口')
        return
      }
      const dispose = registerPanelRoutes(registry, runtime)
      disposers.push(dispose)
      log('已注册面板接口 /api/forlife/{state,entries,compaction,spills,health}')
    })
  }

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



