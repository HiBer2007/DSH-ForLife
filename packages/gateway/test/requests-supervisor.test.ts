/**
 * 好友/群请求 + **系统监督循环**（P0-2 的接线证据）。
 *
 * ## 这个文件要回答的两个问题
 *
 *  1. **好友申请现在会不会静默丢？**
 *     —— 会（改之前）：NapCat 上报了、适配器收到了、网关写进 `effects` 了，
 *     而"把未报告的 effects 交给模型"那条链（`runReportCycle`）**生产零调用**。
 *     这里的端到端测试证明**现在真的到得了模型**。
 *  2. **离线积压的通知真的会送到模型手里吗？**
 *     —— 同理，断言落在 `FakeTurnDriver.requests[0].prompt` 上。
 *
 * 用的是**进程内假传输层**（Gateway 只依赖 `QqTransport` 接口），
 * 比起真 WebSocket 快得多，而"网关 → 驱动 → 提示词"这条要验的链路是**真的**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { listEffects, openDatabase } from '@forlife/store'
import { seedBacklogWakeRule } from '../src/backlog.ts'
import { FakeTurnDriver } from '../src/driver.ts'
import { Gateway } from '../src/gateway.ts'
import { listPendingRequests, markRequestHandled, recordInboundRequest, renderRequestNotice, requestNotice } from '../src/requests.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import type { ConversationRef, FileInfo, ForwardContent, InboundEvent, OutboundSegment, PttTextResult, QqTransport, SendResult, TransportStatus } from '../src/transport.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-req-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

/** 进程内假传输层：只做我们要断言的事。 */
class FakeTransport implements QqTransport {
  readonly handlers = new Set<(event: InboundEvent) => void>()
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = []
  forwardResult: ForwardContent | undefined
  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onEvent(handler: (event: InboundEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  status(): TransportStatus {
    return { connected: true }
  }
  push(event: InboundEvent): void {
    for (const handler of this.handlers) handler(event)
  }
  async sendMessage(_c: ConversationRef, _s: readonly OutboundSegment[]): Promise<SendResult> {
    this.record('sendMessage')
    return { ok: true, messageId: 'm1' }
  }
  async sendReaction(): Promise<SendResult> {
    this.record('sendReaction')
    return { ok: true }
  }
  async setInputStatus(): Promise<SendResult> {
    return { ok: true }
  }
  async mentionAll(): Promise<SendResult> {
    return { ok: true }
  }
  async getSelfInfo(): Promise<{ userId: string; nickname: string } | undefined> {
    return { userId: '3112546448', nickname: '小满' }
  }
  async getAtAllQuota(): Promise<undefined> {
    return undefined
  }
  async groupNotice(): Promise<SendResult> {
    return { ok: true }
  }
  async getAtAllRemain(): Promise<undefined> {
    return undefined
  }
  async deleteMessage(): Promise<SendResult> {
    return { ok: true }
  }
  async sendForward(_c: ConversationRef, nodes: readonly unknown[]): Promise<SendResult> {
    this.record('sendForward', nodes)
    return { ok: true, messageId: 'fwd1' }
  }
  async getForward(messageId: string): Promise<ForwardContent | undefined> {
    this.record('getForward', messageId)
    return this.forwardResult
  }
  async handleFriendRequest(flag: string, approve: boolean, remark?: string): Promise<SendResult> {
    this.record('handleFriendRequest', flag, approve, remark)
    return { ok: true }
  }
  async handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<SendResult> {
    this.record('handleGroupRequest', flag, approve, reason)
    return { ok: true }
  }
  async listFriends(): Promise<undefined> {
    return undefined
  }
  async listGroups(): Promise<undefined> {
    return undefined
  }
  async listGroupMembers(): Promise<undefined> {
    return undefined
  }
  async fetchPttText(messageId: string): Promise<PttTextResult> {
    this.record('fetchPttText', messageId)
    return { ok: false, error: '假传输层没有语音转写' }
  }
  async getFileInfo(input: { readonly file?: string; readonly fileId?: string }): Promise<FileInfo | undefined> {
    this.record('getFileInfo', input)
    return undefined
  }
}

let transport: FakeTransport
let driver: FakeTurnDriver
let gateway: Gateway

/** 建一台带监督循环的网关（每个测试用干净的库更省事，但这里复用同一个库 + 清表）。 */
function buildGateway(supervisor: boolean): { gateway: Gateway; driver: FakeTurnDriver; transport: FakeTransport } {
  const localTransport = new FakeTransport()
  const localDriver = new FakeTurnDriver(() => ({ segments: ['ok'], toolCalls: 0 }))
  const runner = new TurnRunner({
    db,
    driver: localDriver,
    scopeOf: defaultScopeOf,
    conditionOf: defaultConditionOf,
    random: () => 0,
    log: () => {},
  })
  const localGateway = new Gateway({
    db,
    transport: localTransport,
    runner,
    debounceMs: 40,
    outboxPollMs: 30,
    ...(supervisor ? { supervisor: { enabled: true, intervalMs: 60_000 } } : {}),
    log: () => {},
  })
  return { gateway: localGateway, driver: localDriver, transport: localTransport }
}

/**
 * 把所有 `effects` 的 `created_at` 往回拨 —— **模拟"已经安静下来了"**。
 *
 * 为什么要这么做：`collectReportable` 有**合并窗口**（`admin.report.coalesceMs`，默认 60 秒）——
 * 窗口内还有新动作就再等等（避免被连点按钮刷屏）。这是**设计如此**，不是 bug：
 * 一条刚到的申请最多晚 60 秒才被报告。测试里把它拨老，才能验"安静之后真的会报"。
 */
function ageEffects(): void {
  db.prepare("UPDATE effects SET created_at = ?").run(new Date(Date.now() - 600_000).toISOString())
}

/** 往待读池塞够"积压唤醒门槛"那么多条。 */
function fillBacklog(prefix: string): number {
  const min = defaultFor<number>('qq.backlog.wakeMinUnread')
  const at = new Date().toISOString()
  const statement = db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
     VALUES (?, 'group:88888', 'onebot11:88888', '老王', ?, ?, 0, NULL)`,
  )
  for (let i = 0; i < min; i++) statement.run(`${prefix}${String(i)}`, `${prefix} 的正文`, at)
  return min
}

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  seedBacklogWakeRule(db)
  setWakeRule(db, '*', 'private_message', { enabled: true, probability: 100 }, 'admin')
  const built = buildGateway(true)
  transport = built.transport
  driver = built.driver
  gateway = built.gateway
  // ⚠️ 必须真的 start()：`onEvent` 的订阅与出站消费循环都在里面，
  //    而 `supervise()` 的第一行就是 `if (!this.running) return`。
  gateway.start()
})

after(async () => {
  await gateway.stop()
  close()
  rmSync(dir, { recursive: true, force: true })
})

test('★ 请求落库：幂等（同一条请求重复上报不会变成两条）', () => {
  const first = recordInboundRequest(db, { kind: 'friend', userId: '20001', comment: '我是老王', flag: 'req-1', at: '2026-10-09T01:00:00.000Z' })
  const second = recordInboundRequest(db, { kind: 'friend', userId: '20001', comment: '我是老王', flag: 'req-1', at: '2026-10-09T01:00:00.000Z' })
  assert.equal(first, second, 'id 由 kind+flag 派生 ⇒ 重复上报落到同一行')
  const pending = listPendingRequests(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.flag, 'req-1')
  assert.equal(pending[0]?.userId, '20001')
})

test('★ 请求：flag 必须能取出来（处理时原样回传，凭空构造一定失败）', () => {
  // 这条是"能处理"的前提：NapCat 里 flag 是 reqTime / 通知 seq，
  // 除了上报没有任何其它来源。
  const item = listPendingRequests(db).find((r) => r.flag === 'req-1')
  assert.ok(item !== undefined)
  assert.equal(item.comment, '我是老王')
})

test('★ 请求通知：允许带"是谁 + 附言"（与积压通知不同，它低频且必须逐条判断）', () => {
  const notice = requestNotice(db)
  assert.equal(notice.pending, 1)
  const text = renderRequestNotice(notice)
  assert.match(text, /20001/, '要说清是谁')
  assert.match(text, /我是老王/, '要带上附言')
  assert.match(text, /安全含义/, '要写清加好友的风险')
  assert.match(text, /qq_handle_request/, '要告诉它怎么处理')
  assert.match(text, /flag/, '要提醒 flag 从 qq_requests 取')
})

test('★ 处理过的请求不再出现在待处理里', () => {
  markRequestHandled(db, { flag: 'req-1', kind: 'friend', approve: false, reason: '不认识', actor: 'model' })
  assert.equal(listPendingRequests(db).length, 0, '处理过就不该再冒出来')
  assert.equal(requestNotice(db).pending, 0)
  // 留痕：谁在什么时候拒绝了谁
  const handled = listEffects(db, 10, 'qq_request_handled')
  assert.equal(handled.length, 1)
  assert.equal(handled[0]?.subject, 'req-1')
})

// ── ★★ P0-2：入站请求事件真的到得了模型 ────────────────────────────────────

test('★★★ 端到端：入站 `request` 事件 ⇒ **真的通知到模型**（改之前是静默丢的）', async () => {
  const before = driver.requests.length
  transport.push({
    type: 'request',
    kind: 'friend',
    userId: '30001',
    comment: '你好，我是社区里的',
    flag: 'req-e2e-1',
    at: new Date().toISOString(),
  })
  ageEffects()
  const result = await gateway.supervise()
  assert.equal(result.delivered, true, '监督循环必须真的投递了一轮')
  assert.ok(driver.requests.length > before, '模型必须真的被叫起来')
  const prompt = driver.requests[driver.requests.length - 1]?.prompt ?? ''
  assert.match(prompt, /30001/, '要告诉它是谁在申请')
  assert.match(prompt, /你好，我是社区里的/, '要带上附言')
  assert.match(prompt, /待处理请求/)

  // 投递成功后必须标记已报告（否则下一轮会重复吵它）
  const unreported = listEffects(db, 50, 'qq_request').filter((row) => row.reported === 0)
  assert.deepEqual(unreported, [], '投递成功后请求必须被标记为已报告')
})

test('★ 监督循环：没东西可报时**不开轮次**（不白烧模型调用）', async () => {
  const before = driver.requests.length
  const result = await gateway.supervise()
  assert.equal(result.delivered, false)
  assert.equal(driver.requests.length, before)
})

test('★★ 监督循环：离线积压只报数量、不报正文；且走**单独那组参数**', async () => {
  const min = fillBacklog('sentinel')
  assert.ok(min >= 1)
  const before = driver.requests.length
  const result = await gateway.supervise()
  assert.equal(result.delivered, true)
  assert.ok(driver.requests.length > before)
  const prompt = driver.requests[driver.requests.length - 1]?.prompt ?? ''
  assert.match(prompt, /未读积压/)
  assert.match(prompt, new RegExp(`${String(min)} 条`), '要说清有多少条')
  assert.match(prompt, /group:88888/)
  assert.ok(!prompt.includes('sentinel 的正文'), '**积压通知里绝不能出现正文**')
  db.prepare("DELETE FROM pending_messages WHERE id LIKE 'sentinel%'").run()
})

test('★★ 单独参数组：关掉 pending_backlog ⇒ 监督循环不再为积压开口', async () => {
  fillBacklog('sentinel2')
  setWakeRule(db, '*', 'pending_backlog' as never, { enabled: false }, 'model')
  const before = driver.requests.length
  const result = await gateway.supervise()
  assert.equal(result.delivered, false, '积压那组关掉之后就没别的可报了 ⇒ 不该开轮次')
  assert.equal(driver.requests.length, before)
  setWakeRule(db, '*', 'pending_backlog' as never, { enabled: true }, 'model')
  db.prepare("DELETE FROM pending_messages WHERE id LIKE 'sentinel2%'").run()
})

// ── 请求的处理动作走真实出站链路 ────────────────────────────────────────────

test('★ 端到端：`kind=friend_request` 的出站动作走到 `handleFriendRequest`', async () => {
  const { enqueueOutbound } = await import('../src/outbox.ts')
  enqueueOutbound(db, {
    conversationKey: 'onebot11:20001',
    conversationKind: 'private',
    kind: 'friend_request',
    payload: { flag: 'req-out-1', approve: true, reason: '认识' },
  })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !transport.calls.some((c) => c.method === 'handleFriendRequest')) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const call = transport.calls.find((c) => c.method === 'handleFriendRequest')
  assert.ok(call !== undefined, '处理好友申请必须真的走到传输层')
  assert.deepEqual(call.args, ['req-out-1', true, '认识'])
})

test('★ 端到端：`kind=group_request` 走到 `handleGroupRequest`（不会发成好友申请）', async () => {
  const { enqueueOutbound } = await import('../src/outbox.ts')
  enqueueOutbound(db, {
    conversationKey: 'onebot11:0',
    conversationKind: 'private',
    kind: 'group_request',
    payload: { flag: 'greq-1', approve: false, reason: '广告' },
  })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !transport.calls.some((c) => c.method === 'handleGroupRequest')) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const call = transport.calls.find((c) => c.method === 'handleGroupRequest')
  assert.ok(call !== undefined)
  assert.deepEqual(call.args, ['greq-1', false, '广告'])
})

// ── 跨进程只读查询（probe）──────────────────────────────────────────────────

test('★★ 端到端：`kind=probe` 的查询把结果写回 `forlife_state`，工具进程读得到', async () => {
  const { enqueueOutbound } = await import('../src/outbox.ts')
  const { readProbeResult, clearProbeResult } = await import('../src/probe.ts')
  transport.forwardResult = { messageId: 'fwd-x', text: '甲：内容', nodeCount: 1, notes: [] }
  const id = enqueueOutbound(db, {
    conversationKey: 'onebot11:0',
    conversationKind: 'private',
    kind: 'probe',
    payload: { probeAction: 'get_forward_msg', probeArgs: { message_id: 'fwd-x' } },
  })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && readProbeResult(db, id) === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const result = readProbeResult(db, id)
  assert.ok(result !== undefined, '结果必须能被工具侧读到')
  assert.equal(result.ok, true)
  assert.equal((result.data as { text: string }).text, '甲：内容')
  clearProbeResult(db, id)
  assert.equal(readProbeResult(db, id), undefined, '读完必须清掉（否则 forlife_state 会无限长）')
})

test('★ 查询动作是**白名单**：不在名单里的一律拒绝（不是"任意 action 都能调"）', async () => {
  const { enqueueOutbound } = await import('../src/outbox.ts')
  const { readProbeResult } = await import('../src/probe.ts')
  const id = enqueueOutbound(db, {
    conversationKey: 'onebot11:0',
    conversationKind: 'private',
    kind: 'probe',
    payload: { probeAction: 'send_packet', probeArgs: {} },
  })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status FROM qq_outbox WHERE id = ?').get(id) as { status: string } | undefined
    if (row?.status === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const row = db.prepare('SELECT status, error FROM qq_outbox WHERE id = ?').get(id) as { status: string; error: string }
  assert.equal(row.status, 'failed', '危险动作不许借这条路走（onebot.ts 的红线）')
  assert.match(row.error, /未知的查询动作/)
  assert.equal(readProbeResult(db, id), undefined)
})
