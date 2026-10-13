/**
 * 归档与提升的**端到端**（真服务、真 HTTP、真 cookie、**真文件**）。
 *
 * ## 为什么必须有这一层
 *
 * 与迁移那个 e2e 同理：库层测试（`archive.test.ts` 10/10）**证明不了"点了按钮真的做了"**。
 * 归档/提升这一路尤其要看两件事，而它们**只有真 HTTP + 真文件才验得了**：
 *
 * 1. **目录守卫真的挡住了绝对路径与 `..`** ——
 *    库层测的是"函数被调用后做了什么"，而守卫在**路由层**；
 * 2. **`recover` 真的把文件从冷层搬到热层**，而且**校验不过时源还在**。
 *
 * ## 它验什么
 *
 * - 没配 `FORLIFE_ARCHIVE_DIR` ⇒ `/archive` 明确 400（**不是悄悄写到一个默认位置**）；
 * - 配了之后 `/archive` 真的导出，`/archives` 真的列出来；
 * - `/recover` **没有 id ⇒ 400**（提升是逐个的）；
 * - `/recover` **真的搬文件**并更新库；
 * - **路径守卫**：绝对路径 / `..` 都被拒。
 *
 * 用法：
 * ```
 * $env:DSH_HOME='D:\DSH-ForLife\.runtime\dsh'
 * node packages/gateway/scripts/e2e-archive-api.ts
 * ```
 *
 * @module @forlife/gateway/scripts/e2e-archive-api
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '@forlife/store'

import { createAdminServer } from '../src/server.ts'

const PASSWORD = 'e2e-password-一次性'

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'forlife-e2e-archive-'))
  const staticRoot = join(base, 'dist')
  const dbPath = join(base, 'admin.sqlite')
  const hotRoot = join(base, 'hot')
  const coldRoot = join(base, 'cold')
  const archiveRoot = join(base, 'archives')
  mkdirSync(staticRoot, { recursive: true })
  mkdirSync(hotRoot, { recursive: true })
  mkdirSync(coldRoot, { recursive: true })
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  writeFileSync(join(staticRoot, 'theme-init.js'), 'void 0', 'utf8')

  let passed = 0
  let failed = 0
  const check = (name: string, fn: () => void): void => {
    try {
      fn()
      passed += 1
      console.log(`   ✓ ${name}`)
    } catch (error) {
      failed += 1
      console.log(`   ✗ ${name}\n     ${String(error).slice(0, 200)}`)
    }
  }

  process.env['FORLIFE_ROOT_HOT'] = hotRoot
  process.env['FORLIFE_ROOT_WARM'] = coldRoot
  process.env['FORLIFE_ROOT_COLD'] = coldRoot

  // 造数据：一条**已在冷层**的 blob（用来验 recover）+ 一条**已沉降的长期记忆**（用来验归档）
  const opened = openDatabase({ file: dbPath })
  const content = 'cold-blob-content'
  const sha = createHash('sha256').update(content).digest('hex')
  const coldPath = join(coldRoot, 'c1.bin')
  writeFileSync(coldPath, content, 'utf8')
  opened.db
    .prepare(
      `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
       VALUES ('cold-1', ?, 'image', 'application/octet-stream', ?, ?, 'cold', ?)`,
    )
    .run(sha, content.length, coldPath, new Date().toISOString())
  opened.db
    .prepare(
      `INSERT INTO long_memory_entries (id, content, summary, entities, source_mid_ids, storage_tier, status, created_at)
       VALUES ('L1', '长期记忆正文', '摘要', '[]', '[]', 'cold', 'active', ?)`,
    )
    .run(new Date().toISOString())
  opened.db.close()

  const running = await createAdminServer({ dbPath, distRoot: staticRoot, host: '127.0.0.1', port: 0, sessionTtlMs: 120_000 }).start()
  const origin = `http://127.0.0.1:${String(running.port)}`
  let cookie = ''

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = { origin, 'content-type': 'application/json' }
    if (cookie !== '') headers['cookie'] = cookie
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookie = response.headers.getSetCookie()[0]
    if (setCookie !== undefined) cookie = setCookie.split(';')[0] ?? ''
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    return { status: response.status, body: parsed }
  }

  const db = (): ReturnType<typeof openDatabase>['db'] => openDatabase({ file: dbPath }).db

  try {
    console.log('\n【1】登录')
    const setup = await call('POST', '/api/admin/setup', { password: PASSWORD })
    check('设置口令成功', () => assert.equal(setup.status, 200))

    console.log('\n【2】★ 没配 FORLIFE_ARCHIVE_DIR ⇒ 明确 400（不是悄悄写到某个默认位置）')
    delete process.env['FORLIFE_ARCHIVE_DIR']
    const noCfg = await call('POST', '/api/admin/archive', { tier: 'cold' })
    check('/archive 明确拒绝并说清原因', () => {
      assert.equal(noCfg.status, 400, JSON.stringify(noCfg.body))
      assert.match(String((noCfg.body as { error: string }).error), /FORLIFE_ARCHIVE_DIR/)
    })
    const listNoCfg = await call('GET', '/api/admin/archives')
    check('/archives 报 configured:false（而不是一个假的空列表）', () => {
      const b = listNoCfg.body as { configured: boolean; note?: string }
      assert.equal(b.configured, false)
      assert.match(String(b.note), /FORLIFE_ARCHIVE_DIR/)
    })

    console.log('\n【3】配了之后：归档真的导出，列表真的能看到')
    process.env['FORLIFE_ARCHIVE_DIR'] = archiveRoot
    const arch = await call('POST', '/api/admin/archive', { tier: 'cold' })
    check('导出成功且报了条数', () => {
      assert.equal(arch.status, 200, JSON.stringify(arch.body))
      const b = arch.body as { ok: boolean; rows: number; dir?: string }
      assert.equal(b.ok, true)
      assert.equal(b.rows, 1)
      assert.ok(b.dir !== undefined && existsSync(join(b.dir, 'manifest.json')), 'manifest 要真的写到盘上')
    })
    const list = await call('GET', '/api/admin/archives')
    check('列表里能看到它', () => {
      const b = list.body as { configured: boolean; archives: { rows: number }[] }
      assert.equal(b.configured, true)
      assert.equal(b.archives.length, 1)
      assert.equal(b.archives[0]?.rows, 1)
    })

    console.log('\n【4】参数守卫')
    const badTier = await call('POST', '/api/admin/archive', { tier: 'nope' })
    check('非法 tier ⇒ 400', () => assert.equal(badTier.status, 400))
    const noId = await call('POST', '/api/admin/recover', {})
    check('★ /recover 没有 id ⇒ 400（提升是逐个的）', () => {
      assert.equal(noId.status, 400)
      assert.match(String((noId.body as { error: string }).error), /逐个/)
    })
    const traversal = await call('POST', '/api/admin/backup-verify', { path: '../../../etc/passwd' })
    check('★ 路径守卫：`..` 被拒', () => {
      assert.equal(traversal.status, 400)
    })
    const absolute = await call('POST', '/api/admin/backup-verify', { path: 'C:\\Windows\\system32\\x' })
    check('★ 路径守卫：绝对路径被拒', () => {
      assert.equal(absolute.status, 400)
    })

    console.log('\n【5】★ /recover **真的把文件从冷层搬到热层**')
    const rec = await call('POST', '/api/admin/recover', { id: 'cold-1' })
    check('提升成功', () => {
      assert.equal(rec.status, 200, JSON.stringify(rec.body))
      assert.equal((rec.body as { ok: boolean }).ok, true)
    })
    check('库里的 tier 与路径都到热层了', () => {
      const d = db()
      const row = d.prepare("SELECT storage_tier, storage_path, settled_at FROM media_assets WHERE id = 'cold-1'").get()
      d.close()
      assert.equal(row?.storage_tier, 'hot')
      assert.ok(String(row?.storage_path).startsWith(hotRoot), '路径要在热层根下')
      assert.equal(row?.settled_at, null, '提升后 settled_at 要清空')
    })
    check('★ 文件**真的搬过去了**（不是只改了库）', () => {
      const d = db()
      const row = d.prepare("SELECT storage_path FROM media_assets WHERE id = 'cold-1'").get()
      d.close()
      assert.ok(existsSync(String(row?.storage_path)), `热层文件必须真的存在：${String(row?.storage_path)}`)
    })
    const again = await call('POST', '/api/admin/recover', { id: 'cold-1' })
    check('★ 已在热层 ⇒ 明确说"不需要提升"，不报成功', () => {
      assert.equal(again.status, 400)
      assert.match(String((again.body as { reason: string }).reason), /已经在热层/)
    })

    console.log('\n【6】写操作都落审计')
    check('审计里有归档/提升记录', () => {
      const d = db()
      const n = d.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE detail LIKE '%归档%' OR detail LIKE '%提升%'").get()
      d.close()
      assert.ok(Number(n?.n) >= 2, `至少 2 条，实际 ${String(n?.n)}`)
    })
  } finally {
    await running.close()
    rmSync(base, { recursive: true, force: true })
  }

  console.log(`\n${'─'.repeat(58)}`)
  console.log(`  归档/提升 API 端到端：**${String(passed)} 通过 / ${String(failed)} 失败**`)
  console.log(`${'─'.repeat(58)}\n`)
  if (failed > 0) process.exitCode = 1
}

await main()
