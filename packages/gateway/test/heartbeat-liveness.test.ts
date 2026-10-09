/**
 * ★★ P1-3 的后半截：**心跳与「协议端说掉线了」必须真的喂到存活判据**。
 *
 * ## 为什么这个文件最重要的一条是"参数来自真实心跳"
 *
 * 实测事故（`research/napcat_issues.json:531`）的形态是
 * **反向 WS 一直 ESTABLISHED、QQ 已被静默踢下线、下游 35 小时收不到任何事件**。
 * 判据要抓它，只能靠心跳的 `status.online` —— 而这条链有三段，每一段都能"看起来接上了"：
 *
 *   1. `onebot.ts` 解析 `meta_event.heartbeat`（**旧代码直接丢弃**）；
 *   2. 通过**构造函数**把观察者带出去（本项目真的漏过这一行：`onConnectionState`
 *      在构造函数里没被复制，回调永远不触发，而日志只显示"已连接"）；
 *   3. `runtime.ts` 把它交给 `wake.livenessMonitor.observeHeartbeat`。
 *
 * ⇒ 所以这里既有**端到端行为**（真 WS 帧 → 真 transport → 观察者收到真实数值），
 * 也有**源码守卫**（去注释、语句位置、断言结果被用）。
 *
 * ⚠️ 另外守一条"别把心跳写成审计行"：心跳 30 秒一条 ⇒ 落 `effects` 是 2880 行/天，
 * 还会把真正的报告淹掉。所以**只有边沿（离线那一刻）才产事件**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { WebSocket } from 'ws'

import { openDatabase } from '@forlife/store'

import { Gateway } from '../src/gateway.ts'
import { FakeTurnDriver } from '../src/driver.ts'
import { createOneBotTransport, OneBotTransport } from '../src/onebot.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import { isPeerTyping, recordTyping, typingConversations } from '../src/typing-state.ts'
import type { InboundEvent } from '../src/transport.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-hb-'))
const port = 37195
let db: ReturnType<typeof openDatabase>['db']
let close: () => void
let transport: OneBotTransport
let gateway: Gateway
let client: WebSocket

/** 观察者收到的心跳（**这就是存活判据的输入**）。 */
const heartbeats: { online: boolean; good?: boolean; intervalMs?: number; at: Date }[] = []
const botOfflineCalls: { reason: string; at: Date }[] = []
const events: InboundEvent[] = []

before(async () => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  setWakeRule(db, '*', 'private_message', { enabled: true, probability: 100 }, 'admin')

  // ★ 必须走 `createOneBotTransport`（= 构造函数）：参数"在两层之间掉了"这类缺陷
  //   只有在构造函数路径上才暴露得出来。
  transport = createOneBotTransport({
    port,
    actionTimeoutMs: 1000,
    onHeartbeat: (heartbeat) => heartbeats.push(heartbeat),
    onBotOffline: (reason, at) => botOfflineCalls.push({ reason, at }),
  })
  await transport.start()
  transport.onEvent((event) => events.push(event))

  const gatewayClient = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    gatewayClient.once('open', () => resolve())
    gatewayClient.once('error', reject)
  })
  client = gatewayClient
  // 假 QQ 端要**应答动作**，否则 `callAction` 会等到超时（那会让"守卫没误伤正常 id"这条测不出来）
  client.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { action?: string; echo?: string }
    if (typeof parsed.action !== 'string') return
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: parsed.echo }))
  })
  await delay(50)
})

after(async () => {
  await gateway?.stop()
  client?.close()
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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function gatewaySrc(relative: string): string {
  return stripComments(readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8'))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
}

// ── 一、端到端：心跳真的到了观察者手里，且数值来自那一帧 ──────────────────

test('★★★ 心跳：`online`/`good`/`interval` 原样交给观察者（**参数来自真实帧**）', async () => {
  client.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      time: Math.floor(Date.now() / 1000),
      self_id: 3112546448,
      status: { online: true, good: true },
      interval: 30000,
    }),
  )
  await waitFor(() => heartbeats.length > 0)
  const heartbeat = heartbeats[0]
  assert.equal(heartbeat?.online, true)
  assert.equal(heartbeat?.good, true)
  assert.equal(heartbeat?.intervalMs, 30000, '★ 间隔必须用**心跳自带的** interval（换配置不用改代码）')
  assert.ok(heartbeat?.at instanceof Date, '时间戳必须是真实的 Date（判据要靠它算沉默时长）')
  // 心跳**不许**产事件（2880 行/天）
  assert.equal(events.filter((e) => e.type === 'bot_offline').length, 0, '在线心跳不该产任何事件')
})

test('★★ 心跳：`online:false` 只产**一次**事件（边沿），但每次都喂判据', async () => {
  const before = heartbeats.length
  for (let i = 0; i < 2; i += 1) {
    client.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        time: Math.floor(Date.now() / 1000),
        status: { online: false, good: false },
        interval: 30000,
      }),
    )
    await delay(30)
  }
  await waitFor(() => heartbeats.length >= before + 2)
  assert.equal(heartbeats.length, before + 2, '每一条心跳都要喂判据（判据靠"多久没心跳"算沉默）')
  assert.equal(
    events.filter((e) => e.type === 'bot_offline').length,
    1,
    '★ 离线期间心跳每 30 秒一条：事件只许在**边沿**产一次（否则 effects 2880 行/天）',
  )
})

test('★★ `notice_type: bot_offline`：喂判据**并且**产事件（第二道保险）', async () => {
  const before = botOfflineCalls.length
  const beforeEvents = events.filter((e) => e.type === 'bot_offline').length
  client.send(
    JSON.stringify({
      post_type: 'notice',
      notice_type: 'bot_offline',
      time: Math.floor(Date.now() / 1000),
      self_id: 3112546448,
      message: '账号已被踢下线',
    }),
  )
  await waitFor(() => botOfflineCalls.length > before)
  assert.match(botOfflineCalls[before]?.reason ?? '', /bot_offline/)
  assert.ok(botOfflineCalls[before]?.at instanceof Date)
  assert.equal(events.filter((e) => e.type === 'bot_offline').length, beforeEvents + 1, '该通知本身是边沿式的 ⇒ 要产事件')
})

// ── 二、消息 id 精度守卫（审计 §5d）─────────────────────────────────────

test('★★ 不安全的消息 id：**报错而不是截断**（撤回/表情回应都守）', async () => {
  const unsafe = '9007199254740993' // 2^53 + 1：Number() 会取整到错的值
  const reaction = await transport.sendReaction(unsafe, '128077')
  assert.equal(reaction.ok, false)
  assert.match(reaction.error ?? '', /安全整数/)
  const recall = await transport.deleteMessage(unsafe)
  assert.equal(recall.ok, false)
  assert.match(recall.error ?? '', /安全整数/)
  // 非数字形态也拒绝（协议端 id 允许 string，但我们的传输层只认十进制整数）
  assert.equal((await transport.sendReaction('abc', '1')).ok, false)
  // 正常的 10 位 id 照常（**不能被守卫误伤**）
  const ok = await transport.sendReaction('1956236413', '128077')
  assert.equal(ok.ok, true)
})

// ── 三、"对方正在输入"的临时状态 ───────────────────────────────────────

test('★★ typing：记进去、能读出来、**过期就自动不算**（不留僵尸正在输入）', () => {
  const key = 'onebot11:10001'
  const now = new Date('2026-10-09T10:00:00.000Z')
  recordTyping(db, { conversationKey: key, eventType: 1, statusText: '对方正在输入...', now, ttlMs: 12_000 })
  assert.equal(isPeerTyping(db, key, new Date('2026-10-09T10:00:05.000Z')), true)
  assert.equal(isPeerTyping(db, key, new Date('2026-10-09T10:00:20.000Z')), false, '超过 TTL 必须自动失效')
  // 明确"停止输入" ⇒ 直接删键（表里剩几个键就等于"现在有几个人在打字"）
  recordTyping(db, { conversationKey: key, eventType: 2, statusText: '停止输入', now })
  assert.equal(isPeerTyping(db, key, new Date('2026-10-09T10:00:01.000Z')), false)
  const raw = db.prepare('SELECT count(*) AS n FROM forlife_state WHERE key LIKE ?').get('qq_typing:%') as { n: number }
  assert.equal(raw.n, 0, '停止输入后不该留键')
})

test('★★ typing：一次问一批（工具层渲染要按条给 typing）', () => {
  const now = new Date('2026-10-09T11:00:00.000Z')
  recordTyping(db, { conversationKey: 'onebot11:1', eventType: 1, statusText: 'x', now, ttlMs: 12_000 })
  recordTyping(db, { conversationKey: 'onebot11:2', eventType: 1, statusText: 'x', now, ttlMs: 12_000 })
  const typing = typingConversations(db, ['onebot11:1', 'onebot11:2', 'onebot11:3'], new Date('2026-10-09T11:00:03.000Z'))
  assert.deepEqual([...typing].sort(), ['onebot11:1', 'onebot11:2'])
})

test('★★ 端到端：`input_status` 通知 ⇒ 网关真的记下了（事件被消费，不是只落审计）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: ['ok'], toolCalls: 0 }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  gateway = new Gateway({ db, transport, runner, debounceMs: 50, outboxPollMs: 50, log: () => {} })
  gateway.start()
  client.send(
    JSON.stringify({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'input_status',
      user_id: 10001,
      status_text: '对方正在输入...',
      event_type: 1,
      time: Math.floor(Date.now() / 1000),
    }),
  )
  await waitFor(() => isPeerTyping(db, 'onebot11:10001'))
  assert.equal(isPeerTyping(db, 'onebot11:10001'), true, '★ 网关必须把输入状态记下来（read_pending 的 typing 靠它）')
  // 审计行仍然保留（它是一致的轨迹）
  const effect = db.prepare("SELECT count(*) AS n FROM effects WHERE kind = 'qq_event:peer_input_status'").get() as { n: number }
  assert.equal(effect.n >= 1, true)
})

// ── 四、接线守卫（读源码 · 去注释 · 语句位置 · 断言结果被用）──────────────

test('★★ 接线守卫：心跳解析真的产出了观察者输入，且**间隔取自帧**', () => {
  const body = gatewaySrc('onebot.ts')
  assert.match(body, /this\.notifyHeartbeat\(\{ online/, '必须把心跳交给观察者')
  assert.match(body, /record\['interval'\]/, '间隔必须从帧里取')
  // 心跳**不许**落审计：heartbeat 分支里不能出现产事件之外的副作用
  const heartbeatBlock = body.slice(body.indexOf("meta_event_type'] === 'heartbeat'"), body.indexOf('private normalizeMessage('))
  assert.ok(!/recordNonMessageEvent|recordEffect|INSERT INTO effects/.test(heartbeatBlock), '★ 心跳不许写 effects（2880 行/天）')
  assert.match(heartbeatBlock, /wasOnline !== false/, '★ 离线事件只许在边沿产（否则同样 2880 行/天）')
  // 观察者必须**穿过构造函数**（本项目漏过这一行）
  assert.match(body, /options\.onHeartbeat === undefined \? \{\} : \{ onHeartbeat: options\.onHeartbeat \}/)
  assert.match(body, /options\.onBotOffline === undefined \? \{\} : \{ onBotOffline: options\.onBotOffline \}/)
})

test('★★★ 接线守卫：生产路径把心跳/掉线喂给**存活判据**（不是"函数存在"）', () => {
  const body = gatewaySrc('runtime.ts')
  assert.match(body, /onHeartbeat: \(heartbeat\) =>/, '必须在传输层装配处挂心跳回调')
  assert.match(body, /wake\.livenessMonitor\?\.observeHeartbeat\(heartbeat\)/, '★ 必须把**收到的那份**心跳交给判据（重新拼一个对象就等于丢字段）')
  assert.match(body, /onBotOffline: \(reason, at\) =>/, '必须挂掉线回调')
  assert.match(body, /wake\.livenessMonitor\?\.observeBotOffline\(reason, at\)/, '★ 掉线也要喂判据')
  // 结果被用：判定不是 alive 时要留日志（否则"判了但没人知道"）
  assert.match(body, /verdict\.state !== 'alive'/, '判定结果必须被用（不然等于只调不用）')
})

test('★★ 接线守卫：`input_status` 在网关侧被消费成 typing 状态', () => {
  const body = gatewaySrc('gateway.ts')
  assert.match(body, /event\.type === 'peer_input_status'/, '必须认这个事件')
  assert.match(body, /recordTyping\(this\.options\.db, \{/, '必须真的记状态')
  assert.match(body, /eventType: event\.eventType/, '事件类型必须传下去（停止输入要靠它）')
  const tools = readFileSync(new URL('../../dsh-component/src/qq-tools.ts', import.meta.url), 'utf8')
  assert.match(tools, /typingConversations\(/, '工具层必须真的去读它')
  assert.match(tools, /typing: typing\.has\(i\.conversationKey\)/, '★ 每条消息都要带上 typing（读了不用等于没接）')
})

// ── 五、★ P3：`message_sent` 打开后的**去重护栏** ────────────────────────

test('★★★ P3：`message_sent` 里"我们自己发的"不再重复入库（只留"主人在别处发的"）', async () => {
  const driver = new FakeTurnDriver(() => ({ segments: ['ok'], toolCalls: 0 }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  const localGateway = new Gateway({ db, transport, runner, debounceMs: 50, outboxPollMs: 50, log: () => {} })
  localGateway.start()

  // ① 一条**我们没发过**的 id（= 主人用手机发的）⇒ 必须记下来
  client.send(
    JSON.stringify({
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'self-foreign-1',
      user_id: 3112546448,
      self_id: 3112546448,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 3112546448, nickname: '我' },
      message: [{ type: 'text', data: { text: '我在手机上说的' } }],
    }),
  )
  await waitFor(() => (db.prepare('SELECT count(*) AS n FROM qq_inbox WHERE id = ?').get('self-foreign-1') as { n: number }).n > 0)
  const effectsOf = (id: string): number =>
    (db.prepare('SELECT count(*) AS n FROM effects WHERE id = ?').get(id) as { n: number }).n
  assert.equal(effectsOf('eff_self_self-foreign-1'), 1, '外部发送必须留下多端一致性记录')

  // ② 一条**我们自己发出去的** id（`qq_outbox` 里已确认）⇒ 不许写第二份
  db.prepare(
    `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source, conversation_kind)
     VALUES ('out_p3', 'onebot11:10001', 'self-ours-1', 'text', '{"segments":[]}', ?, 1, ?, NULL, 'sent', NULL, 0, 'model', 'private')`,
  ).run(new Date().toISOString(), new Date().toISOString())
  client.send(
    JSON.stringify({
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'self-ours-1',
      user_id: 3112546448,
      self_id: 3112546448,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 3112546448, nickname: '我' },
      message: [{ type: 'text', data: { text: '我自己刚回的' } }],
    }),
  )
  await delay(200)
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM qq_inbox WHERE id = ?').get('self-ours-1') as { n: number }).n,
    0,
    '★ 我们自己发的消息已经有权威记录（qq_outbox）⇒ 不许写第二份（否则每轮都会读到"我刚说过什么"）',
  )
  assert.equal(effectsOf('eff_self_self-ours-1'), 0, '也不许写第二份影响报告')

  // 接线守卫：去重必须真的基于 qq_outbox 的**平台消息 id**
  const body = gatewaySrc('gateway.ts')
  assert.match(body, /SELECT 1 AS x FROM qq_outbox WHERE platform_msg_id = \? AND status = 'sent'/, '去重口径必须是"已确认发出去的平台 id"')
  assert.match(body, /if \(known !== undefined\)/, '★ 判定结果必须被用（只查不用等于没去重）')

  await localGateway.stop()
})
