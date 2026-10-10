/**
 * **P2-b：额度路由往 `deepseek-official` 倾** —— 在 `model_routes` 里的那半边。
 *
 * ## 为什么这张表的顺序值一条测试
 *
 * `model_routes.rank` **不是装饰**：
 *
 * - `listModelRoutes()` 是 `ORDER BY rank`（`store/src/routing.ts:32`），
 *   而列注释写着「**同一 role 内越小越优先**」（`migrations.ts:709`）
 * - ★ **`failover` 的候选链读的正是它** ⇒ 顺序就是"出错时先往谁换"
 *
 * ⇒ 原来 `seedDeepSeekFallback` 是 `rank = max + 1`（**追加到末尾**），
 * 于是候选链是 `[GO, GO, …, DS 最后]` —— 与用户要的「**额度路由往 DS 倾**」
 * **正好相反**（GO 那家"实际上只有百分之 9"）。
 *
 * ⚠️ 而且它**不是"少了个优化"**：排在 GO 后面意味着
 * **transient 抖动一次就往那家只剩 9% 的换** —— 越抖越费，越费越抖。
 *
 * ## 与另一处的关系
 *
 * `TIER_PREFERENCE`（`router/src/initial.ts`）是**判档选模型**那一侧的序，
 * 已经在 `dbc7ad3` 改过了。这里是**降级候选链**那一侧。
 * **P2-b 要两处都对** —— 只改一处会让两条路径给出相反的偏好。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { listModelRoutes, openDatabase, upsertModelRoute } from '@forlife/store'

import { seedDeepSeekFallback } from '../src/route-seed.ts'

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-p2b-'))
  const db = openDatabase({ file: join(dir, 't.sqlite') }).db
  return { db, dir }
}

/** 先按"GO 是主"的老样子播两行（rank 0 与 1）。 */
function seedGoFirst(db: DatabaseSync): void {
  upsertModelRoute(db, {
    role: 'L2',
    rank: 0,
    provider: 'opencode-go',
    model: 'flash',
    reasoningEffort: 'high',
    updatedBy: 'system',
  })
  upsertModelRoute(db, {
    role: 'L2',
    rank: 1,
    provider: 'opencode-go',
    model: 'pro',
    reasoningEffort: 'high',
    updatedBy: 'system',
  })
}

test('★★★ DS 的兜底行必须排在**最前**（P2-b）—— 不是"追加到末尾"', () => {
  const { db, dir } = freshDb()
  const before = process.env['DEEPSEEK_API_KEY']
  try {
    process.env['DEEPSEEK_API_KEY'] = 'test-key-for-seed'
    seedGoFirst(db)

    const result = seedDeepSeekFallback(db)
    assert.equal(result.seeded, true, `播种应当成功：${result.reason}`)

    const l2 = listModelRoutes(db, 'L2')
    assert.equal(l2.length, 3, '两行 GO + 一行 DS')
    assert.equal(
      l2[0]?.provider,
      'deepseek-official',
      '★★★ 候选链的**第一个**必须是 DS —— failover 出错时就是往它换；' +
        '排在 GO 后面 ⇒ **一抖动就往只剩 9% 的那家换**',
    )
    // ★ 而且 rank 必须真的更小（不是靠插入顺序碰巧）
    const dsRank = l2[0]?.rank ?? Number.NaN
    const goRanks = l2.filter((r) => r.provider === 'opencode-go').map((r) => r.rank)
    assert.ok(
      goRanks.every((r) => dsRank < r),
      `★ DS 的 rank(${String(dsRank)}) 必须**小于**所有 GO 的 rank(${goRanks.join(',')}) —— ` +
        '`ORDER BY rank` 是唯一的排序依据',
    )
    // ★ 负数也要能落库：表上 `rank INTEGER NOT NULL` + `UNIQUE(role, rank)`
    //   ⇒ 不能和 GO 的 0 撞，取 min-1 是合法且排最前的写法
    assert.ok(dsRank < 0, 'DS 应当拿到负数 rank（min-1），因为 0 已被 GO 占住且 (role,rank) 唯一')
  } finally {
    if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = before
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 三个档位（L2/L3/minimum）都要排到最前，不只是 L2', () => {
  const { db, dir } = freshDb()
  const before = process.env['DEEPSEEK_API_KEY']
  try {
    process.env['DEEPSEEK_API_KEY'] = 'test-key-for-seed'
    // 每个档位都先放一行 GO（rank 0）
    for (const role of ['L2', 'L3', 'minimum']) {
      upsertModelRoute(db, {
        role,
        rank: 0,
        provider: 'opencode-go',
        model: 'flash',
        reasoningEffort: 'high',
        updatedBy: 'system',
      })
    }
    seedDeepSeekFallback(db)

    for (const role of ['L2', 'L3', 'minimum']) {
      assert.equal(
        listModelRoutes(db, role)[0]?.provider,
        'deepseek-official',
        `${role} 的第一个候选该是 DS`,
      )
    }
  } finally {
    if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = before
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 幂等没被破坏：第二次调用不重复追加', () => {
  const { db, dir } = freshDb()
  const before = process.env['DEEPSEEK_API_KEY']
  try {
    process.env['DEEPSEEK_API_KEY'] = 'test-key-for-seed'
    seedGoFirst(db)
    seedDeepSeekFallback(db)
    const first = listModelRoutes(db, 'L2').length
    const again = seedDeepSeekFallback(db)
    assert.equal(again.seeded, false, '已经有 DS 的行 ⇒ 不再追加')
    assert.equal(listModelRoutes(db, 'L2').length, first, '行数不许变')
  } finally {
    if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = before
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 空表（没有 GO）时 DS 从 rank 0 开始 —— 不做无意义的负数', () => {
  const { db, dir } = freshDb()
  const before = process.env['DEEPSEEK_API_KEY']
  try {
    process.env['DEEPSEEK_API_KEY'] = 'test-key-for-seed'
    seedDeepSeekFallback(db)
    const l2 = listModelRoutes(db, 'L2')
    assert.equal(l2[0]?.provider, 'deepseek-official')
    assert.equal(l2[0]?.rank, 0, '没有别人占位时就用 0（负数只在需要插到前面时才用）')
  } finally {
    if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = before
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
