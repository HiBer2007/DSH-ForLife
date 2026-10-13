/**
 * 表情检索的验收测试 —— 直接对着 PLAN 阶段六那条标准写：
 * **手动丢 10 张图入库 → 自动生成描述 → 自然语言 query 检索 top-1 命中 ≥ 8/10**。
 *
 * 所以这里就造 10 张（描述 + 标签），再用 10 条自然语言 query 去查，
 * **断言命中率 ≥ 8**。命中率这个断言比"某一条必须命中"更有意义：
 * 它衡量的正是验收标准本身，而不是我挑出来的一个漂亮例子。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase, saveStickerDescription, upsertStickerAsset } from '@forlife/store'

import { scoreSticker, searchStickers, tokenize } from '../src/sticker-search.ts'

/** 10 张表情：描述是我们会从视觉模型拿到的那种口吻，标签是主动打的。 */
const LIBRARY: readonly { key: string; description: string; tags: readonly string[] }[] = [
  { key: 'cat', description: '一只橘猫趴在键盘上睡觉，眼睛闭着', tags: ['猫', '睡觉', '可爱'] },
  { key: 'panda-crack', description: '熊猫头表情包，配文「我裂开了」', tags: ['熊猫头', '崩溃', '裂开'] },
  { key: 'shiba', description: '柴犬歪着头，一脸疑惑地看着镜头', tags: ['狗', '疑惑'] },
  { key: 'thumb', description: '一个小人竖起大拇指，配文「牛」', tags: ['点赞', '牛', '厉害'] },
  { key: 'cry', description: '流泪的卡通人物，配文「呜呜呜」', tags: ['哭', '伤心'] },
  { key: 'typing', description: '火柴人疯狂敲键盘，旁边有汗滴', tags: ['敲键盘', '忙碌', '加班'] },
  { key: 'penguin', description: '一只企鹅脚下一滑摔倒了', tags: ['企鹅', '摔倒', '搞笑'] },
  { key: 'warn', description: '红色感叹号，配文「注意」', tags: ['警告', '注意'] },
  { key: 'rabbit', description: '一只兔子用两只前爪比出一个心形', tags: ['兔子', '比心', '爱心'] },
  { key: 'panda-eat', description: '熊猫抱着竹子啃，腮帮子鼓鼓的', tags: ['熊猫', '吃', '干饭'] },
]

/** 10 条自然语言 query → 期望命中的 key。 */
const QUERIES: readonly { query: string; expect: string }[] = [
  { query: '猫在睡觉', expect: 'cat' },
  { query: '我裂开了', expect: 'panda-crack' },
  { query: '疑惑', expect: 'shiba' },
  { query: '点赞', expect: 'thumb' },
  { query: '想哭', expect: 'cry' },
  { query: '敲键盘', expect: 'typing' },
  { query: '企鹅摔倒了', expect: 'penguin' },
  { query: '警告', expect: 'warn' },
  { query: '比心', expect: 'rabbit' },
  { query: '熊猫吃竹子', expect: 'panda-eat' },
]

/** 建库并塞进 10 张（返回 key → assetId）。 */
function seed(): { db: ReturnType<typeof openDatabase>['db']; ids: Map<string, string> } {
  const opened = openDatabase({ file: ':memory:' })
  const ids = new Map<string, string>()
  LIBRARY.forEach((item, index) => {
    const asset = upsertStickerAsset(opened.db, {
      sha256: `sha-${item.key}`,
      mime: 'image/png',
      sizeBytes: 1000 + index,
      storagePath: `/s/${item.key}.png`,
      source: 'manual',
      now: new Date(Date.UTC(2026, 0, 1, 0, index)),
    })
    saveStickerDescription(opened.db, {
      assetId: asset.id,
      description: item.description,
      emotionTags: item.tags,
      model: 'test',
    })
    ids.set(item.key, asset.id)
  })
  return { db: opened.db, ids }
}

test('切词：中文取单字+二元组、英文按词、虚词被挡掉', () => {
  const tokens = tokenize('猫在睡觉 hello world')
  assert.ok(tokens.has('睡觉'), '二元组要能命中')
  assert.ok(tokens.has('猫'), '单字要保留（容忍单词查询）')
  assert.ok(!tokens.has('在'), '高频虚词应被挡掉')
  assert.ok(tokens.has('hello') && tokens.has('world'), '英文按词切')
})

test('打分：标签权重高于描述，且分数与 query 长短无关', () => {
  const sticker = { assetId: 'a', description: '一只橘猫趴在键盘上睡觉', emotionTags: ['猫', '睡觉'], useCount: 0 }
  const byTag = scoreSticker('猫', sticker)
  assert.ok(byTag.score > 0, '命中标签应得分')
  assert.ok(byTag.matched.includes('猫'))

  const miss = scoreSticker('汽车', sticker)
  assert.equal(miss.score, 0, '完全无关的 query 得 0 分')
  assert.deepEqual(miss.matched, [])

  // 分数是"命中权重 / query token 数"，所以落在 0..2 之间
  for (const query of ['猫', '猫睡觉', '一只猫在键盘上睡觉', 'hello']) {
    const score = scoreSticker(query, sticker).score
    assert.ok(score >= 0 && score <= 2.0001, `分数应在 0..2：${query} → ${String(score)}`)
  }
})

test('验收：10 条自然语言 query，top-1 命中 ≥ 8/10', () => {
  const { db, ids } = seed()
  try {
    let hits = 0
    const detail: string[] = []
    for (const item of QUERIES) {
      const results = searchStickers(db, item.query, { limit: 3 })
      const top = results[0]
      const expectedId = ids.get(item.expect)
      const ok = top !== undefined && top.asset.id === expectedId
      if (ok) hits += 1
      detail.push(`  ${ok ? '✓' : '✗'} 「${item.query}」→ ${top === undefined ? '(无结果)' : (LIBRARY.find((l) => ids.get(l.key) === top.asset.id)?.key ?? '?')}（期望 ${item.expect}）`)
    }
    assert.ok(
      hits >= 8,
      `top-1 命中率必须 ≥ 8/10（PLAN 阶段六验收），实际 ${String(hits)}/10：\n${detail.join('\n')}`,
    )
  } finally {
    db.close()
  }
})

test('排序稳定：同分时用过的排前面', () => {
  const { db, ids } = seed()
  try {
    // 给 panda-eat 记一次使用，让它与 panda-crack 在「熊猫」这个 query 下同分时胜出
    const pandaEat = ids.get('panda-eat')
    assert.ok(pandaEat !== undefined)
    db.prepare('UPDATE sticker_assets SET use_count = 5 WHERE id = ?').run(pandaEat)

    const results = searchStickers(db, '熊猫', { limit: 2 })
    assert.equal(results[0]?.asset.id, pandaEat, '同分时使用次数多的应排前')
  } finally {
    db.close()
  }
})

test('空库与无意义 query：返回空数组而不是抛错', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    assert.deepEqual(searchStickers(opened.db, '猫'), [])
    const { db } = seed()
    try {
      assert.deepEqual(searchStickers(db, '！！！'), [], '全是标点的 query 应得空结果')
      assert.deepEqual(searchStickers(db, ''), [])
    } finally {
      db.close()
    }
  } finally {
    opened.db.close()
  }
})
