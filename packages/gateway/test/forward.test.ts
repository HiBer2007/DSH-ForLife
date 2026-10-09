/**
 * 合并转发的**收 / 发**测试 —— 任务①的核心。
 *
 * ## 这个文件最重要的一条
 *
 * 「★ 端到端：她转发一段聊天记录给机器人 ⇒ **模型真的看到了内容**」。
 *
 * 它走的是**真实链路**：真 WebSocket + 真 SQLite + 真网关 + 真防抖/调度/轮次，
 * 只有"QQ 那头的手机"和"模型那头的大脑"是假的。
 * 而"QQ 那头"回的是**照着 NapCat 源码实测形状**编的帧：
 *
 *  - 入站消息里的合并转发段是 `{type:'forward', data:{id:'…'}}` ——
 *    **只有 id、没有 content**（线上 `parseMultMsg: false`，见 forward.ts 的模块头）；
 *  - `get_forward_msg` 的返回是 `{messages:[…]}`，元素是**完整消息对象**
 *    （`{user_id, time, sender:{nickname}, message:[段]}`）。
 *
 * 断言落在 `FakeTurnDriver.requests[0].prompt` 上 ——
 * 也就是"模型真正拿到的那段文字"。这是"内容没丢"唯一算数的证据。
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
import { buildForwardNodes, buildForwardNodesFromIds, parseForwardMessages } from '../src/forward.ts'
import { Gateway } from '../src/gateway.ts'
import { OneBotTransport } from '../src/onebot.ts'
import { enqueueOutbound } from '../src/outbox.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-fwd-'))
const port = 37160
let db: ReturnType<typeof openDatabase>['db']
let close: () => void
let transport: OneBotTransport
let gateway: Gateway
let client: WebSocket
let driver: FakeTurnDriver

/** 假 QQ 端收到的动作。 */
const actions: { action: string; params: Record<string, unknown> }[] = []
/**
 * `get_forward_msg` 的**剧本**：键是消息 id，值是协议端会返回的 `messages`。
 *
 * 形状照 NapCat 实测写：元素是完整消息对象，不是 node。
 */
let forwardScript: Record<string, unknown[]> = {}

before(async () => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  setWakeRule(db, '*', 'private_message', { enabled: true, probability: 100 }, 'admin')

  driver = new FakeTurnDriver(() => ({ segments: ['ok'], toolCalls: 0 }))
  transport = new OneBotTransport({ port, actionTimeoutMs: 2000 })
  await transport.start()

  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  gateway = new Gateway({ db, transport, runner, debounceMs: 80, outboxPollMs: 60, log: () => {} })
  gateway.start()

  client = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  client.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
    if (typeof parsed.action !== 'string') return
    actions.push({ action: parsed.action, params: parsed.params ?? {} })
    const data =
      parsed.action === 'get_forward_msg'
        ? { messages: forwardScript[String((parsed.params ?? {})['message_id'] ?? '')] ?? [] }
        : { message_id: 9000 + actions.length }
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: parsed.echo }))
  })
  await delay(60)
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

/** 推一条 QQ 消息进来（`message` 段数组原样给，方便造各种段）。 */
function pushMessage(messageId: string, message: unknown[]): void {
  client.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: 10001,
      self_id: 3112546448,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 10001, nickname: '小满' },
      message,
    }),
  )
}

/** 等某个条件成立（默认 2 秒）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
}

// ── 纯逻辑：发 ──────────────────────────────────────────────────────────────

test('buildForwardNodes：产出的一定是 `type:node`，且正文写在 `content` 而不是 `message`', () => {
  const built = buildForwardNodes([
    { name: '老王', userId: '10002', text: '明天开会' },
    { name: '小满', text: '收到', image: '/tmp/x.png' },
  ])
  assert.equal(built.ok, true)
  if (!built.ok) return
  for (const node of built.nodes) {
    assert.equal(node['type'], 'node', 'NapCat 的 check() 只接受纯 node 数组')
    const data = node['data'] as Record<string, unknown>
    // ★ 这条是本项目最容易踩的坑：写 `message` 会让节点变成**空消息**，
    //   而接口照样返回成功（"成功但空白"最难查）。NapCat 两条路径读的都是 content。
    assert.ok(Array.isArray(data['content']), '正文必须在 data.content')
    assert.equal(data['message'], undefined, '不能写 data.message —— NapCat 不读它')
    assert.ok((data['time'] as number) > 0, '时间要给（否则协议端用 Date.now，历史时间会乱）')
  }
  const first = built.nodes[0]?.['data'] as Record<string, unknown>
  assert.equal(first['nickname'], '老王')
  assert.equal(first['user_id'], '10002')
})

test('buildForwardNodes：空节点与超限**明确报错**，不是默默砍掉', () => {
  assert.equal(buildForwardNodes([]).ok, false)
  assert.equal(buildForwardNodes([{ text: '   ' }]).ok, false, '空节点在 QQ 上会显示成一条空白')
  const built = buildForwardNodes([{ name: 'a', text: 'hi' }])
  assert.equal(built.ok, true)
})

test('buildForwardNodesFromIds：按 id 原样转发（保留图片/语音）', () => {
  const built = buildForwardNodesFromIds(['7001', '7002'])
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.deepEqual(built.nodes, [
    { type: 'node', data: { id: '7001' } },
    { type: 'node', data: { id: '7002' } },
  ])
  assert.equal(buildForwardNodesFromIds(['']).ok, false)
})

// ── 纯逻辑：收 ──────────────────────────────────────────────────────────────

test('parseForwardMessages：认 NapCat 的**消息对象**形状（线上就是这个）', () => {
  // 形状照 napcat.mjs 的 parseMultiMessageContent（parseMessage(…, 'array', true)）实测写
  const parsed = parseForwardMessages([
    {
      user_id: 10002,
      time: 1700000000,
      message_id: 501,
      sender: { user_id: 10002, nickname: '小满', card: '满满' },
      message: [
        { type: 'text', data: { text: '你上次说的那个' } },
        { type: 'image', data: { file: 'x.jpg' } },
        { type: 'at', data: { qq: '3112546448' } },
      ],
    },
    {
      user_id: 10003,
      time: 1700000060,
      message_id: 502,
      sender: { user_id: 10003, nickname: '老王' },
      message: [{ type: 'text', data: { text: '嗯，我记得' } }],
    },
  ])
  assert.equal(parsed.nodeCount, 2)
  assert.match(parsed.text, /满满：你上次说的那个\[图片\]@3112546448/)
  assert.match(parsed.text, /老王：嗯，我记得/)
  assert.deepEqual(parsed.notes, [], '完整还原时不该有告警')
})

test('parseForwardMessages：也认 node 形状（go-cqhttp 兼容）', () => {
  const parsed = parseForwardMessages([
    { type: 'node', data: { user_id: 1, nickname: '甲', content: [{ type: 'text', data: { text: '一' } }] } },
    { type: 'node', data: { user_id: 2, nickname: '乙', message: [{ type: 'text', data: { text: '二' } }] } },
  ])
  assert.equal(parsed.nodeCount, 2)
  assert.match(parsed.text, /甲：一/)
  assert.match(parsed.text, /乙：二/)
})

test('parseForwardMessages：**没认出来的段必须记进 notes**（不许静默丢）', () => {
  const parsed = parseForwardMessages([
    { user_id: 1, sender: { nickname: '甲' }, message: [{ type: 'mface', data: {} }, { type: 'text', data: { text: '正文' } }] },
  ])
  assert.match(parsed.text, /\[mface\]/)
  assert.equal(parsed.notes.length, 1, '未渲染的段要如实说')
  assert.match(parsed.notes[0] ?? '', /mface/)
})

test('parseForwardMessages：空数组不是"成功但没内容"，而是**明确说明**', () => {
  const parsed = parseForwardMessages([])
  assert.equal(parsed.nodeCount, 0)
  assert.match(parsed.notes[0] ?? '', /没有任何消息/)
})

// ── ★★ 端到端：她转发一段聊天记录 ⇒ 模型看得到内容 ──────────────────────────

test('★★★ 端到端：入站合并转发（只有 id）⇒ 网关自动取回 ⇒ **模型在提示词里看到内容**', async () => {
  // 协议端会怎么答这次 get_forward_msg —— 只有 id 的那种（线上 parseMultMsg: false）
  forwardScript['fwd-alpha'] = [
    {
      user_id: 10002,
      time: 1700000000,
      message_id: 601,
      sender: { user_id: 10002, nickname: '小满' },
      message: [{ type: 'text', data: { text: '明天九点体检，别吃早饭' } }],
    },
    {
      user_id: 10003,
      time: 1700000060,
      message_id: 602,
      sender: { user_id: 10003, nickname: '老王' },
      message: [{ type: 'text', data: { text: '收到' } }],
    },
  ]
  const before = driver.requests.length
  pushMessage('m-forward-1', [{ type: 'forward', data: { id: 'fwd-alpha' } }])

  await waitFor(() => driver.requests.length > before, 4000)
  assert.ok(driver.requests.length > before, '这一批必须真的唤醒并跑了一轮（否则断言的是"没人调用"）')

  const request = driver.requests[driver.requests.length - 1]
  assert.ok(request !== undefined)
  // ★ 这就是全任务最重要的一条断言
  assert.match(request.prompt, /明天九点体检，别吃早饭/, '**转发内容必须出现在模型拿到的提示词里**')
  assert.match(request.prompt, /小满/, '连同发送者一起（否则模型不知道是谁说的）')

  // 协议端确实被问了 —— 证明内容是从 get_forward_msg 来的，不是巧合
  assert.ok(
    actions.some((a) => a.action === 'get_forward_msg' && a.params['message_id'] === 'fwd-alpha'),
    '必须先调 get_forward_msg 取回内容（入站事件里只有 id）',
  )
})

test('★★ 端到端：取不回内容时**保留可见的占位符**（不是"一条空消息"）', async () => {
  forwardScript['fwd-missing'] = [] // 协议端说"没有内容"
  const before = driver.requests.length
  pushMessage('m-forward-2', [{ type: 'forward', data: { id: 'fwd-missing' } }, { type: 'text', data: { text: '看看这个' } }])

  await waitFor(() => driver.requests.length > before, 4000)
  const request = driver.requests[driver.requests.length - 1]
  assert.ok(request !== undefined)
  assert.match(request.prompt, /看看这个/)
  // 关键：内容取不回时，模型看到的是**看得见的失败**，而不是一片空白
  assert.match(request.prompt, /合并转发/, '占位符必须留在提示词里')
  assert.match(request.prompt, /内容未能取回/, '而且要说明"没取到"，不能假装它就是空的')
})

test('★ 端到端：段里已经带了 content（parseMultMsg=true 的部署）⇒ 不必再问协议端', async () => {
  const beforeGetForward = actions.filter((a) => a.action === 'get_forward_msg').length
  const before = driver.requests.length
  pushMessage('m-forward-3', [
    {
      type: 'forward',
      data: {
        id: 'fwd-inline',
        content: [{ user_id: 10002, sender: { nickname: '小满' }, message: [{ type: 'text', data: { text: '就地展开的内容' } }] }],
      },
    },
  ])
  await waitFor(() => driver.requests.length > before, 4000)
  const request = driver.requests[driver.requests.length - 1]
  assert.ok(request !== undefined)
  assert.match(request.prompt, /就地展开的内容/)
  const afterGetForward = actions.filter((a) => a.action === 'get_forward_msg').length
  assert.equal(afterGetForward, beforeGetForward, '内容已经在手上时不该再花一次往返')
})

// ── 发：走真实出站链路 ──────────────────────────────────────────────────────

test('★ 端到端：`kind=forward` 的出站动作真的走到 `send_private_forward_msg`', async () => {
  const built = buildForwardNodes([{ name: '小满', text: '打包给你' }])
  assert.equal(built.ok, true)
  if (!built.ok) return
  enqueueOutbound(db, {
    conversationKey: 'onebot11:10001',
    conversationKind: 'private',
    kind: 'forward',
    payload: { nodes: built.nodes },
  })
  await waitFor(() => actions.some((a) => a.action === 'send_private_forward_msg'), 3000)
  const sent = actions.find((a) => a.action === 'send_private_forward_msg')
  assert.ok(sent !== undefined, '合并转发必须真的发出去（走既有 OneBot 链路，不是另起一套）')
  const messages = sent.params['messages'] as Record<string, unknown>[]
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.['type'], 'node', 'messages 里只许有 node（NapCat 的 check() 会拒绝混合）')
})

test('★ 端到端：群聊里的合并转发走 `send_group_forward_msg`（不会发成私聊）', async () => {
  const built = buildForwardNodes([{ text: '群里的记录' }])
  assert.equal(built.ok, true)
  if (!built.ok) return
  enqueueOutbound(db, {
    conversationKey: 'onebot11:88888',
    conversationKind: 'group',
    kind: 'forward',
    payload: { nodes: built.nodes },
  })
  await waitFor(() => actions.some((a) => a.action === 'send_group_forward_msg'), 3000)
  const sent = actions.find((a) => a.action === 'send_group_forward_msg')
  assert.ok(sent !== undefined)
  assert.equal(sent.params['group_id'], 88888)
})
