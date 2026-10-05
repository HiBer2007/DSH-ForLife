/**
 * 压缩引擎测试。
 *
 * 分两层：
 *  - **落库层**（`applyCompactionDecision`）：用真库跑完整 Step 4，并注入故障验证回滚；
 *  - **引擎层**（`summarize`）：用 `Object.create(prototype)` 绕开 cordis Service 装配，
 *    只测方法逻辑（llm 调用形状、消息拼装、解析、返回值），并**如实标注**这一取舍。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import {
  buildCompactionInstruction,
  applyCompactionDecision,
  ForlifeCompactionEngine,
  setCompactionEngineHooks,
} from '../src/compaction-engine.ts'
import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { currentEpoch, getCompactionRun, listCompactionRuns } from '@forlife/store'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-engine-'))

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

/** 造一个带若干条目的运行时。 */
function makeRuntime(dir: string): MemoryRuntime {
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, relativeAges: false }), dbPath: join(dir, 'db', 'forlife.sqlite') })
  return runtime
}

test('指令：包含 L3 渲染全文、条目化清单、输出格式与质量约束', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.append({ summary: '用户养了一只叫团子的猫', entities: ['团子'] })
    runtime.append({ summary: '用户偏好用 Rust 写系统工具', entities: ['Rust'] })

    const instruction = buildCompactionInstruction(runtime, '上下文压力')

    assert.ok(instruction.includes('当前中期记忆（渲染全文'), '要带上 L3 渲染全文（与主对话逐字节一致）')
    assert.ok(instruction.includes('用户养了一只叫团子的猫'), '渲染全文里应含条目标题')
    assert.ok(instruction.includes('中期记忆条目化清单'), '要带上条目化清单')
    assert.ok(/mid_[0-9a-f]+/.test(instruction), '清单里必须给出条目 id（fragment_mid 只能填这些）')
    assert.ok(instruction.includes('push_to_mid'), '要给出输出格式')
    assert.ok(instruction.includes('keep_in_short'))
    assert.ok(instruction.includes('fragment_mid'))
    assert.ok(instruction.includes('reasoning'))
    assert.ok(instruction.includes('触发原因') && instruction.includes('上下文压力'))
    // §4.3 的质量约束必须在指令里明说
    assert.ok(instruction.includes('可独立理解'), '§4.3：必须可独立理解')
    assert.ok(instruction.includes('纯工具调用记录'), '§4.3：禁止纯工具记录')
    assert.ok(instruction.includes('允许 push_to_mid 为空数组'), '§4.3：允许空列表')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('落库：push_to_mid 追加到 L3、epoch 推进、日志与事务记录齐全', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.append({ summary: '压缩前的旧条目' })
    const epochBefore = currentEpoch(runtime.db)

    const stats = applyCompactionDecision(
      { runtime, reason: 'test' },
      {
        push_to_mid: [
          { content: '用户养了一只叫团子的猫，是橘猫', summary: '用户养了一只叫团子的猫', entities: ['团子'], importance: 0.9 },
          { content: '用户偏好用 Rust 写系统工具', summary: '用户偏好 Rust', entities: ['Rust'], importance: 0.7 },
        ],
        keep_in_short: ['正在实现压缩引擎'],
        fragment_mid: [],
        reasoning: '短期轨迹达 3000 token',
      },
      'sess_1',
      'cmp_1',
    )

    assert.equal(stats.pushed, 2)
    assert.equal(stats.epoch, epochBefore + 1, 'Step 4：compaction_epoch 必须 +1')

    const entries = runtime.listEntries()
    assert.equal(entries.length, 3, '旧条目 + 2 条新条目')
    // 新条目落在新 epoch，旧条目仍在旧 epoch（L3 累积）
    const newOnes = entries.filter((e) => e.compaction_epoch === epochBefore + 1)
    assert.equal(newOnes.length, 2)
    assert.ok(newOnes.some((e) => e.summary === '用户养了一只叫团子的猫'))
    // 窗口里能看到新条目（验收①：L3 尾部出现新条目）
    assert.ok(runtime.renderView().text.includes('团子'))

    const runs = listCompactionRuns(runtime.db)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.phase, 'committed', '成功路径必须提交事务')
    assert.equal(runs[0]?.epoch_to, epochBefore + 1)

    const log = runtime.compactionLog()
    assert.equal(log.length, 1, 'PLAN §4.5：压缩日志必须有记录')
    assert.equal(log[0]?.['approved'], 1)
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('落库：fragment_mid 把中期条目变 [F1→] 碎片，全文进长期记忆且可 recall_full', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    const appended = runtime.append({ summary: 'QQ bot 防抖合并策略与消息队列实现细节', content: '完整原文：防抖窗口 2-3 秒，per-key mutex……', entities: ['QQ', '防抖'] })
    // 先塞进长期记忆里可检索的全文（模拟沉降）
    const stats = applyCompactionDecision(
      { runtime, reason: 'test' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: [appended.id], reasoning: '该条目已不活跃' },
      'sess_1',
    )
    assert.equal(stats.fragmented, 1, '应碎片化 1 条')

    const entries = runtime.listEntries()
    const target = entries.find((e) => e.id === appended.id)
    assert.equal(target?.status, 'fragmented')
    assert.equal(target?.entry_type, 'fragment')
    assert.equal(target?.content, null, '碎片化后原文从表里移走（位置迁移，不是删除）')
    assert.ok(target?.fragmented_into?.startsWith('long_from_'), '碎片必须指向长期记忆 id')

    const view = runtime.renderView().text
    assert.match(view, /\[F1→\]/, '验收④：沉降后中期条目渲染为 [F1→] 碎片')
    assert.ok(view.includes('QQ bot 防抖'), '碎片保留 hint 作为方向指示')
    assert.ok(!view.includes('per-key mutex'), '碎片不保留全文（全文在长期记忆侧）')

    // 验收④：recall_longterm 能取回全文
    const recalled = runtime.recallLongterm('防抖')
    assert.equal(recalled.entries.length, 1, 'recall_longterm 必须能命中沉降后的条目')
    assert.ok(recalled.entries[0]?.content?.includes('per-key mutex'), '取回的必须是全文')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('落库：注入故障 ⇒ 回滚到调用前的完整状态（无半写条目）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.append({ summary: '原有条目 A' })
    const epochBefore = currentEpoch(runtime.db)
    const revisionBefore = runtime.revision()
    const countBefore = runtime.listEntries().length

    // 让第 2 次 append 抛错：模拟"写了一半就崩"
    let calls = 0
    const failing = {
      get db() { return runtime.db },
      listEntries: (o?: Parameters<MemoryRuntime['listEntries']>[0]) => runtime.listEntries(o),
      reason: 'inject',
      append: (input: Parameters<MemoryRuntime['append']>[0]) => {
        calls += 1
        if (calls === 2) throw new Error('注入的写入故障')
        return runtime.append(input)
      },
    } as unknown as MemoryRuntime

    assert.throws(
      () =>
        applyCompactionDecision(
          { runtime: failing, reason: 'inject' },
          {
            push_to_mid: [
              { content: 'a', summary: '第一条', entities: [], importance: 0.5 },
              { content: 'b', summary: '第二条', entities: [], importance: 0.5 },
            ],
            keep_in_short: [],
            fragment_mid: [],
            reasoning: 'inject',
          },
          'sess_x',
        ),
      /注入的写入故障/,
    )

    assert.equal(runtime.listEntries().length, countBefore, '半写条目必须被回滚掉')
    assert.equal(currentEpoch(runtime.db), epochBefore, 'epoch 必须退回')
    assert.ok(runtime.revision() > revisionBefore, '回滚也要推进修订号')
    const runs = listCompactionRuns(runtime.db)
    assert.equal(runs[0]?.phase, 'aborted', '失败事务必须标记 aborted')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('落库：fragment_mid 里的无效 id 被忽略（不炸、不写垃圾）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    const stats = applyCompactionDecision(
      { runtime, reason: 'test' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: ['mid_不存在', 'M5'], reasoning: 'r' },
      'sess_1',
    )
    assert.equal(stats.fragmented, 0, '不存在的 id 不该产生碎片')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('引擎 summarize：一次 stream、消息=前缀+指令、返回 keep_in_short 作为摘要', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    setCompactionEngineHooks({ resolveRuntime: () => runtime, reason: '单测' })

    const captured: Record<string, unknown>[] = []
    const fakeAgent = {
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
      session: {
        id: 'sess_engine',
        toolHistory: () => [],
      },
    }

    // 用原型对象绕开 Service 装配（见文件头说明）
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const engine = Object.create(ForlifeCompactionEngine.prototype) as {
      ctx: unknown
      config: Record<string, unknown>
      summarize(input: unknown, agent: unknown, signal?: AbortSignal): Promise<{ summary: { text: string }[]; provider: string; model: string; llmStreamCall: true }>
    }
    engine.config = { summarizationProvider: '', summarizationModel: '', maxTokens: 4096 }
    engine.ctx = {
      llm: {
        stream: (options: Record<string, unknown>): AsyncIterable<unknown> => {
          captured.push(options)
          return (async function* () {
            yield { type: 'text-delta', text: '{"push_to_mid":[{"content":"用户喜欢猫","summary":"用户喜欢猫","entities":["猫"],"importance":0.8}],"keep_in_short":["正在做压缩引擎"],"fragment_mid":[],"reasoning":"轨迹较长"}' }
          })()
        },
      },
    }

    const prefix = [{ role: 'user', content: [{ type: 'text', text: '历史消息' }] }]
    const result = await engine.summarize({ messages: prefix, tools: [{ name: 't' }] }, fakeAgent)

    assert.equal(captured.length, 1, '只允许一次 LLM 调用')
    const options = captured[0] as Record<string, unknown>
    assert.equal(options['purpose'], 'compaction', '必须标记 purpose=compaction（计量与日志要能区分辅助调用）')
    assert.equal(options['sessionId'], 'sess_engine')
    assert.equal(options['maxTokens'], 4096)
    assert.deepEqual(options['tools'], [{ name: 't' }], 'tools 必须原样复用（前缀缓存对齐）')
    const messages = options['messages'] as { role: string; source?: { kind?: string } }[]
    assert.equal(messages.length, 2, '前缀原样重放 + 追加一条指令')
    assert.equal(messages[0], prefix[0], '第一条消息必须是原样的前缀（引用相同 ⇒ 字节相同）')
    assert.equal(messages[1]?.role, 'user')
    assert.equal(messages[1]?.source?.kind, 'forlife:compaction-instruction', '铁律：绝不发 source.kind === "user"')

    assert.equal(result.llmStreamCall, true)
    assert.equal(result.provider, 'deepseek-official')
    assert.equal(result.model, 'deepseek-flash')
    assert.ok(result.summary.map((b) => b.text).join('').includes('正在做压缩引擎'), '摘要 = keep_in_short 的渲染')

    // 决策已落库
    assert.equal(runtime.listEntries().filter((e) => e.summary === '用户喜欢猫').length, 1)
    runtime.close()
    setCompactionEngineHooks({})
  } finally {
    await cleanup(dir)
  }
})

test('引擎 summarize：输出不合规 ⇒ 抛错且不写任何记忆（交给宿主重试）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.append({ summary: '原有条目' })
    const countBefore = runtime.listEntries().length
    setCompactionEngineHooks({ resolveRuntime: () => runtime })

    const engine = Object.create(ForlifeCompactionEngine.prototype) as {
      ctx: unknown
      config: Record<string, unknown>
      summarize(input: unknown, agent: unknown): Promise<unknown>
    }
    engine.config = { summarizationProvider: 'deepseek-official', summarizationModel: 'deepseek-flash', maxTokens: 1024 }
    engine.ctx = {
      llm: {
        stream: (): AsyncIterable<unknown> =>
          (async function* () {
            yield { type: 'text-delta', text: '抱歉，我不太确定该怎么压缩。' }
          })(),
      },
    }

    await assert.rejects(
      () => engine.summarize({ messages: [] }, { options: {}, session: { id: 's', toolHistory: () => [] } }),
      /压缩输出不合规/,
    )
    assert.equal(runtime.listEntries().length, countBefore, '不合规输出不得写进任何记忆')
    assert.equal(listCompactionRuns(runtime.db).length, 0, '不该留下事务记录（还没开始就失败了）')
    runtime.close()
    setCompactionEngineHooks({})
  } finally {
    await cleanup(dir)
  }
})

test('引擎 summarize：运行时未就绪 ⇒ 明确报错（不静默）', async () => {
  const engine = Object.create(ForlifeCompactionEngine.prototype) as {
    ctx: unknown
    config: Record<string, unknown>
    summarize(input: unknown, agent: unknown): Promise<unknown>
  }
  engine.config = {}
  engine.ctx = {}
  setCompactionEngineHooks({ resolveRuntime: () => undefined })
  await assert.rejects(
    () => engine.summarize({ messages: [] }, { options: {}, session: { id: 's', toolHistory: () => [] } }),
    /记忆运行时尚未就绪/,
  )
  setCompactionEngineHooks({})
})

test('事务记录：compaction_id 与 session_id 被写入（可对账）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    applyCompactionDecision(
      { runtime, reason: 'test' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: [], reasoning: 'r' },
      'sess_42',
      'cmp_42',
    )
    const run = getCompactionRun(runtime.db, listCompactionRuns(runtime.db)[0]?.id ?? '')
    assert.equal(run?.session_id, 'sess_42')
    assert.equal(run?.compaction_id, 'cmp_42')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})
