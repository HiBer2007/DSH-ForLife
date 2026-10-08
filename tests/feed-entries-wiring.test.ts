/**
 * ★★ 「四条入口共用同一个核心」的接线守卫。
 *
 * ## 守的是什么
 *
 * 用户 2026-10-07 的硬要求：**四条入口都要**，而且**都走真实的沉降路径**。
 * 最危险的退化不是"某条入口没做"，而是"某条入口自己另写了一套"：
 * 那种东西在面板上、在沉降里、在 recall 里的表现都跟正常记忆不一样，
 * 而且要等到出事（发现喂进去的东西不参与压缩、或检索不到）才会被发现。
 *
 * 所以这里不检查功能，检查**接线形状**：
 *  1. 四条入口都调 `feedMemory`（唯一核心）；
 *  2. 四条入口**都不直接**碰记忆的写入/检索原语（`insertLongEntry` /
 *     `appendMidEntry` / `searchLongFts` / `searchMidFts`）—— 那些只在核心那一侧出现；
 *  3. 两条 HTTP 入口的路径就是用户点名的那两个；
 *  4. 删除**没有**新接口：文档与核心都把"删"指向既有的 `memory-archive`。
 *
 * 扫描**先去注释**：注释里出现这些名字通常是在说"不要这么干"或"复用它"，
 * 当成违规就是误报，而误报会让人开始忽略守卫（本仓在 `param-consumption.test.ts` 栽过）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 去掉注释（`/* *​/` 与 `//`），只留真正的代码。 */
function code(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/** 四条入口：路径 → 人话（断言失败时直接说清是哪条入口）。 */
const ENTRIES: readonly (readonly [string, string])[] = [
  ['scripts/feed-memory.ts', '① 文件/目录扫描 + ② 命令行直接传文本'],
  ['packages/gateway/src/admin/api.ts', '③ 后台 HTTP 接口（POST /api/admin/feed）'],
  ['packages/dsh-component/src/api.ts', '③ 面板 HTTP 接口（POST /api/forlife/feed）'],
  ['packages/dsh-component/src/feed-tools.ts', '④ 模型工具 feed_memory'],
]

test('★★ 四条入口都调同一个核心 `feedMemory`（没有第二条管道）', () => {
  for (const [rel, what] of ENTRIES) {
    assert.match(code(rel), /feedMemory\(/, `${what}（${rel}）必须调用 feedMemory —— 不许各写一套`)
  }
})

test('★★ 四条入口都不直接碰记忆的写入/检索原语（那些只在核心那一侧）', () => {
  const primitives = ['insertLongEntry(', 'appendMidEntry(', 'searchLongFts(', 'searchMidFts(']
  for (const [rel, what] of ENTRIES) {
    const source = code(rel)
    for (const primitive of primitives) {
      assert.ok(
        !source.includes(primitive),
        `${what}（${rel}）里出现了 ${primitive} —— 入口只该转发给 feedMemory；` +
          '自己写一套的后果是"这条入口喂进去的东西跟正常记忆长得不一样"',
      )
    }
  }
  // 反过来：核心那一侧必须复用它（否则"真实路径"就是空话）
  const core = code('packages/gateway/src/feed.ts')
  for (const required of ['insertLongEntry(', 'appendMidEntry(', 'searchLongFts(', 'searchMidFts(']) {
    assert.ok(core.includes(required), `核心 feed.ts 必须复用 ${required}`)
  }
})

test('★ 两条 HTTP 入口的路径就是用户点名的那两个', () => {
  assert.match(code('packages/dsh-component/src/api.ts'), /'\/api\/forlife\/feed'/, '面板接口路径必须是 /api/forlife/feed')
  assert.match(code('packages/gateway/src/admin/api.ts'), /route === '\/feed'/, '后台接口是 /api/admin/feed')
})

test('★ 删除没有新接口：指向既有的 memory-archive', () => {
  for (const [rel] of ENTRIES) {
    const source = code(rel)
    // 入口里不许出现"删除喂进来的东西"的接口路径（既有的是 /memory-archive，不在这些入口里）
    assert.ok(!/memory-delete|feed-delete|deleteFeed/i.test(source), `${rel} 不该有新删除接口`)
  }
  const core = readFileSync(join(REPO_ROOT, 'packages/gateway/src/feed.ts'), 'utf8')
  assert.match(core, /archiveLongMemory/, '核心里的"删"必须是既有的归档能力')
  assert.match(core, /memory-archive/, '指引要指名既有的接口（否则用户会去找一个不存在的删除入口）')
})

test('★ 核心从**基线**读参数（阈值不许写死在代码里）', () => {
  const core = code('packages/gateway/src/feed.ts')
  for (const key of [
    'feed.dedupeSimilarity',
    'feed.dedupeCandidates',
    'feed.probeChars',
    'feed.summaryMaxChars',
    'feed.maxItemsPerCall',
  ]) {
    assert.ok(core.includes(`'${key}'`), `核心必须经 defaultFor('${key}') 取默认值（写死的话改基线就撒谎）`)
  }
  // 阈值写死是最常见的一种：0.9 出现在 feed.ts 里就说明有人把它抄进了代码
  assert.ok(!/\b0\.9\b/.test(core), 'feed.ts 里不许出现写死的 0.9 阈值（要读 feed.dedupeSimilarity）')
})

test('★ 核心只有一份：没有人复制 `splitIntoFeedChunks` 之类的实现', () => {
  const core = code('packages/gateway/src/feed.ts')
  for (const exported of ['splitIntoFeedChunks', 'feedIdFor', 'feedScopeOf', 'feedMemory']) {
    assert.ok(core.includes(`export function ${exported}`) || core.includes(`export const ${exported}`), `核心要导出 ${exported}`)
  }
  for (const [rel, what] of ENTRIES) {
    assert.ok(
      !code(rel).includes('function splitIntoFeedChunks'),
      `${what}（${rel}）里复制了一份分块实现 —— 分块属于记忆系统本身（用户原话）`,
    )
  }
})
