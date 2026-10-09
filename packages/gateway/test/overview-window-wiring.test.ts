/**
 * 面板「活跃 token」的**窗口口径**接线守卫（用户 2026-10-09 裁定 ④）。
 *
 * ## 它拦的是什么
 *
 * `buildOverview()` 里那个 `activeTokens` 是**全表** `SUM(token_count)`
 * —— 真机 10,794 条 / **1,504,850** token。而真正进系统提示词的只有**窗口**里那一段
 * （基线 `memory.midWindow.maxTokens` = 100k）。两个数差 15 倍时，
 * 用户打开面板看到 1,505k，只会得出一个结论：**窗口没修好**。
 *
 * 所以这里守两件事，缺一不可：
 *  ① **数据面**：`buildOverview()` 真的给出窗口口径的数字，而且它与全表口径**对得上账**；
 *  ② **两端一致**：给数的那个函数（gateway）与显示它的那个视图（admin-ui）
 *     必须用**同一批字段** —— 只改一端的话，面板要么显示旧口径，要么显示 `undefined`。
 *
 * ## 为什么源码守卫是必须的（不是"测试写得不好看"）
 *
 * 这个缺陷的形状是"**函数写对了，但数字没被用上**"：
 * `selectMidWindow()` 完全可以被调用、结果被丢掉，然后 `windowTokens` 继续读全表 SUM ——
 * 那样**行为层看不出来**（面板本来就有数，只是数不对口径）。
 * 所以除了真库断言，还要读源码确认：
 *  - 调用点在 `buildOverview()` 的代码路径上；
 *  - 结果落在**语句位置**（`windowTokens: midWindow.tokens,`），不是只被读出来放着；
 *  - 预算读基线，不许写死数字。
 *
 * 每一层都做过"最小翻转"验证（注入缺陷 ⇒ 变红 ⇒ 还原 ⇒ 变绿），见交付报告。
 *
 * @module forlife-gateway/test/overview-window-wiring
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { appendMidEntry, openDatabase } from '@forlife/store'
import { defaultFor } from '@forlife/contracts'

import { buildOverview } from '../src/admin/overview.ts'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

/** 全新的内存库（迁移会自动建表）。见 `admin-queries-memory.test.ts` 同一套理由。 */
function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

/** 总览（只喂它必需的两个上下文项）。 */
function overviewOf(db: DatabaseSync) {
  return buildOverview(db, { dbPath: ':memory:', startedAt: Date.now() })
}

const readSource = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * 必须去注释：本仓注释写得很细，`windowTokens` 这类字段名在说明里反复出现 ——
 * 直接 `text.includes(...)` 会让守卫**自己满足自己**（本项目在
 * `param-consumption.test.ts` 与 `mid-window-wiring.test.ts` 上都栽过这个坑）。
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

/**
 * 取 `buildOverview()` 的函数体（去注释后按花括号配平）。
 *
 * ⚠️ **不能从签名行就开始配平**：`buildOverview` 的参数表里有一个**内联对象类型**
 * （`context: { … }`），那对花括号会让配平在函数体开始之前就归零 ⇒ 守卫只拿到
 * 签名、后面的断言全部落空。（第一版正是这么写的，四条守卫一起变红才发现。）
 * 所以先定位**函数体开头**那一行（`): Overview {`），再从它开始数。
 */
function buildOverviewBody(): readonly string[] {
  const lines = stripComments(readSource('../src/admin/overview.ts')).split('\n')
  const sigAt = lines.findIndex((line) => line.includes('export function buildOverview('))
  assert.ok(sigAt >= 0, 'overview.ts 里找不到 `export function buildOverview(` —— 接线被删了？')
  const bodyAt = lines.findIndex((line, index) => index > sigAt && /^\s*\):\s*\w+\s*\{/.test(line))
  assert.ok(bodyAt >= 0, '找不到 `): Overview {` 这一行（返回类型改了？守卫要跟着改，别静默通过）')
  const out: string[] = []
  let depth = 0
  for (let i = bodyAt; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    out.push(line)
    if (depth === 0) return out
  }
  assert.fail('`buildOverview()` 的花括号没有配平 —— 守卫取不到函数体，不能静默通过')
}

// ════════════════════════════════════════════════════════════════════════════
// ① 数据面：窗口口径真的算出来了，而且与全表口径对得上账
// ════════════════════════════════════════════════════════════════════════════

test('★★ 窗口口径 ≠ 全表口径：超预算时 `windowTokens` 必须**小于** `activeTokens`', () => {
  const db = freshDb()
  // 3 × 60k = 180k：100k 预算只装得下**最新一条**（60k），另外两条出窗口
  for (const id of ['m0', 'm1', 'm2']) {
    appendMidEntry(db, { id, summary: `记忆 ${id}`, tokenCount: 60_000 })
  }

  const overview = overviewOf(db)
  const memory = overview.memory

  assert.equal(memory.activeTokens, 180_000, '全表口径：三条都要算进来（诊断口径，不能删）')
  assert.equal(memory.windowTokens, 60_000, '窗口口径：只有最新那条进上下文')
  assert.ok(
    memory.windowTokens < memory.activeTokens,
    '两个口径必须真的不同 —— 相等就说明窗口口径又被全表 SUM 顶掉了（这正是修之前的样子）',
  )
  assert.equal(memory.windowEntries, 1, '窗口里 1 条')
  assert.equal(memory.windowDroppedEntries, 2, '窗口丢弃：2 条')
  assert.equal(memory.windowDroppedTokens, 120_000, '窗口丢弃：120k token')
  assert.equal(memory.windowDroppedByCount, 0, '这次是 token 预算在管（不是条数）')
})

test('★★ 账要平：窗口内 + 窗口外 = 全表（数字之间不能自相矛盾）', () => {
  const db = freshDb()
  for (const id of ['m0', 'm1', 'm2', 'm3']) {
    appendMidEntry(db, { id, summary: `记忆 ${id}`, tokenCount: 30_000 })
  }

  const memory = overviewOf(db).memory
  assert.equal(memory.activeTokens, 120_000)
  assert.equal(
    memory.windowTokens + memory.windowDroppedTokens,
    memory.activeTokens,
    '窗口内 token + 窗口丢弃 token 必须等于全表 token（否则面板上两个数互相打脸）',
  )
  assert.equal(
    memory.windowEntries + memory.windowDroppedEntries,
    memory.activeEntries,
    '窗口内条数 + 窗口丢弃条数必须等于全表 active 条数',
  )
  assert.equal(memory.windowMaxTokens, 100_000, '面板要能显示预算（读基线，不许在 overview.ts 里写死）')
  assert.ok(memory.windowMaxCount > 0, '条数上限也要如实给出来（它现在是窗口的第二道约束）')
})

test('★ 空库不抛、全 0（全新部署时面板第一眼不能是红的）', () => {
  const memory = overviewOf(freshDb()).memory
  assert.equal(memory.activeTokens, 0)
  assert.equal(memory.windowTokens, 0)
  assert.equal(memory.windowEntries, 0)
  assert.equal(memory.windowDroppedEntries, 0)
  assert.equal(memory.windowDroppedTokens, 0)
  assert.equal(memory.windowDroppedByCount, 0)
})

test('★ 预算读的是**基线**（面板显示的预算必须与渲染器用的是同一个数）', () => {
  const memory = overviewOf(freshDb()).memory
  assert.equal(memory.windowMaxTokens, defaultFor<number>('memory.midWindow.maxTokens'))
  assert.equal(memory.windowMaxCount, defaultFor<number>('memory.midWindow.maxCount'))
})

// ════════════════════════════════════════════════════════════════════════════
// ② 源码守卫：调用点在代码路径上、结果落在语句位置、预算读基线
// ════════════════════════════════════════════════════════════════════════════

test('★★ 守卫：`buildOverview()` 真的调了**渲染器同一个** `selectMidWindow()`', () => {
  const body = buildOverviewBody()
  assert.ok(
    body.some((line) => line.includes('selectMidWindow(')),
    '`buildOverview()` 必须真的调用 selectMidWindow(...) —— 在 SQL 里另写一套裁剪迟早与渲染器漂开',
  )
  assert.ok(
    body.some((line) => line.includes('listRenderableMidEntries(')),
    '候选集也必须与渲染器同源（`listRenderableMidEntries()` 带 status 过滤与排序）',
  )
})

test('★★ 守卫：窗口结果落在**语句位置**并被用（只调用不使用 = 数字还是旧的）', () => {
  const joined = buildOverviewBody().join('\n')
  const selectAt = joined.indexOf('selectMidWindow(')
  assert.ok(selectAt >= 0, '找不到窗口调用点，守卫会失去意义')

  // 五个字段都必须**取自窗口结果**。少一个，面板上那个格子就会退回旧口径。
  for (const field of [
    'windowEntries: midWindow.entries.length,',
    'windowTokens: midWindow.tokens,',
    'windowDroppedEntries: midWindow.droppedCount,',
    'windowDroppedTokens: midWindow.droppedTokens,',
    'windowDroppedByCount: midWindow.droppedByCount,',
  ]) {
    const at = joined.indexOf(field)
    assert.ok(at >= 0, `缺少语句 \`${field}\` —— 面板那个字段会退回旧口径或变成 undefined`)
    assert.ok(at > selectAt, `\`${field}\` 必须排在选出窗口**之后**（否则用的是上一次的结果）`)
  }

  // 反面：窗口字段绝不能再从 SQL 标量来（那正是"全表冒充窗口"的入口）
  assert.ok(
    !/window(Tokens|Entries|Dropped\w*)\s*:\s*scalar\(/.test(joined),
    'window* 字段**不许**由 `scalar(...)` 直接查出来 —— 它们只能来自窗口选取结果',
  )
})

test('★★ 守卫：全表口径**没被删**（用户明确要求留着，它是诊断口径）', () => {
  const joined = buildOverviewBody().join('\n')
  assert.ok(
    joined.includes('activeTokens: scalar('),
    '全表的 `activeTokens` 必须保留（1,505k 那个数正是从它看出来的）；删了就只剩窗口口径，排障时无从对照',
  )
  assert.ok(joined.includes('fragmentTokens: scalar('), '碎片全表 token 也要保留')
})

test('★★ 守卫：两个预算都读基线，`buildOverview()` 里不许写死数字', () => {
  const body = buildOverviewBody()
  assert.ok(
    body.some((line) => line.includes("defaultFor<number>('memory.midWindow.maxTokens')")),
    'token 预算必须来自 plan-baseline.json（本仓铁律：代码里的默认值只能从基线派生）',
  )
  assert.ok(
    body.some((line) => line.includes("defaultFor<number>('memory.midWindow.maxCount')")),
    '条数上限也必须来自基线 —— 写死 2000 的话基线改了它不会跟着改',
  )
  const hardcoded = body.filter((line) => /\b(100_?000|2000)\b/.test(line))
  assert.deepEqual(
    hardcoded,
    [],
    `\`buildOverview()\` 里不许出现写死的预算数字（100000 / 2000）：\n${hardcoded.join('\n')}`,
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 两端一致：给数的（gateway）与显示它的（admin-ui）必须用同一批字段
// ════════════════════════════════════════════════════════════════════════════

test('★★ 守卫：面板视图读的是**窗口**字段，不是旧的 `activeTokens`', () => {
  const view = stripComments(readSource('../../admin-ui/src/views/OverviewView.vue'))
  assert.ok(
    view.includes('d.memory.windowTokens'),
    '「活跃 token」卡必须读 `d.memory.windowTokens`（窗口口径）—— 继续读 activeTokens 就是没修',
  )
  assert.ok(
    view.includes('d.memory.windowDroppedTokens'),
    '必须显示"窗口丢弃了多少"（用户裁定 ④ 明确要求暴露它）',
  )
  assert.ok(
    view.includes('d.memory.activeTokens'),
    '全表口径也要显示（用户明确要求"别删，标清楚哪个是哪个"）',
  )
  // 「活跃 token」这个标签后面**紧接着**的 value 必须是窗口口径 ——
  // 光"文件里出现过 windowTokens"不够（它可能只出现在某个角落的提示里）。
  const activeCard = /label: '活跃 token',\s*\n\s*value: ([^,]+),/.exec(view)
  assert.ok(activeCard !== null, '找不到「活跃 token」卡的定义（标签或字段名改了？守卫要跟着改）')
  assert.equal(
    activeCard[1]?.trim(),
    'formatTokens(d.memory.windowTokens)',
    '「活跃 token」显示的值必须是窗口口径 —— 这正是用户看到 1,505k 时以为没修好的那个格子',
  )
})

test('★ 守卫：内嵌面板（DSH 侧）也在同一批字段上（两处面板不许一个新一个旧）', () => {
  const client = stripComments(readSource('../../dsh-component/client/index.js'))
  assert.ok(client.includes('state.windowTokens'), '内嵌面板的「活跃 token」也要改成窗口口径（state.windowTokens）')
  assert.ok(client.includes('state.windowDroppedTokens'), '内嵌面板也要暴露"窗口丢弃了多少"')
  assert.ok(client.includes('state.activeTokens'), '内嵌面板同样保留全表口径')
})
