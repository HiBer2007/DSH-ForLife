/**
 * ★★★ **接线守卫：死循环监控真的抽出去了**（用户 2026-10-11 裁定）。
 *
 * ## 用户原话
 *
 * > 「最好把防止死循环的功能**单独提取出来**而不是和 memory 模块合并，
 * > 他是**独立的模型输出监控工具**」
 *
 * ## 为什么要有这条守卫
 *
 * "抽出去了"这件事**从行为上看不出来**：记忆插件照样在跑、照样能中止循环。
 * 只有**源码**能证明：
 *
 * 1. 实现**只有一份**（本仓纪律：不许两份实现 —— 两份迟早会分叉）；
 * 2. `forlife-memory` **真的走的是那一份**（不是"自己另写了一遍"）；
 * 3. ★★ 旧的那条**接线缺陷**不能复活 —— 工具腿此前被写在用量采集的
 *    `catch (error)` 块里（用量采集失败才会执行）⇒ **生产里几乎从不执行**，
 *    而且**只记日志、从不中止**，可三层单测全绿。
 *
 * ## 一条方法论（本仓栽过）
 *
 * **"零调用方"与"接上了"在测试上看不出区别** —— 所以这里断言的是
 * **语句位置与来源**，不是"存在某个字符串"。
 * 且一律**去注释后**再断言（本仓注释写得很细，不去注释会自己满足自己）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const packageDir = fileURLToPath(new URL('../../loop-guard/', import.meta.url))

/** 读源码、**去注释**（`//` 与 `/* *​/`）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

function read(relative: string): string {
  return readFileSync(join(srcDir, relative), 'utf8')
}

test('★★ index.ts 从 `@forlife/loop-guard` 导入 `installLoopGuard`（去注释）', () => {
  const body = stripComments(read('index.ts'))
  assert.match(
    body,
    /import \{ installLoopGuard \} from '@forlife\/loop-guard'/,
    '**必须从那个包导入** —— 否则就是又写了一份',
  )
})

test('★★ index.ts 真的**调用**了它（语句位置，不是只在注释里提过）', () => {
  const body = stripComments(read('index.ts'))
  assert.match(body, /^\s*installLoopGuard\(ctx, \{ log, always, disposers \}\)$/m, '**必须真的调用**')
})

test('★★★ 三个旧实现文件**不许回来**（一条实现只住一个地方）', () => {
  for (const stale of ['loop-guard-hook.ts', 'loop-guard-register.ts', 'tool-loop-guard.ts']) {
    assert.equal(existsSync(join(srcDir, stale)), false, `**${stale} 不该再存在于 forlife-memory 里**`)
  }
})

/** 递归列出 `packages/*​/src` 下的所有 `.ts`（**跳过 `node_modules`** —— 那里有 junction，会重复计数）。 */
function listPackageSources(packagesDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(packagesDir, 0)
  return out
}

test('★★★ 全仓**只有一份** `class LoopGuard`（PLAN §2.14.14：不许两份实现）', () => {
  const packagesDir = fileURLToPath(new URL('../../', import.meta.url))
  const hits: string[] = []
  for (const full of listPackageSources(packagesDir)) {
    // **只看 `packages/<pkg>/src/` 下的源码**（测试/脚本里不该有实现）
    if (!/packages[\\/][^\\/]+[\\/]src[\\/]/.test(full)) continue
    if (stripComments(readFileSync(full, 'utf8')).includes('class LoopGuard')) hits.push(full)
  }
  assert.equal(hits.length, 1, `**只该有一份实现**，实际：${hits.join(' | ')}`)
  assert.ok(
    hits[0]?.includes(join('loop-guard', 'src', 'detector.ts')),
    `实现在 ${hits[0] ?? '?'}（应当在 loop-guard 包里）`,
  )
})

test('★★ `@forlife/store` 只是**再导出**（不是第二份实现，也不能反向依赖）', () => {
  const storeIndex = stripComments(
    readFileSync(join(packageDir, '..', 'store', 'src', 'index.ts'), 'utf8'),
  )
  assert.match(
    storeIndex,
    /export \{ DEFAULT_LOOP_POLICY, LoopGuard, normalizeForLoop, scanForLoop \} from '@forlife\/loop-guard'/,
    '**必须从 loop-guard 包再导出**',
  )
  assert.doesNotMatch(storeIndex, /from '\.\/loop-guard\.ts'/, '**旧路径不许再出现**')
})

test('★★★ 工具腿**不许**再被塞进用量采集的 `catch` 里（旧缺陷的回归守卫）', () => {
  const body = stripComments(read('index.ts'))
  // 旧实现的三块拼图：本地的工具检测器 + 在 catch 里 feed 它
  assert.doesNotMatch(body, /createToolLoopGuard/, '**工具检测器不该由记忆插件自己建**')
  assert.doesNotMatch(body, /toolLoopGuard/, '**旧的那段（在 catch 里 feed）必须彻底消失**')
  assert.doesNotMatch(body, /toolVerdict/, '**旧的判定处理必须彻底消失**')
})

test('★★ 包里那条工具腿**真的订阅了 `session/event`**并喂了检测器（去注释）', () => {
  const install = stripComments(readFileSync(join(packageDir, 'src', 'install.ts'), 'utf8'))
  const onIndex = install.indexOf("contextOn.on('session/event'")
  const feedIndex = install.indexOf('toolGuard.feed(')
  assert.ok(onIndex >= 0, '**必须订阅 session/event**（工具腿的唯一数据源）')
  assert.ok(feedIndex > onIndex, '**必须在这条订阅的 handler 里喂检测器**（顺序断言）')
  // 两条腿各一条订阅 —— **多一条就可能重复喂**（一次输出被喂两遍 ⇒ 误杀）
  assert.equal(
    install.split("contextOn.on('").length - 1,
    2,
    '**只该有两条订阅**（文字 + 工具）',
  )
})
