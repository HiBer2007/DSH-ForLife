/**
 * ★★ **作用域守卫（2026-10-08 真栽过一次）**：
 * 接线的调用**不许嵌在别人的回调里**。
 *
 * ## 那次是怎么栽的
 *
 * 我把取数层插进了**前一个调用（探针）的 `.catch()` 回调里**：
 *
 * ```ts
 * void probeLlm(ctx).then(…).catch((error) => {
 *   always('探针异常')
 *   void fetchHostCatalog(ctx).then(…)   // ← 只有探针**抛异常**时才会跑
 * })
 * ```
 *
 * **⇒ 探针成功 ⇒ `.catch` 永不执行 ⇒ 取数层永远不跑。**
 *
 * ## 而当时的「接线守卫」是绿的
 *
 * 因为 `catalog-wiring.test.ts` 只断言**「语句位置存在这行调用」** ——
 * 它不看这行在**哪个作用域**。
 *
 * ## 症状长什么样（这才是它值钱的地方）
 *
 * - 容器 `healthy`
 * - 插件 `failed to import` = **0**
 * - **探针日志正常打出来**
 * - **就是没有目录日志**
 *
 * ⇒ 三个"正常"加一个"没输出"，很容易被当成"还没跑到"而放过去。
 *
 * ## 怎么判
 *
 * **所有接线调用必须处在同一个花括号深度** ——
 * 从第一个接线调用到最后一个，**净深度必须是 0**。
 * 嵌进回调的话，深度会 > 0。
 *
 * 另外补一条更直白的：在探针与取数层之间，
 * **不许有未闭合的 `.catch(`**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读 `src/index.ts` 的行。 */
function sourceLines(): string[] {
  return readFileSync(join(ROOT, 'src/index.ts'), 'utf8').split(/\r?\n/)
}

/** 找"语句位置的接线调用"的行号。 */
function wiredCallLines(lines: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*void\s+(probeLlm|fetchHostCatalog)\(\s*ctx/.test(lines[i] ?? '')) out.push(i)
  }
  return out
}

test('★★ 接线调用之间花括号净深度必须为 0（不许嵌在 .catch / .then 回调里）', () => {
  const lines = sourceLines()
  const wired = wiredCallLines(lines)
  assert.ok(wired.length >= 2, '接线调用少于 2 个，这个测试等于没跑')

  const first = wired[0] as number
  const last = wired[wired.length - 1] as number

  let depth = 0
  for (let i = first; i < last; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  }

  assert.equal(
    depth,
    0,
    '接线调用之间花括号净深度是 ' +
      String(depth) +
      ' ⇒ 有一个接线**嵌在别人的回调里**（多半是 .catch 或 .then）。' +
      '那种调用只在别人失败/成功时才跑 —— 而容器照常 healthy、日志照常"看起来正常"。',
  )
})

test('★★ 探针与取数层之间不许有未闭合的 .catch(', () => {
  const lines = sourceLines()
  const wired = wiredCallLines(lines)

  let probeAt = -1
  let catalogAt = -1
  for (const i of wired) {
    if (/probeLlm\(\s*ctx/.test(lines[i] ?? '')) probeAt = i
    if (/fetchHostCatalog\(\s*ctx/.test(lines[i] ?? '')) catalogAt = i
  }
  assert.ok(probeAt !== -1, '找不到探针调用')
  assert.ok(catalogAt !== -1, '找不到取数层调用')
  assert.ok(catalogAt > probeAt, '取数层应该在探针之后')

  const between = lines.slice(probeAt, catalogAt)
  const opens = between.join('\n').match(/\bcatch\s*\(/g)?.length ?? 0
  // 只数"顶格的 `})`"（回调收尾），不数普通的 `}` 
  const closes = between.filter((l) => /^\s*\}\)\s*$/.test(l)).length

  assert.ok(
    closes >= opens,
    '探针与取数层之间有 ' +
      String(opens) +
      ' 个 `.catch(` 但只闭合了 ' +
      String(closes) +
      ' 个 ⇒ 取数层跑在 catch 回调里，只有探针抛异常时才会执行。',
  )
})
