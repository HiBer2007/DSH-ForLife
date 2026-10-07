/**
 * **接线守卫 + 行为**：PLAN §7.1 的预算声明、§7.4 的周期硬上限、§7.5 的逃生通道、§6.3 的 `recover`。
 *
 * ## 为什么单独一个文件
 *
 * 这一批缺陷的共同形状还是它：**看起来都有、实际都不在链路上**。
 *  - §7.1：预算被**拍平**成 `{usedThisTurn, remainingThisTurn, remainingThisCycle}` ——
 *    没有 `budget` 对象、没有 `reset_at`、没有 `queries_this_turn`、没有 `hint`；
 *  - §7.4：`recall.maxPerCycle` 只被**读进来显示**，从不判断 ⇒ 周期额度形同建议；
 *  - §7.5：`request_recall_extension` **不在 33 个已注册工具里**，而耗尽提示却让模型去调它
 *    （并自称"阶段 4 开放"，而阶段 4 早已交付）；
 *  - §6.3：L2 提示词（**稳定前缀**）让模型"用 `recover` 提升回热层"，而 `recover` 不是工具，
 *    `markLongRecovered()` 全仓零调用。
 *
 * 单元测试抓不到这一类（它们直接调函数，绕过接线），所以这里有两层：
 *  ① **读源码断言调用点存在**（不好看，但拦的正是"线上根本没跑"）；
 *  ② **走工具的真实 `execute`**（不 mock 工具本体），断言返回值与库里的状态。
 *
 * 每一条都做过"最小翻转"验证：把接线去掉一个条件，它必须变红。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { insertLongEntry, settleLongEntries } from '@forlife/store'

import { applyCompactionDecision } from '../src/compaction-engine.ts'
import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime, appendBoundedQuery, RECALL_QUERY_MAX_CHARS, recallQueryLogLimit } from '../src/runtime.ts'
import { buildMemoryTools, MEMORY_TOOL_NAMES, type DefineToolLike } from '../src/tools.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-recall-budget-'))

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
    config: resolveConfig({ storageRoot: dir, relativeAges: false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
}

/** 一条被捕获的工具定义（只声明我们读的部分；**不 mock execute**）。 */
interface CapturedTool {
  readonly name: string
  readonly description: string
  readonly output: { readonly render: (args: never, value: never) => readonly { readonly type: string; readonly text: string }[] }
  execute(args: never, exec?: unknown): Promise<unknown>
}

function captureTools(runtime: MemoryRuntime): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>()
  const fake = ((options: CapturedTool): unknown => {
    captured.set(options.name, options)
    return options
  }) as unknown as DefineToolLike
  buildMemoryTools(fake, runtime)
  return captured
}

/** 某个函数的函数体（从签名切到下一个顶层 `export`/`}`）—— 源码守卫用，避免匹配到别处。 */
function bodyOf(src: string, signature: string, stopAt: string): string {
  const from = src.indexOf(signature)
  assert.ok(from > 0, `源码里找不到 ${signature}（接线被删了？）`)
  const to = src.indexOf(stopAt, from + signature.length)
  return src.slice(from, to > from ? to : undefined)
}

/** 调用 `recall_longterm` 工具（真实 execute + 真实 render）。 */
async function recallViaTool(
  runtime: MemoryRuntime,
  query: string,
  limit?: number,
): Promise<{
  readonly value: RecallValue
  readonly rendered: string
}> {
  const tool = captureTools(runtime).get('recall_longterm')
  assert.ok(tool !== undefined, '**recall_longterm 工具必须注册出来**')
  const args = { query, ...(limit === undefined ? {} : { limit }) }
  const value = (await tool.execute(args as never)) as RecallValue
  const rendered = tool.output.render(args as never, value as never).map((b) => b.text).join('\n')
  return { value, rendered }
}

/** `recall_longterm` 返回值里我们读到的部分（**含 PLAN §7.1 的 budget 与兼容用的平铺字段**）。 */
interface RecallValue {
  readonly ok: boolean
  readonly results: readonly { readonly id: string; readonly tier: string; readonly content?: string }[]
  readonly budget: {
    readonly used: number
    readonly limit: number
    readonly remaining: number
    readonly reset_at: string
    readonly queries_this_turn: readonly string[]
    readonly hint: string
    readonly per_turn: { readonly used: number; readonly limit: number; readonly remaining: number }
    readonly extension: { readonly grantedThisCycle: number; readonly maxPerRequest: number; readonly cooldownTurns: number }
  }
  readonly usedThisTurn: number
  readonly remainingThisTurn: number
  readonly remainingThisCycle: number
  readonly note?: string
}

/** 取某个工具并跑一次真实 execute。 */
async function runTool(runtime: MemoryRuntime, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = captureTools(runtime).get(name)
  assert.ok(tool !== undefined, `**${name} 工具必须注册出来**`)
  return (await tool.execute(args as never)) as Record<string, unknown>
}

/** 基线值（**测试里也不许出现魔法数字**：从 plan-baseline.json 派生）。 */
const MAX_PER_TURN = defaultFor<number>('recall.maxPerTurn')
const MAX_PER_CYCLE = defaultFor<number>('recall.maxPerCycle')
const EXT_MAX = defaultFor<number>('recall.extensionMax')
const EXT_COOLDOWN = defaultFor<number>('recall.extensionCooldownTurns')
const RESET_POLICY = String(defaultFor<unknown>('recall.resetPolicy'))

/** 用满**一周期的**额度（每轮上限有限 ⇒ 分若干轮用掉）。 */
function exhaustCycle(runtime: MemoryRuntime): void {
  let used = 0
  while (used < MAX_PER_CYCLE) {
    runtime.beginTurn()
    for (let i = 0; i < MAX_PER_TURN && used < MAX_PER_CYCLE; i++) {
      runtime.recallLongterm(`填额度 ${String(used)}`)
      used += 1
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ① PLAN §7.1 —— 预算声明的形状与真实性
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.1：recall_longterm 返回 `budget` 对象，六个 PLAN 字段齐全且数字自洽', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'L1', content: '防抖窗口 2-3 秒', summary: '防抖设计' })
    const { value } = await recallViaTool(runtime, '防抖')

    assert.equal(typeof value.budget, 'object', '**必须有 budget 对象**（PLAN §7.1 的形状）')
    for (const key of ['used', 'limit', 'remaining', 'reset_at', 'queries_this_turn', 'hint']) {
      assert.ok(Object.hasOwn(value.budget, key), `budget 缺字段 ${key}（PLAN §7.1 逐字要求）`)
    }
    assert.equal(value.budget.used, 1, '这一次检索已计入')
    assert.equal(value.budget.limit, MAX_PER_CYCLE, 'limit 取基线 recall.maxPerCycle（不写死数字）')
    assert.equal(value.budget.remaining, MAX_PER_CYCLE - 1, 'remaining 必须与 used/limit 自洽')
    assert.equal(
      value.budget.reset_at,
      RESET_POLICY,
      '**reset_at 必须读基线 recall.resetPolicy**（写死的话，改策略就撒谎）',
    )
    assert.deepEqual(value.budget.queries_this_turn, ['防抖'], 'queries_this_turn 要真的记下本轮查过什么')
    assert.ok(value.budget.hint.includes(String(value.budget.remaining)), 'hint 里的数字必须是真的')
    assert.match(value.budget.hint, /避免重复检索相近主题/, 'PLAN §7.1 样例里的这句要保留')
    assert.match(value.budget.hint, /将在下次压缩后重置/, 'reset_at=on_compaction ⇒ 文案必须说压缩后重置')
    assert.deepEqual(value.budget.per_turn, { used: 1, limit: MAX_PER_TURN, remaining: MAX_PER_TURN - 1 }, '第二轮额度也要如实报')
    assert.equal(value.budget.extension.maxPerRequest, EXT_MAX, '追加上限读基线 recall.extensionMax')
    assert.equal(value.budget.extension.cooldownTurns, EXT_COOLDOWN, '冷却读基线 recall.extensionCooldownTurns')
    assert.equal(value.budget.extension.grantedThisCycle, 0, '没申请过就是 0（不编造）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★★ §7.1：预算声明**也要渲染给模型看**（模型读的是 render，不是 execute 的返回值）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'L1', content: '防抖窗口 2-3 秒', summary: '防抖设计' })
    const { value, rendered } = await recallViaTool(runtime, '防抖')
    assert.match(rendered, /【额度】/, 'render 里必须带上额度行（否则模型永远读不到 hint）')
    assert.ok(rendered.includes(String(value.budget.remaining)), '渲染出来的剩余次数必须是真的')
    assert.match(rendered, /本轮已查/, 'render 里要给出"本轮已查过什么"（queries_this_turn）')
    assert.ok(rendered.includes('防抖'), '已查清单要包含刚才的查询词')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ §7.1 兼容性：平铺字段仍然保留（旧会话历史里读得到，删掉会让新旧两轮读法冲突）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const { value } = await recallViaTool(runtime, '随便查一下')
    assert.equal(value.usedThisTurn, 1)
    assert.equal(value.remainingThisTurn, MAX_PER_TURN - 1)
    assert.equal(value.remainingThisCycle, MAX_PER_CYCLE - 1)
    assert.equal(value.remainingThisCycle, value.budget.remaining, '平铺与 budget 同源（同一份计数，不可能互相矛盾）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 接线守卫：预算声明由 runtime 一处产出（工具层不许自己拼数字）', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /budget: result\.declaration/, '**budget 必须原样透传 runtime 的声明**')
  assert.ok(
    !/budget:\s*\{\s*used:\s*result/.test(tools),
    '工具层不能自己拼 budget（两处拼数字迟早自相矛盾）',
  )
  const runtime = read('../src/runtime.ts')
  assert.match(runtime, /reset_at: this\.recallResetPolicy\(\)/, '**reset_at 必须读策略，不许写死**')
  assert.match(runtime, /queries_this_turn: \[\.\.\.this\.queriesThisTurn\]/, 'queries_this_turn 必须来自真实记录')
})

// ════════════════════════════════════════════════════════════════════════════
// ② PLAN §7.4 —— 周期硬上限（maxPerCycle）真的拦
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.4：`recall.maxPerCycle` 是硬上限 —— 用满后**直接拒绝**（以前只显示不判）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    exhaustCycle(runtime)
    // 新一轮：**每轮额度是满的**，只有周期那道闸门能拦住它
    runtime.beginTurn()
    const { value } = await recallViaTool(runtime, '超额的一次')

    assert.deepEqual(value.results, [], '超限必须返回空结果（PLAN §7.2）')
    assert.equal(value.budget.used, MAX_PER_CYCLE, '周期额度已经用满')
    assert.equal(value.budget.remaining, 0)
    assert.equal(value.budget.per_turn.remaining, MAX_PER_TURN, '**每轮额度明明是满的** ⇒ 拦住它的一定是周期闸门')
    assert.match(value.note ?? '', /额度已用尽/, '必须明确说清为什么被拒（不静默失败）')
    assert.ok((value.note ?? '').includes('request_recall_extension'), '提示必须指向**真实存在**的逃生通道工具')
    assert.ok(value.budget.hint.includes('request_recall_extension'), 'budget.hint 也要指向它')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★★ §7.4 x §7.6：周期额度**不因新轮重置**，但压缩提交后归零（别弄坏 resetCycle 接线）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    exhaustCycle(runtime)
    runtime.beginTurn()
    const blocked = await recallViaTool(runtime, '再来一次')
    assert.deepEqual(blocked.value.results, [], '新轮不等于新周期 ⇒ 仍然要被拦')

    // 走真实的压缩提交路径（`compaction-engine.ts` 在事务 commit 后调 resetCompactionAccounting → resetCycle）
    applyCompactionDecision(
      { runtime, reason: '接线测试' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: [], reasoning: '测试' },
      'sess_budget',
    )
    const after = await recallViaTool(runtime, '压缩之后应当重新有额度')
    assert.equal(after.value.budget.used, 1, '**压缩完成 ⇒ 周期额度重置**（PLAN §7.6 reset_policy=on_compaction）')
    assert.equal(after.value.budget.remaining, MAX_PER_CYCLE - 1)
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 接线守卫：周期闸门真的在源码里（不是只算了 remainingThisCycle）', () => {
  const src = read('../src/runtime.ts')
  const body = bodyOf(src, 'recallLongterm(query: string', 'requestRecallExtension(input')
  assert.match(body, /this\.recallThisCycle >= maxPerCycle/, '**必须判断周期上限**（只计算不判断 = 形同建议）')
  assert.match(body, /effectiveMaxPerCycle\(\)/, '上限要取生效值（含追加额度）')
  // 反向守卫：`remainingThisCycle` 只被算出来、没被判断 —— 那正是修复前的样子
  assert.ok(
    !/remainingThisCycle\s*<=\s*0\s*\)\s*\{?\s*return/.test(body),
    '不许用"算出来的 remaining"代替闸门（读起来像闸门、实际不是）',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ PLAN §7.5 —— 逃生通道 request_recall_extension
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.5：工具真的注册了，且**空理由被拒**（不能让"随便什么理由"换额度）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const names = captureTools(runtime)
    assert.ok(names.has('request_recall_extension'), '**33 个工具里没有它**正是这次的缺陷，必须真的注册')
    assert.ok(MEMORY_TOOL_NAMES.includes('request_recall_extension'), '工具名清单也要包含它')

    for (const reason of ['', '   ', '嗯']) {
      const value = await runTool(runtime, 'request_recall_extension', { reason })
      assert.equal(value['granted'], false, `理由 ${JSON.stringify(reason)} 必须被拒`)
      assert.equal(value['reason'], 'reason_too_short')
      assert.equal(value['additional'], 0, '被拒就不该追加任何额度')
      assert.equal(value['perCycleLimit'], MAX_PER_CYCLE, '被拒后额度不变')
    }
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★★ §7.5：批准后额度**真的变宽**，并在下一次返回里如实告知', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    // 先把每轮额度用满（逃生通道的典型触发场景）
    runtime.beginTurn()
    runtime.recallLongterm('用掉每轮 1')
    runtime.recallLongterm('用掉每轮 2')
    const blocked = runtime.recallLongterm('再查就是第三次')
    assert.match(blocked.note ?? '', /本轮 recall 次数已达上限/, '前提：每轮额度确实用满了')

    const granted = await runTool(runtime, 'request_recall_extension', {
      reason: '要核对三天前的部署记录，现有信息不够',
    })
    assert.equal(granted['granted'], true, '理由够具体 ⇒ 批准')
    assert.equal(granted['additional'], EXT_MAX, '缺省追加数取基线 recall.extensionMax')
    assert.equal(granted['perTurnLimit'], MAX_PER_TURN + EXT_MAX, '每轮额度必须真的抬高')
    assert.equal(granted['perCycleLimit'], MAX_PER_CYCLE + EXT_MAX, '周期额度必须真的抬高')
    assert.equal(granted['cooldownTurns'], EXT_COOLDOWN)

    // PLAN §7.5「批准后…并在下次返回中告知」
    const after = await recallViaTool(runtime, '额度已经追加过了')
    assert.ok(!(after.value.note ?? '').includes('已达上限'), '**"批准"必须真的能查** —— 否则那句批准就是空话')
    assert.equal(after.value.budget.per_turn.limit, MAX_PER_TURN + EXT_MAX, '下次返回里要报出抬高后的每轮上限')
    assert.equal(after.value.budget.limit, MAX_PER_CYCLE + EXT_MAX, '下次返回里要报出抬高后的周期上限')
    assert.equal(after.value.budget.extension.grantedThisCycle, EXT_MAX, '追加记录也要如实报')
    assert.match(after.value.budget.hint, /已追加/, '提示里要说清额度从哪来')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §7.5：冷却按 `recall.extensionCooldownTurns` **轮次**维度，且拒绝时说清还差几轮', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const first = await runTool(runtime, 'request_recall_extension', { reason: '第一次申请，理由够长' })
    assert.equal(first['granted'], true)

    const again = await runTool(runtime, 'request_recall_extension', { reason: '马上再要一次额度' })
    assert.equal(again['granted'], false, '同一轮里再要必须被拒')
    assert.equal(again['reason'], 'too_frequent')
    assert.equal(again['cooldownRemainingTurns'], EXT_COOLDOWN, '要说清还差几轮')
    assert.match(String(again['hint']), /冷却中/)

    runtime.beginTurn()
    const oneTurnLater = await runTool(runtime, 'request_recall_extension', { reason: '过了一轮再要额度' })
    assert.equal(oneTurnLater['granted'], false, '只过 1 轮还不能再要')
    assert.equal(oneTurnLater['cooldownRemainingTurns'], EXT_COOLDOWN - 1)

    for (let i = 0; i < EXT_COOLDOWN - 1; i++) runtime.beginTurn()
    const afterCooldown = await runTool(runtime, 'request_recall_extension', { reason: '冷却结束，再申请一次' })
    assert.equal(afterCooldown['granted'], true, `冷却 ${String(EXT_COOLDOWN)} 轮后必须放行`)
    assert.equal(afterCooldown['grantedThisCycle'], EXT_MAX * 2, '累计追加要如实累加')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §7.5：`additional` 越界或非法 ⇒ **明确拒绝**（静默夹取会让模型以为要到了）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const tooMany = await runTool(runtime, 'request_recall_extension', {
      reason: '一口气要很多额度',
      additional: EXT_MAX + 1,
    })
    assert.equal(tooMany['granted'], false)
    assert.equal(tooMany['reason'], 'beyond_max')
    assert.equal(tooMany['perCycleLimit'], MAX_PER_CYCLE, '被拒后额度不变（不许静默夹到上限）')

    const zero = await runTool(runtime, 'request_recall_extension', { reason: '要零次额度', additional: 0 })
    assert.equal(zero['granted'], false)
    assert.equal(zero['reason'], 'bad_amount')

    const ok = await runTool(runtime, 'request_recall_extension', { reason: '只要一次就够用', additional: 1 })
    assert.equal(ok['granted'], true)
    assert.equal(ok['perCycleLimit'], MAX_PER_CYCLE + 1)
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §7.5：追加额度是**临时**的 —— 压缩提交后随周期一起归零', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    await runTool(runtime, 'request_recall_extension', { reason: '申请一份追加额度' })
    applyCompactionDecision(
      { runtime, reason: '接线测试' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: [], reasoning: '测试' },
      'sess_ext_reset',
    )
    const after = await recallViaTool(runtime, '压缩之后')
    assert.equal(after.value.budget.per_turn.limit, MAX_PER_TURN, '每轮额度回到基线')
    assert.equal(after.value.budget.limit, MAX_PER_CYCLE, '周期额度回到基线（追加不跨周期累积）')
    assert.equal(after.value.budget.extension.grantedThisCycle, 0, '追加记录也归零')
    // 归零之后冷却也重来（否则新周期第一次申请就被旧冷却挡住）
    const reRequest = await runTool(runtime, 'request_recall_extension', { reason: '新周期重新申请额度' })
    assert.equal(reRequest['granted'], true, '新周期不该继承上一个周期的冷却')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 接线守卫：两个"零引用"基线键真的被消费了，且提示不再指向"阶段 4 开放"', () => {
  const runtime = read('../src/runtime.ts')
  assert.match(runtime, /defaultFor<number>\('recall\.extensionMax'\)/, '`recall.extensionMax` 以前零引用，必须真的读')
  assert.match(
    runtime,
    /defaultFor<number>\('recall\.extensionCooldownTurns'\)/,
    '`recall.extensionCooldownTurns` 以前零引用，必须真的读',
  )
  const tools = read('../src/tools.ts')
  assert.match(tools, /name: 'request_recall_extension'/, '工具必须真的定义出来')
  assert.match(tools, /runtime\.requestRecallExtension\(/, 'execute 必须真的调 runtime（只定义不调用 = 又一根断线）')
  for (const [name, src] of [
    ['tools.ts', tools],
    ['runtime.ts', runtime],
  ] as const) {
    assert.ok(!src.includes('阶段 4 开放'), `**${name} 里不该再有"阶段 4 开放"** —— 那个阶段早已交付，而工具现在真的存在`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ④ PLAN §6.3 —— recover：长期条目 HDD → SSD
// ════════════════════════════════════════════════════════════════════════════

const DAY = 86_400_000

/** 造一条 100 天没访问的长期条目，并**真的**把它沉到冷层（走 long-settle 的真实路径）。 */
async function settleOne(runtime: MemoryRuntime, dir: string, id: string, content: string): Promise<string> {
  insertLongEntry(runtime.db, { id, content, summary: `摘要 ${id}` })
  const old = new Date(Date.now() - 100 * DAY).toISOString()
  runtime.db.prepare('UPDATE long_memory_entries SET created_at = ?, last_accessed_at = ? WHERE id = ?').run(old, old, id)
  const outcomes = await settleLongEntries({ db: runtime.db, coldRoot: join(dir, 'cold') })
  assert.equal(outcomes[0]?.action, 'settled', '前提：条目必须真的沉降成功')
  const archivePath = outcomes[0]?.archivePath
  assert.ok(archivePath !== undefined && existsSync(archivePath), '前提：归档文件必须真的落盘')
  return archivePath
}

function longRow(runtime: MemoryRuntime, id: string): { content: string | null; storage_tier: string | null; archive_path: string | null } {
  const row = runtime.db
    .prepare('SELECT content, storage_tier, archive_path FROM long_memory_entries WHERE id = ?')
    .get(id) as { content: string | null; storage_tier: string | null; archive_path: string | null }
  return row
}

test('★★★ §6.3：`recover` 真的存在，且能把 HDD 长期条目提回 SSD（正文回填、archive_path 清空）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const archivePath = await settleOne(runtime, dir, 'L1', '防抖窗口 2-3 秒，per-key mutex')
    const settledRow = longRow(runtime, 'L1')
    assert.equal(settledRow.content, null, '前提：沉降后库内正文为空')
    assert.equal(settledRow.storage_tier, 'hdd')
    assert.equal(settledRow.archive_path, archivePath)

    const value = await runTool(runtime, 'recover', { id: 'L1' })
    assert.equal(value['ok'], true, '**模型照着提示词调它，必须真的能用**')
    assert.equal(value['status'], 'recovered')
    assert.equal(value['source'], 'archive', '正文必须从归档读回来（那才是"从冷层提升"）')

    const after = longRow(runtime, 'L1')
    assert.equal(after.storage_tier, 'ssd', 'tier 必须真的回到 ssd')
    assert.equal(after.content, '防抖窗口 2-3 秒，per-key mutex', '正文必须回填（否则只是换了个标签）')
    assert.equal(after.archive_path, null, 'archive_path 必须清空（markLongRecovered 的契约）')
    assert.ok(existsSync(archivePath), '**提升不删源**：冷层归档文件留在原处')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §6.3：已经在热层 ⇒ 明确说"不需要提升"，**不报成功**', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'HOT', content: '一直在热层的条目', summary: '热的' })
    const value = await runTool(runtime, 'recover', { id: 'HOT' })
    assert.equal(value['ok'], false, '报成功会让模型以为刚触发了一次搬运')
    assert.equal(value['status'], 'already_hot')
    assert.match(String(value['note']), /已经在热层/)
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ §6.3：不存在的 id ⇒ `not_found`（不假装成功）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const value = await runTool(runtime, 'recover', { id: 'nope' })
    assert.equal(value['ok'], false)
    assert.equal(value['status'], 'not_found')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §6.3：归档坏了 ⇒ 明确拒绝，且**绝不回落到库内副本**（库内仍是 NULL、tier 仍是 hdd）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const archivePath = await settleOne(runtime, dir, 'L1', '这条的归档会被删掉')
    rmSync(archivePath, { force: true })

    const value = await runTool(runtime, 'recover', { id: 'L1' })
    assert.equal(value['ok'], false, '归档读不出来时必须报失败')
    assert.equal(value['status'], 'archive_unreadable')
    assert.match(String(value['note']), /没有回落/, '要说清"没有回落到库内副本"')
    const after = longRow(runtime, 'L1')
    assert.equal(after.content, null, '库内正文不能被编出来')
    assert.equal(after.storage_tier, 'hdd', '失败 ⇒ 不动库（否则会变成"取不回来的空壳"）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 接线守卫：`recover` 真的调了 `markLongRecovered`（只读不写 = 什么都没提升）', () => {
  const src = read('../src/runtime.ts')
  const body = bodyOf(src, 'async recoverLongEntry(id: string)', '/** 取回被截断的大结果全文')
  assert.match(body, /loadLongEntry\(\{ db: this\.db, id \}\)/, '必须从归档读正文')
  assert.match(body, /if \(!cold\.found \|\| cold\.content === undefined\)/, '必须区分"读到了"与"没读到"')
  assert.match(body, /markLongRecovered\(this\.db, id, cold\.content\)/, '**必须真的写回库**（此前这个函数全仓零调用）')
  const tools = read('../src/tools.ts')
  assert.match(tools, /name: 'recover'/, '工具必须定义出来')
  assert.match(tools, /runtime\.recoverLongEntry\(a\.id\)/, 'execute 必须真的调 runtime')
})

test('★★★ 接线守卫：L2 提示词（稳定前缀）里提到的 `recover` 必须是**已注册工具**', async () => {
  const config = read('../src/config.ts')
  assert.match(config, /可用 recover 提升回热层/, '前提：L2 提示词确实让模型用 recover')
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const names = captureTools(runtime)
    assert.ok(names.has('recover'), '**提示词指向的工具必须在工具表里** —— 这正是本条缺陷的定义')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
  assert.ok(MEMORY_TOOL_NAMES.includes('recover'), '工具名清单必须含 recover')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ §7.1 的 queries_this_turn 必须有界
// ════════════════════════════════════════════════════════════════════════════

test('★★ queries_this_turn 有界：条数封顶（丢最旧的）+ 单条截断', () => {
  const max = recallQueryLogLimit()
  assert.ok(max > 0, '上限必须由基线推导出来')

  let list: readonly string[] = []
  for (let i = 0; i < max * 3; i++) list = appendBoundedQuery(list, `查询 ${String(i)}`, max)
  assert.equal(list.length, max, `条数必须封顶在 ${String(max)}（无界列表会把上下文越撑越大）`)
  assert.equal(list[list.length - 1], `查询 ${String(max * 3 - 1)}`, '保留的是最近的（去重最需要"刚查过什么"）')
  assert.ok(!list.includes('查询 0'), '最旧的应当被丢掉')

  const long = 'x'.repeat(RECALL_QUERY_MAX_CHARS * 5)
  const clipped = appendBoundedQuery([], long, max)
  assert.ok(
    (clipped[0]?.length ?? 0) <= RECALL_QUERY_MAX_CHARS + 1,
    `单条也要截断（否则一条巨长的"关键词"就能把上下文顶掉）：实际 ${String(clipped[0]?.length)}`,
  )
  assert.equal(appendBoundedQuery([], 'q', 0).length, 0, '上限为 0 时不留任何条目（不越界）')
})

test('★ 轮次边界会清空 queries_this_turn（它是"本轮"的口径）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const first = await recallViaTool(runtime, '第一轮查的')
    assert.deepEqual(first.value.budget.queries_this_turn, ['第一轮查的'])
    runtime.beginTurn()
    const second = await recallViaTool(runtime, '第二轮查的')
    assert.deepEqual(second.value.budget.queries_this_turn, ['第二轮查的'], '新的一轮只该看到本轮查过的')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})
