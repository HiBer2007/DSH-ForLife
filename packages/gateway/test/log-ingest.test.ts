/**
 * ★★★ 日志采集入口（`POST /api/admin/log-ingest`）的测试 —— `FIX_PLAN.md` §57 待办①。
 *
 * ## 为什么这个端点必须被钉死
 *
 * 它**写的是日志库**，而且入口在**宿主侧脚本**手里（不是浏览器）。三条最容易出事的地方：
 *
 * 1. ★★ **没配令牌时不许退化成"谁都能写"** —— 那等于给全网开一个写日志的口子
 *    （日志会被灌满、还会被塞进假信息去误导排障）；
 * 2. ★★ **令牌比较必须是常量时间**（`safeEqualString`）—— 与口令同一条纪律；
 * 3. ★ **坏记录只丢那一条**（`rejected` 里说清为什么），但**超过单批上限整请求拒** ——
 *    否则 NapCat 里一行畸形日志能让整批 199 条好日志一起丢。
 *
 * ★ 另一半（采集端真的走脱敏 + 缓冲 + 落盘）是**源码级**守卫，见本文件最后两条。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from '../src/admin/api.ts'
import { MAX_INGEST_RECORDS, MAX_INGEST_TEXT, parseIngestBatch, sanitizeModule } from '../src/admin/log-ingest.ts'

/** 起一个真的 admin API + 一个收集 `accept` 的假落点。 */
async function startApi(options: { readonly token?: string } = {}): Promise<{
  readonly base: string
  readonly accepted: { level: string; module: string; text: string; at: string }[]
  readonly close: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-log-ingest-'))
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  const accepted: { level: string; module: string; text: string; at: string }[] = []
  const token = options.token ?? ''
  const handler = createAdminApi({
    db: opened.db,
    dbPath: join(dir, 'forlife.sqlite'),
    startedAt: Date.now(),
    // ★ 令牌为空串 = "没配" ⇒ 端点应当 503（不是"谁都能写"）
    logIngest: { token, accept: (record) => accepted.push({ ...record }) },
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    accepted,
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

/** 投一批。 */
async function post(base: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['x-forlife-log-token'] = token
  const response = await fetch(`${base}/api/admin/log-ingest`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const OK_RECORD = { level: 'error', module: 'napcat', text: 'ECONNREFUSED', at: '2026-10-12T01:00:00.000Z' }

test('★★★ 没配令牌 ⇒ **503 如实说"未启用"**（绝不退化成谁都能写）', async () => {
  const api = await startApi()
  try {
    const result = await post(api.base, { records: [OK_RECORD] })
    assert.equal(result.status, 503, '没配令牌必须是 503')
    assert.match(String(result.body.error), /FORLIFE_LOG_INGEST_TOKEN/, '要说清是哪个变量没配')
    assert.equal(api.accepted.length, 0, '★ 一条都不许落 —— 这条断言才是"没退化成开放写"的凭据')
  } finally {
    await api.close()
  }
})

test('★★ 令牌不对 ⇒ 401 且**一条都不落**', async () => {
  const api = await startApi({ token: 'the-right-token' })
  try {
    const wrong = await post(api.base, { records: [OK_RECORD] }, 'wrong-token')
    assert.equal(wrong.status, 401)
    const missing = await post(api.base, { records: [OK_RECORD] })
    assert.equal(missing.status, 401, '不带令牌也是 401')
    assert.equal(api.accepted.length, 0, '被拒的请求一条都不许落')
  } finally {
    await api.close()
  }
})

test('★★★ 令牌正确 ⇒ 真的落，且**级别/模块/正文**都对', async () => {
  const api = await startApi({ token: 'the-right-token' })
  try {
    const result = await post(
      api.base,
      {
        records: [
          { level: 'error', module: 'napcat', text: '连接错误 Error: connect ECONNREFUSED', at: '2026-10-12T01:00:00.000Z' },
          { level: 'warn', module: 'caddy', text: 'dial tcp: refused', at: '2026-10-12T01:00:01.000Z' },
        ],
      },
      'the-right-token',
    )
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.accepted, 2)
    assert.deepEqual(result.body.rejected, [])
    assert.deepEqual(
      api.accepted.map((r) => `${r.level}/${r.module}`),
      ['error/napcat', 'warn/caddy'],
      '级别与模块要原样落（面板按它们筛）',
    )
  } finally {
    await api.close()
  }
})

test('★★ 坏记录只丢那一条（`rejected` 说清下标与原因），好记录照落', async () => {
  const api = await startApi({ token: 't' })
  try {
    const result = await post(
      api.base,
      {
        records: [
          { level: 'info', module: 'napcat', text: 'ok', at: '2026-10-12T01:00:00.000Z' },
          { level: 'verbose', module: 'napcat', text: '等级不认识', at: '2026-10-12T01:00:00.000Z' },
          { level: 'info', module: '!!!', text: '模块名洗不出来', at: '2026-10-12T01:00:00.000Z' },
          { level: 'info', module: 'napcat', text: '   ', at: '2026-10-12T01:00:00.000Z' },
          { level: 'info', module: 'napcat', text: 'ok2', at: '2026-10-12T01:00:00.000Z' },
        ],
      },
      't',
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.accepted, 2, '两条好的要落')
    const rejected = result.body.rejected as { index: number; reason: string }[]
    assert.deepEqual(rejected.map((r) => r.index), [1, 2, 3], '被拒的要报**下标**（采集端要对得上自己发的是哪条）')
    assert.match(rejected[0]?.reason ?? '', /level/, '要说清是 level 的问题')
    assert.match(rejected[0]?.reason ?? '', /verbose/, '★ 还要把**收到的值**说出来')
    assert.equal(api.accepted.length, 2)
  } finally {
    await api.close()
  }
})

test('★★ 超过单批上限 ⇒ **整请求拒**（采集端要自己分批，不是我们悄悄截断）', async () => {
  const api = await startApi({ token: 't' })
  try {
    const records = Array.from({ length: MAX_INGEST_RECORDS + 1 }, () => OK_RECORD)
    const result = await post(api.base, { records }, 't')
    assert.equal(result.status, 400)
    assert.match(String(result.body.error), new RegExp(String(MAX_INGEST_RECORDS)), '要说清上限是多少')
    assert.equal(api.accepted.length, 0, '★ 整请求被拒时一条都不许落（不许"收一半"）')
  } finally {
    await api.close()
  }
})

test('★ 归一：模块名要洗（面板按它筛）、正文超长要**带标记**截断', () => {
  assert.equal(sanitizeModule('Nap Cat!!'), 'nap-cat')
  assert.equal(sanitizeModule('  DS H  '), 'ds-h')
  assert.equal(sanitizeModule('!!!'), undefined, '洗不出东西 ⇒ 拒绝（不是落一个空模块名）')
  assert.equal(sanitizeModule(123), undefined)

  const long = 'x'.repeat(MAX_INGEST_TEXT + 500)
  const batch = parseIngestBatch([{ level: 'info', module: 'napcat', text: long, at: '2026-10-12T01:00:00.000Z' }])
  const text = batch.records[0]?.text ?? ''
  assert.ok(text.length < long.length, '要截断')
  assert.match(text, /已截断/, '★ 截断要**带标记**（不静默丢尾巴）')
})

test('★ 时间戳不合法 ⇒ 用接收时刻，但**标出来**（不静默）', () => {
  const now = new Date('2026-10-12T02:00:00.000Z')
  const batch = parseIngestBatch([{ level: 'info', module: 'napcat', text: 'hi', at: '昨天' }], () => now)
  assert.equal(batch.records[0]?.at, now.toISOString())
  assert.match(batch.records[0]?.text ?? '', /未给合法时间戳/, '要标出来，否则"时间不对"会被当成采集端的问题查半天')
})

// ════════════════════════════════════════════════════════════════════════════
// 源码级：采集来的行必须走**与其它日志完全相同的落点**（脱敏 + 缓冲 + 落盘）
// ════════════════════════════════════════════════════════════════════════════

/** 去注释（判接线时只看真代码）。 */
function code(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

test('★★★ `server.ts` 的 `accept` 必须走脱敏 + 缓冲 + 落盘（漏掉脱敏 = 密钥进日志库）', () => {
  const body = code('../src/server.ts')
  const at = body.indexOf('logIngest:')
  assert.ok(at >= 0, '★ 必须接上采集入口（没接 = 端点永远 503）')
  const block = body.slice(at, at + 900)
  assert.match(block, /redact\(record\.text\)/, '★★ 必须脱敏 —— 采集来的行同样可能带密钥')
  assert.match(block, /logBuffer\.pushRecord/, '★ 必须进内存缓冲（否则面板要刷新才看得到）')
  assert.match(block, /logStore\.write/, '★ 必须落盘（否则重启就没了）')
  assert.match(block, /FORLIFE_LOG_INGEST_TOKEN/, '★ 令牌从环境变量来（不许硬编码）')
})

test('★★ `api.ts` 里没有"跳过令牌"的分支（503 之后必须 return）', () => {
  const body = code('../src/admin/api.ts')
  const at = body.indexOf("route === '/log-ingest'")
  assert.ok(at >= 0, '端点必须在')
  const block = body.slice(at, at + 1800)
  assert.match(block, /ingest === undefined \|\| ingest\.token === ''/, '★ 没配令牌要有明确分支')
  assert.match(block, /json\(res, 503/, '★ 没配令牌要 503（不是"默默接受"）')
  assert.match(block, /safeEqualString\(presented, ingest\.token\)/, '★★ 令牌比较必须是常量时间（与口令同一条纪律）')
  assert.match(block, /json\(res, 401/, '★ 令牌不对要 401')
  // ★ 顺序：令牌检查必须在 `accept(` 之前（否则"先落再拒"）
  assert.ok(block.indexOf('json(res, 401') < block.indexOf('ingest.accept('), '★★ 必须先验令牌再落')
})
