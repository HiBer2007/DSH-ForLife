/**
 * 展示层格式化 —— 只做"给人看"的转换，不做业务判断。
 *
 * 所有函数都必须能接受 undefined / 非法值并返回一个安全字符串：
 * 界面上出现 "NaN" 或 "undefined" 是最伤信任的一种细节。
 */

/** 字节数 → 人能读的大小（1024 进制，保留 1 位小数）。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** 大数字加千分位；非数字返回占位符。 */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN')
}

/** token 数：上万时用 k 缩写（面板里空间宝贵）。 */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value < 10_000) return formatNumber(value)
  return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`
}

/** ISO 时间 → 相对时间（"3 分钟前"）。 */
export function formatRelative(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const diff = Date.now() - at
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))} 秒前`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}

/** ISO 时间 → 本地完整时间。 */
export function formatDateTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** 秒 → "3 天 4 小时"这类人读时长。 */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${Math.floor(seconds % 60)} 秒`
  return `${Math.floor(seconds)} 秒`
}

/** 百分比（0..1 → "23.5%"）。 */
export function formatPercent(ratio: number | undefined, digits = 1): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}
