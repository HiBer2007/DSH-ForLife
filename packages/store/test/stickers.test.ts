/**
 * 表情库存储层的守卫测试。
 *
 * 最重要的一条是**省钱主线**：同一个指纹第二次出现必须 **0 次视觉调用**。
 * 这条断言的意义在于它数的是"模型被调用了几次"，而不是"结果对不对" ——
 * 结果对不对在第二次调用时也往往是对的，但钱已经花了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/index.ts'
import {
  describeStickerOnce,
  evictLearnedStickers,
  findStickerBySha,
  getStickerAsset,
  listStickerAssets,
  rejectStickerAsset,
  touchStickerUse,
  upsertStickerAsset,
} from '../src/stickers.ts'

function freshDb(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

/** 造一个"视觉模型调用计数器"，用来断言到底调了几次。 */
function counter(): { calls: number; describe: () => Promise<{ description: string; emotionTags: string[] }> } {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    describe: async () => {
      state.calls += 1
      return { description: `第 ${String(state.calls)} 次生成的描述`, emotionTags: ['开心'] }
    },
  }
}

test('指纹去重：同一 sha256 第二次入库不新增行，且累积 scopes', () => {
  const opened = freshDb()
  try {
    const first = upsertStickerAsset(opened.db, {
      sha256: 'aaa',
      mime: 'image/png',
      sizeBytes: 100,
      storagePath: '/s/a.png',
      source: 'manual',
      scope: 'onebot11:10001',
    })
    assert.equal(first.created, true)

    const second = upsertStickerAsset(opened.db, {
      sha256: 'aaa',
      mime: 'image/png',
      sizeBytes: 100,
      storagePath: '/s/a.png',
      source: 'learned',
      scope: 'onebot11:88888',
    })
    assert.equal(second.created, false, '指纹命中 ⇒ 不该新增行')
    assert.equal(second.id, first.id)

    const rows = opened.db.prepare('SELECT COUNT(*) AS v FROM sticker_assets').get() as { v: number }
    assert.equal(rows.v, 1, '库里只能有一行')

    const asset = getStickerAsset(opened.db, first.id)
    assert.deepEqual(JSON.parse(asset?.scopes ?? '[]'), ['onebot11:10001', 'onebot11:88888'], 'scopes 要累积')
    // 重复入库不该把"我们自己的"标记重置掉（那是丢信息）
    assert.equal(asset?.ours, 1, 'ours 必须保持原值，不被后来的 learned 覆盖')
  } finally {
    opened.db.close()
  }
})

test('省钱主线：第二次描述 0 次视觉调用', async () => {
  const opened = freshDb()
  try {
    const vision = counter()
    upsertStickerAsset(opened.db, {
      sha256: 'bbb',
      mime: 'image/png',
      sizeBytes: 200,
      storagePath: '/s/b.png',
      source: 'manual',
    })

    const first = await describeStickerOnce(opened.db, { sha256: 'bbb', describe: vision.describe })
    assert.equal(first.calledModel, true, '第一次必须调用模型')
    assert.equal(vision.calls, 1)

    const second = await describeStickerOnce(opened.db, { sha256: 'bbb', describe: vision.describe })
    assert.equal(second.calledModel, false, '第二次绝不能调用模型')
    assert.equal(vision.calls, 1, '模型调用次数必须停在 1 —— 这就是"省钱"的断言')
    assert.equal(second.description, first.description, '复用的描述要与第一次一致')
    assert.deepEqual(second.emotionTags, ['开心'], '标签也要复用')
    assert.equal(second.assetId, first.assetId)
  } finally {
    opened.db.close()
  }
})

test('学习别人的表情：默认 ours=false（能学，但不主动转发）', async () => {
  const opened = freshDb()
  try {
    const vision = counter()
    // 先由 describeStickerOnce 自动建行（learned）
    const described = await describeStickerOnce(opened.db, { sha256: 'ccc', describe: vision.describe })
    const asset = getStickerAsset(opened.db, described.assetId)
    assert.equal(asset?.ours, 0, '没见过来源的表情应记为"学来的"')

    const ours = listStickerAssets(opened.db, { ours: true })
    assert.equal(ours.length, 0, '学来的表情不能出现在"我们自己的"列表里（默认不主动转发）')
    const learned = listStickerAssets(opened.db, { ours: false })
    assert.equal(learned.length, 1)
  } finally {
    opened.db.close()
  }
})

test('拒绝的资产：记下原因，但不进 active 列表', () => {
  const opened = freshDb()
  try {
    rejectStickerAsset(opened.db, { sha256: 'ddd', reason: '来源不在白名单', sourceUrl: 'http://evil.test/x.png' })
    const row = findStickerBySha(opened.db, 'ddd')
    assert.equal(row?.status, 'rejected')
    assert.equal(row?.reject_reason, '来源不在白名单')
    assert.equal(listStickerAssets(opened.db).length, 0, '被拒的不该出现在 active 列表')
    assert.equal(listStickerAssets(opened.db, { status: 'rejected' }).length, 1)
  } finally {
    opened.db.close()
  }
})

test('LRU 淘汰：只淘汰学来的，绝不删用户自己收藏的', () => {
  const opened = freshDb()
  try {
    // 1 个自己的 + 3 个学来的
    upsertStickerAsset(opened.db, { sha256: 'own1', mime: 'image/png', sizeBytes: 1, storagePath: '/o', source: 'manual', ours: true })
    for (const [index, sha] of ['l1', 'l2', 'l3'].entries()) {
      const row = upsertStickerAsset(opened.db, {
        sha256: sha,
        mime: 'image/png',
        sizeBytes: 1,
        storagePath: `/l${String(index)}`,
        source: 'learned',
        ours: false,
        now: new Date(Date.UTC(2026, 0, 1 + index)),
      })
      touchStickerUse(opened.db, row.id, new Date(Date.UTC(2026, 0, 1 + index)))
    }

    const evicted = evictLearnedStickers(opened.db, 1)
    assert.equal(evicted, 2, '3 个学来的保留 1 个 ⇒ 淘汰 2 个')

    const active = listStickerAssets(opened.db, { status: 'active' })
    assert.equal(active.filter((row) => row.ours === 1).length, 1, '自己的那个必须还在')
    assert.equal(active.filter((row) => row.ours === 0).length, 1, '学来的只剩最近用的那个')

    // 最近使用的那个（l3）应该被保留
    assert.ok(active.some((row) => row.sha256 === 'l3'), '保留的应是最近使用的')
  } finally {
    opened.db.close()
  }
})
