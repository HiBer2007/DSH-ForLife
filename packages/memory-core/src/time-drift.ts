/**
 * 时间漂移抽取（阶段 4 交付物 7 的 P4 第 11 条）。
 *
 * 目标：把"时间幻觉"从感觉变成**可测指标**。做法是从模型输出里抓出它声称的时间，
 * 与当时真实读数比对，偏差记一条。
 *
 * ## 宁可漏报，不可误报
 *
 * 这个抽取器是**保守**的：只认几种明确的写法（`2026年10月5日`、`14:23`、
 * `下午三点`、`今天/昨天/明天`），拿不准就不抽。
 * 理由：误报会让人开始忽略这个指标，而"被忽略的指标"等于没有指标。
 * 所以每条记录都带 `excerpt`（上下文片段），便于人复核是不是误报。
 *
 * @module @forlife/memory-core/time-drift
 */

/** 抽到的一条时间表述。 */
export interface TimeClaim {
  /** 原始文本片段。 */
  readonly text: string
  /** 解析出的时刻（无法解析时为 undefined）。 */
  readonly at?: Date
  /** 解析依据（便于解释与排错）。 */
  readonly basis: string
  /** 是否只是相对表述（相对表述不做绝对比对）。 */
  readonly relative: boolean
}

/** 漂移判定结果。 */
export interface DriftFinding {
  readonly claim: TimeClaim
  readonly actualAt: Date
  /** 偏差毫秒（正 = 模型说的时间偏晚）。 */
  readonly driftMs: number
  readonly severity: 'info' | 'warn' | 'bad'
}

/** 中文数字 → 阿拉伯数字（时间表述里够用即可）。 */
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/** 解析中文钟点（`三点` / `十一点` / `十点半` / `三点一刻`）。 */
function parseChineseHour(text: string): { hour: number; minute: number } | undefined {
  const match = /([零一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|[零一二两三四五六七八九十]{1,3}分?)?/.exec(text)
  if (match === null) return undefined
  const raw = match[1] ?? ''
  let hour: number
  if (raw === '十') hour = 10
  else if (raw.length === 2 && raw.startsWith('十')) hour = 10 + (CN_DIGITS[raw[1] ?? ''] ?? 0)
  else if (raw.length === 2 && raw.endsWith('十')) hour = (CN_DIGITS[raw[0] ?? ''] ?? 0) * 10
  else if (raw.length === 3 && raw[1] === '十') hour = (CN_DIGITS[raw[0] ?? ''] ?? 0) * 10 + (CN_DIGITS[raw[2] ?? ''] ?? 0)
  else hour = CN_DIGITS[raw] ?? Number(raw)
  if (!Number.isFinite(hour)) return undefined

  const tail = match[2] ?? ''
  let minute = 0
  if (tail === '半') minute = 30
  else if (tail === '一刻') minute = 15
  else if (tail === '三刻') minute = 45
  else if (tail.endsWith('分')) minute = CN_DIGITS[tail.replace('分', '')] ?? Number(tail.replace('分', '')) ?? 0
  return { hour, minute: Number.isFinite(minute) ? minute : 0 }
}

/** 取某时刻在给定时区的年月日。 */
function ymd(at: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  const [year, month, day] = parts.split('-').map(Number)
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 }
}

/** 取某时刻在给定时区的钟点。 */
function hm(at: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  const [hour, minute] = parts.split(':').map(Number)
  return { hour: hour === 24 ? 0 : (hour ?? 0), minute: minute ?? 0 }
}

/**
 * 在时区里构造一个时刻（把"本地年月日时分"换算成 UTC 时刻）。
 *
 * 做法是先按 UTC 造一个，再按目标时区的偏移修正一次 —— 对分钟级精度足够，
 * 且不引入依赖。跨夏令时切换点的极端情况会有一小时误差，
 * 但那属于"模型说的本来就不精确"的量级。
 *
 * @param local - 本地年月日时分。
 * @param timezone - 时区。
 * @returns 时刻。
 */
function fromZoned(local: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
  const guess = new Date(naive)
  // 先看把 naive 当 UTC 时，目标时区显示的是什么，再修正差值
  const shown = hm(guess, timezone)
  const shownDay = ymd(guess, timezone)
  const shownNaive = Date.UTC(shownDay.year, shownDay.month - 1, shownDay.day, shown.hour, shown.minute)
  const offset = shownNaive - naive
  return new Date(naive - offset)
}

/**
 * 从一段文本里抽取时间表述（保守）。
 *
 * @param text - 模型输出。
 * @param now - 当前真实时刻。
 * @param timezone - 会话时区。
 * @returns 抽到的表述列表。
 */
export function extractTimeClaims(text: string, now: Date, timezone = 'Asia/Shanghai'): readonly TimeClaim[] {
  const claims: TimeClaim[] = []
  const today = ymd(now, timezone)

  // ① 完整日期：2026年10月5日 / 2026-10-05 / 2026/10/05
  for (const match of text.matchAll(/(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?/g)) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    claims.push({
      text: match[0],
      at: fromZoned({ year, month, day, hour: 12, minute: 0 }, timezone),
      basis: '完整日期',
      relative: false,
    })
  }

  // ② 今年是哪一年：`今年是 2024 年` / `2024年`
  for (const match of text.matchAll(/(?:今年(?:是|为)?\s*)?(\d{4})\s*年(?!\s*\d)/g)) {
    const year = Number(match[1])
    if (year < 1970 || year > 2200) continue
    // 已被 ① 覆盖的（带月日的）跳过
    if (claims.some((claim) => claim.text.includes(`${String(year)}年`) && claim.basis === '完整日期')) continue
    claims.push({
      text: match[0].trim(),
      at: fromZoned({ year, month: today.month, day: today.day, hour: 12, minute: 0 }, timezone),
      basis: '年份表述',
      relative: false,
    })
  }

  // ③ 钟点：14:23 / 下午三点 / 上午 9 点 30 分
  for (const match of text.matchAll(/(上午|下午|中午|凌晨|早上|晚上|傍晚)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g)) {
    const rawHour = Number(match[2])
    const minute = Number(match[3])
    const meridiem = match[1]
    const hour = adjustMeridiem(rawHour, meridiem)
    if (hour === undefined) continue
    claims.push({
      text: match[0],
      at: fromZoned({ ...today, hour, minute }, timezone),
      basis: `${meridiem ?? ''}${String(rawHour)}:${String(minute).padStart(2, '0')}`,
      relative: false,
    })
  }
  for (const match of text.matchAll(/(上午|下午|中午|凌晨|早上|晚上|傍晚)\s*([零一二两三四五六七八九十]{1,3}\s*点\s*(?:半|一刻|三刻|[零一二两三四五六七八九十]{1,3}分?)?)/g)) {
    const parsed = parseChineseHour(match[2] ?? '')
    if (parsed === undefined) continue
    const hour = adjustMeridiem(parsed.hour, match[1])
    if (hour === undefined) continue
    claims.push({
      text: `${match[1]}${match[2]}`.replace(/\s+/g, ''),
      at: fromZoned({ ...today, hour, minute: parsed.minute }, timezone),
      basis: `中文钟点（${match[1]}）`,
      relative: false,
    })
  }

  // ④ 相对表述：只标记，不做绝对比对（"三天前"依赖锚点，硬比会误报）
  // 中文数字也要认：人写「三天前」远比「3天前」多（第一版只认阿拉伯数字，漏掉了一大半）
  for (const match of text.matchAll(/(今天|昨天|前天|明天|后天|(?:\d+|[零一二两三四五六七八九十]+)\s*(?:秒|分钟|小时|天|周|个月|年)(?:前|后|之后|以前))/g)) {
    claims.push({ text: match[0], basis: '相对表述', relative: true })
  }

  return claims
}

/** 按上下午修正小时。 */
function adjustMeridiem(hour: number, meridiem?: string): number | undefined {
  if (hour < 0 || hour > 24) return undefined
  if (meridiem === undefined) return hour === 24 ? 0 : hour
  if (meridiem === '下午' || meridiem === '晚上' || meridiem === '傍晚') return hour < 12 ? hour + 12 : hour
  if (meridiem === '中午') return hour === 12 ? 12 : hour < 12 ? hour + 12 : hour
  if (meridiem === '上午' || meridiem === '早上' || meridiem === '凌晨') return hour === 12 ? 0 : hour
  return hour
}

/**
 * 判断漂移（只对可解析的绝对表述判定）。
 *
 * 阈值：1 小时以内算正常（人说话本来就不精确）；超过 1 小时 warn；超过 1 天 bad。
 *
 * @param claims - 抽到的表述。
 * @param actualAt - 真实时刻。
 * @param options - 阈值覆盖。
 * @returns 漂移发现（可能是空的）。
 */
export function findDrift(
  claims: readonly TimeClaim[],
  actualAt: Date,
  options: { readonly warnMs?: number; readonly badMs?: number } = {},
): readonly DriftFinding[] {
  const warnMs = options.warnMs ?? 3_600_000
  const badMs = options.badMs ?? 86_400_000
  const findings: DriftFinding[] = []
  for (const claim of claims) {
    if (claim.relative || claim.at === undefined) continue
    const driftMs = claim.at.getTime() - actualAt.getTime()
    const abs = Math.abs(driftMs)
    findings.push({
      claim,
      actualAt,
      driftMs,
      severity: abs >= badMs ? 'bad' : abs >= warnMs ? 'warn' : 'info',
    })
  }
  return findings
}

/**
 * 一句话结论（面板/日志用）。
 *
 * @param findings - 漂移发现。
 * @returns 结论。
 */
export function describeDrift(findings: readonly DriftFinding[]): string {
  if (findings.length === 0) return '没有可判定的时间表述（或都在容差内）。'
  const worst = findings.reduce((a, b) => (Math.abs(a.driftMs) >= Math.abs(b.driftMs) ? a : b))
  const minutes = Math.round(Math.abs(worst.driftMs) / 60_000)
  const direction = worst.driftMs > 0 ? '偏晚' : '偏早'
  return `共 ${String(findings.length)} 处时间表述，最大偏差 ${String(minutes)} 分钟（${direction}）：「${worst.claim.text}」`
}

