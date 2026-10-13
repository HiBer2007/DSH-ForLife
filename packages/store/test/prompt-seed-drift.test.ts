/**
 * ★★★ **提示词漂移读数**（`promptSeedDrift`）的测试。
 *
 * ## 为什么要有这个函数（`FIX_PLAN.md` §76.5③ / §78.8）
 *
 * `seedDefaultPrompts` **只在没有 active 版本时**播种 ⇒
 * ★ **基线后来改了，库里那份不会追**。
 * 2026-10-11 真机实测撞到过：生产库里的 `p1-system` 是 **2026-10-07 那天的基线**
 * （885 字符 vs 基线 950），而**没有任何地方会说话**。
 *
 * ## 最值得守的三条
 *
 * 1. ★★ **"不一致"必须报**（那是这个函数存在的全部理由）；
 * 2. ★★ **"一致"不能误报成不一致**（否则每次启动都刷一条假的 ⚠️ ⇒ 人就不看了）；
 * 3. ★ **它是只读的**：调它不许改库、不许播种（★ 这条最容易在实现里走偏）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { activePrompt, openDatabase, promptSeedDrift, savePromptRevision, seedDefaultPrompts } from '@forlife/store'

/** 造一个临时库（每个用例一个）。 */
function withDb(fn: (db: ReturnType<typeof openDatabase>['db']) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-prompt-drift-'))
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  try {
    fn(opened.db)
  } finally {
    try {
      opened.close()
    } catch {
      // Windows 上可能还开着 —— 交给系统回收
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 同上
    }
  }
}

test('★ 还没播种 ⇒ `missing`（而且**读数本身不许顺手播种**）', () => {
  withDb((db) => {
    const rows = promptSeedDrift(db)
    assert.equal(rows.length, 2, '两个槽位各一条')
    for (const row of rows) {
      assert.equal(row.verdict, 'missing', `${row.slug} 还没播种 ⇒ missing`)
      assert.equal(row.seeded, false)
      assert.equal(row.activeSha256, undefined)
      assert.match(row.baselineSha256, /^[0-9a-f]{64}$/, '基线 sha256 要给出来')
    }
    // ★ 只读：调完之后库里**还是**没有 active 版本
    assert.equal(activePrompt(db, 'p1-system'), undefined, '**读数不许播种**')
    assert.equal(activePrompt(db, 'p2-style'), undefined, '**读数不许播种**')
  })
})

test('★★ 播种之后 ⇒ `same`（不能误报）', () => {
  withDb((db) => {
    const seeded = seedDefaultPrompts(db)
    assert.equal(seeded.length, 2, '两个槽位都该播上')
    for (const row of promptSeedDrift(db)) {
      assert.equal(row.verdict, 'same', `${row.slug} 刚播种完 ⇒ 必须与基线一致（实际 ${row.verdict}）`)
      assert.equal(row.activeBy, 'system')
      assert.equal(row.activeSha256, row.baselineSha256)
    }
  })
})

test('★★★ 有人从面板改了 ⇒ `differs`（这就是"基线不会追"的那一面）', () => {
  withDb((db) => {
    seedDefaultPrompts(db)
    const saved = savePromptRevision(db, {
      slug: 'p1-system',
      text: `${defaultFor<string>('prompt.p1Default')}\n\n（这一行是后加的）`,
      createdBy: 'admin',
      note: '测试：模拟人改过',
    })
    assert.equal(saved.ok, true, saved.ok ? '' : saved.errors.join('；'))
    const rows = promptSeedDrift(db)
    const p1 = rows.find((row) => row.slug === 'p1-system')
    const p2 = rows.find((row) => row.slug === 'p2-style')
    assert.equal(p1?.verdict, 'differs', '**改过就必须报出来**')
    assert.equal(p1?.activeBy, 'admin', '要能看出是谁建的（面板排查要看）')
    assert.equal(p2?.verdict, 'same', '没动的那个槽位不受影响')
  })
})

test('★★ 基线与库里**逐字相同**时不许报 differs（口径必须是同一套哈希）', () => {
  withDb((db) => {
    seedDefaultPrompts(db)
    // 再存一次**一模一样的文本**：会被判 changed=false，但它仍是"与基线一致"
    const again = savePromptRevision(db, {
      slug: 'p2-style',
      text: defaultFor<string>('prompt.p2Default'),
      createdBy: 'admin',
      note: '测试：原样再存一次',
    })
    assert.equal(again.ok, true, again.ok ? '' : again.errors.join('；'))
    const p2 = promptSeedDrift(db).find((row) => row.slug === 'p2-style')
    assert.equal(p2?.verdict, 'same', '同一份文本 ⇒ 必须 same（哈希口径要一致）')
  })
})
