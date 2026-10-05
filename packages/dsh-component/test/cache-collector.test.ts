/**
 * 缓存采集器的测试 —— 事件形状的鲁棒性 + 归因的准确性。
 *
 * 采集这一层最容易出的问题是**静默失效**：宿主换了事件形状，我们取不到用量，
 * 于是面板上永远是"还没有数据"，而没人知道是"没跑过"还是"取不到"。
 * 所以这里既测"能取到"，也测"取不到时不写垃圾行、且形状变化可被发现"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { summarizeCache } from '@forlife/memory-core'
import { listCacheUsage, openDatabase, recordCacheUsage } from '@forlife/store'

import { collectPrefixChanges, collectUsageFromEvent, extractUsage, isUsageEvent } from '../src/cache-collector.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-collect-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
})

after(async () => {
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

/** 造一个宿主的助手消息事件。 */
function assistantEvent(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant/message', turn: 1, step: 0, message: { role: 'assistant' }, usage, ...extra }
}

test('事件判定：只认带用量的助手消息事件', () => {
  assert.equal(isUsageEvent(assistantEvent({ inputTokens: 1 })), true)
  assert.equal(isUsageEvent({ type: 'assistant/attempt', usage: { inputTokens: 1 } }), true)
  assert.equal(isUsageEvent({ type: 'tool/result' }), false)
  assert.equal(isUsageEvent({ type: 'message' }), false)
  assert.equal(isUsageEvent(null), false)
  assert.equal(isUsageEvent('字符串'), false)
})

test('抽取：四类 token 都拿到，turn/step 也带出来', () => {
  const extracted = extractUsage(
    assistantEvent({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 50, reasoningTokens: 5 }, { turn: 3, step: 2 }),
    'sess_1',
  )
  assert.ok(extracted !== undefined)
  assert.equal(extracted.usage.inputTokens, 100)
  assert.equal(extracted.usage.cacheReadTokens, 800)
  assert.equal(extracted.usage.cacheWriteTokens, 50)
  assert.equal(extracted.usage.reasoningTokens, 5)
  assert.equal(extracted.usage.turn, 3)
  assert.equal(extracted.usage.step, 2)
  assert.equal(extracted.sessionId, 'sess_1')
})

test('抽取：缺字段按 0 处理；四个全 0 视为"适配器没报账"，不写垃圾行', () => {
  const partial = extractUsage(assistantEvent({ inputTokens: 100 }))
  assert.equal(partial?.usage.cacheReadTokens, 0, '缺的字段当 0，不要 NaN')

  assert.equal(extractUsage(assistantEvent({ inputTokens: 0, outputTokens: 0 })), undefined, '全 0 不记')
  assert.equal(extractUsage(assistantEvent({ inputTokens: 'NaN' })), undefined, '非数字也不记')
  assert.equal(extractUsage({ type: 'assistant/message' }), undefined, '没有 usage 字段就不记')
  assert.equal(extractUsage({ type: 'tool/result', usage: { inputTokens: 10 } }), undefined, '不是助手消息事件就不记')
})

test('兼容：usage 嵌在 message 里也能取到（宿主形状变化的退路）', () => {
  const extracted = extractUsage({ type: 'assistant/message', message: { role: 'assistant', usage: { inputTokens: 42, outputTokens: 1 } } })
  assert.equal(extracted?.usage.inputTokens, 42)
})

test('采集：第一次采样归因为 first-call（缓存还没建立）', () => {
  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 500, outputTokens: 10, cacheWriteTokens: 500 }))
  assert.equal(result.recorded, true)
  assert.equal(result.missReason, 'first-call')

  const rows = listCacheUsage(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.input_tokens, 500)
  assert.equal(rows[0]?.cache_write_tokens, 500)
  assert.equal(rows[0]?.miss_reason, 'first-call')
})

test('采集：命中的采样不归因', () => {
  const result = collectUsageFromEvent(db, assistantEvent({ cacheReadTokens: 1000, outputTokens: 20 }))
  assert.equal(result.recorded, true)
  assert.equal(result.missReason, null)
})

test('归因：窗口内的压缩会让未命中变成可解释', () => {
  // 造一条"刚提交的压缩事务"
  db.prepare(
    `INSERT INTO compaction_runs (id, compaction_id, session_id, phase, epoch_from, epoch_to, plan, detail, error, started_at, ended_at)
     VALUES ('run_1', 'c1', 'sess_x', 'committed', 0, 1, '{}', NULL, NULL, ?, ?)`,
  ).run(new Date(Date.now() - 30_000).toISOString(), new Date(Date.now() - 29_000).toISOString())

  const changes = collectPrefixChanges(db)
  assert.ok(changes.some((c) => c.kind === 'compaction'), '压缩事务必须被收集到')

  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 2000, outputTokens: 30 }), { windowMs: 300_000 })
  assert.equal(result.missReason, 'compaction', '压缩之后的未命中是可解释的')
})

test('归因：提示词编辑同样可解释，且取最近的一次', () => {
  db.prepare(
    `INSERT INTO prompt_revisions (id, slug, text, sha256, token_count, variables, note, created_by, created_at, active)
     VALUES ('pr_t1', 'p2-style', 'x', 'h', 1, '[]', NULL, 'admin', ?, 0)`,
  ).run(new Date(Date.now() - 5_000).toISOString())

  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 1500, outputTokens: 10 }), { windowMs: 300_000 })
  assert.equal(result.missReason, 'prompt-edit', '编辑比压缩更近 ⇒ 归到编辑')
})

test('归因：没有任何变更事件 ⇒ unexplained（前缀在无故漂移，必须可见）', () => {
  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 3000, outputTokens: 5 }), { windowMs: 1 })
  assert.equal(result.missReason, 'unexplained', '窗口设成 1ms ⇒ 先前的事件都不算，只能是无法解释')

  const summary = summarizeCache(
    listCacheUsage(db).map((row) => ({
      at: row.at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      missReason: row.miss_reason,
    })),
  )
  assert.ok(summary.unexplainedMisses >= 1, '"无法解释的未命中"必须能被汇总看见')
})

test('归因用的变更事件只算"非内置播种"的提示词版本（否则首次调用前的那一版会替未命中背锅）', () => {
  const changes = collectPrefixChanges(db)
  const edits = changes.filter((c) => c.kind === 'prompt-edit')
  assert.equal(edits.length, 1, '只有 admin 改的那一版算，system 播种的不算')
})

test('非用量事件：原样跳过，不写库（采集器不该污染数据）', () => {
  const before = listCacheUsage(db).length
  assert.equal(collectUsageFromEvent(db, { type: 'tool/result' }).recorded, false)
  assert.equal(collectUsageFromEvent(db, undefined).recorded, false)
  assert.equal(listCacheUsage(db).length, before)
})

test('面板取数：最新的在后（便于按时间画曲线）', () => {
  recordCacheUsage(db, { inputTokens: 1, outputTokens: 1, at: new Date(Date.now() + 60_000).toISOString() })
  const rows = listCacheUsage(db, { limit: 5 })
  assert.ok((rows[rows.length - 1]?.at ?? '') >= (rows[0]?.at ?? ''), '时间必须升序')
})
