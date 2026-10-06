/**
 * 私有媒体并入长期记忆的验收测试 —— 直接对着 PLAN 阶段六那条写：
 * 「`media_save` 后 `recall_longterm("那张架构图")` 能命中该条目，
 *   `recall_media(id)` 取回原图；表情与私有媒体**检索不混用**」
 *
 * 三条最值得守的：
 *  1. 保存后**长期记忆真的能命中**（只写 media 表的话模型永远找不到它）
 *  2. 表情检索**绝不能**命中私有媒体（否则私人文件可能被发出去 —— 隐私事故）
 *  3. 备注后补要生效（同一张图第二次保存往往带着更好的说明，丢了就是白写）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase, searchLongFts } from '@forlife/store'

import { buildMediaMemoryText, getMediaAsset, saveMediaAsset, searchMedia } from '../src/media.ts'

/** 造一条媒体。 */
function save(db: Parameters<typeof saveMediaAsset>[0], over: Partial<Parameters<typeof saveMediaAsset>[1]> = {}) {
  return saveMediaAsset(db, {
    sha256: over.sha256 ?? 'sha-1',
    kind: over.kind ?? 'image',
    mime: over.mime ?? 'image/png',
    sizeBytes: over.sizeBytes ?? 1024,
    storagePath: over.storagePath ?? '/m/1.png',
    ...(over.note === undefined ? {} : { note: over.note }),
    ...(over.originalName === undefined ? {} : { originalName: over.originalName }),
    ...(over.conversationKey === undefined ? {} : { conversationKey: over.conversationKey }),
  })
}

test('★ 验收：保存后 recall_longterm 能命中（这是"并入长期记忆"的定义）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const saved = save(opened.db, { note: '网关与 NapCat 的部署架构图', originalName: 'arch.png' })
    assert.equal(saved.created, true)

    // recall_longterm 走的是长期记忆的全文检索 —— 必须能命中
    const hits = searchLongFts(opened.db, '架构图', 5)
    assert.ok(hits.length >= 1, '「架构图」必须能命中 —— 命不中就说明没真正并入长期记忆')
    assert.equal(hits[0]?.id, saved.longMemoryId, '命中的应该是我们刚建的那条记忆')

    // 按文件名也能找到（用户可能记得的是文件名）
    assert.ok(searchLongFts(opened.db, 'arch', 5).length >= 1, '按文件名也该能找到')
  } finally {
    opened.db.close()
  }
})

test('★ 表情检索与私有媒体**绝不混用**（混用会让私人文件可能被发出去）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    save(opened.db, { note: '我的身份证照片', originalName: 'id.png' })

    // 表情库里没有东西
    const stickerCount = (opened.db.prepare('SELECT COUNT(*) AS v FROM sticker_assets').get() as { v: number }).v
    assert.equal(stickerCount, 0, '保存私有媒体**不该**往表情库里写任何东西')

    // 媒体检索能命中（说明数据确实在，只是不在表情库那条路径上）
    assert.equal(searchMedia(opened.db, '身份证').length, 1)
  } finally {
    opened.db.close()
  }
})

test('recall_media：能按 id 取回原图（拿到 storage_path）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const saved = save(opened.db, { note: '一张图', storagePath: '/m/abc.png' })
    const asset = getMediaAsset(opened.db, saved.id)
    assert.ok(asset !== undefined)
    assert.equal(asset.storage_path, '/m/abc.png', '必须能拿到落盘路径，否则取不回原图')
    assert.equal(asset.long_memory_id, saved.longMemoryId, '两边必须串起来')
  } finally {
    opened.db.close()
  }
})

test('指纹去重：同一张图第二次保存不新增行、不重复建记忆条目', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const first = save(opened.db, { sha256: 'same', note: '第一版说明' })
    const second = save(opened.db, { sha256: 'same', note: '第一版说明' })
    assert.equal(second.created, false)
    assert.equal(second.id, first.id)
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM media_assets').get() as { v: number }).v, 1)
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM long_memory_entries').get() as { v: number }).v, 1, '不能重复建记忆条目')
  } finally {
    opened.db.close()
  }
})

test('备注后补要生效（同一张图第二次保存往往带着更好的说明）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    save(opened.db, { sha256: 'same2', note: '一张图' })
    const second = save(opened.db, { sha256: 'same2', note: '这是网关的部署架构图' })
    assert.equal(second.created, false)

    const asset = getMediaAsset(opened.db, second.id)
    assert.equal(asset?.note, '这是网关的部署架构图', '新备注必须生效 —— 丢了就等于把用户刚写的说明扔了')

    // 记忆条目的文本也要跟着更新，否则新备注搜不到
    assert.ok(searchLongFts(opened.db, '部署架构', 5).length >= 1, '备注更新后，新词必须能搜到')
  } finally {
    opened.db.close()
  }
})

test('记忆文本要覆盖多种回忆方式（备注 / 文件名 / 类型）', () => {
  const text = buildMediaMemoryText({ note: '架构图', originalName: 'arch.png', kind: 'image' })
  assert.match(text, /架构图/)
  assert.match(text, /arch\.png/, '用户可能按文件名找')
  assert.match(text, /图片/, '用户也可能只说"那张图片"')

  // 没有备注时也要有可用文本（不能是空串，否则 FTS 什么都搜不到）
  const bare = buildMediaMemoryText({ kind: 'file' })
  assert.ok(bare.trim() !== '')
  assert.match(bare, /文件/)
})

test('searchMedia：空 query 返回空数组（不是全量）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    save(opened.db, { note: '某张图' })
    assert.deepEqual(searchMedia(opened.db, ''), [], '空 query 不该把整个媒体库倒出来')
    assert.deepEqual(searchMedia(opened.db, '   '), [])
  } finally {
    opened.db.close()
  }
})
