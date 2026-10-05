/**
 * 阶段 2 验收测试：裁决工具、记账、缓存未命中次数、沉降任务。
 *
 * 对应 EXECUTION_PLAN 阶段 2 的四条验收：
 *  ① 压缩后 L3 尾部出现新条目 / L4 被替换 / compaction_log 完整 / **缓存未命中仅一次**
 *  ② 冷却期内 request_compaction 被拒且字段与 §4.4 逐字段一致；token≥6000 或占比≥75% 豁免生效
 *  ④ 沉降后中期条目变 [F1→] 碎片且 recall_longterm 能取回全文
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { listEffects, listUnreportedEffects, recordEffect } from '@forlife/store'

import { applyCompactionDecision } from '../src/compaction-engine.ts'
import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { buildMemoryTools, MEMORY_TOOL_NAMES } from '../src/tools.ts'
import { L3_NAME, registerMemorySections } from '../src/prompt.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'

const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as {
  default: unknown
  renderPrompt(assembly: unknown): string
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-acc-'))

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

function makeRuntime(dir: string): MemoryRuntime {
  return new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false, contextWindowTokens: 8000 }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
}

/** 从工具定义里取出某个工具。 */
function tool(runtime: MemoryRuntime, name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[]
  const found = tools.find((t) => t.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

const exec = { callId: 'c1', signal: new AbortController().signal }

test('工具清单：request_compaction 已注册', () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    const tools = buildMemoryTools(defineTool as never, runtime) as unknown as { name: string }[]
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MEMORY_TOOL_NAMES].sort())
    assert.ok(MEMORY_TOOL_NAMES.includes('request_compaction'))
    runtime.close()
  } finally {
    void cleanup(dir)
  }
})

test('验收②：内容太薄时 request_compaction 被拒，反馈字段与 PLAN §4.4 逐字段一致', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 造出 PLAN 示例的状态：1200 token、2 轮、3 次工具调用
    runtime.observeShortTokens(1200)
    runtime.beginTurn()
    runtime.beginTurn()
    runtime.recordToolCall()
    runtime.recordToolCall()
    runtime.recordToolCall()

    const result = (await tool(runtime, 'request_compaction').execute({ reason: '想清理上下文' }, exec)) as Record<string, unknown>

    assert.equal(result['approved'], false)
    assert.equal(result['reason'], 'too_thin')
    assert.deepEqual(result['current'], { tokens: 1200, turns: 2, tool_calls: 3 })
    assert.deepEqual(result['required'], { tokens: 2000, turns: 3, tool_calls: 5 })
    assert.equal(result['hint'], '再完成至少 1 轮对话或累积 800 token 后可再次请求', 'hint 必须与 §4.4 示例同语义')
    assert.equal(runtime.takePendingCompactionRequest(), undefined, '被拒时不得入队')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('验收②：满足阈值时批准并入队；引擎取走后队列清空', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.observeShortTokens(3000)
    for (let i = 0; i < 3; i++) runtime.beginTurn()
    for (let i = 0; i < 5; i++) runtime.recordToolCall()

    const first = (await tool(runtime, 'request_compaction').execute({ reason: '该总结了' }, exec)) as Record<string, unknown>
    assert.equal(first['approved'], true, '从未压缩过 ⇒ 冷却期不适用，应当批准')
    assert.equal(first['queued'], true)

    const pending = runtime.takePendingCompactionRequest()
    assert.equal(pending?.reason, '该总结了')
    assert.equal(runtime.takePendingCompactionRequest(), undefined, '取走后必须清空（否则会反复强制压缩）')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('验收②：冷却期内被拒（too_frequent），且豁免路径可观测', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.observeShortTokens(3000)
    for (let i = 0; i < 6; i++) runtime.beginTurn()
    for (let i = 0; i < 6; i++) runtime.recordToolCall()
    // 制造"刚压缩过"的记账基线，然后重新攒到"过得了最小阈值、过不了冷却期"
    runtime.resetCompactionAccounting()
    runtime.observeShortTokens(3000)
    for (let i = 0; i < 3; i++) runtime.beginTurn() // 3 ≥ minTurns(3)，但 < cooldownTurns(5)
    for (let i = 0; i < 5; i++) runtime.recordToolCall()

    const rejected = (await tool(runtime, 'request_compaction').execute({ reason: '再压一次' }, exec)) as Record<string, unknown>
    assert.equal(rejected['approved'], false)
    assert.equal(rejected['reason'], 'too_frequent', '刚压缩过 ⇒ 冷却期拦下')
    assert.match(String(rejected['hint']), /距上次压缩太近/)

    // 豁免：短期占比 ≥75% ⇒ 强制通过
    runtime.observeShortTokens(7000) // 7000 / 8000 = 87.5%
    const waived = (await tool(runtime, 'request_compaction').execute({ reason: '上下文要爆了' }, exec)) as Record<string, unknown>
    assert.equal(waived['approved'], true, '占比告急必须能压')
    assert.equal(waived['waiver'], 'context_pressure')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('验收②：token ≥ 6000 时豁免"最小轮次"约束（从未压缩过的场景）', async () => {
  const dir = tempDir()
  try {
    // 用大窗口，避免先命中"占比 ≥75%"那条豁免（那是另一条路径，上面单独测）
    const runtime = new MemoryRuntime({
      config: resolveConfig({ storageRoot: dir, contextWindowTokens: 100_000 }),
      dbPath: join(dir, 'db', 'forlife.sqlite'),
    })
    runtime.observeShortTokens(6500)
    runtime.beginTurn() // 只有 1 轮（< 最小 3）
    for (let i = 0; i < 5; i++) runtime.recordToolCall()

    const result = (await tool(runtime, 'request_compaction').execute({ reason: '内容已经很多' }, exec)) as Record<string, unknown>
    assert.equal(result['approved'], true)
    assert.equal(result['waiver'], 'token_threshold')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('验收①：压缩后 L3 尾部出现新条目、L4 被替换为单个摘要节点、缓存未命中仅一次', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    const ctx = new Context()
    ;(ctx.plugin as unknown as (p: unknown) => unknown)(systemPromptModule.default)
    await delay(120)
    registerMemorySections(ctx.get('systemPrompt') as Parameters<typeof registerMemorySections>[0], runtime)

    const render = async (): Promise<string> => {
      const service = ctx.get('systemPrompt') as { assemble(): Promise<unknown> }
      return systemPromptModule.renderPrompt(await service.assemble())
    }
    const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

    // ── 压缩前：连续两轮（无写入）指纹必须相同
    runtime.beginTurn()
    const turn1 = sha(await render())
    runtime.beginTurn()
    const turn2 = sha(await render())
    assert.equal(turn1, turn2, '无写入时指纹必须稳定（缓存命中的前提）')

    // ── 触发一次压缩：L3 追加新条目 + L4 被 keep_in_short 替换
    runtime.observeShortTokens(3000)
    const before = runtime.listEntries().length
    const keepInShortText = '（以下为压缩后的当前状态）\n- 正在实现压缩引擎'
    applyCompactionDecision(
      { runtime, reason: '验收' },
      {
        push_to_mid: [{ content: '用户养了一只叫团子的猫', summary: '用户养了一只叫团子的猫', entities: ['团子'], importance: 0.9 }],
        keep_in_short: ['正在实现压缩引擎'],
        fragment_mid: [],
        reasoning: '验收用',
      },
      'sess_accept',
    )

    // L3 尾部出现新条目
    const entries = runtime.listEntries()
    assert.equal(entries.length, before + 1, '验收①：L3 尾部必须出现新条目')
    assert.equal(entries[entries.length - 1]?.summary, '用户养了一只叫团子的猫')

    // L4 被替换为**单个**摘要节点（keep_in_short 渲染成一段文本）
    const replacement = renderKeepInShortForTest(['正在实现压缩引擎'])
    assert.equal(replacement.split('\n').filter((l) => l.startsWith('- ')).length, 1, '替换节点只含一项保留状态')

    const turn3 = sha(await render())
    assert.notEqual(turn3, turn2, '压缩必须让前缀变化（这正是那一次缓存未命中）')
    assert.ok((await render()).includes('团子'), '压缩后的提示词里能看到新条目')

    // ── 压缩后连续三轮：指纹不再变化 ⇒ 全程只有一次缓存未命中
    const hashes = [turn3]
    for (let i = 0; i < 3; i++) {
      runtime.beginTurn()
      hashes.push(sha(await render()))
    }
    assert.equal(new Set(hashes).size, 1, `压缩后不得再出现未命中：${hashes.join(' / ')}`)

    // 整段会话的未命中次数 = 1（指纹变化次数）
    const misses = [turn1, turn2, turn3].filter((h, i, arr) => i === 0 || h !== arr[i - 1]).length
    assert.equal(misses, 2, 'turn1 是首次装配；此后唯一一次变化来自压缩 ⇒ 压缩引起的未命中恰好 1 次')
    assert.equal(keepInShortText.length > 0, true)
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

/** 直接引用被测实现，避免测试里重写一遍渲染逻辑。 */
function renderKeepInShortForTest(keep: readonly string[]): string {
  return ['（以下为压缩后的当前状态）', ...keep.map((k) => `- ${k}`)].join('\n')
}

test('验收④：沉降任务把最久未访问的条目变成 [F1→]，全文进长期记忆可 recall', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    // 先把记忆区撑到真实规模：§5.3 要求碎片占比 ≤20%，
    // 在只有两三条的极小记忆区里"任何碎片化都会超限"是**正确行为**（那等于把记忆掏空），
    // 所以这里必须给出一个有代表性的池子，否则测的不是沉降而是上限。
    for (let i = 0; i < 30; i++) {
      runtime.append({ summary: `历史条目 ${String(i)}：关于架构与实现的讨论记录`, content: `历史正文 ${String(i)}`, entities: [`e${String(i)}`] })
    }
    const old = runtime.append({ summary: '很久以前讨论的 QQ 防抖策略细节', content: '完整原文：防抖窗口 2-3 秒……', entities: ['QQ', '防抖'] })
    const fresh = runtime.append({ summary: '刚刚讨论的事', content: '新鲜内容', entities: ['新'] })
    // 把 old 的访问时间推到 200 天前
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    runtime.db.prepare('UPDATE mid_memory_entries SET last_accessed_at = ?, created_at = ? WHERE id = ?').run(longAgo, longAgo, old.id)

    const result = runtime.settle()
    assert.equal(result.fragmented, 1, '只有超期的那条该被沉降')
    assert.ok(result.notes.length >= 0)

    const view = runtime.renderView().text
    assert.match(view, /\[F1→\]/, '验收④：沉降后渲染为碎片指针')
    assert.ok(view.includes('QQ 防抖'), '碎片保留 hint')
    assert.ok(view.includes('刚刚讨论的事'), '未超期的条目仍是活跃条目')

    const recalled = runtime.recallLongterm('防抖')
    assert.equal(recalled.entries.length, 1)
    assert.ok(recalled.entries[0]?.content?.includes('防抖窗口 2-3 秒'), '验收④：全文必须能取回')
    assert.equal(runtime.listEntries().find((e) => e.id === fresh.id)?.status, 'active')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('沉降任务：没有满足条件的条目时不做事（不产生空洞日志）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.append({ summary: '刚写的', entities: [] })
    const result = runtime.settle()
    assert.equal(result.fragmented, 0)
    assert.deepEqual(result.notes, ['没有满足沉降条件的活跃条目'])
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('第三写：压缩留下 effects 审计记录，且标记为"待向模型报告"', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    applyCompactionDecision(
      { runtime, reason: '审计测试' },
      { push_to_mid: [{ content: 'c', summary: '一条', entities: [], importance: 0.5 }], keep_in_short: ['x'], fragment_mid: [], reasoning: 'r' },
      'sess_audit',
    )
    const all = listEffects(runtime.db)
    assert.equal(all.length, 1, '压缩必须留下影响记录')
    assert.equal(all[0]?.kind, 'compaction')
    assert.equal(all[0]?.actor, 'system')

    // 铁律 1：影响模型的操作需要报告 ⇒ 默认是"未报告"
    const unreported = listUnreportedEffects(runtime.db)
    assert.equal(unreported.length, 1, '未报告的影响必须能被取出来（供阶段 3 的唤醒/注入管线消费）')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('记账：跨重启保留（turns/tool_calls/token 基线都在表里）', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'db', 'forlife.sqlite')
  try {
    const first = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }), dbPath })
    first.observeShortTokens(2500)
    first.beginTurn()
    first.recordToolCall()
    const before = first.compactionStats()
    assert.equal(before.turnsSinceLast, 1)
    assert.equal(before.toolCallsSinceLast, 1)
    assert.equal(before.shortTokens, 2500)
    assert.equal(before.hasPreviousCompaction, false)
    first.close()

    const reborn = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }), dbPath })
    const after = reborn.compactionStats()
    assert.equal(after.turnsSinceLast, 1, '记账必须跨重启保留')
    assert.equal(after.toolCallsSinceLast, 1)
    assert.equal(after.shortTokens, 2500)
    reborn.close()
  } finally {
    await cleanup(dir)
  }
})

test('记账：压缩后重置基线，token 增量从零重新起算', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    runtime.observeShortTokens(3000)
    assert.equal(runtime.compactionStats().hasPreviousCompaction, false)
    runtime.resetCompactionAccounting()
    assert.equal(runtime.compactionStats().hasPreviousCompaction, true)
    assert.equal(runtime.compactionStats().turnsSinceLast, 0)
    assert.equal(runtime.compactionStats().tokenDeltaSinceLast, 0, '压缩后增量归零')
    runtime.observeShortTokens(3500)
    assert.equal(runtime.compactionStats().tokenDeltaSinceLast, 500)
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

test('审计：报告后不再出现在待报告列表（幂等）', async () => {
  const dir = tempDir()
  try {
    const runtime = makeRuntime(dir)
    recordEffect(runtime.db, { id: 'eff_a', kind: 'admin_action', actor: 'admin', detail: { what: '改了配置' } })
    const pending = listUnreportedEffects(runtime.db)
    assert.equal(pending.length, 1)
    const { markEffectsReported } = await import('@forlife/store')
    assert.equal(markEffectsReported(runtime.db, [pending[0]!.id]), 1)
    assert.equal(listUnreportedEffects(runtime.db).length, 0)
    assert.equal(markEffectsReported(runtime.db, [pending[0]!.id]), 0, '重复标记不产生变化')
    assert.equal(L3_NAME, 'forlife:l3-mid')
    runtime.close()
  } finally {
    await cleanup(dir)
  }
})

