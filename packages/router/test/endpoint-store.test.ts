/**
 * 端点目录与模式审计的落库测试。
 *
 * 两条重点：
 *  - **凭据只存引用**（明文永不入表）—— 这是安全红线，值得一条断言盯着；
 *  - **实际生效的后端**要单独记：有些镜像会静默回落到 CPU，
 *    如果只看声明值，面板会一直显示"cuda 加速中"而实际在慢跑。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import {
  deleteEndpoint,
  endpointOverview,
  getEndpoint,
  listEndpoints,
  listModeSwitches,
  openDatabase,
  recordEndpointHealth,
  recordModeSwitch,
  setEndpointMode,
  upsertEndpoint,
} from '@forlife/store'

const dir = mkdtempSync(join(tmpdir(), 'forlife-endpoints-'))
let db: import('node:sqlite').DatabaseSync

before(() => {
  db = openDatabase({ file: join(dir, 'ep.sqlite') }).db
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

test('端点：按 id upsert，能力位以 JSON 存', () => {
  upsertEndpoint(db, {
    id: 'ep-local-score',
    type: 'local',
    mode: 'resident',
    backend: 'cpu',
    baseUrl: 'http://127.0.0.1:8080/v1',
    deployTarget: 'local-docker',
    containerName: 'forlife-scorer',
    modelRoot: '/models',
    models: [{ id: 'Qwen2.5-0.5B-Instruct', image: false, contextLength: 32_000, reasoningEfforts: ['low'] }],
  })
  const row = getEndpoint(db, 'ep-local-score')
  assert.equal(row?.mode, 'resident')
  assert.equal(row?.backend, 'cpu')
  const models = JSON.parse(row?.models ?? '[]') as { id: string; image: boolean }[]
  assert.equal(models[0]?.id, 'Qwen2.5-0.5B-Instruct')
  assert.equal(models[0]?.image, false)

  // 再写一次是更新而不是新增
  upsertEndpoint(db, { id: 'ep-local-score', type: 'local', mode: 'on-demand', backend: 'cpu', baseUrl: 'http://127.0.0.1:8080/v1', models: [] })
  assert.equal(listEndpoints(db).length, 1)
  assert.equal(getEndpoint(db, 'ep-local-score')?.mode, 'on-demand')
})

test('凭据：只存引用，绝不存明文（安全红线）', () => {
  upsertEndpoint(db, {
    id: 'ep-cloud',
    type: 'cloud-api',
    mode: 'remote-api',
    backend: 'cpu',
    baseUrl: 'https://api.example.test/v1',
    apiKeyRef: 'env:FORLIFE_CLOUD_KEY',
    models: [],
  })
  const row = getEndpoint(db, 'ep-cloud')
  assert.equal(row?.api_key_ref, 'env:FORLIFE_CLOUD_KEY')
  // 整行序列化后不该出现任何像密钥的东西
  const dump = JSON.stringify(row)
  assert.ok(!/sk-[A-Za-z0-9]/.test(dump), '表里不该出现形如密钥的字符串')
})

test('健康：要单独记**实际生效的后端**（镜像可能静默回落到 CPU）', () => {
  upsertEndpoint(db, { id: 'ep-gpu', type: 'local', mode: 'resident', backend: 'cuda', baseUrl: 'http://127.0.0.1:8081/v1', models: [] })
  recordEndpointHealth(db, 'ep-gpu', { ok: true, latencyMs: 12, effectiveBackend: 'cpu', note: '镜像回落到 CPU' })

  const row = getEndpoint(db, 'ep-gpu')
  assert.equal(row?.health_ok, 1)
  assert.equal(row?.effective_backend, 'cpu')
  assert.equal(row?.backend, 'cuda', '声明的后端不该被覆盖（要能看出两者不一致）')

  const overview = endpointOverview(db)
  assert.ok(overview.backendMismatch.some((item) => item.id === 'ep-gpu' && item.declared === 'cuda' && item.effective === 'cpu'), '不一致必须能被面板发现')
})

test('健康：不健康的端点要能被列出来（带原因）', () => {
  recordEndpointHealth(db, 'ep-cloud', { ok: false, note: 'HTTP 503' })
  const overview = endpointOverview(db)
  assert.ok(overview.unhealthy.some((item) => item.id === 'ep-cloud' && item.note === 'HTTP 503'))
})

test('模式：只改 mode 字段（不覆盖别的字段）', () => {
  const before = getEndpoint(db, 'ep-local-score')
  setEndpointMode(db, 'ep-local-score', 'resident')
  const after = getEndpoint(db, 'ep-local-score')
  assert.equal(after?.mode, 'resident')
  assert.equal(after?.base_url, before?.base_url)
  assert.equal(after?.models, before?.models)
  assert.equal(after?.model_root, before?.model_root, '别的字段不该被模式切换清掉')
})

test('模式审计：成功的、失败的、幂等跳过的都要留痕（排障时最关心"为什么没切过去"）', () => {
  recordModeSwitch(db, { endpointId: 'ep-local-score', from: 'resident', to: 'on-demand', actor: 'admin', reason: '省内存', ok: true, note: '切换成功' })
  recordModeSwitch(db, { endpointId: 'ep-local-score', from: 'resident', to: 'on-demand', actor: 'admin', reason: '省内存', ok: true, note: '已经是目标模式，幂等跳过' })
  recordModeSwitch(db, { endpointId: 'ep-local-score', from: 'resident', to: 'on-demand', actor: 'auto', reason: '深夜', ok: false, note: '排水超时 ⇒ 放弃切换' })

  const rows = listModeSwitches(db, 'ep-local-score')
  assert.equal(rows.length, 3)
  assert.match(String(rows[0]?.['note']), /排水超时/)
  assert.ok(rows.some((row) => row['ok'] === 0), '失败的也要留痕')
  assert.ok(rows.some((row) => String(row['note']).includes('幂等跳过')))
  // 别的端点不受影响
  assert.equal(listModeSwitches(db, 'ep-cloud').length, 0)
})

test('目录概览：按来源与模式统计', () => {
  const overview = endpointOverview(db)
  assert.ok(overview.total >= 3)
  assert.ok(overview.byType.some((item) => item.type === 'local'))
  assert.ok(overview.byType.some((item) => item.type === 'cloud-api'))
  assert.ok(overview.byMode.some((item) => item.mode === 'remote-api'))
})

test('删除端点', () => {
  assert.equal(deleteEndpoint(db, 'ep-gpu'), true)
  assert.equal(getEndpoint(db, 'ep-gpu'), undefined)
  assert.equal(deleteEndpoint(db, 'ep-gpu'), false)
})
