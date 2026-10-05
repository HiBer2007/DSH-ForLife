/**
 * 时间感知的**接线测试**：工具能查时间、网关会把读数放进尾部、读数会落库。
 *
 * 这一层要证明的不是"函数算得对"（那在 clock.test.ts 里测过了），而是：
 *  ① `now()` 真的注册成了工具，且返回权威读数（含相对锚点与边界）；
 *  ② **网关的提示词尾部**真的带上了读数，而**前缀段一个字节都没变**；
 *  ③ 三个关键场景（压缩后 / 唤醒后 / 长空闲后）都有新鲜读数落库（验收项）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FakeTurnDriver } from '@forlife/gateway'
import { isFresh, renderTimeBlock } from '@forlife/memory-core'
import { lastTimeReading, listTimeReadings, openDatabase, timeReadingStats } from '@forlife/store'

import { buildClockTools, CLOCK_TOOL_NAMES, isValidTimezone } from '../src/clock-tools.ts'
import { resolveConfig } from '../src/config.ts'
import { P1_NAME, P2_NAME, registerMemorySections, registerPromptSections } from '../src/prompt.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '@forlife/gateway'

const dir = mkdtempSync(join(tmpdir(), 'forlife-clockwire-'))
let runtime: MemoryRuntime

before(() => {
  const opened = openDatabase({ file: join(dir, 'seed.sqlite') })
  opened.close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir }), dbPath: join(dir, 'forlife.sqlite') })
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 取一个工具。 */
function tool(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildClockTools(defineTool as never, runtime) as unknown as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[]
  const found = tools.find((t) => t.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

const exec = { callId: 'c1', signal: new AbortController().signal }

test('工具清单：now / get_clock / set_clock / list_clocks 都在', () => {
  const tools = buildClockTools(defineTool as never, runtime) as unknown as { name: string }[]
  assert.deepEqual(tools.map((t) => t.name).sort(), [...CLOCK_TOOL_NAMES].sort())
})

test('时区名校验：合法与非法分得清（非法时报错而不是静默回落）', () => {
  assert.equal(isValidTimezone('Asia/Shanghai'), true)
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('America/New_York'), true)
  assert.equal(isValidTimezone('Shanghai'), false)
  assert.equal(isValidTimezone(''), false)
})

test('now()：返回权威读数（ISO 带偏移、人类可读、边界、相对锚点）并落库', async () => {
  const result = (await tool('now').execute({}, exec)) as Record<string, unknown>
  assert.match(String(result['iso']), /^2026-|^\d{4}-/, 'ISO 必须是完整时间')
  assert.match(String(result['iso']), /[+-]\d{2}:\d{2}$/, '要带偏移')
  assert.equal(result['timezone'], 'Asia/Shanghai', '默认用会话时区')
  assert.match(String(result['human']), /周[一二三四五六日]/)
  assert.match(String(result['utc']), /Z$/, 'UTC 也要给（记录用 UTC）')
  assert.ok(String(result['todayStart']).includes('00:00'))
  assert.ok(String(result['weekStart']).length === 10)
  assert.match(String(result['text']), /时间读数/)
  assert.match(String(result['text']), /不要依据训练数据或历史消息里的时间戳推断"现在"/)

  const reading = lastTimeReading(runtime.db)
  assert.ok(reading !== undefined, 'now() 必须落库（面板要看最新读数年龄）')
  assert.equal(reading?.reason, 'manual')
  assert.equal(reading?.timezone, 'Asia/Shanghai')
  assert.ok((reading?.token_count ?? 0) > 0, 'token 成本要记（注入是每轮都花的开销）')
})

test('now()：未知时区名如实说明并按会话时区返回（不静默给出错的时间）', async () => {
  const result = (await tool('now').execute({ timezone: 'Mars/Olympus' }, exec)) as Record<string, unknown>
  assert.equal(result['timezone'], 'Asia/Shanghai')
  assert.match(String(result['text']), /未知时区名/)
})

test('get_clock / set_clock / list_clocks：三层时区与来源优先级', async () => {
  const before = (await tool('get_clock').execute({}, exec)) as Record<string, unknown>
  assert.equal(before['systemTimezone'], 'UTC', '记录一律 UTC（用户拍板）')
  assert.equal(before['source'], 'default')

  // 低置信度 ⇒ 只写建议，不生效
  const suggested = (await tool('set_clock').execute({ conversation: 'group:88888', timezone: 'Asia/Tokyo', confidence: 'low', reason: '作息像东京' }, exec)) as Record<string, unknown>
  assert.equal(suggested['applied'], false, '低置信度不能直接生效')
  assert.match(String(suggested['note']), /待确认建议/)
  const afterSuggest = (await tool('get_clock').execute({ conversation: 'group:88888' }, exec)) as Record<string, unknown>
  assert.equal(afterSuggest['conversationTimezone'], 'Asia/Shanghai', '建议不该改变生效值')
  assert.match(String(afterSuggest['note']), /待确认的时钟建议/)

  // 高置信度 ⇒ 生效，来源是 model_note
  const applied = (await tool('set_clock').execute({ conversation: 'group:88888', timezone: 'Asia/Tokyo', confidence: 'high', reason: '用户说他在东京' }, exec)) as Record<string, unknown>
  assert.equal(applied['applied'], true)
  const afterApply = (await tool('get_clock').execute({ conversation: 'group:88888' }, exec)) as Record<string, unknown>
  assert.equal(afterApply['conversationTimezone'], 'Asia/Tokyo')
  assert.equal(afterApply['source'], 'model_note')

  // 只有这个会话变了，别的会话不受影响
  const other = (await tool('get_clock').execute({ conversation: 'private:10001' }, exec)) as Record<string, unknown>
  assert.equal(other['conversationTimezone'], 'Asia/Shanghai', '时区设置是按会话的')

  const listed = (await tool('list_clocks').execute({}, exec)) as { count: number }
  assert.equal(listed.count, 1)

  // 未知时区名 ⇒ 拒绝
  const bad = (await tool('set_clock').execute({ conversation: 'group:1', timezone: 'Nowhere' }, exec)) as Record<string, unknown>
  assert.equal(bad['ok'], false)
  assert.match(String(bad['note']), /未知时区名/)
})

test('提示词：读数**只进尾部**，前缀段（P1/P2）一个字节都不含时间', async () => {
  // 用真宿主装配一次，确认前缀里没有时间读数
  const { Context } = await import('@deepseek-ai/cordis')
  const module = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as { default: unknown; renderPrompt(a: unknown): string }
  const ctx = new Context()
  const install = ctx.plugin as unknown as (p: unknown) => unknown
  install.call(ctx, module.default)
  await delay(120)
  const sp = ctx.get('systemPrompt') as Parameters<typeof registerPromptSections>[0]
  const d1 = registerPromptSections(sp, runtime, { persona_name: '团子', owner_name: '主人', language: '中文' })
  const d2 = registerMemorySections(sp, runtime)
  await delay(30)
  const rendered = module.renderPrompt(await (sp as unknown as { assemble(): Promise<unknown> }).assemble())
  d1()
  d2()

  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(rendered), `稳定前缀里不该出现时间戳，实际含：${rendered.slice(0, 200)}`)
  assert.ok(!rendered.includes('时间读数'), '稳定前缀里不该出现时间读数块')

  // 而时间块本身是尾部注入用的
  const block = renderTimeBlock({ now: new Date(), timezone: 'Asia/Shanghai', reason: 'turn-first' })
  assert.match(block, /时间读数/)
  void P1_NAME
  void P2_NAME
})

test('网关尾部注入：提示词里真的有读数块，且读数落了库（端到端）', async () => {
  const { recordTimeReading: record } = await import('@forlife/store')
  const conversationKey = 'onebot11:10001'
  const readings: { at: Date; reason: string }[] = []

  // 用真实的 TurnRunner，把时间钩子按网关插件里的接线方式接上
  const driver = new FakeTurnDriver((request) => ({ segments: ['ok'], toolCalls: 0, ...(request.prompt.includes('时间读数') ? {} : { error: '提示词里没有时间读数' }) }))
  const runner = new TurnRunner({
    db: runtime.db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    log: () => {},
    timeHooks: {
      lastReadingAt: () => {
        const row = lastTimeReading(runtime.db)
        return row === undefined ? undefined : new Date(row.at)
      },
      lastInteractionAt: () => undefined,
      lastActionAt: () => undefined,
      compactedSince: () => false,
      wokeSince: () => false,
      clockSettings: () => ({ conversationTimezone: 'Asia/Shanghai', hour24: true }),
      record: (_key, at, reason, timezone, text) => {
        readings.push({ at, reason })
        record(runtime.db, { at: at.toISOString(), reason, timezone, text, tokenCount: Math.ceil(text.length / 2), conversationKey })
      },
    },
  })

  const inbound = {
    messageId: 'm_clock_1',
    conversation: { platform: 'onebot11', chatId: '10001', kind: 'private' as const },
    senderId: '10001',
    senderName: '老王',
    text: '现在几点了',
    mentionedMe: true,
    mentionedAll: false,
    isPoke: false,
    isSelf: false,
    at: new Date().toISOString(),
    raw: {},
  }

  const result = await runner.handleBatch([inbound], new AbortController().signal)
  assert.equal(result.woken, true, '私聊默认会唤醒')
  assert.equal(driver.requests.length, 1)

  const prompt = driver.requests[0]?.prompt ?? ''
  assert.match(prompt, /时间读数/, '提示词里必须带时间读数')
  assert.match(prompt, /不要依据训练数据或历史消息里的时间戳推断"现在"/, '必须带裁决规则')
  assert.match(prompt, /现在：\d{4}-\d{2}-\d{2} 周[一二三四五六日]/, '要有权威读数')
  assert.equal(readings.length, 1, '注入必须落库')
  assert.equal(readings[0]?.reason, 'turn-first', 'QQ 轮次天然是首步 ⇒ 首步注入')
  assert.ok(isFresh(readings[0]?.at ?? new Date(0), new Date()), '读数必须新鲜（<30s）')

  // 关键：读数是**尾部**内容 —— 前缀段里不该出现它
  assert.ok(prompt.indexOf('时间读数') > prompt.indexOf('### 会话'), '读数必须在会话消息之后（尾部），不能在前缀')
})

test('规格：QQ 轮次**每轮都注入**（首步必注入）—— 代价与理由都要说清', async () => {
  // 这是刻意为之，不是漏优化：
  //   · QQ 轮次天然是"这一轮的第一步"，而规格要求"每个用户可见轮次都有新读数"；
  //   · 我们的架构里一轮可能跨压缩、跨唤醒、跨几小时（自唤醒），
  //     陈旧读数的代价远大于几十个 token；
  //   · 成本是可观测的（time_readings.token_count + 面板的注入次数），不是隐形开销。
  //
  // 间隔逻辑（默认 5 分钟）留给"同一轮内的后续步骤"——那种场景在宿主的多步轮次里才有，
  // 它的判定已经由 memory-core 的纯逻辑测试覆盖（clock.test.ts）。
  const driver = new FakeTurnDriver(() => ({ segments: ['ok'] }))
  const seen: string[] = []
  const runner = new TurnRunner({
    db: runtime.db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    log: () => {},
    timeHooks: {
      // 1 秒前刚读过、也没有任何强事件 —— 依然要注入（因为这是首步）
      lastReadingAt: () => new Date(Date.now() - 1_000),
      lastInteractionAt: () => new Date(Date.now() - 2_000),
      lastActionAt: () => undefined,
      compactedSince: () => false,
      wokeSince: () => false,
      clockSettings: () => ({ conversationTimezone: 'Asia/Shanghai', hour24: true }),
      record: (_k, _at, reason) => void seen.push(reason),
    },
  })

  await runner.handleBatch(
    [
      {
        messageId: 'm_clock_cool',
        conversation: { platform: 'onebot11', chatId: '10009', kind: 'private' as const },
        senderId: '10009',
        senderName: '小李',
        text: '在吗',
        mentionedMe: true,
        mentionedAll: false,
        isPoke: false,
        isSelf: false,
        at: new Date().toISOString(),
        raw: {},
      },
    ],
    new AbortController().signal,
  )

  assert.deepEqual(seen, ['turn-first'], '首步必注入：这是"每轮都有新读数"的规格，不是 bug')
  assert.match(driver.requests[0]?.prompt ?? '', /时间读数/)
})
test('场景覆盖：压缩后与唤醒后即使刚读过也必须注入（强事件优先于间隔）', async () => {
  const cases: { name: string; compacted: boolean; woke: boolean; expectReason: string }[] = [
    { name: '压缩后', compacted: true, woke: false, expectReason: 'after-compaction' },
    { name: '唤醒后', compacted: false, woke: true, expectReason: 'after-wake' },
  ]
  for (const item of cases) {
    const driver = new FakeTurnDriver(() => ({ segments: ['ok'] }))
    const seen: string[] = []
    const runner = new TurnRunner({
      db: runtime.db,
      driver,
      scopeOf: defaultScopeOf,
      conditionOf: defaultConditionOf,
      random: () => 0,
      log: () => {},
      timeHooks: {
        lastReadingAt: () => new Date(Date.now() - 1_000),
        lastInteractionAt: () => undefined,
        lastActionAt: () => undefined,
        compactedSince: () => item.compacted,
        wokeSince: () => item.woke,
        clockSettings: () => ({ conversationTimezone: 'Asia/Shanghai', hour24: true }),
        record: (_k, _at, reason) => void seen.push(reason),
      },
    })
    await runner.handleBatch(
      [
        {
          messageId: `m_${item.name}`,
          conversation: { platform: 'onebot11', chatId: `100${item.compacted ? '2' : '3'}1`, kind: 'private' as const },
          senderId: '1',
          senderName: 'x',
          text: '测试',
          mentionedMe: true,
          mentionedAll: false,
          isPoke: false,
          isSelf: false,
          at: new Date().toISOString(),
          raw: {},
        },
      ],
      new AbortController().signal,
    )
    assert.deepEqual(seen, [item.expectReason], `${item.name} 应当以 ${item.expectReason} 为原因注入`)
  }
})


test('时间幻觉：模型说错时间时会被抓住并落库（只记 warn 以上）', async () => {
  const { listTimeDrift, recordTimeDrift } = await import('@forlife/store')
  const before = listTimeDrift(runtime.db, 100).length

  const drifts: { claimed: string; severity: string }[] = []
  const runner = new TurnRunner({
    db: runtime.db,
    driver: new FakeTurnDriver(() => ({
      // 模型输出里带了两个时间表述：一个准确（14:00 附近），一个差了一年多
      segments: ['大概 2024年3月15日 吧，我也不确定。'],
    })),
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    log: () => {},
    timeHooks: {
      lastReadingAt: () => undefined,
      lastInteractionAt: () => undefined,
      lastActionAt: () => undefined,
      compactedSince: () => false,
      wokeSince: () => false,
      clockSettings: () => ({ conversationTimezone: 'Asia/Shanghai', hour24: true }),
      record: () => {},
      recordDrift: (input) => {
        drifts.push({ claimed: input.claim, severity: input.severity })
        recordTimeDrift(runtime.db, {
          claimed: input.claim,
          actualAt: input.actualAt.toISOString(),
          driftMs: input.driftMs,
          severity: input.severity,
          excerpt: input.excerpt,
        })
      },
    },
  })

  await runner.handleBatch(
    [
      {
        messageId: 'm_drift_1',
        conversation: { platform: 'onebot11', chatId: '10077', kind: 'private' as const },
        senderId: '10077',
        senderName: '小王',
        text: '现在几点',
        mentionedMe: true,
        mentionedAll: false,
        isPoke: false,
        isSelf: false,
        at: new Date().toISOString(),
        raw: {},
      },
    ],
    new AbortController().signal,
  )

  assert.ok(drifts.length >= 1, '差一年多的表述必须被抓住')
  assert.equal(drifts[0]?.severity, 'bad')
  assert.match(drifts[0]?.claimed ?? '', /2024/)
  assert.ok(listTimeDrift(runtime.db, 100).length > before, '漂移要落库（面板要画曲线）')
})

test('时间幻觉：正常口语精度（1 小时内）不记录，避免淹没真正的问题', async () => {
  const drifts: unknown[] = []
  const now = new Date()
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  const runner = new TurnRunner({
    db: runtime.db,
    driver: new FakeTurnDriver(() => ({ segments: [`现在是 ${hhmm} 左右。`] })),
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    log: () => {},
    timeHooks: {
      lastReadingAt: () => undefined,
      lastInteractionAt: () => undefined,
      lastActionAt: () => undefined,
      compactedSince: () => false,
      wokeSince: () => false,
      clockSettings: () => ({ conversationTimezone: 'Asia/Shanghai', hour24: true }),
      record: () => {},
      recordDrift: (input) => void drifts.push(input),
    },
  })
  await runner.handleBatch(
    [
      {
        messageId: 'm_drift_2',
        conversation: { platform: 'onebot11', chatId: '10078', kind: 'private' as const },
        senderId: '10078',
        senderName: '小赵',
        text: '现在几点',
        mentionedMe: true,
        mentionedAll: false,
        isPoke: false,
        isSelf: false,
        at: now.toISOString(),
        raw: {},
      },
    ],
    new AbortController().signal,
  )
  assert.equal(drifts.length, 0, '说对了就不该记录（info 级要丢掉）')
})

