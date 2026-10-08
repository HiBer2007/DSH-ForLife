/**
 * 「手动喂食记忆资料」核心（`feedMemory`）的测试。
 *
 * 守的东西按重要性排序：
 *  ① **走的是真实路径**：喂知识要能在**长期记忆的 FTS** 里被中文检索到（`segmentForFts` 那条链）；
 *     喂经历要真的进中期记忆并推进渲染修订号（压缩/沉降的前提）；
 *  ② **来源追踪**：`source_scope` = `feed:<来源>`，同源重导**更新**而不是新增；
 *  ③ **去重**：与既有记忆几乎相同的段落被跳过（附 `matchedId` 与相似度），而不是又记一遍；
 *  ④ **删除依附既有管理**：重导变短时用 `archiveLongMemory` 归档（可恢复），
 *     **没有**新写删除接口、没有建表、没有内容指纹索引（源码守卫在文件末尾）；
 *  ⑤ 校验失败是 `ok:false`（→ 入口层 400），不是抛异常（→ 500"服务器内部错误"）。
 *
 * 每个用例开一个**独立的内存库**：共享库会让用例之间产生隐式顺序依赖。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import { FEED_DELETE_HINT, feedIdFor, feedMemory, resolveFeedDbPath, splitIntoFeedChunks } from '../src/feed.ts'
import { resolveRuntimeConfig } from '../src/server.ts'
import { getLongEntry, getMidEntry, listLongEntriesByScope, markLongSettled, openDatabase, searchLongFts, searchMidFts } from '@forlife/store'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

/** 长期记忆条数（含归档 —— 归档不是删除，行还在）。 */
function longCount(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM long_memory_entries').get() as { n: number }).n
}

/** 中期记忆条数。 */
function midCount(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM mid_memory_entries').get() as { n: number }).n
}

// ── 分块（最朴素的段落切分）─────────────────────────────────────────────────

test('分块：空行与标题行断开，空白段丢掉', () => {
  const chunks = splitIntoFeedChunks('# 标题\n\n第一段第一行\n第一段第二行\n\n\n第二段\n   \n### 小节\n小节正文\n')
  assert.deepEqual([...chunks], ['# 标题', '第一段第一行\n第一段第二行', '第二段', '### 小节\n小节正文'])
})

test('分块：没有空行的整篇算**一段**（不在这里做定长切 —— 那是记忆系统的事）', () => {
  const long = Array.from({ length: 500 }, (_, i) => `第 ${String(i)} 句。`).join('')
  assert.equal(splitIntoFeedChunks(long).length, 1)
})

// ── 知识 ⇒ 长期记忆（真实写入路径）────────────────────────────────────────────

test('喂知识：进长期记忆、带来源标记、且能被中文 FTS 检索到', () => {
  const db = freshDb()
  const result = feedMemory(db, {
    items: [{ content: 'QQ 防抖窗口取 2-3 秒，同会话新消息会重置计时。' }],
    as: 'knowledge',
    source: 'notes/debounce.md',
  })

  assert.equal(result.ok, true)
  assert.equal(result.chunkCount, 1)
  assert.equal(result.inserted, 1)
  assert.equal(result.scope, 'feed:notes/debounce.md')
  assert.ok(result.tokens > 0, 'token 必须是真实估算，不能是 0')

  const id = result.details[0]?.id ?? ''
  const row = getLongEntry(db, id)
  assert.equal(row?.source_scope, 'feed:notes/debounce.md', '来源要落在既有的 source_scope 列上')
  assert.equal(row?.status, 'active')

  // ★ 关键：中文检索真的通（unicode61 对 CJK 无效，必须走 segmentForFts 那条链）
  const hits = searchLongFts(db, '防抖窗口', 5)
  assert.deepEqual(hits.map((hit) => hit.id), [id], '刚喂进去的正文必须能被"防抖窗口"搜到')
  assert.ok(searchLongFts(db, '不存在的词', 5).length === 0)
})

test('喂知识：多段按段落落成多条，摘要缺省时按首行截断', () => {
  const db = freshDb()
  const result = feedMemory(db, {
    items: [{ content: '# 部署笔记\n\n数据库用 WAL，网关与插件共享同一个库文件。\n\n备份走 VACUUM INTO。' }],
    as: 'knowledge',
    source: 'notes/deploy.md',
  })
  assert.equal(result.chunkCount, 3)
  assert.equal(result.inserted, 3)
  assert.equal(longCount(db), 3)

  const summaries = db.prepare('SELECT summary FROM long_memory_entries ORDER BY created_at, id').all() as unknown as {
    summary: string
  }[]
  assert.ok(summaries.some((row) => row.summary === '部署笔记'), '标题段的摘要不该带 #')
  for (const row of summaries) assert.notEqual(row.summary.trim(), '', '摘要不能为空（列表/检索都用它）')
})

test('喂知识：同源重导**更新**已有条目，不新增行；内容没变则如实说"未改动"', () => {
  const db = freshDb()
  const first = feedMemory(db, {
    items: [{ content: '阈值取 0.5。\n\n冷却 60 秒。' }],
    as: 'knowledge',
    source: 'notes/compaction.md',
  })
  assert.equal(first.inserted, 2)
  const ids = first.details.map((detail) => detail.id)
  assert.equal(longCount(db), 2)

  // 第二段改了，第一段没变
  const second = feedMemory(db, {
    items: [{ content: '阈值取 0.5。\n\n冷却 90 秒（真机实测后调整）。' }],
    as: 'knowledge',
    source: 'notes/compaction.md',
  })
  assert.equal(second.unchanged, 1, '没变的那段不该被重写')
  assert.equal(second.updated, 1, '变了的那段是**更新**，不是新增')
  assert.equal(second.inserted, 0)
  assert.equal(longCount(db), 2, '同源重导不许把条目数喂大')
  assert.deepEqual(
    second.details.map((detail) => detail.id).sort(),
    [...ids].sort(),
    '同源重导必须落在同一批 id 上（靠"来源 + 段落序号"派生，不靠内容指纹）',
  )
  assert.equal(getLongEntry(db, ids[1] as string)?.content, '冷却 90 秒（真机实测后调整）。')
})

test('喂知识：重导变短 ⇒ 上一版多出来的段落被**归档**（既有管理能力，可恢复）', () => {
  const db = freshDb()
  const first = feedMemory(db, {
    items: [{ content: '第一段。\n\n第二段。\n\n第三段。' }],
    as: 'knowledge',
    source: 'notes/shrink.md',
  })
  const staleId = first.details[2]?.id ?? ''

  const second = feedMemory(db, { items: [{ content: '第一段。\n\n第二段。' }], as: 'knowledge', source: 'notes/shrink.md' })
  assert.equal(second.archived, 1, '上一版多出来的那一段要归档')
  assert.equal(longCount(db), 3, '归档**不是真删**：行还在（引用它的中期条目不会断链）')
  assert.equal(getLongEntry(db, staleId)?.status, 'archived')

  // 再喂一次同样的短内容：已经归档过的不再重复报"归档了 1 条"
  const third = feedMemory(db, { items: [{ content: '第一段。\n\n第二段。' }], as: 'knowledge', source: 'notes/shrink.md' })
  assert.equal(third.archived, 0)
  assert.ok(
    third.details.some((detail) => detail.reason.includes('已经归档过了')),
    '要如实说明"早就归档了"，而不是默不作声',
  )
})

test('喂知识：与**别的来源**已有记忆几乎相同的段落被跳过（复用既有检索判重）', () => {
  const db = freshDb()
  feedMemory(db, { items: [{ content: '记忆区占比超过 50% 就触发压缩。' }], as: 'knowledge', source: 'notes/a.md' })

  const second = feedMemory(db, {
    items: [{ content: '记忆区占比超过50%就触发压缩。' }],
    as: 'knowledge',
    source: 'notes/b.md',
  })
  assert.equal(second.inserted, 0)
  assert.equal(second.duplicates, 1)
  const detail = second.details[0]
  assert.ok((detail?.similarity ?? 0) > 0.9, '要给出真实的相似度（面板与 CLI 都显示它）')
  assert.equal(detail?.matchedId, feedIdFor('notes/a.md', 0), '要指出撞上了哪一条')
  assert.equal(longCount(db), 1, '判重不许真写进去')
})

test('喂知识：抓不到的边界要诚实（改动落在查重前缀之内 ⇒ 判不出重复）', () => {
  const db = freshDb()
  feedMemory(db, { items: [{ content: '长期记忆沉降的条件是 90 天未访问。' }], as: 'knowledge', source: 'notes/a.md' })
  // 在**前缀之内**插了一个字：FTS 短语（精确相邻）取不到候选 ⇒ 判不出重复
  const second = feedMemory(db, {
    items: [{ content: '长期记忆的沉降的条件是 90 天未访问。' }],
    as: 'knowledge',
    source: 'notes/b.md',
  })
  assert.equal(second.duplicates, 0, '词面近似抓不到前缀内的插入 —— 如实插进去，不假装判了重')
  assert.equal(second.inserted, 1)
  assert.equal(longCount(db), 2, '代价是多一条近重复：**宁漏不误杀**（误杀会让用户以为喂进去了）')
})

test('喂知识：已沉降到冷层的条目不被重导拉回热层（冷热归既有沉降策略管）', () => {
  const db = freshDb()
  const first = feedMemory(db, { items: [{ content: '冷层条目的正文在归档里。' }], as: 'knowledge', source: 'notes/cold.md' })
  const id = first.details[0]?.id ?? ''
  // 模拟既有沉降：正文移入归档、表内 content 置空、storage_tier = hdd
  markLongSettled(db, id, 'archive/cold.ndjson')

  const again = feedMemory(db, {
    items: [{ content: '冷层条目的正文在归档里（改过）。' }],
    as: 'knowledge',
    source: 'notes/cold.md',
  })
  assert.equal(again.updated, 0, '重导不该把冷数据拽回热层（那是既有沉降策略的决定）')
  assert.ok(
    again.details.some((detail) => detail.reason.includes('冷层')),
    '要如实说明"这一段已沉降、没动它"，而不是默不作声',
  )
  assert.equal(getLongEntry(db, id)?.content, null, '冷条目的正文仍然为空')
  assert.equal(getLongEntry(db, id)?.storage_tier, 'hdd')
})

test('id 派生：只跟"来源 + 段落序号"有关，与内容无关（不是内容指纹索引）', () => {
  assert.equal(feedIdFor('notes/a.md', 0), feedIdFor('notes/a.md', 0))
  assert.notEqual(feedIdFor('notes/a.md', 0), feedIdFor('notes/a.md', 1))
  assert.notEqual(feedIdFor('notes/a.md', 0), feedIdFor('notes/b.md', 0))
  assert.match(feedIdFor('notes/a.md', 0), /^feed_[0-9a-f]{10}_0$/)
})

// ── 经历 ⇒ 中期记忆（真实写入路径）────────────────────────────────────────────

test('喂经历：进中期记忆、推进渲染修订号、带来源标记、可被中文 FTS 检索', () => {
  const db = freshDb()
  const result = feedMemory(db, {
    items: [{ content: '今天主人说以后日志都写 UTC，显示再转东八区。' }],
    as: 'experience',
    source: 'chat/2026-10-07',
  })
  assert.equal(result.ok, true)
  assert.equal(result.inserted, 1)
  assert.equal(result.revision, 1, '写入必须推进渲染修订号（否则 L3 窗口不会重渲染）')

  const id = result.details[0]?.id ?? ''
  const row = getMidEntry(db, id)
  assert.equal(row?.source_scope, 'feed:chat/2026-10-07')
  assert.equal(row?.status, 'active')
  assert.deepEqual(searchMidFts(db, '东八区', 5).map((hit) => hit.id), [id])
})

test('喂经历：同源重导相同内容判为已喂过；内容变了则以新条目**追加**（中期记忆只追加）', () => {
  const db = freshDb()
  const first = feedMemory(db, { items: [{ content: '第一段经历。' }], as: 'experience', source: 'diary/day1' })
  const baseId = first.details[0]?.id ?? ''

  const again = feedMemory(db, { items: [{ content: '第一段经历。' }], as: 'experience', source: 'diary/day1' })
  assert.equal(again.duplicates, 1)
  assert.equal(midCount(db), 1, '同样的内容不许喂出两条')

  const changed = feedMemory(db, { items: [{ content: '第一段经历（补充：当时在下雨）。' }], as: 'experience', source: 'diary/day1' })
  assert.equal(changed.inserted, 1, '内容变了要追加新版本 —— 中期记忆没有 update 原语，不能假装更新了')
  assert.equal(midCount(db), 2)
  assert.notEqual(changed.details[0]?.id, baseId, '新版本用新 id，老的那条留在库里')
  assert.equal(getMidEntry(db, baseId)?.content, '第一段经历。', '老条目一个字节都不许动')

  // 同一份改动重复喂 ⇒ 命中同一个 id ⇒ 不会越喂越多
  const repeat = feedMemory(db, { items: [{ content: '第一段经历（补充：当时在下雨）。' }], as: 'experience', source: 'diary/day1' })
  assert.equal(repeat.duplicates, 1)
  assert.equal(midCount(db), 2)
})

test('喂经历：与既有中期记忆几乎相同的段落被跳过（空白差异算同一段）', () => {
  const db = freshDb()
  feedMemory(db, { items: [{ content: '长期记忆沉降的条件是 90 天未访问。' }], as: 'experience', source: 'diary/a' })
  const second = feedMemory(db, { items: [{ content: '长期记忆沉降的条件是90天未访问。' }], as: 'experience', source: 'diary/b' })
  assert.equal(second.inserted, 0)
  assert.equal(second.duplicates, 1)
  assert.equal(midCount(db), 1)
})

// ── dry-run 与校验 ───────────────────────────────────────────────────────────

test('dry-run：一段都不落库，但如实报出"会发生什么"', () => {
  const db = freshDb()
  const preview = feedMemory(db, {
    items: [{ content: '第一段。\n\n第二段。' }],
    as: 'knowledge',
    source: 'notes/dry.md',
    dryRun: true,
  })
  assert.equal(preview.ok, true)
  assert.equal(preview.dryRun, true)
  assert.equal(preview.inserted, 0)
  assert.equal(preview.details.filter((detail) => detail.action === 'planned').length, 2)
  assert.equal(longCount(db), 0, '--dry-run 必须一行都不写')
  assert.equal(midCount(db), 0)
})

test('校验：空内容与超上限都是 ok:false（入口层要能变成 400，而不是 500）', () => {
  const db = freshDb()
  const empty = feedMemory(db, { items: [{ content: '   \n\n  ' }], as: 'knowledge', source: 'x' })
  assert.equal(empty.ok, false)
  assert.match(empty.error ?? '', /没有可喂的内容/)

  // 上限读基线（不在这里写死数字 —— 阈值只有一处真源）
  const cap = defaultFor<number>('feed.maxItemsPerCall')
  const tooMany = feedMemory(db, {
    items: [{ content: Array.from({ length: cap + 1 }, (_, i) => `第 ${String(i)} 段。`).join('\n\n') }],
    as: 'knowledge',
    source: 'x',
  })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error ?? '', /超过单次上限/)
  assert.equal(longCount(db), 0, '被拒的请求不许留下一半数据')
})

test('缺省来源：按内容派生 —— 同样的内容幂等，不同的内容互不覆盖', () => {
  const db = freshDb()
  const first = feedMemory(db, { items: [{ content: '随手记一句。' }], as: 'knowledge' })
  assert.equal(first.ok, true)
  assert.match(first.source, /^knowledge:[0-9a-f]{8}$/, '缺省来源按内容派生（不是常量、也不是假文件名）')
  assert.equal(first.inserted, 1)

  // 同样的内容再喂一次：**幂等**（不是又加一条）
  const again = feedMemory(db, { items: [{ content: '随手记一句。' }], as: 'knowledge' })
  assert.equal(again.source, first.source)
  assert.equal(again.unchanged, 1)
  assert.equal(longCount(db), 1)

  // 不同的内容（也没给来源）：**不许**盖掉上一条
  const other = feedMemory(db, { items: [{ content: '另一句完全不同的话。' }], as: 'knowledge' })
  assert.notEqual(other.source, first.source, '没给来源时不同的内容必须落成不同的来源')
  assert.equal(other.inserted, 1)
  assert.equal(longCount(db), 2)
  assert.equal(getLongEntry(db, first.details[0]?.id ?? '')?.content, '随手记一句。', '上一条一个字节都不许动')
})

test('同一个 source 就是同一份东西：显式同源 + 不同正文 ⇒ 如实报"更新"（不新增）', () => {
  const db = freshDb()
  feedMemory(db, { items: [{ content: 'A 版正文。' }], as: 'knowledge', source: 'notes/one-doc.md' })
  const second = feedMemory(db, { items: [{ content: 'B 版正文（整个换掉了）。' }], as: 'knowledge', source: 'notes/one-doc.md' })
  assert.equal(second.updated, 1, '同源 = 同一份东西的不同版本，语义就是更新')
  assert.equal(second.inserted, 0)
  assert.equal(longCount(db), 1, '这也是为什么要给"不同的两段东西"用不同的来源')
})

// ── 删除依附既有管理 + 没有平行机制（源码守卫）────────────────────────────────

test('删除指引指向**既有**记忆管理（不是新的删除接口）', () => {
  assert.match(FEED_DELETE_HINT, /memory-archive/)
  assert.match(FEED_DELETE_HINT, /归档/)
  assert.match(FEED_DELETE_HINT, /不是真删/)
})

test('★ 源码守卫：feed.ts 里没有建表 / 删数据 / 内容指纹索引（不许造平行机制）', () => {
  // **必须去掉注释再扫**：模块头里那句"没有 sha256 内容指纹表"是在说"不要这么干"，
  // 把它当违规就是误报（本仓在 `param-consumption.test.ts` 栽过同一个坑）。
  const raw = readFileSync(new URL('../src/feed.ts', import.meta.url), 'utf8')
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase()
  for (const forbidden of ['create table', 'delete from', 'drop index', 'sha256']) {
    assert.ok(!source.includes(forbidden), `feed.ts 里不许出现「${forbidden}」—— 那是平行机制的开始`)
  }
  // 复用既有路径：写入、检索、更新、归档都必须来自记忆系统本身
  for (const required of ['insertlongentry', 'appendmidentry', 'searchlongfts', 'searchmidfts', 'updatelongmemory', 'archivelongmemory']) {
    assert.ok(source.includes(required), `feed.ts 必须复用既有的 ${required}（自己实现一套就是旁路）`)
  }
})

// ── 数据库路径推导（可移植）──────────────────────────────────────────────────

test('DB 路径：FORLIFE_DB 优先、DSH_HOME 次之、默认与 gateway 的推导一致且不碰宿主目录', () => {
  assert.equal(resolveFeedDbPath({ FORLIFE_DB: 'D:/tmp/custom.sqlite' }), 'D:/tmp/custom.sqlite')

  const fromHome = resolveFeedDbPath({ DSH_HOME: 'D:/isolated/dsh' })
  assert.equal(fromHome.replace(/\\/g, '/'), 'D:/isolated/dsh/forlife/db/forlife.sqlite')
  assert.equal(
    resolveFeedDbPath({ FORLIFE_DSH_HOME: 'D:/isolated/dsh' }).replace(/\\/g, '/'),
    'D:/isolated/dsh/forlife/db/forlife.sqlite',
    'FORLIFE_DSH_HOME 是部署侧的变量名，也要认',
  )

  // 默认值必须与 `resolveRuntimeConfig`（gateway 服务端）派生的**同一个文件** ——
  // 两处各写一份路径，迟早会喂到"另一个库"里去
  const fallback = resolveFeedDbPath({})
  assert.equal(fallback, resolveRuntimeConfig({}).dbPath)
  assert.ok(!fallback.startsWith(homedir()), `默认库必须落在仓库内，不能是宿主目录：${fallback}`)
  assert.ok(fallback.replace(/\\/g, '/').includes('/.runtime/dsh/forlife/db/forlife.sqlite'))
})
