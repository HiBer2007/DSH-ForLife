/**
 * 验收：**备份 → 销毁 → 恢复演练**（PLAN 阶段 11 未勾项之一）。
 *
 * ## 为什么这条最该做
 *
 * 我做了备份模块（`backup.ts`），验了"备份文件**看起来**是好的"
 * （回读、integrity_check、schema 版本、表数）。
 * 但**"备份是好的"与"备份能恢复"是两件事** ——
 * 而验收标准写的是「备份→销毁→恢复**演练成功**」。
 *
 * **不真做一次恢复演练，就永远不知道恢复这条路通不通。**
 * 这正是备份最危险的失败模式：**做成了但恢复不了**，
 * 等到真要用的时候才发现（`backup.ts` 模块头写的就是这条）。
 *
 * ## 演练怎么做（**真删、真恢复**）
 *
 * 全程在**临时目录**里，**绝不碰真库**：
 *  1. 建一个"源"库，写进可辨认的数据（含 blob 文件）；
 *  2. `runBackup` 备份它；
 *  3. **销毁**源库与源 blob（真删）；
 *  4. 从备份**恢复**出来；
 *  5. **逐项核对**：schema 版本、行数、**具体那几行数据**、blob 的 sha256。
 *
 * ## 一条纪律：**核对要比"表存在"更细**
 *
 * "恢复后表还在"证明不了什么 —— **空表也在**。
 * 所以核对的是**具体那几行**（`forlife_state` 里我写进去的那个值）。
 *
 * 用法：
 * ```
 * $env:DSH_HOME='D:\DSH-ForLife\.runtime\dsh'
 * node packages/store/scripts/drill-backup-restore.mjs
 * ```
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { runBackup, verifyBackup } from '../src/backup.ts'
import { openDatabase } from '../src/db.ts'

let passed = 0
let failed = 0
// ★ **必须 await 回调** —— 不 await 的话，异步断言会**逃逸到清理之后**才跑，
// 于是它看到的是"备份已被删掉"的世界，报一条**看起来像 bug 的假错误**。
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`   ✗ ${name}\n     ${String(error).slice(0, 220)}`)
  }
}

const base = mkdtempSync(join(tmpdir(), 'forlife-drill-'))
const srcDir = join(base, 'src')
const srcDbPath = join(srcDir, 'forlife.sqlite')
const blobRoot = join(srcDir, 'stickers')
const backupDir = join(base, 'backups')
mkdirSync(blobRoot, { recursive: true })

/** 写进源库的**可辨认数据**（恢复后要逐项核对的就是它）。 */
const MARKER_KEY = 'drill.marker'
const MARKER_VALUE = 'drill-2026-10-07-必须一模一样地回来'

console.log('\n【1】建"源"库并写进可辨认的数据')

const opened = openDatabase({ file: srcDbPath })
opened.db
  .prepare('INSERT INTO forlife_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  .run(MARKER_KEY, MARKER_VALUE)
// 再造几条不同表的数据（**只核对一张表的话，恢复漏了别的表也看不出来**）
opened.db
  .prepare(
    `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
     VALUES ('drill-blob-1', ?, 'image', 'image/png', 12, ?, 'hot', ?)`,
  )
  .run('a'.repeat(64), join(blobRoot, 'drill.png'), new Date().toISOString())
const srcRows = {
  state: opened.db.prepare('SELECT COUNT(*) AS n FROM forlife_state').get()?.n,
  media: opened.db.prepare('SELECT COUNT(*) AS n FROM media_assets').get()?.n,
  migrations: opened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v,
}
opened.db.close()

const blobContent = 'drill-blob-bytes'
writeFileSync(join(blobRoot, 'drill.png'), blobContent, 'utf8')
const blobSha = createHash('sha256').update(blobContent).digest('hex')

await check('源库建好了（有可辨认的数据）', () => {
  assert.ok(Number(srcRows.state) > 0, '要有 state 行')
  assert.ok(Number(srcRows.migrations) > 0, '要有 schema 版本')
})

console.log('\n【2】备份它')

// **句柄要留着并关掉** —— 备份会开一个连接，
// 用完不关的话源文件在 Windows 上**删不掉**（EPERM）。
const forBackup = openDatabase({ file: srcDbPath })
let backup
try {
  backup = await runBackup({ db: forBackup.db, dbPath: srcDbPath, targetDir: backupDir, blobRoot })
} finally {
  forBackup.db.close()
}
await check('备份成功且**回读验证通过**', () => {
  assert.equal(backup.ok, true, backup.reason)
  assert.equal(backup.verified?.integrity, 'ok')
  assert.equal(backup.blobsCopied, 1, 'blob 要拷过去')
})
const backupDbPath = String(backup.dbPath)
const backupBlobPath = join(String(backupDbPath).replace(/forlife\.sqlite$/, ''), 'blobs', 'drill.png')

await check('备份文件真的在盘上', () => {
  assert.ok(existsSync(backupDbPath), `库备份不存在：${backupDbPath}`)
  assert.ok(existsSync(backupBlobPath), `blob 备份不存在：${backupBlobPath}`)
})

console.log('\n【3】★ **销毁**源库与源 blob（真删）')

rmSync(srcDbPath, { force: true })
rmSync(`${srcDbPath}-wal`, { force: true })
rmSync(`${srcDbPath}-shm`, { force: true })
rmSync(blobRoot, { recursive: true, force: true })

await check('源真的没了', () => {
  assert.equal(existsSync(srcDbPath), false, '源库必须真的删掉')
  assert.equal(existsSync(blobRoot), false, '源 blob 必须真的删掉')
})

console.log('\n【4】从备份**恢复**')

// 恢复 = 把备份文件放回原位置（**这是演练里唯一"手工"的一步**，
// 也正因为它是手工的，才必须演练 —— 手工步骤最容易漏）
mkdirSync(srcDir, { recursive: true })
writeFileSync(srcDbPath, readFileSync(backupDbPath))
mkdirSync(blobRoot, { recursive: true })
writeFileSync(join(blobRoot, 'drill.png'), readFileSync(backupBlobPath))

await check('恢复前先**验证备份可用**（而不是恢复完才发现不行）', async () => {
  const v = await verifyBackup(backupDbPath)
  assert.equal(v.ok, true, v.reason)
})

console.log('\n【5】★ 逐项核对（**比"表存在"更细**）')

const restored = new DatabaseSync(srcDbPath, { readOnly: true })
try {
  await check('schema 版本一致', () => {
    const v = restored.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v
    assert.equal(v, srcRows.migrations, `schema 版本不一致：${String(v)} vs ${String(srcRows.migrations)}`)
  })
  await check('★ **那几行数据一模一样地回来了**（空表也在，所以不能只看表存在）', () => {
    const row = restored.prepare('SELECT value FROM forlife_state WHERE key = ?').get(MARKER_KEY)
    assert.equal(row?.value, MARKER_VALUE, `标记值不一致：${String(row?.value)}`)
  })
  await check('别的表也回来了（只核对一张表的话，漏了别的表看不出来）', () => {
    const n = restored.prepare('SELECT COUNT(*) AS n FROM media_assets').get()?.n
    assert.equal(n, srcRows.media, `media_assets 行数不一致：${String(n)} vs ${String(srcRows.media)}`)
  })
  await check('完整性检查通过', () => {
    const r = restored.prepare('PRAGMA integrity_check').get()
    assert.equal(r?.integrity_check, 'ok')
  })
} finally {
  restored.close()
}

await check('★ blob 内容**逐字节一致**（sha256）', () => {
  const got = createHash('sha256').update(readFileSync(join(blobRoot, 'drill.png'))).digest('hex')
  assert.equal(got, blobSha, 'blob 内容变了')
})

rmSync(base, { recursive: true, force: true })

console.log(`\n${'─'.repeat(58)}`)
console.log(`  备份→销毁→恢复演练：**${String(passed)} 通过 / ${String(failed)} 失败**`)
console.log(`${'─'.repeat(58)}\n`)
if (failed > 0) process.exitCode = 1
