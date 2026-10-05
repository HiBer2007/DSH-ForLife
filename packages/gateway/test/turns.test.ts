/**
 * 端到端时序测试：**消息进 → 唤醒判定 → 轮次 → 出站动作 → 送达确认**。
 *
 * 这是阶段 3 最有价值的一条测试线：它把前面所有零件（防抖、串行、唤醒矩阵、动作队列、
 * 轮次驱动）串成一条真实链路，而**不需要真模型、也不需要真 QQ**（假驱动按剧本扮演模型）。
 * 缺了它，每次改时序都得人工点一遍。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { FakeTurnDriver, parseNdjson } from '../src/driver.ts'
import { claimPendingOutbound, confirmOutbound, enqueueOutbound, getOutbound, waitForConfirmation } from '../src/outbox.ts'
import { Debouncer, KeyedMutex } from '../src/timing.ts'
import { buildTurnPrompt, defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'
import type { InboundMessage } from '../src/transport.ts'
import { conversationKey } from '../src/transport.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-e2e-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
})

after(async () => {
  close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 造一条入站消息。 */
function inbound(partial: Partial<InboundMessage> & { text: string; chatId: string; kind: InboundMessage['conversation']['kind'] }): InboundMessage {
  return {
    messageId: `m_${Math.random().toString(36).slice(2, 8)}`,
    conversation: { platform: 'onebot11', chatId: partial.chatId, kind: partial.kind },
    senderId: '10001',
    senderName: '老王',
    mentionedMe: false,
    mentionedAll: false,
    isPoke: false,
    isSelf: false,
    at: new Date().toISOString(),
    raw: {},
    ...partial,
  }
}

test('提示词：每条消息都带会话标签（多会话单窗口的前提）', () => {
  const prompt = buildTurnPrompt(
    [
      inbound({ text: '在吗', chatId: '10001', kind: 'private' }),
      inbound({ text: '看这个', chatId: '88888', kind: 'group', mentionedMe: true }),
    ],
    { now: new Date('2026-10-05T12:00:00.000Z'), unreadSummary: '群里聊了 3 条（与你无关）' },
  )
  assert.ok(prompt.includes('onebot11:10001'), '私聊会话键必须在提示词里')
  assert.ok(prompt.includes('onebot11:88888'), '群会话键必须在提示词里')
  assert.ok(prompt.includes('私聊') && prompt.includes('群'))
  assert.ok(prompt.includes('@我'), '互动标记要显式写出来')
  assert.ok(prompt.includes('你被唤醒期间错过的消息'), '唤醒提示要带上"你错过了什么"')
  assert.ok(prompt.includes('conversation 参数必填'), '要提醒模型回复时必须指路')
})

test('条件映射：@我 / @全体 / 拍一拍 / 普通消息 各归各的（不派生）', () => {
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', mentionedMe: true })]), 'group_mention')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', mentionedAll: true })]), 'group_mention_all')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', isPoke: true })]), 'group_poke')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group' })]), 'group_message_any')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'private' })]), 'private_message')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'temp' })]), 'temp_message')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', mediaKind: 'image' })]), 'media_received')
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', mediaKind: 'file' })]), 'file_received')
  // 组合：既 @我 又 @全体 ⇒ 按 @我（更明确的信号优先），但两条规则各自仍独立存在
  assert.equal(defaultConditionOf([inbound({ text: 'x', chatId: '1', kind: 'group', mentionedMe: true, mentionedAll: true })]), 'group_mention')
})

test('端到端：私聊消息 → 唤醒 → 轮次（假驱动扮演模型）→ 出站队列 → 送达确认', async () => {
  const conversation = { platform: 'onebot11', chatId: '10001', kind: 'private' as const }

  // 假驱动"扮演模型"：用 qq_reply 的语义把回复写进动作队列
  const driver = new FakeTurnDriver((request) => {
    const outId = enqueueOutbound(db, {
      conversationKey: conversationKey(request.conversation),
      kind: 'text',
      payload: { segments: [{ kind: 'text', text: '在的，我是团子' }] },
    })
    return { segments: ['在的，我是团子'], toolCalls: 1, tokensIn: 120, tokensOut: 12, ...(outId === '' ? {} : {}) }
  })

  const runner = new TurnRunner({
    db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0.1, // 私聊 80% ⇒ 必中
    log: () => {},
  })

  const messages = [inbound({ text: '在吗', chatId: '10001', kind: 'private' })]
  const result = await runner.handleBatch(messages, new AbortController().signal)

  assert.equal(result.woken, true)
  assert.ok(result.turnId !== undefined)
  assert.equal(driver.requests.length, 1, '假驱动应当被调用一次')
  assert.ok(driver.requests[0]?.prompt.includes('在吗'))

  // 轮次记录完整（面板要看的耗时/token/工具调用次数）
  const turn = db.prepare('SELECT * FROM qq_turns WHERE id = ?').get(requireTurnId(result)) as Record<string, unknown>
  assert.equal(turn['status'], 'done')
  assert.equal(turn['tokens_in'], 120)
  assert.equal(turn['tokens_out'], 12)
  assert.equal(turn['tool_calls'], 1)
  assert.ok(turn['ended_at'] !== null)

  // 出站动作：网关认领 → 发送 → 确认
  const claimed = claimPendingOutbound(db, { limit: 10 })
  const outbound = claimed.find((row) => row.conversation_key === 'onebot11:10001')
  assert.ok(outbound !== undefined, '模型产出的动作必须在队列里等网关发送')
  const waiting = waitForConfirmation(db, outbound.id, { timeoutMs: 1000, pollMs: 20 })
  confirmOutbound(db, outbound.id, '555')
  const confirmation = await waiting
  assert.equal(confirmation.confirmed, true)
  assert.equal(confirmation.messageId, '555')
})

test('端到端：群聊普通消息零唤醒，但摘要进待读池', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: ['不该被调用'] }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, log: () => {} })
  const result = await runner.handleBatch([inbound({ text: '大家早上好', chatId: '99999', kind: 'group' })], new AbortController().signal)

  assert.equal(result.woken, false)
  assert.equal(result.reason, 'disabled')
  assert.equal(driver.requests.length, 0, '零唤醒时绝不能调用模型（这是用户最在意的成本边界）')

  const pending = db.prepare('SELECT * FROM pending_messages WHERE conversation_key = ?').all('onebot11:99999') as unknown as Record<string, unknown>[]
  assert.equal(pending.length, 1, '不唤醒 ≠ 不知道：摘要必须进待读池')
  assert.match(String(pending[0]?.['summary']), /大家早上好/)
})

test('端到端：@我 立即唤醒（同群，与普通消息互不影响）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: ['在'] }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0.99, log: () => {} })
  const result = await runner.handleBatch(
    [inbound({ text: '@我 帮我看下这个', chatId: '99999', kind: 'group', mentionedMe: true })],
    new AbortController().signal,
  )
  assert.equal(result.woken, true, '@我 100% ⇒ 即使随机数接近 1 也必须醒')
  assert.equal(driver.requests.length, 1)
})

test('端到端：模型要求挂起 ⇒ 轮次标记 deferred（§8.3 不提交、不追加记忆）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: [], deferred: { reason: '等外部任务', expectedMs: 60_000 } }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  const result = await runner.handleBatch([inbound({ text: '在', chatId: '10002', kind: 'private' })], new AbortController().signal)
  assert.equal(result.woken, true)

  const turn = db.prepare('SELECT * FROM qq_turns WHERE id = ?').get(requireTurnId(result)) as Record<string, unknown>
  assert.equal(turn['status'], 'deferred')
  assert.equal(turn['defer_reason'], '等外部任务')
  assert.ok(turn['defer_until'] !== null)
  assert.equal(turn['ended_at'], null, '挂起不是结束')
})

test('端到端：驱动抛错 ⇒ 轮次标记 failed 且错误入表（不静默丢失）', async () => {
  const driver = new FakeTurnDriver(() => {
    throw new Error('模型服务 503')
  })
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  const result = await runner.handleBatch([inbound({ text: '在', chatId: '10003', kind: 'private' })], new AbortController().signal)
  assert.equal(result.woken, true)
  assert.match(result.outcome?.error ?? '', /503/)
  const turn = db.prepare('SELECT * FROM qq_turns WHERE id = ?').get(requireTurnId(result)) as Record<string, unknown>
  assert.equal(turn['status'], 'failed')
  assert.match(String(turn['error']), /503/)
})

test('时序串联：防抖把连发 5 条合成一批 → 一轮 → 一条回复', async () => {
  let flushed: InboundMessage[] = []
  const clock = ((): { now: () => number; setTimer: (cb: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; advance: (ms: number) => void } => {
    let current = 0
    let seq = 0
    const timers = new Map<number, { at: number; cb: () => void }>()
    return {
      now: () => current,
      setTimer: (cb, ms) => {
        const id = ++seq
        timers.set(id, { at: current + ms, cb })
        return id
      },
      clearTimer: (h) => void timers.delete(h as number),
      advance: (ms) => {
        current += ms
        for (const [id, t] of [...timers.entries()]) {
          if (t.at <= current) {
            timers.delete(id)
            t.cb()
          }
        }
      },
    }
  })()

  const driver = new FakeTurnDriver((request) => {
    flushed = [...request.messages]
    enqueueOutbound(db, { conversationKey: conversationKey(request.conversation), kind: 'text', payload: { segments: [{ kind: 'text', text: '收到' }] } })
    return { segments: ['收到'], toolCalls: 1 }
  })
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0.1, log: () => {} })
  const debouncer = new Debouncer({
    windowMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (_key, ids) => {
      void ids
    },
  })

  for (let i = 1; i <= 5; i++) {
    debouncer.push('onebot11:10004', `msg${String(i)}`)
    clock.advance(400)
  }
  // 用真实的一批消息（模拟防抖合并结果）走一轮
  const batch = [1, 2, 3, 4, 5].map((i) => inbound({ text: `第 ${String(i)} 条`, chatId: '10004', kind: 'private' }))
  const result = await runner.handleBatch(batch, new AbortController().signal)

  assert.equal(result.woken, true)
  assert.equal(flushed.length, 5, '一轮里应当包含合并后的全部 5 条')
  assert.equal(driver.requests.length, 1, '5 条只触发一轮（这就是防抖的价值）')
  const turn = db.prepare('SELECT input_ids FROM qq_turns WHERE id = ?').get(requireTurnId(result)) as { input_ids: string }
  assert.equal((JSON.parse(input_ids_of(turn)) as unknown[]).length, 5, '轮次要记录这 5 条的 id（可追溯）')
})


/** 断言轮次一定有 id（否则测试本身就失效了），并收窄类型供 SQL 使用。 */
function requireTurnId(result: { readonly turnId?: string }): string {
  assert.ok(result.turnId !== undefined, '这一批必须产生轮次')
  return result.turnId
}

/** 取 input_ids 字段。 */
function input_ids_of(row: { input_ids: string }): string {
  return row.input_ids
}

test('串行：同会话的两个批次不会交叉（多会话单窗口的安全前提）', async () => {
  const mutex = new KeyedMutex()
  const order: string[] = []
  const driver = new FakeTurnDriver(async (request) => {
    order.push(`start:${request.prompt.includes('甲') ? 'A' : 'B'}`)
    await delay(30)
    order.push(`end:${request.prompt.includes('甲') ? 'A' : 'B'}`)
    return { segments: [] }
  })
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0.1, log: () => {} })
  const key = 'onebot11:10005'

  await Promise.all([
    mutex.run(key, async () => runner.handleBatch([inbound({ text: '甲', chatId: '10005', kind: 'private' })], new AbortController().signal)),
    mutex.run(key, async () => runner.handleBatch([inbound({ text: '乙', chatId: '10005', kind: 'private' })], new AbortController().signal)),
  ])

  assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B'], '同会话必须严格串行（否则回复会交叉错乱）')
})

test('NDJSON 解析：坏行不抛，好行正确解析', () => {
  assert.equal(parseNdjson(''), undefined)
  assert.equal(parseNdjson('   '), undefined)
  assert.equal(parseNdjson('这不是 JSON'), undefined)
  assert.equal(parseNdjson('[1,2]'), undefined, '数组不是事件对象')
  assert.deepEqual(parseNdjson('{"type":"text","text":"嗨"}'), { type: 'text', text: '嗨' })
})

test('规则可调：模型把某群 @我 概率降到 0 ⇒ 不再唤醒（但摘要进池）', async () => {
  setWakeRule(db, 'group:11111', 'group_mention', { probability: 0 }, 'model')
  const driver = new FakeTurnDriver(() => ({ segments: [] }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  const result = await runner.handleBatch([inbound({ text: '@我', chatId: '11111', kind: 'group', mentionedMe: true })], new AbortController().signal)
  assert.equal(result.woken, false)
  assert.equal(result.reason, 'disabled')
  assert.equal(driver.requests.length, 0)
})

test('噪音过滤接入：整批闲聊不进模型、不占待读池（§8.5）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: ['不该被调用'] }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  // 群里的"嗯嗯"（两字以内、没被 @）⇒ 噪音
  const result = await runner.handleBatch([inbound({ text: '嗯嗯', chatId: '77777', kind: 'group' })], new AbortController().signal)

  assert.equal(result.woken, false)
  assert.equal(result.reason, 'noise', '整批噪音应当直接被挡掉（连唤醒判定都不做）')
  assert.equal(driver.requests.length, 0)
  const pending = db.prepare('SELECT * FROM pending_messages WHERE conversation_key = ?').all('onebot11:77777') as unknown as unknown[]
  assert.equal(pending.length, 0, '噪音不该占待读池 —— 不值得回复的消息也不值得记')
})

test('噪音过滤接入：混合批次只把非噪音送进模型', async () => {
  const driver = new FakeTurnDriver((request) => {
    return { segments: [], toolCalls: 0, tokensIn: 0, tokensOut: 0, ...(request.messages.length === 1 ? {} : { error: '应当只收到 1 条' }) }
  })
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0.99, log: () => {} })
  const result = await runner.handleBatch(
    [
      inbound({ text: '嗯', chatId: '66666', kind: 'group' }), // 噪音
      inbound({ text: '@我 帮个忙', chatId: '66666', kind: 'group', mentionedMe: true }), // 真信号
    ],
    new AbortController().signal,
  )
  assert.equal(result.woken, true, '有真信号就该醒（噪音不该拖累判断）')
  assert.equal(driver.requests[0]?.messages.length, 1, '送进模型的只应有非噪音那条')
  assert.ok(driver.requests[0]?.prompt.includes('帮个忙'))
  assert.ok(!driver.requests[0]?.prompt.includes('嗯'), '噪音不进提示词')
})

test('噪音过滤关掉时可放行（排障用）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: [] }))
  const runner = new TurnRunner({
    db,
    driver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    disableNoiseFilter: true,
    log: () => {},
  })
  const result = await runner.handleBatch([inbound({ text: '嗯嗯', chatId: '55501', kind: 'private' })], new AbortController().signal)
  assert.equal(result.reason !== 'noise', true, '关掉过滤后不该再判噪音')
})

test('出站队列：网关未认领前动作一直留在队列（不丢）', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:10006', kind: 'text', payload: { segments: [{ kind: 'text', text: '排队中' }] } })
  assert.equal(getOutbound(db, id)?.status, 'pending')
  assert.equal(getOutbound(db, id)?.platform_msg_id, null)
})



