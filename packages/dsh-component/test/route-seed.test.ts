/**
 * 路由表播种的测试（阶段 5 的收尾）。
 *
 * 为什么值得测：`model_routes` 是"档位 → 具体模型"的**唯一真源**，
 * 空表意味着降级链没有候选、子代理分不到模型、面板上七个角色全是"还没配置"。
 * 而"播种"最容易犯的错是**覆盖用户已有配置** —— 那条要单独盯着。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { listModelRoutes, openDatabase, upsertModelRoute } from '@forlife/store'

import { roleGapSeverity, seedDefaultRoutes } from '../src/route-seed.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-seed-'))
let db: import('node:sqlite').DatabaseSync

before(() => {
  db = openDatabase({ file: join(dir, 'seed.sqlite') }).db
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

test('播种：空表时补 L1/L2/L3/scorer —— 档位只决定推理强度', () => {
  const result = seedDefaultRoutes(db, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(result.seeded, true)
  assert.equal(result.count, 4)
  const rows = listModelRoutes(db)
  assert.deepEqual(rows.map((r) => r.role).sort(), ['L1', 'L2', 'L3', 'scorer'])
  assert.equal(rows.find((r) => r.role === 'L1')?.reasoning_effort, 'low')
  assert.equal(rows.find((r) => r.role === 'L3')?.reasoning_effort, 'high')
  assert.match(String(rows.find((r) => r.role === 'scorer')?.note), /默认复用主模型/)
})

test('播种：**绝不覆盖已有配置**（这条最重要）', () => {
  upsertModelRoute(db, { role: 'L3', rank: 0, provider: 'my-strong', model: 'big-model' })
  const result = seedDefaultRoutes(db, { provider: 'other', model: 'other-model' })
  assert.equal(result.seeded, false)
  assert.match(result.reason, /不覆盖/)
  assert.equal(listModelRoutes(db).find((r) => r.role === 'L3')?.provider, 'my-strong', '用户配的不能被播种改掉')
})

test('播种：没给 provider/model 时跳过（留空让用户填，而不是猜）', () => {
  const scratch = openDatabase({ file: join(dir, 'empty.sqlite') }).db
  const result = seedDefaultRoutes(scratch, { provider: '', model: '' })
  assert.equal(result.seeded, false)
  assert.match(result.reason, /跳过播种/)
  assert.equal(listModelRoutes(scratch).length, 0)
  scratch.close()
})

test('播种：刻意不给视觉/嵌入猜模型（**猜错比空着更糟**）', () => {
  const scratch = openDatabase({ file: join(dir, 'empty2.sqlite') }).db
  const result = seedDefaultRoutes(scratch, { provider: 'p', model: 'm' })
  assert.match(result.reason, /视觉与嵌入/)
  assert.match(result.reason, /刻意不猜/)
  const roles = listModelRoutes(scratch).map((r) => r.role)
  assert.ok(!roles.includes('vision'), '视觉必须由人指定（要 image 能力）')
  assert.ok(!roles.includes('embedding'), '嵌入必须由人指定（要给维度）')
  scratch.close()
})

test('角色缺失分轻重：主对话与评分器是 required，视觉/嵌入/子代理是 optional', () => {
  assert.equal(roleGapSeverity('L1').level, 'required')
  assert.equal(roleGapSeverity('L3').level, 'required')
  assert.equal(roleGapSeverity('scorer').level, 'required')
  assert.equal(roleGapSeverity('vision').level, 'optional')
  assert.equal(roleGapSeverity('embedding').level, 'optional')
  assert.equal(roleGapSeverity('subagent').level, 'optional')
  // 提示要**说清后果**，而不是只说"没配置"
  assert.match(roleGapSeverity('L3').hint, /降级链/)
  assert.match(roleGapSeverity('vision').hint, /image 能力/)
  assert.match(roleGapSeverity('embedding').hint, /维度/)
  assert.match(roleGapSeverity('subagent').hint, /异构/)
})
