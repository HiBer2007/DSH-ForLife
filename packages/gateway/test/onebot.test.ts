/**
 * OneBot 适配器的测试：**用一个假的 QQ 端**连上来，跑真实 WebSocket。
 *
 * 为什么值得这么测：这一层是唯一与外部进程（NapCat / SnowLuma）打交道的代码，
 * 协议细节一旦错，表现是"消息发出去了但对面没收到""重连后事件丢了"这类**只在集成时才出现**的问题。
 * 假端用 `ws` 的客户端（与真实端同一套协议栈），所以互操作性有真实意义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { WebSocket } from 'ws'

import { OneBotTransport } from '../src/onebot.ts'
import { conversationKey, parseConversationKey, type InboundEvent } from '../src/transport.ts'

/** 起一个适配器 + 一个假 QQ 端，返回操作句柄。 */
async function harness(options: { accessToken?: string; port?: number } = {}): Promise<{
  transport: OneBotTransport
  client: WebSocket
  /** 假端收到的动作调用（可断言我们发了什么）。 */
  actions: { action: string; params: Record<string, unknown>; echo: string }[]
  /** 让假端对下一个动作回一个响应。 */
  respond: (data: unknown, retcode?: number, status?: string) => void
  /** 让假端推一个事件。 */
  push: (event: Record<string, unknown>) => void
  close: () => Promise<void>
}> {
  const port = options.port ?? 35700 + Math.floor(Math.random() * 200)
  const transport = new OneBotTransport({
    port,
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
    actionTimeoutMs: 2000,
  })
  await transport.start()

  const client = new WebSocket(`ws://127.0.0.1:${String(port)}/`, {
    ...(options.accessToken === undefined ? {} : { headers: { authorization: `Bearer ${options.accessToken}` } }),
  })
  const actions: { action: string; params: Record<string, unknown>; echo: string }[] = []
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  client.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
    if (typeof parsed.action === 'string') {
      actions.push({ action: parsed.action, params: parsed.params ?? {}, echo: parsed.echo ?? '' })
    }
  })
  await delay(50)

  return {
    transport,
    client,
    actions,
    respond: (data, retcode = 0, status = 'ok') => {
      const last = actions[actions.length - 1]
      if (last === undefined) throw new Error('还没有收到任何动作，无法响应')
      client.send(JSON.stringify({ status, retcode, data, echo: last.echo }))
    },
    push: (event) => client.send(JSON.stringify(event)),
    close: async () => {
      client.close()
      await transport.stop()
    },
  }
}

test('会话键：三段规范化与解析（§8.4）', () => {
  assert.equal(conversationKey({ platform: 'onebot11', chatId: '123', kind: 'group' }), 'onebot11:123')
  assert.equal(conversationKey({ platform: 'onebot11', chatId: '123', threadId: 't9', kind: 'group' }), 'onebot11:123:t9')
  assert.deepEqual(parseConversationKey('onebot11:123'), { platform: 'onebot11', chatId: '123' })
  assert.deepEqual(parseConversationKey('onebot11:123:t9'), { platform: 'onebot11', chatId: '123', threadId: 't9' })
  assert.equal(parseConversationKey(''), undefined)
  assert.equal(parseConversationKey('onlyplatform:'), undefined)
})

test('入站：群消息被正确归一化（@我 / @全体 / 媒体 / 文本拼接）', async () => {
  const h = await harness()
  const events: InboundEvent[] = []
  h.transport.onEvent((event) => events.push(event))
  try {
    h.push({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: 1_760_000_000,
      self_id: 30001,
      group_id: 88888,
      user_id: 10001,
      message_id: 501,
      message: [
        { type: 'at', data: { qq: '30001' } },
        { type: 'text', data: { text: ' 看看这个 ' } },
        { type: 'image', data: { file: 'a.jpg' } },
      ],
      sender: { card: '老王', nickname: 'wang' },
    })
    await delay(50)

    assert.equal(events.length, 1)
    const event = events[0]
    assert.equal(event?.type, 'message')
    if (event?.type !== 'message') return
    const message = event.message
    assert.equal(message.conversation.chatId, '88888')
    assert.equal(message.conversation.kind, 'group')
    assert.equal(message.mentionedMe, true, '被 @ 必须识别（用 self_id 比对，不能靠猜）')
    assert.equal(message.mentionedAll, false)
    assert.equal(message.mediaKind, 'image')
    assert.equal(message.text, '[@] 看看这个 [图片]'.trim())
    assert.equal(message.senderName, '老王', '群名片优先于昵称')
    assert.equal(message.isSelf, false)
    assert.equal(message.at, new Date(1_760_000_000 * 1000).toISOString(), '事件时间要用平台给的 time（秒）')
  } finally {
    await h.close()
  }
})

test('入站：@全体 与 @我 是两个独立信号，不派生', async () => {
  const h = await harness()
  const events: InboundEvent[] = []
  h.transport.onEvent((e) => events.push(e))
  try {
    h.push({
      post_type: 'message',
      message_type: 'group',
      time: 1_760_000_001,
      self_id: 30001,
      group_id: 88888,
      user_id: 10001,
      message_id: 502,
      message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '通知' } }],
      sender: {},
    })
    await delay(50)
    const event = events[0]
    if (event?.type !== 'message') throw new Error('没有收到消息事件')
    assert.equal(event.message.mentionedAll, true)
    assert.equal(event.message.mentionedMe, false, '@全体 不能当成 @我（用户明确要求分开算）')
  } finally {
    await h.close()
  }
})

test('入站：私聊与临时会话的 kind 判定，且私聊"被 @"恒真', async () => {
  const h = await harness()
  const events: InboundEvent[] = []
  h.transport.onEvent((e) => events.push(e))
  try {
    h.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1_760_000_002, self_id: 30001, user_id: 10001, message_id: 601, message: [{ type: 'text', data: { text: '在吗' } }], sender: {} })
    h.push({ post_type: 'message', message_type: 'private', sub_type: 'group', time: 1_760_000_003, self_id: 30001, user_id: 10002, group_id: 88888, message_id: 602, message: [{ type: 'text', data: { text: '临时会话' } }], sender: {} })
    await delay(60)

    const [first, second] = events
    if (first?.type !== 'message' || second?.type !== 'message') throw new Error('事件类型不对')
    assert.equal(first.message.conversation.kind, 'private')
    assert.equal(first.message.mentionedMe, true, '私聊里对方就是在找我说话')
    assert.equal(second.message.conversation.kind, 'temp', '群临时会话是第三种 kind（默认唤醒概率 20%）')
    assert.equal(second.message.mentionedMe, true)
  } finally {
    await h.close()
  }
})

test('入站：拍一拍 / 撤回 / 自己被踢 等事件被归一化（§2.17.8）', async () => {
  const h = await harness()
  const events: InboundEvent[] = []
  h.transport.onEvent((e) => events.push(e))
  try {
    h.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', time: 1_760_000_010, self_id: 30001, group_id: 88888, user_id: 30001, operator_id: 10001 })
    h.push({ post_type: 'notice', notice_type: 'group_recall', time: 1_760_000_011, self_id: 30001, group_id: 88888, user_id: 10001, operator_id: 10001, message_id: 700 })
    h.push({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick_me', time: 1_760_000_012, self_id: 30001, group_id: 88888, user_id: 30001, operator_id: 10001 })
    await delay(60)

    assert.equal(events.length, 3)
    assert.equal(events[0]?.type, 'message')
    if (events[0]?.type === 'message') {
      assert.equal(events[0].message.isPoke, true, '拍一拍要能被识别（默认 100% 唤醒）')
      assert.equal(events[0].message.mentionedMe, true)
    }
    assert.equal(events[1]?.type, 'message_recalled')
    if (events[1]?.type === 'message_recalled') assert.equal(events[1].messageId, '700')
    assert.equal(events[2]?.type, 'group_member_change')
    if (events[2]?.type === 'group_member_change') assert.equal(events[2].change, 'kick_me', '被踢要单独可辨（要置系统状态）')
  } finally {
    await h.close()
  }
})

test('出站：send_group_msg 用 echo 关联响应并取回 message_id', async () => {
  const h = await harness()
  try {
    const promise = h.transport.sendMessage({ platform: 'onebot11', chatId: '88888', kind: 'group' }, [{ kind: 'text', text: '你好' }, { kind: 'at', userId: '10001' }])
    await delay(50)
    assert.equal(h.actions[0]?.action, 'send_group_msg')
    assert.deepEqual(h.actions[0]?.params['message'], [
      { type: 'text', data: { text: '你好' } },
      { type: 'at', data: { qq: '10001' } },
    ])
    h.respond({ message_id: 12345 })
    const result = await promise
    assert.equal(result.ok, true)
    assert.equal(result.messageId, '12345', 'message_id 要带回来（送达确认与撤回都要用）')
  } finally {
    await h.close()
  }
})

test('出站：平台返回失败时如实汇报（不假装成功）', async () => {
  const h = await harness()
  try {
    const promise = h.transport.sendMessage({ platform: 'onebot11', chatId: '10001', kind: 'private' }, [{ kind: 'text', text: 'x' }])
    await delay(50)
    h.respond({}, 1400, 'failed')
    const result = await promise
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /retcode=1400/)
  } finally {
    await h.close()
  }
})

test('出站：未连接时立即失败（不吊死调用方）', async () => {
  const transport = new OneBotTransport({ port: 35999, actionTimeoutMs: 500 })
  await transport.start()
  try {
    const result = await transport.sendMessage({ platform: 'onebot11', chatId: '1', kind: 'private' }, [{ kind: 'text', text: 'x' }])
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /未连接/)
  } finally {
    await transport.stop()
  }
})

test('出站：动作超时会失败并清理（不留悬挂 Promise）', async () => {
  const h = await harness()
  try {
    const promise = h.transport.sendMessage({ platform: 'onebot11', chatId: '1', kind: 'private' }, [{ kind: 'text', text: 'x' }])
    const result = await promise // 假端故意不响应 ⇒ 2 秒后超时
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /超时/)
  } finally {
    await h.close()
  }
})

test('出站：群聊的"输入中"必须失败（set_input_status 仅 C2C 有效）', async () => {
  const h = await harness()
  try {
    const group = await h.transport.setInputStatus({ platform: 'onebot11', chatId: '88888', kind: 'group' }, true)
    assert.equal(group.ok, false, '群聊没有这个能力，不能假装成功')
    assert.match(group.error ?? '', /仅 C2C/)

    const privatePromise = h.transport.setInputStatus({ platform: 'onebot11', chatId: '10001', kind: 'private' }, true)
    await delay(50)
    assert.equal(h.actions[h.actions.length - 1]?.action, 'set_input_status')
    h.respond({})
    assert.equal((await privatePromise).ok, true, '私聊应当真的发出去')
  } finally {
    await h.close()
  }
})

test('出站：@全体成员单独走一条路径（与普通发送分开）', async () => {
  const h = await harness()
  try {
    const promise = h.transport.mentionAll({ platform: 'onebot11', chatId: '88888', kind: 'group' }, [{ kind: 'text', text: '通知' }])
    await delay(50)
    const sent = h.actions[h.actions.length - 1]
    assert.equal(sent?.action, 'send_group_msg')
    assert.deepEqual(sent?.params['message'], [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: '通知' } },
    ])
    h.respond({ message_id: 9 })
    assert.equal((await promise).ok, true)

    const wrong = await h.transport.mentionAll({ platform: 'onebot11', chatId: '1', kind: 'private' }, [])
    assert.equal(wrong.ok, false, '私聊 @全体 没有意义')
  } finally {
    await h.close()
  }
})

test('出站：查 @全体剩余额度，can_at_all=false 归零', async () => {
  const h = await harness()
  try {
    const okPromise = h.transport.getAtAllRemain('88888')
    await delay(50)
    assert.equal(h.actions[h.actions.length - 1]?.action, 'get_group_at_all_remain')
    h.respond({ can_at_all: true, remain_at_all_count_for_group: 7 })
    assert.equal(await okPromise, 7)

    const denied = h.transport.getAtAllRemain('88888')
    await delay(50)
    h.respond({ can_at_all: false, remain_at_all_count_for_group: 0 })
    assert.equal(await denied, 0)
  } finally {
    await h.close()
  }
})

test('鉴权：token 不匹配的连接被拒绝（防同网段冒充）', async () => {
  const port = 36201
  const transport = new OneBotTransport({ port, accessToken: 'secret-token', actionTimeoutMs: 500 })
  await transport.start()
  try {
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/`, { headers: { authorization: 'Bearer wrong' } })
    const closed = await new Promise<number>((resolve) => {
      client.once('close', (code) => resolve(code))
      client.once('error', () => resolve(-1))
    })
    assert.equal(closed, 1008, '鉴权失败必须用 1008 关闭')
    assert.equal(transport.status().connected, false)
  } finally {
    await transport.stop()
  }
})

test('重连：新连接替换旧连接（OneBot 重连是常态）', async () => {
  const port = 36301
  const transport = new OneBotTransport({ port, actionTimeoutMs: 500 })
  await transport.start()
  try {
    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
    await new Promise<void>((resolve) => first.once('open', () => resolve()))
    await delay(50)
    assert.equal(transport.status().connected, true)

    const second = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
    await new Promise<void>((resolve) => second.once('open', () => resolve()))
    await delay(80)
    assert.equal(transport.status().connected, true, '新连接接管后仍应处于已连接')

    // 事件应当从新连接进来
    const events: InboundEvent[] = []
    transport.onEvent((e) => events.push(e))
    second.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1_760_000_100, self_id: 30001, user_id: 10001, message_id: 1, message: [{ type: 'text', data: { text: '来自新连接' } }], sender: {} }))
    await delay(50)
    assert.equal(events.length, 1, '事件必须从当前连接进来')
    first.close()
    second.close()
  } finally {
    await transport.stop()
  }
})

test('健壮性：脏帧与未知事件被忽略，不断开、不影响后续', async () => {
  const h = await harness()
  const events: InboundEvent[] = []
  h.transport.onEvent((e) => events.push(e))
  try {
    h.client.send('这不是 JSON')
    h.client.send(JSON.stringify({ post_type: '不认识的类型' }))
    h.client.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1_760_000_200, self_id: 30001, user_id: 10001, message_id: 2, message: [{ type: 'text', data: { text: '正常消息' } }], sender: {} }))
    await delay(80)
    assert.equal(events.length, 1, '脏帧与未知事件都不该产生事件，但后续必须照常')
    assert.equal(h.transport.status().connected, true, '脏帧不该导致断连')
  } finally {
    await h.close()
  }
})

test('红线：适配器不实现协议级危险动作（能力面上切断）', () => {
  const transport = new OneBotTransport({ port: 36999 })
  const surface = transport as unknown as Record<string, unknown>
  for (const forbidden of ['send_packet', 'getCookies', 'get_cookies', 'getCsrfToken', 'get_credentials', 'getRkey', 'handleQuickOperation', 'handle_quick_operation']) {
    assert.equal(surface[forbidden], undefined, `不得实现 ${forbidden}（§2.17.8 的红线：不是在工具层挡住，而是根本不建方法）`)
  }
  // 但合法的能力必须在
  for (const allowed of ['sendMessage', 'sendReaction', 'setInputStatus', 'mentionAll', 'getSelfInfo', 'getAtAllRemain', 'deleteMessage']) {
    assert.equal(typeof surface[allowed], 'function', `应当实现 ${allowed}`)
  }
})
