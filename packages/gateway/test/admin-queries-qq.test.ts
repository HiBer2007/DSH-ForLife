/**
 * 「会话与队列」与「唤醒」查询的测试。
 *
 * 这里守的是**面板看到的数字必须与库里的事实一致**，所以每条断言都对着一个具体后果：
 *  - 排序错了 → 用户在"最近会话"里看到的是最老的会话；
 *  - `processed`/`read`/`confirmed` 给了 0/1 而不是布尔 → 界面渲染出 "1"；
 *  - unread 算错 → 用户以为有 3 条新消息，点进去只有 1 条；
 *  - 分组错了 → `group_mention` 掉进"不分会话类型"，让人以为群聊 @ 我没人管。
 *
 * 用例全部用内存库（`openDatabase({ file: ':memory:' })` 会跑完迁移，表一定存在），
 * 每个用例一个新库，互不污染。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import { queryConversations, queryWake } from '../src/admin/queries-qq.ts'

/** 开一个全新的内存库跑用例，跑完必关。 */
function withDb(run: (db: DatabaseSync) => void): void {
  const opened = openDatabase({ file: ':memory:' })
  try {
    run(opened.db)
  } finally {
    opened.close()
  }
}

/** 按会话键取一行，取不到直接断言失败（避免用例里到处写 `!`）。 */
function byKey<T extends { readonly conversationKey: string }>(rows: readonly T[], key: string): T {
  const found = rows.find((row) => row.conversationKey === key)
  assert.ok(found !== undefined, `列表里应当有会话 ${key}`)
  return found
}

/** 按组名取一个分组，取不到直接断言失败。 */
function byGroup<T extends { readonly group: string }>(groups: readonly T[], name: string): T {
  const found = groups.find((group) => group.group === name)
  assert.ok(found !== undefined, `应当有分组 ${name}`)
  return found
}

/** 按条件名取一条分组规则，取不到直接断言失败。 */
function byCondition<T extends { readonly condition: string }>(rules: readonly T[], condition: string): T {
  const found = rules.find((rule) => rule.condition === condition)
  assert.ok(found !== undefined, `分组里应当有条件 ${condition}`)
  return found
}

const T0 = '2026-10-06T00:00:00.000Z'

function addSession(
  db: DatabaseSync,
  row: {
    readonly key: string
    readonly kind?: string
    readonly title?: string | null
    readonly lastMessageAt?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO qq_sessions (conversation_key, platform, chat_id, kind, title, last_message_at, created_at)
     VALUES (?, 'onebot11', ?, ?, ?, ?, ?)`,
  ).run(row.key, row.key, row.kind ?? 'private', row.title ?? null, row.lastMessageAt ?? null, T0)
}

function addInbox(
  db: DatabaseSync,
  row: {
    readonly id: string
    readonly key: string
    readonly receivedAt: string
    readonly at?: string
    readonly text?: string
    readonly senderName?: string | null
    readonly processed?: number
    readonly attempt?: number
    readonly error?: string | null
    readonly mediaKind?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO qq_inbox (id, conversation_key, text, payload, at, received_at, processed, attempt, error, media_kind, sender_name)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.key,
    row.text ?? '',
    row.at ?? row.receivedAt,
    row.receivedAt,
    row.processed ?? 0,
    row.attempt ?? 0,
    row.error ?? null,
    row.mediaKind ?? null,
    row.senderName ?? null,
  )
}

function addTurn(
  db: DatabaseSync,
  row: {
    readonly id: string
    readonly key: string
    readonly status: string
    readonly startedAt: string
    readonly endedAt?: string | null
    readonly model?: string | null
    readonly tokensIn?: number
    readonly tokensOut?: number
    readonly toolCalls?: number
    readonly deferReason?: string | null
    readonly error?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, model,
                           tokens_in, tokens_out, tool_calls, defer_reason, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.key,
    row.status,
    row.startedAt,
    row.endedAt ?? null,
    row.model ?? null,
    row.tokensIn ?? 0,
    row.tokensOut ?? 0,
    row.toolCalls ?? 0,
    row.deferReason ?? null,
    row.error ?? null,
  )
}

function addOutbox(
  db: DatabaseSync,
  row: {
    readonly id: string
    readonly key: string
    readonly sentAt: string
    readonly kind?: string
    readonly status?: string
    readonly attempt?: number
    readonly confirmed?: number
    readonly error?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO qq_outbox (id, conversation_key, kind, payload, sent_at, confirmed, error, status, attempt)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.key,
    row.kind ?? 'text',
    row.sentAt,
    row.confirmed ?? 0,
    row.error ?? null,
    row.status ?? 'pending',
    row.attempt ?? 0,
  )
}

function addPending(
  db: DatabaseSync,
  row: {
    readonly id: string
    readonly scope: string
    readonly key: string
    readonly summary: string
    readonly at: string
    readonly senderName?: string | null
    readonly read?: number
  },
): void {
  db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.scope, row.key, row.senderName ?? null, row.summary, row.at, row.read ?? 0)
}

function addRule(
  db: DatabaseSync,
  row: {
    readonly scope: string
    readonly condition: string
    readonly enabled?: number
    readonly probability?: number
    readonly minIntervalMs?: number
    readonly dailyLimit?: number
    readonly quietUntil?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit,
                             quiet_until, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?)`,
  ).run(
    row.scope,
    row.condition,
    row.enabled ?? 1,
    row.probability ?? 100,
    row.minIntervalMs ?? 0,
    row.dailyLimit ?? 0,
    row.quietUntil ?? null,
    T0,
  )
}

function addEvent(
  db: DatabaseSync,
  row: {
    readonly id: string
    readonly at: string
    readonly scope: string
    readonly condition: string
    readonly decision: 'wake' | 'skip'
    readonly reason: string
    readonly conversationKey?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO wake_events (id, scope, condition, conversation_key, decision, reason, roll, at)
     VALUES (?, ?, ?, ?, ?, ?, 0.42, ?)`,
  ).run(row.id, row.scope, row.condition, row.conversationKey ?? null, row.decision, row.reason, row.at)
}

// ── 空库 ────────────────────────────────────────────────────────────────────

test('空库：两块查询都不抛，计数为 0，平均时长缺省而不是 0', () => {
  withDb((db) => {
    const conversations = queryConversations(db)
    assert.deepEqual(conversations.sessions, [])
    assert.deepEqual(conversations.queue, [])
    assert.deepEqual(conversations.queueStats, { pending: 0, total: 0, failed: 0 })
    assert.deepEqual(conversations.turns, [])
    // 没有任何轮次时 `avgDurationMs` 必须整个缺失：0ms 会被界面画成"轮次瞬间完成"。
    assert.deepEqual(conversations.turnStats, { running: 0, done: 0, failed: 0, deferred: 0 })
    assert.equal(conversations.turnStats.avgDurationMs, undefined)
    assert.deepEqual(conversations.outbox, [])
    assert.deepEqual(conversations.outboxStats, { pending: 0, failed: 0, confirmed: 0 })
    assert.deepEqual(conversations.pending, [])

    const wake = queryWake(db)
    assert.deepEqual(wake.rules, [])
    assert.deepEqual(wake.events, [])
    assert.deepEqual(wake.stats, { total: 0, enabled: 0, overridden: 0 })
    // 四个分组固定存在（空组也留），前端不用处理"这一块今天不存在"。
    assert.deepEqual(
      wake.groups.map((group) => group.group),
      ['私聊', '临时会话', '群聊', '不分会话类型'],
    )
    assert.ok(wake.groups.every((group) => group.rules.length === 0))
  })
})

// ── 会话与队列 ──────────────────────────────────────────────────────────────

test('会话：按 last_message_at DESC 排、NULL 垫底，unread 按会话分别数准', () => {
  withDb((db) => {
    addSession(db, { key: 'private:1001', title: '张三', lastMessageAt: '2026-10-06T03:00:00.000Z' })
    addSession(db, { key: 'group:2001', kind: 'group', lastMessageAt: null }) // 建过会话但没说过话
    addSession(db, { key: 'group:2002', kind: 'group', title: '技术群', lastMessageAt: '2026-10-06T05:00:00.000Z' })

    // 未处理：private:1001 两条、group:2002 一条（另一条已处理）、group:2001 零条。
    addInbox(db, { id: 'i1', key: 'private:1001', receivedAt: '2026-10-06T03:00:00.000Z' })
    addInbox(db, { id: 'i2', key: 'private:1001', receivedAt: '2026-10-06T03:00:01.000Z' })
    addInbox(db, { id: 'i3', key: 'group:2002', receivedAt: '2026-10-06T05:00:00.000Z' })
    addInbox(db, { id: 'i4', key: 'group:2002', receivedAt: '2026-10-06T05:00:01.000Z', processed: 1 })

    const { sessions } = queryConversations(db)
    assert.deepEqual(
      sessions.map((session) => session.conversationKey),
      ['group:2002', 'private:1001', 'group:2001'],
    )
    assert.deepEqual(
      sessions.map((session) => session.lastMessageAt),
      ['2026-10-06T05:00:00.000Z', '2026-10-06T03:00:00.000Z', undefined],
    )
    assert.equal(byKey(sessions, 'private:1001').unread, 2)
    assert.equal(byKey(sessions, 'group:2002').unread, 1)
    assert.equal(byKey(sessions, 'group:2001').unread, 0)
    // 没有值就是"没有这个字段"，不能是 null（面板要区分"没聊过"与"有这个值"）。
    assert.equal(byKey(sessions, 'group:2001').lastMessageAt, undefined)
    assert.equal(byKey(sessions, 'group:2001').title, undefined)
    assert.equal(byKey(sessions, 'private:1001').platform, 'onebot11')
    assert.equal(byKey(sessions, 'private:1001').chatId, 'private:1001')
  })
})

test('页大小：各列表都听 limit，非法的 limit 会被夹进 1..200 而不是"全都要"', () => {
  withDb((db) => {
    for (let i = 1; i <= 5; i += 1) {
      const stamp = `2026-10-06T0${String(i)}:00:00.000Z`
      addSession(db, { key: `private:${String(1000 + i)}`, lastMessageAt: stamp })
      addInbox(db, { id: `i${String(i)}`, key: `private:${String(1000 + i)}`, receivedAt: stamp })
      addTurn(db, { id: `t${String(i)}`, key: `private:${String(1000 + i)}`, status: 'done', startedAt: stamp })
      addOutbox(db, { id: `o${String(i)}`, key: `private:${String(1000 + i)}`, sentAt: stamp })
      addPending(db, { id: `p${String(i)}`, scope: '*', key: `private:${String(1000 + i)}`, summary: '待读', at: stamp })
    }

    const two = queryConversations(db, { limit: 2 })
    assert.equal(two.sessions.length, 2)
    assert.equal(two.queue.length, 2)
    assert.equal(two.turns.length, 2)
    assert.equal(two.outbox.length, 2)
    assert.equal(two.pending.length, 2)
    // 取的是最新那两条，不是最老那两条。
    assert.deepEqual(
      two.sessions.map((session) => session.conversationKey),
      ['private:1005', 'private:1004'],
    )

    // 0 / 负数不是"不限量"的意思：夹到最小 1，绝不返回空列表让面板以为查询坏了。
    assert.equal(queryConversations(db, { limit: 0 }).sessions.length, 1)
    assert.equal(queryConversations(db, { limit: -5 }).sessions.length, 1)
    // 上限截断（这里只有 5 行，验证的是"大数不会把 SQL 撑坏且不报错"）。
    assert.equal(queryConversations(db, { limit: 100_000 }).sessions.length, 5)
    // 默认 30/50 都大于这 5 行，全部返回。
    assert.equal(queryConversations(db).sessions.length, 5)
  })
})

test('入站队列：按 received_at DESC 排，processed 是真布尔，可空列缺失即 undefined', () => {
  withDb((db) => {
    addInbox(db, {
      id: 'q1',
      key: 'group:2002',
      receivedAt: '2026-10-06T05:00:00.000Z',
      at: '2026-10-06T04:59:58.000Z',
      text: '带图的消息',
      senderName: '李四',
      mediaKind: 'image',
    })
    addInbox(db, {
      id: 'q2',
      key: 'private:1001',
      receivedAt: '2026-10-06T04:00:00.000Z',
      text: '处理失败的',
      processed: 1,
      attempt: 3,
      error: '处理超时',
    })
    addInbox(db, { id: 'q3', key: 'private:1001', receivedAt: '2026-10-06T03:00:00.000Z', text: '纯文本' })

    const { queue, queueStats } = queryConversations(db)
    assert.deepEqual(
      queue.map((item) => item.id),
      ['q1', 'q2', 'q3'],
    )
    const q1 = queue[0]
    assert.ok(q1 !== undefined)
    assert.equal(q1.processed, false)
    assert.equal(typeof q1.processed, 'boolean')
    assert.equal(q1.mediaKind, 'image')
    assert.equal(q1.senderName, '李四')
    assert.equal(q1.error, undefined)
    assert.equal(q1.at, '2026-10-06T04:59:58.000Z')
    assert.equal(q1.receivedAt, '2026-10-06T05:00:00.000Z')

    const q2 = queue[1]
    assert.ok(q2 !== undefined)
    assert.equal(q2.processed, true)
    assert.equal(q2.attempt, 3)
    assert.equal(q2.error, '处理超时')
    assert.equal(q2.mediaKind, undefined)
    assert.equal(q2.senderName, undefined)

    // pending = 没处理过的（q1、q3），failed = error 非空（q2），total 是全表。
    assert.deepEqual(queueStats, { pending: 2, total: 3, failed: 1 })
  })
})

test('轮次：按 started_at DESC 排，平均时长只算有 ended_at 的（不含 running/deferred）', () => {
  withDb((db) => {
    addTurn(db, {
      id: 't1',
      key: 'private:1001',
      status: 'done',
      startedAt: '2026-10-06T03:00:00.000Z',
      endedAt: '2026-10-06T03:00:02.000Z', // 2000ms
      model: 'gpt-x',
      tokensIn: 100,
      tokensOut: 50,
      toolCalls: 2,
    })
    addTurn(db, {
      id: 't2',
      key: 'group:2002',
      status: 'done',
      startedAt: '2026-10-06T04:00:00.000Z',
      endedAt: '2026-10-06T04:00:04.000Z', // 4000ms
    })
    addTurn(db, { id: 't3', key: 'group:2002', status: 'running', startedAt: '2026-10-06T05:00:00.000Z' })
    addTurn(db, {
      id: 't4',
      key: 'private:1001',
      status: 'failed',
      startedAt: '2026-10-06T02:00:00.000Z',
      endedAt: '2026-10-06T02:00:01.000Z', // 1000ms
      error: '模型超时',
    })
    addTurn(db, {
      id: 't5',
      key: 'private:1001',
      status: 'deferred',
      startedAt: '2026-10-06T01:00:00.000Z',
      deferReason: '对方正在输入',
    })

    const { turns, turnStats } = queryConversations(db)
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ['t3', 't2', 't1', 't4', 't5'],
    )
    const t1 = turns[2]
    assert.ok(t1 !== undefined)
    assert.equal(t1.model, 'gpt-x')
    assert.equal(t1.tokensIn, 100)
    assert.equal(t1.tokensOut, 50)
    assert.equal(t1.toolCalls, 2)
    assert.equal(t1.endedAt, '2026-10-06T03:00:02.000Z')

    const running = turns[0]
    assert.ok(running !== undefined)
    assert.equal(running.status, 'running')
    assert.equal(running.endedAt, undefined)
    const deferred = turns[4]
    assert.ok(deferred !== undefined)
    assert.equal(deferred.deferReason, '对方正在输入')
    assert.equal(deferred.error, undefined)
    const failed = turns[3]
    assert.ok(failed !== undefined)
    assert.equal(failed.error, '模型超时')

    assert.equal(turnStats.running, 1)
    assert.equal(turnStats.done, 2)
    assert.equal(turnStats.failed, 1)
    assert.equal(turnStats.deferred, 1)
    // (2000 + 4000 + 1000) / 3 = 2333.33 → 2333；把没结束的算成 0 会得到 1400（那就错了）。
    assert.equal(turnStats.avgDurationMs, 2333)
  })
})

test('出站：按 sent_at DESC 排，失败只认终态 —— 重试中的行仍算 pending', () => {
  withDb((db) => {
    addOutbox(db, { id: 'o1', key: 'private:1001', sentAt: '2026-10-06T05:00:00.000Z' })
    addOutbox(db, {
      id: 'o2',
      key: 'private:1001',
      sentAt: '2026-10-06T04:00:00.000Z',
      status: 'sent',
      confirmed: 1,
      attempt: 1,
    })
    addOutbox(db, {
      id: 'o3',
      key: 'group:2002',
      sentAt: '2026-10-06T03:00:00.000Z',
      kind: 'image',
      status: 'failed',
      attempt: 3,
      error: '平台拒绝',
    })
    // 发失败后回到 pending 等重试的行：带 error，但**不是**终态失败。
    addOutbox(db, {
      id: 'o4',
      key: 'group:2002',
      sentAt: '2026-10-06T02:00:00.000Z',
      status: 'pending',
      attempt: 2,
      error: '上次重试失败',
    })

    const { outbox, outboxStats } = queryConversations(db)
    assert.deepEqual(
      outbox.map((item) => item.id),
      ['o1', 'o2', 'o3', 'o4'],
    )
    const o2 = outbox[1]
    assert.ok(o2 !== undefined)
    assert.equal(o2.confirmed, true)
    assert.equal(typeof o2.confirmed, 'boolean')
    assert.equal(o2.status, 'sent')
    const o3 = outbox[2]
    assert.ok(o3 !== undefined)
    assert.equal(o3.kind, 'image')
    assert.equal(o3.error, '平台拒绝')
    const o1 = outbox[0]
    assert.ok(o1 !== undefined)
    assert.equal(o1.confirmed, false)
    assert.equal(o1.error, undefined)

    assert.deepEqual(outboxStats, { pending: 2, failed: 1, confirmed: 1 })
    // 出站默认页是 30（比别的列表小），limit 照样能收紧。
    assert.equal(queryConversations(db, { limit: 2 }).outbox.length, 2)
  })
})

test('待读池：按 at DESC 排，read 是真布尔', () => {
  withDb((db) => {
    addPending(db, {
      id: 'p1',
      scope: 'group:2002',
      key: 'group:2002',
      summary: '群里在聊部署',
      at: '2026-10-06T05:00:00.000Z',
      senderName: '李四',
    })
    addPending(db, {
      id: 'p2',
      scope: '*',
      key: 'private:1001',
      summary: '张三问了个问题',
      at: '2026-10-06T04:00:00.000Z',
      read: 1,
    })

    const { pending } = queryConversations(db)
    assert.deepEqual(
      pending.map((item) => item.id),
      ['p1', 'p2'],
    )
    const p1 = pending[0]
    assert.ok(p1 !== undefined)
    assert.equal(p1.read, false)
    assert.equal(typeof p1.read, 'boolean')
    assert.equal(p1.senderName, '李四')
    assert.equal(p1.scope, 'group:2002')
    const p2 = pending[1]
    assert.ok(p2 !== undefined)
    assert.equal(p2.read, true)
    assert.equal(p2.senderName, undefined)
  })
})

// ── 唤醒 ────────────────────────────────────────────────────────────────────

/**
 * 分组用真实条件名验证：库里 15 行真数据里有 `group_message_any`（不是文档里简写的
 * `group_message`）、`bot_offline`、`peer_input_status` 这些"文档没列全"的名字。
 * 归类一旦漏了，条件就会掉进兜底组，面板上看起来像"这条规则没人管"。
 */
function seedRealConditionNames(db: DatabaseSync): void {
  addRule(db, { scope: '*', condition: 'group_mention', probability: 100 })
  addRule(db, { scope: 'group:123', condition: 'group_mention', enabled: 0, probability: 30 })
  addRule(db, { scope: '*', condition: 'group_mention_all', probability: 50, quietUntil: '2026-10-06T10:00:00.000Z' })
  addRule(db, { scope: '*', condition: 'group_message_any', enabled: 0, probability: 0 })
  addRule(db, { scope: '*', condition: 'group_poke', probability: 100, minIntervalMs: 5_000, dailyLimit: 10 })
  addRule(db, { scope: '*', condition: 'private_message', probability: 80 })
  addRule(db, { scope: 'private:9', condition: 'private_message', probability: 50 })
  addRule(db, { scope: '*', condition: 'temp_message', probability: 20 })
  addRule(db, { scope: '*', condition: 'peer_input_status', probability: 100 })
  addRule(db, { scope: '*', condition: 'bot_offline', enabled: 0, probability: 100 })
  addRule(db, { scope: 'group:42', condition: 'system_event', probability: 10 })
}

test('唤醒分组：group_mention 落在「群聊」，peer_input_status 归「不分会话类型」', () => {
  withDb((db) => {
    seedRealConditionNames(db)
    const { groups } = queryWake(db)

    assert.deepEqual(
      byGroup(groups, '群聊')
        .rules.map((rule) => rule.condition)
        .sort(),
      ['group_mention', 'group_mention_all', 'group_message_any', 'group_poke'],
    )
    assert.deepEqual(
      byGroup(groups, '私聊').rules.map((rule) => rule.condition),
      ['private_message'],
    )
    assert.deepEqual(
      byGroup(groups, '临时会话').rules.map((rule) => rule.condition),
      ['temp_message'],
    )
    assert.deepEqual(
      byGroup(groups, '不分会话类型')
        .rules.map((rule) => rule.condition)
        .sort(),
      ['bot_offline', 'peer_input_status', 'system_event'],
    )
    // 状态信号不是"私聊消息"：放进私聊组会让人以为 C2C 打字状态算一条私聊。
    assert.ok(
      !byGroup(groups, '私聊').rules.some((rule) => rule.condition === 'peer_input_status'),
      'peer_input_status 不应出现在「私聊」组',
    )
  })
})

test('唤醒合并：同一条件跨 scope 合并成一行，scopes 列全，展示值取 `*` 基准行', () => {
  withDb((db) => {
    seedRealConditionNames(db)
    const { groups, rules } = queryWake(db)

    const mention = byCondition(byGroup(groups, '群聊').rules, 'group_mention')
    assert.deepEqual(mention.scopes, ['*', 'group:123'])
    // group:123 上这条是关的（覆盖），但基准行开着：面板要展示"整体上它是开着的"。
    assert.equal(mention.enabled, true)
    assert.equal(mention.probability, 100)

    // 只在某个具体会话配过的条件（没有 `*` 基准行）就退回覆盖行的值。
    const systemEvent = byCondition(byGroup(groups, '不分会话类型').rules, 'system_event')
    assert.deepEqual(systemEvent.scopes, ['group:42'])
    assert.equal(systemEvent.enabled, true)
    assert.equal(systemEvent.probability, 10)

    // 原始规则列表按 (scope, condition) 稳定排序，且可空列缺失即 undefined。
    assert.deepEqual(
      rules.map((rule) => `${rule.scope}/${rule.condition}`).slice(0, 3),
      ['*/bot_offline', '*/group_mention', '*/group_mention_all'],
    )
    const allMention = rules.find((rule) => rule.scope === '*' && rule.condition === 'group_mention_all')
    assert.ok(allMention !== undefined)
    assert.equal(allMention.quietUntil, '2026-10-06T10:00:00.000Z')
    assert.equal(byCondition(rules, 'private_message').quietUntil, undefined)
    assert.equal(byCondition(rules, 'group_poke').minIntervalMs, 5_000)
    assert.equal(byCondition(rules, 'group_poke').dailyLimit, 10)
  })
})

test('唤醒统计：total/enabled/overridden，overridden 只数 scope 不等于 `*` 的行', () => {
  withDb((db) => {
    seedRealConditionNames(db)
    const { stats } = queryWake(db)
    // 11 条规则里：group_mention(group:123)、group_message_any、bot_offline 是关的。
    assert.equal(stats.total, 11)
    assert.equal(stats.enabled, 8)
    // 被单独覆盖过的：group:123 的 group_mention、private:9 的 private_message、group:42 的 system_event。
    assert.equal(stats.overridden, 3)
  })
})

test('唤醒留痕：列名是 decision（没有 verdict 列），按 at DESC 排，scope 只筛留痕', () => {
  withDb((db) => {
    seedRealConditionNames(db)
    addEvent(db, {
      id: 'e1',
      at: '2026-10-06T05:00:00.000Z',
      scope: 'group:123',
      condition: 'group_mention',
      decision: 'wake',
      reason: 'matched',
      conversationKey: 'group:123',
    })
    addEvent(db, {
      id: 'e2',
      at: '2026-10-06T04:00:00.000Z',
      scope: 'group:123',
      condition: 'group_message_any',
      decision: 'skip',
      reason: 'probability',
      conversationKey: 'group:123',
    })
    addEvent(db, {
      id: 'e3',
      at: '2026-10-06T03:00:00.000Z',
      scope: '*',
      condition: 'private_message',
      decision: 'skip',
      reason: 'quiet_hours',
    })
    addEvent(db, {
      id: 'e4',
      at: '2026-10-06T02:00:00.000Z',
      scope: '*',
      condition: 'group_mention_all',
      decision: 'skip',
      reason: 'rate_limit',
    })

    const all = queryWake(db)
    assert.deepEqual(
      all.events.map((event) => event.id),
      ['e1', 'e2', 'e3', 'e4'],
    )
    const e1 = all.events[0]
    assert.ok(e1 !== undefined)
    // 形状钉死：字段名就是表里的 decision，不是文档里写顺手的 verdict。
    assert.deepEqual(Object.keys(e1).sort(), ['at', 'condition', 'conversationKey', 'decision', 'id', 'reason', 'scope'])
    assert.equal(e1.decision, 'wake')
    assert.equal(e1.reason, 'matched')
    assert.equal(e1.conversationKey, 'group:123')
    const e3 = all.events[2]
    assert.ok(e3 !== undefined)
    assert.equal(e3.decision, 'skip')
    assert.equal(e3.conversationKey, undefined)

    // scope 只筛判定留痕：规则矩阵与统计保持全库口径（groups 的 scopes、overridden 都要跨 scope 才有意义）。
    const scoped = queryWake(db, { scope: 'group:123' })
    assert.deepEqual(
      scoped.events.map((event) => event.id),
      ['e1', 'e2'],
    )
    assert.equal(scoped.rules.length, all.rules.length)
    assert.deepEqual(scoped.stats, all.stats)
    assert.deepEqual(scoped.groups, all.groups)

    // 留痕页大小：默认 100，显式 limit 生效。
    assert.equal(queryWake(db, { limit: 1 }).events.length, 1)
    assert.equal(queryWake(db, { limit: 0 }).events.length, 1)
    assert.equal(queryWake(db).events.length, 4)
  })
})
