/**
 * 后台接口测试（阶段 3 的面板数据面）。
 *
 * 面板的价值在于"排障时不必猜"。所以这里逐条验证面板真的能看到：
 * 积压多少、为什么没唤醒、它什么时候醒过、花了多少、以及**人类直发通道能用且留痕**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { seedWakeRules } from '@forlife/gateway'
import { openDatabase } from '@forlife/store'

import { buildPanelRoutes, type PanelRoute } from '../src/api.ts'
import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-adminapi-'))
let runtime: MemoryRuntime
let routes: readonly PanelRoute[]

before(() => {
  const opened = openDatabase({ file: join(dir, 'seed.sqlite') })
  seedWakeRules(opened.db)
  opened.close()
  runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }),
    dbPath: join(dir, 'forlife.sqlite'),
  })
  seedWakeRules(runtime.db)
  routes = buildPanelRoutes(runtime)
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 找一条路由。 */
function route(path: string, method: 'GET' | 'POST' = 'GET'): PanelRoute {
  const found = routes.find((r) => r.path === path && r.methods.includes(method))
  assert.ok(found !== undefined, `缺少路由 ${method} ${path}`)
  return found
}

/** 发一个 GET。 */
async function get(path: string, query = ''): Promise<Record<string, unknown>> {
  const response = await route(path).fetch(new Request(`http://local${path}${query}`))
  assert.equal(response.status, 200, `${path} 应当返回 200`)
  return (await response.json()) as Record<string, unknown>
}

/** 发一个 POST。 */
async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route(path, 'POST').fetch(
    new Request(`http://local${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('路由齐备：QQ 概览 / 队列 / 轮次 / 唤醒规则 / 判定留痕 / 待读池 / 后台对话', () => {
  const paths = routes.map((r) => `${r.methods.join(',')} ${r.path}`)
  for (const expected of [
    'GET /api/forlife/qq/state',
    'GET /api/forlife/qq/queue',
    'GET /api/forlife/qq/turns',
    'GET /api/forlife/qq/wake-rules',
    'POST /api/forlife/qq/wake-rules',
    'GET /api/forlife/qq/wake-events',
    'GET /api/forlife/qq/pending',
    'GET /api/forlife/admin/chat',
    'POST /api/forlife/admin/chat',
  ]) {
    assert.ok(paths.includes(expected), `缺少 ${expected}`)
  }
})

test('概览：能看到积压与会话数（排障不必猜）', async () => {
  // 造一条入站与一条出站
  runtime.db
    .prepare(
      `INSERT INTO qq_inbox (id, conversation_key, platform_msg_id, sender_id, sender_name, is_group, is_self, mentioned_me, mentioned_all, is_poke, media_kind, text, payload, at, received_at, processed, merged_into, attempt, error)
       VALUES ('api_1', 'onebot11:88888', 'api_1', '10001', '老王', 1, 0, 0, 0, 0, NULL, '你好', '{}', ?, ?, 0, NULL, 0, NULL)`,
    )
    .run(new Date().toISOString(), new Date().toISOString())
  runtime.db
    .prepare(
      `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source, conversation_kind)
       VALUES ('api_out_1', 'onebot11:88888', NULL, 'text', '{}', ?, 0, NULL, '平台拒绝', 'failed', NULL, 1, 'model', 'group')`,
    )
    .run(new Date().toISOString())

  const state = await get('/api/forlife/qq/state')
  assert.equal(state['ok'], true)
  assert.ok(Number(state['inbound']) >= 1)
  assert.ok(Number(state['inboundPending']) >= 1, '未处理的入站要能看到（积压）')
  const outbox = state['outbox'] as Record<string, number>
  assert.ok((outbox['failed'] ?? 0) >= 1, '失败数要能看到')
  assert.ok(state['transport'] !== undefined, '传输层状态要给出来')
})

test('队列：失败原因与重试次数可见（面板最常看的一张表）', async () => {
  const body = await get('/api/forlife/qq/queue')
  const rows = body['rows'] as Record<string, unknown>[]
  const failed = rows.find((r) => r['id'] === 'api_out_1')
  assert.ok(failed !== undefined)
  assert.equal(failed['status'], 'failed')
  assert.equal(failed['error'], '平台拒绝')
  assert.equal(failed['attempt'], 1)
  assert.equal(failed['conversationKind'], 'group', '会话类型要显示（群/私聊决定发到哪）')
  const stats = body['stats'] as Record<string, number>
  assert.ok((stats['failed'] ?? 0) >= 1)
})

test('队列：可按状态过滤', async () => {
  const body = await get('/api/forlife/qq/queue', '?status=failed')
  const rows = body['rows'] as Record<string, unknown>[]
  assert.ok(rows.length >= 1)
  assert.ok(rows.every((r) => r['status'] === 'failed'))
})

test('轮次时间线：醒过几次、花了多少 token、失败原因', async () => {
  const now = new Date().toISOString()
  runtime.db
    .prepare(
      `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
       VALUES ('api_turn_1', 'onebot11:88888', 'done', ?, ?, NULL, 'm', '[]', 1200, 300, 2, NULL, NULL, NULL)`,
    )
    .run(now, now)
  runtime.db
    .prepare(
      `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
       VALUES ('api_turn_2', 'onebot11:10001', 'failed', ?, NULL, NULL, NULL, '[]', 0, 0, 0, NULL, NULL, '模型 503')`,
    )
    .run(now)

  const body = await get('/api/forlife/qq/turns')
  const turns = body['turns'] as Record<string, unknown>[]
  const done = turns.find((t) => t['id'] === 'api_turn_1')
  assert.ok(done !== undefined, '成功的轮次必须出现在时间线里')
  assert.equal(done['tokensIn'], 1200)
  assert.equal(done['toolCalls'], 2)
  const failed = turns.find((t) => t['id'] === 'api_turn_2')
  assert.ok(failed !== undefined, '失败的轮次也必须出现（失败要看得见）')
  assert.equal(failed['status'], 'failed')
  assert.equal(failed['error'], '模型 503')
})

test('唤醒规则：默认值就是用户拍板的那套，且改一条不影响别人', async () => {
  const body = await get('/api/forlife/qq/wake-rules', '?scope=*')
  const rules = body['rules'] as Record<string, unknown>[]
  const find = (condition: string): Record<string, unknown> => {
    const rule = rules.find((r) => r['condition'] === condition)
    assert.ok(rule !== undefined, `缺少 ${condition}`)
    return rule
  }
  assert.equal(find('group_message_any')['enabled'], false, '群聊默认零唤醒')
  assert.equal(find('private_message')['probability'], 80)
  assert.equal(find('group_mention_all')['probability'], 50, '@全体独立 50%')
  assert.ok(Array.isArray(body['conditions']) && (body['conditions'] as unknown[]).length >= 15)

  // 后台改一条：@我 概率降到 30
  const updated = await post('/api/forlife/qq/wake-rules', { scope: 'group:88888', condition: 'group_mention', probability: 30, enabled: true })
  assert.equal(updated.status, 200)
  assert.equal((updated.body['rule'] as Record<string, unknown>)['probability'], 30)

  const after = await get('/api/forlife/qq/wake-rules', '?scope=group:88888')
  assert.equal((after['rules'] as Record<string, unknown>[]).find((r) => r['condition'] === 'group_mention')?.['probability'], 30)
  assert.equal((after['rules'] as Record<string, unknown>[]).find((r) => r['condition'] === 'group_poke')?.['probability'], 100, '别的条件不受影响')
})

test('唤醒规则：改动用 admin 身份留痕（铁律 1：影响模型的操作要报告）', async () => {
  const row = runtime.db
    .prepare("SELECT * FROM effects WHERE kind = 'admin_action' AND detail LIKE '%wake.rule%' ORDER BY rowid DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined
  assert.ok(row !== undefined, '后台改唤醒规则必须进审计')
  assert.equal(row['actor'], 'admin')
  assert.equal(row['affects_model'], 1, '影响模型 ⇒ 待报告')
  assert.equal(row['reported'], 0, '等着被合并报告')
})

test('唤醒规则：未知条件与越界概率被挡住（不静默接受坏配置）', async () => {
  const bad = await post('/api/forlife/qq/wake-rules', { scope: '*', condition: '不存在的条件', probability: 10 })
  assert.equal(bad.status, 400)
  assert.match(String(bad.body['error']), /未知的唤醒条件/)

  const clamped = await post('/api/forlife/qq/wake-rules', { scope: '*', condition: 'temp_message', probability: 500 })
  assert.equal(clamped.status, 200)
  assert.equal((clamped.body['rule'] as Record<string, unknown>)['probability'], 100, '越界值应被夹到 100')
})

test('后台对话：能发、能读、留痕，且明确告知"已入队"', async () => {
  const sent = await post('/api/forlife/admin/chat', { text: '你好，看看今天的记忆情况', actor: 'HiBer2007' })
  assert.equal(sent.status, 200)
  assert.equal(sent.body['ok'], true)
  assert.match(String(sent.body['note']), /已入队/)

  const chat = await get('/api/forlife/admin/chat')
  const messages = chat['messages'] as Record<string, unknown>[]
  const mine = messages.find((m) => String(m['text']).includes('看看今天的记忆情况'))
  assert.ok(mine !== undefined)
  assert.equal(mine['role'], 'human')
  assert.equal(mine['actor'], 'HiBer2007')
  assert.equal(mine['handled'], false, '还没被网关消费')
  assert.ok(Number(chat['pending']) >= 1, '未处理计数要能看到（面板红点）')

  const audit = runtime.db
    .prepare("SELECT * FROM effects WHERE kind = 'admin_action' AND detail LIKE '%admin.chat.post%' ORDER BY rowid DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined
  assert.ok(audit !== undefined, '人类直发消息要留痕（谁在什么时候说了什么）')
})

test('后台对话：空消息被拒绝（不制造空轮次）', async () => {
  const empty = await post('/api/forlife/admin/chat', { text: '   ' })
  assert.equal(empty.status, 400)
  assert.match(String(empty.body['error']), /不能为空/)
})

test('待读池与判定留痕：面板能回答"为什么没唤醒"', async () => {
  runtime.db
    .prepare(
      `INSERT INTO wake_events (id, scope, condition, conversation_key, decision, reason, roll, at)
       VALUES ('api_wake_1', 'group:88888', 'group_message_any', 'onebot11:88888', 'skip', 'disabled', 0.5, ?)`,
    )
    .run(new Date().toISOString())
  runtime.db
    .prepare(
      `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
       VALUES ('api_pend_1', 'group:88888', 'onebot11:88888', '老王', '他们聊了明天的会议', ?, 0, NULL)`,
    )
    .run(new Date().toISOString())

  const events = await get('/api/forlife/qq/wake-events')
  const skip = (events['events'] as Record<string, unknown>[]).find((e) => e['id'] === 'api_wake_1')
  assert.equal(skip?.['reason'], 'disabled', '不唤醒的原因必须能查到')
  assert.equal(skip?.['roll'], 0.5, '概率判定的随机数要留着（可复算）')

  const pending = await get('/api/forlife/qq/pending')
  assert.ok((pending['items'] as Record<string, unknown>[]).some((i) => i['id'] === 'api_pend_1'))
  assert.ok(Number((pending['stats'] as Record<string, number>)['unread']) >= 1)
})

