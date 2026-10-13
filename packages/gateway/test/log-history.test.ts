/**
 * ★★ 面板「翻历史」的服务端一侧（`FIX_PLAN.md` §57 待办④）。
 *
 * ## 为什么需要它
 *
 * `/logs` 原来那条筛选路走的是 `buffer.query(...)` —— **内存缓冲**（进程内、重启就空、容量有限）。
 * 而采集端采进来的 NapCat 记录（真机 2025 条）**大部分在落盘里** ⇒
 * ★ 不翻历史的话，网关重启之后面板上**又看不见了**，而那正是这套采集要解决的事。
 *
 * ## 钉三件事
 *
 * 1. ★ `logStore.modules()` 能报出**落盘里出现过的模块**（否则重启后下拉选不到 `napcat`）；
 * 2. ★★ `?history=1&modules=…` 真的读**落盘**，并回 `source: 'store'`；
 * 3. ★★ **没接上落盘时如实回 `source: 'buffer'`**（不假装翻了历史 —— §52 的"没做与做了要分得开"）。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from '../src/admin/api.ts'
import { createLogStore } from '../src/admin/log-store.ts'
import type { LogRecord } from '../src/admin/log.ts'

/** 造一个临时日志目录，写几条进去。 */
function seedLogs(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-log-history-'))
  const store = createLogStore({ dir })
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 12, 3, minute, 0)).toISOString()
  const rows: LogRecord[] = [
    { level: 'info', module: 'gateway', text: 'gateway 起来了', at: at(0) },
    { level: 'error', module: 'napcat', text: 'Login Error,ErrType: 1', at: at(1) },
    { level: 'info', module: 'napcat', text: '二维码已保存', at: at(2) },
    { level: 'warn', module: 'caddy', text: 'certificate renew', at: at(3) },
    { level: 'error', module: 'napcat', text: 'ECONNREFUSED gateway:3010', at: at(4) },
  ]
  for (const row of rows) store.write(row)
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 上可能还开着
      }
    },
  }
}

test('★★ `logStore.modules()` 报的是**落盘里出现过**的模块（重启后面板靠它）', () => {
  const seeded = seedLogs()
  try {
    const store = createLogStore({ dir: seeded.dir })
    assert.deepEqual(store.modules(), ['caddy', 'gateway', 'napcat'], '要按字典序、去重')
  } finally {
    seeded.cleanup()
  }
})

test('★★ `logStore.read({modules})` 只回那些模块（历史筛选的底层）', () => {
  const seeded = seedLogs()
  try {
    const store = createLogStore({ dir: seeded.dir })
    const napcat = store.read({ modules: ['napcat'], limit: 100 })
    assert.deepEqual(napcat.map((r) => r.text), ['Login Error,ErrType: 1', '二维码已保存', 'ECONNREFUSED gateway:3010'])
    const errors = store.read({ levels: ['error'], limit: 100 })
    assert.deepEqual(errors.map((r) => r.module), ['napcat', 'napcat'])
    const mixed = store.read({ modules: ['napcat'], levels: ['error'], limit: 100 })
    assert.deepEqual(mixed.map((r) => r.text), ['Login Error,ErrType: 1', 'ECONNREFUSED gateway:3010'])
  } finally {
    seeded.cleanup()
  }
})

/** 起一个真的 admin API（带/不带 logStore）。 */
async function startApi(withStore: boolean, dir?: string): Promise<{
  readonly base: string
  readonly cookie: string
  readonly close: () => Promise<void>
}> {
  const workDir = mkdtempSync(join(tmpdir(), 'forlife-log-api-'))
  const opened = openDatabase({ file: join(workDir, 'forlife.sqlite') })
  const store = withStore && dir !== undefined ? createLogStore({ dir }) : undefined
  const handler = createAdminApi({
    db: opened.db,
    dbPath: join(workDir, 'forlife.sqlite'),
    startedAt: Date.now(),
    ...(store === undefined ? {} : { logStore: { read: (filter) => store.read(filter), modules: () => store.modules() } }),
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = `http://127.0.0.1:${String(port)}`

  // 首次设置口令 ⇒ 拿会话 cookie
  const setup = await fetch(`${base}/api/admin/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  })
  assert.equal(setup.status, 200, '首次设置应当成功')
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

  return {
    base,
    cookie,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        opened.close()
      } catch {
        // Windows 上可能还开着
      }
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 同上
      }
    },
  }
}

test('★★★ `?history=1&modules=napcat` 真的读**落盘**，并回 `source=store`', async () => {
  const seeded = seedLogs()
  const api = await startApi(true, seeded.dir)
  try {
    const response = await fetch(`${api.base}/api/admin/logs?history=1&modules=napcat&limit=100`, {
      headers: { cookie: api.cookie },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      lines: { module: string; text: string }[]
      source?: string
      filtered?: boolean
      modules?: string[]
    }
    assert.equal(body.source, 'store', '★ 必须走落盘（否则重启后又看不见了）')
    assert.equal(body.filtered, true)
    assert.deepEqual(body.lines.map((l) => l.module), ['napcat', 'napcat', 'napcat'])
    assert.ok(
      body.modules?.includes('napcat') === true,
      '★ 历史模式的模块下拉要把**落盘里的模块**并进来（重启后才选得到 napcat）',
    )
  } finally {
    await api.close()
    seeded.cleanup()
  }
})

test('★★ 没接上落盘 ⇒ **如实回 `source=buffer`**（不假装翻了历史）', async () => {
  const seeded = seedLogs()
  const api = await startApi(false)
  try {
    const response = await fetch(`${api.base}/api/admin/logs?history=1&modules=napcat`, {
      headers: { cookie: api.cookie },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { source?: string; lines: unknown[] }
    assert.equal(body.source, 'buffer', '★ 没接上落盘时必须如实说"这次读的是缓冲"')
    assert.deepEqual(body.lines, [], '缓冲里没有 napcat（这正是要翻历史的原因）')
  } finally {
    await api.close()
    seeded.cleanup()
  }
})
