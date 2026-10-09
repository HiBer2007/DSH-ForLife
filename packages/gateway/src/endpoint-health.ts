/**
 * 端点健康探测（自动）。
 *
 * ## 为什么需要它：一个永远显示 0 的指标等于没有指标
 *
 * 面板上「端点：健康/已登记」这个卡片，在补齐之前**恒为 0/N** ——
 * 因为 `health_ok` 从来没有被写过：探测逻辑只存在于插件里，而且**只能手动调 API 触发**。
 *
 * 用户看到的是"监控端点 0"，以为是"没有端点"或"端点都坏了"，
 * 实际是**这个数字从来没被计算过**。这比报错更糟：报错至少有人会去查。
 *
 * ## 探测什么
 *
 * `GET {base_url}/models`（OpenAI 兼容端点都有），8 秒超时。
 * 选它而不是发一次 chat completion 的理由：
 *  - 它**不花钱**（不发推理请求），可以放心高频跑；
 *  - 它能同时确认"连得上"与"认得这个端点"，而且顺带拿到模型清单；
 *  - 真正花钱的"试跑"留给用户手动触发（那是"编辑"动作，不是监控动作）。
 *
 * ## 三态，不是两态
 *
 * `health_ok` 为 `NULL`（从未探测）与 `0`（探测过但不健康）**必须分开**：
 * 混在一起显示成"不健康"，用户就会去修一个可能根本没坏的东西。
 * 所以这个模块只负责**把 NULL 变成真实值**，而不是把 NULL 当成失败。
 *
 * @module @forlife/gateway/endpoint-health
 */
import type { DatabaseSync } from 'node:sqlite'

import { recordEndpointHealth, recordEndpointProbe } from '@forlife/store'

import { describeQuota, probeQuota, quotaBlocksRouting, type QuotaFetch } from './quota.ts'

/** 注入的 fetch（测试用）。 */
export type HealthFetch = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/** 单个端点的探测结果。 */
export interface EndpointProbeResult {
  readonly endpointId: string
  readonly ok: boolean
  readonly latencyMs?: number
  readonly models?: readonly string[]
  readonly error?: string
  /** 健康/额度结论（面板显示用）。 */
  readonly note?: string
}

/** 探测配置。 */
export interface EndpointHealthOptions {
  readonly db: DatabaseSync
  readonly fetchImpl?: HealthFetch
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
  /** 额度查询用的 fetch（测试注入）。 */
  readonly quotaFetchImpl?: QuotaFetch | undefined
  /** 取 key 的环境变量表（默认 process.env）。 */
  readonly env?: NodeJS.ProcessEnv
  /**
   * 每次探测完一个端点后回调（可选）。
   *
   * 给唤醒引擎用：端点不可用/恢复要能转成 system 触发。
   * **它是观察者，不是链路的一部分** —— 抛异常会被吞掉，不影响探测。
   */
  readonly onProbeResult?: ((endpointName: string, ok: boolean, error?: string) => void) | undefined
}

/** 探测一个端点。 */
export async function probeEndpoint(baseUrl: string, options: { readonly fetchImpl?: HealthFetch; readonly timeoutMs?: number } = {}): Promise<
  { readonly ok: true; readonly latencyMs: number; readonly models: readonly string[] } | { readonly ok: false; readonly latencyMs: number; readonly error: string }
> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as HealthFetch)
  const base = baseUrl.replace(/\/$/, '')
  const started = Date.now()
  try {
    const response = await fetchImpl(`${base}/models`, { signal: AbortSignal.timeout(options.timeoutMs ?? 8000) })
    const latencyMs = Date.now() - started
    if (!response.ok) return { ok: false, latencyMs, error: `HTTP ${String(response.status)}` }
    const body = (await response.json()) as { data?: { id?: unknown }[] }
    const models = (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string')
    return { ok: true, latencyMs, models }
  } catch (error) {
    // 超时与连不上都是"不健康"，但要**区分开**：前者是端点慢，后者是端点不在
    const latencyMs = Date.now() - started
    const message = String(error)
    return { ok: false, latencyMs, error: message.includes('Timeout') || message.includes('timeout') ? `超时（>${String(options.timeoutMs ?? 8000)}ms）` : message.slice(0, 160) }
  }
}

/**
 * 探测全部**启用的**端点并落库。
 *
 * 只探启用的：停用的端点探了也没意义，反而会让"健康数"虚高，
 * 让人以为有更多可用后端。
 */
/**
 * 通知探测结果（给唤醒引擎用）。
 *
 * **吞掉观察者的异常** —— 它是观察者，不是链路的一部分。
 * 让"上报端点挂了"的失败带崩整个探测循环的话，面板会永久停在旧值上，且没人知道。
 */
function notifyProbe(options: EndpointHealthOptions, endpointName: string, ok: boolean, error?: string): void {
  const callback = options.onProbeResult
  if (callback === undefined) return
  try {
    callback(endpointName, ok, error)
  } catch (error_) {
    ;(options.log ?? ((): void => {}))(`端点健康观察者抛异常（已忽略）：${String(error_)}`)
  }
}

/**
 * ★ 目录漂移：清单里声明、但上游**已经不认**的模型。
 *
 * ## 为什么必须有这个检查
 *
 * 2026-10-09 实测发现：`packages/contracts/src/opencode-go.ts` 的授权清单里写着
 * `space-bunny-free`，L1 降级链的最后一档还指着它 —— 而上游
 * `GET https://opencode.ai/zen/go/v1/models` 返回的 45 个模型里**没有这个 id**，
 * 只有 `space-bunny`（免费档被撤了）。
 *
 * 复核期机制（`free.recheckDays`）**挡不住这种情况**：它只看时间，
 * 不看模型还在不在。于是清单会一路烂下去，直到某天降级链真的走到那一档，
 * 报回来一个看起来像网络故障的 404。
 *
 * 探测本来就已经拿到了上游的真实清单 —— 不比对一下纯属浪费。
 *
 * ## 只报「声明了但上游没有」，不报「上游有但没声明」
 *
 * 后者是**预期**的：Go 计划给几十个模型，我们只授权其中几个（能用 ≠ 允许用）。
 * 把它也报出来只会刷屏，把真正的漂移淹掉。
 *
 * ⚠ 漂移**不改变端点健康判定**：端点本身好好的，烂的是我们这边的目录。
 * 因为目录陈旧就把端点标红，会让路由避开一个完全可用的后端。
 */
function missingDeclaredModels(declaredJson: string | null, live: readonly string[]): readonly string[] {
  if (declaredJson === null || declaredJson.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(declaredJson)
  } catch {
    // 字段坏了不在这里报 —— 那是配置校验的事，不是探测的事
    return []
  }
  if (!Array.isArray(parsed)) return []
  const liveSet = new Set(live)
  const missing: string[] = []
  for (const item of parsed) {
    // 两种写法都容忍：`["a","b"]` 与 `[{"id":"a"},...]`
    const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id !== '' && !liveSet.has(id)) missing.push(id)
  }
  return missing
}

export async function probeAllEndpoints(options: EndpointHealthOptions): Promise<readonly EndpointProbeResult[]> {
  const log = options.log ?? ((): void => {})
  const rows = options.db
    .prepare('SELECT id, base_url, api_key_ref, models FROM inference_endpoints WHERE enabled = 1 ORDER BY id')
    .all() as { id: string; base_url: string; api_key_ref: string | null; models: string | null }[]

  if (rows.length === 0) {
    log('端点健康探测：没有启用的端点，跳过（不写任何 health 值 —— 让面板继续显示「从未探测」而不是假装健康）')
    return []
  }

  const results: EndpointProbeResult[] = []
  for (const row of rows) {
    const probe = await probeEndpoint(row.base_url, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })

    if (probe.ok) {
      // ★ 连通之后**还要查额度**：能调用 ≠ 有钱可用。
      //   余额为 0 时路由照样全线失败，而面板会显示"健康" —— 那是假绿灯，比红灯更危险。
      const quota = await probeQuota({
        baseUrl: row.base_url,
        keyRef: row.api_key_ref,
        ...(options.quotaFetchImpl === undefined ? {} : { fetchImpl: options.quotaFetchImpl }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      const quotaOk = !quotaBlocksRouting(quota)
      const drift = missingDeclaredModels(row.models, probe.models)
      const driftNote = drift.length === 0 ? '' : `；⚠ 目录漂移：${String(drift.length)} 个已声明模型上游不认（${drift.join('、')}）`
      const note = `连通（${String(probe.models.length)} 个模型）；${describeQuota(quota)}${driftNote}`

      // 额度用尽 ⇒ 整个端点判为**不健康**（否则路由会一直选它然后全线失败）。
      // 但"额度偏低"仍算健康 —— 一低就拦会让系统在还能用的时候提前瘫掉。
      recordEndpointHealth(options.db, row.id, { ok: quotaOk, latencyMs: probe.latencyMs, note })
      recordEndpointProbe(options.db, { endpointId: row.id, model: null, ok: quotaOk, latencyMs: probe.latencyMs, note, models: probe.models })
      log(`端点 ${row.id} ${quotaOk ? '健康' : '额度用尽'}（${String(probe.latencyMs)}ms）；${describeQuota(quota)}`)
      // ★ 漂移单独吼一声，而且**不改健康判定**：端点没坏，是我们这边的目录烂了。
      //   写进 note 只是给面板看，真正要修的是 packages/contracts/src/opencode-go.ts。
      if (drift.length > 0) {
        log(
          `⚠ 端点 ${row.id} 目录漂移：${drift.join('、')} 已不在上游模型清单里。` +
            `路由指到它们必然 404（且错误看起来像网络故障）—— 请更新 packages/contracts/src/opencode-go.ts 并重播种。`,
        )
      }
      notifyProbe(options, row.id, quotaOk, quotaOk ? undefined : '额度用尽')
      results.push({ endpointId: row.id, ok: quotaOk, latencyMs: probe.latencyMs, models: probe.models, note })
    } else {
      recordEndpointHealth(options.db, row.id, { ok: false, latencyMs: probe.latencyMs, note: probe.error })
      recordEndpointProbe(options.db, { endpointId: row.id, model: null, ok: false, latencyMs: probe.latencyMs, note: probe.error })
      log(`端点 ${row.id} 不健康：${probe.error}`)
      notifyProbe(options, row.id, false, probe.error)
      results.push({ endpointId: row.id, ok: false, latencyMs: probe.latencyMs, error: probe.error })
    }
  }
  return results
}

/**
 * 起一个定时探测循环。
 *
 * 首次探测**立刻**跑（不等一个周期）：否则刚启动的那几分钟面板还是 0，
 * 而"刚部署完看到 0"正是最容易让人以为坏了的时候。
 *
 * @returns 停止函数。
 */
export function startEndpointHealthLoop(options: EndpointHealthOptions & { readonly intervalMs?: number }): () => void {
  const intervalMs = Math.max(30_000, options.intervalMs ?? 5 * 60_000)
  const log = options.log ?? ((): void => {})
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      await probeAllEndpoints(options)
    } catch (error) {
      // 探测循环绝不能因为一次异常就死掉 —— 那样面板会永久停在旧值上，且没人知道
      log(`端点健康探测异常（循环继续）：${String(error)}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  void tick()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
