/**
 * ★ **路由中介层的探针**（2026-10-08）
 *
 * ## 为什么先写探针
 *
 * 中介层要调两个**宿主服务**（都不是我们的代码）：
 * - `llm` —— `listProviders()` / `listModels(provider)` / `resolveModel(...)`
 * - `agentDefaultModel` —— `currentSelection()` / **`saveSelection(next)`**
 *
 * 这两个是从**宿主的 `.d.ts` 里读出来的签名**（`dsh-llm` / `dsh-agent-default-model`），
 * **但签名对 ≠ 运行期拿得到**：服务名可能不同、可能被别的插件抢先注册、
 * 或者在 `dsh web` 这个宿主里根本没加载。
 *
 * **⇒ 先用一个**只读**的探针把真实数据打出来** ——
 * 拿得到才写正式代码，否则又是"照文档写完发现接口对不上"。
 *
 * ## 为什么它值得**永久保留**
 *
 * 它不只是临时验证：**中介层"看得见什么"本来就是运维要的信息**
 * （面板上"路由"页应该显示的就是这些）。
 * ⇒ 保留为 `router_status` 的一个数据源，比写完就删更好。
 *
 * ## 本函数**只读**
 *
 * 不调 `saveSelection` —— 改模型是正式代码的事，探针只负责"看清"。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 一个 provider 的探针结果。 */
interface ProviderProbe {
  readonly id: string
  readonly label?: string
  readonly models?: readonly string[]
  readonly modelsError?: string
}

/** 探针报告。 */
export interface LlmProbeReport {
  /** `llm` 服务拿得到吗。 */
  readonly llmAvailable: boolean
  /** `llm` 服务的候选名（按顺序试，第一个拿到的胜出）。 */
  readonly llmResolvedName?: string
  /** 枚举到的 provider。 */
  readonly providers?: readonly ProviderProbe[]
  /** 枚举 provider 时的错误。 */
  readonly providersError?: string
  /** `agentDefaultModel` 服务拿得到吗。 */
  readonly defaultModelAvailable: boolean
  /** 它报的当前选择。 */
  readonly currentSelection?: unknown
  /** 读当前选择时的错误。 */
  readonly currentSelectionError?: string
  /** 一句话摘要（给日志用）。 */
  readonly summary: string
}

/**
 * `llm` 服务可能的名字。
 *
 * ⚠️ **为什么试多个**：DSH 的服务名来自包导出的 `name`，而我们是从 `.d.ts` 推的，
 * **没有运行期保证**。试几个的成本极低，比"猜一个然后失败"强。
 */
const LLM_SERVICE_NAMES = ['llm', 'llmRuntime', 'LlmRuntime'] as const

/** `agentDefaultModel` 可能的名字（它的 `declare module` 里写的就是 `agentDefaultModel`）。 */
const DEFAULT_MODEL_SERVICE_NAMES = ['agentDefaultModel', 'agent-default-model'] as const

/** 安全地取一个服务（拿不到返回 `undefined`，不抛）。 */
function tryGet(ctx: Context, names: readonly string[]): { readonly value: unknown; readonly name?: string } {
  for (const name of names) {
    try {
      const value = ctx.get(name as never)
      if (value !== undefined && value !== null) return { value, name }
    } catch {
      // 服务不存在会抛 —— 继续试下一个名字
    }
  }
  return { value: undefined }
}

/** 把未知值当对象用（够用即可，不引入宿主的类型依赖）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 探一次：宿主 LLM 服务能枚举出什么、当前默认模型是什么。
 *
 * **只读、不抛**（任何一步失败都记进报告，而不是让插件加载失败）。
 */
export async function probeLlm(ctx: Context): Promise<LlmProbeReport> {
  const llmHit = tryGet(ctx, LLM_SERVICE_NAMES)
  const llm = asRecord(llmHit.value)

  const dmHit = tryGet(ctx, DEFAULT_MODEL_SERVICE_NAMES)
  const dm = asRecord(dmHit.value)

  const report: {
    llmAvailable: boolean
    llmResolvedName?: string
    providers?: ProviderProbe[]
    providersError?: string
    defaultModelAvailable: boolean
    currentSelection?: unknown
    currentSelectionError?: string
    summary: string
  } = {
    llmAvailable: llm !== undefined,
    defaultModelAvailable: dm !== undefined,
    summary: '',
  }

  if (llmHit.name !== undefined) report.llmResolvedName = llmHit.name

  // ── 枚举 provider
  if (llm === undefined) {
    report.providersError = '拿不到 llm 服务（试过 ' + LLM_SERVICE_NAMES.join(' / ') + '）'
  } else if (typeof llm['listProviders'] !== 'function') {
    report.providersError = 'llm 服务上没有 listProviders()'
  } else {
    try {
      const raw = (llm['listProviders'] as () => unknown).call(llm)
      const list = Array.isArray(raw) ? raw : []
      const out: ProviderProbe[] = []
      for (const item of list) {
        const rec = asRecord(item)
        const id = rec === undefined ? undefined : (rec['id'] ?? rec['provider'] ?? rec['name'])
        if (typeof id !== 'string' || id === '') continue
        const label = rec === undefined ? undefined : rec['label']
        const entry: { id: string; label?: string; models?: readonly string[]; modelsError?: string } = { id }
        if (typeof label === 'string') entry.label = label
        // 顺手枚举这个 provider 的模型（失败只记这一条，不影响别的）
        if (typeof llm['listModels'] === 'function') {
          try {
            const modelsRaw = await (llm['listModels'] as (p: string) => Promise<unknown>).call(llm, id)
            const modelsList = Array.isArray(modelsRaw) ? modelsRaw : []
            entry.models = modelsList
              .map((m) => {
                const mr = asRecord(m)
                const mid = mr === undefined ? undefined : (mr['id'] ?? mr['model'] ?? mr['name'])
                return typeof mid === 'string' ? mid : undefined
              })
              .filter((x): x is string => x !== undefined)
          } catch (error) {
            entry.modelsError = String(error).slice(0, 120)
          }
        }
        out.push(entry)
      }
      report.providers = out
    } catch (error) {
      report.providersError = String(error).slice(0, 200)
    }
  }

  // ── 读当前默认模型
  if (dm === undefined) {
    report.currentSelectionError = '拿不到 agentDefaultModel（试过 ' + DEFAULT_MODEL_SERVICE_NAMES.join(' / ') + '）'
  } else if (typeof dm['currentSelection'] !== 'function') {
    report.currentSelectionError = 'agentDefaultModel 上没有 currentSelection()'
  } else {
    try {
      report.currentSelection = (dm['currentSelection'] as () => unknown).call(dm)
    } catch (error) {
      report.currentSelectionError = String(error).slice(0, 200)
    }
  }

  // ── 一句话摘要
  const parts: string[] = []
  parts.push('llm=' + (report.llmAvailable ? '✅' + (report.llmResolvedName ?? '') : '❌'))
  if (report.providers !== undefined) {
    const totalModels = report.providers.reduce((n, p) => n + (p.models?.length ?? 0), 0)
    parts.push('providers=' + String(report.providers.length) + '(' + report.providers.map((p) => p.id).join(',') + ')')
    parts.push('models=' + String(totalModels))
  } else {
    parts.push('providers=❌' + (report.providersError ?? ''))
  }
  parts.push('agentDefaultModel=' + (report.defaultModelAvailable ? '✅' : '❌'))
  if (report.currentSelection !== undefined) {
    const sel = asRecord(report.currentSelection)
    const p = sel?.['provider']
    const m = sel?.['model']
    const e = sel?.['reasoningEffort']
    if (typeof p === 'string' || typeof m === 'string') {
      parts.push('current=' + String(p ?? '?') + '/' + String(m ?? '?') + (typeof e === 'string' ? ':' + e : ''))
    }
  }
  report.summary = parts.join(' ')

  return report
}
