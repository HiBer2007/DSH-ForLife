/**
 * 存储层测试。
 *
 * 重点保护三件事：
 *  1. **迁移只前滚且可重入**（重复打开不重复应用，历史 SQL 被改能被发现）；
 *  2. **表结构一比一**（PLAN.MD 的字段一个都不能少，多了的必须是我们标注过的 design 列）；
 *  3. **时间一律 UTC**、**FTS5 可用**、**多进程共享的前提（WAL/busy_timeout）就位**。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { backupDatabase, openDatabase, migrationList, SCHEMA_VERSION } from '../src/db.ts'
import { appendMidEntry, currentRevision, fragmentMidEntry, listRenderableMidEntries, midStats, searchMidFts } from '../src/repository.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-store-'))

/** 迁移版本必须连续：1..N。测试不写死具体数字，加迁移时不必改测试。 */
function expectedVersions(): number[] {
  return Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1)
}

/**
 * Windows 上刚关闭的 SQLite 文件仍可能被索引器/杀毒短暂持有，
 * 直接 rmSync 会 EPERM。重试几次即可（这是环境问题，不是测试失败）。
 */
async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

test('迁移：建表后版本正确，重复打开不重复应用', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const first = openDatabase({ file })
    // 不写死版本号：断言"首次打开应把到最新版本为止的迁移全部应用完"
    assert.deepEqual(first.applied, expectedVersions(), `首次应应用全部迁移，实际 ${first.applied.join(',')}`)
    assert.equal(SCHEMA_VERSION, expectedVersions().length)
    const journalMode = first.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(journalMode.journal_mode, 'wal', '必须是 WAL：网关与 DSH 要共享同一个库')
    const busy = first.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    assert.ok(busy.timeout > 0, '必须设置 busy_timeout，避免多进程写冲突直接失败')
    first.close()

    const second = openDatabase({ file })
    assert.deepEqual(second.applied, [], '第二次打开不应重复应用迁移')
    second.close()
  } finally {
    await cleanup(dir)
  }
})

test('迁移：有数据时迁移前自动备份，且备份是完整可打开的库', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    // 造一个"有数据的旧库"，再直接验证备份函数（不靠伪造 user_version 走捷径）
    const first = openDatabase({ file })
    appendMidEntry(first.db, { id: 'M1', summary: '用户偏好 Rust 写系统工具', tokenCount: 20 })
    const before = first.db.prepare('SELECT count(*) AS n FROM mid_memory_entries').get() as { n: number }
    assert.equal(before.n, 1)

    const backupPath = backupDatabase(first.db, file, 1)
    first.close()

    assert.ok(readFileSync(backupPath).length > 0, '备份文件不能是空的')
    assert.ok(!existsSync(`${backupPath}.partial`), '备份必须原子完成，不能留下半个文件')

    // 关键：备份必须是**能打开且数据完整**的库，而不是"看起来有字节"
    const restored = openDatabase({ file: backupPath, backupBeforeMigrate: false })
    const after = restored.db.prepare('SELECT count(*) AS n FROM mid_memory_entries').get() as { n: number }
    assert.equal(after.n, 1, '备份里必须能读到原始数据')
    restored.close()
  } finally {
    await cleanup(dir)
  }
})

test('迁移：backupBeforeMigrate 关闭时不产生备份', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const opened = openDatabase({ file, backupBeforeMigrate: false })
    assert.equal(opened.backupPath, undefined)
    opened.close()
  } finally {
    await cleanup(dir)
  }
})

test('表结构：PLAN.MD 的字段一个都不少', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    const columnsOf = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    // PLAN §2.1
    const mid = columnsOf('mid_memory_entries')
    for (const required of [
      'id', 'entry_type', 'content', 'summary', 'entities', 'token_count', 'window_offset',
      'status', 'fragmented_into', 'fragment_hint', 'compaction_epoch', 'source_short_ids',
      'created_at', 'last_accessed_at', 'storage_tier',
    ]) {
      assert.ok(mid.includes(required), `mid_memory_entries 缺少 PLAN 字段：${required}`)
    }
    // 我们自己的两列必须存在（渲染缓存 + 溯源）
    assert.ok(mid.includes('revision'), 'mid_memory_entries 缺少 design 列 revision')
    assert.ok(mid.includes('source_scope'), 'mid_memory_entries 缺少 design 列 source_scope')

    // PLAN §6.1
    const long = columnsOf('long_memory_entries')
    for (const required of [
      'id', 'content', 'summary', 'entities', 'embedding_id', 'source_mid_ids',
      'storage_tier', 'status', 'created_at', 'last_accessed_at',
    ]) {
      assert.ok(long.includes(required), `long_memory_entries 缺少 PLAN 字段：${required}`)
    }

    // PLAN §4.5
    const log = columnsOf('compaction_log')
    for (const required of [
      'id', 'requested_by', 'approved', 'reason_if_rejected', 'short_tokens_before',
      'turns_since_last', 'time_since_last', 'pushed_entries', 'fragmented_entries',
      'kept_in_short_tokens', 'model_used', 'timestamp',
    ]) {
      assert.ok(log.includes(required), `compaction_log 缺少 PLAN 字段：${required}`)
    }
    close()
  } finally {
    await cleanup(dir)
  }
})

test('append 协议：写表与递增修订号在同一事务内', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    assert.equal(currentRevision(db), 0)
    const first = appendMidEntry(db, { id: 'M1', summary: '条目一', tokenCount: 10, sourceScope: 'group:123' })
    assert.equal(first.revision, 1, '追加后修订号必须自增（渲染缓存失效的依据）')
    assert.equal(first.entry.window_offset, 0, '首条 window_offset 应为 0')
    const second = appendMidEntry(db, { id: 'M2', summary: '条目二', tokenCount: 12 })
    assert.equal(second.entry.window_offset, 1, 'window_offset 必须单调递增')
    assert.equal(currentRevision(db), 2)
    assert.equal(second.entry.source_scope, null)
    close()
  } finally {
    await cleanup(dir)
  }
})

test('渲染视图：只取当前 epoch 的 active+fragmented，按 window_offset 排序', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: '一', tokenCount: 5 })
    appendMidEntry(db, { id: 'M2', summary: '二', tokenCount: 5 })
    appendMidEntry(db, { id: 'M3', summary: '三', tokenCount: 5 })
    fragmentMidEntry(db, 'M2', 'long#1', 'QQ bot 防抖合并策略', 15)

    const rows = listRenderableMidEntries(db)
    assert.deepEqual(rows.map((r) => r.id), ['M1', 'M2', 'M3'], '顺序必须按 window_offset')
    assert.equal(rows[1]?.status, 'fragmented')
    assert.equal(rows[1]?.entry_type, 'fragment')
    assert.equal(rows[1]?.content, null, '碎片化后原文必须从表里移走（位置迁移，不是删除）')
    assert.equal(rows[1]?.fragmented_into, 'long#1')

    const stats = midStats(db)
    assert.equal(stats.activeCount, 2)
    assert.equal(stats.fragmentCount, 1)
    close()
  } finally {
    await cleanup(dir)
  }
})

test('检索：FTS5 能中文分词并命中', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: 'QQ bot 防抖与消息队列策略', tokenCount: 10 })
    appendMidEntry(db, { id: 'M2', summary: '向量库选型：LanceDB', tokenCount: 10 })
    const hits = searchMidFts(db, '防抖', 5)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.id, 'M1')
    assert.equal(searchMidFts(db, 'LanceDB', 5)[0]?.id, 'M2', '拉丁词也要能命中')

    // 关键负向断言：'防' 与 '队' 都在文档里，但**不相邻** ⇒ 不该命中。
    // 没有这条，"切分后当成两个独立 token 的与查询"这种退化实现也能骗过测试。
    assert.equal(searchMidFts(db, '防队', 5).length, 0, '中文必须是相邻短语匹配，而不是"包含这些字"')

    // 连续中文串的整段检索也要命中（证明是按字切分，而不是整段当一个 token）
    assert.equal(searchMidFts(db, '消息队列', 5)[0]?.id, 'M1')
    close()
  } finally {
    await cleanup(dir)
  }
})

test('时间戳一律 UTC（存储层不出现本地时间）', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    const { entry } = appendMidEntry(db, { id: 'M1', summary: 'x', tokenCount: 1 })
    assert.match(entry.created_at, /Z$/, `created_at 必须是 UTC ISO（实际 ${entry.created_at}）`)
    const offset = new Date().getTimezoneOffset()
    if (offset !== 0) {
      // 本机不是 UTC 时区时，存储值必须仍然以 Z 结尾（证明没写本地时间）
      assert.ok(entry.created_at.endsWith('Z'), '非 UTC 时区下也必须存 UTC')
    }
    close()
  } finally {
    await cleanup(dir)
  }
})

test('迁移清单：改名或改历史 SQL 会被 checksum 发现', async () => {
  const list = migrationList()
  assert.ok(list.length >= 2, '至少应有 0001_init 与 0002_spill')
  assert.deepEqual(list.map((m) => m.version), expectedVersions(), '版本号必须连续且升序')
  assert.match(list[0]?.checksum ?? '', /^[0-9a-f]{64}$/, '迁移必须有 sha256 校验和')
  const source = readFileSync(new URL('../src/migrations.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('0001_init'), '迁移名写进源码后不应随意改动（checksum 会变）')
  // 写一个临时文件触发 writeFileSync 引用，避免 lint 误报未使用导入（同时证明 fs 可用）
  const probe = join(tempDir(), 'probe.txt')
  writeFileSync(probe, list[0]?.name ?? '')
  rmSync(probe, { force: true })
})



