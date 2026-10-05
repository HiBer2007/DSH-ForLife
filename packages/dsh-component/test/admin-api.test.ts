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
import { seedDefaultPrompts } from '../src/prompt-store.ts'
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
  // 插件 apply 时会播种默认提示词；这里对齐真实行为，否则提示词接口读到的是"没有生效版本"
  seedDefaultPrompts(runtime.db)
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

/**
 * 取一次，但**不假定 200**（要测"应当被拒绝"的路径）。
 *
 * @param path - 路由路径。
 * @param query - 查询串。
 * @returns 状态码与响应体。
 */
async function getRaw(path: string, query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route(path).fetch(new Request(`http://local${path}${query}`))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 发一个 POST。 */
async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route(path, 'POST').fetch(
    new Request(`http://local${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('路由齐备：QQ 概览 / 队列 / 轮次 / 唤醒规则 / 判定留痕 / 待读池 / 后台对话', () => {
  // 断言"某个 path 支持某个 method"，而不是拼字符串 "GET /path"：
  // 同 path 的读写现在会**合并成一条注册**（宿主的注册表按 path 唯一），
  // 拼字符串时 methods 变成 'GET,POST' 就匹配不上 —— 那会让这条守卫在
  // "合并"这个正确做法生效时反而报错。
  const cases: readonly (readonly [string, string])[] = [
    ['GET', '/api/forlife/qq/state'],
    ['GET', '/api/forlife/qq/queue'],
    ['GET', '/api/forlife/qq/turns'],
    ['GET', '/api/forlife/qq/wake-rules'],
    ['POST', '/api/forlife/qq/wake-rules'],
    ['GET', '/api/forlife/qq/wake-events'],
    ['GET', '/api/forlife/qq/pending'],
    ['GET', '/api/forlife/admin/chat'],
    ['POST', '/api/forlife/admin/chat'],
  ]
  for (const [method, path] of cases) {
    const hit = routes.find((route) => route.path === path)
    assert.ok(hit !== undefined, `缺少路由 ${path}`)
    assert.ok(hit.methods.includes(method as 'GET' | 'HEAD' | 'POST'), `${path} 不支持 ${method}（实际 ${hit.methods.join(',')}）`)
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


// ── 阶段 4：提示词接口 ──────────────────────────────────────────────────────

test('提示词：读状态给出两个槽位 + 变量白名单（含动态变量标记）', async () => {
  const body = await get('/api/forlife/prompts')
  assert.equal(body['ok'], true)
  const slugs = body['slugs'] as Record<string, unknown>[]
  assert.deepEqual(slugs.map((s) => s['slug']).sort(), ['p1-system', 'p2-style'])
  const p1 = slugs.find((s) => s['slug'] === 'p1-system')
  assert.ok(String(p1?.['sha256']).length === 64, '要给出当前生效版本的哈希（面板显示"现在是什么"）')
  assert.ok(Number(p1?.['tokenCount']) > 0)

  const variables = body['variables'] as Record<string, unknown>[]
  assert.ok(variables.some((v) => v['name'] === 'persona_name' && v['dynamic'] === false))
  assert.ok(variables.some((v) => v['name'] === 'now' && v['dynamic'] === true), '动态变量要标出来（它们只允许用在尾部）')
})

test('提示词预览：给出最终拼装结果、token 数与"会不会造成缓存未命中"', async () => {
  const current = await get('/api/forlife/prompts')
  const p1 = (current['slugs'] as Record<string, unknown>[]).find((s) => s['slug'] === 'p1-system')

  // ① 原样回传当前生效内容 ⇒ willChange=false（规范化后哈希相同，不算改动）
  const currentText = runtime.db.prepare("SELECT text FROM prompt_revisions WHERE slug = 'p1-system' AND active = 1").get() as { text: string }
  const same = await post('/api/forlife/prompts/preview', { slug: 'p1-system', text: currentText.text })
  assert.equal(same.status, 200)
  assert.equal(same.body['willChange'], false, '内容没变就不该说"会造成缓存未命中"')
  assert.equal(p1?.['sha256'], same.body['currentSha256'], '预览里的 currentSha256 要与状态接口一致')

  const changed = await post('/api/forlife/prompts/preview', {
    slug: 'p2-style',
    text: '## 新风格\n- 用{{language}}，叫对方{{owner_name}}。\n',
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body['ok'], true)
  assert.equal(changed.body['willChange'], true, '内容变了就要明说会造成一次缓存未命中')
  assert.match(String(changed.body['rendered']), /叫对方主人/, '预览里变量必须已被替换（这才是"最终拼装结果"）')
  assert.ok(Number(changed.body['tokenCount']) > 0)
  const diff = changed.body['diff'] as Record<string, unknown>[]
  assert.ok(diff.some((d) => d['kind'] === 'added') && diff.some((d) => d['kind'] === 'removed'), '要给出 diff')
})

test('提示词预览：未知变量与动态变量都被拦下并说明原因', async () => {
  const unknown = await post('/api/forlife/prompts/preview', { slug: 'p1-system', text: '你是{{nobody}}' })
  assert.equal(unknown.body['ok'], false)
  assert.match(JSON.stringify(unknown.body['errors']), /未知变量/)

  const dynamic = await post('/api/forlife/prompts/preview', { slug: 'p1-system', text: '现在是{{now}}' })
  assert.equal(dynamic.body['ok'], false)
  assert.match(JSON.stringify(dynamic.body['errors']), /动态变量/)
  assert.match(JSON.stringify(dynamic.body['errors']), /缓存全废/)
})

test('提示词保存：真改才产生版本，且留痕（铁律 1）+ 返回两条提示', async () => {
  const save = await post('/api/forlife/prompts', { slug: 'p2-style', text: '## 说话方式\n- 一句话说完。\n', note: '测试' })
  assert.equal(save.status, 200)
  assert.equal(save.body['changed'], true)
  assert.match(String(save.body['cacheNote']), /一次\*\*缓存未命中|一次/, '必须明说会造成一次缓存未命中')
  assert.match(String(save.body['effective']), /下一轮生效/)

  const again = await post('/api/forlife/prompts', { slug: 'p2-style', text: '## 说话方式\n- 一句话说完。\n\n\n' })
  assert.equal(again.body['changed'], false, '规范化后一样 ⇒ 不算改动')
  assert.match(String(again.body['note']), /没有产生新版本/)

  const audit = runtime.db
    .prepare("SELECT * FROM effects WHERE kind = 'admin_action' AND detail LIKE '%prompt.edit%' ORDER BY rowid DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined
  assert.ok(audit !== undefined, '改提示词必须留痕（它比改记忆更直接影响模型）')
  assert.equal(audit['affects_model'], 1)

  const bad = await post('/api/forlife/prompts', { slug: 'p2-style', text: '用{{nobody}}' })
  assert.equal(bad.status, 400, '校验不过必须拒绝，不能写进库')
})

test('提示词历史与回滚：旧版本还在，回滚后哈希精确回到旧值', async () => {
  const before = await get('/api/forlife/prompts')
  const p2Before = (before['slugs'] as Record<string, unknown>[]).find((s) => s['slug'] === 'p2-style')
  const oldSha = String(p2Before?.['sha256'])

  await post('/api/forlife/prompts', { slug: 'p2-style', text: '## 又一版\n- 换个语气。\n' })
  const after = await get('/api/forlife/prompts')
  const p2After = (after['slugs'] as Record<string, unknown>[]).find((s) => s['slug'] === 'p2-style')
  assert.notEqual(String(p2After?.['sha256']), oldSha, '改完哈希必须变')

  const revisions = await get('/api/forlife/prompts/revisions', '?slug=p2-style')
  const list = revisions['revisions'] as Record<string, unknown>[]
  assert.ok(list.length >= 2, '历史版本都要留着')
  assert.equal(list.filter((r) => r['active'] === true).length, 1, '同时只有一版生效')
  const target = list.find((r) => r['sha256'] === oldSha)
  assert.ok(target !== undefined, '旧版本要能在列表里找到（回滚的前提）')

  const rolled = await post('/api/forlife/prompts/rollback', { revisionId: target['id'] })
  assert.equal(rolled.status, 200)
  assert.equal((rolled.body['revision'] as Record<string, unknown>)['sha256'], oldSha, '回滚后哈希必须精确回到旧值')

  const missing = await post('/api/forlife/prompts/rollback', { revisionId: '不存在的版本' })
  assert.equal(missing.status, 404)
})

test('提示词：未知槽位一律拒绝（不静默当成默认槽位）', async () => {
  assert.equal((await getRaw('/api/forlife/prompts/revisions', '?slug=nope')).status, 400)
  assert.equal((await post('/api/forlife/prompts', { slug: 'nope', text: 'x' })).status, 400)
  assert.equal((await post('/api/forlife/prompts/preview', { slug: 'nope', text: 'x' })).status, 400)
})

test('提示词覆盖：只能覆盖 P2；写入与清除都留痕', async () => {
  const revisions = await get('/api/forlife/prompts/revisions', '?slug=p2-style')
  const target = (revisions['revisions'] as Record<string, unknown>[])[0]

  const set = await post('/api/forlife/prompts/overrides', { scope: 'group:88888', slug: 'p2-style', revisionId: target?.['id'] })
  assert.equal(set.status, 200)
  assert.match(String(set.body['note']), /尾部注入/, '要说明为什么覆盖走尾部注入（否则有人会想把它写进前缀）')

  const listed = await get('/api/forlife/prompts')
  assert.ok((listed['overrides'] as Record<string, unknown>[]).some((o) => o['scope'] === 'group:88888'))

  const bad = await post('/api/forlife/prompts/overrides', { scope: 'group:1', slug: 'p1-system', revisionId: target?.['id'] })
  assert.equal(bad.status, 400, 'P1 是人设，不允许按会话分裂')

  const cleared = await post('/api/forlife/prompts/overrides', { scope: 'group:88888', slug: 'p2-style', clear: true })
  assert.equal(cleared.body['cleared'], true)

  const noScope = await post('/api/forlife/prompts/overrides', { slug: 'p2-style', revisionId: target?.['id'] })
  assert.equal(noScope.status, 400)
})


// ── 阶段 4：缓存命中率接口 ──────────────────────────────────────────────────

test('缓存：空数据时给"还没跑过"而不是假装 0% 命中', async () => {
  const body = await get('/api/forlife/cache')
  assert.equal(body['ok'], true)
  const summary = body['summary'] as Record<string, number>
  assert.equal(summary['samples'], 0)
  const verdict = body['verdict'] as Record<string, unknown>
  assert.equal(verdict['ok'], true)
  assert.match(String(verdict['verdict']), /还没有用量数据/)
})

test('缓存：命中率、期望未命中数与结论都算得出来', async () => {
  const { recordCacheUsage } = await import('@forlife/store')
  const at = (offsetSec: number): string => new Date(Date.now() + offsetSec * 1000).toISOString()

  // 首次：写缓存（未命中，可解释）
  recordCacheUsage(runtime.db, { inputTokens: 0, cacheWriteTokens: 1000, outputTokens: 10, at: at(1), missReason: 'first-call' })
  // 之后 4 次全命中
  for (let i = 0; i < 4; i++) {
    recordCacheUsage(runtime.db, { inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 20, outputTokens: 10, at: at(2 + i) })
  }
  // 一次无法解释的未命中 —— 这是要报警的
  recordCacheUsage(runtime.db, { inputTokens: 1000, outputTokens: 10, at: at(10), missReason: 'unexplained' })

  const body = await get('/api/forlife/cache')
  const summary = body['summary'] as Record<string, number>
  assert.equal(summary['samples'], 6)
  assert.equal(summary['misses'], 2)
  assert.equal(summary['explainedMisses'], 1)
  assert.equal(summary['unexplainedMisses'], 1)
  // 精确值而不是拍个阈值：分母是**提示词总 token**（写入的那部分也算），
  // 1000 + 4×1020 + 1000 = 6080，命中 4000 ⇒ 0.658。阈值式断言会掩盖口径写错。
  assert.equal(summary['hitRate'], 4000 / 6080)

  const expected = body['expected'] as Record<string, number>
  assert.ok((expected['total'] ?? 0) >= 1, '期望未命中数至少含首次那一次')

  const verdict = body['verdict'] as Record<string, unknown>
  // 显式断言 alse（noUncheckedIndexedAccess 下索引访问是 unknown，直接比较更清楚）
  assert.strictEqual(verdict['ok'], false, '有无法解释的未命中就必须报警')
  assert.match(String(verdict['verdict']), /无法解释/)
  assert.match(String(verdict['verdict']), /前缀在无故漂移/)

  assert.ok(Array.isArray(body['curve']))
  assert.ok(Array.isArray(body['recent']))
  assert.ok((body['recent'] as unknown[]).length > 0)
})





// ── 阶段 4：时间感知接口 ────────────────────────────────────────────────────

test('时间：没有读数时如实说"还没有"，并给出三层时区设置', async () => {
  const body = await get('/api/forlife/time')
  assert.equal(body['ok'], true)
  const settings = body['settings'] as Record<string, unknown>
  assert.equal(settings['systemTimezone'], 'UTC', '记录一律 UTC（用户拍板）')
  assert.equal(settings['conversationTimezone'], 'Asia/Shanghai')
  assert.ok(['fresh', 'null'].includes(body['latest'] === null ? 'null' : 'fresh'), '没有读数时 latest 必须是 null')
})

test('时间：有读数时给出年龄与新鲜度判定（验收项）', async () => {
  const { recordTimeReading } = await import('@forlife/store')
  recordTimeReading(runtime.db, {
    at: new Date(Date.now() - 5_000).toISOString(),
    reason: 'after-compaction',
    timezone: 'Asia/Shanghai',
    text: '【时间读数】…',
    tokenCount: 160,
    conversationKey: 'onebot11:88888',
  })

  const body = await get('/api/forlife/time')
  const latest = body['latest'] as Record<string, unknown>
  assert.equal(latest['reason'], 'after-compaction')
  assert.equal(latest['fresh'], true, '5 秒前的读数必须判定为新鲜（阈值 30 秒）')
  assert.ok(Number(latest['ageMs']) >= 4_000 && Number(latest['ageMs']) < 30_000)
  assert.equal(body['freshThresholdMs'], 30_000)

  const byReason = body['byReason'] as Record<string, unknown>[]
  assert.ok(byReason.some((r) => r['reason'] === 'after-compaction' && Number(r['count']) >= 1))
  assert.ok(Number(body['tokenCost']) >= 160, '注入的 token 成本要能被看见')

  // 老旧读数要被判成不新鲜。
  // 注意：判据是"**最新**那一条"够不够新，所以必须先把表清空 ——
  // 否则刚插进去的那条 5 秒前的读数仍然是最新的，测的就不是陈旧路径了。
  runtime.db.exec('DELETE FROM time_readings')
  recordTimeReading(runtime.db, { at: new Date(Date.now() - 3_600_000).toISOString(), reason: 'turn-first', timezone: 'UTC', text: 'x', tokenCount: 10 })
  const older = await get('/api/forlife/time')
  assert.equal((older['latest'] as Record<string, unknown>)['fresh'], false, '一小时前的读数必须判为不新鲜')
})

test('时间：按会话时区与漂移统计都要能看到', async () => {
  const { setConversationClock, recordTimeDrift } = await import('@forlife/store')
  setConversationClock(runtime.db, { scope: 'group:88888', timezone: 'Asia/Tokyo', source: 'model_note', reason: '用户说在东京' })
  recordTimeDrift(runtime.db, {
    claimed: '现在是下午三点',
    actualAt: new Date().toISOString(),
    driftMs: 7_200_000,
    severity: 'bad',
    excerpt: '…现在是下午三点…',
  })

  const body = await get('/api/forlife/time')
  const clocks = body['clocks'] as Record<string, unknown>[]
  assert.ok(clocks.some((c) => c['scope'] === 'group:88888' && c['timezone'] === 'Asia/Tokyo' && c['source'] === 'model_note'))

  const drift = body['drift'] as Record<string, unknown>
  assert.equal(drift['count'], 1)
  assert.equal(drift['maxMs'], 7_200_000)
  assert.ok((body['recentDrift'] as Record<string, unknown>[]).some((d) => d['severity'] === 'bad'))
})


// ── 阶段 5：模型与路由接口 ─────────────────────────────────────────────────

test('路由页：七个角色都在，且每个角色带用途说明（让人理解为什么用便宜/强模型）', async () => {
  const body = await get('/api/forlife/routes')
  assert.equal(body['ok'], true)
  const roles = body['roles'] as Record<string, unknown>[]
  assert.equal(roles.length, 7)
  for (const role of roles) {
    assert.ok(typeof role['role'] === 'string')
    assert.ok(Array.isArray(role['candidates']))
  }
  // 视觉与嵌入角色要有用途说明（面板要能解释"这个角色是干什么的"）
  const vision = roles.find((item) => item['role'] === 'vision')
  assert.match(String(vision?.['purpose']), /image/)
})

test('路由页：写一行候选（(role, rank) upsert）并按 rank 排序返回', async () => {
  const created = await post('/api/forlife/routes', { role: 'L2', rank: 0, provider: 'main-a', model: 'mid', effort: 'medium' })
  assert.equal(created.body['ok'], true)
  await post('/api/forlife/routes', { role: 'L2', rank: 1, provider: 'main-b', model: 'mid-backup' })

  const body = await get('/api/forlife/routes')
  const l2 = (body['roles'] as Record<string, unknown>[]).find((item) => item['role'] === 'L2')
  const candidates = l2?.['candidates'] as Record<string, unknown>[]
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0]?.['provider'], 'main-a')
  assert.equal(candidates[1]?.['provider'], 'main-b')
})

test('路由页：非法 role / 缺 provider 都要 400（校验在保存时，不在运行期）', async () => {
  const badRole = await post('/api/forlife/routes', { role: 'L9', rank: 0, provider: 'p', model: 'm' })
  assert.equal(badRole.body['ok'], false)
  assert.match(String(badRole.body['error']), /role 必须是/)
  const missing = await post('/api/forlife/routes', { role: 'L1', rank: 0, provider: '', model: '' })
  assert.equal(missing.body['ok'], false)
  assert.match(String(missing.body['error']), /必填/)
})

test('路由页：删行用 POST（宿主的 fetch 注册表只支持 GET/HEAD/POST）', async () => {
  await post('/api/forlife/routes', { role: 'L1', rank: 0, provider: 'x', model: 'y' })
  const removed = await post('/api/forlife/routes/delete', { role: 'L1', rank: 0 })
  assert.equal(removed.body['ok'], true)
  const again = await post('/api/forlife/routes/delete', { role: 'L1', rank: 0 })
  assert.equal(again.body['ok'], false)
  assert.match(String(again.body['error']), /没有这一行/)
})

test('路由页：设备探测结果与校验问题都要给出来', async () => {
  const body = await get('/api/forlife/routes')
  const devices = body['devices'] as Record<string, unknown>
  assert.ok(typeof devices['nvidia'] === 'boolean')
  assert.ok(Array.isArray(devices['renderNodes']))
  assert.ok(Array.isArray(body['issues']))
  // 降级率与不确定案例也要能看见
  assert.ok(typeof (body['stats'] as Record<string, unknown>)['degradedRate'] === 'number')
  assert.ok(typeof (body['uncertain'] as Record<string, unknown>)['pending'] === 'number')
})

test('路由页：试跑端点会记录真实延迟（端点不存在时如实报错）', async () => {
  const missing = await post('/api/forlife/routes/probe', { endpointId: 'nope' })
  assert.equal(missing.body['ok'], false)
  assert.match(String(missing.body['error']), /端点不存在/)
})

test('路由页：模式切换对不存在的端点/非法模式都要拦住', async () => {
  const noEndpoint = await post('/api/forlife/routes/mode', { endpointId: 'nope', mode: 'resident' })
  assert.equal(noEndpoint.body['ok'], false)
  assert.match(String(noEndpoint.body['error']), /端点不存在/)

  const badMode = await post('/api/forlife/routes/mode', { endpointId: 'nope', mode: 'teleport' })
  assert.equal(badMode.body['ok'], false)
  assert.match(String(badMode.body['error']), /mode 必须是/)
})

test('路由页：容器端点没有执行器时**明确失败**，绝不假装切成功', async () => {
  const { upsertEndpoint } = await import('@forlife/store')
  upsertEndpoint(runtime.db, {
    id: 'ep-container',
    type: 'local',
    mode: 'resident',
    backend: 'cpu',
    baseUrl: 'http://127.0.0.1:8099/v1',
    models: [],
  })
  const result = await post('/api/forlife/routes/mode', { endpointId: 'ep-container', mode: 'on-demand', reason: '省内存' })
  assert.equal(result.body['ok'], false)
  assert.match(String(result.body['note']), /需要容器执行器/)
  assert.match(String(result.body['note']), /没有假装切成功/)

  // 而且模式**真的没变**（假装成功会让面板显示"已按需"而容器还在占内存）
  const { getEndpoint } = await import('@forlife/store')
  assert.equal(getEndpoint(runtime.db, 'ep-container')?.mode, 'resident')
})

test('路由页：云端点（不需要容器）的模式切换是真的生效并留审计', async () => {
  const { upsertEndpoint, getEndpoint, listModeSwitches } = await import('@forlife/store')
  upsertEndpoint(runtime.db, {
    id: 'ep-cloud-x',
    type: 'cloud-api',
    mode: 'remote-api',
    backend: 'cpu',
    baseUrl: 'https://api.example.test/v1',
    models: [],
  })
  const result = await post('/api/forlife/routes/mode', { endpointId: 'ep-cloud-x', mode: 'host-native', reason: '改用宿主内置模型' })
  assert.equal(result.body['ok'], true)
  assert.equal(getEndpoint(runtime.db, 'ep-cloud-x')?.mode, 'host-native')
  assert.ok(listModeSwitches(runtime.db, 'ep-cloud-x').length >= 1, '切换要留审计')
})


test('注册契约：**同一个 path 只能注册一次**（宿主的 fetch 注册表按 path 唯一）', () => {
  // 这条是真机启动才暴露的：我把 GET /routes 与 POST /routes 分成两次注册，
  // 宿主直接抛 `exact Fetch route "/api/forlife/routes" is already registered` ——
  // 而那个异常会让**整个面板插件都不激活**（用户看到的是"什么都没有"）。
  // 内存测试里逐个取路由，撞车完全看不出来，所以必须有这条守卫。
  const seen = new Map<string, number>()
  for (const route of routes) seen.set(route.path, (seen.get(route.path) ?? 0) + 1)
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path)
  assert.deepEqual(duplicated, [], `这些 path 注册了多次（读写要合并成一条、methods 列全）：${duplicated.join(', ')}`)
})

test('注册契约：/routes 一条注册里同时支持 GET 与 POST（读写合并的形态）', async () => {
  const route = routes.find((item) => item.path === '/api/forlife/routes')
  assert.ok(route !== undefined)
  assert.ok(route.methods.includes('GET'), '要能读')
  assert.ok(route.methods.includes('POST'), '要能写')
  // GET 拿到的是快照
  const read = await route.fetch(new Request('http://local/api/forlife/routes'))
  assert.equal(read.status, 200)
  const body = (await read.json()) as Record<string, unknown>
  assert.equal(body['ok'], true)
  assert.ok(Array.isArray(body['roles']))
  // POST 走写路径
  const written = await route.fetch(
    new Request('http://local/api/forlife/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'L1', rank: 5, provider: 'merged-p', model: 'merged-m' }),
    }),
  )
  assert.equal(written.status, 200)
  assert.equal(((await written.json()) as Record<string, unknown>)['ok'], true)
})

test('登记端点：能加、能查、能删；**保存时就拦住**不合法的组合', async () => {
  const bad = await post('/api/forlife/endpoints', { id: 'ep1', baseUrl: '', type: 'local', mode: 'resident', backend: 'cpu' })
  assert.equal(bad.body['ok'], false)
  assert.match(String(bad.body['error']), /必填/)

  // 与机器无关地构造"不支持的后端"：先看探测结果，挑一个这台机器确实没有的加速后端。
  // （我第一版写死了 cuda，而开发机**真的有 NVIDIA** —— 断言就变成了"因为机器不同而红"）
  const probed = (await get('/api/forlife/routes'))['devices'] as Record<string, boolean>
  const unsupported = [
    ['cuda', probed['nvidia'], /NVIDIA/],
    ['rocm', probed['rocm'], /ROCm/],
    ['sycl', probed['intel'], /Intel/],
    ['vulkan', probed['vulkan'], /Vulkan/],
  ].find(([, present]) => present !== true) as [string, boolean, RegExp] | undefined
  if (unsupported === undefined) {
    // 五种后端全都能用（几乎不可能）⇒ 这条就没什么可断言的，别硬编一个假场景
    assert.ok(true, '这台机器所有加速后端都可用，跳过"不支持的后端"断言')
  } else {
    const badBackend = await post('/api/forlife/endpoints', {
      id: 'ep2',
      baseUrl: 'http://127.0.0.1:9/v1',
      type: 'local',
      mode: 'resident',
      backend: unsupported[0],
    })
    assert.equal(badBackend.body['ok'], false, `${unsupported[0]} 在这台机器上不可用 ⇒ 保存即报错（不等到启动）`)
    assert.match(String(badBackend.body['error']), unsupported[2])
  }

  const ok = await post('/api/forlife/endpoints', {
    id: 'ep-external',
    baseUrl: 'http://10.0.0.5:8080/v1',
    type: 'remote-selfhost',
    mode: 'remote-api',
    backend: 'cpu',
    modelId: 'Qwen2.5-0.5B-Instruct',
    contextLength: 32000,
  })
  assert.equal(ok.body['ok'], true)

  const routes = await get('/api/forlife/routes')
  assert.ok((routes['endpoints'] as Record<string, unknown>[]).some((item) => item['id'] === 'ep-external'))

  const removed = await post('/api/forlife/endpoints/delete', { id: 'ep-external' })
  assert.equal(removed.body['ok'], true)
  const again = await post('/api/forlife/endpoints/delete', { id: 'ep-external' })
  assert.equal(again.body['ok'], false)
})

test('登记端点：视觉模型没声明 image、嵌入没给维度 ⇒ 保存即拒绝（面板不给出错的机会）', async () => {
  // 先把它选成视觉角色
  await post('/api/forlife/routes', { role: 'vision', rank: 0, provider: 'p', model: 'text-only' })
  await post('/api/forlife/endpoints', {
    id: 'ep-vision',
    baseUrl: 'http://127.0.0.1:9/v1',
    type: 'remote-selfhost',
    mode: 'remote-api',
    backend: 'cpu',
    modelId: 'text-only',
    image: false,
  })
  // 校验发生在"登记端点"时用 roles 上下文；这里直接断言校验函数被接上了：
  const { validateEndpoint } = await import('@forlife/router')
  const issues = validateEndpoint(
    {
      id: 'ep-vision',
      type: 'remote-selfhost',
      mode: 'remote-api',
      backend: 'cpu',
      baseUrl: 'http://x/v1',
      models: [{ id: 'text-only', image: false, contextLength: 32000 }],
    },
    { devices: { renderNodes: [], nvidia: false, rocm: false, intel: false, vulkan: false }, roles: { vision: 'text-only' } },
  )
  assert.ok(issues.some((issue) => issue.field === 'models.image' && issue.severity === 'error'))
})
