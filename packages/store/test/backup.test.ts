/**
 * 备份的守卫测试（PLAN 阶段 9 交付物 7）。
 *
 * ## 最值得守的四条
 *
 * 1. **备份必须能被回读验证** —— "做成了但恢复不了"是备份最危险的失败模式
 *    （等到真要用时才发现）。
 * 2. **验证不过要删掉那个备份文件** —— 留一个"看起来有、其实不能用"的备份
 *    **比没有更危险**：人会以为有退路。
 * 3. **blob 增量按内容判断**，不是按存在与否 —— 同名不同内容必须重拷。
 * 4. **拷完立刻校验** —— 校验不过不算成功。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { backupBlobs, backupDatabaseVerified, runBackup, stampFor, verifyBackup } from '../src/backup.ts'
import { openDatabase } from '../src/db.ts'

/** 造一个临时目录。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forlife-backup-'))
}

test('stampFor：冒号要换掉（Windows 文件名里非法）', () => {
  const s = stampFor(new Date('2026-10-07T03:12:20.000Z'))
  assert.ok(!s.includes(':'), `不能有冒号：${s}`)
  assert.ok(!s.includes('.'), `不能有点：${s}`)
  assert.match(s, /^2026-10-07T03-12-20/)
})

test('★ 库备份 + **回读验证**（做成了但恢复不了才是最危险的）', async () => {
  const dir = tempDir()
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db.exec("INSERT INTO forlife_state (key, value) VALUES ('probe', 'hello')")
    const target = join(dir, 'backup.sqlite')
    const r = await backupDatabaseVerified({ db: opened.db, targetPath: target })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.verified?.integrity, 'ok')
    assert.ok(Number(r.verified?.schemaVersion) > 0, '要能读到 schema 版本')
    assert.ok(Number(r.verified?.tables) > 10, '要能数出表')
    assert.ok(Number(r.bytes) > 0)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 备份里有**真实数据**（不只是空壳）', async () => {
  const dir = tempDir()
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db.exec("INSERT INTO forlife_state (key, value) VALUES ('probe', 'hello')")
    const target = join(dir, 'b.sqlite')
    await backupDatabaseVerified({ db: opened.db, targetPath: target })
    const v = await verifyBackup(target)
    assert.equal(v.ok, true, v.reason)

    // 直接打开备份，确认那行数据在
    const { DatabaseSync } = await import('node:sqlite')
    const probe = new DatabaseSync(target, { readOnly: true })
    const row = probe.prepare("SELECT value FROM forlife_state WHERE key = 'probe'").get()
    probe.close()
    assert.equal(row?.value, 'hello', '备份里必须有真实数据')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 验证一个不是我们库的文件 ⇒ 明确说"不是我们的库"', async () => {
  const dir = tempDir()
  try {
    const bogus = join(dir, 'bogus.sqlite')
    writeFileSync(bogus, 'not a database at all')
    const v = await verifyBackup(bogus)
    assert.equal(v.ok, false)
    assert.match(v.reason, /打不开|不是我们的库/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 目标已存在时也能备份（`VACUUM INTO` 要求目标不存在 —— 要先删残留）', async () => {
  const dir = tempDir()
  const opened = openDatabase({ file: ':memory:' })
  try {
    const target = join(dir, 'b.sqlite')
    writeFileSync(target, 'stale garbage')
    const r = await backupDatabaseVerified({ db: opened.db, targetPath: target })
    assert.equal(r.ok, true, `已有残留时应当先删再备份：${r.reason}`)
    const v = await verifyBackup(target)
    assert.equal(v.ok, true)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ blob 增量：第一次全拷、第二次**全跳过**', async () => {
  const dir = tempDir()
  try {
    const src = join(dir, 'src')
    const dst = join(dir, 'dst')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.png'), 'aaa')
    writeFileSync(join(src, 'b.png'), 'bbb')

    const first = await backupBlobs({ sourceRoot: src, targetRoot: dst })
    assert.equal(first.copied, 2)
    assert.equal(first.skipped, 0)

    const second = await backupBlobs({ sourceRoot: src, targetRoot: dst })
    assert.equal(second.copied, 0, '第二次不该重拷')
    assert.equal(second.skipped, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ blob 增量：**同名不同内容必须重拷**（按内容判断，不是按存在与否）', async () => {
  const dir = tempDir()
  try {
    const src = join(dir, 'src')
    const dst = join(dir, 'dst')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'x.png'), 'v1')
    await backupBlobs({ sourceRoot: src, targetRoot: dst })

    // 源文件换了内容（同名）
    writeFileSync(join(src, 'x.png'), 'v2-different')
    const again = await backupBlobs({ sourceRoot: src, targetRoot: dst })
    assert.equal(again.copied, 1, '同名不同内容必须重拷')
    assert.equal(readFileSync(join(dst, 'x.png'), 'utf8'), 'v2-different', '目标要被更新')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源目录不存在 ⇒ 不是失败（没有 blob 可备份）', async () => {
  const dir = tempDir()
  try {
    const r = await backupBlobs({ sourceRoot: join(dir, 'nope'), targetRoot: join(dir, 'dst') })
    assert.equal(r.copied, 0)
    assert.equal(r.failures.length, 0, '源不存在不该记成失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 一次完整备份：库 + blob，且都验证过', async () => {
  const dir = tempDir()
  const opened = openDatabase({ file: ':memory:' })
  try {
    const blobRoot = join(dir, 'blobs-src')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(blobRoot, { recursive: true })
    writeFileSync(join(blobRoot, 's1.png'), 'sticker-one')

    const r = await runBackup({
      db: opened.db,
      dbPath: ':memory:',
      targetDir: join(dir, 'backups'),
      blobRoot,
      now: () => new Date('2026-10-07T03:12:20.000Z'),
    })
    assert.equal(r.ok, true, r.reason)
    assert.ok(r.dbPath !== undefined)
    assert.equal(r.verified?.integrity, 'ok')
    assert.equal(r.blobsCopied, 1)

    // 备份出来的库要能被验证
    const v = await verifyBackup(r.dbPath)
    assert.equal(v.ok, true, v.reason)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 库备份失败 ⇒ **整个备份算失败**（blob 单独有备份没意义：没有索引指向它们）', async () => {
  const dir = tempDir()
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db.close() // 关掉 ⇒ VACUUM INTO 会失败
    const r = await runBackup({
      db: opened.db,
      dbPath: ':memory:',
      targetDir: join(dir, 'backups'),
      blobRoot: join(dir, 'blobs'),
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /库备份失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
