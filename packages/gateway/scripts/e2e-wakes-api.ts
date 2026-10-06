/**
 * 验收⑤ 的 HTTP 层端到端（真服务、真 HTTP、真 cookie）。
 *
 * ## 为什么必须走真 HTTP
 *
 * 面板上的按钮最终打的是这些路由。库层面的测试（"setWakePaused 生效了"）
 * **证明不了"点一下按钮真的停住了"** —— 中间还隔着：路由是否注册、
 * 同源校验是否放行、cookie 是否带上、参数名是否对得上。
 * 阶段 7 的四个真机坑全都在这一层。
 *
 * ## 它验什么
 *
 *  - `GET /wakes` 返回**真实数据**（触发器 / 历史 / 统计 / 暂停状态）；
 *  - `POST /wake-pause` **立即生效**（下一次 GET 就能看到）；
 *  - `POST /wake-now` 真的把 `next_fire_at` 拨到"现在"；
 *  - `POST /wake-toggle` 真的改 enabled；
 *  - `POST /wake-cancel` 真的删掉；
 *  - 写操作**都落审计**。
 *
 * 用法：
 * ```
 * $env:DSH_HOME='D:\DSH-ForLife\.runtime\dsh'
 * node packages/gateway/scripts/e2e-wakes-api.ts
 * ```
 *
 * @module @forlife/gateway/scripts/e2e-wakes-api
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWakeTrigger, isWakePaused, listWakeTriggers, openDatabase } from '@forlife/store'

import { createAdminServer } from '../src/server.ts'

const PASSWORD = 'e2e-password-一次性'

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'forlife-e2e-api-'))
  const staticRoot = join(base, 'dist')
  const dbPath = join(base, 'admin.sqlite')
  writeFileSync(join(base, 'x'), '', 'utf8')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(staticRoot, { recursive: true })
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
      console.log(`   ✗ ${name}\n     ${String(error).slice(0, 260)}`)
    }
  }

  const running = await createAdminServer({ dbPath, distRoot: staticRoot, host: '127.0.0.1', port: 0, sessionTtlMs: 120_000 }).start()
  const origin = `http://127.0.0.1:${String(running.port)}`
  let cookie = ''

  /** 带 cookie 与同源 Origin 的 JSON 请求。 */
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

  try {
    console.log('\n【1】登录（首次设置口令）')
    const setup = await call('POST', '/api/admin/setup', { password: PASSWORD })
    check('设置口令成功且下发 cookie', () => {
      assert.equal(setup.status, 200, JSON.stringify(setup.body))
      assert.notEqual(cookie, '', '必须下发 cookie')
    })

    console.log('\n【2】准备一条真实触发器')
    // 面板读的是**同一个库** —— 直接写库（等价于模型用 schedule_wake 建的）
    const db = openDatabase({ file: dbPath })
    const created = createWakeTrigger(db.db, {
      kind: 'timer',
      scope: 'onebot11:123',
      title: '面板要显示的',
      prompt: '做点什么',
      spec: { delaySeconds: 120 },
      createdBy: 'model',
      nextFireAt: '2027-01-01T00:00:00.000Z',
      now: new Date(),
    })
    const triggerId = created.row!.id
    check('触发器已入库', () => {
      assert.equal(created.ok, true)
    })

    console.log('\n【3】GET /wakes —— 面板读到的**真实数据**')
    const list = await call('GET', '/api/admin/wakes')
    check('200 且能读到那条触发器', () => {
      assert.equal(list.status, 200, JSON.stringify(list.body))
      const body = list.body as { triggers: { id: string; title: string; health: string }[] }
      assert.equal(body.triggers.length, 1)
      assert.equal(body.triggers[0]?.title, '面板要显示的')
      // 健康判定也要有值（面板靠它显示徽章）
      assert.ok(['ok', 'idle', 'failing', 'disabled'].includes(String(body.triggers[0]?.health)))
    })
    check('返回暂停状态与统计', () => {
      const body = list.body as { paused: boolean; stats: { triggers: number } }
      assert.equal(body.paused, false)
      assert.equal(body.stats.triggers, 1)
    })

    console.log('\n【4】验收⑤：全局暂停**立即生效**（点一下 → 下一次 GET 就看到）')
    const pause = await call('POST', '/api/admin/wake-pause', { paused: true })
    check('暂停接口 200', () => {
      assert.equal(pause.status, 200, JSON.stringify(pause.body))
    })
    const afterPause = await call('GET', '/api/admin/wakes')
    check('★ 再读就是已暂停（立即生效，不是等缓存过期）', () => {
      assert.equal((afterPause.body as { paused: boolean }).paused, true)
    })
    check('库层面也是暂停（不只是接口回显）', () => {
      // 用 isWakePaused 而不是猜表名 —— 猜表名会得到 "no such table"，
      // 而那个失败看起来像"暂停没生效"，其实只是我猜错了存储位置
      assert.equal(isWakePaused(db.db), true)
    })
    const resume = await call('POST', '/api/admin/wake-pause', { paused: false })
    check('恢复也立即生效', () => {
      assert.equal(resume.status, 200)
      assert.equal(isWakePaused(db.db), false)
    })

    console.log('\n【5】立刻执行 / 停用 / 取消')
    const now = await call('POST', '/api/admin/wake-now', { id: triggerId })
    check('wake-now 200', () => {
      assert.equal(now.status, 200, JSON.stringify(now.body))
    })
    check('★ next_fire_at 被拨到"现在"（引擎下一次 tick 就会扫到）', () => {
      const row = listWakeTriggers(db.db)[0]
      assert.ok(row?.next_fire_at !== null && row.next_fire_at !== undefined)
      assert.ok(new Date(row.next_fire_at).getTime() <= Date.now() + 2000, `实际 ${String(row.next_fire_at)}`)
    })

    const toggle = await call('POST', '/api/admin/wake-toggle', { id: triggerId, enabled: false })
    check('wake-toggle 200 且真的改 enabled', () => {
      assert.equal(toggle.status, 200)
      assert.equal(listWakeTriggers(db.db)[0]?.enabled, 0)
    })

    const cancel = await call('POST', '/api/admin/wake-cancel', { id: triggerId })
    check('wake-cancel 200 且真的删掉', () => {
      assert.equal(cancel.status, 200)
      assert.equal(listWakeTriggers(db.db).length, 0)
    })

    console.log('\n【6】错误处理：不存在 / 参数缺失')
    const missing = await call('POST', '/api/admin/wake-cancel', { id: 'wt_不存在' })
    check('取消不存在的 ⇒ 404 且说清是哪个 id', () => {
      assert.equal(missing.status, 404)
      assert.match(JSON.stringify(missing.body), /没有这条触发器/)
    })
    const badToggle = await call('POST', '/api/admin/wake-toggle', { id: 'wt_不存在', enabled: true })
    check('停用不存在的 ⇒ 404', () => {
      assert.equal(badToggle.status, 404)
    })

    console.log('\n【7】写操作都落审计')
    const audits = db.db.prepare("SELECT detail FROM admin_audit ORDER BY id DESC LIMIT 20").all() as unknown as { detail: string }[]
    check('暂停/立刻执行/取消都有审计记录', () => {
      const joined = audits.map((a) => a.detail).join('\n')
      assert.match(joined, /全局暂停|恢复/)
      assert.match(joined, /立刻执行/)
      assert.match(joined, /取消触发器/)
    })

    console.log('\n【8】CSRF 纵深防御：写操作必须 JSON 内容类型')
    const notJson = await fetch(`${origin}/api/admin/wake-pause`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'text/plain' },
      body: 'paused=true',
    })
    check('非 JSON 内容类型 ⇒ 400（挡住表单式 CSRF）', () => {
      assert.equal(notJson.status, 400)
    })

    db.db.close()
  } finally {
    await running.close()
    // Windows 上文件可能还被占着（服务刚关）—— 清理失败不该让验收变红
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // 临时目录留一点残留可以接受
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  验收⑤ HTTP 层：**${String(passed)} 通过 / ${String(failed)} 失败**`)
  console.log(`${'─'.repeat(60)}\n`)
  if (failed > 0) process.exitCode = 1
}


await main()
