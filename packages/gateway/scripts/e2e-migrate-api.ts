/**
 * 迁移 API 的**端到端**（真服务、真 HTTP、真 cookie、**真文件**）。
 *
 * ## 为什么必须有这一层
 *
 * 库层面的测试（`migration.test.ts` 13/13）**证明不了"点了按钮真的搬了"** ——
 * 中间还隔着：路由是否注册、同源校验是否放行、cookie 是否带上、
 * **参数名是否对得上**、以及**搬迁实现真的碰磁盘时会不会挂**。
 *
 * 我这几轮反复出现同一个模式：库层测得很细，而接线只验到"路由存在（401）"。
 * **"路由存在"与"点了能用"是两件事** —— 这个 goal 里已经踩过两次接线 bug
 * （`whitelist` 参数被丢、`onConnectionState` 被构造函数丢掉），**两次都是单测全绿**。
 *
 * ## 它验什么
 *
 * - `POST /migrate-start` 真的建 run 并取锁；
 * - `GET /migrate-status` 能看到它（**包括锁** —— 有锁时 core 会拒绝写入，
 *   面板上看不到锁的话用户会以为"沉降坏了"）；
 * - `POST /migrate-resume` 真的**搬文件 + 校验 + 切换引用 + 收尾**；
 * - `POST /migrate-rollback` 真的**把引用切回旧根**；
 * - 写操作都落审计。
 *
 * 用法：
 * ```
 * $env:DSH_HOME='D:\DSH-ForLife\.runtime\dsh'
 * node packages/gateway/scripts/e2e-migrate-api.ts
 * ```
 *
 * @module @forlife/gateway/scripts/e2e-migrate-api
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getMigrationRun, openDatabase } from '@forlife/store'

import { createAdminServer } from '../src/server.ts'

const PASSWORD = 'e2e-password-一次性'

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'forlife-e2e-migrate-'))
  const staticRoot = join(base, 'dist')
  const dbPath = join(base, 'admin.sqlite')
  const hotRoot = join(base, 'hot')
  const coldRoot = join(base, 'cold')
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

  // **根路径从环境变量来**（接口不接受请求里的任意路径）——
  // 所以这里必须**先设好再起服务**
  process.env['FORLIFE_ROOT_HOT'] = hotRoot
  process.env['FORLIFE_ROOT_WARM'] = coldRoot
  process.env['FORLIFE_ROOT_COLD'] = coldRoot

  // 造两个真文件在热层
  const blobs = [
    { id: 'blob-1', content: 'hello-blob-one' },
    { id: 'blob-2', content: 'hello-blob-two' },
  ]
  const opened = openDatabase({ file: dbPath })
  for (const b of blobs) {
    const sha = createHash('sha256').update(b.content).digest('hex')
    const p = join(hotRoot, `${b.id}.bin`)
    writeFileSync(p, b.content, 'utf8')
    opened.db
      .prepare(
        `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
         VALUES (?, ?, 'image', 'application/octet-stream', ?, ?, 'hot', ?)`,
      )
      .run(b.id, sha, b.content.length, p, new Date().toISOString())
  }
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

  const db = (): ReturnType<typeof openDatabase>['db'] => {
    const o = openDatabase({ file: dbPath })
    return o.db
  }

  try {
    console.log('\n【1】登录')
    const setup = await call('POST', '/api/admin/setup', { password: PASSWORD })
    check('设置口令成功且下发 cookie', () => {
      assert.equal(setup.status, 200)
      assert.notEqual(cookie, '')
    })

    console.log('\n【2】没有迁移时 /migrate-status 是干净的')
    const s0 = await call('GET', '/api/admin/migrate-status')
    check('返回 ok 且没有锁、没有可续传的', () => {
      assert.equal(s0.status, 200)
      const b = s0.body as { ok: boolean; lock: unknown; resumable: unknown[] }
      assert.equal(b.ok, true)
      assert.equal(b.lock, null, '**没有锁时必须报 null**（有锁会挡住新的写入）')
      assert.equal(b.resumable.length, 0)
    })

    console.log('\n【3】POST /migrate-start 真的建 run 并取锁')
    const start = await call('POST', '/api/admin/migrate-start', { fromTier: 'hot', toTier: 'cold' })
    let runId = ''
    check('建 run 成功', () => {
      assert.equal(start.status, 200, JSON.stringify(start.body))
      const b = start.body as { ok: boolean; runId: string }
      assert.equal(b.ok, true)
      assert.notEqual(b.runId, '')
      runId = b.runId
    })
    check('journal 里记了 2 条待搬', () => {
      const d = db()
      const n = d.prepare('SELECT COUNT(*) AS n FROM migration_journal WHERE run_id = ?').get(runId)
      d.close()
      assert.equal(n?.n, 2)
    })

    console.log('\n【4】★ /migrate-status **能看到锁**（看不到的话用户会以为"沉降坏了"）')
    const s1 = await call('GET', '/api/admin/migrate-status')
    check('锁被报出来，且能续传', () => {
      const b = s1.body as { lock: { runId: string } | null; resumable: { id: string }[] }
      assert.notEqual(b.lock, null, '**有锁时必须报出来**')
      assert.equal(b.lock?.runId, runId)
      assert.equal(b.resumable.length, 1)
      assert.equal(b.resumable[0]?.id, runId)
    })

    console.log('\n【5】★ POST /migrate-resume **真的搬文件 + 校验 + 切换 + 收尾**')
    const resume = await call('POST', '/api/admin/migrate-resume', { runId })
    check('搬完 2 条并收尾', () => {
      assert.equal(resume.status, 200, JSON.stringify(resume.body))
      const b = resume.body as { batch: { verified: number; failed: number; remaining: number }; switched?: { switched: number }; finished?: { ok: boolean } }
      assert.equal(b.batch.verified, 2, `本批应通过 2 条：${JSON.stringify(b.batch)}`)
      assert.equal(b.batch.failed, 0)
      assert.equal(b.batch.remaining, 0)
      assert.equal(b.switched?.switched, 2, '搬完应当自动切换')
      assert.equal(b.finished?.ok, true, '没有剩余时应当收尾')
    })
    check('库里的 tier 与路径都切到冷层了', () => {
      const d = db()
      const rows = d.prepare("SELECT id, storage_tier, storage_path FROM media_assets ORDER BY id").all()
      d.close()
      for (const r of rows) {
        assert.equal(r.storage_tier, 'cold', `${String(r.id)} 应当切到 cold`)
        assert.ok(String(r.storage_path).startsWith(coldRoot), `${String(r.id)} 的路径应当在冷层根下`)
      }
    })
    check('锁已释放（收尾时释放的）', async () => {
      const s = await call('GET', '/api/admin/migrate-status')
      const b = s.body as { lock: unknown }
      assert.equal(b.lock, null)
    })

    console.log('\n【6】★ POST /migrate-rollback **把引用切回旧根**')
    const rollback = await call('POST', '/api/admin/migrate-rollback', { runId })
    check('回滚成功', () => {
      assert.equal(rollback.status, 200, JSON.stringify(rollback.body))
      const b = rollback.body as { ok: boolean; restored: number }
      assert.equal(b.ok, true)
      assert.equal(b.restored, 2)
    })
    check('引用切回热层，**冷层文件还在**（回滚不删新数据）', () => {
      const d = db()
      const rows = d.prepare('SELECT id, storage_tier, storage_path FROM media_assets ORDER BY id').all()
      const run = getMigrationRun(d, runId)
      d.close()
      for (const r of rows) {
        assert.equal(r.storage_tier, 'hot', '引用要切回 hot')
        assert.ok(String(r.storage_path).startsWith(hotRoot), '路径要回到热层根下')
      }
      assert.equal(run?.status, 'rolledback')
    })

    console.log('\n【7】参数守卫')
    const same = await call('POST', '/api/admin/migrate-start', { fromTier: 'hot', toTier: 'hot' })
    check('fromTier === toTier ⇒ 拒绝（那不是迁移，是白搬一遍）', () => {
      assert.equal(same.status, 400)
    })
    const badTier = await call('POST', '/api/admin/migrate-start', { fromTier: 'nope', toTier: 'cold' })
    check('非法 tier ⇒ 拒绝', () => {
      assert.equal(badTier.status, 400)
    })
    const noRun = await call('POST', '/api/admin/migrate-resume', { runId: 'nope' })
    check('不存在的 runId ⇒ 404', () => {
      assert.equal(noRun.status, 404)
    })

    console.log('\n【8】写操作都落审计')
    check('审计里有迁移记录', () => {
      const d = db()
      const n = d.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE detail LIKE '%迁移%'").get()
      d.close()
      assert.ok(Number(n?.n) >= 3, `应当至少有 3 条（start/resume/rollback），实际 ${String(n?.n)}`)
    })
  } finally {
    await running.close()
    rmSync(base, { recursive: true, force: true })
  }

  console.log(`\n${'─'.repeat(58)}`)
  console.log(`  迁移 API 端到端：**${String(passed)} 通过 / ${String(failed)} 失败**`)
  console.log(`${'─'.repeat(58)}\n`)
  if (failed > 0) process.exitCode = 1
}

await main()
