/**
 * 时间感知的**纯逻辑**：格式化、相对锚点、边界、新鲜度判定。
 *
 * ## 为什么这块要自己做而不是直接用宿主插件
 *
 * EXECUTION_PLAN §2.15.1 查到的三个事实决定了必须自己做：
 *  ① `dsh-time-context` 只在 `dsh-web-app` 的 bundle 里，**而且那一行是 `disabled: true`**；
 *     我们的 QQ 轮次走 `dsh --profile ... headless`，连它都不加载 ⇒ 模型**拿不到任何时间读数**；
 *  ② 它的默认节流是 **10 分钟**，而我们的场景里有防抖合并、`defer_turn` 长挂起、
 *     自唤醒（可能隔几小时/几天才醒）—— 10 分钟在那些场景下完全不够；
 *  ③ 它的注入措辞是"日志式"的（`Time sampled while preparing turn <t>, step <s>`），
 *     模型得自己做映射和新鲜度判断，弱引导 ⇒ 模型倾向用自己的先验。
 *
 * 所以我们自己算、自己注入，并且把"读数有多新"**直接写成人话**（"这是 3 秒前的读数"），
 * 而不是让模型从 turn/step 推断。
 *
 * ## 一切时间都以"权威读数"为单一来源
 *
 * `now()` 工具、记忆条目的相对年龄、唤醒提示里的锚点、审计时间戳 ——
 * 全部走这里的函数，保证对外表述一致（否则模型会看到互相矛盾的三个"现在"）。
 *
 * @module @forlife/memory-core/clock
 */

/** 三个时区（§2.16）。 */
export interface ClockSettings {
  /** 系统时区：**记录一律 UTC**，这个只用于展示换算。 */
  readonly systemTimezone: string
  /** 会话时区：与这个人/这个群对话时用哪个时区理解时间。 */
  readonly conversationTimezone: string
  /** 展示时区：面板/日志给人看的时候用哪个。 */
  readonly displayTimezone: string
  /** 是否 24 小时制（false 用 12 小时制 + AM/PM）。 */
  readonly hour24: boolean
}

/** 默认设置（§2.16 用户拍板：记录用 UTC，会话默认东八区）。 */
export function defaultClockSettings(): ClockSettings {
  return {
    systemTimezone: 'UTC',
    conversationTimezone: 'Asia/Shanghai',
    displayTimezone: 'Asia/Shanghai',
    hour24: true,
  }
}

/** 一次"权威读数"。 */
export interface ClockReading {
  /** 读数时刻（UTC ISO，**存储与比较一律用它**）。 */
  readonly at: Date
  /** 会话时区（理解时间用它）。 */
  readonly timezone: string
  readonly hour24: boolean
}

/** 某个时区某时刻的字段。 */
interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: string
  /** 形如 `+08:00`。 */
  readonly offset: string
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/**
 * 取某时刻在某时区的本地字段。
 *
 * 用 `Intl` 而不是手写偏移表：夏令时、历史时区变更这些坑不该我们自己踩。
 *
 * @param at - 时刻。
 * @param timezone - IANA 时区名。
 * @returns 本地字段。
 */
export function zonedParts(at: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
    timeZoneName: 'longOffset',
  })
  const parts = formatter.formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const number = (type: string): number => Number(get(type))

  // `24` 是 Intl 在 hour12:false 下表示午夜的写法
  const hour = number('hour') === 24 ? 0 : number('hour')
  const weekdayText = get('weekday')
  const weekdayZh =
    WEEKDAYS_ZH[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayText)] ?? weekdayText

  const rawOffset = get('timeZoneName')
  const offset = rawOffset === '' || rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '')

  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour,
    minute: number('minute'),
    second: number('second'),
    weekday: weekdayZh,
    offset: offset === '' ? '+00:00' : offset,
  }
}

/** 把偏移格式化成 `+08:00`（`+8` → `+08:00`）。 */
function normalizeOffset(offset: string): string {
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(offset)
  if (match === null) return offset
  const sign = match[1] ?? '+'
  const hours = (match[2] ?? '0').padStart(2, '0')
  const minutes = (match[3] ?? '00').padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/** 人类可读的时间（`2026-10-05 周日 14:23`）。 */
export function formatHuman(at: Date, timezone: string, hour24 = true): string {
  const p = zonedParts(at, timezone)
  const pad = (n: number): string => String(n).padStart(2, '0')
  let time: string
  if (hour24) {
    time = `${pad(p.hour)}:${pad(p.minute)}`
  } else {
    const isPm = p.hour >= 12
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12
    time = `${String(h12)}:${pad(p.minute)} ${isPm ? 'PM' : 'AM'}`
  }
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)} ${p.weekday} ${time}`
}

/** ISO 8601 带偏移（`2026-10-05T14:23:01+08:00`）。 */
export function formatIsoWithOffset(at: Date, timezone: string): string {
  const p = zonedParts(at, timezone)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${String(p.year)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    normalizeOffset(p.offset)
  )
}

/** 时长的人话（不带方向；`formatRelative` 再按方向加"前/之后"）。 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (!Number.isFinite(abs)) return '时间未知'
  const seconds = Math.round(abs / 1000)
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时`
  const days = Math.round(hours / 24)
  if (days < 30) return `${String(days)} 天`
  const months = Math.round(days / 30)
  if (months < 12) return `${String(months)} 个月`
  return `${String(Math.round(months / 12))} 年`
}

/** "多久之前"的人话（系统算好，模型不必做算术）。 */
export function formatRelative(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime()
  if (!Number.isFinite(ms)) return '时间未知'
  if (ms < 0) {
    // 未来的时间戳：多半是对方设备时钟偏差。
    // 如实说出方向与原因，**不悄悄取绝对值**（那会把"时钟快了两分钟"伪装成"两分钟前"）。
    return `${formatDuration(ms)}之后（对方时钟可能快）`
  }
  return `${formatDuration(ms)}前`
}

/** 日期边界（会话时区下的今天起止与本周起止）。 */
export interface DateBounds {
  readonly todayStart: string
  readonly todayEnd: string
  readonly weekStart: string
  readonly weekday: string
  /** 是否是会话时区下的新的一天（跨天判断要用）。 */
  readonly isNewDay: boolean
}

/**
 * 算日期边界。
 *
 * @param at - 时刻。
 * @param timezone - 会话时区。
 * @param previous - 上一次读数（用于判断是否跨天）。
 * @returns 边界信息。
 */
export function dateBounds(at: Date, timezone: string, previous?: Date): DateBounds {
  const p = zonedParts(at, timezone)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dayKey = (d: Date): string => {
    const q = zonedParts(d, timezone)
    return `${String(q.year)}-${pad(q.month)}-${pad(q.day)}`
  }
  const todayKey = dayKey(at)
  // 本周起点：把"本周一"作为起点（中文语境里周一是第一天）
  const weekdayIndex = WEEKDAYS_ZH.indexOf(p.weekday as (typeof WEEKDAYS_ZH)[number])
  const daysSinceMonday = weekdayIndex === 0 ? 6 : weekdayIndex - 1
  const weekStartDate = new Date(at.getTime() - daysSinceMonday * 86_400_000)
  return {
    todayStart: `${todayKey} 00:00`,
    todayEnd: `${todayKey} 23:59`,
    weekStart: dayKey(weekStartDate),
    weekday: p.weekday,
    isNewDay: previous === undefined ? false : dayKey(previous) !== todayKey,
  }
}

/** 为什么注入（进日志与面板，也是验收要断言的"三个场景都有新鲜读数"）。 */
export type InjectionReason =
  | 'turn-first' // 每轮首步：必注入
  | 'interval' // 同轮后续步：跨过 N 分钟
  | 'date-boundary' // 跨天
  | 'after-compaction' // 压缩后：补回被遮蔽的锚点
  | 'after-wake' // 唤醒轮 / defer 恢复
  | 'after-idle' // 长期空闲后的首个消息
  | 'manual' // 模型自己调 now()

/** 注入判定上下文。 */
export interface InjectionContext {
  readonly now: Date
  /** 上一次读数的时刻（没有则视为"从未注入"）。 */
  readonly lastReadingAt?: Date
  /** 上一次交互时刻（用户消息/唤醒）。 */
  readonly lastInteractionAt?: Date
  readonly isTurnFirstStep: boolean
  readonly compactedSinceLastReading?: boolean
  readonly wokeSinceLastReading?: boolean
  readonly intervalMs?: number
  readonly idleThresholdMs?: number
}

/** 注入判定结果。 */
export interface InjectionDecision {
  readonly inject: boolean
  readonly reason?: InjectionReason
  /** 为什么**不**注入（排障要看"这轮为什么没给时间"）。 */
  readonly skipReason?: string
}

/**
 * 决定这一步要不要注入时间读数（§2.15.2 P2 的事件驱动表）。
 *
 * 判定顺序是有讲究的：先看"必须注入"的强事件（压缩后/唤醒/跨天/每轮首步），
 * 再看时间间隔。反过来会让强事件被间隔条件挡掉 —— 那正是宿主的 bug 来源。
 *
 * @param context - 判定上下文。
 * @returns 判定结果。
 */
export function decideInjection(context: InjectionContext): InjectionDecision {
  const { now, lastReadingAt } = context

  // 从未注入过 ⇒ 必须给（否则模型手里一个读数都没有）
  if (lastReadingAt === undefined) return { inject: true, reason: 'turn-first' }

  if (context.compactedSinceLastReading === true) return { inject: true, reason: 'after-compaction' }

  if (context.wokeSinceLastReading === true) return { inject: true, reason: 'after-wake' }

  const bounds = dateBounds(now, 'UTC', lastReadingAt)
  if (bounds.isNewDay) return { inject: true, reason: 'date-boundary' }

  const idleThresholdMs = context.idleThresholdMs ?? 30 * 60_000
  if (context.lastInteractionAt !== undefined && now.getTime() - context.lastInteractionAt.getTime() > idleThresholdMs) {
    return { inject: true, reason: 'after-idle' }
  }

  if (context.isTurnFirstStep) return { inject: true, reason: 'turn-first' }

  const intervalMs = context.intervalMs ?? 5 * 60_000
  const sinceReading = now.getTime() - lastReadingAt.getTime()
  if (sinceReading >= intervalMs) return { inject: true, reason: 'interval' }

  return {
    inject: false,
    skipReason: `距上次读数仅 ${formatRelative(lastReadingAt, now)}（阈值 ${String(Math.round(intervalMs / 60_000))} 分钟），且非首步/无强事件`,
  }
}

/** 读数的年龄（毫秒）。 */
export function readingAgeMs(reading: Date, now: Date): number {
  return Math.max(0, now.getTime() - reading.getTime())
}

/** 读数是否够新鲜（验收要求"最新读数年龄 < 30 s"）。 */
export function isFresh(reading: Date, now: Date, maxAgeMs = 30_000): boolean {
  return readingAgeMs(reading, now) <= maxAgeMs
}

/** 渲染成给模型看的时间块（**只进尾部，绝不进前缀**）。 */
export interface TimeBlockInput {
  readonly now: Date
  readonly timezone: string
  readonly hour24?: boolean
  readonly reason: InjectionReason
  readonly lastInteractionAt?: Date
  readonly lastActionAt?: Date
  readonly lastReadingAt?: Date
}

/**
 * 拼时间块（给模型的权威读数）。
 *
 * 措辞刻意是**权威式**而不是日志式（对照 §2.15.1 根因 3）：
 * 直接说"现在是 X（刚刚取到）"，而不是"采样于 turn 3, step 0"让模型自己映射。
 *
 * @param input - 输入。
 * @returns 文本块。
 */
export function renderTimeBlock(input: TimeBlockInput): string {
  const hour24 = input.hour24 ?? true
  const lines = [
    '【时间读数】（权威值，以下一律以它为准）',
    `现在：${formatHuman(input.now, input.timezone, hour24)}（${formatIsoWithOffset(input.now, input.timezone)}，时区 ${input.timezone}）`,
    `UTC：${input.now.toISOString()}`,
  ]
  if (input.lastReadingAt !== undefined) {
    lines.push(`上一条读数：${formatRelative(input.lastReadingAt, input.now)}`)
  }
  if (input.lastInteractionAt !== undefined) {
    lines.push(`距上次交互：${formatRelative(input.lastInteractionAt, input.now)}`)
  }
  if (input.lastActionAt !== undefined) {
    lines.push(`距上次行动：${formatRelative(input.lastActionAt, input.now)}`)
  }
  const bounds = dateBounds(input.now, input.timezone, input.lastReadingAt)
  lines.push(`今天：${bounds.todayStart} 起｜${bounds.weekday}｜本周开始于 ${bounds.weekStart}`)
  lines.push(
    '',
    `（本次读数原因：${describeReason(input.reason)}。涉及时间/日期/时长的判断请以本读数为准，` +
      '不要依据训练数据或历史消息里的时间戳推断"现在"。）',
  )
  return lines.join('\n')
}

/** 注入原因的人话。 */
export function describeReason(reason: InjectionReason): string {
  switch (reason) {
    case 'turn-first':
      return '本轮首次给你时间'
    case 'interval':
      return '距上次读数已超过间隔'
    case 'date-boundary':
      return '跨天了（日期变了）'
    case 'after-compaction':
      return '刚压缩过，旧的读数可能已被遮蔽'
    case 'after-wake':
      return '你刚被唤醒'
    case 'after-idle':
      return '闲置了一段时间后的第一条消息'
    case 'manual':
      return '你主动查了时间'
  }
}
