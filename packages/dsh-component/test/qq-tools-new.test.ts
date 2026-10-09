/**
 * 新 QQ 工具（合并转发 / 请求 / 联系人 / 取回额度）的行为测试 + **接线守卫**。
 *
 * ## 接线守卫这一半为什么必须存在
 *
 * 本项目栽过 20+ 次"库代码写好了、单测全绿、生产路径零调用"。
 * 最近的两次就在眼前：
 *  - `buildQqTools` 写好但 `apply()` 没调 ⇒ 9 个 QQ 工具在生产里不存在；
 *  - `reports.ts` 的 `runReportCycle` 写好但生产零调用 ⇒ 好友申请永远到不了模型。
 *
 * ⇒ 所以这里对**每一条新接线**都做两件事：
 *  1. **读源码**（`stripComments` 去注释后、且要求出现在**语句位置**上）——
 *     防"注释里写了、代码里没写"；
 *  2. **断言结果被用**（例如 `if (!decision.allowed)` —— 只算不用等于没接）。
 *
 * 行为那一半走**真工具 + 真库**（`buildQqTools` → `execute`），断言落在 `qq_outbox` 上。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { defaultFor } from '@forlife/contracts'
import { backlogReadQuota, consumeBacklogRead, seedBacklogWakeRule, seedWakeRules } from '@forlife/gateway'
import { openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { buildQqTools, QQ_TOOL_NAMES, QQ_WAKE_CONDITIONS } from '../src/qq-tools.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-qqtools2-'))
let runtime: MemoryRuntime

before(() => {
  const opened = openDatabase({ file: join(dir, 'seed.sqlite') })
  seedWakeRules(opened.db)
  opened.close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }), dbPath: join(dir, 'forlife.sqlite') })
  seedWakeRules(runtime.db)
  seedBacklogWakeRule(runtime.db)
  // 登记一个**群**会话：`qq_reply` / `qq_forward` 的 kind 是从 `qq_sessions` 查的，
  // 不登记就会回落成 private —— 那正好是"群消息被发成私聊"那类灾难的现场。
  runtime.db
    .prepare(
      `INSERT INTO qq_sessions (conversation_key, platform, chat_id, thread_id, kind, title, last_message_at, last_read_at, created_at)
       VALUES ('onebot11:88888', 'onebot11', '88888', NULL, 'group', '测试群', NULL, NULL, ?)
       ON CONFLICT(conversation_key) DO NOTHING`,
    )
    .run(new Date().toISOString())
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

const TEST_CONFIRM_TIMEOUT_MS = 120
const exec = { callId: 'c1', signal: new AbortController().signal }

function tool(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildQqTools(defineTool as never, runtime, { confirmTimeoutMs: TEST_CONFIRM_TIMEOUT_MS }) as unknown as {
    name: string
    execute(args: unknown, exec: unknown): Promise<unknown>
  }[]
  const found = tools.find((t) => t.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

/** 从源码里去掉注释 —— **注释不算接线**（本仓的铁律）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** 读一个源码文件（相对 `src/`）。 */
function src(relative: string): string {
  return stripComments(readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8'))
}

/**
 * 读**另一个包**的源码（网关侧）。
 *
 * 为什么要跨包读：这几条接线一头在 `dsh-component`（工具、插件），
 * 另一头在 `gateway`（主循环、传输层）。只守一边等于没守 ——
 * "插件开了开关但网关不看它"是本项目最典型的一种假接线。
 */
function gatewaySrc(relative: string): string {
  return stripComments(readFileSync(new URL(`../../gateway/src/${relative}`, import.meta.url), 'utf8'))
}

// ── 接线守卫（读源码 · 去注释 · 语句位置 · 断言结果被用）────────────────────

test('★★ 接线守卫：插件里**真的开了**系统监督循环（没有它，报告/请求/积压全是死的）', () => {
  const body = src('gateway-plugin.ts')
  // 语句位置：出现在 `new Gateway({ … })` 的参数里
  assert.match(body, /new Gateway\(\{/, '必须真的构造网关')
  assert.match(body, /supervisor:\s*\{\s*enabled:\s*true\s*\}/, '★ `supervisor.enabled` 必须在 `new Gateway({…})` 里显式为 true')
  // 播种积压那组参数：不播种就没有 min_interval，第一次改动会被硬编码兜底覆盖
  assert.match(body, /seedBacklogWakeRule\(runtime\.db\)/, '积压规则必须播种')
  // 唤醒提示改成"只报数量"
  assert.match(body, /backlogNotice\(runtime\.db\)/, '唤醒提示必须用计数型通知')
  assert.ok(!/readPending\(runtime\.db,\s*\{\s*scope,\s*limit:\s*5/.test(body), '**旧的"塞 5 条摘要"写法必须删掉**')
})

test('★★ 接线守卫：网关主循环里**出站消费接了投递节拍**（结果被用）', () => {
  const body = gatewaySrc('gateway.ts')
  assert.match(body, /const pacing = deliverPacing\(this\.options\.db\)/, '要真的算节拍')
  assert.match(body, /if \(pacing\.waitMs > 0\)/, '★ 结果必须被用在判断里 —— 只算不用等于没接')
  // 节拍必须在**认领之前**：认领之后再等，行会卡在 sending
  const pacingAt = body.indexOf('const pacing = deliverPacing')
  const claimAt = body.indexOf('claimPendingOutbound(this.options.db')
  assert.ok(pacingAt >= 0 && claimAt >= 0 && pacingAt < claimAt, '节拍判定必须在认领之前')
})

test('★★ 接线守卫：合并转发的内容**真的被取回来并用上**（P0-3）', () => {
  const body = gatewaySrc('gateway.ts')
  assert.match(body, /await this\.options\.transport\.getForward\(forwardId\)/, '要真的调 getForward')
  assert.match(body, /const enriched = await this\.resolveForwards\(messages\)/, '结果必须被用在这一批上')
  // ★ 这一条改过一次名字：`enriched` 之后又串了一道**入站媒体**（P1-1/P1-2/P2-b）的解析，
  //   所以交给轮次的那一批叫 `withMedia` —— 但**断言的本意不变**：
  //   交给轮次的必须是**补过内容的那一批**（用原批就等于没接）。
  assert.match(body, /const withMedia = await this\.resolveMedia\(enriched\)/, '媒体解析必须建立在合转展开的结果上')
  assert.match(body, /handleBatch\(withMedia, controller\.signal\)/, '★ 交给轮次的必须是**补过内容的那一批**（用原批就等于没接）')
})

test('★★ 接线守卫：入站 `request` 事件**走结构化落库**（不是塞进原始 JSON）', () => {
  const body = gatewaySrc('gateway.ts')
  assert.match(body, /recordInboundRequest\(this\.options\.db,\s*\{/, '请求必须结构化落库')
  assert.match(body, /if \(event\.type === 'request'\)/, '要显式分支')
})

test('★★ 接线守卫：工具层的两个方向限制**结果都被用**（去注释后）', () => {
  const body = src('qq-tools.ts')
  // 取：额度结果必须决定取几条
  assert.match(body, /const quota = backlogReadQuota\(runtime\.db/, '要真的问额度')
  assert.match(body, /if \(!quota\.allowed\)/, '★ 拦截结果必须被用')
  assert.match(body, /limit: quota\.granted/, '★ 取几条必须由额度决定')
  assert.match(body, /consumeBacklogRead\(runtime\.db, read\.items\.length\)/, '取完要记账')
  // 发：速率闸门
  assert.match(body, /const gate = sendGate\(\)/, '要真的算速率')
  assert.match(body, /if \(gate !== undefined\)/, '★ 拦截结果必须被用')
  // 合转 + 请求处理也纳入限流
  const gates = body.match(/sendGate\(\)/g) ?? []
  assert.ok(gates.length >= 2, `速率闸门至少要在 qq_reply 与 qq_forward 两处生效，实际 ${String(gates.length)} 处`)
})

test('★ 接线守卫：`read_pending` 不再直接调 `readPending`（筛选与标记已读只有一条路）', () => {
  const body = src('qq-tools.ts')
  assert.ok(!/readPending\(/.test(body), '工具层不该再直接调 `readPending` —— 那会绕过取回额度')
  assert.match(body, /readBacklog\(runtime\.db,\s*\{/, '要走带额度与筛选的 readBacklog')
})

test('★ 接线守卫：积压那一组**没被塞进** `WAKE_CONDITIONS`（那是别人的文件，纪律）', () => {
  const wake = gatewaySrc('wake.ts')
  assert.ok(!wake.includes('pending_backlog'), '`wake.ts` 里不该出现 pending_backlog（本轮它属于另一个改动）')
  assert.ok((QQ_WAKE_CONDITIONS as readonly string[]).includes('pending_backlog'), '但工具面必须能配它')
})

// ── 工具行为 ────────────────────────────────────────────────────────────────

test('工具清单：新增的四个工具都在，且总数与 QQ_TOOL_NAMES 一致', () => {
  const tools = buildQqTools(defineTool as never, runtime, { confirmTimeoutMs: TEST_CONFIRM_TIMEOUT_MS }) as unknown as { name: string }[]
  assert.deepEqual(tools.map((t) => t.name).sort(), [...QQ_TOOL_NAMES].sort())
  for (const name of ['qq_forward', 'qq_requests', 'qq_handle_request', 'qq_contacts']) {
    assert.ok(tools.some((t) => t.name === name), `缺工具 ${name}`)
  }
})

test('★ qq_forward（发）：入队的是 `kind=forward` 且 nodes 全是 node', async () => {
  const result = (await tool('qq_forward').execute(
    { conversation: 'onebot11:88888', nodes: [{ name: '小满', text: '打包一段' }] },
    exec,
  )) as { ok: boolean; mode: string; confirmed: boolean }
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'send')
  const row = runtime.db.prepare("SELECT * FROM qq_outbox WHERE kind = 'forward' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  assert.ok(row !== undefined, '合并转发必须入队（走既有出站链路）')
  const payload = JSON.parse(String(row['payload'])) as { nodes: Record<string, unknown>[] }
  assert.equal(payload.nodes[0]?.['type'], 'node')
  assert.ok(Array.isArray((payload.nodes[0]?.['data'] as Record<string, unknown>)['content']))
  assert.equal(row['conversation_kind'], 'group', '群聊不能发成私聊')
})

test('★ qq_forward：nodes 与 message_ids 必须给且只给一个', async () => {
  const both = (await tool('qq_forward').execute({ conversation: 'onebot11:88888', nodes: [{ text: 'a' }], message_ids: ['1'] }, exec)) as { ok: boolean; hint?: string }
  assert.equal(both.ok, false)
  assert.match(both.hint ?? '', /只给一个/)
  const neither = (await tool('qq_forward').execute({ conversation: 'onebot11:88888' }, exec)) as { ok: boolean }
  assert.equal(neither.ok, false)
})

test('★ qq_forward（收）：走白名单查询，超时/失败时如实说明（不编一个空结果）', async () => {
  const result = (await tool('qq_forward').execute({ read: 'fwd-1' }, exec)) as { ok: boolean; mode: string; hint?: string }
  assert.equal(result.mode, 'read')
  assert.equal(result.ok, false, '这里没有网关在跑 ⇒ 必须如实说失败')
  assert.match(result.hint ?? '', /没有在|超时|失败/)
  const row = runtime.db.prepare("SELECT * FROM qq_outbox WHERE kind = 'probe' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  assert.ok(row !== undefined, '查询必须走 probe 接缝')
})

test('★ read_pending：按 kind 筛 + 报剩余 + 报额度', async () => {
  const at = new Date().toISOString()
  const insert = runtime.db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
     VALUES (?, ?, ?, '老王', ?, ?, 0, NULL)`,
  )
  insert.run('bp-g1', 'group:88888', 'onebot11:88888', '群里的', at)
  insert.run('bp-p1', 'private:10001', 'onebot11:10001', '私聊的', at)

  const priv = (await tool('read_pending').execute({ kind: 'private' }, exec)) as { count: number; remaining: number; quota?: string; items: { summary: string }[] }
  assert.equal(priv.count, 1)
  assert.equal(priv.items[0]?.summary, '私聊的')
  assert.equal(priv.remaining, 0, '剩余量要按同一筛选口径')
  assert.ok((priv.quota ?? '').includes('还剩'), '要把本轮剩余额度告诉模型')

  const rest = (await tool('read_pending').execute({}, exec)) as { count: number }
  assert.equal(rest.count, 1, '群里那条还在')
})

test('★★ read_pending：额度用尽时**明确拒绝并说明**（不是默默少返回几条）', async () => {
  // 把本轮的批数用完
  const batchesMax = defaultFor<number>('qq.backlog.readPerTurnBatches')
  for (let i = 0; i < batchesMax + 1; i++) consumeBacklogRead(runtime.db, 1)
  assert.equal(backlogReadQuota(runtime.db).allowed, false, '前提：额度确实用尽了')

  runtime.db
    .prepare(
      `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
       VALUES ('bp-x', 'private:10001', 'onebot11:10001', '老王', '还有一条', ?, 0, NULL)`,
    )
    .run(new Date().toISOString())
  const result = (await tool('read_pending').execute({}, exec)) as { ok: boolean; count: number; hint?: string }
  assert.equal(result.ok, false)
  assert.equal(result.count, 0)
  assert.match(result.hint ?? '', /readPerTurnBatches/, '要说清是被哪条上限挡的 —— 否则模型以为工具坏了')
  // 关键：被拦下的那一条**不能被标记已读**（否则它就被吞掉了）
  const row = runtime.db.prepare("SELECT read FROM pending_messages WHERE id = 'bp-x'").get() as { read: number }
  assert.equal(row.read, 0, '被限流时不许吃掉消息')
})

test('★ qq_requests：列出待处理请求（flag 必须能取到）', async () => {
  runtime.db
    .prepare(
      `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
       VALUES ('qqreq_test1', 'qq_request', 'system', 'flag-abc', ?, 1, 0, ?)`,
    )
    .run(JSON.stringify({ requestKind: 'friend', userId: '40001', comment: '我是小明' }), new Date().toISOString())

  const result = (await tool('qq_requests').execute({}, exec)) as { ok: boolean; pending: number; items: { flag: string; userId: string; comment: string }[] }
  assert.equal(result.ok, true)
  assert.ok(result.pending >= 1)
  const item = result.items.find((i) => i.flag === 'flag-abc')
  assert.ok(item !== undefined, 'flag 必须出现在结果里 —— 否则处理不了')
  assert.equal(item.userId, '40001')
  assert.equal(item.comment, '我是小明')
})

test('★ qq_handle_request：入队 friend_request（不是 text，也不猜目标）', async () => {
  const result = (await tool('qq_handle_request').execute({ flag: 'flag-abc', kind: 'friend', approve: true, reason: '认识' }, exec)) as { ok: boolean; confirmed: boolean }
  assert.equal(result.ok, true)
  const row = runtime.db.prepare("SELECT * FROM qq_outbox WHERE kind = 'friend_request' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  assert.ok(row !== undefined)
  const payload = JSON.parse(String(row['payload'])) as { flag: string; approve: boolean; reason: string }
  assert.equal(payload.flag, 'flag-abc')
  assert.equal(payload.approve, true)
})

test('★ qq_handle_request：空 flag 直接拒（flag 只能来自上报）', async () => {
  const result = (await tool('qq_handle_request').execute({ flag: '  ', kind: 'group', approve: true }, exec)) as { ok: boolean; hint?: string }
  assert.equal(result.ok, false)
  assert.match(result.hint ?? '', /qq_requests/)
})

test('★★ qq_handle_request：小时额度用尽时拦下，并说明（防被疯狂申请刷）', async () => {
  const perHour = defaultFor<number>('qq.requests.handlePerHourMax')
  const at = new Date().toISOString()
  const statement = runtime.db.prepare(
    `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source, conversation_kind)
     VALUES (?, 'onebot11:0', NULL, 'group_request', '{}', ?, 0, NULL, NULL, 'sent', NULL, 0, 'model', 'private')`,
  )
  for (let i = 0; i < perHour; i++) statement.run(`rate_${String(i)}`, at)
  const result = (await tool('qq_handle_request').execute({ flag: 'flag-xyz', kind: 'group', approve: true }, exec)) as { ok: boolean; throttled?: boolean; hint?: string }
  assert.equal(result.ok, false)
  assert.equal(result.throttled, true)
  assert.match(result.hint ?? '', /handlePerHourMax/)
})

test('★ qq_contacts：需要 group_id 时缺了就拒；否则走 probe', async () => {
  const missing = (await tool('qq_contacts').execute({ kind: 'members' }, exec)) as { ok: boolean; hint?: string }
  assert.equal(missing.ok, false)
  assert.match(missing.hint ?? '', /group_id/)
  const ok = (await tool('qq_contacts').execute({ kind: 'groups' }, exec)) as { ok: boolean; hint?: string }
  assert.equal(ok.ok, false, '没有网关在跑 ⇒ 如实报失败')
  const row = runtime.db.prepare("SELECT * FROM qq_outbox WHERE kind = 'probe' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  const payload = JSON.parse(String(row['payload'])) as { probeAction: string }
  assert.equal(payload.probeAction, 'get_group_list')
})

test('★ list_wake_rules：必须能列出 `pending_backlog`（否则模型没法"忽略离线群消息"）', async () => {
  const result = (await tool('list_wake_rules').execute({ scope: '*' }, exec)) as { rules: { condition: string; enabled: boolean }[] }
  const backlog = result.rules.find((r) => r.condition === 'pending_backlog')
  assert.ok(backlog !== undefined, '单独那一组必须出现在列表里')
})

test('★ set_wake_rule：能关掉 `pending_backlog`，且**保留基线里的最小间隔**', async () => {
  const result = (await tool('set_wake_rule').execute({ scope: '*', condition: 'pending_backlog', enabled: false }, exec)) as { ok: boolean; enabled: boolean }
  assert.equal(result.ok, true)
  assert.equal(result.enabled, false)
  const row = runtime.db
    .prepare("SELECT enabled, min_interval_ms FROM wake_rules WHERE scope = '*' AND condition = 'pending_backlog'")
    .get() as { enabled: number; min_interval_ms: number }
  assert.equal(row.enabled, 0)
  assert.equal(row.min_interval_ms, defaultFor<number>('qq.backlog.wakeIntervalMs'), '最小间隔不能被硬编码兜底覆盖成 0')
  // 复位，免得影响别的用例
  await tool('set_wake_rule').execute({ scope: '*', condition: 'pending_backlog', enabled: true }, exec)
})

test('★ qq_reply：被速率闸门拦下时**不入队**（消息不许留在队列里）', async () => {
  const burstMax = defaultFor<number>('qq.send.burstMax')
  const at = new Date().toISOString()
  const statement = runtime.db.prepare(
    `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source, conversation_kind)
     VALUES (?, 'onebot11:88888', NULL, 'text', '{}', ?, 0, NULL, NULL, 'sent', NULL, 0, 'model', 'group')`,
  )
  for (let i = 0; i < burstMax; i++) statement.run(`burst_${String(i)}`, at)
  const before = (runtime.db.prepare("SELECT count(*) AS n FROM qq_outbox WHERE kind = 'text'").get() as { n: number }).n
  const result = (await tool('qq_reply').execute({ conversation: 'onebot11:88888', text: '刷屏试试' }, exec)) as { ok: boolean; throttled?: boolean; hint?: string }
  assert.equal(result.ok, false)
  assert.equal(result.throttled, true)
  assert.match(result.hint ?? '', /burstMax/)
  const after = (runtime.db.prepare("SELECT count(*) AS n FROM qq_outbox WHERE kind = 'text'").get() as { n: number }).n
  assert.equal(after, before, '★ 被拦下的消息**不许入队**（入队了就等于发出去了）')
})
