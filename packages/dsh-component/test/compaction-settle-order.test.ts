/**
 * ★★ 缺口 ④ 的守卫：**L4 压缩进行中 ⇒ 暂不触发 L3 沉降**（`FIX_PLAN.md` §67）。
 *
 * ## 用户原话
 * 「当活跃上下文压缩时，中期记忆达到上限**暂时不触发**中期压缩，
 *   而是**等到短期的完毕之后**才触发中期；★ 也**可以只先触发中期**。」
 *
 * ## 为什么（不是"保险起见"）
 * `PLAN.MD` §1.3 末句：「压缩周期内 L0-L4 全程只追加，缓存持续命中；
 * **仅在压缩事件发生时 L3 尾部追加、L4 替换，缓存未命中一次**。」
 * ⇒ ★ 两个压缩**同时**动，就是让 L3/L4 边界**连续失效**（未命中两次甚至更多）。
 *
 * ## 判据是**现成的**
 * `compaction_runs` 里 `phase='started'` 的行 = 正在跑
 * （开始压缩时 `INSERT … ended_at=NULL`；提交/中止才写 `ended_at`）。
 * ★ 不用新表、不用新标志位。
 *
 * ★ 本文件同时守**两件**事：
 *   ① **行为**：有未完成运行 ⇒ `settle()` 什么都不做、并如实说明原因；
 *   ② **位置**：那道闸必须在 `settle()` 的**最前面** ——
 *      放在候选计算**之后**就白搭了（该做的读取与排序已经发生，
 *      而且真跑起来时"算完再丢弃"会让日志与面板给出误导性的中间态）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  abortCompactionRun,
  beginCompactionRun,
  commitCompactionRun,
  openDatabase,
  pendingCompactionRuns,
} from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 去掉注释（尊重字符串/模板字面量）—— 本仓注释里就写着"闸要在最前面"，不去掉会自己满足自己。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function tempRuntime(tag: string): {
  readonly dir: string
  readonly runtime: MemoryRuntime
  readonly cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), `forlife-${tag}-`))
  const runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
  return {
    dir,
    runtime,
    cleanup: () => {
      try {
        runtime.close()
      } catch {
        // 关库失败不影响断言
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 文件锁
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ① 行为
// ════════════════════════════════════════════════════════════════════════════

test('★★ L4 压缩进行中 ⇒ `settle()` 不做任何事，并如实说明原因', () => {
  const { runtime, cleanup } = tempRuntime('gap4-block')
  try {
    // 造一个"正在跑"的压缩事务
    const run = beginCompactionRun(runtime.db, { id: 'run_block', epochFrom: 0, sessionId: 's1', plan: { pushedIds: [], fragmentedIds: [] } })
    assert.equal(pendingCompactionRuns(runtime.db).length, 1, '前提：未完成运行确实在')

    const result = runtime.settle()
    assert.equal(result.fragmented, 0, '★ L4 正在跑 ⇒ 不许碎片化')
    assert.equal(result.archived, 0, '★ L4 正在跑 ⇒ 不许淘汰')
    assert.ok(
      result.notes.some((n) => n.includes('L4 压缩进行中')),
      `★ 必须**如实说明**为什么没做事（不静默）。实际 notes：${JSON.stringify(result.notes)}`,
    )
    // ★ 反面对照：这句话**不该**是那句"没有满足沉降条件的活跃条目"
    //   —— 那会让人以为是"没候选"，而真相是"让路"
    assert.ok(
      !result.notes.some((n) => n.includes('没有满足沉降条件的活跃条目')),
      '★ 原因必须说准：是"让路给 L4"，不是"没有候选"',
    )
  } finally {
    cleanup()
  }
})

test('★★ 压缩提交之后 ⇒ `settle()` 恢复（不再被挡）', () => {
  const { runtime, cleanup } = tempRuntime('gap4-resume')
  try {
    const run = beginCompactionRun(runtime.db, { id: 'run_block', epochFrom: 0, sessionId: 's1', plan: { pushedIds: [], fragmentedIds: [] } })
    assert.ok(runtime.settle().notes.some((n) => n.includes('L4 压缩进行中')))
    commitCompactionRun(runtime.db, run.id, { epochTo: 1, detail: {} })
    assert.equal(pendingCompactionRuns(runtime.db).length, 0, '提交后不该再有未完成运行')
    const after = runtime.settle()
    assert.ok(
      !after.notes.some((n) => n.includes('L4 压缩进行中')),
      '★ 压缩完毕之后必须**恢复** —— 否则沉降被永久堵死（那比不做这个守卫更糟）',
    )
  } finally {
    cleanup()
  }
})

test('★★ 压缩中止（aborted）之后 ⇒ `settle()` 同样恢复', () => {
  const { runtime, cleanup } = tempRuntime('gap4-abort')
  try {
    const run = beginCompactionRun(runtime.db, { id: 'run_block', epochFrom: 0, sessionId: 's1', plan: { pushedIds: [], fragmentedIds: [] } })
    abortCompactionRun(runtime.db, run.id, '注入的中止')
    assert.equal(pendingCompactionRuns(runtime.db).length, 0)
    assert.ok(!runtime.settle().notes.some((n) => n.includes('L4 压缩进行中')))
  } finally {
    cleanup()
  }
})

test('★★ 「也可以只先触发中期」：没有 L4 在跑时，L3 沉降照常（不被这道闸误伤）', () => {
  const { runtime, cleanup } = tempRuntime('gap4-alone')
  try {
    assert.equal(pendingCompactionRuns(runtime.db).length, 0)
    const result = runtime.settle()
    // ★ 走的是正常那条路（要么真沉降、要么如实说"没有满足条件的活跃条目"），
    //   但**绝不能**是被 L4 那道闸挡下的
    assert.ok(
      !result.notes.some((n) => n.includes('L4 压缩进行中')),
      `★ 没有 L4 在跑时不该让路。实际 notes：${JSON.stringify(result.notes)}`,
    )
  } finally {
    cleanup()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② 位置与来源（源码级）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 那道闸必须在 `settle()` 的**最前面**（语句位置，去注释后）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  const settleIdx = body.indexOf('settle(options:')
  assert.ok(settleIdx >= 0, '找不到 `settle(options:` 的定义（形状变了？守卫要跟着改）')
  const settleBody = body.slice(settleIdx, settleIdx + 4000)
  const guardIdx = settleBody.indexOf('pendingCompactionRuns(this.db)')
  assert.ok(guardIdx >= 0, '★ `settle()` 里找不到 `pendingCompactionRuns(this.db)` —— 那道闸不见了')
  // ★ 闸必须在**候选计算之前**：找几个"后面才该发生"的锚点，断言它们排在闸之后
  for (const later of ['listEntries({ status:', 'planFragmentation(']) {
    const laterIdx = settleBody.indexOf(later)
    if (laterIdx >= 0) {
      assert.ok(
        guardIdx < laterIdx,
        `★ 闸必须排在 \`${later}\` **之前** —— 放在后面就白搭了` +
          '（该做的读取与排序已经发生，而且"算完再丢弃"会让日志给出误导性的中间态）。',
      )
    }
  }
})

test('★★ 判据用**现成的** `pendingCompactionRuns`，不许手搓 SQL', () => {
  const body = stripComments(read('../src/runtime.ts'))
  const settleIdx = body.indexOf('settle(options:')
  const settleBody = body.slice(settleIdx, settleIdx + 4000)
  assert.ok(
    settleBody.includes('pendingCompactionRuns('),
    '★ 必须用 `compaction-runs.ts` 里那个现成函数（它与 `beginCompactionRun`/`commit`/`abort` 同源）。',
  )
  assert.ok(
    !/compaction_runs/.test(settleBody),
    '★ 不许在 `runtime.ts` 里手搓 `compaction_runs` 的 SQL —— ' +
      '那会让"phase 的取值域"在第二个地方被重新定义一遍（本仓栽过这类）。',
  )
})
