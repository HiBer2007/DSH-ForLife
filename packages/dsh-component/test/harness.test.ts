/**
 * 阶段 1 验收台：**用真实的宿主服务**跑端到端断言。
 *
 * 这不是 mock 测试 —— 它加载真实的 `@deepseek-ai/dsh-system-prompt`、
 * 用真实的 `defineTool` 编译工具 schema、开真实的 SQLite 库，
 * 然后按验收标准逐条断言。
 *
 * 覆盖的验收项：
 *  A1 模型调 push_mid_memory → 下一轮 system prompt 里出现该条目（assemble + renderPrompt）
 *  A2 连续 3 轮无写入 → renderPrompt(assemble()) 的 SHA-256 完全不变
 *  A3 崩溃后重启 → 渲染结果与崩溃前一致（表是权威）
 *  A4 面板接口能列条目并按 epoch 过滤
 *  A5 工具 schema 能被宿主的 defineTool 真实编译（schema 写错会在这里炸）
 *  A6 事件声明以 ignorable 追加；无会话时静默跳过
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Config, resolveConfig } from '../src/config.ts'
import { buildPanelRoutes } from '../src/api.ts'
import { buildMemoryTools, MEMORY_TOOL_NAMES } from '../src/tools.ts'
import { emitForlifeEvent, FORLIFE_EVENT_TYPES } from '../src/events.ts'
import { L2_NAME, L3_NAME, registerMemorySections } from '../src/prompt.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-harness-'))
const dbPath = join(tempRoot, 'db', 'forlife.sqlite')

/** 真实的 system-prompt 插件（进程内加载）。 */
const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as {
  default: unknown
  renderPrompt(assembly: unknown): string
}

const ctx = new Context()
/**
 * 把插件装到指定上下文。
 *
 * cordis 的 `plugin()` 签名对插件对象要求很严（`Plugin<any>`），而我们从动态 import
 * 拿到的是 `unknown`；这里收窄成一个显式的小助手，**不 bind**（bind 会锁死 this，
 * 导致插件被装到另一个上下文）。
 */
function installPlugin(target: Context, pluginModule: unknown): void {
  const install = target.plugin as unknown as (p: unknown) => unknown
  install.call(target, pluginModule)
}
let runtime: MemoryRuntime
let disposeSections: () => void

before(async () => {
  installPlugin(ctx, systemPromptModule.default)
  await delay(120)
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: tempRoot, relativeAges: false }), dbPath })
  const systemPrompt = ctx.get('systemPrompt') as Parameters<typeof registerMemorySections>[0]
  assert.ok(systemPrompt !== undefined, '真实的 systemPrompt 服务必须可用（否则验收台本身失效）')
  disposeSections = registerMemorySections(systemPrompt, runtime)
  await delay(50)
})

after(async () => {
  disposeSections?.()
  runtime?.close()
  await cleanup(tempRoot)
})

/** 渲染当前系统提示词（真实装配 → 真实渲染）。 */
async function renderSystemPrompt(): Promise<string> {
  const systemPrompt = ctx.get('systemPrompt') as { assemble(): Promise<unknown> }
  return systemPromptModule.renderPrompt(await systemPrompt.assemble())
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 取出某个工具定义并按模型调用它的方式执行。 */
function toolByName(target: string): { execute(args: unknown, exec: unknown): Promise<unknown>; output: { render(args: never, value: never): unknown } } {
  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as {
    name: string
    execute(args: unknown, exec: unknown): Promise<unknown>
    output: { render(args: never, value: never): unknown }
  }[]
  const found = tools.find((t) => t.name === target)
  assert.ok(found !== undefined, `工具 ${target} 未定义`)
  return found
}

test('A5 工具 schema 能被真实 defineTool 编译（写错 schema 会在这里炸）', () => {
  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string }[]
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...MEMORY_TOOL_NAMES].sort(),
    '四个工具的注册名必须与清单一致',
  )
})

test('A1 调 push_mid_memory 后，下一轮 system prompt 里出现该条目', async () => {
  const before = await renderSystemPrompt()
  assert.ok(!before.includes('猫叫团子'), '测试前提：这条记忆此刻还不存在')

  // ① 模型调用 push_mid_memory（走真实 defineTool 定义的 execute）
  const tool = toolByName('push_mid_memory')
  const value = (await tool.execute(
    {
      entries: [
        { summary: '用户养了一只叫团子的猫', entities: ['团子'] },
        { summary: '用户偏好用 Rust 写系统工具' },
      ],
      scope: 'private:10001',
    },
    { callId: 'call_1', signal: new AbortController().signal },
  )) as { added: { id: string }[]; revision: number }

  assert.equal(value.added.length, 2)
  assert.ok(value.revision > 0, '写入必须推进渲染修订号')

  // ② 下一轮装配：条目必须出现在系统提示词里
  const after = await renderSystemPrompt()
  assert.ok(after.includes('团子'), '写入的条目必须出现在下一轮系统提示词里')
  assert.ok(after.includes('=== 中期记忆 ==='), 'L3 标题应随非空内容一起出现')
  assert.ok(after.includes('用户偏好用 Rust 写系统工具'))
  assert.ok(after.length > before.length, '提示词必须真的变长了')
})

test('A1b 工具的 render 是纯投影（不写库、可重复调用）', async () => {
  const tool = toolByName('remember')
  const revisionBefore = runtime.revision()
  const view = tool.output.render(undefined as never, {
    ok: true,
    id: 'mid_x',
    tokenCount: 12,
    midTokens: 34,
  } as never) as { type: string; text: string }[]
  assert.equal(view[0]?.type, 'text')
  assert.match(view[0]?.text ?? '', /已记住/)
  assert.equal(runtime.revision(), revisionBefore, 'render 不得产生任何写入')
})

test('A2 连续 3 轮无记忆写入时，系统提示词 SHA-256 完全不变', async () => {
  // 模拟三个轮次：每轮开始 → 装配 → 渲染，但**没有任何记忆写入**
  const hashes: string[] = []
  for (let turn = 0; turn < 3; turn++) {
    runtime.beginTurn()
    hashes.push(sha256(await renderSystemPrompt()))
  }
  assert.equal(new Set(hashes).size, 1, `三轮提示词出现字节差异：${hashes.join(' / ')}`)

  // 反证：一旦发生写入，指纹必须改变（否则上面那条可能是因为"提示词根本没接上"）
  const tool = toolByName('remember')
  await tool.execute({ summary: '这一条会改变指纹' }, { callId: 'call_2', signal: new AbortController().signal })
  assert.notEqual(sha256(await renderSystemPrompt()), hashes[0], '写入后指纹必须变化')
})

test('A3 崩溃后重启：新进程渲染出的系统提示词与崩溃前逐字节一致', async () => {
  // 用**独立的库文件与独立的两套上下文**模拟两个进程，避免影响其它用例
  const crashDb = join(tempRoot, 'crash', 'forlife.sqlite')
  const promptOf = async (ctxN: Context, rt: MemoryRuntime): Promise<string> => {
    const sp = ctxN.get('systemPrompt') as Parameters<typeof registerMemorySections>[0]
    registerMemorySections(sp, rt)
    const service = ctxN.get('systemPrompt') as { assemble(): Promise<unknown> }
    return systemPromptModule.renderPrompt(await service.assemble())
  }
  const bootContext = async (): Promise<Context> => {
    const fresh = new Context()
    installPlugin(fresh, systemPromptModule.default)
    await delay(100)
    return fresh
  }
  const config = resolveConfig({ storageRoot: tempRoot, relativeAges: false })

  // ── 进程 A：写入 → 渲染 → 记录指纹
  const ctxA = await bootContext()
  const runtimeA = new MemoryRuntime({ config, dbPath: crashDb })
  await runtimeA.append({ summary: '崩溃前写入的一条事实' }).id
  const promptBefore = await promptOf(ctxA, runtimeA)
  assert.ok(promptBefore.includes('崩溃前写入的一条事实'))
  runtimeA.close() // ← 进程被杀：不清理任何内存态（本来也没有第二份真源）

  // ── 进程 B：全新上下文 + 全新运行时，指向同一个库文件
  const ctxB = await bootContext()
  const runtimeB = new MemoryRuntime({ config, dbPath: crashDb })
  try {
    const promptAfter = await promptOf(ctxB, runtimeB)
    assert.equal(promptAfter, promptBefore, '重启后渲染出的提示词必须逐字节一致')
  } finally {
    runtimeB.close()
  }
})

test('A4 面板接口：能列条目并按 epoch 过滤', async () => {
  const routes = buildPanelRoutes(runtime)
  const names = routes.map((r) => r.path).sort()
  assert.deepEqual(names, [
    '/api/forlife/compaction',
    '/api/forlife/entries',
    '/api/forlife/health',
    '/api/forlife/spills',
    '/api/forlife/state',
  ])

  const entriesRoute = routes.find((r) => r.path === '/api/forlife/entries')
  assert.ok(entriesRoute !== undefined)

  // 不过滤：默认列出**全部 epoch** 的条目（L3 是跨压缩累积的，默认只列当前 epoch 会误导）
  const all = (await (await entriesRoute.fetch(new Request('http://local/api/forlife/entries'))).json()) as {
    ok: boolean
    epoch: number | null
    count: number
    entries: { id: string; epoch: number; summary: string }[]
  }
  assert.equal(all.ok, true)
  assert.ok(all.count >= 3, `应至少列出 3 条，实际 ${String(all.count)}`)
  assert.equal(all.epoch, null, '未按 epoch 过滤时应回显 null（而不是假装在用当前 epoch）')

  // 按 epoch 过滤：当前 epoch 有数据，别的 epoch 必须是空
  const other = (await (
    await entriesRoute.fetch(new Request(`http://local/api/forlife/entries?epoch=${String(runtime.epoch() + 7)}`))
  ).json()) as { count: number; epoch: number }
  assert.equal(other.count, 0, '不存在的 epoch 必须返回空列表')
  assert.equal(other.epoch, runtime.epoch() + 7, '回显的 epoch 必须是查询参数里的那个')

  // 按 status 过滤
  const actives = (await (
    await entriesRoute.fetch(new Request('http://local/api/forlife/entries?status=active'))
  ).json()) as { entries: { status: string }[] }
  assert.ok(actives.entries.every((e) => e.status === 'active'))

  // 状态接口
  const stateRoute = routes.find((r) => r.path === '/api/forlife/state')
  const state = (await (await stateRoute!.fetch(new Request('http://local/api/forlife/state'))).json()) as {
    revision: number
    renderedSha256: string
    dbPath: string
  }
  assert.equal(state.renderedSha256, runtime.renderView().sha256, '面板展示的指纹必须与运行时一致')
  assert.equal(state.dbPath, dbPath)
})

test('A6 会话事件以 ignorable 追加；无会话时静默跳过', () => {
  const appended: { type: string; data: unknown; opts: unknown }[] = []
  const session = {
    append(type: string, data: unknown, opts?: { ignorable?: true }): void {
      appended.push({ type, data, opts })
    },
  }
  assert.equal(emitForlifeEvent(session, 'forlife.render.changed', { epoch: 0, revision: 1, sha256: 'x', activeCount: 1, fragmentCount: 0 }), true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0]?.opts?.['ignorable' as never], true as never, '未登记事件必须带 ignorable: true，否则宿主会拒绝')

  // 没有会话不该抛错（记忆写入是权威的，事件只是旁路记录）
  assert.equal(emitForlifeEvent(undefined, 'forlife.render.changed', {}), false)
  // 会话 append 抛错也不该让调用方崩
  assert.equal(emitForlifeEvent({ append: () => { throw new Error('session closed') } }, 'forlife.render.changed', {}), false)

  assert.ok(FORLIFE_EVENT_TYPES.every((t) => t.startsWith('forlife.')), '事件命名必须带 forlife. 前缀')
})

test('配置：默认值来自基线，且 volatile 字段被正确归一化', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.recallMaxResults, 3, 'recall.maxResults 基线值必须生效')
  assert.equal(resolved.recallMaxPerTurn, 2)
  assert.equal(resolved.timeZone, 'UTC', '系统时区默认 UTC')
  assert.equal(resolved.relativeAges, true)

  // volatile 字段（storageRoot / l2IndexText）在 schema 上是引用对象，归一化后必须是裸值
  const fromSchema = Config({}) as unknown as { storageRoot: unknown; l2IndexText: unknown }
  assert.equal(typeof fromSchema.storageRoot, 'object', '未归一化时 storageRoot 是 Volatile 引用（这正是要归一化的原因）')
  const normalized = resolveConfig(fromSchema as never)
  assert.equal(normalized.storageRoot, 'forlife', '归一化后必须拿到裸字符串')
  assert.ok(normalized.l2IndexText.includes('长期记忆'), 'L2 手册默认文案必须可用')
  assert.equal(L2_NAME, 'forlife:l2-index')
  assert.equal(L3_NAME, 'forlife:l3-mid')
})

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




