/**
 * 状态通道 + QQ 工具的测试。
 *
 * 守两件最容易被做坏的事：
 *  ① **系统故障状态不可被静默覆盖** —— 否则"在线"可能是幻觉，而真实情况是它已经坏了；
 *  ② **qq_reply 必须显式指路** —— 一个模型窗口同时处理多个会话，猜错目标在群里是灾难性的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { claimPendingOutbound, clearSystemStatus, currentStatus, recordWakeAttempt, seedWakeRules, setSystemStatus } from '@forlife/gateway'
import { openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { buildQqTools, QQ_TOOL_NAMES } from '../src/qq-tools.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-qqtools-'))
let runtime: MemoryRuntime

before(() => {
  const opened = openDatabase({ file: join(dir, 'seed.sqlite') })
  seedWakeRules(opened.db)
  opened.close()
  runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }),
    dbPath: join(dir, 'forlife.sqlite'),
  })
  // 播种唤醒规则（工具要读它们）
  seedWakeRules(runtime.db)
  // 登记一个群会话，让 conversation 解析能拿到 kind
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

/**
 * 从工具集里取一个工具。
 *
 * 刻意注入很短的确认窗口：这里没有网关消费队列，用默认的 3 秒会让每个涉及发送的
 * 用例都干等 3 秒。**超时语义本身在 outbox.test.ts 里单独测过**，这里只测工具行为。
 */
const TEST_CONFIRM_TIMEOUT_MS = 120

function tool(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildQqTools(defineTool as never, runtime, { confirmTimeoutMs: TEST_CONFIRM_TIMEOUT_MS }) as unknown as {
    name: string
    execute(args: unknown, exec: unknown): Promise<unknown>
  }[]
  const found = tools.find((t) => t.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

const exec = { callId: 'c1', signal: new AbortController().signal }

test('工具清单：QQ 侧 9 个工具都在', () => {
  const tools = buildQqTools(defineTool as never, runtime, { confirmTimeoutMs: TEST_CONFIRM_TIMEOUT_MS }) as unknown as { name: string }[]
  assert.deepEqual(tools.map((t) => t.name).sort(), [...QQ_TOOL_NAMES].sort())
})

test('系统状态：设置后带原因，且**锁住**模型的改写', () => {
  const status = setSystemStatus(runtime.db, { state: 'away', reason: '连续 3 次唤醒失败' })
  assert.equal(status.source, 'system')
  assert.equal(status.reason, '连续 3 次唤醒失败')
  assert.equal(currentStatus(runtime.db)?.source, 'system')
})

test('set_status：被系统状态锁住时**拒绝**并说明原因（不静默覆盖）', async () => {
  const result = (await tool('set_status').execute({ state: 'online' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], false, '绝不能把"我暂时无法响应"悄悄改成"在线"')
  assert.equal(result['source'], 'system')
  assert.match(String(result['message']), /系统设置的状态/)
  assert.match(String(result['message']), /连续 3 次唤醒失败/)
  assert.equal(currentStatus(runtime.db)?.source, 'system', '状态必须没变')
})

test('clear_system_status：说明原因后可以清除，并留痕', async () => {
  const result = (await tool('clear_system_status').execute({ reason: '端点已恢复' }, exec)) as Record<string, unknown>
  assert.equal(result['cleared'], true)
  const status = currentStatus(runtime.db)
  assert.equal(status?.source, 'model')
  assert.equal(status?.state, 'online')
  assert.match(status?.text ?? '', /已由 model 清除：端点已恢复/)

  const effect = runtime.db.prepare("SELECT * FROM effects WHERE kind = 'status_cleared' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  assert.ok(effect !== undefined, '清除系统状态必须留痕（谁、为什么）')
  assert.match(String(effect['detail']), /端点已恢复/)
})

test('clear_system_status：本来就不是系统状态时如实说明（不做无意义操作）', async () => {
  const result = (await tool('clear_system_status').execute({ reason: '试试' }, exec)) as Record<string, unknown>
  assert.equal(result['cleared'], false)
  assert.match(String(result['note']), /无需清除/)
})

test('set_status：无系统锁时模型可自由设置', async () => {
  const result = (await tool('set_status').execute({ state: 'busy', text: '在跑长任务' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], true)
  assert.equal(result['state'], 'busy')
  assert.equal(currentStatus(runtime.db)?.text, '在跑长任务')
})

test('唤醒失败计数：达到阈值时触发（并跨重启保留）', () => {
  const first = recordWakeAttempt(runtime.db, false)
  assert.equal(first.failures, 1)
  assert.equal(first.tripped, false)
  assert.equal(recordWakeAttempt(runtime.db, false).failures, 2)
  const third = recordWakeAttempt(runtime.db, false)
  assert.equal(third.failures, 3)
  assert.equal(third.tripped, true, '默认阈值 3 次')
  assert.equal(recordWakeAttempt(runtime.db, true).failures, 0, '成功一次就清零')
})

test('qq_reply：必须有 conversation，且动作进队列等网关发送', async () => {
  const result = (await tool('qq_reply').execute({ conversation: 'onebot11:88888', text: '大家好' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], true)
  assert.equal(result['confirmed'], false, '网关还没认领，当然没确认')
  assert.ok(typeof result['outboxId'] === 'string' && result['outboxId'] !== '')
  assert.match(String(result['hint']), /未收到送达确认|已提交/)

  const claimed = claimPendingOutbound(runtime.db, { limit: 50 })
  const ours = claimed.find((row) => row.id === result['outboxId'])
  assert.ok(ours !== undefined, '动作必须在队列里等网关认领')
  assert.equal(ours.conversation_key, 'onebot11:88888')
  assert.deepEqual(JSON.parse(ours.payload)['segments'], [{ kind: 'text', text: '大家好' }])
})

test('qq_reply：会话键格式不对时明确报错（不猜目标）', async () => {
  const result = (await tool('qq_reply').execute({ conversation: '', text: 'x' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], false)
  assert.match(String(result['hint']), /会话键格式不对/)
})

test('qq_reply：引用与 @ 被拼成正确的消息段顺序', async () => {
  const result = (await tool('qq_reply').execute({ conversation: 'onebot11:88888', text: '收到', reply_to: '500', at: ['10001'] }, exec)) as Record<string, unknown>
  const claimed = claimPendingOutbound(runtime.db, { limit: 100 })
  const ours = claimed.find((row) => row.id === result['outboxId'])
  assert.deepEqual(JSON.parse(ours?.payload ?? '{}')['segments'], [
    { kind: 'reply', messageId: '500' },
    { kind: 'at', userId: '10001' },
    { kind: 'text', text: '收到' },
  ])
})

test('qq_typing：群聊如实返回不支持（不假装成功）', async () => {
  const group = (await tool('qq_typing').execute({ conversation: 'onebot11:88888', on: true }, exec)) as Record<string, unknown>
  assert.equal(group['supported'], false)
  assert.equal(group['ok'], false)
  assert.match(String(group['note']), /群聊没有/)

  const privateChat = (await tool('qq_typing').execute({ conversation: 'onebot11:10001', on: true }, exec)) as Record<string, unknown>
  assert.equal(privateChat['supported'], true)
  const claimed = claimPendingOutbound(runtime.db, { limit: 100 })
  assert.ok(claimed.some((row) => row.kind === 'input_status'), '私聊应当真的入队')
})

test('defer_turn：把当前 running 轮次标记为挂起（§8.3）', async () => {
  const turnId = 'turn_test_defer'
  runtime.db
    .prepare(
      `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
       VALUES (?, 'onebot11:10001', 'running', ?, NULL, NULL, NULL, '[]', 0, 0, 0, NULL, NULL, NULL)`,
    )
    .run(turnId, new Date().toISOString())

  const result = (await tool('defer_turn').execute({ reason: '等下载完成', expected_duration_ms: 60_000 }, exec)) as Record<string, unknown>
  assert.equal(result['deferred'], true)
  assert.equal(result['turnId'], turnId)
  const row = runtime.db.prepare('SELECT * FROM qq_turns WHERE id = ?').get(turnId) as Record<string, unknown>
  assert.equal(row['status'], 'deferred')
  assert.equal(row['defer_reason'], '等下载完成')
  assert.ok(row['defer_until'] !== null, '预计时长要转成"什么时候回来看"')
})

test('defer_turn：没有进行中的轮次时如实说明（不假装挂起）', async () => {
  runtime.db.prepare("UPDATE qq_turns SET status = 'done' WHERE status IN ('running','deferred')").run()
  const result = (await tool('defer_turn').execute({ reason: 'x' }, exec)) as Record<string, unknown>
  assert.equal(result['deferred'], false)
  assert.match(String(result['note']), /没有进行中的轮次/)
})

test('list_wake_rules：默认值就是用户拍板的那套', async () => {
  const result = (await tool('list_wake_rules').execute({ scope: '*' }, exec)) as { rules: { condition: string; enabled: boolean; probability: number }[] }
  const find = (condition: string): { enabled: boolean; probability: number } => {
    const rule = result.rules.find((r) => r.condition === condition)
    assert.ok(rule !== undefined, `缺少 ${condition}`)
    return rule
  }
  assert.equal(find('group_message_any').enabled, false, '群聊默认零唤醒')
  assert.equal(find('private_message').probability, 80)
  assert.equal(find('temp_message').probability, 20)
  assert.equal(find('group_mention').probability, 100)
  assert.equal(find('group_mention_all').probability, 50, '@全体独立 50%')
})

test('set_wake_rule：模型能自己调节，且改动留痕（是"影响自己"的配置）', async () => {
  const result = (await tool('set_wake_rule').execute({ scope: 'group:88888', condition: 'group_message_any', enabled: true, probability: 10 }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], true)
  assert.equal(result['enabled'], true)
  assert.equal(result['probability'], 10)

  const effect = runtime.db.prepare("SELECT * FROM effects WHERE kind = 'wake_rule' ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>
  assert.ok(effect !== undefined, '改唤醒规则必须留痕')
  assert.equal(effect['actor'], 'model')
  assert.equal(effect['subject'], 'group:88888:group_message_any')

  // 只改了这一个条件，别的条件必须原样（互不派生）
  const after = (await tool('list_wake_rules').execute({ scope: 'group:88888' }, exec)) as { rules: { condition: string; probability: number }[] }
  assert.equal(after.rules.find((r) => r.condition === 'group_mention')?.probability, 100, '@我 不受影响')
})

test('read_pending：读到的会被标记已读，重复调用不重复返回', async () => {
  runtime.db
    .prepare(
      `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
       VALUES ('p_test_1', 'group:88888', 'onebot11:88888', '老王', '他们聊了明天的会议', ?, 0, NULL)`,
    )
    .run(new Date().toISOString())

  const first = (await tool('read_pending').execute({ scope: 'group:88888' }, exec)) as { count: number; items: { summary: string }[] }
  assert.ok(first.count >= 1)
  assert.ok(first.items.some((i) => i.summary.includes('明天的会议')))

  const second = (await tool('read_pending').execute({ scope: 'group:88888' }, exec)) as { count: number }
  assert.equal(second.count, 0, '读过的不该再出现')
})

