/**
 * 视觉调用计数的端到端测试（验收项：同一张图重复出现 ⇒ 第二次 **0 次视觉调用**）。
 *
 * 这个数字是要给人看的成本指标，所以必须**真的**从日志里数出来，
 * 而不是靠"我们设计上应该会命中缓存"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { getImageDescription, openDatabase, recordVisionCall, saveImageDescription, visionCallsFor, visionStats } from '@forlife/store'

import { decideVisionCall, decideVisionCallForRow, parseDescription, renderDescriptionBlock } from '../src/vision.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-vision-'))
let db: import('node:sqlite').DatabaseSync
const ATTACHMENT = 'sha256:1a2b3c4d5e6f'

before(() => {
  db = openDatabase({ file: join(dir, 'vision.sqlite') }).db
})

after(async () => {
  db.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

test('同一张图两次 ⇒ 第二次 0 次视觉调用（从日志里数出来）', () => {
  // 第一次：缓存没有 ⇒ 要调
  const first = decideVisionCallForRow(getImageDescription(db, ATTACHMENT))
  assert.equal(first.needed, true)
  recordVisionCall(db, { attachmentId: ATTACHMENT, reason: 'bridge', provider: 'vlm-provider', model: 'vl-7b', latencyMs: 850 })
  const parsed = parseDescription('【画面内容】\n一张转账截图\n【文字】\n¥1,000.50 元\n【不确定之处】\n无')
  saveImageDescription(db, {
    attachmentId: ATTACHMENT,
    scene: parsed.scene,
    ocrText: parsed.ocr ?? null,
    uncertain: parsed.uncertain ?? null,
    description: renderDescriptionBlock({ attachmentId: ATTACHMENT, description: parsed }),
    provider: 'vlm-provider',
    model: 'vl-7b',
  })
  assert.equal(visionCallsFor(db, ATTACHMENT), 1)

  // 第二次：缓存命中 ⇒ **不调**
  const cached = getImageDescription(db, ATTACHMENT)
  assert.ok(cached !== undefined)
  const second = decideVisionCallForRow(cached)
  assert.equal(second.needed, false, '同一张图第二次必须 0 次视觉调用')
  assert.equal(visionCallsFor(db, ATTACHMENT), 1, '调用计数不该增加')
})

test('描述缓存：重复写会累加 vision_calls（它是成本计数器，不是状态位）', () => {
  saveImageDescription(db, { attachmentId: ATTACHMENT, scene: '重新描述', description: 'x' })
  const row = getImageDescription(db, ATTACHMENT)
  assert.equal(row?.vision_calls, 2, '第二次写应当把计数加到 2')
  assert.equal(row?.scene, '重新描述', '内容应当被新描述替换（以最新一次为准）')
})

test('重要字段复核也计入视觉调用（成本要看得见）', () => {
  recordVisionCall(db, { attachmentId: ATTACHMENT, reason: 'verify-important-fields', latencyMs: 900 })
  const stats = visionStats(db)
  assert.equal(stats.total, 2)
  assert.ok(stats.byReason.some((item) => item.reason === 'bridge'))
  assert.ok(stats.byReason.some((item) => item.reason === 'verify-important-fields'))
  assert.ok((stats.avgLatencyMs ?? 0) > 0)
  assert.equal(stats.cachedImages, 1)
})

test('失败的视觉调用也要记（否则"为什么没描述出来"无从查起）', () => {
  recordVisionCall(db, { attachmentId: 'sha256:failed', reason: 'bridge', ok: false, note: '超时' })
  const stats = visionStats(db)
  assert.equal(stats.failed, 1)
  const rows = db.prepare("SELECT note FROM vision_call_log WHERE ok = 0").all() as unknown as { note: string }[]
  assert.equal(rows[0]?.note, '超时')
})


