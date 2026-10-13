/**
 * 归档与提升的守卫测试（PLAN 阶段 9 交付物 3）。
 *
 * ## 最值得守的四条
 *
 * 1. **归档必须能读回来且校验通过** —— 归档的用途正是"很久以后才回来读"，
 *    读不出来的归档等于没有。
 * 2. **归档只导出、不删源** —— 删源是另一个操作（要有校验），不该顺手做。
 * 3. **`recover` 只接受单个 id** —— 它是唯一允许"往热处搬"的操作；
 *    批量提升等于把沉降成果一次抹掉，而没人知道为什么。
 * 4. **提升校验不过 ⇒ 保留源、不动库** —— 与沉降同一条纪律。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { archiveEntries, listArchives, readArchive, recoverEntry } from '../src/archive.ts'
import { openDatabase } from '../src/db.ts'
import type { TierRoots } from '../src/storage-tiers.ts'

const ROOTS: TierRoots = { roots: { hot: 'D:\\hot', warm: 'D:\\warm', cold: 'D:\\cold' }, fellBack: [] }
const AT = new Date('2026-10-07T00:00:00.000Z')

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forlife-archive-'))
}

function setup(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

function addLong(opened: ReturnType<typeof openDatabase>, id: string, tier: string): void {
  opened.db
    .prepare(
      `INSERT INTO long_memory_entries (id, content, summary, entities, source_mid_ids, storage_tier, status, created_at)
       VALUES (?, ?, ?, '[]', '[]', ?, 'active', ?)`,
    )
    .run(id, `正文 ${id}`, `摘要 ${id}`, tier, AT.toISOString())
}

function addBlob(opened: ReturnType<typeof openDatabase>, id: string, tier: string): void {
  opened.db
    .prepare(
      `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
       VALUES (?, ?, 'image', 'image/png', 100, ?, ?, ?)`,
    )
    .run(id, id.padEnd(64, '0'), `D:\\${tier}\\${id}.png`, tier, AT.toISOString())
}

test('★ 归档 + **读回来校验通过**（读不出来的归档等于没有）', async () => {
  const dir = tempDir()
  const opened = setup()
  try {
    addLong(opened, 'L1', 'cold')
    addLong(opened, 'L2', 'cold')
    const r = await archiveEntries({ db: opened.db, targetDir: join(dir, 'a'), now: () => AT })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.rows, 2)

    const back = await readArchive(join(dir, 'a'))
    assert.equal(back.ok, true, back.reason)
    assert.equal(back.rows?.length, 2)
    assert.equal(back.manifest?.format, 'ndjson', '格式要写死在 manifest 里 —— 读的人不该去猜')
    assert.equal(back.manifest?.tier, 'cold')
    assert.ok((back.manifest?.columns.length ?? 0) >= 5, 'manifest 要记下列名与类型（将来转 Parquet 的依据）')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 归档**只导出、不删源**（删源是另一个操作，不该顺手做）', async () => {
  const dir = tempDir()
  const opened = setup()
  try {
    addLong(opened, 'L1', 'cold')
    await archiveEntries({ db: opened.db, targetDir: join(dir, 'a'), now: () => AT })
    const still = opened.db.prepare("SELECT COUNT(*) AS n FROM long_memory_entries WHERE id = 'L1'").get()
    assert.equal(still?.n, 1, '**源数据必须还在** —— 归档是"多一份"，不是"搬走"')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 归档被改动 ⇒ 读回时**校验失败**（坏了要能发现）', async () => {
  const dir = tempDir()
  const opened = setup()
  try {
    addLong(opened, 'L1', 'cold')
    await archiveEntries({ db: opened.db, targetDir: join(dir, 'a'), now: () => AT })
    // 篡改内容
    const p = join(dir, 'a', 'entries.ndjson')
    writeFileSync(p, readFileSync(p, 'utf8') + '{"id":"injected"}\n')
    const back = await readArchive(join(dir, 'a'))
    assert.equal(back.ok, false)
    assert.match(back.reason, /校验不符/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('那一层没有条目 ⇒ **不是失败**（没有东西可归档）', async () => {
  const dir = tempDir()
  const opened = setup()
  try {
    const r = await archiveEntries({ db: opened.db, targetDir: join(dir, 'a'), now: () => AT })
    assert.equal(r.ok, true)
    assert.equal(r.rows, 0)
    assert.match(r.reason, /没有可归档/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ recover：冷层 → 热层，并更新库', async () => {
  const opened = setup()
  try {
    addBlob(opened, 'B1', 'cold')
    const r = await recoverEntry({
      db: opened.db,
      id: 'B1',
      roots: ROOTS,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      now: () => AT,
    })
    assert.equal(r.ok, true, r.reason)
    const row = opened.db.prepare("SELECT storage_tier, storage_path, settled_at FROM media_assets WHERE id = 'B1'").get()
    assert.equal(row?.storage_tier, 'hot')
    assert.ok(String(row?.storage_path).includes('hot'), '路径要更新到热层')
    assert.equal(row?.settled_at, null, '提升后 settled_at 要清空（它不再是"已沉降"状态）')
  } finally {
    opened.db.close()
  }
})

test('★ recover 校验失败 ⇒ **保留源、不动库**', async () => {
  const opened = setup()
  try {
    addBlob(opened, 'B1', 'cold')
    const r = await recoverEntry({
      db: opened.db,
      id: 'B1',
      roots: ROOTS,
      moveFile: async () => ({ ok: false, reason: '校验不符，已保留源文件' }),
      now: () => AT,
    })
    assert.equal(r.ok, false)
    const row = opened.db.prepare("SELECT storage_tier FROM media_assets WHERE id = 'B1'").get()
    assert.equal(row?.storage_tier, 'cold', '**失败绝不能改库**')
  } finally {
    opened.db.close()
  }
})

test('★ recover 已经在热层 ⇒ 明确说清，而不是"成功"', async () => {
  const opened = setup()
  try {
    addBlob(opened, 'B1', 'hot')
    const r = await recoverEntry({ db: opened.db, id: 'B1', roots: ROOTS, moveFile: async () => ({ ok: true, reason: 'ok' }) })
    assert.equal(r.ok, false)
    assert.match(r.reason, /已经在热层/)
    // **不能报成功** —— 那会让人以为真的搬过
  } finally {
    opened.db.close()
  }
})

test('recover 不存在的 id ⇒ 明确说"没有这条"', async () => {
  const opened = setup()
  try {
    const r = await recoverEntry({ db: opened.db, id: 'nope', roots: ROOTS, moveFile: async () => ({ ok: true, reason: 'ok' }) })
    assert.equal(r.ok, false)
    assert.match(r.reason, /没有这条 blob/)
  } finally {
    opened.db.close()
  }
})

test('★ listArchives：列出归档；坏目录**跳过而不是编造 0 条**', async () => {
  const dir = tempDir()
  const opened = setup()
  try {
    addLong(opened, 'L1', 'cold')
    await archiveEntries({ db: opened.db, targetDir: join(dir, 'good'), now: () => AT })
    // 造一个坏目录（有目录名但 manifest 坏了）
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'broken'), { recursive: true })
    writeFileSync(join(dir, 'broken', 'manifest.json'), 'not json')

    const list = await listArchives(dir)
    assert.equal(list.length, 1, '坏目录要被跳过')
    assert.equal(list[0]?.name, 'good')
    assert.equal(list[0]?.rows, 1)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不存在 ⇒ 返回空列表，不是报错', async () => {
  const list = await listArchives('D:\\definitely\\not\\here')
  assert.deepEqual(list, [])
})
