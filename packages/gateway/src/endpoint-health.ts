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
}

/** 探测配置。 */
export interface EndpointHealthOptions {
  readonly db: DatabaseSync
  readonly fetchImpl?: HealthFetch
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
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
export async function probeAllEndpoints(options: EndpointHealthOptions): Promise<readonly EndpointProbeResult[]> {
  const log = options.log ?? ((): void => {})
  const rows = options.db
    .prepare('SELECT id, base_url FROM inference_endpoints WHERE enabled = 1 ORDER BY id')
    .all() as { id: string; base_url: string }[]

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
      const note = `探测成功，发现 ${String(probe.models.length)} 个模型`
      recordEndpointHealth(options.db, row.id, { ok: true, latencyMs: probe.latencyMs, note })
      recordEndpointProbe(options.db, { endpointId: row.id, model: null, ok: true, latencyMs: probe.latencyMs, note, models: probe.models })
      log(`端点 ${row.id} 健康（${String(probe.latencyMs)}ms，${String(probe.models.length)} 个模型）`)
      results.push({ endpointId: row.id, ok: true, latencyMs: probe.latencyMs, models: probe.models })
    } else {
      recordEndpointHealth(options.db, row.id, { ok: false, latencyMs: probe.latencyMs, note: probe.error })
      recordEndpointProbe(options.db, { endpointId: row.id, model: null, ok: false, latencyMs: probe.latencyMs, note: probe.error })
      log(`端点 ${row.id} 不健康：${probe.error}`)
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
