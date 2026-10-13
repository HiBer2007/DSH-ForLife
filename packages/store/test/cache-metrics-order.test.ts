/**
 * `cache_metrics` 的**排序确定性**守卫（`FIX_PLAN.md` §45）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-10 全量跑出一个**偶发红**：`cache-collector-wiring.test.ts:164`
 * 期望 `cache_read_tokens === 8192`、实得 **0**。
 * 查下去发现不是"时序玄学"，而是**排序键不够**：
 *
 *   `at` 是**毫秒**精度（`nowIso()` = `toISOString()`），
 *   同一毫秒内写入的多行**并列**，而 `ORDER BY at DESC` 对并列行**不保证顺序**
 *   ⇒ `.reverse()` 之后"新的在后"就成了**空话**
 *   ⇒ 面板按时间画的曲线会**点序错乱**，端到端测试会**偶发红**。
 *
 * ★ 而本仓库**既有约定**就是补 `rowid`（插入序的单调键）：
 *   `endpoints.ts` / `routing.ts` / `time-readings.ts` 的同类查询**全都**写了 `, rowid DESC`
 *   —— 只有 `cache-metrics.ts` 漏了。这个文件把那条约定**钉死**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listCacheUsage, openDatabase, recordCacheUsage, unattrributedMisses } from '@forlife/store'

function tempDb(): { db: ReturnType<typeof openDatabase>['db']; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-cache-order-'))
  // ★ `openDatabase` 收的是 `{ file }`（返回 `{ db, applied, close() }`），不是路径字符串。
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  return {
    db: opened.db,
    cleanup: () => {
      try {
        opened.close()
      } catch {
        /* 已关就算了 */
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('★★ 同一毫秒的两行：`listCacheUsage` 必须按**插入序**确定返回（新行在最后）', () => {
  const { db, cleanup } = tempDb()
  try {
    // ★ 关键：两行 `at` **完全相同**。旧写法（只按 `at` 排）在这种情况下顺序未定义，
    //   `.at(-1)` 可能取到第一行 —— 那就是线上那次偶发红的真身。
    const at = '2026-10-10T12:00:00.000Z'
    recordCacheUsage(db, { sessionId: 's', turn: 1, step: 1, at, inputTokens: 2048, outputTokens: 64, cacheWriteTokens: 512 })
    recordCacheUsage(db, { sessionId: 's', turn: 1, step: 2, at, inputTokens: 16, outputTokens: 8, cacheReadTokens: 8192 })

    const rows = listCacheUsage(db)
    assert.equal(rows.length, 2, '两行都该在')
    assert.equal(rows[0]?.cache_write_tokens, 512, '★ 第一行必须是先写的那条')
    assert.equal(rows[1]?.cache_read_tokens, 8192, '★ 最后一行必须是后写的那条（这就是 `.at(-1)` 的语义）')

    // 再跑一次，顺序必须**稳定**（旧写法会随 SQLite 的取行顺序漂）
    for (let i = 0; i < 5; i += 1) {
      const again = listCacheUsage(db)
      assert.equal(again[1]?.cache_read_tokens, 8192, `第 ${String(i + 2)} 次读也必须一样 —— 顺序不许漂`)
    }
  } finally {
    cleanup()
  }
})

test('★ 同一毫秒的两行：`unattrributedMisses` 也要确定（方向是 ASC）', () => {
  const { db, cleanup } = tempDb()
  try {
    const at = '2026-10-10T12:00:00.000Z'
    recordCacheUsage(db, { sessionId: 's', turn: 1, step: 1, at, inputTokens: 100, outputTokens: 1, note: 'first' })
    recordCacheUsage(db, { sessionId: 's', turn: 1, step: 2, at, inputTokens: 200, outputTokens: 1, note: 'second' })

    const rows = unattrributedMisses(db)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.note, 'first', '★ ASC ⇒ 先写的那条在前')
    assert.equal(rows[1]?.note, 'second')
  } finally {
    cleanup()
  }
})

// ── 源码守卫：这条约定不许再被漏掉（读源码、**去注释后**断言）────────────────────
test('★★ 接线守卫：`cache-metrics.ts` 里按 `at` 排序的查询，**都必须**带 `rowid` 兜底', () => {
  const src = readFileSync(new URL('../../store/src/cache-metrics.ts', import.meta.url), 'utf8')
  // 去掉块注释与行注释 —— 否则我写的那段解释性注释会让守卫假绿
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const orderBys = [...code.matchAll(/ORDER BY at (ASC|DESC)([^'"`]*)/g)]
  assert.ok(orderBys.length >= 2, `至少要抓到那两处按 at 排序的查询，实际 ${String(orderBys.length)} 处`)

  const missing = orderBys.filter((m) => !/rowid/i.test(m[2] ?? ''))
  assert.deepEqual(
    missing.map((m) => m[0]),
    [],
    '★ 按 `at` 排序却**没带 rowid 兜底** —— 毫秒并列时顺序不确定（§45 那个偶发红的成因）',
  )

  // 方向也要对：DESC 配 DESC、ASC 配 ASC（写反了照样错）
  assert.match(code, /ORDER BY at DESC, rowid DESC/, 'DESC 方向要配 `rowid DESC`')
  assert.match(code, /ORDER BY at ASC, rowid ASC/, 'ASC 方向要配 `rowid ASC`')
})
