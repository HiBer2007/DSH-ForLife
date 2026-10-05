/**
 * 粘合层测试：消息来源（铁律 2 的类型层）、溯源标记、噪音过滤接入。
 *
 * 这三件都属于"不说话但决定成败"的胶水：它们不出现在任何功能演示里，
 * 一旦做错，表现是"记忆里不知道这话是谁说的""闲聊把上下文撑爆了"这类慢性问题。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { adminMessage, createForlifeMessage, qqMessage, systemMessage } from '../src/sources.ts'
import { buildMemoryTools } from '../src/tools.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-glue-'))
let runtime: MemoryRuntime

before(() => {
  runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }),
    dbPath: join(dir, 'forlife.sqlite'),
  })
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

test('铁律 2 的类型层：三种来源都能构造，`user` 在构造时就炸', () => {
  const system = systemMessage('后台改过你的提示词', 'report')
  const qq = qqMessage('在吗', 'onebot11:10001', 'm1')
  const admin = adminMessage('帮我看下日志', 'HiBer2007')

  assert.equal((system as unknown as { source: { kind: string } }).source.kind, 'forlife:system')
  assert.equal((qq as unknown as { source: { kind: string } }).source.kind, 'forlife:qq')
  assert.equal((admin as unknown as { source: { kind: string } }).source.kind, 'forlife:admin')

  // 关键：任何试图用 user 的代码在**构造时**就失败，而不是发出去之后才发现
  assert.throws(() => createForlifeMessage('user' as never, 'x'), /铁律 2 被违反/)
})

test('来源元信息：QQ 消息带会话键与平台消息 id（可对账）', () => {
  const message = qqMessage('你好', 'onebot11:88888', '501')
  const source = (message as unknown as { source: { kind: string; conversation: string; platformMessageId?: string } }).source
  assert.equal(source.conversation, 'onebot11:88888', '多会话单窗口下必须能指回来源会话')
  assert.equal(source.platformMessageId, '501', '要能与 QQ 侧对账')
  assert.equal((systemMessage('x', 'wake').source as unknown as { reason: string }).reason ?? 'wake', 'wake')
})

test('溯源：有 running 轮次时 remember 自动带上会话标记', async () => {
  const conversationKey = 'onebot11:88888'
  runtime.db
    .prepare(
      `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
       VALUES ('turn_scope_1', ?, 'running', ?, NULL, NULL, NULL, '[]', 0, 0, 0, NULL, NULL, NULL)`,
    )
    .run(conversationKey, new Date().toISOString())

  assert.equal(runtime.currentConversationScope(), conversationKey, '运行时要知道当前在处理哪个会话')

  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[]
  const remember = tools.find((t) => t.name === 'remember')
  assert.ok(remember !== undefined)
  const result = (await remember.execute({ summary: '用户养了一只叫团子的猫' }, { callId: 'c', signal: new AbortController().signal })) as { id: string }

  const row = runtime.db.prepare('SELECT source_scope FROM mid_memory_entries WHERE id = ?').get(result.id) as { source_scope: string }
  assert.equal(row.source_scope, conversationKey, '记忆条目必须带上来源会话（将来能回溯"这话是谁说的"）')
})

test('溯源：显式给的 scope 优先于自动推断', async () => {
  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[]
  const remember = tools.find((t) => t.name === 'remember')
  assert.ok(remember !== undefined)
  const result = (await remember.execute({ summary: '这条明确指定来源', scope: 'private:10001' }, { callId: 'c', signal: new AbortController().signal })) as { id: string }
  const row = runtime.db.prepare('SELECT source_scope FROM mid_memory_entries WHERE id = ?').get(result.id) as { source_scope: string }
  assert.equal(row.source_scope, 'private:10001')
})

test('溯源：没有 running 轮次时不硬编造来源（留空）', async () => {
  runtime.db.prepare("UPDATE qq_turns SET status = 'done' WHERE status = 'running'").run()
  assert.equal(runtime.currentConversationScope(), undefined)

  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[]
  const remember = tools.find((t) => t.name === 'remember')
  assert.ok(remember !== undefined)
  const result = (await remember.execute({ summary: '不在 QQ 轮次里记的一条' }, { callId: 'c', signal: new AbortController().signal })) as { id: string }
  const row = runtime.db.prepare('SELECT source_scope FROM mid_memory_entries WHERE id = ?').get(result.id) as { source_scope: string | null }
  assert.equal(row.source_scope, null, '不知道来源就留空，不要编')
})

test('溯源不隔离：带不同来源标记的条目在同一个渲染视图里（统一记忆）', () => {
  const view = runtime.renderView().text
  assert.ok(view.includes('用户养了一只叫团子的猫'), 'A 会话记的事在同一份记忆里')
  assert.ok(view.includes('这条明确指定来源'), 'B 会话记的事也在同一份记忆里')
  // 表里有两个不同的 source_scope，但渲染视图不做任何隔离
  const scopes = runtime.db.prepare('SELECT DISTINCT source_scope FROM mid_memory_entries').all() as unknown as { source_scope: string | null }[]
  assert.ok(scopes.length >= 2, '来源标记确实不同')
})
