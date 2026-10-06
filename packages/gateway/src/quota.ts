/**
 * 端点额度查询（可扩展）。
 *
 * ## 为什么"能连通"不够
 *
 * 用户指出：**「检查端点不止需要检查可以调用，还要检查还有额度而不是钱包空空」**。
 * 连通性只说明端点活着；余额为 0 时路由照样全线失败，
 * 而面板会显示"健康" —— 那是**假绿灯**，比红灯更危险。
 *
 * ## 为什么要做成注册表而不是 if/else
 *
 * 各家的额度接口形状完全不同，而且会不断新增：
 *  - **OpenCode Go**：`GET {base}/usage` → 三个时间窗（rolling/weekly/monthly），
 *    每个带 `percent`（**已用**百分比）与 `resetsAt`。
 *  - **DeepSeek 官方**：`GET https://api.deepseek.com/user/balance` →
 *    `balance_infos[]` 带 `currency` 与 `total_balance`（**金额**，没有百分比）。
 *  - 本地端点：**没有额度这回事**，必须能被识别出来并跳过（而不是当成"不健康"）。
 *
 * 所以做成 `QuotaProvider` 注册表：新增一家只需加一个 provider，
 * 不用改探测主流程，也不用碰其它 provider 的解析逻辑。
 *
 * ## 一个必须注意的区别：percent 是"已用"还是"剩余"
 *
 * OpenCode Go 返回的 `percent` 是**已用**（22 表示用了 22%），
 * 而判断"快没钱了"要看**剩余**（78%）。
 * 这两个数一旦搞反，告警就会在**余额充足**时狂响、在**快没钱**时安静 ——
 * 完全反向。所以解析函数里把它显式换算成 `remainingPercent`，并写清楚。
 *
 * @module @forlife/gateway/quota
 */
import type { DatabaseSync } from 'node:sqlite'

/** 注入的 fetch。 */
export type QuotaFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

/** 一个时间窗的额度。 */
export interface QuotaWindow {
  readonly name: string
  /** **剩余**百分比（0–100）。注意不是接口返回的那个"已用"。 */
  readonly remainingPercent: number
  readonly resetsAt?: string
}

/** 一笔金额余额。 */
export interface QuotaBalance {
  readonly currency: string
  readonly total: string
}

/** 额度探测结果。 */
export type QuotaResult =
  | { readonly kind: 'windows'; readonly ok: boolean; readonly windows: readonly QuotaWindow[]; readonly note: string }
  | { readonly kind: 'balance'; readonly ok: boolean; readonly balances: readonly QuotaBalance[]; readonly note: string }
  /** 这家没有额度概念（如本地端点）—— **不是失败**。 */
  | { readonly kind: 'unsupported'; readonly ok: true; readonly note: string }
  /** 有额度接口但查不通（缺 key、网络、格式变了）—— 要如实说，不能假装健康。 */
  | { readonly kind: 'error'; readonly ok: false; readonly note: string }

/** 额度 provider。 */
export interface QuotaProvider {
  readonly id: string
  readonly label: string
  /** 这个端点是不是归我管。 */
  matches: (baseUrl: string) => boolean
  probe: (context: { readonly baseUrl: string; readonly apiKey?: string | undefined; readonly fetchImpl?: QuotaFetch }) => Promise<QuotaResult>
}

/** 剩余额度低于这个百分比就算"快没钱了"。 */
export const QUOTA_WARN_REMAINING_PERCENT = 15

/** 解析 OpenCode Go 的 `/usage` 响应。 */
export function parseOpenCodeGoUsage(payload: unknown): QuotaResult {
  const root = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const usage = root['usage'] !== null && typeof root['usage'] === 'object' ? (root['usage'] as Record<string, unknown>) : undefined
  if (usage === undefined) return { kind: 'error', ok: false, note: 'usage 响应里没有 usage 字段（接口形状可能变了）' }

  const windows: QuotaWindow[] = []
  for (const name of ['rolling', 'weekly', 'monthly']) {
    const raw = usage[name]
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const usedPercent = typeof entry['percent'] === 'number' ? entry['percent'] : undefined
    if (usedPercent === undefined) continue
    // ★ 接口给的是**已用**，这里换算成**剩余** —— 搞反会让告警完全反向
    const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
    windows.push({
      name,
      remainingPercent,
      ...(typeof entry['resetsAt'] === 'string' ? { resetsAt: entry['resetsAt'] } : {}),
    })
  }

  if (windows.length === 0) return { kind: 'error', ok: false, note: 'usage 响应里没有任何时间窗数据' }

  const lowest = windows.reduce((min, w) => (w.remainingPercent < min.remainingPercent ? w : min))
  const ok = lowest.remainingPercent > 0
  const note =
    lowest.remainingPercent > QUOTA_WARN_REMAINING_PERCENT
      ? `额度充足（最低 ${lowest.name} 剩 ${String(Math.round(lowest.remainingPercent))}%）`
      : lowest.remainingPercent > 0
        ? `额度偏低：${lowest.name} 仅剩 ${String(Math.round(lowest.remainingPercent))}%`
        : `额度已用尽：${lowest.name} 剩 0%`
  return { kind: 'windows', ok, windows, note }
}

/** 解析 DeepSeek 官方 `/user/balance` 响应。 */
export function parseDeepSeekBalance(payload: unknown): QuotaResult {
  const root = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const infos = Array.isArray(root['balance_infos']) ? root['balance_infos'] : []
  const balances: QuotaBalance[] = []
  for (const info of infos) {
    if (info === null || typeof info !== 'object') continue
    const entry = info as Record<string, unknown>
    const currency = typeof entry['currency'] === 'string' ? entry['currency'] : undefined
    const total = typeof entry['total_balance'] === 'string' ? entry['total_balance'] : undefined
    if (currency === undefined || total === undefined) continue
    balances.push({ currency, total })
  }
  if (balances.length === 0) {
    // DeepSeek 的 `is_available: false` 表示账户不可用（欠费/封禁）
    const available = root['is_available']
    if (available === false) return { kind: 'balance', ok: false, balances: [], note: '账户不可用（is_available=false）—— 可能是欠费' }
    return { kind: 'error', ok: false, note: 'balance 响应里没有 balance_infos（接口形状可能变了）' }
  }
  // **金额没有统一的"百分比"**，所以只能判"是不是 0"。
  // 不做"低于 X 元就告警"：不同币种、不同用量下那个阈值都是猜的。
  const allZero = balances.every((b) => Number(b.total) <= 0)
  const shown = balances.map((b) => `${b.total} ${b.currency}`).join(' / ')
  return {
    kind: 'balance',
    ok: !allZero,
    balances,
    note: allZero ? `余额为 0（${shown}）—— 钱包空空` : `余额 ${shown}`,
  }
}

/** 从环境变量里找端点对应的 key（端点只存引用名，不存明文）。 */
export function resolveApiKey(keyRef: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (keyRef === null || keyRef === undefined || keyRef.trim() === '') return undefined
  const value = env[keyRef.trim()]
  return value === undefined || value === '' ? undefined : value
}

/** OpenCode Go。 */
const openCodeGoProvider: QuotaProvider = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  matches: (baseUrl) => baseUrl.includes('opencode.ai'),
  probe: async ({ baseUrl, apiKey, fetchImpl }) => {
    if (apiKey === undefined) return { kind: 'error', ok: false, note: '没有可用的 API key（端点只存引用名，需环境变量里有值）' }
    const doFetch = fetchImpl ?? (globalThis.fetch as unknown as QuotaFetch)
    try {
      const response = await doFetch(`${baseUrl.replace(/\/$/, '')}/usage`, {
        headers: { authorization: `Bearer ${apiKey}`, 'user-agent': 'dsh-forlife/0.1', 'x-opencode-session': 'dsh-forlife-quota' },
        signal: AbortSignal.timeout(8000),
      })
      const text = await response.text()
      if (!response.ok) return { kind: 'error', ok: false, note: `额度查询失败 HTTP ${String(response.status)}：${text.slice(0, 120)}` }
      try {
        return parseOpenCodeGoUsage(JSON.parse(text))
      } catch {
        return { kind: 'error', ok: false, note: `额度响应不是 JSON：${text.slice(0, 120)}` }
      }
    } catch (error) {
      return { kind: 'error', ok: false, note: `额度查询异常：${String(error).slice(0, 140)}` }
    }
  },
}

/** DeepSeek 官方。 */
const deepSeekProvider: QuotaProvider = {
  id: 'deepseek',
  label: 'DeepSeek 官方',
  matches: (baseUrl) => baseUrl.includes('api.deepseek.com') || baseUrl.includes('deepseek.com'),
  probe: async ({ apiKey, fetchImpl }) => {
    if (apiKey === undefined) return { kind: 'error', ok: false, note: '没有可用的 API key' }
    const doFetch = fetchImpl ?? (globalThis.fetch as unknown as QuotaFetch)
    try {
      // 余额在**站点根**，不在 /v1 下 —— 拼错会拿到 404 并让人以为"接口没了"
      const response = await doFetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: `Bearer ${apiKey}`, 'user-agent': 'dsh-forlife/0.1' },
        signal: AbortSignal.timeout(8000),
      })
      const text = await response.text()
      if (!response.ok) return { kind: 'error', ok: false, note: `余额查询失败 HTTP ${String(response.status)}：${text.slice(0, 120)}` }
      try {
        return parseDeepSeekBalance(JSON.parse(text))
      } catch {
        return { kind: 'error', ok: false, note: `余额响应不是 JSON：${text.slice(0, 120)}` }
      }
    } catch (error) {
      return { kind: 'error', ok: false, note: `余额查询异常：${String(error).slice(0, 140)}` }
    }
  },
}

/**
 * 额度 provider 注册表。
 *
 * 新增一家（如 Anthropic / 智谱 / 月之暗面）只需在这里加一项 ——
 * 探测主流程与其它 provider 都不用动。
 */
export const QUOTA_PROVIDERS: readonly QuotaProvider[] = [openCodeGoProvider, deepSeekProvider]

/** 找到管这个端点的 provider。 */
export function resolveQuotaProvider(baseUrl: string): QuotaProvider | undefined {
  return QUOTA_PROVIDERS.find((provider) => provider.matches(baseUrl))
}

/** 对一个端点查额度。 */
export async function probeQuota(input: {
  readonly baseUrl: string
  readonly keyRef?: string | null | undefined
  readonly fetchImpl?: QuotaFetch
  readonly env?: NodeJS.ProcessEnv
}): Promise<QuotaResult> {
  const provider = resolveQuotaProvider(input.baseUrl)
  if (provider === undefined) {
    // **本地端点走这里**：没有额度概念，不是失败。
    // 若把它当"不健康"，本地模型就会被面板标红，而它其实好好的。
    return { kind: 'unsupported', ok: true, note: '这家没有额度接口（本地端点通常如此），跳过额度检查' }
  }
  const apiKey = resolveApiKey(input.keyRef, input.env)
  return await provider.probe({
    baseUrl: input.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
}

/** 把额度结果写进端点的健康备注（供面板显示）。 */
export function describeQuota(result: QuotaResult): string {
  switch (result.kind) {
    case 'windows':
      return result.note
    case 'balance':
      return result.note
    case 'unsupported':
      return result.note
    case 'error':
      return `额度未知：${result.note}`
  }
}

/** 便于调用方判断"该不该拦"。 */
export function quotaBlocksRouting(result: QuotaResult): boolean {
  return !result.ok
}

/** 占位：让调用方知道 db 参数是给未来持久化用的。 */
export type QuotaStore = DatabaseSync
