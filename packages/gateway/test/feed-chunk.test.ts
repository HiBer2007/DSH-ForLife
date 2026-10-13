/**
 * 机械切分（`feed-chunk.ts`）的测试。
 *
 * 守的是**切分的承诺**（这些承诺一旦破了，坏法是"记忆被悄悄截断"或"窗口被一条炸掉"）：
 *  ① 每一片都 ≤ 天花板（`feed.chunkMaxTokens`）—— 不超限的段落**原样一片**；
 *  ② 不丢字、不重叠：把切片按顺序接回去就是原文（除了片间空白）；
 *  ③ 边界对齐在**句子**上（`。！？；` / 换行 / 子句），只有"一整坨没有标点"才硬切；
 *  ④ **流式切分与整段切分对同一份输入给出同样的正文切片** ——
 *     这条最重要：文件走流式、`--text` 走整段，两者必须落成同一批段落 id，
 *     否则"同一个文件换个入口喂"就会变成另一份文档（重复写一遍）。
 *
 * @module @forlife/gateway/test/feed-chunk
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { estimateTokens } from '@forlife/memory-core'

import { refineFeedChunk, streamFeedChunks, withPieceSuffix } from '../src/feed-chunk.ts'
import { splitIntoFeedChunks } from '../src/feed.ts'

/** 逐片检查"不超限 + 不丢字"（两条最要紧的承诺）。 */
function assertPiecesSane(pieces: readonly { readonly text: string }[], ceiling: number, original: string): void {
  assert.ok(pieces.length > 0, '不该切出空结果')
  for (const piece of pieces) {
    assert.ok(estimateTokens(piece.text) <= ceiling, `切片超限：${String(estimateTokens(piece.text))} > ${String(ceiling)}`)
  }
  // 不丢字/不重叠：接回去必须等于原文（测试文本刻意不含片间空白）
  assert.equal(pieces.map((piece) => piece.text).join(''), original, '切片接回去必须等于原文（不丢字、不重叠、不重排）')
}

test('不超上限 ⇒ **原样一片**（这是"与过去逐字节一致"那条承诺的落点）', () => {
  const text = '第一句。第二句。第三句。'
  const pieces = refineFeedChunk(text, 1000)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0]?.text, text)
  assert.equal(pieces[0]?.parts, 1)
  assert.equal(pieces[0]?.part, 1)
})

test('空文本/纯空白 ⇒ 空数组（不写空记忆）', () => {
  assert.deepEqual([...refineFeedChunk('', 100)], [])
  assert.deepEqual([...refineFeedChunk('   \n\n  ', 100)], [])
})

test('★ 超上限：按**句子边界**切，每片 ≤ 上限，接回去等于原文', () => {
  const ceiling = 120
  const original = Array.from({ length: 200 }, (_, i) => `第 ${String(i)} 句，说的是过去的一件事。`).join('')
  const pieces = refineFeedChunk(original, ceiling)
  assert.ok(pieces.length > 1, '这么长的正文必须被切开')
  assertPiecesSane(pieces, ceiling, original)
  // 句子边界对齐：除最后一片外，每片都停在句末标点上
  for (const piece of pieces.slice(0, -1)) {
    assert.match(piece.text.slice(-1), /[。！？；…]/, `这片没有停在句末：…${piece.text.slice(-12)}`)
  }
  // 片号连续、总数一致
  assert.deepEqual(
    pieces.map((piece) => piece.part),
    Array.from({ length: pieces.length }, (_, i) => i + 1),
  )
  for (const piece of pieces) assert.equal(piece.parts, pieces.length)
})

test('★ 没有标点的一整坨（base64 / 单行 JSON）⇒ 硬切，仍然逐片 ≤ 上限', () => {
  const ceiling = 100
  const original = 'A'.repeat(50_000) // 没有任何边界可对齐
  const pieces = refineFeedChunk(original, ceiling)
  assert.ok(pieces.length >= 100, `必须切成很多片，实际 ${String(pieces.length)}`)
  assertPiecesSane(pieces, ceiling, original)
})

test('★ 中文密集型：字符窗口装不下（1 字 ≈ 1 token）时按实测比例收缩，不许超限', () => {
  const ceiling = 300
  const original = '好'.repeat(20_000)
  const pieces = refineFeedChunk(original, ceiling)
  assertPiecesSane(pieces, ceiling, original)
  assert.ok(pieces.length >= 60, `20k 个汉字按 300 token 切至少要 60 片，实际 ${String(pieces.length)}`)
})

test('上限不可用（<=0 / NaN）⇒ **原样一整片**（宁可这条超大，也不许静默丢内容）', () => {
  const original = '一句话。'.repeat(1000)
  for (const bad of [0, -5, Number.NaN]) {
    const pieces = refineFeedChunk(original, bad)
    assert.equal(pieces.length, 1, `上限=${String(bad)} 时不该切`)
    assert.equal(pieces[0]?.text, original)
  }
})

test('代理对不被劈开（emoji 不会变成两个孤立代理）', () => {
  const ceiling = 40
  const original = '😀'.repeat(500)
  const pieces = refineFeedChunk(original, ceiling)
  assert.ok(pieces.length > 1)
  for (const piece of pieces) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(piece.text), '切片末尾不许是高位代理')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(piece.text), '切片开头不许是低位代理')
  }
  assert.equal(pieces.map((piece) => piece.text).join(''), original)
})

test('★★ 差分：流式切分 == 整段切分（**同一份输入**给出同样的正文切片）', async () => {
  const ceiling = 150
  const corpora = [
    '短的一段。',
    Array.from({ length: 300 }, (_, i) => `第 ${String(i)} 句，说的是过去的一件事。`).join(''),
    // 单条巨型段落（没有空行）：JSONL / dump 的形状
    Array.from({ length: 300 }, (_, i) => `第 ${String(i)} 条记录：字段一二三。`).join('\n'),
    // 多段落 + 标题行
    `# 标题\n\n${'正文一句。'.repeat(200)}\n\n## 第二节\n\n${'另一句。'.repeat(200)}`,
    // 没有标点的硬切形状
    'B'.repeat(20_000),
    // 中英混排
    `${'中文句子。'.repeat(50)}${'english sentence. '.repeat(50)}`,
  ]
  for (const [index, text] of corpora.entries()) {
    const materialized = splitIntoFeedChunks(text).flatMap((paragraph) => refineFeedChunk(paragraph, ceiling).map((piece) => piece.text))
    for (const size of [1, 3, 64, 4096]) {
      const chunks: string[] = []
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
      const streamed: string[] = []
      for await (const piece of streamFeedChunks(chunks, { maxTokens: ceiling })) streamed.push(piece.text)
      assert.deepEqual(
        streamed,
        materialized,
        `第 ${String(index)} 份语料在块大小 ${String(size)} 下，流式与整段切分不一致`,
      )
    }
  }
})

test('流式切分：块边界落在任何地方都不影响结果（含 \\r\\n 被劈成两块）', async () => {
  const ceiling = 60
  const text = '第一段。\r\n\r\n第二段。\r\n\r\n第三段。'
  const expected = splitIntoFeedChunks(text).flatMap((paragraph) => refineFeedChunk(paragraph, ceiling).map((piece) => piece.text))
  // 块边界逐字节推进：'\r' 与 '\n' 会被劈开，正是最容易写错的地方
  const chunks = [...text]
  const streamed: string[] = []
  for await (const piece of streamFeedChunks(chunks, { maxTokens: ceiling })) streamed.push(piece.text)
  assert.deepEqual(streamed, expected)
  assert.deepEqual(streamed, ['第一段。', '第二段。', '第三段。'])
})

test('流式切分：段落边界与 `splitIntoFeedChunks` 一致（空行、标题行都断开）', async () => {
  const text = '# 标题\n正文第一行\n正文第二行\n\n\n第二段\n   \n### 小节\n小节正文\n'
  const streamed: string[] = []
  for await (const piece of streamFeedChunks([text], { maxTokens: 10_000 })) streamed.push(piece.text)
  assert.deepEqual(streamed, [...splitIntoFeedChunks(text)])
})

test('流式切分：被切过的片 `parts` 未知（只报第 k 段），整段装得下时才报得出总数', async () => {
  const ceiling = 30
  const long = '这一句有点长，会被切开。'.repeat(40)
  const split: { part: number; parts?: number | undefined }[] = []
  for await (const piece of streamFeedChunks([long], { maxTokens: ceiling })) split.push(piece)
  assert.ok(split.length > 1)
  assert.ok(
    split.every((piece) => piece.parts === undefined),
    '流式切分在"这一段还没读完"时不可能知道总数 —— 报出来就是撒谎',
  )

  const short: { part: number; parts?: number | undefined }[] = []
  for await (const piece of streamFeedChunks(['短的一段。'], { maxTokens: ceiling })) short.push(piece)
  assert.deepEqual(
    short.map((piece) => ({ part: piece.part, parts: piece.parts })),
    [{ part: 1, parts: 1 }],
  )
})

test('摘要后缀：只动摘要；片号/总数怎么标', () => {
  assert.equal(withPieceSuffix('摘要', { part: 1, parts: 1 }), '摘要', '没被切过 ⇒ 不加后缀')
  assert.equal(withPieceSuffix('摘要', { part: 2, parts: 3 }), '摘要（第 2/3 段）')
  assert.equal(withPieceSuffix('摘要', { part: 1 }), '摘要（第 1 段）', '流式的第一片也要标：parts 缺失本身就说明它被切过')
  assert.equal(withPieceSuffix('摘要', { part: 3 }), '摘要（第 3 段）')
})

test('★ 切片是"原子"的：每一片再喂给核心的段落切分，仍然只有一段', () => {
  // 这条保证"批次里的一段 = 落库的一条"：否则段落序号会错位，重导会整体重写
  const ceiling = 120
  const text = `# 标题\n\n${'正文一句。'.repeat(300)}\n\n${'B'.repeat(5000)}`
  for (const paragraph of splitIntoFeedChunks(text)) {
    for (const piece of refineFeedChunk(paragraph, ceiling)) {
      assert.equal(splitIntoFeedChunks(piece.text).length, 1, `切片不是原子的：${piece.text.slice(0, 40)}…`)
    }
  }
})
