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
      '取当前时间（**权威读数**）。任何涉及时间、日期、时长、相对时间、"多久以前/以后"、',
      '跨天判断、"今天/昨天/这周"的场景都**必须先调用它**，不要依据训练数据或历史消息里的时间戳推断。',
      '返回：ISO（带偏移与时区）、人类可读、距上次交互/上次行动/上次读数多久、今天与本周的边界。',
    ].join('\n'),
    parameters: {
      timezone: { type: 'string', description: '可选：按指定时区读数（IANA 名，如 Asia/Tokyo）。默认用会话时区。' },
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
          text: { type: 'string', required: true, description: '给模型看的完整读数块（与自动注入同格式）。' },
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
          text: `未知时区名「${timezone}」，已按会话时区（${settings.conversationTimezone}）返回。`,
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
    description: '看当前生效的时钟设置（系统时区 / 会话时区 / 展示时区 / 12 或 24 小时制）。涉及"现在几点"的表述前值得看一眼。',
    parameters: {
      conversation: { type: 'string', description: '可选：查某个会话的时区设置（如 group:88888）。' },
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
          source: { type: 'string', required: true, description: '这个会话时区是谁定的。' },
          note: { type: 'string', description: '有候选建议时的说明。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { conversationTimezone: string; hour24: boolean; source: string }
        return text(`会话时区 ${v.conversationTimezone}（${v.source}）｜${v.hour24 ? '24' : '12'} 小时制`)
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
        ...(pending === undefined ? {} : { note: `有一条待确认的时钟建议（${pending.timezone}，置信度 ${pending.confidence}）：来源是${pending.origin}。确认后才生效。` }),
      }
    },
  })

  const setClockTool = defineTool({
    name: 'set_clock',
    description: [
      '设置会话时区（你判断出对方在哪个时区时用）。**记录永远是 UTC**，这里只影响"怎么理解与表述时间"。',
      '不要为了猜时区去反问用户 —— 能从消息内容、作息、地名推断就推断；实在拿不准就别改。',
      '低置信度的判断请用 suggest=true 写成"待确认建议"，不要直接改（改错会让所有时间表述都错）。',
    ].join('\n'),
    parameters: {
      conversation: { type: 'string', required: true, description: '会话键，如 group:88888 或 private:10001。' },
      timezone: { type: 'string', required: true, description: 'IANA 时区名，如 Asia/Shanghai。' },
      hour24: { type: 'boolean', description: '是否 24 小时制。' },
      reason: { type: 'string', description: '为什么这么判断（留痕，便于人复核）。' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '置信度。low 会自动降级为待确认建议。' },
      suggest: { type: 'boolean', description: 'true = 只写待确认建议，不直接生效。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          applied: { type: 'boolean', required: true, description: '是否真的生效（false = 只写了建议）。' },
          timezone: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { applied: boolean; timezone: string; note?: string }
        return text(v.applied ? `会话时区已设为 ${v.timezone}` : (v.note ?? `已记为待确认建议：${v.timezone}`))
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { conversation: string; timezone: string; hour24?: boolean; reason?: string; confidence?: 'high' | 'medium' | 'low'; suggest?: boolean }
      runtime.recordToolCall()
      if (!isValidTimezone(a.timezone)) {
        return { ok: false, applied: false, timezone: a.timezone, note: `未知时区名「${a.timezone}」，没有改动（静默换时区会给出错误的时间，比没有更糟）。` }
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
          note: `已记为**待确认建议**（不生效）：${a.reason ?? '模型判断'}。等人确认或出现更多证据后再设。`,
        }
      }

      runtime.setConversationClock(a.conversation, {
        timezone: a.timezone,
        ...(a.hour24 === undefined ? {} : { hour24: a.hour24 }),
        source: 'model_note',
        reason: a.reason ?? '',
      })
      return { ok: true, applied: true, timezone: a.timezone, note: `记录仍为 UTC；只有"怎么理解与表述"变了。来源标记为 model_note（可被用户设置覆盖）。` }
    },
  })

  const listClocksTool = defineTool({
    name: 'list_clocks',
    description: '列出所有按会话设置过时区的地方（跨时区朋友多的时候用得上）。',
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
        if (v.count === 0) return text('还没有按会话设置过时区（都用全局默认）。')
        return text([`共 ${String(v.count)} 处：`, ...v.clocks.map((c) => `- ${c.conversation}：${c.timezone}`)].join('\n'))
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
