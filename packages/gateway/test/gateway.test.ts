/**
 * 网关主循环的端到端测试：**用假 QQ 端 + 假模型**跑通整条链路。
 *
 * 这是阶段 3 能拿到的最强证据（除了真 NapCat + 真模型那一步）：
 * 真实 WebSocket + 真实 SQLite + 真实防抖/调度/串行/队列，
 * 只有"QQ 那头的手机"和"模型那头的大脑"是假的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { WebSocket } from 'ws'

import { openDatabase } from '@forlife/store'

import { FakeTurnDriver } from '../src/driver.ts'
import { Gateway } from '../src/gateway.ts'
import { OneBotTransport } from '../src/onebot.ts'
import { enqueueOutbound, getOutbound } from '../src/outbox.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-gw-'))
const port = 37100
let db: ReturnType<typeof openDatabase>['db']
let close: () => void
let transport: OneBotTransport
let gateway: Gateway
let client: WebSocket
let driver: FakeTurnDriver

/** 假 QQ 端收到的动作。 */
const actions: { action: string; params: Record<string, unknown>; echo: string }[] = []

before(async () => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  // 私聊 100%、群聊 @我 100%，让测试不受概率影响
  setWakeRule(db, '*', 'private_message', { enabled: true, probability: 100 }, 'admin')
  setWakeRule(db, '*', 'group_mention', { enabled: true, probability: 100 }, 'admin')

  driver = new FakeTurnDriver((request) => {
    // "模型"：把回复写成出站动作
    enqueueOutbound(db, {
      conversationKey: `${request.conversation.platform}:${request.conversation.chatId}`,
      // kind 必须显式给：会话键里没有它，猜错会把群消息发成私聊
      conversationKind: request.conversation.kind,
      kind: 'text',
      payload: { segments: [{ kind: 'text', text: `收到：${request.messages[0]?.text ?? ''}` }] },
    })
    return { segments: ['ok'], toolCalls: 1 }
  })

  transport = new OneBotTransport({ port, actionTimeoutMs: 2000 })
  await transport.start()

  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  gateway = new Gateway({ db, transport, runner, debounceMs: 120, outboxPollMs: 60, log: () => {} })
  gateway.start()

  client = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  client.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
    if (typeof parsed.action === 'string') {
      actions.push({ action: parsed.action, params: parsed.params ?? {}, echo: parsed.echo ?? '' })
      // 假 QQ 端立刻回成功（模拟平台已收到）
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9000 + actions.length }, echo: parsed.echo }))
    }
  })
  await delay(80)
})

after(async () => {
  await gateway.stop()
  client.close()
  await transport.stop()
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

/** 推一条 QQ 消息进来。 */
function pushMessage(options: { chatId: string; kind: 'private' | 'group'; text: string; messageId: string; mentionedMe?: boolean; senderId?: string }): void {
  client.send(
    JSON.stringify({
      post_type: 'message',
      message_type: options.kind,
      sub_type: options.kind === 'group' ? 'normal' : 'friend',
      time: Math.floor(Date.now() / 1000),
      self_id: 30001,
      ...(options.kind === 'group' ? { group_id: Number(options.chatId) } : {}),
      // 私聊里 chatId 就是对方的 QQ 号；群里才是群号 + 发信人。
      // （早先写死 user_id 会让所有私聊都落到同一个会话，测出来的是错的。）
      user_id: Number(options.senderId ?? (options.kind === 'private' ? options.chatId : '10001')),
      message_id: options.messageId,
      message: [
        ...(options.mentionedMe === true ? [{ type: 'at', data: { qq: '30001' } }] : []),
        { type: 'text', data: { text: options.text } },
      ],
      sender: { nickname: '老王' },
    }),
  )
}

test('端到端：QQ 消息进来 → 防抖 → 唤醒 → 轮次 → 出站发送 → 平台确认', async () => {
  const before = actions.length
  pushMessage({ chatId: '10001', kind: 'private', text: '你好', messageId: 'gw_1' })

  // 等防抖 + 调度 + 轮次 + 出站
  await delay(800)

  assert.equal(driver.requests.length >= 1, true, '模型必须被调用一次')
  assert.ok(driver.requests[0]?.prompt.includes('你好'))

  const sent = actions.slice(before).find((a) => a.action === 'send_private_msg')
  assert.ok(sent !== undefined, '回复必须真的通过 OneBot 发出去')
  assert.ok(JSON.stringify(sent.params).includes('收到：你好'), '发出去的内容应当是模型产出的那段')

  // 队列里的那一行应当被确认（送达确认的闭环）
  const outbox = db.prepare("SELECT * FROM qq_outbox WHERE conversation_key = ? ORDER BY sent_at DESC LIMIT 1").get('onebot11:10001') as Record<string, unknown>
  assert.equal(outbox['status'], 'sent', '平台已回执 ⇒ 队列行必须是 sent')
  assert.equal(outbox['confirmed'], 1)
  assert.ok(String(outbox['platform_msg_id']) !== '', '要带回平台消息 id')

  // 入站也落了库（崩溃可恢复）
  const inbound = db.prepare('SELECT * FROM qq_inbox WHERE id = ?').get('gw_1') as Record<string, unknown>
  assert.equal(inbound['text'], '你好')
  assert.equal(inbound['is_group'], 0)
})

test('端到端：同会话连发 5 条 → 防抖合并成一轮（PLAN §8.2 的验收项）', async () => {
  const beforeTurns = driver.requests.length
  for (let i = 1; i <= 5; i++) {
    pushMessage({ chatId: '10002', kind: 'private', text: `第 ${String(i)} 条`, messageId: `gw_b${String(i)}` })
    await delay(20) // 都在防抖窗口内
  }
  await delay(900)

  const newRequests = driver.requests.slice(beforeTurns)
  assert.equal(newRequests.length, 1, `5 条应当合并成 1 轮，实际 ${String(newRequests.length)} 轮`)
  assert.equal(newRequests[0]?.messages.length, 5, '这一轮里应当含全部 5 条')
})

test('端到端：群聊普通消息零唤醒（连模型都不调）', async () => {
  const beforeTurns = driver.requests.length
  pushMessage({ chatId: '88888', kind: 'group', text: '大家早上好呀', messageId: 'gw_g1' })
  await delay(600)
  assert.equal(driver.requests.length, beforeTurns, '默认群聊零唤醒 ⇒ 模型不该被调用')

  const pending = db.prepare('SELECT * FROM pending_messages WHERE conversation_key = ?').all('onebot11:88888') as unknown as unknown[]
  assert.equal(pending.length, 1, '不唤醒 ≠ 不知道：摘要要进待读池')
})

test('端到端：群里 @我 立刻唤醒并回复', async () => {
  const beforeTurns = driver.requests.length
  pushMessage({ chatId: '88888', kind: 'group', text: '帮我看看这个', messageId: 'gw_g2', mentionedMe: true })
  await delay(800)
  assert.equal(driver.requests.length, beforeTurns + 1, '@我 必须唤醒')
  const sent = actions.filter((a) => a.action === 'send_group_msg')
  assert.ok(sent.length >= 1, '群里的回复要走 send_group_msg')
})

test('网关状态：队列、轮次与出站统计可见（面板要看的）', () => {
  const state = gateway.state()
  assert.equal(state.running, true)
  assert.ok(state.turnsHandled >= 3, '至少处理过私聊 1 + 合并 5 条 1 + 群 @我 1')
  assert.ok(state.outboundSent >= 3, '发出的消息数要能统计')
  assert.equal(typeof state.queuedConversations, 'number')
})

test('崩溃自愈：卡在 sending 的行会被退回重发', async () => {
  // 手工造一条"上次崩溃留下的" sending 行
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:10009', conversationKind: 'private', kind: 'text', payload: { segments: [{ kind: 'text', text: '幸存消息' }] } })
  db.prepare("UPDATE qq_outbox SET status = 'sending', claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 120_000).toISOString(), id)
  await delay(400) // 等出站消费者跑几轮
  const row = getOutbound(db, id)
  assert.equal(row?.status, 'sent', '超过 30 秒的 sending 行应当被回收并最终发出去')
  assert.ok(actions.some((a) => JSON.stringify(a.params).includes('幸存消息')))
})

test('停网关：出站消费者停止工作（幂等停止）', async () => {
  await gateway.stop()
  const before = actions.length
  enqueueOutbound(db, { conversationKey: 'onebot11:10010', conversationKind: 'private', kind: 'text', payload: { segments: [{ kind: 'text', text: '停之后的' }] } })
  await delay(300)
  assert.equal(actions.length, before, '网关停了就不该再发送')
  await gateway.stop() // 再停一次不该报错
  gateway.start() // 恢复，供后续用例（当前是最后一个，保持整洁）
  await gateway.stop()
})




