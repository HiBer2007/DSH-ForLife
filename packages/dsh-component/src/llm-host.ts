/**
 * ★ **取数层**：从宿主的 `llm` 服务拿到 provider/model，喂给 `buildCatalog()`。
 *
 * ## 为什么单独一层（而不是塞进 catalog.ts）
 *
 * `catalog.ts` 是**纯函数**（可单测、不需要宿主）。这个文件是**唯一碰宿主的地方**：
 * - 拿服务（`ctx.get('llm')`）
 * - 调它的两个方法（`listProviders()` / `listModels()`）
 * - 把**未知形状**的返回值缩成 `RawProvider` / `RawModel`
 *
 * ⇒ 分开的好处：**逻辑全在纯函数里被测到**，这里**薄到几乎不需要测**。
 *
 * ## 为什么要"每个 provider 单独 listModels 并逐个 try"
 *
 * 宿主对每个 provider 的模型枚举是**独立**的（它可能去问远端）。
 * **一个 provider 挂了不该让整张表空掉** —— 那会让路由在"某个接入点抖动"时
 * 连"还有别的接入点可用"都看不见。
 *
 * ## 可达性怎么算
 *
 * 用户要求初始路由的三个输入之一是"**各模型当前可达性**"。
 * 这里给的是**能立刻判断的那一种**：
 * - **枚举不出模型** ⇒ **不可达**（`buildCatalog` 会留一行并标原因）
 * - **枚举抛异常** ⇒ **不可达**，并把原因记下来
 *
 * ⚠️ **更深的可达性（真发一个请求）不在这里做** —— 那要么花钱要么慢，
 * 应该由**独立的心跳/探测**来做，结果通过 `unreachable` 传进来。
 */
import type { Context } from '@deepseek-ai/cordis'

import { buildCatalog, type ModelCatalog, type RawModel, type RawProvider } from '@forlife/router'

/** `llm` 服务可能的名字（按顺序试）。 */
const LLM_SERVICE_NAMES = ['llm', 'llmRuntime'] as const

/** 一个 provider 的取数结果（含"为什么没拿到"）。 */
export interface HostProviderFetch {
  readonly id: string
  readonly name?: string
  readonly models: readonly RawModel[]
  /** 枚举这个 provider 的模型时的错误（成功时没有）。 */
  readonly error?: string
}

/** 取数结果。 */
export interface HostCatalogResult {
  readonly catalog: ModelCatalog
  readonly providers: readonly HostProviderFetch[]
  /** `llm` 服务拿不到时的原因。 */
  readonly unavailableReason?: string
}

/** 把未知值当对象用。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** 安全取一个服务。 */
function tryGetService(ctx: Context, names: readonly string[]): unknown {
  for (const name of names) {
    try {
      const value = ctx.get(name as never)
      if (value !== undefined && value !== null) return value
    } catch {
      // 服务不存在会抛 —— 继续试下一个名字
    }
  }
  return undefined
}

/** 把宿主的 modality 值缩成字符串数组（不认识的值丢掉）。 */
function modalitiesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length === 0 ? undefined : out
}

/**
 * 取一次数。
 *
 * **不抛**：任何一步失败都记进结果（路由是"尽力而为"的旁路，
 * **不该因为它把主流程弄挂**）。
 */
export async function fetchHostCatalog(ctx: Context): Promise<HostCatalogResult> {
  const svc = asRecord(tryGetService(ctx, LLM_SERVICE_NAMES))

  if (svc === undefined) {
    return {
      catalog: buildCatalog({ providers: [], models: [] }),
      providers: [],
      unavailableReason: '拿不到 llm 服务（试过 ' + LLM_SERVICE_NAMES.join(' / ') + '）',
    }
  }
  if (typeof svc['listProviders'] !== 'function') {
    return {
      catalog: buildCatalog({ providers: [], models: [] }),
      providers: [],
      unavailableReason: 'llm 服务上没有 listProviders()',
    }
  }

  // ── ① provider 列表
  let rawProviders: readonly unknown[] = []
  try {
    const raw = (svc['listProviders'] as () => unknown).call(svc)
    if (Array.isArray(raw)) rawProviders = raw
  } catch (error) {
    return {
      catalog: buildCatalog({ providers: [], models: [] }),
      providers: [],
      unavailableReason: 'listProviders() 抛异常：' + String(error).slice(0, 160),
    }
  }

  const providers: RawProvider[] = []
  for (const item of rawProviders) {
    const rec = asRecord(item)
    const id = rec?.['id']
    if (typeof id !== 'string' || id === '') continue
    const name = rec?.['name']
    providers.push(typeof name === 'string' ? { id, name } : { id })
  }

  // ── ② 逐个 provider 枚举模型（**互不影响**）
  const listModels = svc['listModels']
  const fetches: HostProviderFetch[] = []
  const allModels: RawModel[] = []
  const unreachable = new Set<string>()

  for (const p of providers) {
    if (typeof listModels !== 'function') {
      fetches.push({ id: p.id, ...(p.name === undefined ? {} : { name: p.name }), models: [], error: 'llm 服务上没有 listModels()' })
      continue
    }
    try {
      const raw = await (listModels as (provider: string) => Promise<unknown>).call(svc, p.id)
      const list = Array.isArray(raw) ? raw : []
      const models: RawModel[] = []
      for (const item of list) {
        const rec = asRecord(item)
        const id = rec?.['id']
        if (typeof id !== 'string' || id === '') continue
        const name = rec?.['name']
        const description = rec?.['description']
        const mods = modalitiesOf(rec?.['inputModalities'])
        models.push({
          provider: p.id,
          id,
          ...(typeof name === 'string' ? { name } : {}),
          ...(typeof description === 'string' && description !== '' ? { description } : {}),
          ...(mods === undefined ? {} : { inputModalities: mods }),
        })
      }
      allModels.push(...models)
      fetches.push({ id: p.id, ...(p.name === undefined ? {} : { name: p.name }), models })
    } catch (error) {
      // ★ 一个 provider 挂了不影响别的
      fetches.push({
        id: p.id,
        ...(p.name === undefined ? {} : { name: p.name }),
        models: [],
        error: String(error).slice(0, 160),
      })
      // 它的模型全都算"不可达"（但我们并不知道它有哪些模型 —— 留空即可，
      // buildCatalog 会因为"零模型"给它留一行并标注原因）
    }
  }

  const catalog = buildCatalog({
    providers,
    models: allModels,
    unreachable,
    ...(ctx === undefined ? {} : {}),
  })

  return { catalog, providers: fetches }
}
