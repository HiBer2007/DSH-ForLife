/**
 * 入站事件的**归一化**测试（审计发现的 P0-1 / P1-3 / P1-4 / P2-a）。
 *
 * 这个文件守的是一个很隐蔽的失效形态：
 *
 * > **一类消息连一条记录都不产生。**
 *
 * 三处叠加：`normalizeMessage` 只认少数几种 segment → `text.trim()` 得空串 →
 * `timing.ts` 的 `empty` 规则判噪音 → `turns.ts` **整批吞掉**。
 * 结果不是"空壳"，而是**我们看到 0 条**，连一行日志都没有。
 *
 * ⇒ 所以这里的断言几乎都是"**至少看得见**"：
 * 未知段要有 `[未解析:…]` 占位符，卡片要有标题，心跳离线要变成 `bot_offline` 事件，
 * 以前被丢掉的四类 notice 要能变成事件。
 *
 * 走**真 WebSocket**（假 QQ 端发原始帧），因为要验的正是"帧 → 语义事件"这一步。
 */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { WebSocket } from 'ws'

import { OneBotTransport } from '../src/onebot.ts'
import type { InboundEvent } from '../src/transport.ts'

const port = 37170
let transport: OneBotTransport
let client: WebSocket
const events: InboundEvent[] = []

before(async () => {
  transport = new OneBotTransport({ port, actionTimeoutMs: 1000 })
  await transport.start()
  transport.onEvent((event) => events.push(event))
  client = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  await delay(40)
})

after(async () => {
  client.close()
  await transport.stop()
})

/** 发一帧并等它被归一化。 */
async function frame(payload: Record<string, unknown>): Promise<InboundEvent | undefined> {
  const before = events.length
  client.send(JSON.stringify({ self_id: 3112546448, time: Math.floor(Date.now() / 1000), ...payload }))
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && events.length === before) await delay(10)
  return events[events.length - 1]
}

/** 一条私聊消息的公共字段。 */
function privateMessage(message: unknown[]): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: `m-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    user_id: 10001,
    sender: { user_id: 10001, nickname: '小满' },
    message,
  }
}

test('★★ P0-1：没被解析的段**不许让整条消息消失**（至少留一个看得见的占位符）', async () => {
  // `bubble` / `tofu` / `tasktopmsg` 这些是实测里会被 NapCat 发出来、
  // 而我们的段循环以前**一个分支都不匹配**的类型。旧行为下 text = ''。
  const event = await frame(privateMessage([{ type: 'bubble', data: {} }]))
  assert.equal(event?.type, 'message')
  const message = event?.type === 'message' ? event.message : undefined
  assert.ok(message !== undefined)
  assert.notEqual(message.text, '', '**空串会让下游把它当噪音整批吞掉** —— 那才是真正的内容丢失')
  assert.match(message.text, /\[未解析:bubble\]/)
})

test('★★ P2-a：分享卡片要抽出标题（不是只留一个 `[未解析:json]`）', async () => {
  const card = JSON.stringify({ app: 'com.tencent.music', meta: { music: { title: '夜曲', desc: '周杰伦' } } })
  const event = await frame(privateMessage([{ type: 'json', data: { data: card } }]))
  const message = event?.type === 'message' ? event.message : undefined
  assert.ok(message !== undefined)
  assert.match(message.text, /夜曲/, '卡片标题是可读信息里最有用的那一项')
  assert.match(message.text, /卡片/)
})

test('★★ P2-a：XML 卡片与 markdown 同样要抽出正文', async () => {
  const xml = await frame(privateMessage([{ type: 'xml', data: { data: '<msg><title>群公告</title><summary>明天放假</summary></msg>' } }]))
  const xmlText = xml?.type === 'message' ? xml.message.text : ''
  assert.match(xmlText, /群公告/)

  const md = await frame(privateMessage([{ type: 'markdown', data: { content: '**注意**：九点开会' } }]))
  const mdText = md?.type === 'message' ? md.message.text : ''
  assert.match(mdText, /九点开会/)
})

test('★ P2-a：商城大表情与在线文件要带上名字', async () => {
  const mface = await frame(privateMessage([{ type: 'mface', data: { summary: '猫猫震惊' } }]))
  assert.match(mface?.type === 'message' ? mface.message.text : '', /猫猫震惊/)

  const online = await frame(privateMessage([{ type: 'onlinefile', data: { name: '报告.pdf' } }]))
  assert.match(online?.type === 'message' ? online.message.text : '', /报告\.pdf/)
})

test('★★★ P1-3：心跳报告 QQ 离线 ⇒ 必须变成 `bot_offline` 事件（那条 35 小时的坑）', async () => {
  // 实测事故：账号被静默踢下线、TCP 仍 ESTABLISHED、下游 35 小时收不到任何事件。
  // 心跳每 30 秒一次且带 status.online —— 不读它我们就和那次事故一样瞎。
  const offline = await frame({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false, good: true } })
  assert.equal(offline?.type, 'bot_offline', '心跳离线必须升级成事件（否则它只躺在日志里）')
  assert.match(offline?.type === 'bot_offline' ? offline.reason : '', /online=false/)
  // ★ 关键的第二半：**状态里也要如实反映离线**。
  //   只发事件而不改状态的话，健康检查/面板会继续显示"在线" ——
  //   而那正是那次 35 小时事故里"一路绿灯"的来源。
  assert.equal(transport.status().connected, true, '前提：WS 仍然连着（这正是事故形态）')
  assert.equal(transport.status().qqOnline, false, 'QQ 已离线时状态必须说 false（写死 true 就永远发现不了）')

  // 恢复在线：**不该**再产生 bot_offline（否则会一直刷"掉线"，把真事故淹掉）。
  // ⚠️ 这一帧本来就是"不产生事件"的，所以不能用 `frame()`（它会等到超时再返回上一条）。
  const beforeOnline = events.length
  client.send(
    JSON.stringify({ self_id: 3112546448, time: Math.floor(Date.now() / 1000), post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }),
  )
  await delay(200)
  const fresh = events.slice(beforeOnline)
  assert.equal(fresh.filter((e) => e.type === 'bot_offline').length, 0, '在线时不许再报掉线')

  // 状态里必须能分辨"链路通着"与"QQ 在线"（合并成一个字段就分不出来了）
  const status = transport.status()
  assert.equal(status.connected, true)
  assert.equal(status.qqOnline, true)
})

test('★★ P1-4：四类以前被丢掉的 notice 现在都要变成事件', async () => {
  const inputStatus = await frame({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'input_status',
    user_id: 10001,
    status_text: '对方正在输入...',
    event_type: 1,
  })
  assert.equal(inputStatus?.type, 'peer_input_status', '`peer_input_status` 唤醒条件一直缺生产者，就是这里断的')

  const ban = await frame({ post_type: 'notice', notice_type: 'group_ban', group_id: 88888, user_id: 10002, operator_id: 10003, duration: 600, sub_type: 'ban' })
  assert.equal(ban?.type, 'group_ban')
  assert.equal(ban?.type === 'group_ban' ? ban.durationSeconds : 0, 600)

  const upload = await frame({
    post_type: 'notice',
    notice_type: 'group_upload',
    group_id: 88888,
    user_id: 10002,
    file: { id: 'file-abc', name: '资料.zip', size: 1234 },
  })
  assert.equal(upload?.type, 'group_upload')
  // `file_id` 是之后取文件内容要用的东西 —— 不记下来就永远取不到（P2-b）
  assert.equal(upload?.type === 'group_upload' ? upload.fileId : '', 'file-abc')
  assert.equal(upload?.type === 'group_upload' ? upload.fileName : '', '资料.zip')

  const likes = await frame({
    post_type: 'notice',
    notice_type: 'group_msg_emoji_like',
    group_id: 88888,
    message_id: 'm-1',
    user_id: 10002,
    likes: [{ emoji_id: '128077', count: 2 }],
  })
  assert.equal(likes?.type, 'group_msg_emoji_like')
  assert.deepEqual(likes?.type === 'group_msg_emoji_like' ? likes.likes : [], [{ emojiId: '128077', count: 2 }])
})

test('★★ P0-4：`reply` 段的 id 必须被带出来（否则 `reply_to_me` 永不触发）', async () => {
  const event = await frame(privateMessage([{ type: 'reply', data: { id: 'msg-999' } }, { type: 'text', data: { text: '这条是回你的' } }]))
  const message = event?.type === 'message' ? event.message : undefined
  assert.ok(message !== undefined)
  assert.equal(message.replyToMessageId, 'msg-999', '以前这个 id 读完就扔 ⇒ `reply_to_me` 形同虚设')
  assert.match(message.text, /这条是回你的/)
})
