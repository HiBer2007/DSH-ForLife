/**
 * ★★ `wake_rules` 里**不许有孤儿行**（条件不在 `WAKE_CONDITIONS` 里的配置行）。
 *
 * ## 为什么需要这条守卫
 *
 * 用户 2026-10-11 把 `peer_input_status` 从 `WAKE_CONDITIONS` 摘掉
 * （改成工具 `peer_status`，见 `FIX_PLAN.md` §64）—— 代码改了，但**真库里那一行留了下来**：
 * `{scope: '*', condition: 'peer_input_status', enabled: 1}`。
 *
 * ★★ 后果不是"无害的垃圾"：★ **面板仍会把它列出来、还带一个开关**，而它**永远不会发生**
 * ⇒ 用户看到的是**能看、不能改（`setWakeRule` 会以「未知的唤醒条件」拒绝）、还永远不发生**的开关。
 * ★ 这正是那次改动要消灭的病，只是从"代码里"挪到了"数据里"。
 *
 * ## 为什么守卫是**通用**的，而不是只钉 `peer_input_status`
 *
 * ★ 只钉一个名字，下次摘条件时**同样的事会再发生一次**。
 * ⇒ 这条守卫断言的是**不变量**：`wake_rules` 里每一行的 `condition`
 *   **必须**是 `WAKE_CONDITIONS` 的一员，**或者**是那张表之外**明确登记过**的补充条件。
 *
 * ★ 它同时守两头：
 *   - 摘掉一个条件却忘了清数据 ⇒ **红**（本文件要抓的）
 *   - 加了一个条件却没进 `WAKE_CONDITIONS`（也没登记）⇒ **红**（同一个不变量的另一面）
 *
 * ★ 为什么这个文件在 `gateway/test/` 而不是 `store/test/`：
 *   它需要**同时**拿到 `WAKE_CONDITIONS`（gateway）与 `openDatabase`/`seedWakeRules`（store），
 *   而依赖方向是 **gateway → store**，反过来 import 不成立。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MIGRATIONS, openDatabase } from '@forlife/store'

import { seedWakeRules, WAKE_CONDITIONS } from '../src/wake.ts'

/**
 * ★ 在 `WAKE_CONDITIONS` **之外**、但**合法**的补充条件（有出处、不是漏登记的）。
 *
 * `pending_backlog`：离线积压那一条。它在 `wake.ts` 的 `BACKLOG_WAKE_CONDITION`
 * 有单独说明（"用户要的单独一组参数"），并被 `QQ_WAKE_CONDITIONS` 显式收进去。
 */
const EXTRA_LEGAL_CONDITIONS: readonly string[] = ['pending_backlog']

/** 打开一个临时库。返回 `{ dir, opened, db }`，用完交给 `cleanup()`。 */
function tempDb(tag: string): {
  readonly dir: string
  readonly opened: { close(): void }
  readonly db: ReturnType<typeof openDatabase>['db']
} {
  const dir = mkdtempSync(join(tmpdir(), `forlife-${tag}-`))
  const opened = openDatabase({ file: join(dir, 'db', 'forlife.sqlite'), backupBeforeMigrate: false })
  return { dir, opened, db: opened.db ?? (opened as unknown as { db: ReturnType<typeof openDatabase>['db'] }).db }
}

/**
 * 清理临时目录。
 *
 * ⚠️ Windows 上 `rmSync` 会因为 **SQLite 句柄没关**而报 `EPERM`（文件被占用）。
 * ⇒ 两个动作都要：**先关库**，再把删除本身包成"删不掉也不算失败"
 *   （临时目录留给系统清理，比让一条**跟被测行为无关**的清理动作把测试弄红要好）。
 */
function cleanup(dir: string, opened: { close(): void }): void {
  try {
    opened.close()
  } catch {
    // 关库失败不该影响断言结果
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 删不掉就算了（Windows 文件锁）
  }
}

test('★★ 播种之后：`wake_rules` 里每一行的条件都必须是"已知条件"', () => {
  const { dir, opened, db } = tempDb('wake-orphan')
  try {
    seedWakeRules(db)
    const rows = db.prepare('SELECT DISTINCT condition FROM wake_rules').all() as { condition: string }[]
    const known = new Set<string>([...WAKE_CONDITIONS, ...EXTRA_LEGAL_CONDITIONS])
    const orphans = rows
      .map((r) => r.condition)
      .filter((c) => !known.has(c))
      .sort()
    assert.deepEqual(
      orphans,
      [],
      '★ `wake_rules` 里出现了**不在条件表里、也没登记过**的条件 ⇒ 面板会显示一个' +
        '"能看、不能改、还永远不发生"的开关。\n' +
        '★ 两种修法：① 摘条件时**同时清数据**（写一条迁移，见 `0029`）；' +
        '② 若这个条件确实合法，把它加进 `WAKE_CONDITIONS` 或本文件的 `EXTRA_LEGAL_CONDITIONS`。',
    )
  } finally {
    cleanup(dir, opened)
  }
})

test('★★ 迁移 0029 真的把 `peer_input_status` 那一行删掉了', () => {
  const { dir, opened, db } = tempDb('wake-m29')
  try {
    // ① 先手工塞一行"历史遗留"（模拟真库改前那个状态）
    seedWakeRules(db)
    db.prepare(
      'INSERT OR REPLACE INTO wake_rules (scope, condition, enabled, probability, updated_by, updated_at) ' +
        "VALUES ('*', 'peer_input_status', 1, 25, 'system', '2026-10-09T00:00:00.000Z')",
    ).run()
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM wake_rules WHERE condition = 'peer_input_status'")
      .get() as { n: number }
    assert.equal(before.n, 1, '前提：注入的历史行确实在（不然这个用例什么都没测）')

    // ② ★★ 跑**真的那条迁移**（`MIGRATIONS` 里 version 29 的 `up`）。
    //
    // ⚠️ 这里原来写的是 `db.exec("DELETE FROM wake_rules WHERE condition = 'peer_input_status';")`
    //    —— ★ **把迁移的 SQL 抄了一遍**。后果：**把迁移改坏，这条守卫不会响**
    //    （我用"注入 B：把 DELETE 改成删别的"验过，它当时是**绿的** ❌）。
    //    ⇒ 这正是本仓反复警告的那一类：**"看着像守卫"**。
    //    ★ 改成调用**真迁移的 `up`** ⇒ 迁移一改，这里立刻跟着变。
    const m29 = MIGRATIONS.find((m) => m.version === 29)
    assert.ok(m29 !== undefined, '★ 找不到 version 29 的迁移 —— 它没登记进 `MIGRATIONS`（守卫③会单独报）')
    m29.up(db)

    const after = db
      .prepare("SELECT COUNT(*) AS n FROM wake_rules WHERE condition = 'peer_input_status'")
      .get() as { n: number }
    assert.equal(after.n, 0, '★ 迁移必须把那一行删干净 —— 否则面板上仍有个永远不发生的开关')
  } finally {
    cleanup(dir, opened)
  }
})

test('★ 迁移 0029 已登记进 `MIGRATIONS`（源码级：只写不登记 = 永远不会跑）', () => {
  const src = readFileSync(new URL('../../store/src/migrations.ts', import.meta.url), 'utf8')
  assert.ok(
    src.includes('0029_drop_peer_input_status_wake_rule'),
    '找不到 0029 的定义（形状变了？守卫要跟着改）',
  )
  assert.ok(
    /version:\s*m0029\.version/.test(src),
    '★ **定义了但没登记进 `MIGRATIONS` = 它永远不会跑** —— 本仓栽过"写了没人调"好几次，' +
      '所以这里断言的是**注册列表里真的有它**。',
  )
})
