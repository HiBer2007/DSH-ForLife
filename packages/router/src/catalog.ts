/**
 * ★ **模型目录**：把宿主给的 provider/model 原始清单，整理成"能拿来决策"的一张表。
 *
 * ## 为什么要有这一层
 *
 * 用户的设计（2026-10-08）：
 *
 * > 由于需要由本地小模型根据任务来判断应该使用哪个模型（初始路由），
 * > 因此需要给模型表（尤其是本地自部署）的模型**提供标记和简介功能，以辅助决策**。
 * > ……初始路由不用特别关心记忆的内容，所以不用吃掉所有上下文，
 * > **只需要轮次输入作为参考，以及表、各个模型当前可达性**。
 *
 * ⇒ 于是中介层的输入被定死成三样：
 * **① 轮次输入  ② 模型表  ③ 各模型当前可达性**。
 *
 * 这个模块负责 **② + ③** —— 把宿主那两个接口的原始返回值，整理成
 * **短、稳、可读**的一行行，好让 `minimum` 那个 0.5B 的小模型**一眼看懂**。
 *
 * ## 为什么是纯函数
 *
 * 宿主接口（`llm.listProviders()` / `listModels()`）**只在插件上下文里拿得到**，
 * 单测里造不出来。⇒ 把"取数"和"整理"分开：
 * - **取数**（`dsh-component` 侧，薄薄一层）—— 拿不到就返回空
 * - **整理**（这里，纯）—— **全部逻辑都在这儿，全部可单测**
 *
 * ## "标记"与"简介"从哪来
 *
 * - **名字/描述**：**宿主给的**（`LlmModelInfo.name` / `.description`）—— 事实来源是 DSH，不是我们
 * - **标记**：**我们推的**（本地/免费/视觉/原生/自带）—— 从 id 与 modality 推，规则写在下面
 *
 * ⚠️ **标记是启发式的**，所以规则要**窄**（宁可少标，不要标错）：
 * 标错一个"本地"会让小模型把远程模型当本地用。
 */
import type { ReasoningEffort } from '@forlife/contracts'

/** 宿主 `LlmProviderInfo` 的最小形状（只取我们用得到的）。 */
export interface RawProvider {
  readonly id: string
  readonly name?: string
}

/** 宿主 `LlmModelInfo` 的最小形状。 */
export interface RawModel {
  readonly provider?: string
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly inputModalities?: readonly string[]
}

/** 一个模型在决策表里的**标记**。 */
export type CatalogMark =
  /** 本地自部署（同机/内网容器里跑的 —— 零成本、快、但小）。 */
  | 'local'
  /** 免费额度（限时或长期免费）。 */
  | 'free'
  /** 能看图（视觉输入）。 */
  | 'vision'
  /** DSH 原生自带（`deepseek-official` 那一类）。 */
  | 'native'
  /** 我们自己注册的接入点（`opencode-go`）。 */
  | 'ours'
  /** 自带账号（`deepseek-account` 那一类）。 */
  | 'account'

/** 决策表里的一行 —— **这一行就是给小模型看的东西**。 */
export interface CatalogEntry {
  readonly provider: string
  readonly model: string
  /** 人类可读的名字（宿主给的，没有就用 id）。 */
  readonly name: string
  /** 简介（宿主给的）。**没有就空着** —— 不要编。 */
  readonly description?: string
  /** 标记（我们推的，可能为空）。 */
  readonly marks: readonly CatalogMark[]
  /** 现在可达吗（`false` 的行**不该**被选）。 */
  readonly reachable: boolean
  /** 不可达的原因（可达时没有）。 */
  readonly unreachableReason?: string
}

/** 目录（决策表的整体）。 */
export interface ModelCatalog {
  readonly entries: readonly CatalogEntry[]
  /** 生成时间（可达性是有时效的）。 */
  readonly builtAt: string
  /** 一句话摘要（给日志/面板）。 */
  readonly summary: string
}

/** 判断"是不是本地自部署"的**窄**规则。 */
const LOCAL_PATTERNS: readonly RegExp[] = [
  // llama.cpp / ollama / vllm 那类本地推理服务
  // 分隔符含 `.`：`scorer.gguf` 这种写法很常见
  /(^|[-_/.])local([-_/.]|$)/i,
  /(^|[-_/.])llama([-_/.]|$)/i,
  /(^|[-_/.])ollama([-_/.]|$)/i,
  /(^|[-_/.])vllm([-_/.]|$)/i,
  /(^|[-_/.])llamacpp([-_/.]|$)/i,
  /(^|[-_/.])gguf([-_/.]|$)/i,
  // 显式写了 loopback / 容器名
  /(^|[-_/.])(localhost|127\.0\.0\.1|host\.docker\.internal)([-_/:.]|$)/i,
]

/** 判断"免费"的窄规则（`free` 作为一个词出现）。 */
const FREE_PATTERN = /(^|[-_/])free([-_/]|$)/i  // 注意：`.free` 也算，但 `freedom` 不算

/**
 * 推一个模型的标记。
 *
 * ⚠️ **规则刻意窄**：只认明确的信号。宁可少标（小模型自己也能从名字看出来），
 * **不要标错** —— 标错"本地"会让它把远程模型当零成本用。
 */
export function marksOf(input: {
  readonly provider: string
  readonly model: string
  readonly inputModalities?: readonly string[]
  readonly oursProviders?: readonly string[]
  readonly nativeProviders?: readonly string[]
  readonly accountProviders?: readonly string[]
}): readonly CatalogMark[] {
  const out: CatalogMark[] = []
  const hay = input.provider + '/' + input.model

  if (LOCAL_PATTERNS.some((re) => re.test(hay))) out.push('local')
  if (FREE_PATTERN.test(input.model)) out.push('free')
  if ((input.inputModalities ?? []).includes('image')) out.push('vision')
  if ((input.oursProviders ?? []).includes(input.provider)) out.push('ours')
  if ((input.nativeProviders ?? []).includes(input.provider)) out.push('native')
  if ((input.accountProviders ?? []).includes(input.provider)) out.push('account')

  return out
}

/** 标记 → 中文短标签（给小模型看的一行）。 */
const MARK_LABEL: Record<CatalogMark, string> = {
  local: '本地',
  free: '免费',
  vision: '视觉',
  native: '原生',
  ours: '自建',
  account: '账号',
}

/**
 * 整理成决策表。
 *
 * @param input.providers - 宿主 `listProviders()` 的结果。
 * @param input.models - 宿主 `listModels()` 的结果（**所有 provider 合并在一起**）。
 * @param input.unreachable - 已知不可达的 `provider/model`（`Set` 的键是 `provider + '/' + model`）。
 * @param input.oursProviders - 我们自己注册的 provider id（默认 `['opencode-go']`）。
 * @param input.nativeProviders - DSH 原生自带的（默认 `['deepseek-official']`）。
 * @param input.accountProviders - 自带账号类（默认 `['deepseek-account']`）。
 * @param input.now - 时间（便于测试）。
 */
export function buildCatalog(input: {
  readonly providers: readonly RawProvider[]
  readonly models: readonly RawModel[]
  readonly unreachable?: ReadonlySet<string>
  readonly oursProviders?: readonly string[]
  readonly nativeProviders?: readonly string[]
  readonly accountProviders?: readonly string[]
  readonly now?: Date
}): ModelCatalog {
  const ours = input.oursProviders ?? ['opencode-go']
  const native = input.nativeProviders ?? ['deepseek-official']
  const account = input.accountProviders ?? ['deepseek-account']
  const unreachable = input.unreachable ?? new Set<string>()

  // provider 的 display name（宿主给了就用，没给就用 id）
  const provName = new Map<string, string>()
  for (const p of input.providers) provName.set(p.id, p.name ?? p.id)

  const entries: CatalogEntry[] = []
  for (const m of input.models) {
    const provider = m.provider ?? ''
    if (provider === '') continue
    const key = provider + '/' + m.id
    const marks = marksOf({
      provider,
      model: m.id,
      ...(m.inputModalities === undefined ? {} : { inputModalities: m.inputModalities }),
      oursProviders: ours,
      nativeProviders: native,
      accountProviders: account,
    })
    const bad = unreachable.has(key)
    entries.push({
      provider,
      model: m.id,
      name: m.name ?? m.id,
      ...(m.description === undefined ? {} : { description: m.description }),
      marks,
      reachable: !bad,
      ...(bad ? { unreachableReason: '已知不可达（最近一次探测失败）' } : {}),
    })
  }

  // ★ provider 一个模型都没枚举出来时，**也要留一行**。
  //   为什么：那本身就是信息（"这个接入点现在不可用"），
  //   小模型看到"某接入点 0 个模型"比"它完全不出现"更容易判断。
  for (const p of input.providers) {
    if (entries.some((e) => e.provider === p.id)) continue
    entries.push({
      provider: p.id,
      model: '(无可用模型)',
      name: provName.get(p.id) ?? p.id,
      marks: marksOf({ provider: p.id, model: '', oursProviders: ours, nativeProviders: native, accountProviders: account }),
      reachable: false,
      unreachableReason: '这个接入点没有枚举出任何模型',
    })
  }

  entries.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))

  const reachableCount = entries.filter((e) => e.reachable).length
  const summary =
    '接入点 ' + String(input.providers.length) + ' 个（' + input.providers.map((p) => p.id).join(', ') + '）' +
    '｜模型 ' + String(entries.length) + ' 个，其中可达 ' + String(reachableCount) + ' 个'

  const builtAt = (input.now ?? new Date()).toISOString()
  return { entries, builtAt, summary }
}

/**
 * 把目录压成**给小模型看的一段文本**。
 *
 * ## 为什么不是 JSON
 *
 * 0.5B 那个量级的模型读 JSON 很容易串行/漏字段；
 * **一行一个模型的固定格式**它对得准。
 *
 * ## 为什么带 `id:`
 *
 * 小模型输出时要能**原样回抄**一个坐标（`provider/model`）——
 * 给它短代号反而多一层映射、多一处出错。
 */
export function renderCatalogForPrompt(catalog: ModelCatalog, options: { readonly maxEntries?: number } = {}): string {
  const max = options.maxEntries ?? 200
  const lines: string[] = []
  lines.push('可用模型（每行：可达性 坐标 标记 名字/简介）')
  for (const e of catalog.entries.slice(0, max)) {
    const reach = e.reachable ? '可用' : '不可用'
    const marks = e.marks.length === 0 ? '' : ' [' + e.marks.map((m) => MARK_LABEL[m]).join('/') + ']'
    const desc = e.description === undefined ? '' : ' — ' + e.description
    lines.push(reach + ' ' + e.provider + '/' + e.model + marks + ' ' + e.name + desc)
  }
  if (catalog.entries.length > max) {
    lines.push('（还有 ' + String(catalog.entries.length - max) + ' 个未列出）')
  }
  return lines.join('\n')
}

/** 档位 → 建议的推理强度（与 `route-seed.ts` 的播种保持一致）。 */
export const TIER_EFFORT: Record<string, ReasoningEffort> = {
  L1: 'low',
  L2: 'high',
  L3: 'max',
  minimum: 'low',
}
