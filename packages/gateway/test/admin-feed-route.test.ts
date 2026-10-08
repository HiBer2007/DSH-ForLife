/**
 * 后台「喂食记忆」接口（`POST /api/admin/feed`）的行为测试 —— **起真服务、走真 HTTP**。
 *
 * 为什么不用 mock 直接调 handler：这条路由的风险几乎全在 HTTP 层
 * （登录门槛、CSRF 纵深防御、状态码、请求体大小），mock 掉这层等于什么都没测。
 *
 * 覆盖：
 *  - 未登录必须 401（喂食能改模型记得什么，绝不能匿名调用）；
 *  - 缺 `application/json` 必须 400（既有 CSRF 纵深防御，照抄不改）；
 *  - 正常喂知识/经历 → 真的落库、带来源标记；
 *  - 坏参数 → 400 带原因（不是 500）；
 *  - `dryRun` → 一个字都不写。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createAdminServer, type RunningAdminServer } from '../src/server.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-admin-feed-'))
const dbPath = join(dir, 'forlife.sqlite')
let running: RunningAdminServer
let base: string
let cookie: string

/** 带 cookie 的 JSON POST。 */
function postJson(path: string, body: unknown, withCookie = true): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withCookie && cookie !== '') headers['cookie'] = cookie
  return fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
}

before(async () => {
  running = await createAdminServer({ dbPath, distRoot: dir, host: '127.0.0.1', port: 0, sessionTtlMs: 60_000 }).start()
  base = `http://127.0.0.1:${running.port}`

  const setup = await fetch(`${base}/api/admin/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a-good-password' }),
  })
  assert.equal(setup.status, 200, '首次设置口令应当成功')
  cookie = (setup.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  assert.notEqual(cookie, '')
})

after(async () => {
  await running.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 直接读库（第二个连接）—— 断言"真的落库了"，而不是只信接口的返回值。 */
function query<T>(sql: string): readonly T[] {
  const opened = openDatabase({ file: dbPath, backupBeforeMigrate: false })
  try {
    return opened.db.prepare(sql).all() as unknown as T[]
  } finally {
    opened.close()
  }
}

test('未登录必须 401（喂食能改模型记得什么，不能匿名调用）', async () => {
  const response = await postJson('/api/admin/feed', { items: [{ content: 'x' }], as: 'knowledge' }, false)
  assert.equal(response.status, 401)
})

test('缺 application/json 必须 400（CSRF 纵深防御，与其它写接口同一条）', async () => {
  const response = await fetch(`${base}/api/admin/feed`, {
    method: 'POST',
    headers: { 'cookie': cookie, 'content-type': 'text/plain' },
    body: JSON.stringify({ items: [{ content: 'x' }], as: 'knowledge' }),
  })
  assert.equal(response.status, 400)
  assert.match(String(((await response.json()) as { error?: string }).error), /application\/json/)
})

test('★ 喂知识：落长期记忆、带来源标记；同源重导不新增', async () => {
  const first = await postJson('/api/admin/feed', {
    items: [{ content: '后台喂进来的第一条：中文检索必须自己切分。' }],
    as: 'knowledge',
    source: 'admin/panel-1',
  })
  assert.equal(first.status, 200)
  const body = (await first.json()) as { ok: boolean; result: { inserted: number; scope: string; hint: string } }
  assert.equal(body.ok, true)
  assert.equal(body.result.inserted, 1)
  assert.equal(body.result.scope, 'feed:admin/panel-1')
  assert.match(body.result.hint, /memory-archive/, '结果里要带上"怎么删"的指引（指向既有管理）')

  const rows = query<{ source_scope: string; content: string }>(
    "SELECT source_scope, content FROM long_memory_entries WHERE source_scope = 'feed:admin/panel-1'",
  )
  assert.equal(rows.length, 1, '必须真的落库（不是只返回一个好看的 JSON）')
  assert.match(rows[0]?.content ?? '', /中文检索必须自己切分/)

  // 同源重导：内容一致 ⇒ 未改动；条目数不变
  const again = await postJson('/api/admin/feed', {
    items: [{ content: '后台喂进来的第一条：中文检索必须自己切分。' }],
    as: 'knowledge',
    source: 'admin/panel-1',
  })
  const againBody = (await again.json()) as { result: { unchanged: number; inserted: number } }
  assert.equal(againBody.result.unchanged, 1)
  assert.equal(againBody.result.inserted, 0)
  assert.equal(query("SELECT id FROM long_memory_entries WHERE source_scope = 'feed:admin/panel-1'").length, 1)
})

test('★ 喂经历：落中期记忆、推进渲染修订号', async () => {
  const response = await postJson('/api/admin/feed', {
    items: [{ content: '后台喂进来的一段经历：面板上第一次点"喂食"。' }],
    as: 'experience',
    source: 'admin/panel-exp',
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { result: { inserted: number; revision?: number } }
  assert.equal(body.result.inserted, 1)
  assert.ok((body.result.revision ?? 0) > 0, '写入必须推进渲染修订号')

  const rows = query<{ source_scope: string; id: string }>(
    "SELECT source_scope, id FROM mid_memory_entries WHERE source_scope = 'feed:admin/panel-exp'",
  )
  assert.equal(rows.length, 1)
})

test('★ dryRun：一个字都不写', async () => {
  const before = query('SELECT id FROM long_memory_entries').length
  const response = await postJson('/api/admin/feed', {
    items: [{ content: '预演用的一段资料，不该落库。' }],
    as: 'knowledge',
    source: 'admin/dry',
    dryRun: true,
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { result: { dryRun: boolean; inserted: number; details: { action: string }[] } }
  assert.equal(body.result.dryRun, true)
  assert.equal(body.result.inserted, 0)
  assert.equal(body.result.details[0]?.action, 'planned')
  assert.equal(query('SELECT id FROM long_memory_entries').length, before, 'dryRun 不许写库')
})

test('坏参数是 400 带原因（不是 500）', async () => {
  const badKind = await postJson('/api/admin/feed', { items: [{ content: 'x' }], as: 'memory' })
  assert.equal(badKind.status, 400)
  assert.match(String(((await badKind.json()) as { error?: string }).error), /knowledge 或 experience/)

  const noItems = await postJson('/api/admin/feed', { as: 'knowledge' })
  assert.equal(noItems.status, 400)

  const blank = await postJson('/api/admin/feed', { items: [{ content: '  ' }], as: 'knowledge' })
  assert.equal(blank.status, 400)
  assert.match(String(((await blank.json()) as { error?: string }).error), /没有可喂的内容/)
})

test('★ 喂食留痕进审计（谁在什么时候喂了什么来源）', async () => {
  const rows = query<{ detail: string; actor: string; affects_model: number }>(
    "SELECT detail, actor, affects_model FROM effects WHERE kind = 'admin_action' AND detail LIKE '%memory.feed%'",
  )
  assert.ok(rows.length >= 1, '每一次喂食都要留一笔（含 dryRun 之外的成功调用）')
  assert.equal(rows[0]?.actor, 'admin')
  assert.equal(rows[0]?.affects_model, 1, '它影响模型记得什么 ⇒ 必须报告')
})
