/**
 * **分层降噪（PLAN §3.2）的真实路径验收台**。
 *
 * ## 为什么不能用"直接调 spill() 再调 recall_full()"来验
 *
 * 那种测试**绕过真实写入路径**，于是"`spill()` 零调用"这种事故它永远发现不了 ——
 * 本项目已经栽过 4 次（功能写好、测试全绿、线上没跑）。
 *
 * 所以这里全部走**宿主真实的工具流水线**：
 *
 * ```
 *   defineTool（宿主真的）+ tools.register（真服务）+ tools.execute（真执行）
 *     → post-execute 瀑布 → finalizeContent（模型可见内容的最后一公里）→ 结果
 * ```
 *
 * 断言的是**模型最终看到的那份内容**：全文不在里面，只有 head + 溢出 id；
 * 然后拿真实注册的 `recall_full` 工具把全文取回来（**往返**）。
 *
 * 附：`@deepseek-ai/dsh-system-prompt` 是 `ToolRuntime` 的 inject 依赖，
 * 装真服务是为了让 `ctx.get('tools')` 真的可用（不是替身）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { buildMemoryTools } from '../src/tools.ts'
import {
  planToolResultSpill,
  registerToolResultSpill,
  resetToolSpillStats,
  SPILL_NOTICE_MARK,
  toolSpillStats,
  withToolResultSpill,
  type SpillSink,
} from '../src/tool-spill.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-spill-'))
let runtime: MemoryRuntime
let ctx: Context
let tools: {
  register(definition: unknown): () => void
  execute(input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }): Promise<{ isError: boolean; content: { type: string; text?: string }[] }>
}

/** 宿主流水线的结果内容（拼成文本，断言只看模型看见的那份）。 */
const textOf = (content: readonly { type: string; text?: string }[]): string =>
  content.map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('\n')

/** 一段"大结果"：可辨认的头 + 一坨必须被省略的正文。 */
function bigResultBytes(bytes: number): string {
  const head = ['HEAD-1 第一行', 'HEAD-2 第二行', 'HEAD-3 第三行'].join('\n')
  return `${head}\n${'B'.repeat(Math.max(0, bytes - head.length))}\nTAIL-MARK`
}

const threshold = (): number => defaultFor<number>('tool.spill.thresholdBytes')

before(async () => {
  const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as { default: unknown }
  const toolsModule = (await import('@deepseek-ai/dsh-tools')) as unknown as { default: unknown }
  ctx = new Context()
  const install = ctx.plugin as unknown as (p: unknown) => unknown
  install.call(ctx, systemPromptModule.default)
  await delay(200)
  install.call(ctx, toolsModule.default)
  await delay(200)
  const service = ctx.get('tools') as unknown as typeof tools | undefined
  assert.ok(service !== undefined, '真实的 tools 服务必须可用（否则验收台本身失效）')
  tools = service
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: tempRoot, relativeAges: false }), dbPath: join(tempRoot, 'db', 'forlife.sqlite') })
})

after(() => {
  runtime?.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

/** 数一数 spill 表里有多少行（**证据**：不是"函数被调用"，而是"真的落库了"）。 */
function spillRowCount(): number {
  const row = runtime.db.prepare('SELECT COUNT(*) AS n FROM spill_entries').get() as { n: number }
  return row.n
}

/** 定义一个"结果很大"的工具，并**经过统一接缝**注册到真实的宿主工具服务上。 */
function registerBigTool(name: string, bytes: number): () => void {
  const definition = withToolResultSpill(defineTool as never, runtime)({
    name,
    description: '测试用：结果很大',
    parameters: { n: { type: 'integer', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (): never[] => [{ type: 'text', text: bigResultBytes(bytes) }] as never[],
    },
    execute: async (): Promise<unknown> => ({ ok: true }),
  })
  return tools.register(definition)
}

test('★★ 真实路径：大结果落 spill，模型只看到 head + id（全文不进上下文）', async () => {
  resetToolSpillStats()
  const before = spillRowCount()
  const dispose = registerBigTool('spill_probe_big', threshold() * 3)
  try {
    const result = await tools.execute({ callId: 'call_spill_1', name: 'spill_probe_big', arguments: { n: 1 }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    const seen = textOf(result.content)

    assert.equal(spillRowCount(), before + 1, '**必须真的写进 spill_entries**（这正是原来缺的那一步）')
    assert.match(seen, /HEAD-1 第一行/, '头几行必须留下（模型还要能干活）')
    assert.ok(!seen.includes('TAIL-MARK'), '**全文不能进上下文** —— 末尾必须被省略')
    assert.ok(
      Buffer.byteLength(seen, 'utf8') <= threshold(),
      `截断后的内容（含提示）必须封顶在阈值内（实际 ${String(Buffer.byteLength(seen, 'utf8'))} 字节 > ${String(threshold())}）`,
    )
    assert.ok(seen.includes(SPILL_NOTICE_MARK), '必须告诉模型"结果过大、被分层降噪了"')
    assert.match(seen, /recall_full/, '**必须给出取回全文的工具名**（否则模型只能猜）')

    // 溢出 id 必须是**可用的**：拿它去读库，取回的必须是完整原文
    const row = runtime.db.prepare('SELECT id, content, tool_name FROM spill_entries ORDER BY created_at DESC LIMIT 1').get() as
      | { id: string; content: string; tool_name: string }
      | undefined
    assert.ok(row !== undefined, '溢出记录必须存在')
    assert.ok(seen.includes(row.id), '提示里的 id 必须与库里那条一致（写错就等于给了一个取不到的 id）')
    assert.equal(row.tool_name, 'spill_probe_big')
    assert.ok(row.content.includes('TAIL-MARK'), 'spill 里存的必须是**完整**原文')
    assert.ok(row.content.includes('HEAD-1 第一行'))

    // 内存里的读路径（runtime.recallFull）也要能取回全文
    const recalled = runtime.recallFull(row.id)
    assert.equal(recalled.found, true, '**recallFull 必须 found:true**（修好之前它永远是 false）')
    assert.equal(recalled.content, row.content)
    assert.equal(recalled.meta?.bytes, Buffer.byteLength(row.content, 'utf8'))
  } finally {
    dispose()
  }
})

test('★★ 往返：真实的 `recall_full` 工具能把被截断的全文取回来（found 不再是 false）', async () => {
  const dispose = registerBigTool('spill_probe_roundtrip', threshold() * 2)
  try {
    const result = await tools.execute({ callId: 'call_spill_2', name: 'spill_probe_roundtrip', arguments: { n: 1 }, signal: new AbortController().signal })
    const seen = textOf(result.content)
    const id = /id：(spill_[0-9a-f]+)/.exec(seen)?.[1]
    assert.ok(id !== undefined, `提示里必须有溢出 id：${seen.slice(-200)}`)

    // 用**真实注册的** recall_full 工具（与生产同一份定义）取回
    const definitions = buildMemoryTools(defineTool as never, runtime) as unknown as {
      name: string
      execute(args: unknown, exec: unknown): Promise<unknown>
    }[]
    const recallFull = definitions.find((tool) => tool.name === 'recall_full')
    assert.ok(recallFull !== undefined, 'recall_full 必须被注册')
    const value = (await recallFull.execute({ id }, { callId: 'call_spill_2b', signal: new AbortController().signal })) as {
      found: boolean
      content: string
      lines: number
    }
    assert.equal(value.found, true, '**这一条就是本次修复的验收点**：found 必须是 true')
    assert.match(value.content, /TAIL-MARK/, '取回的必须是完整原文（含被省略的尾部）')
    assert.match(value.content, /HEAD-1 第一行/)
    assert.ok(seen.includes(id), 'id 必须来自模型可见的那份提示')
  } finally {
    dispose()
  }
})

test('★ 阈值来自基线：刚好不超阈值的原样放行，超一点就落 spill', async () => {
  resetToolSpillStats()
  const below = rockBelow(threshold())
  const disposeBelow = registerBigTool('spill_probe_small', below)
  const disposeAbove = registerBigTool('spill_probe_exact', threshold() + 64)
  try {
    const small = await tools.execute({ callId: 'call_spill_3', name: 'spill_probe_small', arguments: { n: 1 }, signal: new AbortController().signal })
    const smallText = textOf(small.content)
    assert.ok(!smallText.includes(SPILL_NOTICE_MARK), '没超阈值就不能截（否则小结果也被塞进 spill 表）')
    assert.match(smallText, /TAIL-MARK/, '原样放行时尾部必须还在')

    const big = await tools.execute({ callId: 'call_spill_4', name: 'spill_probe_exact', arguments: { n: 1 }, signal: new AbortController().signal })
    assert.ok(textOf(big.content).includes(SPILL_NOTICE_MARK), '超阈值必须截')
  } finally {
    disposeBelow()
    disposeAbove()
  }
})

test('★★ `recall_full` 自己**不截断**（截它 = 永远拿不到全文）', () => {
  resetToolSpillStats()
  const before = spillRowCount()
  const plan = planToolResultSpill({
    runtime,
    toolName: 'recall_full',
    blocks: [{ type: 'text', text: bigResultBytes(threshold() * 4) }],
  })
  assert.equal(plan.kind, 'keep')
  assert.equal(spillRowCount(), before, 'recall_full 的结果不许落 spill')
})

test('★ 含非文本块（图片）的结果**原样放行** —— 截断它们等于毁内容', () => {
  resetToolSpillStats()
  const before = spillRowCount()
  const plan = planToolResultSpill({
    runtime,
    toolName: 'spill_probe_image',
    blocks: [
      { type: 'text', text: bigResultBytes(threshold() * 3) },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
    ],
  })
  assert.deepEqual(plan, { kind: 'keep', reason: 'non_text' })
  assert.equal(spillRowCount(), before)
})

test('★★ 钩子（tools/post-execute）：**先 next() 再替换**，且真的落库', async () => {
  resetToolSpillStats()
  const registered: { event: string; handler: (...args: unknown[]) => unknown; opts?: { prepend?: boolean } }[] = []
  const fakeCtx = {
    on: (event: string, handler: (...args: unknown[]) => unknown, opts?: { prepend?: boolean }): (() => void) => {
      registered.push({ event, handler, ...(opts === undefined ? {} : { opts }) })
      return () => undefined
    },
  }
  const disposers: (() => void)[] = []
  const mounted = registerToolResultSpill(fakeCtx, runtime, { log: () => undefined, always: () => undefined, disposers })
  assert.equal(mounted, true, '有 ctx.on ⇒ 必须挂上')
  assert.equal(disposers.length, 1, '必须交出反注册器（否则热重载会重复挂）')
  assert.equal(registered[0]?.event, 'tools/post-execute')
  assert.equal(registered[0]?.opts?.prepend, true, 'prepend：先跑才能看到别人处理后的最终内容')

  const order: string[] = []
  const huge = bigResultBytes(threshold() * 3)
  const decision = (await registered[0]?.handler(
    { name: 'pwsh', callId: 'call_hook_1' },
    { content: [{ type: 'text', text: huge }], isError: false },
    async (): Promise<unknown> => {
      order.push('next')
      return { kind: 'accept' }
    },
  )) as { kind: string; content?: { type: string; text?: string }[] }

  assert.deepEqual(order, ['next'], '**必须先委托 next()** —— 抢在它前面返回会吞掉别人的决定')
  assert.equal(decision.kind, 'accept')
  const seen = textOf(decision.content ?? [])
  assert.ok(seen.includes(SPILL_NOTICE_MARK), '宿主工具（pwsh 这类）的大结果也必须被接住')
  assert.ok(!seen.includes('TAIL-MARK'), '全文不能进上下文')
  assert.equal(spillRowCount() >= 1, true)
  const row = runtime.db.prepare("SELECT tool_name, tool_call_id FROM spill_entries WHERE tool_call_id = 'call_hook_1'").get() as
    | { tool_name: string; tool_call_id: string }
    | undefined
  assert.equal(row?.tool_name, 'pwsh', '要记清是谁的结果（面板与诊断都靠它）')

  // 别人的"阻止"决定必须原样放行（我们只改 accept）
  const blocked = await registered[0]?.handler(
    { name: 'pwsh', callId: 'call_hook_2' },
    { content: [{ type: 'text', text: huge }], isError: false },
    async (): Promise<unknown> => ({ kind: 'block', feedback: [{ type: 'text', text: '不许这么干' }] }),
  )
  assert.deepEqual(blocked, { kind: 'block', feedback: [{ type: 'text', text: '不许这么干' }] })

  // 带 value 的 accept（整值替换）也不能动它的 content
  const replaced = await registered[0]?.handler(
    { name: 'pwsh', callId: 'call_hook_3' },
    { content: [{ type: 'text', text: huge }], isError: false },
    async (): Promise<unknown> => ({ kind: 'accept', value: { ok: true } }),
  )
  assert.deepEqual(replaced, { kind: 'accept', value: { ok: true } })
})

test('★ `finalizeContent` 必须是 total：spill 抛错时**原样放行**并把失败记下来', async () => {
  resetToolSpillStats()
  const broken: SpillSink = {
    spill: () => {
      throw new Error('注入的落库故障')
    },
  }
  const errors: string[] = []
  const definitions = withToolResultSpill(defineTool as never, broken, { onError: (m) => errors.push(m) })({
    name: 'spill_probe_broken',
    description: '测试用：落库会失败',
    parameters: { n: { type: 'integer', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (): never[] => [{ type: 'text', text: bigResultBytes(threshold() * 2) }] as never[],
    },
    execute: async (): Promise<unknown> => ({ ok: true }),
  }) as unknown as { finalizeContent?: (exec: unknown, result: unknown) => readonly { type: string }[] | undefined }

  // 直接调宿主会调的那个回调（宿主文档：total、不抛、返回 undefined = 不改）
  const returned = definitions.finalizeContent?.(
    { name: 'spill_probe_broken', callId: 'c' },
    { content: [{ type: 'text', text: bigResultBytes(threshold() * 2) }], isError: false },
  )
  assert.equal(returned, undefined, '失败时必须"不改内容"，不能抛也不能返回半截内容')
  assert.equal(toolSpillStats().failed, 1, '失败必须计数（**不静默**）')
  assert.equal(errors.length, 1, '失败必须上报')
  resetToolSpillStats()
})

test('★★ 两层同时挂着（index.ts 接上钩子后的真实形态）：**只落 1 行、只有 1 个提示**', async () => {
  resetToolSpillStats()
  const before = spillRowCount()
  const disposers: (() => void)[] = []
  const mounted = registerToolResultSpill(ctx, runtime, { log: () => undefined, always: () => undefined, disposers })
  assert.equal(mounted, true, '真实上下文里也必须挂得上')
  const dispose = registerBigTool('spill_probe_both', threshold() * 3)
  try {
    const result = await tools.execute({ callId: 'call_spill_both', name: 'spill_probe_both', arguments: { n: 1 }, signal: new AbortController().signal })
    const seen = textOf(result.content)
    assert.equal(spillRowCount(), before + 1, '两层都挂着时只能落一行（落两行 = 一次调用给出两个 id，模型会疯）')
    assert.equal((seen.match(/结果过大（已分层降噪）/g) ?? []).length, 1, '提示只能出现一次（二次截断防护）')
    assert.ok(!seen.includes('TAIL-MARK'), '两层叠加也不能把全文漏回上下文')
  } finally {
    dispose()
    for (const off of disposers) off()
  }
})

/** 取一个"刚好低于阈值"的目标字节数（阈值本身很小的话保底 64）。 */
function rockBelow(limit: number): number {
  return Math.max(64, limit - 128)
}
