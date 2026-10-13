/**
 * 「投喂前更新」（源刷新，`feed-refresh.ts`）的测试。
 *
 * ## 守的是什么
 *
 * 这条机制的**唯一理由**是"别用陈旧数据重喂"（用户 2026-10-09：
 * 当晚"清空重喂"手上那份是早上切的 281 段，投喂前拉了一次才发现源里多了 6 条）。
 * 所以这里逐条钉住那些"省事但会丢数据"的路：
 *
 *  ① **空结果不是成功** —— DeepSeek 那个接口失败的样子是"安静地返回空数组 + HTTP 200"，
 *     而 `cache_version` 传成会话当前 version 就会这样（**要全量就传 0**）；
 *  ② **刷新失败 ⇒ 不喂**（除非显式 `allowStale`，那时必须标出来）；
 *  ③ **"旧 N → 新 M" 必须算得出来**（台账 + 脚本报的条数）；
 *  ④ **无源输入要能被显式声明**，而不是被迫假装刷新；
 *  ⑤ 命令**不经过 shell**（参数逐项传）—— 引号/空格/注入问题在 `splitCommandLine` 那一层解决。
 *
 * @module @forlife/gateway/test/feed-refresh
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { openDatabase } from '@forlife/store'

import {
  configuredRefreshCommand,
  feedSourceLedgerKey,
  parseRefreshMarkers,
  readFeedSourceState,
  resolveFeedRefresh,
  runFeedRefresh,
  splitCommandLine,
} from '../src/feed-refresh.ts'

const opened: { close: () => void }[] = []

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

// 用例跑完统一关库（不然一个用例一个连接会攒着）
process.on('exit', () => {
  for (const handle of opened) handle.close()
})

/** 用 node 自己当"刷新脚本"：可移植、不用 pwsh、也不碰 `.runtime`。 */
function nodeCommand(script: string): { readonly command: string; readonly args: readonly string[] } {
  return { command: process.execPath, args: ['-e', script] }
}

test('标记解析：默认契约是 items=<n>（可配），版本是 version=<x>；没有就**不报**', () => {
  assert.deepEqual(parseRefreshMarkers('拉到 items=287 条'), { items: 287 })
  assert.deepEqual(parseRefreshMarkers('done\nitems = 12\nversion=abc123\n'), { items: 12, version: 'abc123' })
  assert.deepEqual(parseRefreshMarkers('什么都没报'), {}, '没报就是没报 —— 不许编一个数字出来')
  assert.deepEqual(parseRefreshMarkers('条数=9', '条数='), { items: 9 }, '标记可配（脚本可以有自己的说法）')
  // 0 要能解析出来：它是"空 200"的信号，不能被当成"没报"
  assert.deepEqual(parseRefreshMarkers('items=0'), { items: 0 })
})

test('命令行拆分：带引号的整段算一个参数；引号本身不进参数', () => {
  assert.deepEqual(splitCommandLine('pwsh -NoProfile -File a.ps1'), { command: 'pwsh', args: ['-NoProfile', '-File', 'a.ps1'] })
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\node.exe" "my script.mjs"'), {
    command: 'C:\\Program Files\\node.exe',
    args: ['my script.mjs'],
  })
  assert.deepEqual(splitCommandLine("node -e 'a b'"), { command: 'node', args: ['-e', 'a b'] })
  assert.deepEqual(splitCommandLine('   '), { command: '', args: [] })
})

test('台账：键由**刷新命令**派生（"怎么拉它"就是源的身份），存的不是命令原文', () => {
  const key = feedSourceLedgerKey({ command: 'pwsh', args: ['-File', 'fetch.ps1'] })
  assert.match(key, /^feed_source:[0-9a-f]{10}$/)
  assert.equal(key, feedSourceLedgerKey({ command: 'pwsh', args: ['-File', 'fetch.ps1'] }), '同样的命令 ⇒ 同样的键')
  assert.notEqual(key, feedSourceLedgerKey({ command: 'pwsh', args: ['-File', 'other.ps1'] }), '换个脚本就是另一个源')

  const db = freshDb()
  assert.equal(readFeedSourceState(db, key), undefined, '没记录过 ⇒ undefined（不是 0）')
  db.prepare("INSERT INTO forlife_state (key, value) VALUES (?, ?)").run(key, '{坏 JSON')
  assert.equal(readFeedSourceState(db, key), undefined, '坏数据当"没有"，不许抛（它在投喂前的热路径上）')
})

test('声明解析：文件/流**必须**显式说清源怎么刷新；内容型输入自动算「无源」', () => {
  // 内容型：不声明也行（它**就是**当下给的内容）
  const content = resolveFeedRefresh(undefined, { hasContent: true, hasFiles: false, hasStream: false })
  assert.equal(content.ok, true)
  assert.equal(content.ok ? content.spec.kind : '', 'none')

  // 文件 / 流：不声明 ⇒ 打回，并说清两条出路
  for (const input of [
    { hasContent: false, hasFiles: true, hasStream: false },
    { hasContent: false, hasFiles: false, hasStream: true },
  ]) {
    const rejected = resolveFeedRefresh(undefined, input)
    assert.equal(rejected.ok, false)
    assert.match(rejected.ok ? '' : rejected.error, /必须先刷新/)
    assert.match(rejected.ok ? '' : rejected.error, /none/, '要告诉人"无源"怎么显式声明')
  }

  // 显式无源：必须给 reason（否则事后查不出"当时为什么说它没有源"）
  assert.equal(resolveFeedRefresh({ kind: 'none', reason: '' }, { hasContent: true, hasFiles: false, hasStream: false }).ok, false)
  assert.equal(
    resolveFeedRefresh({ kind: 'none', reason: '刚手写的资料' }, { hasContent: true, hasFiles: false, hasStream: false }).ok,
    true,
  )

  // 命令声明：空的 command 是写错了，不是"没有源"
  assert.equal(resolveFeedRefresh({ kind: 'command', command: '  ' }, { hasContent: false, hasFiles: true, hasStream: false }).ok, false)
})

test('部署配置：环境变量优先于基线；没配时 default 声明要明确失败（不许假装刷过）', () => {
  assert.equal(configuredRefreshCommand({ FORLIFE_FEED_REFRESH_COMMAND: 'pwsh -File x.ps1' }), 'pwsh -File x.ps1')
  assert.equal(configuredRefreshCommand({}), defaultFor<string>('feed.refresh.command').trim())
  const none = resolveFeedRefresh({ kind: 'default' }, { hasContent: false, hasFiles: true, hasStream: false }, {})
  assert.equal(none.ok, false, '部署没配命令时，default 不能"静默跳过刷新"')
  assert.match(none.ok ? '' : none.error, /FORLIFE_FEED_REFRESH_COMMAND/)
  const configured = resolveFeedRefresh({ kind: 'default' }, { hasContent: false, hasFiles: true, hasStream: false }, {
    FORLIFE_FEED_REFRESH_COMMAND: 'pwsh -File x.ps1',
  })
  assert.equal(configured.ok, true)
})

test('无源：不跑任何命令，结果里如实写明「无外部源」+ 理由', async () => {
  const db = freshDb()
  const outcome = await runFeedRefresh(db, { kind: 'none', reason: '调用方直接给的一段文本' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.kind, 'none')
  assert.equal(outcome.command, undefined, '无源时没有命令这回事')
  assert.match(outcome.note, /无外部源/)
  assert.match(outcome.note, /直接给的一段文本/, '理由要带出来（审计口径）')
})

test('★★ 成功：报出条数、记进台账；下一次就能算「旧 N → 新 M（+K）」', async () => {
  const db = freshDb()
  // 模拟真实形状：**同一条命令**（源的身份），而源里的条数变了（内容变了）
  const valueFile = join(mkdtempSync(join(tmpdir(), 'forlife-refresh-')), 'items.txt')
  writeFileSync(valueFile, '281', 'utf8')
  const script = "const fs=require('node:fs');console.log('items='+fs.readFileSync(process.argv[process.argv.length-1],'utf8').trim())"
  const spec = { kind: 'command' as const, command: process.execPath, args: ['-e', script, valueFile] }

  const first = await runFeedRefresh(db, spec)
  assert.equal(first.ok, true)
  assert.equal(first.items, 281)
  assert.equal(first.previousItems, undefined, '第一次没有基准 ⇒ 不报 delta（不许编）')
  assert.match(first.note, /拉到 281 条/)

  writeFileSync(valueFile, '287', 'utf8')
  const second = await runFeedRefresh(db, spec)
  assert.equal(second.ok, true)
  assert.equal(second.items, 287)
  assert.equal(second.previousItems, 281)
  assert.equal(second.delta, 6)
  assert.match(second.note, /旧 281 条 → 新 287 条（\+6）/, '用户要能一眼看出源里多了几条')
})

test('★ 成功但脚本没报条数：如实说"没报"，绝不编一个数字', async () => {
  const db = freshDb()
  const outcome = await runFeedRefresh(db, { kind: 'command', command: process.execPath, args: ['-e', "console.log('拉完了')"] })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.items, undefined)
  assert.match(outcome.note, /没报条数/)
})

test('★★ 空结果（items=0）⇒ **失败**，并把 cache_version 那个坑点出来；allowStale 才放行', async () => {
  const db = freshDb()
  const spec = { kind: 'command' as const, command: process.execPath, args: ['-e', "console.log('items=0')"] }
  const refused = await runFeedRefresh(db, spec)
  assert.equal(refused.ok, false, '安静的空 200 最难查 ⇒ 必须当失败')
  assert.match(refused.reason, /0 条/)
  assert.match(refused.reason, /cache_version/, '要点名那个坑（传会话当前 version 就会拿到 0 条）')
  assert.equal(readFeedSourceState(db, feedSourceLedgerKey(spec)), undefined, '失败不写台账（否则下次的"旧 N"会撒谎）')

  const allowed = await runFeedRefresh(db, { ...spec, allowStale: true })
  assert.equal(allowed.ok, true, '显式接受可疑源 ⇒ 放行')
  assert.equal(allowed.stale, true, '放行必须标出来（事后要能看出"这次可能什么都没拉到"）')
})

test('★★ 刷新失败（非零退出）⇒ 不喂；allowStale 才放行，且必须标 stale', async () => {
  const db = freshDb()
  const spec = { kind: 'command' as const, command: process.execPath, args: ['-e', 'process.exit(3)'] }
  const failed = await runFeedRefresh(db, spec)
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /退出码 3/)
  assert.match(failed.reason, /没有写入任何记忆/)

  const allowed = await runFeedRefresh(db, { ...spec, allowStale: true })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.stale, true)
  assert.match(allowed.note, /陈旧/)
})

test('★ 超时 ⇒ 失败（卡住的刷新比失败的刷新更糟：它把投喂也堵住了）', async () => {
  const db = freshDb()
  const outcome = await runFeedRefresh(db, {
    kind: 'command',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    timeoutMs: 150,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /超时/)
})

test('★ 基线 feed.refresh.required=false ⇒ 只警告并继续（运维逃生门），但照旧标 stale', async () => {
  const db = freshDb()
  // 这条基线默认是 true；这里直接用"允许陈旧"的那条路模拟它的效果，
  // 真正的基线开关由 tests/feed-refresh-wiring.test.ts 从源码/取值两侧钉住。
  const outcome = await runFeedRefresh(db, {
    kind: 'command',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    allowStale: true,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.stale, true)
})

test('★ useOutputAsText：命令的 stdout 成为要喂的内容（不留中间文件）', async () => {
  const db = freshDb()
  const outcome = await runFeedRefresh(db, {
    kind: 'command',
    command: process.execPath,
    args: ['-e', "console.log('刷新出来的正文'); console.error('items=3')"],
    useOutputAsText: true,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.text, '刷新出来的正文\n', 'stdout 原样当内容（stderr 不算内容）')
  assert.equal(outcome.items, 3, 'stdout 与 stderr 一起参与标记解析（脚本爱往哪写都行）')
})

test('★ 命令起不来（路径不存在）⇒ 失败，错误里带人话原因', async () => {
  const db = freshDb()
  const outcome = await runFeedRefresh(db, { kind: 'command', command: '这个命令不存在-zzz', args: [] })
  assert.equal(outcome.ok, false)
  assert.ok((outcome.reason ?? '').length > 10, '要说清是什么原因（不是一句"失败了"）')
})
