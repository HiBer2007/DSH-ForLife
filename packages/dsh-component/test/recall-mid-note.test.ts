/**
 * ★ `recallLongterm()` 在"长期无命中、中期有"时那句话的**真话测试**（用户 2026-10-09 裁定 ③）。
 *
 * ## 它拦的是什么
 *
 * 原文案（`runtime.ts:492`）：
 * 「长期记忆无命中；中期记忆里有 N 条相关，**但它们已在当前上下文中，无需检索**。」
 *
 * **有窗口之前**这话是真的（`renderView()` 把整张表渲染进前缀）；
 * 窗口（`memory.midWindow.maxTokens`）落地之后，**窗口外的条目既不在上下文、
 * 正文也永不返回** —— 那句话就成了一句"听起来很确定、实际是错的"断言，
 * 模型会据此认为"这条信息我已经有了"，然后凭一个窗口里根本没有的印象作答。
 *
 * ## 为什么必须是"真库 + 真 recallLongterm"
 *
 * 这类问题的形状是**文案与事实脱节**，不是某个函数的输入输出错：
 * 单测 `midFallbackNote()` 这种私有方法只能证明"它按我想的拼了字符串"，
 * 证明不了"窗口外真的够不着"。所以这里喂真条目、跑真检索，
 * 断言的是**模型读到的那句话**与**窗口的真实成员**是否一致。
 *
 * @module forlife-memory/test/recall-mid-note
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { appendMidEntry } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-recall-note-'))

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

/** 真运行时（真库、真表）。 */
function makeRuntime(dir: string): MemoryRuntime {
  return new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
}

/** 跑一次检索，把模型看到的那句 note 取出来（**没有 note 本身就是 bug**：模型只会看到空结果）。 */
function note(runtime: MemoryRuntime, query: string): string {
  const result = runtime.recallLongterm(query)
  assert.ok(
    result.note !== undefined,
    '这条路径必须给出 note —— 否则模型只看得到空结果，不知道"为什么没有"（本仓纪律：不静默）',
  )
  return result.note
}

/**
 * 取某个方法的方法体（**先剥注释**，再做花括号配平）。
 *
 * 为什么不按"下一个成员"当锚点：`midFallbackNote()` 的函数体里有嵌套的 `{}`
 * （`if` 块、模板字面量的 `${…}`），用行锚点切会切多或切少 ——
 * 切少了守卫会假绿，切多了会把别处的字符串也算进来。
 */
function methodBody(name: string): readonly string[] {
  const source = stripComments(read('../src/runtime.ts'))
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes(`${name}(`))
  assert.ok(start >= 0, `runtime.ts 里找不到 \`${name}(\` —— 接线被删了？`)
  const out: string[] = []
  let depth = 0
  let seen = false
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    for (const ch of line) {
      if (ch === '{') {
        depth += 1
        seen = true
      } else if (ch === '}') {
        depth -= 1
      }
    }
    out.push(line)
    if (seen && depth === 0) return out
  }
  assert.fail(`\`${name}()\` 的花括号没有配平 —— 守卫取不到方法体，别让它静默通过`)
}

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * 必须去注释：那句旧文案在**注释里也写着**（文件头与 `midFallbackNote` 的说明都在复述它），
 * 不去注释的话"这句话只出现一次"这类断言会被自己的说明文字满足 —— 典型的假绿。
 * 与 `contracts/test/param-consumption.test.ts`、`mid-window-wiring.test.ts` 同一套做法。
 */
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

// ════════════════════════════════════════════════════════════════════════════
// ① 行为：真库 + 真 recallLongterm
// ════════════════════════════════════════════════════════════════════════════

test('★ 命中**全在窗口内** ⇒ 照说"已在当前上下文中"（这次它是真话）', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    appendMidEntry(runtime.db, { id: 'mid_in', summary: '斑马鱼在鱼缸里', tokenCount: 10 })

    // 前提校验：它**真的**在窗口里（否则"这句话是真的"就没被验证到）
    assert.deepEqual(runtime.midWindow().entries.map((e) => e.id), ['mid_in'], '前提：该条目在窗口内')

    const text = note(runtime, '斑马鱼')
    assert.ok(text.includes('已在当前上下文中'), `窗口内命中该照说原话，实际：${text}`)
    assert.ok(!text.includes('滑出'), `全部在窗口内时不该出现"滑出"的说法，实际：${text}`)
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★★ 命中**全在窗口外** ⇒ 绝不能说"已在当前上下文中"（那句静默的谎就在这）', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 目标条目最旧、自身 60k token；后面再压两条 60k 的新条目
    // ⇒ 100k 预算（基线 `memory.midWindow.maxTokens`）只装得下**最一条**
    appendMidEntry(runtime.db, { id: 'mid_out', summary: '斑马鱼在鱼缸里', tokenCount: 60_000 })
    appendMidEntry(runtime.db, { id: 'mid_new_a', summary: '无关的新记忆甲', tokenCount: 60_000 })
    appendMidEntry(runtime.db, { id: 'mid_new_b', summary: '无关的新记忆乙', tokenCount: 60_000 })

    // 前提校验：目标条目**真的**在窗口外 —— 这条不成立，整个用例什么都没测
    assert.ok(
      !runtime.midWindow().entries.some((entry) => entry.id === 'mid_out'),
      '前提不成立：目标条目还在窗口里（预算或条目大小被改了？），用例失去意义',
    )

    const text = note(runtime, '斑马鱼')
    assert.ok(
      !text.includes('已在当前上下文中'),
      `窗口外的命中**不许**说"已在当前上下文中" —— 这正是修之前那句谎。实际：${text}`,
    )
    assert.ok(text.includes('滑出当前上下文窗口'), `必须如实说它在窗口外，实际：${text}`)
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★ 窗口内 + 窗口外都有 ⇒ **两边的条数都要如实分述**', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 最旧的 60k 会被挤出去，最新的 60k 留下；两条摘要都含"斑马鱼"
    appendMidEntry(runtime.db, { id: 'mid_old', summary: '斑马鱼的老记录', tokenCount: 60_000 })
    appendMidEntry(runtime.db, { id: 'mid_fresh', summary: '斑马鱼的新记录', tokenCount: 60_000 })

    assert.deepEqual(runtime.midWindow().entries.map((e) => e.id), ['mid_fresh'], '前提：窗口里只留最新那条')

    const text = note(runtime, '斑马鱼')
    assert.ok(text.includes('2 条相关'), `总数要说 2 条，实际：${text}`)
    assert.ok(text.includes('其中 1 条在当前上下文（窗口内）'), `窗口内 1 条要如实说，实际：${text}`)
    assert.ok(text.includes('另有 1 条'), `窗口外 1 条要如实说，实际：${text}`)
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② 源码守卫：这句话必须**问窗口**，不许退回"整张表都在上下文里"的旧假设
// ════════════════════════════════════════════════════════════════════════════

test('★★ 守卫：`midFallbackNote()` 真的调 `midWindow()`（不调用就又是旧假设）', () => {
  const body = methodBody('midFallbackNote')
  assert.ok(
    body.some((line) => line.includes('this.midWindow()')),
    '`midFallbackNote()` 必须真的向**窗口**要成员 —— 否则它又在按"整表都在前缀里"说话',
  )
})

test('★★ 守卫："已在当前上下文中"必须排在 `outside === 0` 这道闸**之后**', () => {
  const joined = methodBody('midFallbackNote').join('\n')
  const claims = joined.split('已在当前上下文中').length - 1
  assert.equal(claims, 1, `这句话只该出现一次（在"全在窗口内"的分支里），实际出现 ${String(claims)} 次`)
  const guardAt = joined.indexOf('if (outside === 0)')
  const claimAt = joined.indexOf('已在当前上下文中')
  assert.ok(guardAt >= 0, '找不到 `if (outside === 0)` 这道闸 —— 守卫会失去意义（锚点漂了？）')
  assert.ok(claimAt > guardAt, '`已在当前上下文中` 必须排在 `outside === 0` 之后，窗口外的条目不许拿到它')
})

test('★ 守卫：窗口外那条路上**不许**承诺一条不存在的回填路径', () => {
  const joined = methodBody('midFallbackNote').join('\n')
  // `recall_full` 取的是**溢出工具结果**的全文（spill），不是中期条目；
  // `recover` 只处理长期冷层条目。写进去就是**第二次谎**（本仓纪律：不假装做了一件没做的事）。
  for (const forbidden of ['recall_full', 'recover(']) {
    assert.ok(
      !joined.includes(forbidden),
      `窗口外的说明里不许出现 \`${forbidden}\` —— 它不是"按 id 取中期条目正文"的路径，承诺了就是假话`,
    )
  }
})
