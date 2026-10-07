/**
 * `recall_longterm` 的**冷层按需加载**（PLAN §6.3 的"回读"）测试。
 *
 * ## 为什么这个文件必须存在
 *
 * 仓库里早就有两条"能取回全文"的测试
 * （`compaction-engine.test.ts` / `acceptance-phase2.test.ts`），但它们
 * **直接调 `runtime.recallLongterm()` 再断言 `entries[0].content`** ——
 * 那**证明不了"recall 能取回 HDD 条目"**：
 *
 *  1. 那条路径**不经过工具**，而模型只能通过工具拿到结果；
 *  2. 更根本的是：`recallLongterm` 只做 FTS 检索。沉降过的条目在 FTS 里**仍然命中**，
 *     但表内 `content` 是 NULL ⇒ **直接调它拿到的就是一条空正文**。
 *
 * 所以这里补两条**走真实路径**的：
 *  - 用 `settleLongEntries` 真的把条目沉到 HDD，再调**工具**的 `execute`，断言正文回来了；
 *  - 归档坏掉时，断言**明确报错**、且**绝不回落到库内副本**。
 *
 * 外加**接线守卫**（读源码断言调用点存在）—— 本项目已经栽过四次
 * "功能写好了、测试全绿、而线上根本没跑"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { insertLongEntry, loadStats, settleLongEntries } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { buildMemoryTools, COLD_CONTENT_MAX_CHARS, type DefineToolLike } from '../src/tools.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-recall-cold-'))

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

/** 一条被捕获的工具定义（只声明我们读的部分）。 */
interface CapturedTool {
  readonly name: string
  readonly output: { readonly render: (args: never, value: never) => readonly { readonly type: string; readonly text: string }[] }
  execute(args: never, exec?: unknown): Promise<unknown>
}

/** 用替身 `defineTool` 捕获工具定义（**不 mock 工具本体** —— 跑的是真实 execute）。 */
function captureTools(runtime: MemoryRuntime): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>()
  const fake = ((options: CapturedTool): unknown => {
    captured.set(options.name, options)
    return options
  }) as unknown as DefineToolLike
  buildMemoryTools(fake, runtime)
  return captured
}

const DAY = 86_400_000

/** 造一条 100 天没访问的长期条目（真实写入路径 ⇒ FTS 索引也在）。 */
function addOldLong(runtime: MemoryRuntime, id: string, content: string): void {
  insertLongEntry(runtime.db, { id, content, summary: `摘要 ${id}` })
  const old = new Date(Date.now() - 100 * DAY).toISOString()
  runtime.db.prepare('UPDATE long_memory_entries SET created_at = ?, last_accessed_at = ? WHERE id = ?').run(old, old, id)
}

/** 取 `recall_longterm` 工具，跑一次真实 execute。 */
async function recallViaTool(runtime: MemoryRuntime, query: string): Promise<{
  readonly results: readonly { readonly id: string; readonly summary: string; readonly tier: string; readonly content?: string }[]
  readonly note?: string
  readonly rendered: string
}> {
  const tools = captureTools(runtime)
  const tool = tools.get('recall_longterm')
  assert.ok(tool !== undefined, '**recall_longterm 工具必须注册出来**')
  const value = (await tool.execute({ query, limit: 3 } as never)) as {
    results: { id: string; summary: string; tier: string; content?: string }[]
    note?: string
  }
  const blocks = tool.output.render({ query } as never, value as never)
  return { ...value, rendered: blocks.map((b) => b.text).join('\n') }
}

test('★★ 真实路径：沉降到 HDD 的条目，recall_longterm 仍能取回正文（E-1 + E-2 合起来才成立）', async () => {
  const dir = tempDir()
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  try {
    addOldLong(runtime, 'L1', '防抖窗口 2-3 秒，per-key mutex')
    // ① E-1：真的沉下去（正文移出库、归档落盘）
    const settled = await settleLongEntries({ db: runtime.db, coldRoot: join(dir, 'cold') })
    assert.equal(settled[0]?.action, 'settled')
    const row = runtime.db.prepare('SELECT content, storage_tier FROM long_memory_entries WHERE id = ?').get('L1')
    assert.equal(row?.content, null, '沉降后表内正文必须为空')
    assert.equal(row?.storage_tier, 'hdd')

    // ② E-2：模型走工具检索 —— 正文必须回来
    const value = await recallViaTool(runtime, '防抖')
    assert.equal(value.results.length, 1, '沉降过的条目**仍然要能被检索命中**')
    assert.equal(value.results[0]?.tier, 'hdd')
    assert.equal(
      value.results[0]?.content,
      '防抖窗口 2-3 秒，per-key mutex',
      '**必须按需加载回正文** —— 否则沉降 = 静默的数据丢失',
    )
    assert.ok(value.rendered.includes('per-key mutex'), '正文要真的渲染进模型可见内容里')

    // ③ 验收标准 #3：**延迟记录在案**（"可接受"必须是事实，不是感觉）
    const stats = loadStats(runtime.db)
    const hdd = stats.find((s) => s.tier === 'hdd')
    assert.ok(hdd !== undefined, '按需加载必须记一行延迟统计')
    assert.equal(hdd?.loads, 1)
    assert.ok((hdd?.lastMs ?? -1) >= 0)
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 归档坏了 ⇒ **明确告诉模型取不回来**，且绝不回落到库内副本', async () => {
  const dir = tempDir()
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  try {
    addOldLong(runtime, 'L1', '防抖：归档里的正文')
    const settled = await settleLongEntries({ db: runtime.db, coldRoot: join(dir, 'cold') })
    const archivePath = String(settled[0]?.archivePath)
    assert.ok(archivePath !== 'undefined')
    rmSync(archivePath, { force: true }) // 归档文件没了（盘坏了 / 被误删）
    // 库里**故意留一份副本**：用来证明"绝不回落到库内副本"这条纪律真的生效
    runtime.db.prepare("UPDATE long_memory_entries SET content = '库里的副本' WHERE id = 'L1'").run()

    const value = await recallViaTool(runtime, '防抖')
    assert.equal(value.results.length, 1, '命中还是要报出来（让模型知道"有过这条记忆"）')
    assert.equal(value.results[0]?.content, undefined, '**取不回来就不能给正文**（更不能把库内副本当成功）')
    assert.match(String(value.note), /取不回来/, '**必须明确告诉模型**，而不是静默返回空内容')
    assert.match(String(value.note), /L1/, '要说清是哪一条')
    assert.ok(value.rendered.includes('取不回来'), '这句必须真的出现在模型可见内容里')
    assert.ok(!value.rendered.includes('库里的副本'), '**绝不能回落到库内副本** —— 那会掩盖"归档坏了"')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ 直接调 `recallLongterm()`（旧测试的写法）**取不回冷层正文** —— 所以那种测试证明不了 HDD 可取回', async () => {
  const dir = tempDir()
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  try {
    addOldLong(runtime, 'L1', '防抖：正文在这里')
    await settleLongEntries({ db: runtime.db, coldRoot: join(dir, 'cold') })

    const sync = runtime.recallLongterm('防抖')
    assert.equal(sync.entries.length, 1, 'FTS 仍然命中（这正是坑所在）')
    assert.equal(sync.entries[0]?.content, null, '**同步检索拿到的正文是 NULL**')
    assert.equal(sync.coldLoaded, undefined, '同步检索不做 I/O（按需加载是异步的那一条路）')

    // ⚠️ 这里必须换一轮（`beginTurn()`）再查同一句：
    // PLAN §7.4 的重复查询检测会拒绝"同一轮里再查一次几乎相同的词"（`duplicate_query`），
    // 而本用例要比较的是**两条检索路径**（同步 vs 按需加载），不是在测那道闸门。
    // 换轮之后比对清单（queries_this_turn）清空，两次调用拿到的是同一个查询的同一批命中，
    // 变量只剩"走哪条路"这一个。
    runtime.beginTurn()
    // 同一次检索走按需加载那条路 ⇒ 正文回来
    const onDemand = await runtime.recallLongtermOnDemand('防抖')
    assert.equal(onDemand.entries[0]?.content, '防抖：正文在这里', '**按需加载那条路必须能取回**')
    assert.equal(onDemand.coldLoaded?.[0]?.source, 'archive', '如实报"从归档读的"')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ 冷层正文过长会被截断，并**如实标注**（不假装那是全文）', async () => {
  const dir = tempDir()
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  try {
    const long = `防抖${'x'.repeat(COLD_CONTENT_MAX_CHARS + 500)}`
    addOldLong(runtime, 'L1', long)
    await settleLongEntries({ db: runtime.db, coldRoot: join(dir, 'cold') })
    const value = await recallViaTool(runtime, '防抖')
    const content = String(value.results[0]?.content)
    assert.ok(content.length < long.length, '必须截断（一条旧日志不该把上下文顶掉）')
    assert.match(content, /已截断/, '**截断必须说出来** —— 否则模型会以为那就是全文')
    assert.ok(content.startsWith('防抖'), '保留的是**开头**（关键词命中的地方多半在前面）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ 没有冷层命中时不做额外 I/O（hot 条目不产生 coldLoaded、不记延迟）', async () => {
  const dir = tempDir()
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  try {
    addOldLong(runtime, 'L1', '防抖：热条目的正文')
    const onDemand = await runtime.recallLongtermOnDemand('防抖')
    assert.equal(onDemand.entries.length, 1)
    assert.equal(onDemand.coldLoaded, undefined, '没命中冷层就不该有那一项')
    assert.deepEqual(loadStats(runtime.db), [], '**不该有任何按需加载记录**（那说明根本没去读文件）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

// ── 接线守卫（读源码断言调用点存在）────────────────────────────────────
//
// 这种测试不好看，但它拦的正是"功能写好了、测试全绿、而线上根本没跑"。

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').split(/\r?\n/).join('\n')

test('★★ 接线守卫：`recall_longterm` 工具真的调了 recallLongtermOnDemand（不是同步那个）', () => {
  const src = read('../src/tools.ts')
  assert.ok(src.includes('await runtime.recallLongtermOnDemand(a.query, a.limit)'), '**工具必须走按需加载那条路**')
  assert.ok(!/runtime\.recallLongterm\(/.test(src), '**同步那个调用点必须消失** —— 它拿不到冷层正文')
})

test('★★ 接线守卫：按需加载真的调了 `loadLongEntry`（E-2 的调用点）', () => {
  const src = read('../src/runtime.ts')
  assert.ok(/^\s*loadLongEntry,$/m.test(src), '**导入了才算接上**（@forlife/store 的 import 列表里）')
  const methodAt = src.indexOf('async recallLongtermOnDemand(')
  const loadAt = src.indexOf('await loadLongEntry({', methodAt)
  assert.ok(methodAt > 0, '找不到 recallLongtermOnDemand')
  assert.ok(loadAt > methodAt, '**必须在按需加载那条路上调用 loadLongEntry**')
  assert.ok(src.includes("storage_tier === 'hdd'"), '只对 HDD 条目做 I/O（别把热条目也拖慢）')
  assert.ok(src.includes('this.recallLongterm(query, limit)'), '检索与预算**复用**同步那条路（两套预算迟早不一致）')
})

test('★★ 接线守卫：取不回来时要**明确告诉模型**（静默返回空内容 = 看起来像"记忆被删了"）', () => {
  const src = read('../src/runtime.ts')
  assert.ok(src.includes('取不回来'), '**失败必须显式说出来**')
  assert.ok(src.includes('ok: cold.found && cold.content !== undefined'), '成功/失败要如实记进 coldLoaded')
  assert.ok(src.includes('coldLoaded'), '结果里要带上"从哪读的、花了多久、读成没读成"')
})
