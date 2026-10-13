/**
 * ★★ 维护端点**真的能选"只跑碎片维护"**（`FIX_PLAN.md` §76.5④ 的行为面）。
 *
 * ## 为什么加这一条
 *
 * PLAN `src-08.md:346` 点名要「碎片索引合并与淘汰（**定时 + 手动**）」。
 * `tick()` 早就支持 `only='fragments'`（维护请求的认领者走的就是它），
 * 但**给人用的 HTTP 入口一直只有"三样都跑"** —— 于是"手动"那条腿缺了一半：
 * 只想合并碎片索引的人，只能顺带把文件也搬一遍。
 *
 * 这条测试钉三件事：
 * 1. ★★ `{only:'fragments'}` ⇒ **真的调 `tick('fragments')`**（不是忽略参数照跑全部）；
 * 2. ★ 不传 ⇒ `tick(undefined)`（= 三样都跑 = **自动那条完全相同的路径**）；
 * 3. ★ 非法值 ⇒ **400 且说清收到的是什么**（不猜、不静默忽略）。
 *
 * ★ 用**假的 SettleLoop 句柄**，不碰真库：这里验的是"参数有没有传对"，
 *   而不是"沉降算法对不对"（那是 settle-loop 自己的测试）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from '../src/admin/api.ts'

/** 造一个假句柄：记录每次 `tick()` 收到的参数。 */
function fakeLoop(calls: (string | undefined)[]): {
  readonly tick: (only?: 'fragments') => Promise<{ moved: number; skipped: number; failed: number; failures: readonly string[] }>
  readonly stop: () => void
  readonly config: { enabled: boolean; intervalMs: number; limit: number; disabledReason?: string }
} {
  return {
    tick: async (only?: 'fragments') => {
      calls.push(only)
      return { moved: only === 'fragments' ? 0 : 2, skipped: 1, failed: 0, failures: [] }
    },
    stop: () => undefined,
    config: { enabled: true, intervalMs: 60_000, limit: 50 },
  }
}

/** 起一个真的 admin API（监听 127.0.0.1 的随机端口），返回它的地址与关闭函数。 */
async function startApi(
  calls: (string | undefined)[],
): Promise<{ readonly base: string; readonly close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-maint-api-'))
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  // ★ `createAdminApi` 返回的是**处理器**（不是 server）⇒ 这里自己套一层 http server。
  const handler = createAdminApi({
    db: opened.db,
    dbPath: join(dir, 'forlife.sqlite'),
    startedAt: Date.now(),
    maintenance: fakeLoop(calls) as never,
  })
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        opened.close()
      } catch {
        // Windows 上可能还开着
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 同上
      }
    },
  }
}

/**
 * 登录拿会话 cookie。
 *
 * ★ 首次设置流程：没有口令时 `POST /login` 会**设置**它（`needsSetup`）——
 *   这里就用这条路，免得测试里硬编码一个口令。
 */
async function login(base: string): Promise<string> {
  const first = await fetch(`${base}/api/admin/session`)
  const status = (await first.json()) as { needsSetup?: boolean }
  assert.equal(status.needsSetup, true, '前提：这个临时库还没有口令 ⇒ 走首次设置（POST /api/admin/setup）')
  const response = await fetch(`${base}/api/admin/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  })
  assert.equal(response.status, 200, `登录应当成功，实际 ${String(response.status)}`)
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie !== null && cookie !== '', '登录必须发会话 cookie')
  return cookie.split(';')[0] ?? ''
}

test('★★★ `{only:"fragments"}` ⇒ 真的调 `tick("fragments")`（不是照跑全部）', async () => {
  const calls: (string | undefined)[] = []
  const api = await startApi(calls)
  try {
    const cookie = await login(api.base)
    const response = await fetch(`${api.base}/api/admin/maintenance/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ only: 'fragments' }),
    })
    const body = (await response.json()) as { ok?: boolean; result?: { moved?: number } }
    assert.equal(response.status, 200, `应当 200，实际 ${String(response.status)}：${JSON.stringify(body)}`)
    assert.deepEqual(calls, ['fragments'], '★ 传进去的必须是 `fragments`（忽略参数照跑全部 = 这条腿白加）')
  } finally {
    await api.close()
  }
})

test('★★ 不传 `only` ⇒ `tick(undefined)`（三样都跑 = 自动那条完全相同的路径）', async () => {
  const calls: (string | undefined)[] = []
  const api = await startApi(calls)
  try {
    const cookie = await login(api.base)
    const response = await fetch(`${api.base}/api/admin/maintenance/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls, [undefined], '★ 不传 ⇒ 必须是 `undefined`（`tick()` 的"三样都跑"就是它）')
  } finally {
    await api.close()
  }
})

test('★ 非法 `only` ⇒ 400 且**说清收到的是什么**（不猜、不静默忽略）', async () => {
  const calls: (string | undefined)[] = []
  const api = await startApi(calls)
  try {
    const cookie = await login(api.base)
    const response = await fetch(`${api.base}/api/admin/maintenance/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ only: 'everything' }),
    })
    const body = (await response.json()) as { error?: string }
    assert.equal(response.status, 400, '非法值必须 400')
    assert.match(String(body.error), /fragments/, '要把**支持的取值**说出来')
    assert.match(String(body.error), /everything/, '★ 也要把**收到的**原样说出来（否则排障要猜）')
    assert.deepEqual(calls, [], '★★ 被拒的请求**一次都不许跑**（"拒了但还是跑了"是最坏的一种）')
  } finally {
    await api.close()
  }
})
