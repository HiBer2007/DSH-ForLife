/**
 * 沉降任务的守卫测试（PLAN 阶段 9 交付物 1）。
 *
 * ## 最值得守的四条
 *
 * 1. **只往冷处搬** —— 策略 bug 不该能把冷数据拉回 SSD（那是 `recover` 的事）。
 * 2. **校验失败 ⇒ 不动库** —— 源还在原处，下一轮还能重试。
 *    "失败了但库说搬好了"是最坏的结果：查不到文件，也不知道该去哪找。
 * 3. **一条失败不拖垮整批** —— 但失败要**逐条记账**，不是静默跳过。
 * 4. **没到策略门槛的不搬** —— 否则"沉降"会变成"一启动就全搬到 HDD"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import { settleBlobs, tierPathFor, type MoveFile } from '../src/settle.ts'
import { DEFAULT_SETTLE_POLICY, type TierRoots } from '../src/storage-tiers.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

/** 三层都配齐的根路径。 */
const ROOTS: TierRoots = {
  roots: { hot: 'D:\\hot', warm: 'D:\\warm', cold: 'D:\\cold' },
  fellBack: [],
}

/** 造一个 db + 若干 blob。 */
function setup(
  blobs: readonly { id: string; tier: string; daysAgo: number; bytes?: number; sha?: string }[],
): ReturnType<typeof openDatabase> {
  const opened = openDatabase({ file: ':memory:' })
  for (const b of blobs) {
    const created = new Date(AT.getTime() - b.daysAgo * 86_400_000).toISOString()
    opened.db
      .prepare(
        `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
         VALUES (?, ?, 'image', 'image/png', ?, ?, ?, ?)`,
      )
      .run(
        b.id,
        // 每条用**唯一** sha —— 表上有 UNIQUE(sha256)，重复会插入失败
        b.sha ?? b.id.padEnd(64, '0'),
        b.bytes ?? 10_000,
        `D:\\hot\\${b.id}.png`,
        b.tier,
        created,
      )
  }
  return opened
}

/** 总是成功的搬迁替身。 */
const okMove: MoveFile = async () => ({ ok: true, reason: 'ok' })

test('★ 超过门槛的搬到 warm（7 天）', async () => {
  const opened = setup([{ id: 'old', tier: 'hot', daysAgo: 10 }])
  try {
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT })
    assert.equal(out.length, 1)
    assert.equal(out[0]?.action, 'moved')
    assert.equal(out[0]?.to, 'warm')
    const row = opened.db.prepare("SELECT storage_tier, settled_at FROM media_assets WHERE id = 'old'").get()
    assert.equal(row?.storage_tier, 'warm')
    assert.equal(row?.settled_at, AT.toISOString(), 'settled_at 必须记上')
  } finally {
    opened.db.close()
  }
})

test('★ 没到门槛的**不搬**（否则"沉降"变成"一启动全搬走"）', async () => {
  const opened = setup([{ id: 'fresh', tier: 'hot', daysAgo: 1 }])
  try {
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT })
    assert.equal(out[0]?.action, 'skipped')
    const row = opened.db.prepare("SELECT storage_tier FROM media_assets WHERE id = 'fresh'").get()
    assert.equal(row?.storage_tier, 'hot', '不该被搬走')
  } finally {
    opened.db.close()
  }
})

test('★ 太小（低于 minBytesToSettle）的不搬 —— 搬一个小文件比它占的地方还费', async () => {
  const opened = setup([{ id: 'tiny', tier: 'hot', daysAgo: 100, bytes: 10 }])
  try {
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT })
    assert.equal(out[0]?.action, 'skipped')
  } finally {
    opened.db.close()
  }
})

test('★ 校验失败 ⇒ **不动库**（源还在原处，下一轮能重试）', async () => {
  const opened = setup([{ id: 'bad', tier: 'hot', daysAgo: 30 }])
  try {
    const failMove: MoveFile = async () => ({ ok: false, reason: '校验不符，已保留源文件' })
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: failMove, now: () => AT })
    assert.equal(out[0]?.action, 'failed')
    const row = opened.db.prepare("SELECT storage_tier, storage_path, settled_at FROM media_assets WHERE id = 'bad'").get()
    assert.equal(row?.storage_tier, 'hot', '**失败绝不能改库**')
    assert.equal(row?.settled_at, null)
    assert.ok(String(row?.storage_path).includes('hot'), '路径也该留在原处')
  } finally {
    opened.db.close()
  }
})

test('★ 搬迁抛异常 ⇒ 算失败，不把整批带走', async () => {
  const opened = setup([
    { id: 'boom', tier: 'hot', daysAgo: 30 },
    { id: 'fine', tier: 'hot', daysAgo: 30 },
  ])
  try {
    const flaky: MoveFile = async ({ from }) => {
      if (from.includes('boom')) throw new Error('磁盘满了')
      return { ok: true, reason: 'ok' }
    }
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: flaky, now: () => AT })
    assert.equal(out.length, 2, '两条都要有结果（不是抛出去）')
    const boom = out.find((o) => o.id === 'boom')
    const fine = out.find((o) => o.id === 'fine')
    assert.equal(boom?.action, 'failed')
    assert.match(String(boom?.reason), /磁盘满了/)
    assert.equal(fine?.action, 'moved', '**另一条必须照常搬**')
  } finally {
    opened.db.close()
  }
})

test('★ 拒绝搬到更热或同层（搬热是 recover 的事，不是沉降）', async () => {
  const opened = setup([{ id: 'warm1', tier: 'warm', daysAgo: 100 }])
  try {
    // 造一个"要往 hot 搬"的坏策略
    const evilPolicy = { warmAfterDays: 0, coldAfterDays: 0, minBytesToSettle: 0 }
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: evilPolicy, moveFile: okMove, now: () => AT })
    // 它应当搬到 cold（更冷），**绝不能**是 hot
    assert.notEqual(out[0]?.to, 'hot', '**绝不能往热处搬**')
    if (out[0]?.action === 'moved') assert.equal(out[0]?.to, 'cold')
  } finally {
    opened.db.close()
  }
})

test('★ 已经在最冷层的不进候选（不用每次扫全表）', async () => {
  const opened = setup([{ id: 'already', tier: 'cold', daysAgo: 999 }])
  try {
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT })
    assert.equal(out.length, 0, '最冷层的应当被 SQL 直接过滤掉')
  } finally {
    opened.db.close()
  }
})

test('★ cold 退回时，最冷层是 warm —— 不能往一个不存在的层搬', async () => {
  const opened = setup([{ id: 'x', tier: 'hot', daysAgo: 100 }])
  try {
    const fellBack: TierRoots = { roots: { hot: 'D:\\hot', warm: 'D:\\warm', cold: 'D:\\warm' }, fellBack: [{ tier: 'cold', from: 'warm' }] }
    const out = await settleBlobs({ db: opened.db, roots: fellBack, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT })
    assert.equal(out[0]?.to, 'warm', 'cold 退回了 ⇒ 最冷层是 warm')
  } finally {
    opened.db.close()
  }
})

test('tierPathFor：按 sha256 前两位分片（避免单目录几万文件）', () => {
  const p = tierPathFor(ROOTS, 'cold', 'ab12'.padEnd(64, '0'), 'D:\\hot\\x.png')
  assert.ok(p.startsWith('D:\\cold'), `实际 ${p}`)
  assert.ok(p.includes('ab'), '应当有 sha 前两位的分片目录')
  assert.ok(p.endsWith('.png'), '扩展名要保留')
})

test('limit 生效（防一次搬太多把 IO 打满）', async () => {
  const opened = setup(
    Array.from({ length: 10 }, (_, i) => ({ id: `b${String(i)}`, tier: 'hot', daysAgo: 30 })),
  )
  try {
    const out = await settleBlobs({ db: opened.db, roots: ROOTS, policy: DEFAULT_SETTLE_POLICY, moveFile: okMove, now: () => AT, limit: 3 })
    assert.equal(out.length, 3)
  } finally {
    opened.db.close()
  }
})
