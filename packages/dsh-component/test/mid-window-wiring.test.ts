/**
 * **接线守卫**：中期记忆的渲染窗口（PLAN §1.2「上下文窗口中的稳定前缀」）。
 *
 * ## 为什么必须有这一条
 *
 * 这个缺陷的形状是本项目最熟的那一种：`selectMidWindow()` 这种纯函数**写了也可能没人调**
 * （本项目栽过 19 次"库代码写好了、生产零调用"）。而它的后果是**真机不可用**：
 *
 *  - `renderView()` 曾把 `listRenderableMidEntries()` 的**全表**渲染进系统提示词
 *    （实测 10,794 条 / 1,504,850 token）⇒ QQ 唤醒报
 *    `CONTEXT_WINDOW_EXCEEDED: pi-ai detected context overflow`；
 *  - 压缩要看"上下文占比"才触发，上下文一开始就爆 ⇒ **压缩永远不触发**
 *    （`compaction_epoch` 恒为 0、长期记忆恒为空）—— 四层流水线第一层堵死。
 *
 * 单元测试**抓不到这一类问题**（它们直接调纯函数，绕过 `renderView()`）。
 * 所以这里有三层：
 *  ① **读源码断言调用点在 `renderView()` 的代码路径上**（不好看，但拦的正是"线上根本没跑"）；
 *  ② **真库 + 真 `renderView()`**：喂真条目，看渲染出来的文本真的变短、真的丢旧留新；
 *  ③ **`epoch` 分桶那个坑**：压缩后新条目 `window_offset` 从 0 重来，
 *     窗口若只看 offset 就会把**最新的**记忆丢出去（这条最容易在实现里写错）。
 *
 * 每一层都做过"最小翻转"验证：把窗口绕过（让它直接返回全集），①的行为层与②③必须变红。
 *
 * @module forlife-memory/test/mid-window-wiring
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { appendMidEntry, bumpEpoch } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-midwindow-'))

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

/** 真运行时（真库、真表）。`log` 可收集，用来断言"丢了东西不静默"。 */
function makeRuntime(dir: string, options: { readonly verbose?: boolean; readonly log?: (m: string) => void } = {}): MemoryRuntime {
  return new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false, verbose: options.verbose ?? false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
}

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * 与 `packages/contracts/test/param-consumption.test.ts` 同一套做法、**必须**这么做：
 * 本项目栽过"锚点匹配到注释 ⇒ 结论正好相反"。这里的守卫要断言
 * `renderView()` **真的**调了窗口函数、**真的**从基线读预算 ——
 * 而这两件事在注释里都写着（本仓注释写得很细），不去注释就会自己满足自己。
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
 * 取 `renderView()` 方法体（**拆行数组**，见文件头：本项目栽过"锚点匹配到注释"）。
 *
 * 先剥注释、再按行定位两个锚点（方法签名 → 下一个顶层成员），**找不到就报错** ——
 * 静默返回空串会让后面的断言全部"通过"（那种绿是假绿）。
 */
function renderViewBody(): readonly string[] {
  const source = stripComments(read('../src/runtime.ts'))
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^\s{2}renderView\(\)\s*:\s*RenderedView\s*\{/.test(line))
  assert.ok(start >= 0, 'runtime.ts 里找不到 `renderView(): RenderedView {` 的定义行（接线被删了？）')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^\s{2}l2Text\(\)\s*:/.test(line))
  assert.ok(end >= 0, '`renderView()` 之后找不到下一个成员 `l2Text()` —— 方法体边界锚点失效，守卫会失去意义')
  return rest.slice(0, end)
}

// ════════════════════════════════════════════════════════════════════════════
// ① 源码守卫：窗口必须在 `renderView()` 的代码路径上
// ════════════════════════════════════════════════════════════════════════════

test('★★ 守卫：`renderView()` 真的调了窗口函数（只定义不调用 = 又是死代码）', () => {
  const body = renderViewBody()
  assert.ok(
    body.some((line) => line.includes('selectMidWindow(')),
    '`renderView()` 里必须真的调用 selectMidWindow(...) —— 否则中期记忆又被整表渲染进提示词',
  )
})

test('★★ 守卫：渲染的是**窗口的结果**，不是全表（把 `window.entries` 换回 `entries` 必须变红）', () => {
  const body = renderViewBody()
  const selectLine = body.findIndex((line) => line.includes('selectMidWindow('))
  const renderLine = body.findIndex((line) => /renderMidMemory\(\s*\w+\.entries\s*,/.test(line))
  assert.ok(selectLine >= 0, '必须先选出窗口')
  assert.ok(
    renderLine >= 0,
    '渲染调用必须吃窗口的 `.entries`（形如 `renderMidMemory(window.entries, {`）—— ' +
      '只调用窗口函数却继续渲染全集，等于窗口是个摆设',
  )
  assert.ok(selectLine < renderLine, '顺序必须是"先选窗口、再渲染窗口内容"')

  const joined = body.join('\n')
  assert.ok(
    !/renderMidMemory\(\s*entries\s*,/.test(joined),
    '**不许**把不过窗口的 `entries` 交给渲染 —— 那正是 1,504,850 token 进前缀的入口',
  )
})

test('★★ 守卫：预算读基线 `memory.midWindow.maxTokens`，不许写死数字', () => {
  const body = renderViewBody()
  assert.ok(
    body.some((line) => line.includes("defaultFor<number>('memory.midWindow.maxTokens')")),
    '预算必须来自 plan-baseline.json（本仓铁律：代码里的默认值只能从基线派生）',
  )
  assert.ok(
    !body.some((line) => /\b100_?000\b/.test(line)),
    '`renderView()` 里不许出现写死的 100000 —— 基线改了它不会跟着改',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ② 行为：真库 + 真 `renderView()`
// ════════════════════════════════════════════════════════════════════════════

test('★★ 端到端：真条目超预算 ⇒ 渲染出来的只有最新那几条，最旧的出窗口', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 4 条 × 30k = 120k > 100k 预算（条目 token 数用表口径显式给，不必真造 40 万字）
    for (let i = 0; i < 4; i += 1) {
      appendMidEntry(runtime.db, { id: `mid_${String(i)}`, summary: `记忆条目${String(i)}`, tokenCount: 30_000 })
    }

    const view = runtime.renderView()
    assert.equal(view.activeCount, 3, '4×30k 装不进 100k ⇒ 只渲染最新 3 条（修复前是 4 条全进）')
    assert.ok(view.text.includes('记忆条目3'), '最新的必须在窗口里')
    assert.ok(view.text.includes('记忆条目1'), '次新的也必须在')
    assert.ok(
      !view.text.includes('记忆条目0'),
      '**最旧的那条必须出窗口** —— 这正是"150 万 token 一次性进系统提示词"的入口',
    )
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★★ 端到端：压缩之后（epoch 递增、offset 从 0 重来）新记忆仍在窗口里', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 压缩前：epoch 0，offset 0..2
    for (let i = 0; i < 3; i += 1) {
      appendMidEntry(runtime.db, { id: `old_${String(i)}`, summary: `旧记忆${String(i)}`, tokenCount: 30_000 })
    }
    // 压缩事务：**先 bumpEpoch 再 push**（compaction-engine.ts 的 Step 4）
    bumpEpoch(runtime.db)
    // 压缩后：epoch 1，offset **从 0 重新开始**
    for (let i = 0; i < 3; i += 1) {
      appendMidEntry(runtime.db, { id: `new_${String(i)}`, summary: `新记忆${String(i)}`, tokenCount: 30_000 })
    }

    const view = runtime.renderView()
    assert.equal(view.activeCount, 3, '6×30k 装不进 100k ⇒ 只留 3 条')
    for (let i = 0; i < 3; i += 1) {
      assert.ok(view.text.includes(`新记忆${String(i)}`), `压缩刚 push 的"新记忆${String(i)}"必须在窗口里`)
    }
    assert.ok(
      !view.text.includes('旧记忆'),
      '**只按 window_offset 排序就会在这里翻车**：压缩后新条目的 offset 是 0/1/2（最小），' +
        '会被当成"最旧"丢出去、留下 offset 100 级的老条目 —— 窗口非空但永远看不到新记忆',
    )
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★ 端到端：丢东西**不静默**（verbose 时如实报出进/出条数与 token）', () => {
  const dir = tempDir()
  try {
    const logs: string[] = []
    const runtime = makeRuntime(dir, { verbose: true, log: (m) => logs.push(m) })
    for (let i = 0; i < 3; i += 1) {
      appendMidEntry(runtime.db, { id: `mid_${String(i)}`, summary: `条目${String(i)}`, tokenCount: 60_000 })
    }
    runtime.renderView()

    const line = logs.find((m) => m.includes('中期窗口'))
    assert.ok(line !== undefined, `窗口丢弃必须有日志（本仓纪律：不静默失败）—— 实际日志：${logs.join(' | ')}`)
    assert.match(line, /进 1 条 \/ 60000 token/)
    assert.match(line, /丢下 2 条 \/ 120000 token/)
    assert.match(line, /预算 100000 token/, '日志里的预算必须是基线值')
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★ 端到端：窗口不改变过滤口径（archived 不许被捞回来；跨 epoch 累积仍是既定设计）', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    appendMidEntry(runtime.db, { id: 'keep', summary: '保留的条目', tokenCount: 10 })
    appendMidEntry(runtime.db, { id: 'gone', summary: '已淘汰的条目', tokenCount: 10 })
    runtime.db.prepare("UPDATE mid_memory_entries SET status = 'archived' WHERE id = 'gone'").run()

    const view = runtime.renderView()
    assert.ok(view.text.includes('保留的条目'))
    assert.ok(!view.text.includes('已淘汰的条目'), 'status 过滤仍然生效：窗口只从可渲染条目里选')

    // 跨 epoch 累积：PLAN §2.2 的"只渲染当前 epoch"是**被有意否决**的那一支
    // （见 contracts/src/deviations.ts 的 §2.2/§4.2 登记）—— 窗口不改这件事。
    bumpEpoch(runtime.db)
    appendMidEntry(runtime.db, { id: 'next_epoch', summary: '下一个 epoch 的条目', tokenCount: 10 })
    const after = runtime.renderView()
    assert.equal(after.activeCount, 2, '老 epoch 的条目仍在渲染源里（L3 跨压缩累积，这是登记过的设计取舍）')
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('★ 端到端：窗口不重排 ⇒ 追加式前缀仍然稳定（缓存断点的前提）', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    appendMidEntry(runtime.db, { id: 'm0', summary: '第一条', tokenCount: 10 })
    appendMidEntry(runtime.db, { id: 'm1', summary: '第二条', tokenCount: 10 })
    const before = runtime.renderView()

    appendMidEntry(runtime.db, { id: 'm2', summary: '第三条', tokenCount: 10 })
    const after = runtime.renderView()

    assert.notEqual(after.sha256, before.sha256, '新条目必须真的进了渲染（revision 变了 ⇒ 缓存重算）')
    assert.ok(
      after.text.startsWith(before.text),
      '未超预算时新条目只能追加在**尾部**：旧前缀逐字节不变 —— 窗口若把新的排到最前，每次 append 都会改写整个前缀',
    )
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})
