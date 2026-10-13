/**
 * ★★★ **接线守卫：提示词漂移读数真的在启动路径上**（`FIX_PLAN.md` §76.5③ / §78.8）。
 *
 * ## 为什么这条守卫非有不可
 *
 * `promptSeedDrift()` 本身有测试（`store/test/prompt-seed-drift.test.ts`，4 条），
 * 但**它被写好了、生产路径零调用**这件事，行为测试**证明不了** ——
 * 本仓为此栽过 18 次（见 `model-router.ts` 模块头那段）。
 * 所以这里做两件事：
 *  1. **源码级**：`index.ts` 真的导入并调用了它，且**三种读数都被处理**（`missing`/`same`/`differs`）；
 *  2. **行为级**：★ **端到端跑一次真 `apply()`** —— 库里放一份"被人改过"的提示词，
 *     断言启动日志里**真的出现**那条 `⚠️`（不是"代码里写着会报"）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { openDatabase, savePromptRevision, seedDefaultPrompts } from '@forlife/store'

import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

/** 读源码、**去注释**（本仓注释写得很细，不去注释会自己满足自己）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

const source = stripComments(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'))

/** 安静的日志捕获（`apply` 会往 stdout 说话）。 */
async function capture<T>(fn: () => T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = console.log
  const originalErr = console.error
  console.log = (...args: unknown[]): void => void lines.push(args.map(String).join(' '))
  console.error = (...args: unknown[]): void => void lines.push(args.map(String).join(' '))
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    console.log = original
    console.error = originalErr
  }
}

test('★★ index.ts 真的导入了 `promptSeedDrift`（去注释、语句位置）', () => {
  assert.match(
    source,
    /import \{ promptSeedDrift, seedDefaultPrompts \} from '\.\/prompt-store\.ts'/,
    '**必须从 prompt-store 导入** —— 否则那段读数根本不存在',
  )
})

test('★★★ 三种读数都被处理（`missing` / `same` / `differs`）—— 少一种就是"有一类没人管"', () => {
  assert.match(source, /promptSeedDrift\(runtime\.db\)/, '**必须真的调用**')
  assert.match(source, /drift\.verdict === 'missing'/, '`missing` 要有分支')
  assert.match(source, /drift\.verdict === 'same'/, '`same` 要有分支')
  // ★ `differs` 不能只 `log` —— 那是"必须让人看见"的那一类（与 §11 的判据一致）
  const differsAt = source.indexOf('promptSeedDrift(runtime.db)')
  assert.ok(differsAt >= 0, '调用点必须在')
  const block = source.slice(differsAt, differsAt + 2000)
  assert.match(block, /always\(/, '★ "与基线不一致"必须走 `always`（`⚠️` 级），不能只 `log`')
  assert.match(block, /基线更新了而种子不会追/, '★ 两种成因都要说出来（否则人第一反应是"谁动了我的提示词"）')
})

test('★★★ 端到端：库里那份被人改过 ⇒ 真 `apply()` 的启动日志里**真的出现** ⚠️', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-prompt-drift-e2e-'))
  const dbPath = join(dir, 'db', 'forlife.sqlite')
  try {
    // ① 先造一个"被人改过"的库（与插件启动时打开的是同一个文件）
    mkdirSync(join(dir, 'db'), { recursive: true })
    const opened = openDatabase({ file: dbPath })
    seedDefaultPrompts(opened.db)
    const saved = savePromptRevision(opened.db, {
      slug: 'p1-system',
      text: `${defaultFor<string>('prompt.p1Default')}\n\n（这一行是后加的，模拟人改过）`,
      createdBy: 'admin',
      note: '端到端：模拟人改过',
    })
    assert.equal(saved.ok, true, saved.ok ? '' : saved.errors.join('；'))
    opened.close()

    // ② 真 apply()（它自己会打开同一个库、播种、然后打那行读数）
    //    ★ `verbose: true`：插件的 `log()` **只在 verbose 下才打印**（`always` 才无条件打）。
    //      这里要验"两种读数各说各的"，所以把 verbose 打开 ——
    //      ★ 也就是说：**默认配置下只有"不一致"那一条会出现在日志里**（那是刻意的，避免每次启动刷屏）。
    const { lines } = await capture(() => {
      apply(
        { get: () => undefined, inject: () => {}, effect: () => {}, on: () => () => {} } as never,
        resolveConfig({ storageRoot: dir, verbose: true }),
      )
    })
    await delay(30)

    const hit = lines.find((line) => line.includes('提示词 p1-system') && line.includes('不一致'))
    assert.ok(
      hit !== undefined,
      `**启动日志里必须出现那条 ⚠️**（否则"库里是旧提示词"又一次没人说话）\n  实际日志：\n    ${lines.slice(-12).join('\n    ')}`,
    )
    assert.match(hit, /admin/, '要说清是谁建的（面板排查要看）')
    // 没被改的那个槽位要报"一致"（不能一律报警）
    assert.ok(
      lines.some((line) => line.includes('提示词 p2-style') && line.includes('与基线一致')),
      '★ 没改过的槽位要报"一致" —— 一律报警等于没报',
    )
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 库可能还开着（Windows）—— 交给系统回收
    }
  }
})
