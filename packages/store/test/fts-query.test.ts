/**
 * `ftsQuery` 的健壮性测试 —— 守"**查询串本身不许把检索打挂**"。
 *
 * ## 为什么需要这条（2026-10-07 实测发现的既有缺陷）
 *
 * `ftsQuery` 在**不含 CJK** 时把切分后的原文直接交给 `MATCH`。而 FTS5 的裸词只允许
 * 字母/数字/下划线，其余字符被当成操作符 ⇒ 下面这些查询**不是"没命中"，而是直接抛**：
 *
 * ```
 * MATCH 'feed-memory.md'          → fts5: syntax error near "."
 * MATCH '`feed.dedupeSimilarity`' → fts5: syntax error near "`"
 * MATCH '---'                     → fts5: syntax error near "-"
 * ```
 *
 * 这不是理论问题：模型完全可能拿一个文件名、路径或代码片段当查询；而"手动喂食记忆资料"
 * 的查重探针会拿**正文片段**去查（Markdown 表格、带反引号的代码行到处都是），
 * 真实文档一扫就撞上（CLI 扫 `docs/notes/` 时每个文件都报 `✖ … syntax error`）。
 *
 * 修法：把裸词之外的字符清成空格（与 unicode61 在标点处切词的口径一致 ⇒ 语义不变），
 * 清完为空则给 `""`（合法且匹配不到，不是抛错）。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { insertLongEntry, openDatabase, searchLongFts } from '../src/index.ts'
import { ftsQuery, segmentForFts } from '../src/repository.ts'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

test('ftsQuery：拉丁查询里的标点被清成空格（不再当操作符）', () => {
  assert.equal(ftsQuery('feed-memory.md'), 'feed memory md')
  assert.equal(ftsQuery('`feed.dedupeSimilarity`'), 'feed dedupeSimilarity')
  assert.equal(ftsQuery('PLAN.MD §2.19'), 'PLAN MD 2 19')
  assert.equal(ftsQuery('C++ / Rust'), 'C Rust')
})

test('ftsQuery：空 / 纯标点 / 纯空白都给 `""`（合法且匹配不到，不抛）', () => {
  assert.equal(ftsQuery(''), '""')
  assert.equal(ftsQuery('   '), '""')
  assert.equal(ftsQuery('---'), '""')
  assert.equal(ftsQuery('`。`'), '""', '全角标点 + 反引号：清完什么都不剩')
})

test('ftsQuery：含 CJK 走短语查询，内部的引号被转义', () => {
  assert.equal(ftsQuery('防抖窗口'), '"防 抖 窗 口"')
  assert.equal(ftsQuery('说"防抖"'), `"说 "" 防 抖 """`)
  assert.ok(segmentForFts('防抖窗口').startsWith('防'))
})

test('ftsQuery：连续多次调用不因正则状态而变脸（`test()` 在 /g 下是有状态的）', () => {
  const first = ftsQuery('防抖窗口')
  for (let i = 0; i < 5; i += 1) {
    assert.equal(ftsQuery('防抖窗口'), first, `第 ${String(i + 2)} 次调用必须与第一次一致`)
  }
})

test('★ 检索回归：文件名/代码片段模样的查询不再抛，且按裸词命中', () => {
  const db = freshDb()
  insertLongEntry(db, { id: 'doc', content: 'feed-memory.md 是喂食那篇说明文档。', summary: '文档' })
  // 修之前这三个都会抛 `fts5: syntax error`
  assert.deepEqual(searchLongFts(db, 'feed-memory.md', 5).map((row) => row.id), ['doc'])
  assert.deepEqual(searchLongFts(db, '---', 5), [])
  assert.deepEqual(searchLongFts(db, '`feed.dedupeSimilarity`', 5), [])
})

test('★ 短语语义：标点差异**不**影响命中（两侧都过 unicode61 分词，标点不参与）', () => {
  const db = freshDb()
  insertLongEntry(db, { id: 'a', content: '记忆区占比超过 50% 就触发压缩。', summary: '阈值' })
  assert.deepEqual(searchLongFts(db, '记忆区占比超过50%就触发压缩。', 5).map((row) => row.id), ['a'])
  assert.deepEqual(searchLongFts(db, '记忆区占比超过 50% 就触发压缩', 5).map((row) => row.id), ['a'])
  // 但**词**变了就命中不了（短语是相邻 token 序列的精确匹配）
  assert.deepEqual(searchLongFts(db, '记忆区的占比超过 50%', 5), [])
})
