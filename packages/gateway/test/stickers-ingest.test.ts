/**
 * 入库管线的守卫测试。
 *
 * 守的是 PLAN 阶段六那条硬验收：**非白名单来源 / 超大 / 非法类型被拒绝，且库里不留垃圾行**。
 * 以及两条容易被忽略的性质：
 *  - 白名单为空时必须 **fail-closed**（拒绝一切），而不是"没配就都放行"；
 *  - 校验必须在**落盘之前** —— 否则盘上会留下被拒绝的文件（垃圾只是从库里换到了盘上）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { checkMediaBytes, checkSourceUrl, fingerprintOf, ingestSticker, MAX_MEDIA_BYTES } from '../src/stickers.ts'

/** 一个最小的合法 PNG 头（内容不重要，校验只看 mime 与大小）。 */
function fakeImage(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forlife-sticker-'))
}

test('来源白名单：后缀匹配、拒绝其它域、空白名单 fail-closed', () => {
  assert.equal(checkSourceUrl('https://gchat.qpic.cn/a.png').ok, true)
  assert.equal(checkSourceUrl('https://sub.gchat.qpic.cn/a.png').ok, true, '子域应被允许（后缀匹配）')

  const other = checkSourceUrl('https://evil.test/a.png')
  assert.equal(other.ok, false)
  assert.match(other.reason, /不在白名单/)

  // fail-closed：没配白名单时**拒绝一切**，而不是放行一切
  const empty = checkSourceUrl('https://gchat.qpic.cn/a.png', [])
  assert.equal(empty.ok, false, '空白名单必须拒绝')
  assert.match(empty.reason, /fail-closed/)

  // 协议也要管：file:// 之类绝不能放行
  assert.equal(checkSourceUrl('file:///etc/passwd').ok, false)
  // 不能把任意 qq.com 子域都放进来
  assert.equal(checkSourceUrl('https://random.qq.com/a.png').ok, false)
})

test('字节校验：类型与大小', () => {
  assert.equal(checkMediaBytes({ mime: 'image/png', sizeBytes: 100 }).ok, true)
  assert.equal(checkMediaBytes({ mime: 'image/png; charset=binary', sizeBytes: 100 }).ok, true, '带参数要能识别')

  const badType = checkMediaBytes({ mime: 'application/x-msdownload', sizeBytes: 100 })
  assert.equal(badType.ok, false)
  assert.match(badType.reason, /类型不允许/)

  assert.equal(checkMediaBytes({ mime: 'image/png', sizeBytes: 0 }).ok, false, '空文件要拒')
  const huge = checkMediaBytes({ mime: 'image/png', sizeBytes: MAX_MEDIA_BYTES + 1 })
  assert.equal(huge.ok, false)
  assert.match(huge.reason, /超过上限/)
})

test('白名单外来源：被拒、记原因、**不落盘**', () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    const result = ingestSticker({
      db: opened.db,
      bytes: fakeImage(),
      mime: 'image/png',
      source: 'search',
      sourceUrl: 'https://evil.test/x.png',
      storageRoot: dir,
    })
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /不在白名单/)

    // 关键：盘上不能留下文件（校验在落盘之前）
    assert.deepEqual(readdirSync(dir), [], '被拒绝的绝不能落盘 —— 否则垃圾只是从库里换到了盘上')

    // 但库里要留证据（审计要求）
    const row = opened.db.prepare("SELECT status, reject_reason FROM sticker_assets WHERE status = 'rejected'").get() as
      | { status: string; reject_reason: string }
      | undefined
    assert.ok(row !== undefined, '拒绝也要留一行（审计）')
    assert.match(row.reject_reason, /不在白名单/)

    // 不能出现在 active 列表里
    const active = opened.db.prepare("SELECT COUNT(*) AS v FROM sticker_assets WHERE status = 'active'").get() as { v: number }
    assert.equal(active.v, 0)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超大文件：被拒且不落盘', () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    const result = ingestSticker({
      db: opened.db,
      bytes: fakeImage(MAX_MEDIA_BYTES + 10),
      mime: 'image/png',
      source: 'manual',
      storageRoot: dir,
    })
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /超过上限/)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常入库：落盘 + 登记；重复入库复用原行且不重复落盘', () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    const bytes = fakeImage(2048)
    const first = ingestSticker({
      db: opened.db,
      bytes,
      mime: 'image/png',
      source: 'manual',
      scope: 'onebot11:10001',
      storageRoot: dir,
    })
    assert.equal(first.status, 'created')
    assert.ok(first.storagePath !== undefined && existsSync(first.storagePath), '应当落盘')
    assert.equal(first.sha256, fingerprintOf(bytes))

    const filesAfterFirst = readdirSync(dir).length
    assert.equal(filesAfterFirst, 1)

    const second = ingestSticker({
      db: opened.db,
      bytes,
      mime: 'image/png',
      source: 'learned',
      ours: false,
      scope: 'onebot11:88888',
      storageRoot: dir,
    })
    assert.equal(second.status, 'duplicate', '同内容第二次入库必须是 duplicate')
    assert.equal(second.assetId, first.assetId, '复用同一行')
    assert.equal(readdirSync(dir).length, filesAfterFirst, '重复入库**不该**再落一份文件')

    const count = opened.db.prepare('SELECT COUNT(*) AS v FROM sticker_assets').get() as { v: number }
    assert.equal(count.v, 1, '库里只能有一行')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('手动导入没有来源 URL ⇒ 不走白名单（白名单只约束联网抓取）', () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    const result = ingestSticker({
      db: opened.db,
      bytes: fakeImage(),
      mime: 'image/png',
      source: 'manual',
      storageRoot: dir,
    })
    assert.equal(result.status, 'created', '手动导入（用户自己的文件）不该被白名单挡住')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
