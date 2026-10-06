/**
 * 表情服务的守卫测试。
 *
 * 最重要的一条是**产品约束**：学来的表情（ours=0）默认不主动转发。
 * 这条约束如果写漏，后果是"往别人群里发了我们不认识来源的图" —— 而且不会报错，
 * 只会悄悄发出去。所以它必须在唯一出口上被守住，并由测试钉死。
 *
 * 第二条是**省钱主线在服务层的表现**：同一张图第二次入库，`calledModel` 必须是 false。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase, saveStickerDescription, upsertStickerAsset } from '@forlife/store'

import { createStickerService } from '../src/sticker-service.ts'

function fakeImage(size = 512, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0)
  bytes[10] = seed
  return bytes
}

function setup(): {
  db: ReturnType<typeof openDatabase>['db']
  dir: string
  calls: () => number
  service: ReturnType<typeof createStickerService>
} {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-svc-'))
  let calls = 0
  const service = createStickerService({
    db: opened.db,
    storageRoot: dir,
    // 水印闸门是 fail-closed 的：不配检查器会拒绝一切导入。
    // 这里给一个"判定无水印"的替身 —— 水印拒绝路径由本文件末尾的专门用例覆盖。
    watermark: async () => ({ hasWatermark: false, evidence: 'none', calledModel: true }),
    describer: async () => {
      calls += 1
      return { description: `第 ${String(calls)} 次生成的描述`, emotionTags: ['测试'], model: 'fake', tokenCount: 1 }
    },
  })
  return { db: opened.db, dir, calls: () => calls, service }
}

test('add：入库并生成描述；同一张图第二次 ⇒ 0 次视觉调用', async () => {
  const { db, dir, calls, service } = setup()
  try {
    const bytes = fakeImage(512, 1)
    const first = await service.add({ bytes, mime: 'image/png', source: 'manual' })
    assert.equal(first.status, 'created')
    assert.equal(first.calledModel, true)
    assert.equal(calls(), 1)
    assert.match(first.description ?? '', /第 1 次生成/)

    const second = await service.add({ bytes, mime: 'image/png', source: 'learned', ours: false })
    assert.equal(second.status, 'duplicate')
    assert.equal(second.calledModel, false, '第二次绝不能调模型')
    assert.equal(calls(), 1, '视觉调用次数必须停在 1')
    assert.equal(second.description, first.description, '描述要复用')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 学来的表情默认不主动转发（唯一出口守住产品约束）', async () => {
  const { db, dir, service } = setup()
  try {
    const learned = await service.add({ bytes: fakeImage(512, 2), mime: 'image/png', source: 'learned', ours: false })
    assert.equal(learned.status, 'created')

    const refused = service.send({ to: 'onebot11:10001', assetId: learned.assetId })
    assert.equal(refused.ok, false, '默认必须拒绝发送学来的表情')
    assert.match(refused.reason, /学来的/)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS v FROM qq_outbox').get() as { v: number }).v,
      0,
      '被拒绝时**不能**留下出站行（否则会被消费者发出去）',
    )

    // 显式允许时才放行
    const allowed = service.send({ to: 'onebot11:10001', assetId: learned.assetId, allowLearned: true })
    assert.equal(allowed.ok, true)
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM qq_outbox').get() as { v: number }).v, 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send：按 query 检索并发送，出站行的 kind 与 segments 正确', () => {
  const { db, dir, service } = setup()
  try {
    const asset = upsertStickerAsset(db, {
      sha256: 'own-1',
      mime: 'image/png',
      sizeBytes: 10,
      storagePath: '/s/own1.png',
      source: 'manual',
      ours: true,
    })
    saveStickerDescription(db, { assetId: asset.id, description: '一只橘猫在睡觉', emotionTags: ['猫', '睡觉'] })

    const sent = service.send({ to: 'onebot11:88888', query: '猫睡觉', replyTo: 'msg-9', conversationKind: 'group' })
    assert.equal(sent.ok, true, sent.reason)
    assert.equal(sent.assetId, asset.id)

    const row = db.prepare('SELECT kind, payload, conversation_kind, source FROM qq_outbox LIMIT 1').get() as {
      kind: string
      payload: string
      conversation_kind: string
      source: string
    }
    assert.equal(row.kind, 'sticker')
    assert.equal(row.conversation_kind, 'group')
    assert.equal(row.source, 'model')
    const segments = (JSON.parse(row.payload) as { segments: { kind: string; file?: string; messageId?: string }[] }).segments
    assert.equal(segments[0]?.kind, 'reply', '回复引用要排在第一个（QQ 侧的回复关系由首段决定）')
    assert.equal(segments[0]?.messageId, 'msg-9')
    assert.equal(segments[1]?.kind, 'sticker')
    assert.equal(segments[1]?.file, '/s/own1.png')

    // 使用统计要更新（LRU 的依据）
    const after = db.prepare('SELECT use_count, last_used_at FROM sticker_assets WHERE id = ?').get(asset.id) as {
      use_count: number
      last_used_at: string | null
    }
    assert.equal(after.use_count, 1)
    assert.ok(after.last_used_at !== null)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send：没命中时如实回报（调用方据此决定要不要补货）', () => {
  const { db, dir, service } = setup()
  try {
    const miss = service.send({ to: 'onebot11:10001', query: '恐龙在跳舞' })
    assert.equal(miss.ok, false)
    assert.match(miss.reason, /没有匹配/)
    assert.equal((db.prepare('SELECT COUNT(*) AS v FROM qq_outbox').get() as { v: number }).v, 0)

    const noArgs = service.send({ to: 'onebot11:10001' })
    assert.equal(noArgs.ok, false)
    assert.match(noArgs.reason, /必须给 query 或 assetId/)

    const badId = service.send({ to: 'onebot11:10001', assetId: 'stk_not_exist' })
    assert.equal(badId.ok, false)
    assert.match(badId.reason, /找不到/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send：被淘汰/拒绝的表情不能发（状态要挡）', () => {
  const { db, dir, service } = setup()
  try {
    const asset = upsertStickerAsset(db, {
      sha256: 'evicted-1',
      mime: 'image/png',
      sizeBytes: 10,
      storagePath: '/s/e.png',
      source: 'manual',
      ours: true,
    })
    db.prepare("UPDATE sticker_assets SET status = 'evicted' WHERE id = ?").run(asset.id)

    const result = service.send({ to: 'onebot11:10001', assetId: asset.id })
    assert.equal(result.ok, false)
    assert.match(result.reason, /状态是 evicted/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('add：没有描述器时只入库不描述（检索仍可靠标签工作）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-svc2-'))
  try {
    const service = createStickerService({
      db: opened.db,
      storageRoot: dir,
      // 这个用例要测的是"没有描述器"，所以水印检查器仍然要给（否则会被 fail-closed 拒掉）
      watermark: async () => ({ hasWatermark: false, evidence: 'none', calledModel: true }),
    })
    const result = await service.add({ bytes: fakeImage(256, 3), mime: 'image/png', source: 'manual' })
    assert.equal(result.status, 'created')
    assert.equal(result.calledModel, undefined, '没描述器就不该有"调用了模型"这回事')
    assert.match(result.reason, /未生成描述/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


test('★ 水印闸门：带水印的图被拒、不入库、且留下证据', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wm-'))
  try {
    const service = createStickerService({
      db: opened.db,
      storageRoot: dir,
      watermark: async () => ({ hasWatermark: true, evidence: '右下角有 @某某 昵称水印', calledModel: true }),
      describer: async () => ({ description: '不该被调用', emotionTags: [], model: 'x', tokenCount: 0 }),
    })
    const result = await service.add({ bytes: fakeImage(512, 7), mime: 'image/png', source: 'manual' })
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /带水印/)
    assert.match(result.reason, /@某某/, '拒绝原因要带上模型的判断依据（便于人工复核误判）')

    // 关键：不能进 active 库（否则就能被发送）
    assert.equal(
      (opened.db.prepare("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'active'").get() as { v: number }).v,
      0,
      '带水印的绝不能进 active 库',
    )
    // 但要有证据行
    const row = opened.db.prepare("SELECT reject_reason FROM sticker_assets WHERE status = 'rejected'").get() as
      | { reject_reason: string }
      | undefined
    assert.match(row?.reject_reason ?? '', /带水印/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 水印闸门：没配检查器 ⇒ 拒绝一切（fail-closed，不许"查不了就放行"）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wm-'))
  try {
    const service = createStickerService({
      db: opened.db,
      storageRoot: dir,
      // 这个用例要测的是"没有描述器"，所以水印检查器仍然要给（否则会被 fail-closed 拒掉）
    })
    const result = await service.add({ bytes: fakeImage(256, 8), mime: 'image/png', source: 'manual' })
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /无法检查水印/)
    assert.equal(
      (opened.db.prepare('SELECT COUNT(*) AS v FROM sticker_assets').get() as { v: number }).v,
      0,
      '查不了就不该留下任何行',
    )
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 水印闸门：检查本身抛错也拒绝（查不了就不许用）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wm-'))
  try {
    const service = createStickerService({
      db: opened.db,
      storageRoot: dir,
      watermark: async () => {
        throw new Error('视觉服务 503')
      },
    })
    const result = await service.add({ bytes: fakeImage(256, 9), mime: 'image/png', source: 'manual' })
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /水印检查失败.*503/s)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
