/**
 * 补货的守卫测试 —— 直接对着 PLAN 阶段六那条验收写：
 * 「库内检索低于阈值 → 自动联网抓取入库并发送；**每轮抓取不超过 3 张**；**白名单外来源被拒**」。
 *
 * 三条最值得守的：
 *  1. 额度按"轮"算 —— 计数器由调用方持有并每轮清零，做成全局累计会让额度第一轮就用光；
 *  2. **下载前**判白名单 —— 判晚了，恶意 URL 已经让我们发起了请求（SSRF 入口）；
 *  3. 没配搜索源时**不补货**（fail-closed），而不是随便找个源。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase, saveStickerDescription, upsertStickerAsset } from '@forlife/store'

import { newRestockBudget, restockSticker, type StickerFetcher } from '../src/sticker-restock.ts'

function image(size = 256, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0)
  bytes[8] = seed
  return bytes
}

/** 记录被请求过的 URL（用来断言"白名单外的根本没被下载"）。 */
function trackingFetcher(): { fetcher: StickerFetcher; requested: string[] } {
  const requested: string[] = []
  let seed = 0
  return {
    requested,
    fetcher: async (url) => {
      requested.push(url)
      seed += 1
      return { ok: true, mime: 'image/png', bytes: image(256, seed) }
    },
  }
}

test('库里已有匹配 ⇒ 不抓取（省钱主线在补货路径上的体现）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    const asset = upsertStickerAsset(opened.db, {
      sha256: 'own',
      mime: 'image/png',
      sizeBytes: 10,
      storagePath: '/s/own.png',
      source: 'manual',
      ours: true,
    })
    saveStickerDescription(opened.db, { assetId: asset.id, description: '一只橘猫在睡觉', emotionTags: ['猫', '睡觉'] })

    const { fetcher, requested } = trackingFetcher()
    const result = await restockSticker('猫睡觉', {
      db: opened.db,
      storageRoot: dir,
      fetcher,
      budget: newRestockBudget(3),
      searcher: async () => [{ url: 'https://gchat.qpic.cn/x.png' }],
    })
    assert.equal(result.status, 'not-needed')
    assert.equal(result.assetId, asset.id)
    assert.deepEqual(requested, [], '库里有就不该发起任何下载')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没配搜索源 ⇒ fail-closed，不抓取', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    const { fetcher, requested } = trackingFetcher()
    const result = await restockSticker('恐龙跳舞', { db: opened.db, storageRoot: dir, fetcher, budget: newRestockBudget(3) })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /fail-closed/)
    assert.deepEqual(requested, [])
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 白名单外的候选：**根本不被下载**（判在白名单检查之后）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    const { fetcher, requested } = trackingFetcher()
    const result = await restockSticker('猫', {
      db: opened.db,
      storageRoot: dir,
      fetcher,
      budget: newRestockBudget(3),
      searcher: async () => [{ url: 'https://evil.test/a.png' }, { url: 'https://gchat.qpic.cn/ok.png' }],
    })
    assert.equal(result.status, 'restocked', '白名单内的第二个候选应该成功')
    assert.deepEqual(requested, ['https://gchat.qpic.cn/ok.png'], '恶意 URL 绝不能被请求')
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0] ?? '', /不在白名单/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 每轮上限：额度用尽后不再抓，且"失败的尝试"也占额度', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    const budget = newRestockBudget(1)
    const { fetcher, requested } = trackingFetcher()
    const searcher = async (): Promise<{ url: string }[]> => [
      { url: 'https://gchat.qpic.cn/a.png' },
      { url: 'https://gchat.qpic.cn/b.png' },
    ]

    const first = await restockSticker('猫', { db: opened.db, storageRoot: dir, fetcher, budget, searcher })
    assert.equal(first.status, 'restocked')
    assert.equal(budget.used, 1)

    // 同一轮再来一次 ⇒ 额度已满
    const second = await restockSticker('狗', { db: opened.db, storageRoot: dir, fetcher, budget, searcher })
    assert.equal(second.status, 'exhausted')
    assert.match(second.reason, /1\/1/)
    assert.equal(requested.length, 1, '额度用尽后不能再发起请求')

    // 下一轮（新 budget）⇒ 恢复
    const nextTurn = await restockSticker('狗', { db: opened.db, storageRoot: dir, fetcher, budget: newRestockBudget(1), searcher })
    assert.equal(nextTurn.status, 'restocked', '新一轮应恢复额度（额度按轮算，不是全局累计）')
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('下载失败/校验失败：记进 skipped 并继续试下一个候选', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    let call = 0
    const fetcher: StickerFetcher = async () => {
      call += 1
      if (call === 1) return { ok: false, mime: 'image/png', bytes: new Uint8Array(), reason: '404' }
      // 第二个返回非法类型 ⇒ 应被入库管线拒绝
      return { ok: true, mime: 'application/x-msdownload', bytes: image(64, 9) }
    }
    const result = await restockSticker('猫', {
      db: opened.db,
      storageRoot: dir,
      fetcher,
      budget: newRestockBudget(5),
      searcher: async () => [{ url: 'https://gchat.qpic.cn/a.png' }, { url: 'https://gchat.qpic.cn/b.png' }],
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.skipped.length, 2)
    assert.match(result.skipped[0] ?? '', /404/)
    assert.match(result.skipped[1] ?? '', /类型不允许/)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('搜索源抛错：如实回报失败，不吞掉', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = mkdtempSync(join(tmpdir(), 'forlife-restock-'))
  try {
    const result = await restockSticker('猫', {
      db: opened.db,
      storageRoot: dir,
      fetcher: trackingFetcher().fetcher,
      budget: newRestockBudget(3),
      searcher: async () => {
        throw new Error('搜索服务 502')
      },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, /搜索失败.*502/s)
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
