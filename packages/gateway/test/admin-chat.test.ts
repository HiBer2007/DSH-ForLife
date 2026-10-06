/**
 * 后台对话通道的测试 —— 铁律 2 的"唯一人类入口"必须被钉死。
 *
 * 守三件：
 *  ① 后台留言**不走唤醒判定**（面板里有人打字就是在直接跟你说话）；
 *  ② 模型的回答落在后台，**不会**跑到 QQ 去（渠道不能串）；
 *  ③ 人类消息的处理状态可追溯（谁说的、什么时候被看到、失败原因）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { ADMIN_CHAT_KEY, appendModelReply, buildAdminPrompt, listAdminChat, markHandled, pendingAdminCount, postHumanMessage, takePendingHumanMessages } from '../src/admin-chat.ts'
import { FakeTurnDriver } from '../src/driver.ts'
import { Gateway } from '../src/gateway.ts'
import { listOutbound } from '../src/outbox.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'
import type { QqTransport, TransportStatus } from '../src/transport.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-admin-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  // 把所有 QQ 唤醒条件关死：这样"模型被调用了"只可能来自后台对话
  setWakeRule(db, '*', 'private_message', { enabled: false }, 'admin')
  setWakeRule(db, '*', 'group_mention', { enabled: false }, 'admin')
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

/** 只记录、不做事的传输层（后台对话不该碰它）。 */
function inertTransport(): { transport: QqTransport; sent: unknown[] } {
  const sent: unknown[] = []
  const transport: QqTransport = {
    async start() {},
    async stop() {},
    onEvent: () => () => {},
    status: (): TransportStatus => ({ connected: false }),
    async sendMessage(_c, segments) {
      sent.push(segments)
      return { ok: true, messageId: 'x' }
    },
    async sendReaction() {
      return { ok: true }
    },
    async setInputStatus() {
      return { ok: true }
    },
    async mentionAll(_c, segments) {
      sent.push(segments)
      return { ok: true }
    },
    async getSelfInfo() {
      return undefined
    },
    async getAtAllRemain() {
      return undefined
    },
    getAtAllQuota: async () => ({ canAtAll: true, remainGroup: 5, remainAccount: 5 }),
    groupNotice: async () => ({ ok: true }),
    async deleteMessage() {
      return { ok: true }
    },
  }
  return { transport, sent }
}

test('入队与读取：人类消息带 actor 与时间，未处理状态可查', () => {
  const id = postHumanMessage(db, { actor: 'HiBer2007', text: '帮我看看今天群里聊了什么' })
  assert.ok(id.startsWith('adm_'))
  assert.equal(pendingAdminCount(db), 1)
  const pending = takePendingHumanMessages(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.role, 'human')
  assert.equal(pending[0]?.actor, 'HiBer2007')
  assert.equal(pending[0]?.handled, 0)
})

test('提示词：明确标注"这不是 QQ 消息"，并提醒不要用 qq_reply', () => {
  const prompt = buildAdminPrompt(
    [{ id: 'a', role: 'human', actor: 'HiBer2007', text: '在吗', at: '2026-10-05T10:00:00.000Z', handled: 0, turnId: null, error: null }],
    new Date('2026-10-05T10:00:01.000Z'),
  )
  assert.match(prompt, /后台对话/)
  assert.match(prompt, /不是 QQ 用户/)
  assert.match(prompt, /不要用 qq_reply 回复/, '渠道不能串：后台的答复要落在后台')
  assert.match(prompt, /HiBer2007：在吗/)
})

test('端到端：后台留言 → 直跑一轮 → 回答落在后台（**不走唤醒判定**）', async () => {
  const { transport, sent } = inertTransport()
  const driver = new FakeTurnDriver((request) => {
    assert.match(request.prompt, /后台对话/, '后台轮次用的是后台专用提示词')
    return { segments: ['今天群里主要在聊明天的会议'], toolCalls: 0, tokensIn: 50, tokensOut: 20 }
  })
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, log: () => {} })
  const gateway = new Gateway({ db, transport, runner, debounceMs: 60, outboxPollMs: 50, log: () => {} })
  gateway.start()

  postHumanMessage(db, { actor: 'HiBer2007', text: '今天群里聊了什么' })
  // 等后台消费循环
  for (let i = 0; i < 40 && driver.requests.length === 0; i++) await delay(50)
  await delay(200)
  await gateway.stop()

  assert.equal(driver.requests.length, 1, '后台留言必须直接触发一轮（不看唤醒概率）')
  const chat = listAdminChat(db, 10)
  const reply = chat.filter((m) => m.role === 'model')
  assert.equal(reply.length, 1, '回答必须落在后台对话里')
  assert.match(reply[0]?.text ?? '', /明天的会议/)
  assert.equal(sent.length, 0, '后台的答复绝不能跑到 QQ 去（渠道串了就是事故）')

  // 人类消息必须被标记已处理，并关联到轮次
  const human = db.prepare("SELECT * FROM admin_chat WHERE role = 'human' ORDER BY at DESC LIMIT 1").get() as Record<string, unknown>
  assert.equal(human['handled'], 1)
  assert.ok(String(human['turn_id']).startsWith('turn_admin_'))
})

test('轮次失败：原因写回后台（看得见，不静默吞掉）', async () => {
  const { transport } = inertTransport()
  const driver = new FakeTurnDriver(() => ({ error: '模型端点 503' }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, log: () => {} })
  const gateway = new Gateway({ db, transport, runner, debounceMs: 60, outboxPollMs: 50, log: () => {} })
  gateway.start()
  postHumanMessage(db, { actor: 'HiBer2007', text: '在吗' })
  for (let i = 0; i < 40 && driver.requests.length === 0; i++) await delay(50)
  await delay(250)
  await gateway.stop()

  const chat = listAdminChat(db, 10)
  const model = chat.filter((m) => m.role === 'model')
  assert.ok(model.some((m) => (m.text ?? '').includes('503')), '失败必须在面板里可见')
  const human = db.prepare("SELECT * FROM admin_chat WHERE role = 'human' ORDER BY at DESC LIMIT 1").get() as Record<string, unknown>
  assert.match(String(human['error']), /503/, '失败原因要挂在对应的人类消息上（可追溯）')
})

test('渠道隔离：后台对话不产生任何 qq_outbox 行', () => {
  const rows = listOutbound(db, 50).filter((row) => row.conversation_key === ADMIN_CHAT_KEY)
  assert.equal(rows.length, 0, '后台通道不该产出 QQ 出站动作')
})

test('未处理计数：面板红点用的数准确', () => {
  const before = pendingAdminCount(db)
  postHumanMessage(db, { actor: 'admin', text: '一' })
  postHumanMessage(db, { actor: 'admin', text: '二' })
  assert.equal(pendingAdminCount(db), before + 2)
  const pending = takePendingHumanMessages(db, 2)
  markHandled(db, pending.map((m) => m.id))
  assert.equal(pendingAdminCount(db), before, '标记后计数回落')
})

test('模型回复可带轮次关联（便于"这次回答对应哪次输入"）', () => {
  const id = appendModelReply(db, { text: '好的', turnId: 'turn_admin_x' })
  const row = db.prepare('SELECT * FROM admin_chat WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row['role'], 'model')
  assert.equal(row['turn_id'], 'turn_admin_x')
  assert.equal(row['handled'], 1, '模型回复不需要再被消费')
})
