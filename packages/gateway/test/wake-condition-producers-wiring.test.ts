/**
 * ★★「唤醒条件到底有没有生产者」的守卫（2026-10-09 入站事件审计的头号问题）。
 *
 * ## 它拦的是什么
 *
 * 审计实测：**15 个唤醒条件里有 7 个没有任何生产者**
 * （`turns.ts:495 defaultConditionOf` 是唯一的产出点，而它不产出那 7 个）。
 * 后果是面板上改那些规则的开关/概率**什么都不会发生，而且不报错** ——
 * 这类缺陷在行为层完全看不出来：不抛异常、不留痕、按钮照样能点。
 *
 * 所以这里守三层，缺一层都拦不住：
 *  ① **行为层**：`reply_to_me` 真的能触发（真库 + 真 `TurnRunner` ⇒ `wake_events` 里那一行）；
 *  ② **源码层**：每条"声称有生产者"的条件，那个文件里**真的有产出它的那一行**
 *     （去注释后匹配，且落在语句位置 —— 注释不算，本项目在 `param-consumption` 上栽过）；
 *  ③ **登记层**：没有生产者的条件**必须写明等什么**，而且这份缺口清单要能被启动日志打出来
 *     （`describeWakeProducerGaps()`）—— "配了不会发生"从"事后审计才发现"变成"启动就能看到"。
 *
 * 另外单独守一条**很容易忘、忘了很贵**的纪律：过唤醒矩阵时**不许传 `summary`** ——
 * `decideWake` 在跳过时会把 summary 记进待读池，那等于给"离线/外部触发"凭空造未读消息，
 * 还会把 `pending_backlog` 唤醒带上（池子自己长大）。
 *
 * @module forlife-gateway/test/wake-condition-producers-wiring
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import { FakeTurnDriver } from '../src/driver.ts'
import { enqueueOutbound } from '../src/outbox.ts'
import { conversationKey, type InboundMessage } from '../src/transport.ts'
import { defaultConditionOf, defaultScopeOf, selfMessageIdDetector, TurnRunner } from '../src/turns.ts'
import { describeWakeProducerGaps, seedWakeRules, WAKE_CONDITION_PRODUCERS, WAKE_CONDITIONS, wakeConditionsWithoutProducer } from '../src/wake.ts'

const opened: { close: () => void }[] = []
after(() => {
  for (const handle of opened) handle.close()
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

/** 造一条入站群消息。 */
function inbound(partial: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `m_${Math.random().toString(36).slice(2, 8)}`,
    conversation: { platform: 'onebot11', chatId: '88888', kind: 'group' },
    senderId: '10001',
    senderName: '她',
    text: '你怎么看',
    mentionedMe: false,
    mentionedAll: false,
    isPoke: false,
    isSelf: false,
    at: new Date('2026-10-09T03:00:00.000Z').toISOString(),
    raw: {},
    ...partial,
  }
}

/** 往出站队列插一条"已经发出去并拿到平台 id"的行（= 我们发过什么）。 */
function seedSentMessage(db: DatabaseSync, platformMessageId: string): void {
  const id = enqueueOutbound(db, {
    conversationKey: 'onebot11:88888',
    kind: 'text',
    payload: { segments: [{ kind: 'text', text: '我发过的' }] },
    conversationKind: 'group',
  })
  db.prepare("UPDATE qq_outbox SET status = 'sent', confirmed = 1, platform_msg_id = ? WHERE id = ?").run(platformMessageId, id)
}

// ── ① 行为层：reply_to_me 真的能产出 ────────────────────────────────────────

test('★ reply_to_me：引用的是我发出去的消息 ⇒ 判据成立（以前这条永远是死规则）', () => {
  const db = freshDb()
  seedSentMessage(db, '777')
  const isSelf = selfMessageIdDetector(db)

  // 引用我发的那条 ⇒ 命中
  assert.equal(defaultConditionOf([inbound({ replyToMessageId: '777' })], { isSelfMessageId: isSelf }), 'reply_to_me')
  // 引用**别人**发的（不在出站表里）⇒ 落回群里的普通消息（不能误判成"回我"）
  assert.equal(defaultConditionOf([inbound({ replyToMessageId: '999' })], { isSelfMessageId: isSelf }), 'group_message_any')
  // 压根没有引用段 ⇒ 同上
  assert.equal(defaultConditionOf([inbound()], { isSelfMessageId: isSelf }), 'group_message_any')
})

test('★ 判据不传上下文时**不产出** reply_to_me（向后兼容：老调用点行为不变）', () => {
  assert.equal(defaultConditionOf([inbound({ replyToMessageId: '777' })]), 'group_message_any')
})

test('@我 优先于"回复我"；私聊里"被 @"恒真，所以那两个类型走各自的条件', () => {
  const db = freshDb()
  seedSentMessage(db, '777')
  const isSelf = selfMessageIdDetector(db)
  assert.equal(
    defaultConditionOf([inbound({ replyToMessageId: '777', mentionedMe: true })], { isSelfMessageId: isSelf }),
    'group_mention',
  )
  // 私聊/临时会话：私聊本身已经是最强信号，不该被"回复我"盖掉
  // （生产里 onebot.ts 对私聊恒置 mentionedMe=true —— 这里照那个形态造消息）
  assert.equal(
    defaultConditionOf(
      [
        inbound({
          replyToMessageId: '777',
          mentionedMe: true,
          conversation: { platform: 'onebot11', chatId: '1', kind: 'private' },
        }),
      ],
      { isSelfMessageId: isSelf },
    ),
    'private_message',
  )
})

test('★★ 端到端：真 TurnRunner + 真库 ⇒ wake_events 里出现 reply_to_me（生产者真的接上了）', async () => {
  const db = freshDb()
  seedWakeRules(db)
  seedSentMessage(db, '777')

  const driver = new FakeTurnDriver(() => ({ segments: ['嗯'] }))
  // 刻意**不注入** isSelfMessageId：走生产路径（TurnRunner 自己从 qq_outbox 反查）
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, log: () => {} })

  const result = await runner.handleBatch([inbound({ replyToMessageId: '777' })], new AbortController().signal)
  assert.equal(result.woken, true, '回复我 = 100% 唤醒（基线 wake.rules.replyToMe）')
  const row = db.prepare('SELECT condition, decision FROM wake_events ORDER BY rowid DESC LIMIT 1').get() as {
    condition: string
    decision: string
  }
  assert.equal(row.condition, 'reply_to_me')
  assert.equal(row.decision, 'wake')
})

test('反向：引用别人的消息在群里**不该**唤醒（默认群聊零唤醒）——证明上一条不是碰巧', async () => {
  const db = freshDb()
  seedWakeRules(db)
  seedSentMessage(db, '777')

  const driver = new FakeTurnDriver(() => ({ segments: ['嗯'] }))
  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, log: () => {} })

  const result = await runner.handleBatch([inbound({ replyToMessageId: '999' })], new AbortController().signal)
  assert.equal(result.woken, false)
  assert.equal(result.reason, 'disabled')
  const row = db.prepare('SELECT condition FROM wake_events ORDER BY rowid DESC LIMIT 1').get() as { condition: string }
  assert.equal(row.condition, 'group_message_any')
})

// ── ② 源码层：每个"声称有生产者"都要在文件里找到那一行 ─────────────────────

const readSource = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * 必须去注释：本仓注释写得极细，`reply_to_me` / `bot_offline` 这些名字在说明里反复出现，
 * 直接 `includes` 会让守卫**自己满足自己**（`param-consumption.test.ts` 与
 * `mid-window-wiring.test.ts` 都栽过这个坑）。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const code = (rel: string): string => stripComments(readSource(rel))

test('★ 登记表逐条核对：声称的生产者文件里真的有产出它的那一行（去注释）', () => {
  for (const condition of WAKE_CONDITIONS) {
    const producer = WAKE_CONDITION_PRODUCERS[condition]
    if (producer.by === null) continue
    const source = code(`../src/${producer.by}`)
    const pattern =
      producer.by === 'turns.ts'
        ? // 条件解析是纯映射：必须落在 **return 语句**里（只出现在别处的字符串不算产出）
          new RegExp(`return [^\\n]*'${condition}'`)
        : // 事件类生产者：条件名必须出现在**语句位置**（`condition: 'xxx'` / `observe('xxx', …)`）
          new RegExp(`(condition|event|name):\\s*'${condition}'|['"]${condition}['"]\\s*,`)
    assert.match(source, pattern, `${condition} 声称由 ${producer.by} 产出，但那里找不到产出它的那一行`)
  }
})

test('★ reply_to_me 的判据必须真的用上"是不是我发的"（判据结果被用，不是读出来放着）', () => {
  const source = code('../src/turns.ts')
  assert.match(source, /context\.isSelfMessageId\?\.\(m\.replyToMessageId\)\s*===\s*true/, '判据表达式不见了')
  assert.match(source, /replyToMessageId/, '入站消息上那个字段不见了')
  // 生产路径必须把上下文**传下去**（不传的话条件又会永远不触发）
  assert.match(code('../src/turns.ts'), /this\.options\.conditionOf\(effective, this\.conditionContext\(\)\)/, 'TurnRunner 没把上下文传给条件解析')
  assert.match(code('../src/turns.ts'), /selfMessageIdDetector\(this\.options\.db\)/, '默认判据没有接到 db 上')
})

test('★ bot_offline 的判据真的接了唤醒矩阵，且**不许传 summary**（免得凭空造未读消息）', () => {
  const source = code('../src/wake-liveness.ts')
  assert.match(source, /condition:\s*'bot_offline'/, 'bot_offline 的矩阵判定不见了')
  const call = /decideWake\(db, \{[\s\S]*?\n  \}\)/.exec(source)
  assert.ok(call !== null, '找不到 decideWake 调用块')
  assert.doesNotMatch(String(call[0]), /summary/, '过矩阵不许传 summary（会把状态当成未读消息塞进待读池）')
  // 判据本体：心跳是唯一与"有没有人说话"无关的证据
  assert.match(source, /heartbeat-stale/, '心跳超时这条判据不见了')
  assert.match(source, /NO_HEARTBEAT_REASON/, '缺心跳时必须如实说"判不了"')
})

test('★ external_request 的矩阵判定必须**决定去留**（判定结果落在 return 上）', () => {
  const source = code('../src/wake-external-source.ts')
  assert.match(source, /condition:\s*'external_request'/, 'external_request 没有被消费')
  assert.match(source, /if \(gate\.decision !== 'wake'\) \{[\s\S]{0,200}?return \{ ok: false/, '判定结果必须决定"放不放行"')
})

test('★ 存活监视必须在生产装配里**跑起来**（结果被用：上报出口 + stop）', () => {
  const source = code('../src/wake-runtime.ts')
  assert.match(source, /const liveness = startLivenessWatch\(\{/, '没有装配存活监视')
  assert.match(source, /report: \(state, detail\) => \{[\s\S]{0,200}?systemSource\.observe\('qq\.silent'/, '判据结果没有接到事件源上')
  assert.match(source, /liveness,/, '监视句柄没有返回给调用方（连接状态就喂不进去）')
  assert.match(source, /liveness\.stop\(\)/, '停止时没有停掉监视循环')
  assert.match(source, /describeWakeProducerGaps\(\)/, '启动时没有把"配了也不会发生"的条件打出来')
})

test('★ 连接回调必须把 WS 状态喂给存活判据（否则一次真断线会被报两次）', () => {
  const source = code('../src/runtime.ts')
  assert.match(source, /livenessMonitor\?\.observeTransport\(connected, detail\)/, '连接回调没有喂存活判据')
})

// ── ③ 登记层：没有生产者的条件必须写明"等什么"，且缺口可被启动日志打出来 ──

test('★ 没有生产者的条件必须写明"卡在哪、等什么"（否则这张表会变成新的谎话）', () => {
  for (const condition of WAKE_CONDITIONS) {
    const producer = WAKE_CONDITION_PRODUCERS[condition]
    if (producer.by !== null) continue
    assert.ok(producer.waitingOn !== undefined, `${condition} 没有生产者，却没写 waitingOn`)
    assert.ok(String(producer.waitingOn).length >= 20, `${condition} 的 waitingOn 太短，说不清等什么`)
    assert.match(String(producer.waitingOn), /\.ts|§/, `${condition} 的 waitingOn 必须指到具体文件或章节`)
  }
})

test('缺口清单：现在还剩哪些"配了也不会发生"的条件，且能渲染成人话', () => {
  const gaps = wakeConditionsWithoutProducer()
  // 这一行是**现状记录**，不是"允许有缺口"：谁接上了生产者，这里就会少一个（测试不会因此变红）
  assert.deepEqual([...gaps].sort(), ['message_recalled', 'peer_input_status', 'peer_status_change', 'self_message_sent'])
  const text = describeWakeProducerGaps()
  assert.ok(text !== undefined)
  assert.match(text, /当前没有生产者/)
  assert.match(text, /message_recalled/)
  assert.match(text, /等：/)
})

test('缺口说明里不许出现"已完成/已接线"这类假话（这一栏只能说现状）', () => {
  const text = describeWakeProducerGaps() ?? ''
  assert.doesNotMatch(text, /已完成|已接线|已实现/)
})
