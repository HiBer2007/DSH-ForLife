/**
 * 一轮投喂的测试（用户 2026-10-10 的四条：工具收窄 / 轮次为界 / 30 分钟 / 断点续传）。
 *
 * ## 这里最要紧的两条
 *
 * 1. **★ 中止时，游标必须按"实际喂完的段数"推进，而不是按"批次大小"** ——
 *    后者会把没喂的段记成已喂 = **漏喂**，而漏喂是这套东西里唯一真正不可接受的结果
 *    （重喂只是慢，漏喂是丢记忆）。
 * 2. **★ 工具掩码必须在 `finally` 里解除** —— 无论成功、抛错、超时。
 *    忘了解除 = 她的正常对话从此刻起发不出 QQ 消息，而且**没人会发现**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { advanceFeedCursor, readFeedCursor } from '../src/feed-cursor.ts'
import { DEFAULT_FEED_TURN_TIMEOUT_MS, runFeedTurn, type FeedTurnTools } from '../src/feed-turn.ts'

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'feed-turn-'))
  const db = new DatabaseSync(join(dir, 't.sqlite'))
  db.exec('CREATE TABLE forlife_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, dir }
}

/** 一个记账用的假工具掩码。 */
function fakeTools(): { tools: FeedTurnTools; acquired: number; released: number } {
  const state = { acquired: 0, released: 0 }
  return {
    get acquired() {
      return state.acquired
    },
    get released() {
      return state.released
    },
    tools: {
      restrict: () => {
        state.acquired += 1
        return {
          dispose: () => {
            state.released += 1
          },
        }
      },
    },
  } as unknown as { tools: FeedTurnTools; acquired: number; released: number }
}

test('★★ 正常一轮：喂一批、推进游标、解除掩码、日志说清"第几到第几段"', async () => {
  const { db, dir } = freshDb()
  try {
    const mask = fakeTools()
    let sawOffset = -1
    const outcome = await runFeedTurn({
      db,
      source: 'chat/a',
      total: 283,
      perTurn: 50,
      items: Array.from({ length: 50 }, (_, i) => i),
      feed: async (_items, indexOffset) => {
        sawOffset = indexOffset
        return { fedCount: 50 }
      },
      tools: mask.tools,
      allowTools: new Set(['read', 'write']),
      log: () => undefined,
    })

    assert.equal(outcome.plan.next?.from, 1)
    assert.equal(outcome.plan.next?.to, 50)
    assert.equal(outcome.fedCount, 50)
    assert.equal(outcome.aborted, false)
    assert.equal(outcome.fedThrough, 50)
    assert.equal(sawOffset, 0, '段落序号的全局偏移 = from - 1（同源同序号才是幂等更新）')
    assert.equal(readFeedCursor(db, 'chat/a')?.fedThrough, 50)
    assert.equal(mask.acquired, 1)
    assert.equal(mask.released, 1, '★ 掩码必须被解除')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 中止时游标按**实际喂完的段数**推进 —— 这是"漏喂"与"重喂"的分界', async () => {
  const { db, dir } = freshDb()
  try {
    // 本轮该喂 1–50，但只喂进去 23 段就被 30 分钟上限截断
    const first = await runFeedTurn({
      db,
      source: 'chat/b',
      total: 283,
      perTurn: 50,
      items: Array.from({ length: 50 }, (_, i) => i),
      feed: async () => ({ fedCount: 23 }),
      timeoutMs: 1, // 让它"看起来"超时（真正的中止由 signal 决定，这里只验游标算法）
      log: () => undefined,
    })
    assert.equal(first.fedCount, 23)
    assert.equal(
      first.fedThrough,
      23,
      '★ 游标必须停在 23 —— 若按"批次大小"推到 50，第 24–50 段就**永远不会被喂**（漏喂 = 丢记忆）',
    )

    // 下一轮必须从第 24 段接着喂（不是从 51）
    const second = await runFeedTurn({
      db,
      source: 'chat/b',
      total: 283,
      perTurn: 50,
      items: Array.from({ length: 50 }, (_, i) => i),
      feed: async (_items, indexOffset) => {
        assert.equal(indexOffset, 23, '★ 第二轮必须从 23 号偏移开始（= 第 24 段）')
        return { fedCount: 50 }
      },
      log: () => undefined,
    })
    assert.equal(second.plan.next?.from, 24, '★ 必须从 24 开始 —— 从 51 开始会漏喂 24–50')
    assert.equal(second.fedThrough, 73)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 喂的过程抛错 ⇒ 掩码**也要**解除（`finally` 的全部理由）', async () => {
  const { db, dir } = freshDb()
  try {
    const mask = fakeTools()
    await assert.rejects(
      runFeedTurn({
        db,
        source: 'chat/c',
        total: 10,
        perTurn: 10,
        items: Array.from({ length: 10 }, (_, i) => i),
        feed: async () => {
          throw new Error('写库炸了')
        },
        tools: mask.tools,
        log: () => undefined,
      }),
      /写库炸了/,
    )
    assert.equal(mask.released, 1, '★ 抛错路径也必须解除掩码 —— 忘了解除 = 她此后发不出 QQ 消息，且没人会发现')
    // 失败时游标**不动**：那一段没喂成功，下次重喂（幂等，安全）
    assert.equal(readFeedCursor(db, 'chat/c'), undefined, '失败时游标不该推进')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 排产与素材对不上 ⇒ **抛错，不许照喂**', async () => {
  const { db, dir } = freshDb()
  try {
    await assert.rejects(
      runFeedTurn({
        db,
        source: 'chat/d',
        total: 100,
        perTurn: 50,
        items: Array.from({ length: 30 }, (_, i) => i), // 只给了 30 段，排产要 50
        feed: async () => ({ fedCount: 50 }),
        log: () => undefined,
      }),
      /对不上/,
      '照喂会把游标推到一个没喂满的位置 ⇒ 中间那几段永远不会被喂',
    )
    assert.equal(readFeedCursor(db, 'chat/d'), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 已喂完 ⇒ 不再调 feed、不再套掩码（不做无用功）', async () => {
  const { db, dir } = freshDb()
  try {
    // ⚠️ 必须**先**把游标写到总数上 —— 否则"没游标"= 从零开始，那当然没完成
    //    （第一版这条测试就是这么写错的：把"没游标"当成了"已完成"）
    advanceFeedCursor(db, 'chat/e', { fedThrough: 5, total: 5 })

    const mask = fakeTools()
    let called = 0
    const outcome = await runFeedTurn({
      db,
      source: 'chat/e',
      total: 5,
      perTurn: 5,
      items: [],
      feed: async () => {
        called += 1
        return { fedCount: 5 }
      },
      tools: mask.tools,
      log: () => undefined,
    })
    assert.equal(outcome.plan.done, true)
    assert.equal(called, 0, '已完成就不该再调 feed')
    assert.equal(mask.acquired, 0, '已完成就不该套掩码（那会让一次空跑也收窄她的工具）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 30 分钟是**默认**上限（用户指定的那个数）', () => {
  assert.equal(DEFAULT_FEED_TURN_TIMEOUT_MS, 30 * 60 * 1000, '用户原话就是"单个轮次时间为 30 分钟"')
})

test('★ 没给 tools ⇒ 不收窄也不报错（CLI 路径没有 agent，本来就没有工具可收窄）', async () => {
  const { db, dir } = freshDb()
  try {
    const outcome = await runFeedTurn({
      db,
      source: 'chat/f',
      total: 3,
      perTurn: 3,
      items: [0, 1, 2],
      feed: async () => ({ fedCount: 3 }),
      log: () => undefined,
    })
    assert.equal(outcome.fedThrough, 3)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
