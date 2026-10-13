/**
 * 时间工具：`now()` 与三层时区（阶段 4 交付物 7/8）。
 *
 * ## `now()` 为什么是关键
 *
 * §2.15.1 根因 4 说得很直白：**没有任何"查时间"的工具** ⇒
 * 用户要求的"意识到应该去看看现在的时间"在能力上就不成立 —— 想查也没得查。
 * 所以这个工具不是锦上添花，它是"主动看时间"这个行为的**唯一实现方式**。
 *
 * 工具描述里写清了**调用条件**（任何涉及时间/日期/时长/相对时间/跨天判断的场景），
 * 因为模型不会无缘无故调一个只返回时间的工具。
 *
 * ## 三层时区（§2.16 用户拍板）
 *
 * | 层 | 含义 | 用户原话 |
 * | :--- | :--- | :--- |
 * | `systemTimezone` | 记录用 | "记录用 UTC" |
 * | `conversationTimezone` | 与这个人/这个群对话时怎么理解时间 | 需要按会话设置 |
 * | `displayTimezone` | 给人看的时候 | 面板/日志 |
 *
 * 优先级：用户明确设置 > 模型备注 > 小模型建议（低置信度只写 pending，不直接生效）。
 *
 * @module forlife-memory/clock-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { defaultFor } from '@forlife/contracts'
import {
  dateBounds,
  formatDuration,
  formatHuman,
  formatIsoWithOffset,
  formatRelative,
  renderTimeBlock,
  zonedParts,
} from '@forlife/memory-core'
import { lastTimeReading, nowIso, recordTimeReading, TIMEZONE_SOURCES } from '@forlife/store'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 文本结果。 */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 时钟工具名（测试与文档共用一份）。 */
export const CLOCK_TOOL_NAMES = ['now', 'get_clock', 'set_clock', 'list_clocks'] as const

/** 校验 IANA 时区名是否可用。 */
export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/**
 * 构造时间相关工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时。
 * @returns 工具定义数组。
 */
export function buildClockTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  /** 当前会话键（有 QQ 轮次时用它解析会话时区）。 */
  const scopeOf = (): string | undefined => runtime.currentConversationScope()

  /** 取生效的时钟设置（会话级覆盖 > 全局）。 */
  const settingsFor = (conversationKey?: string): ReturnType<MemoryRuntime['clockSettings']> =>
    runtime.clockSettings(conversationKey ?? scopeOf())

  const nowTool = defineTool({
    name: 'now',
    description: [
      'Read the current time (**the authoritative reading**). Anything involving time, dates, durations, relative time, "how long ago / from now",',
      'cross-day reasoning, or "today/yesterday/this week" **must call this first**; never infer from training data or from timestamps in earlier messages.',
      'Returns: ISO (with offset and zone), human-readable text, how long since the last interaction/action/reading, and today\'s and this week\'s boundaries.',
    ].join('\n'),
    parameters: {
      timezone: { type: 'string', description: 'Optional: read in a specific zone (IANA name, e.g. Asia/Tokyo). Defaults to the conversation zone.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iso: { type: 'string', required: true },
          utc: { type: 'string', required: true },
          human: { type: 'string', required: true },
          timezone: { type: 'string', required: true },
          weekday: { type: 'string', required: true },
          sinceLastInteraction: { type: 'string' },
          sinceLastAction: { type: 'string' },
          sinceLastReading: { type: 'string' },
          todayStart: { type: 'string', required: true },
          weekStart: { type: 'string', required: true },
          text: { type: 'string', required: true, description: 'The full reading block shown to the model (same format as the automatic injection).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { human: string; iso: string }
        return text(`${v.human}（${v.iso}）`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { timezone?: string }
      runtime.recordToolCall()
      const settings = settingsFor()
      const timezone = a.timezone ?? settings.conversationTimezone
      if (!isValidTimezone(timezone)) {
        // 明确报错而不是回落到默认：静默换时区会给出**错误的时间**，比没有更糟
        return {
          iso: formatIsoWithOffset(new Date(), settings.conversationTimezone),
          utc: new Date().toISOString(),
          human: formatHuman(new Date(), settings.conversationTimezone, settings.hour24),
          timezone: settings.conversationTimezone,
          weekday: zonedParts(new Date(), settings.conversationTimezone).weekday,
          todayStart: dateBounds(new Date(), settings.conversationTimezone).todayStart,
          weekStart: dateBounds(new Date(), settings.conversationTimezone).weekStart,
          text: `Unknown time zone name "${timezone}"; returned in the conversation zone (${settings.conversationTimezone}) instead.`,
        }
      }

      const now = new Date()
      const conversationKey = scopeOf()
      const lastReading = lastTimeReading(runtime.db)
      const lastInteraction = runtime.lastInteractionAt(conversationKey)
      const lastAction = runtime.lastActionAt()

      const block = renderTimeBlock({
        now,
        timezone,
        hour24: settings.hour24,
        reason: 'manual',
        ...(lastInteraction === undefined ? {} : { lastInteractionAt: lastInteraction }),
        ...(lastAction === undefined ? {} : { lastActionAt: lastAction }),
        ...(lastReading === undefined ? {} : { lastReadingAt: new Date(lastReading.at) }),
      })

      // 落库：面板要看到"最新读数年龄"，验收也要断言模型确实拿到了新鲜读数
      recordTimeReading(runtime.db, {
        at: now.toISOString(),
        reason: 'manual',
        timezone,
        text: block,
        tokenCount: Math.ceil(block.length / 2),
        sessionId: runtime.currentSessionId() ?? null,
        conversationKey: conversationKey ?? null,
      })

      const bounds = dateBounds(now, timezone)
      return {
        iso: formatIsoWithOffset(now, timezone),
        utc: now.toISOString(),
        human: formatHuman(now, timezone, settings.hour24),
        timezone,
        weekday: bounds.weekday,
        ...(lastInteraction === undefined ? {} : { sinceLastInteraction: formatRelative(lastInteraction, now) }),
        ...(lastAction === undefined ? {} : { sinceLastAction: formatRelative(lastAction, now) }),
        ...(lastReading === undefined ? {} : { sinceLastReading: formatDuration(now.getTime() - Date.parse(lastReading.at)) }),
        todayStart: bounds.todayStart,
        weekStart: bounds.weekStart,
        text: block,
      }
    },
  })

  const getClockTool = defineTool({
    name: 'get_clock',
    description: 'Show the clock settings in effect (system zone / conversation zone / display zone / 12- or 24-hour). Worth a look before saying what time it is.',
    parameters: {
      conversation: { type: 'string', description: 'Optional: look up one conversation\'s zone settings (e.g. group:88888).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          systemTimezone: { type: 'string', required: true },
          conversationTimezone: { type: 'string', required: true },
          displayTimezone: { type: 'string', required: true },
          hour24: { type: 'boolean', required: true },
          source: { type: 'string', required: true, description: 'Who set this conversation\'s zone.' },
          note: { type: 'string', description: 'Explanation shown when a pending suggestion exists.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { conversationTimezone: string; hour24: boolean; source: string }
        return text(`Conversation zone ${v.conversationTimezone} (${v.source}) | ${v.hour24 ? '24' : '12'}-hour clock`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation?: string }
      const settings = runtime.clockSettings(a.conversation ?? scopeOf())
      const pending = runtime.pendingClockSuggestion(a.conversation ?? scopeOf())
      return {
        systemTimezone: settings.systemTimezone,
        conversationTimezone: settings.conversationTimezone,
        displayTimezone: settings.displayTimezone,
        hour24: settings.hour24,
        source: settings.source,
        ...(pending === undefined ? {} : { note: `There is a pending clock suggestion (${pending.timezone}, confidence ${pending.confidence}) from ${pending.origin}; it takes effect only after confirmation.` }),
      }
    },
  })

  const setClockTool = defineTool({
    name: 'set_clock',
    description: [
      'Set the conversation time zone (use it when you can tell which zone the other side is in). **Records are always UTC**; this only affects how times are understood and phrased.',
      'Do not ask the user back just to guess a zone - infer from message content, daily routine or place names when you can; when you really cannot tell, leave it alone.',
      'For low-confidence judgements use suggest=true to record a "pending suggestion" instead of applying it (a wrong zone makes every time statement wrong).',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: 'Conversation key, e.g. group:88888 or private:10001.' },
      timezone: { type: 'string', required: true, description: 'IANA time zone name, e.g. Asia/Shanghai.' },
      hour24: { type: 'boolean', description: 'Whether to use a 24-hour clock.' },
      reason: { type: 'string', description: 'Why you judged it that way (kept for human review).' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence. low is automatically downgraded to a pending suggestion.' },
      suggest: { type: 'boolean', description: 'true = record a pending suggestion only; it does not take effect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          applied: { type: 'boolean', required: true, description: 'Whether it really took effect (false = only a suggestion was recorded).' },
          timezone: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { applied: boolean; timezone: string; note?: string }
        return text(v.applied ? `Conversation zone set to ${v.timezone}` : (v.note ?? `Recorded as a pending suggestion: ${v.timezone}`))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; timezone: string; hour24?: boolean; reason?: string; confidence?: 'high' | 'medium' | 'low'; suggest?: boolean }
      runtime.recordToolCall()
      if (!isValidTimezone(a.timezone)) {
        return { ok: false, applied: false, timezone: a.timezone, note: `Unknown time zone name "${a.timezone}"; nothing changed (silently switching zones yields wrong times, which is worse than none).` }
      }

      const lowConfidence = a.confidence === 'low'
      if (a.suggest === true || lowConfidence) {
        runtime.setPendingClockSuggestion(a.conversation, {
          timezone: a.timezone,
          confidence: a.confidence ?? 'low',
          origin: 'model',
          reason: a.reason ?? '',
        })
        return {
          ok: true,
          applied: false,
          timezone: a.timezone,
          note: `Recorded as a **pending suggestion** (not applied): ${a.reason ?? 'model judgement'}. Set it after a human confirms or more evidence appears.`,
        }
      }

      runtime.setConversationClock(a.conversation, {
        timezone: a.timezone,
        ...(a.hour24 === undefined ? {} : { hour24: a.hour24 }),
        source: 'model_note',
        reason: a.reason ?? '',
      })
      return { ok: true, applied: true, timezone: a.timezone, note: `Records stay UTC; only how times are understood and phrased changed. The source is marked model_note (user settings can override it).` }
    },
  })

  const listClocksTool = defineTool({
    name: 'list_clocks',
    description: 'List every conversation that has its own time zone (handy when you have friends across zones).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          clocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string' },
                timezone: { type: 'string' },
                hour24: { type: 'boolean' },
                source: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { count: number; clocks: { conversation: string; timezone: string }[] }
        if (v.count === 0) return text('No conversation has its own zone yet (all use the global default).')
        return text([`${String(v.count)} conversation(s):`, ...v.clocks.map((c) => `- ${c.conversation}: ${c.timezone}`)].join('\n'))
      },
    },
    execute: async (): Promise<unknown> => {
      const clocks = runtime.listConversationClocks()
      return {
        ok: true,
        count: clocks.length,
        clocks: clocks.map((c) => ({
          conversation: c.scope,
          timezone: c.timezone,
          hour24: c.hour24,
          source: c.source,
          reason: c.reason,
        })),
      }
    },
  })

  return [nowTool, getClockTool, setClockTool, listClocksTool]
}

/** 默认时钟设置（从保真度基线取，保证与文档一致）。 */
export function defaultClockConfig(): { systemTimezone: string; conversationTimezone: string; displayTimezone: string; hour24: boolean } {
  return {
    systemTimezone: defaultFor<string>('clock.systemTimezone'),
    conversationTimezone: defaultFor<string>('clock.conversationTimezone'),
    displayTimezone: defaultFor<string>('clock.displayTimezone'),
    hour24: defaultFor<boolean>('clock.hour24'),
  }
}

/** 供测试引用：允许的来源。 */
export { TIMEZONE_SOURCES }
