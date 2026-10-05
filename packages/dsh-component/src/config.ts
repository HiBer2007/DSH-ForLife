/**
 * 插件配置（schemastery）。
 *
 * 两条来自宿主实测的硬要求：
 *  1. **必须至少有一个 `.volatile()` 字段** —— 否则宿主设置页**不会**出现本插件条目
 *     （`dsh-settings` 的 `describe()` 要求 schema 上有 volatile 字段才收录）；
 *  2. **namespace = profile 里的 loader row id**，不是包名 —— 所以设置页里看到的是
 *     `forlife-memory` 这一行。
 *
 * 默认值一律经 `defaultFor()` 从**保真度基线**取，不允许在这里硬编码阈值
 * （这是 §2.6 的强制点，偏离必须登记）。
 *
 * @module forlife-memory/config
 */
import z from '@deepseek-ai/schemastery'
import { defaultFor } from '@forlife/contracts'

/** 解析后的运行配置。 */
export interface ForlifeConfig {
  /** 存储根目录（相对 `DSH_HOME`，保证可移植）。 */
  readonly storageRoot: string
  /** 数据库文件名。 */
  readonly dbFile: string
  /** L2 长期记忆手册/索引的文本（用户可编辑，热生效）。 */
  readonly l2IndexText: string
  /** L3 中期记忆区的标题行。 */
  readonly l3Header: string
  /** 系统/记录时区（存储一律 UTC，这里只用于展示换算）。 */
  readonly timeZone: string
  /** 是否在渲染时附带相对年龄（如"（3 天前）"）。 */
  readonly relativeAges: boolean
  /** 单次 recall 返回条数上限。 */
  readonly recallMaxResults: number
  /** 每轮 recall 次数上限。 */
  readonly recallMaxPerTurn: number
  /** 是否把 L2/L3 段注册进系统提示词。 */
  readonly registerPromptSections: boolean
  /** 是否注册工具（关闭后模型看不到记忆工具，用于排障）。 */
  readonly registerTools: boolean
  /** 是否暴露 `/api/forlife/*` 面板接口。 */
  readonly exposePanelApi: boolean
  /** 打印详细诊断。 */
  readonly verbose: boolean
}

/**
 * L2 默认文案。
 *
 * 这是"长期记忆手册/索引"的位置（PLAN §1.3 的 L2）：告诉模型它有一份长期记忆、
 * 怎么用、以及边界在哪。内容刻意写得短 —— 它位于**稳定前缀**里，每个 token 都会被缓存复用，
 * 但也意味着改动会导致一次缓存未命中，所以默认值要一次写对。
 */
export const DEFAULT_L2_INDEX_TEXT = [
  '=== 长期记忆 ===',
  '你拥有一份跨会话的长期记忆（不是当前对话的上下文）：',
  '- 需要回忆过去的事实时，用 recall_longterm 检索；结果附带本周期剩余额度。',
  '- 检索前先想清楚要什么；一次无结果不代表不存在，换关键词再试；不要为确认而反复检索。',
  '- 想主动记住某事时用 remember 或 push_mid_memory；不要记录工具调用流水或你刚说过的话。',
  '- 被截断的大结果可用 recall_full 取回全文；已沉降的条目可用 recover 提升回热层。',
].join('\n')

/** 配置 schema。 */
export const Config = z.object({
  storageRoot: z
    .string()
    .default('forlife')
    .description('存储根目录，相对 DSH_HOME。留空则用 "forlife"。')
    .volatile(),
  dbFile: z.string().default('db/forlife.sqlite').description('数据库文件（相对存储根）。'),
  l2IndexText: z
    .string()
    .default(DEFAULT_L2_INDEX_TEXT)
    .description('L2「长期记忆手册/索引」文本。它位于稳定前缀，改动会导致一次缓存未命中。')
    .volatile(),
  l3Header: z.string().default('=== 中期记忆 ===').description('L3 中期记忆区的标题行。'),
  timeZone: z
    .string()
    .default(defaultFor<string>('time.systemZone'))
    .description('展示时区（存储一律 UTC，不受此项影响）。'),
  relativeAges: z
    .boolean()
    .default(defaultFor<boolean>('time.relativeAges'))
    .description('在记忆条目后附带相对年龄，如「（3 天前）」。'),
  recallMaxResults: z
    .number()
    .default(defaultFor<number>('recall.maxResults'))
    .description('recall_longterm 单次返回条数上限（硬上限 5）。'),
  recallMaxPerTurn: z
    .number()
    .default(defaultFor<number>('recall.maxPerTurn'))
    .description('每轮 recall 次数上限。'),
  registerPromptSections: z.boolean().default(true).description('是否把记忆区注册进系统提示词。'),
  registerTools: z.boolean().default(true).description('是否注册记忆工具（排障时可关闭）。'),
  exposePanelApi: z.boolean().default(true).description('是否暴露 /api/forlife/* 面板接口。'),
  verbose: z.boolean().default(false).description('打印详细诊断日志。'),
})

/** 配置里的默认值来源说明（供 doctor / 文档展示）。 */
export const CONFIG_BASELINE_KEYS: readonly string[] = [
  'time.systemZone',
  'time.relativeAges',
  'recall.maxResults',
  'recall.maxPerTurn',
]

/**
 * 读取一个可能被 schemastery 包成 volatile 引用的配置值。
 *
 * 为什么需要它：`.volatile()` 字段在解析结果里**不是裸值**，而是 cosmokit 的
 * `Volatile<T>`（带 `get()` 的稳定引用，`cosmokit/lib/types/volatile.d.ts:7`）。
 * 直接比较/拼接会得到 `[object Object]`，而且是运行时才发现的坑。
 *
 * 这里用**鸭子类型**而不是 `import { isVolatile } from '@deepseek-ai/cosmokit'`：
 * 少一个 peer 依赖，且 cosmokit 自己的注释说明该协议就是为了跨 ESM/CJS 副本识别，
 * 结构判断与之等价。我们的字段全是标量，不存在"本来就有 get 方法"的误判风险。
 */
function readConfigValue<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    const snapshot = (value as { get(): unknown }).get()
    return (snapshot ?? fallback) as T
  }
  return value as T
}

/**
 * 把宿主传入的（可能含 volatile 引用的）配置归一化成纯数据。
 *
 * @param raw - `apply(ctx, config)` 收到的配置。
 * @returns 每个 volatile 字段都已取其当前快照的纯对象。
 */
export function resolveConfig(raw: Partial<ForlifeConfig>): ForlifeConfig {
  const defaults = Config({}) as unknown as ForlifeConfig
  return {
    storageRoot: readConfigValue(raw.storageRoot, defaults.storageRoot),
    dbFile: readConfigValue(raw.dbFile, defaults.dbFile),
    l2IndexText: readConfigValue(raw.l2IndexText, defaults.l2IndexText),
    l3Header: readConfigValue(raw.l3Header, defaults.l3Header),
    timeZone: readConfigValue(raw.timeZone, defaults.timeZone),
    relativeAges: readConfigValue(raw.relativeAges, defaults.relativeAges),
    recallMaxResults: readConfigValue(raw.recallMaxResults, defaults.recallMaxResults),
    recallMaxPerTurn: readConfigValue(raw.recallMaxPerTurn, defaults.recallMaxPerTurn),
    registerPromptSections: readConfigValue(raw.registerPromptSections, defaults.registerPromptSections),
    registerTools: readConfigValue(raw.registerTools, defaults.registerTools),
    exposePanelApi: readConfigValue(raw.exposePanelApi, defaults.exposePanelApi),
    verbose: readConfigValue(raw.verbose, defaults.verbose),
  }
}
