/**
 * ★★ 慢查询留痕（`FIX_PLAN.md` §57 待办⑥）。
 *
 * ## 为什么需要
 *
 * 面板上那些读库的页面（`/memory`、`/conversations`、`/wake` …）走 `DATA_ROUTES`，
 * ★ 它们原来**没有任何耗时记录** ⇒ 库开始退化时，症状只会被当成"面板有点卡 / 网络慢"，
 * 而真正的原因（WAL 涨了、空闲页多了、某个查询该加索引）**永远浮不上来**。
 *
 * ## 钉三件事
 *
 * 1. ★★ 超过阈值**真的**写一条 `warn`，并说清是哪个路由、用了多久；
 * 2. ★ 没配出口时**照常返回**（计时是观测，不许影响面板）；
 * 3. ★★ 源码级：`server.ts` 把 `storage` 那个 logger 接上了（"只造 logger 不传"是本仓栽过多次的形状）。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from '../src/admin/api.ts'
import type { LogRecord } from '../src/admin/log.ts'

/** 起一个真的 admin API；`slowQueryMs` 压到 0 ⇒ 任何一次读库都算"慢"。 */
async function startApi(options: { readonly slowQueryMs?: number; readonly withLog?: boolean } = {}): Promise<{
  readonly base: string
  readonly cookie: string
  readonly records: LogRecord[]
  readonly close: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-slow-query-'))
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  const records: LogRecord[] = []
  const handler = createAdminApi({
    db: opened.db,
    dbPath: join(dir, 'forlife.sqlite'),
    startedAt: Date.now(),
    ...(options.slowQueryMs === undefined ? {} : { slowQueryMs: options.slowQueryMs }),
    // ★ 出口的形状与生产一致：`createLogger('storage')` 是一个带 level 方法的函数
    ...(options.withLog === true
      ? {
          slowQueryLog: Object.assign((message: string) => records.push({ level: 'info', module: 'storage', text: message, at: '' }), {
            warn: (message: string) => records.push({ level: 'warn', module: 'storage', text: message, at: '' }),
          }),
        }
      : {}),
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = `http://127.0.0.1:${String(port)}`

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
    records,
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

test('★★★ 读库超阈值 ⇒ 一条 `warn`，说清**哪个路由 + 用了多久**', async () => {
  const api = await startApi({ slowQueryMs: 0, withLog: true })
  try {
    const response = await fetch(`${api.base}/api/admin/memory`, { headers: { cookie: api.cookie } })
    assert.equal(response.status, 200, '★ 计时是观测：不许影响面板本身')
    const slow = api.records.filter((r) => r.level === 'warn' && r.text.includes('读库慢'))
    assert.equal(slow.length, 1, `要有且只有一条慢查询记录（实际 ${JSON.stringify(api.records)}）`)
    assert.match(slow[0]?.text ?? '', /\/memory/, '★ 要说清是哪个路由（否则不知道去哪查）')
    assert.match(slow[0]?.text ?? '', /阈值 0ms/, '要把阈值写出来')
    assert.match(slow[0]?.text ?? '', /WAL\/空闲页/, '★ 要指向同模块的存储指标（"库在退化"那条线索）')
  } finally {
    await api.close()
  }
})

test('★ 没配出口 ⇒ 照常返回（观测不许把面板搞坏）', async () => {
  const api = await startApi({ slowQueryMs: 0 })
  try {
    const response = await fetch(`${api.base}/api/admin/wake`, { headers: { cookie: api.cookie } })
    assert.equal(response.status, 200)
  } finally {
    await api.close()
  }
})

test('★ 阈值没到 ⇒ 不写（不是每次读库都留一条）', async () => {
  const api = await startApi({ slowQueryMs: 60_000, withLog: true })
  try {
    const response = await fetch(`${api.base}/api/admin/prompts`, { headers: { cookie: api.cookie } })
    assert.equal(response.status, 200)
    assert.deepEqual(
      api.records.filter((r) => r.text.includes('读库慢')),
      [],
      '阈值 60 秒时不该有任何慢查询记录',
    )
  } finally {
    await api.close()
  }
})

test('★★ 源码级：`server.ts` 把 `storage` 那个 logger 接到了慢查询出口上', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(source, /createLogger\('storage'\)/, '★ 要有 `storage` 模块的 logger（与存储指标同一个模块名）')
  assert.match(
    source,
    /slowQueryLog: storageLog/,
    '★★ 必须传进 `createAdminApi` —— ★ 只造 logger 不传 = 一条慢查询记录都不会有',
  )
  assert.match(source, /startStorageWatch\(\{/, '★ 存储指标监视也要真的起起来')
})
