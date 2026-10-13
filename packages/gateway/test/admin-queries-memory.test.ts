/**
 * 「记忆」「压缩」两个板块的只读查询测试。
 *
 * 守四件（都是面板上会被人当成事实的数字）：
 *  ① 空库（全新部署）不抛、全 0、可选字段**真的缺席** —— 面板第一眼不能是红的；
 *  ② 计数 / 求和的口径正确（token 只算 active 与 fragment，长期记忆按行数）；
 *  ③ 排序与截断（window_offset DESC、预览 200 码元、NULL → 空串）；
 *  ④ limit 的三层防线（默认值、夹紧、NaN/0/负数不许把整表拖出来）。
 *
 * 每个用例开一个**独立的**内存库：共享库会让用例之间产生隐式顺序依赖，
 * 后面插入的数据会把前面的断言变得莫名其妙（那种测试改起来比重写还慢）。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import { queryCompaction, queryMemory } from '../src/admin/queries-memory.ts'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

/**
 * 打开一个全新的内存库（迁移会自动把表建出来）。
 *
 * 用 `:memory:` 而不是临时文件：这里根本不需要持久化，而文件库在 Windows 上还要处理
 * WAL 与句柄占用（删除要重试），纯属自找麻烦。
 */
function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

/** 取数组第 n 个元素，取不到就直接失败（`noUncheckedIndexedAccess` 下下标访问都是可空的）。 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`缺少第 ${String(index)} 个元素`)
  return value
}

/** 按 id 找一行，找不到就直接失败（比 `filter(...)[0]` 少一次"其实没找到"的静默）。 */
function byId<T extends { readonly id: string }>(items: readonly T[], id: string): T {
  const value = items.find((item) => item.id === id)
  if (value === undefined) throw new Error(`找不到 id=${id}`)
  return value
}

// ── 造数据的小工具（只写 NOT NULL 列，其余交给表默认值）──────────────────────

interface MidInput {
  readonly id: string
  readonly windowOffset: number
  readonly status?: 'active' | 'fragmented' | 'archived'
  readonly entryType?: 'semantic' | 'fragment'
  readonly content?: string | null
  readonly summary?: string
  readonly tokenCount?: number
  readonly epoch?: number
  readonly createdAt?: string
  readonly lastAccessedAt?: string | null
  readonly sourceScope?: string | null
}

/** 插一条中期记忆。 */
function insertMid(db: DatabaseSync, input: MidInput): void {
  db.prepare(
    `INSERT INTO mid_memory_entries
       (id, entry_type, content, summary, entities, token_count, window_offset, status,
        fragmented_into, fragment_hint, compaction_epoch, source_short_ids, created_at,
        last_accessed_at, storage_tier, revision, source_scope)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'ssd', 0, ?)`,
  ).run(
    input.id,
    input.entryType ?? 'semantic',
    input.content ?? null,
    input.summary ?? `摘要 ${input.id}`,
    input.tokenCount ?? 0,
    input.windowOffset,
    input.status ?? 'active',
    input.epoch ?? 0,
    input.createdAt ?? '2026-01-01T00:00:00.000Z',
    input.lastAccessedAt ?? null,
    input.sourceScope ?? null,
  )
}

/** 插一条长期记忆（`status` 显式允许 null：早期写入的行就是没有状态的）。 */
function insertLong(db: DatabaseSync, id: string, status: string | null): void {
  db.prepare(
    `INSERT INTO long_memory_entries (id, content, summary, entities, status, created_at, access_count)
     VALUES (?, '正文', '摘要', '[]', ?, '2026-01-01T00:00:00.000Z', 0)`,
  ).run(id, status)
}

interface RunInput {
  readonly id: string
  readonly phase: 'started' | 'committed' | 'aborted'
  readonly startedAt: string
  readonly epochFrom?: number
  readonly epochTo?: number | null
  readonly detail?: string | null
  readonly error?: string | null
  readonly endedAt?: string | null
}

/** 插一条压缩运行记录。 */
function insertRun(db: DatabaseSync, input: RunInput): void {
  db.prepare(
    `INSERT INTO compaction_runs
       (id, compaction_id, session_id, phase, epoch_from, epoch_to, plan, detail, error, started_at, ended_at)
     VALUES (?, NULL, NULL, ?, ?, ?, '{"pushedIds":[]}', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.phase,
    input.epochFrom ?? 0,
    input.epochTo ?? null,
    input.detail ?? null,
    input.error ?? null,
    input.startedAt,
    input.endedAt ?? null,
  )
}

interface LogInput {
  readonly id: string
  readonly timestamp: string
  readonly requestedBy?: string | null
  readonly approved?: number | null
  readonly reason?: string | null
  readonly shortBefore?: number | null
  readonly keptInShort?: number | null
  readonly modelUsed?: string | null
}

/** 插一条压缩日志。 */
function insertLog(db: DatabaseSync, input: LogInput): void {
  db.prepare(
    `INSERT INTO compaction_log
       (id, requested_by, approved, reason_if_rejected, short_tokens_before, turns_since_last,
        time_since_last, pushed_entries, fragmented_entries, kept_in_short_tokens, model_used, timestamp, cache_warmed)
     VALUES (?, ?, ?, ?, ?, 0, 0, '[]', '[]', ?, ?, ?, 0)`,
  ).run(
    input.id,
    input.requestedBy ?? null,
    input.approved ?? null,
    input.reason ?? null,
    input.shortBefore ?? null,
    input.keptInShort ?? null,
    input.modelUsed ?? null,
    input.timestamp,
  )
}

// ── 记忆 ──────────────────────────────────────────────────────────────────────

test('空库：各计数为 0、列表为空、可选字段真的缺席（函数不抛）', () => {
  const db = freshDb()

  const memory = queryMemory(db)
  assert.equal(memory.epoch, 0)
  assert.equal(memory.revision, 0)
  assert.deepEqual(memory.counts, { active: 0, fragmented: 0, archived: 0, long: 0 })
  assert.deepEqual(memory.tokens, { active: 0, fragment: 0 })
  assert.deepEqual(memory.entries, [])

  const compaction = queryCompaction(db)
  assert.deepEqual(compaction.runs, [])
  assert.deepEqual(compaction.log, [])
  assert.deepEqual(compaction.stats, { committed: 0, aborted: 0, started: 0 })
  // 可选字段必须"缺席"而不是等于 undefined：`'lastAt' in stats` 为 false 才算对
  // （JSON 里 undefined 会整个消失，但 JS 侧 `in` / Object.keys 仍然看得见，面板会多一行空值）
  assert.equal('lastAt' in compaction.stats, false, '空库没有"最近一次压缩"')
  assert.equal('tokensBefore' in compaction.stats, false)
  assert.equal('tokensAfter' in compaction.stats, false)
})

test('epoch / revision 取自 forlife_state；脏值与缺失都回落到 0（不抛、不给 NaN）', () => {
  const db = freshDb()
  db.prepare("UPDATE forlife_state SET value = '7' WHERE key = 'compaction_epoch'").run()
  db.prepare("UPDATE forlife_state SET value = '12' WHERE key = 'render_revision'").run()
  assert.equal(queryMemory(db).epoch, 7)
  assert.equal(queryMemory(db).revision, 12)

  // 值被写脏（手工改库、将来换了写法）时不能变成 NaN：NaN 经 JSON 会变成 null，更难排查
  db.prepare("UPDATE forlife_state SET value = '不是数字' WHERE key = 'compaction_epoch'").run()
  assert.equal(queryMemory(db).epoch, 0)

  // 键整个缺失（老库、回滚过）时是 0，不是异常
  db.prepare("DELETE FROM forlife_state WHERE key = 'compaction_epoch'").run()
  assert.equal(queryMemory(db).epoch, 0)
})

test('计数与 token 求和：按 status 分组，长期记忆按行数（含 status 为 NULL 的行）', () => {
  const db = freshDb()
  insertMid(db, { id: 'm1', windowOffset: 1, tokenCount: 10, sourceScope: 'group:88888' })
  insertMid(db, { id: 'm2', windowOffset: 2, tokenCount: 20 })
  insertMid(db, { id: 'm3', windowOffset: 3, status: 'fragmented', entryType: 'fragment', tokenCount: 5 })
  insertMid(db, { id: 'm4', windowOffset: 4, status: 'archived', tokenCount: 7 })
  insertLong(db, 'L1', 'active')
  insertLong(db, 'L2', null)

  const memory = queryMemory(db)
  assert.deepEqual(memory.counts, { active: 2, fragmented: 1, archived: 1, long: 2 })
  assert.deepEqual(memory.tokens, { active: 30, fragment: 5 }, 'token 只统计 active 与 fragment')
})

test('条目按 window_offset DESC 排序；content 截断到 200；NULL content 变空串', () => {
  const db = freshDb()
  insertMid(db, { id: 'old', windowOffset: 10, content: 'x'.repeat(250), summary: '旧的' })
  insertMid(db, { id: 'new', windowOffset: 99, content: '短内容', summary: '新的' })
  insertMid(db, { id: 'frag', windowOffset: 50, status: 'fragmented', entryType: 'fragment', content: null, summary: '碎片' })

  const memory = queryMemory(db)
  assert.deepEqual(
    memory.entries.map((entry) => entry.id),
    ['new', 'frag', 'old'],
    '最近的 window_offset 在最前',
  )
  assert.equal(byId(memory.entries, 'old').contentPreview, 'x'.repeat(200))
  assert.equal(byId(memory.entries, 'frag').contentPreview, '', 'content 为 NULL ⇒ 空串（不是 null）')
  assert.equal(byId(memory.entries, 'frag').entryType, 'fragment')
  assert.equal(
    'sourceScope' in byId(memory.entries, 'new'),
    false,
    '没写来源 ⇒ 字段缺席（口径：NULL 一律省略，前端只需判断 undefined）',
  )
  assert.equal(byId(memory.entries, 'old').sourceScope, undefined, '缺席时读出来就是 undefined')
})

test('sourceScope 有值时带出来（这条是"有来源"的正向对照）', () => {
  const db = freshDb()
  insertMid(db, { id: 'from-group', windowOffset: 1, sourceScope: 'group:88888' })

  const entry = byId(queryMemory(db).entries, 'from-group')
  assert.equal(entry.sourceScope, 'group:88888')
  assert.equal('sourceScope' in entry, true)
})

test('lastAccessedAt 只在真的访问过时出现', () => {
  const db = freshDb()
  insertMid(db, { id: 'touched', windowOffset: 1, lastAccessedAt: '2026-01-03T00:00:00.000Z' })
  insertMid(db, { id: 'never', windowOffset: 2 })

  const entries = queryMemory(db).entries
  assert.equal(byId(entries, 'touched').lastAccessedAt, '2026-01-03T00:00:00.000Z')
  assert.equal('lastAccessedAt' in byId(entries, 'never'), false, '从未访问过 ⇒ 字段缺席，前端据此隐藏这一格')
})

test('截断不切出孤立代理（emoji 正好落在截断点上时少取一个码元）', () => {
  const db = freshDb()
  // 'a' + 150 个 😀：长度 301，第 200 个码元（下标 199）正好是某个 emoji 的高位代理
  const content = `a${'😀'.repeat(150)}`
  insertMid(db, { id: 'emoji', windowOffset: 1, content })

  const preview = byId(queryMemory(db).entries, 'emoji').contentPreview
  assert.ok(preview.length <= 200, '不能超过 200 个码元')
  assert.ok(preview.length < content.length, '必须真的截断了')
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(preview), '不能出现孤立高位代理（前端会显示 �）')
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview), '也不能出现孤立低位代理')
})

test('limit：默认 50、上限 500，NaN / 0 / 负数都不会把整表拖出来', () => {
  const db = freshDb()
  db.exec('BEGIN')
  for (let i = 0; i < 520; i += 1) insertMid(db, { id: `m${String(i).padStart(3, '0')}`, windowOffset: i })
  db.exec('COMMIT')

  assert.equal(queryMemory(db).entries.length, 50, '默认 50 条')
  const three = queryMemory(db, { limit: 3 })
  assert.deepEqual(
    three.entries.map((entry) => entry.windowOffset),
    [519, 518, 517],
    '取的是最新的三条',
  )
  assert.equal(three.entries.length, 3)

  // 库里此刻有 520 条：不夹紧的话这里会拿到 100000 条（也就是整表 + 全部 content）
  assert.equal(queryMemory(db, { limit: 100_000 }).entries.length, 500, 'limit 被夹到 500')

  // NaN 绑进 `LIMIT ?` 会变成 NULL ⇒ SQLite 返回整表，正是要避免的"一次请求拖垮网关"
  assert.equal(queryMemory(db, { limit: Number.NaN }).entries.length, 50, 'NaN 回落默认值，而不是返回全部')
  assert.equal(queryMemory(db, { limit: 0 }).entries.length, 1, '0 抬到 1：参数写错要能被看见')
  assert.equal(queryMemory(db, { limit: -5 }).entries.length, 1)
  assert.equal(queryMemory(db, { limit: 2.9 }).entries.length, 2, '小数向下取整')
})

// ── 压缩 ──────────────────────────────────────────────────────────────────────

test('压缩运行：按 started_at DESC；epochTo / endedAt / error 只在有值时出现', () => {
  const db = freshDb()
  insertRun(db, {
    id: 'r-old',
    phase: 'committed',
    startedAt: '2026-01-01T00:00:01.000Z',
    epochTo: 1,
    endedAt: '2026-01-01T00:00:02.000Z',
  })
  insertRun(db, { id: 'r-bad', phase: 'aborted', startedAt: '2026-01-01T00:00:03.000Z', error: '磁盘满了' })
  insertRun(db, { id: 'r-live', phase: 'started', startedAt: '2026-01-01T00:00:05.000Z' })

  const runs = queryCompaction(db).runs
  assert.deepEqual(
    runs.map((run) => run.id),
    ['r-live', 'r-bad', 'r-old'],
    '最近开始的在最前',
  )

  const live = byId(runs, 'r-live')
  assert.equal('epochTo' in live, false, '还没提交 ⇒ 没有目标 epoch（缺席，不是 0 —— epoch 0 是合法值）')
  assert.equal('endedAt' in live, false)
  assert.equal('error' in live, false)

  const bad = byId(runs, 'r-bad')
  assert.equal(bad.error, '磁盘满了')
  assert.equal('detailPreview' in bad, false, '没有 detail ⇒ 没有预览')

  const old = byId(runs, 'r-old')
  assert.equal(old.epochTo, 1)
  assert.equal(old.endedAt, '2026-01-01T00:00:02.000Z')
})

test('detail 只给 200 码元的预览（截断后的 JSON 解析不了，仅供显示）', () => {
  const db = freshDb()
  const detail = JSON.stringify({ ids: 'x'.repeat(300) })
  insertRun(db, { id: 'r-detail', phase: 'committed', startedAt: '2026-01-01T00:00:00.000Z', epochTo: 1, detail })

  const preview = byId(queryCompaction(db).runs, 'r-detail').detailPreview ?? ''
  assert.equal(preview.length, 200)
  assert.ok(preview.length < detail.length, '原文更长 ⇒ 确实截断了')
})

test('压缩日志：approved 三态、拒绝理由与模型名只在有值时出现、按 timestamp DESC', () => {
  const db = freshDb()
  insertLog(db, { id: 'l-null', timestamp: '2026-01-01T00:00:01.000Z', approved: null, requestedBy: null, shortBefore: 0, keptInShort: 0 })
  insertLog(db, {
    id: 'l-rejected',
    timestamp: '2026-01-01T00:00:02.000Z',
    requestedBy: 'model',
    approved: 0,
    reason: 'too_thin',
    shortBefore: 900,
    keptInShort: 100,
    modelUsed: 'fast',
  })
  insertLog(db, {
    id: 'l-ok',
    timestamp: '2026-01-01T00:00:03.000Z',
    requestedBy: 'system',
    approved: 1,
    shortBefore: 2000,
    keptInShort: 700,
    modelUsed: 'main',
  })

  const log = queryCompaction(db).log
  assert.deepEqual(
    log.map((row) => row.id),
    ['l-ok', 'l-rejected', 'l-null'],
    '最新的在最前',
  )

  const ok = byId(log, 'l-ok')
  assert.equal(ok.approved, true, '库里是 1 ⇒ 接口给真 boolean（模板渲染 true/false 都不会出现 1/0）')
  assert.equal(ok.modelUsed, 'main')
  assert.equal('reasonIfRejected' in ok, false, '批准的行没有拒绝理由')

  const rejected = byId(log, 'l-rejected')
  assert.equal(rejected.approved, false)
  assert.equal(rejected.reasonIfRejected, 'too_thin')

  const unknown = byId(log, 'l-null')
  assert.equal('approved' in unknown, false, '列是 NULL ⇒ 字段缺席，不能替库下"被拒绝"的结论')
  assert.equal('requestedBy' in unknown, false)
  assert.equal('modelUsed' in unknown, false)
  assert.equal(unknown.shortTokensBefore, 0, '可空列按 0 处理（契约要 number），0 是合法读数')
})

test('压缩统计：三种 phase 各自计数、lastAt 取 run/log 里更晚者、token 对比取自最新一行日志', () => {
  const db = freshDb()
  insertRun(db, { id: 'r1', phase: 'committed', startedAt: '2026-01-01T00:00:03.000Z', epochTo: 1 })
  insertRun(db, { id: 'r2', phase: 'aborted', startedAt: '2026-01-01T00:00:05.000Z', error: '超时' })
  insertRun(db, { id: 'r3', phase: 'started', startedAt: '2026-01-01T00:00:06.000Z' })
  insertRun(db, { id: 'r4', phase: 'started', startedAt: '2026-01-01T00:00:07.000Z' })

  // 日志比所有 run 都晚：lastAt 必须跟着日志走，否则面板会显示一个过期的时间
  insertLog(db, { id: 'l-old', timestamp: '2026-01-01T00:00:01.000Z', approved: 1, shortBefore: 111, keptInShort: 22 })
  insertLog(db, { id: 'l-new', timestamp: '2026-01-01T00:00:09.000Z', approved: 1, shortBefore: 2222, keptInShort: 333 })

  const stats = queryCompaction(db).stats
  assert.equal(stats.committed, 1)
  assert.equal(stats.aborted, 1)
  assert.equal(stats.started, 2, 'started > 0 是"上次压缩没收尾"的报警信号')
  assert.equal(stats.lastAt, '2026-01-01T00:00:09.000Z', 'log 比 run 晚 ⇒ 取 log 的时间')
  assert.equal(stats.tokensBefore, 2222, '最新一行日志的"压缩前"')
  assert.equal(stats.tokensAfter, 333)
})

test('压缩的 limit 同时作用于 runs 与 log：默认 30、上限 500', () => {
  const db = freshDb()
  const base = Date.UTC(2026, 0, 1)
  db.exec('BEGIN')
  // 造 520 条（超过上限）才验得出"夹紧"：只有 35 条时 500 与 10000 的结果一样，测不出东西来
  for (let i = 0; i < 520; i += 1) {
    const stamp = new Date(base + i * 1000).toISOString()
    const tag = String(i).padStart(3, '0')
    insertRun(db, { id: `r${tag}`, phase: 'committed', startedAt: stamp, epochTo: 1 })
    insertLog(db, { id: `l${tag}`, timestamp: stamp, approved: 1, shortBefore: i, keptInShort: i })
  }
  db.exec('COMMIT')

  const defaults = queryCompaction(db)
  assert.equal(defaults.runs.length, 30, '默认 30 条运行记录')
  assert.equal(defaults.log.length, 30, '默认 30 条日志')
  assert.equal(at(defaults.runs, 0).id, 'r519', '最新的在最前')
  assert.equal(at(defaults.log, 0).id, 'l519')

  const small = queryCompaction(db, { limit: 2 })
  assert.equal(small.runs.length, 2)
  assert.equal(small.log.length, 2)
  assert.equal(at(small.runs, 0).id, 'r519')

  assert.equal(queryCompaction(db, { limit: 5000 }).runs.length, 500, '上限把 5000 夹到 500（库里有 520 条）')
  assert.equal(queryCompaction(db, { limit: 5000 }).log.length, 500)
})
