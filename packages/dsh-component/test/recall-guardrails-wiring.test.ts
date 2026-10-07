/**
 * **接线守卫 + 行为**：PLAN §7.4 的两条硬约束（重复查询检测 / 联想深度提示）+ §7.3 的工具描述。
 *
 * ## 为什么单独一个文件
 *
 * 这一批缺陷的形状和审计里那 7 次一模一样：**看起来有、实际不在链路上**。
 *  - §7.4 重复查询检测：基线键 `recall.duplicateSimilarity` **零引用**、
 *    全仓 `duplicate_query` **0 命中**；唯一的 `similarity()` 在 `store/src/loop-guard.ts:63`，
 *    那是死循环检测用的**字符级**相似度（看首尾公共部分），与 recall 无关；
 *  - §7.4 联想深度限制：基线键 `recall.associativeDepthWarn` **零引用**，
 *    且 `maxPerTurn`（2）< 阈值（3）⇒ 这条规则在**基线参数下不可达**（PLAN 内部张力）；
 *  - §7.3 工具描述：5 条原则只覆盖 2.5 条，**第 4 条语义相反** ——
 *    旧文案写"可以换关键词"，PLAN 写的是"先判断信息是否真的存在，**而不是**立即换词重试"。
 *
 * 单元测试抓不到"接线断没断"（本项目已栽过 7 次），所以这里两层都有：
 *  ① **读源码断言调用点存在**（不好看，但拦的正是"线上根本没跑"）；
 *  ② **走工具的真实 `execute` + 真实 `render`**（不 mock 工具本体），断言模型看得见的内容。
 *
 * 每条都做过"最小翻转"验证：只翻一个条件它就必须变红（结果见各条测试名旁的 `↩︎` 注释）。
 *
 * @module forlife-memory/test/recall-guardrails-wiring
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { insertLongEntry } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime, querySimilarity } from '../src/runtime.ts'
import { buildMemoryTools, type DefineToolLike } from '../src/tools.ts'

/** 源码读取（**先归一 CRLF** —— 否则跨行正则与 `includes` 会因换行符差异骗过断言）。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').split(/\r?\n/).join('\n')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-recall-guard-'))

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

/** 捕获工具定义（`index.ts` 注册的是 `buildMemoryTools` 的返回值，所以两边都要看）。 */
function captureTools(runtime: MemoryRuntime): Map<string, CapturedTool> {
  const byName = new Map<string, CapturedTool>()
  const fake = ((options: CapturedTool): unknown => {
    byName.set(options.name, options)
    return options
  }) as unknown as DefineToolLike
  for (const tool of buildMemoryTools(fake, runtime) as unknown as CapturedTool[]) byName.set(tool.name, tool)
  return byName
}

/** 某个函数/方法的函数体（从签名切到下一个顶层成员）—— 源码守卫用，避免匹配到别处。 */
function bodyOf(src: string, signature: string, stopAt: string): string {
  const from = src.indexOf(signature)
  assert.ok(from > 0, `源码里找不到 ${signature}（接线被删了？）`)
  const to = src.indexOf(stopAt, from + signature.length)
  return src.slice(from, to > from ? to : undefined)
}

/** `recall_longterm` 返回值里我们读到的部分（含 PLAN §7.4 的拒绝码）。 */
interface RecallValue {
  readonly ok: boolean
  readonly results: readonly { readonly id: string; readonly summary?: string; readonly content?: string }[]
  readonly budget: {
    readonly used: number
    readonly limit: number
    readonly queries_this_turn: readonly string[]
    readonly per_turn: { readonly used: number; readonly limit: number; readonly remaining: number }
  }
  readonly note?: string
  readonly refusal?: {
    readonly code: string
    readonly hint: string
    readonly matchedQuery?: string
    readonly similarity?: number
    readonly threshold?: number
  }
  readonly associationWarn?: { readonly depth: number; readonly warnAt: number; readonly hint: string }
}

/** 调用 `recall_longterm` 工具（真实 execute + 真实 render）。 */
async function recallViaTool(
  runtime: MemoryRuntime,
  query: string,
): Promise<{ readonly value: RecallValue; readonly rendered: string }> {
  const tool = captureTools(runtime).get('recall_longterm')
  assert.ok(tool !== undefined, '**recall_longterm 工具必须注册出来**')
  const args = { query }
  const value = (await tool.execute(args as never)) as RecallValue
  const rendered = tool.output
    .render(args as never, value as never)
    .map((b) => b.text)
    .join('\n')
  return { value, rendered }
}

/** 取某个工具并跑一次真实 execute。 */
async function runTool(runtime: MemoryRuntime, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = captureTools(runtime).get(name)
  assert.ok(tool !== undefined, `**${name} 工具必须注册出来**`)
  return (await tool.execute(args as never)) as Record<string, unknown>
}

/** 基线值（**测试里也不许出现魔法数字**：从 plan-baseline.json 派生）。 */
const DUPLICATE_SIMILARITY = defaultFor<number>('recall.duplicateSimilarity')
const WARN_AT = defaultFor<number>('recall.associativeDepthWarn')
const MAX_PER_TURN = defaultFor<number>('recall.maxPerTurn')

// ════════════════════════════════════════════════════════════════════════════
// ① PLAN §7.4 —— 近似相似度本身（先说清它是什么、不是什么）
// ════════════════════════════════════════════════════════════════════════════

test('★ §7.4：`querySimilarity` 是**词面近似**（不是语义相似度）—— 表面差异判同一个、同义改写抓不到', () => {
  // 表面差异（空白 / 标点 / 全半角 / 大小写）⇒ 判为同一个查询
  assert.equal(querySimilarity('防抖 2-3 秒', '防抖2-3秒。'), 1, '空白与标点差异不该算"换了个查询"')
  assert.equal(querySimilarity('QQ Bot 防抖', 'qq　bot 防抖'), 1, '大小写与全角空格同理（NFKC + 小写）')
  assert.equal(querySimilarity('QQ防抖', '防抖QQ'), 1, '集合语义忽略词序：换个词序问同一件事仍是同一件事')

  // ★ 边界如实：真·同义改写**抓不到** —— 那需要向量库（本仓没有）
  assert.ok(
    querySimilarity('防抖实现', '防抖是怎么做的') < DUPLICATE_SIMILARITY,
    '同义改写抓不到：没有向量库就只能做词面近似。代价是**漏检**，不是把不同查询判成同一个',
  )
  // 词面不同的两个主题 ⇒ 完全不像（不能误杀）
  assert.equal(querySimilarity('消息队列', '数据库迁移'), 0, '不同主题必须判 0 —— 误杀会让模型以为"记忆里没有"')
  // 空查询 / 全是标点 ⇒ 没有 token ⇒ 不判重复（交给检索如实返回"无命中"）
  assert.equal(querySimilarity('', '防抖'), 0)
  assert.equal(querySimilarity('！！！', '防抖'), 0, '全是标点 ⇒ 归一化后没有 token')
})

// ════════════════════════════════════════════════════════════════════════════
// ② PLAN §7.4 —— 重复查询：拒绝 + `duplicate_query` + 明确反馈
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.4：同一轮里再查一次几乎相同的词 ⇒ 拒绝 + `duplicate_query` + 模型可见的反馈', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'L1', content: '防抖窗口 2-3 秒，per-key mutex', summary: '防抖设计' })

    const first = await recallViaTool(runtime, '防抖窗口')
    assert.equal(first.value.results.length, 1, '前提：第一次检索要能命中')
    assert.equal(first.value.refusal, undefined, '正常命中不该带拒绝码')

    // 表面不同、实质同一个查询（多个句号）—— 归一化后完全一致
    const second = await recallViaTool(runtime, '防抖窗口 。')
    assert.deepEqual(second.value.results, [], '重复查询必须被拒（PLAN §7.4：拒绝）')
    assert.equal(second.value.refusal?.code, 'duplicate_query', '**PLAN §7.4 要求的码就是它**')
    assert.equal(second.value.refusal?.matchedQuery, '防抖窗口', '要说清撞上了哪一条已查过的查询')
    assert.equal(second.value.refusal?.threshold, DUPLICATE_SIMILARITY, '阈值必须**读基线**（不许写死 0.9）')
    assert.ok(
      (second.value.refusal?.similarity ?? 0) > (second.value.refusal?.threshold ?? 1),
      '报出的相似度必须真的越线（判据是严格大于，与 PLAN 的「> 0.9」一致）',
    )
    assert.match(String(second.value.note), /你刚查过相近的查询/, '**必须明确告诉模型"你刚查过相近的"**')
    assert.match(String(second.value.note), /duplicate_query/, '码要出现在 note 里（note 一定会渲染）')
    assert.match(second.rendered, /duplicate_query/, '**模型读的是 render** —— 码必须出现在里面')
    assert.match(second.rendered, /你刚查过相近的查询/, 'render 里要有可执行的反馈，不能只说"被拒"')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §7.4：真正不同的查询**不会被误杀**（近似判据只拦"几乎同一个"）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'L1', content: '防抖窗口 2-3 秒，per-key mutex', summary: '防抖设计' })
    const first = await recallViaTool(runtime, '防抖窗口')
    assert.equal(first.value.results.length, 1)

    const other = await recallViaTool(runtime, '数据库迁移')
    assert.equal(other.value.refusal, undefined, '不同主题不许被判重复（误杀比漏检贵得多）')
    assert.ok(!String(other.value.note ?? '').includes('duplicate_query'), 'note 里也不许出现重复查询的码')
    assert.match(String(other.value.note ?? ''), /无命中/, '它该走到的是"无命中"这条路')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ §7.4：重复被拒也**照样扣额度**（免费重试 = 无限撞墙，账目也必须与"真的查了"一致）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    insertLongEntry(runtime.db, { id: 'L1', content: '防抖窗口 2-3 秒', summary: '防抖设计' })
    const first = await recallViaTool(runtime, '防抖窗口')
    assert.equal(first.value.budget.used, 1)

    const dup = await recallViaTool(runtime, '防抖窗口！')
    assert.equal(dup.value.refusal?.code, 'duplicate_query')
    assert.equal(dup.value.budget.used, 2, '**被拒也扣额度** —— 否则这道闸门就是免费重试')
    assert.equal(dup.value.budget.per_turn.used, 2, '每轮计数同样要涨（预算声明不能自相矛盾）')
    assert.deepEqual(
      dup.value.budget.queries_this_turn,
      ['防抖窗口', '防抖窗口！'],
      '被拒的查询也记进 queries_this_turn：它确实发生、也确实扣了额度',
    )

    // 额度见底之后，拦它的该是**额度闸门**（不是重复闸门）—— 顺序要能解释
    const third = await recallViaTool(runtime, '又一条不同的查询')
    assert.equal(third.value.refusal?.code, 'turn_exhausted', '额度用尽时报的是额度码（此时"没额度了"比"重复"更要紧）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ③ PLAN §7.4 —— 联想深度：同轮检索次数 ≥ 基线阈值 ⇒ 强制附加提示
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.4：同轮检索 ≥ `recall.associativeDepthWarn` ⇒ **强制附加提示**（基线参数下先证实它不可达）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    // ★ PLAN 的内部张力：基线 `maxPerTurn`(2) < 阈值(3) ⇒ 同一轮里第 3 次检索
    //   会先被**每轮闸门**拒掉，`recallThisTurn` 到不了阈值。这条断言把张力钉在测试里。
    assert.ok(MAX_PER_TURN < WARN_AT, `前提：基线每轮 ${String(MAX_PER_TURN)} 次 < 阈值 ${String(WARN_AT)} 次 ⇒ 不可达`)

    runtime.beginTurn()
    await recallViaTool(runtime, '防抖窗口')
    await recallViaTool(runtime, '消息队列')
    const blocked = await recallViaTool(runtime, '数据库迁移')
    assert.equal(blocked.value.refusal?.code, 'turn_exhausted', '基线参数下第 3 次根本走不到检索 ⇒ 提示无从出现')

    // 走**真实逃生通道**把每轮额度抬到阈值之上（这正是"同一轮再多查几次"的真实场景）
    const granted = await runTool(runtime, 'request_recall_extension', { reason: '这一轮要连着核对三份旧记录' })
    assert.equal(granted['granted'], true, '前提：追加额度必须获批')
    assert.ok(Number(granted['perTurnLimit']) >= WARN_AT, '前提：抬升后的每轮额度要 ≥ 阈值')

    const third = await recallViaTool(runtime, '数据库迁移')
    assert.equal(third.value.associationWarn?.depth, WARN_AT, '第 3 次（= 阈值）必须出现提示')
    assert.equal(third.value.associationWarn?.warnAt, WARN_AT, '阈值要如实报出（读自基线）')
    assert.match(String(third.value.note), /联想深度提示/, '提示必须真的拼进 note')
    assert.match(third.rendered, /联想深度提示/, '**模型读的是 render** —— 它必须出现在里面')
    assert.match(third.rendered, /候选片段/, '提示要说清"结果是候选片段、不是最终答案"（§7.3 原则 3）')

    // 反向：没到阈值的那些次**不许**乱提示（否则提示就成了噪音，模型会学会忽略它）
    const fourth = await recallViaTool(runtime, '又一条不同的查询')
    assert.equal(fourth.value.associationWarn?.depth, WARN_AT + 1, '第 4 次继续提示（超过阈值仍然提示）')
    runtime.beginTurn()
    const newTurn = await recallViaTool(runtime, '新的一轮第一条')
    assert.equal(newTurn.value.associationWarn, undefined, '新的一轮从 1 起算 ⇒ 不该再提示')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ④ PLAN §7.3 —— 工具描述（5 条使用原则 + 3 条反面示例）
// ════════════════════════════════════════════════════════════════════════════

test('★★★ §7.3：`recall_longterm` 描述覆盖 5 条原则 + 3 条反面示例，且第 4 条**语义正确**', () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    const tool = captureTools(runtime).get('recall_longterm')
    assert.ok(tool !== undefined, 'recall_longterm 必须注册出来')
    const description = tool.description

    // 5 条使用原则（PLAN §7.3）
    const principles: readonly (readonly [string, RegExp])[] = [
      ['① 仅当确实缺少该信息时才查', /只在短期上下文与当前中期记忆确实缺少该信息时才查/],
      ['② 不要为"确认"或"补充"而反复检索同一主题', /不要为.确认.或.补充.而反复检索同一主题/],
      ['③ 返回的是候选片段、不要过度联想串联', /候选片段，不是最终答案[\s\S]{0,12}不要过度联想串联/],
      ['④ 先判断信息是否存在、而不是立即换词重试', /先判断信息是否真的存在，再决定要不要换词/],
      ['⑤ 额度有限且随每次返回告知', /每轮额度有限，额度随每次返回告知/],
    ]
    for (const [what, pattern] of principles) {
      assert.match(description, pattern, `PLAN §7.3 ${what} 必须写进工具描述`)
    }
    assert.match(description, /duplicate_query/, '描述要让模型知道"重复会被拒"的码（否则被拒时看不懂）')

    // 3 条反面示例（PLAN §7.3 逐字）
    for (const example of [
      '为"确保无遗漏"连续检索 3-4 次相似查询',
      '检索到模糊片段后围绕它做大量推测性检索',
      '把不相关结果强行关联到当前任务',
    ]) {
      assert.ok(description.includes(example), `PLAN §7.3 的反面示例必须写进描述：「${example}」`)
    }

    // ★ 第 4 条以前是**语义相反**的（"可以换关键词"）—— 这行守卫防它回来
    assert.ok(!description.includes('可以换关键词'), 'PLAN §7.3 第 4 条要的是"先判断是否存在"，不是"可以换关键词"')
    assert.ok(
      !/无命中不代表不存在[\s\S]{0,10}换/.test(description),
      '旧文案「无命中不代表不存在，可以换关键词」与 PLAN 相反，不许回来',
    )

    // 取舍：描述位于**稳定前缀**（L1 工具定义）⇒ 用上限钉住，防止"越写越长"
    assert.ok(
      description.length <= 600,
      `描述长度 ${String(description.length)} 超过上限 600：它在稳定前缀里，每个字都进每次请求的上下文`,
    )
  } finally {
    runtime.close()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 接线守卫（读源码断言调用点存在）
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 接线守卫：重复检测真的在源码里（阈值读基线、比对在建索引之前、码透传到工具）', () => {
  const runtime = read('../src/runtime.ts')
  // 闸门 ③ 必须在 `recallLongterm` 的检索之前 —— 在之后就成了"查完再说重复"（白花钱）
  const body = bodyOf(runtime, 'recallLongterm(query: string', 'requestRecallExtension(input')
  const dupAt = body.indexOf('this.findDuplicateQuery(query)')
  const searchAt = body.indexOf('searchLongFts(this.db, query, maxResults)')
  assert.ok(dupAt > 0, '**重复检测必须在 `recallLongterm` 里真的被调用**（这次缺陷就是它不存在）')
  assert.ok(searchAt > 0, '前提：检索调用还在')
  assert.ok(dupAt < searchAt, '重复检测必须在检索**之前**（否则重复查询照样花掉一次 FTS）')
  assert.match(body, /return this\.recallDuplicateRefused\(/, '撞上重复要**返回拒绝**（不是只记一笔）')

  const findBody = bodyOf(runtime, 'private findDuplicateQuery(', 'private recallDuplicateRefused(')
  assert.match(findBody, /defaultFor<number>\('recall\.duplicateSimilarity'\)/, '**阈值必须读基线**（此前该键零引用）')
  assert.ok(!/0\.9/.test(findBody), '阈值不许写死 0.9（写死的话改基线就撒谎）')
  assert.match(findBody, /similarity > threshold/, '判据是 PLAN 的严格大于（`> 0.9`）')
  assert.match(findBody, /this\.queriesThisTurn/, '比对集合必须是模型看得见的那份清单（queries_this_turn）')

  const refusedBody = bodyOf(runtime, 'private recallDuplicateRefused(', 'private recallRefused(')
  assert.match(refusedBody, /code: 'duplicate_query'/, '**拒绝码必须真的是 `duplicate_query`**（PLAN §7.4 逐字）')

  // 工具层：码要原样透传（只写进 runtime 的话，模型永远看不到）。
  //
  // ⚠️ 判据必须**行首锚定**：回退验证时发现裸 `includes('refusal: result.refusal')`
  //    会被**注释掉的**那一行满足（"注释不是接线" —— 与 `param-consumption.test.ts`
  //    去掉注释再扫描是同一条教训；那次也是第一版扫描自己满足了自己）。
  const tools = read('../src/tools.ts')
  assert.match(
    tools,
    /^[ \t]*\.\.\.\(result\.refusal === undefined \? \{\} : \{ refusal: result\.refusal \}\),$/m,
    '工具必须原样透传 runtime 的拒绝码（行首锚定 ⇒ 注释掉的那行不算）',
  )
  assert.match(
    tools,
    /^[ \t]*\.\.\.\(result\.associationWarn === undefined \? \{\} : \{ associationWarn: result\.associationWarn \}\),$/m,
    '联想深度提示同样要透传（行首锚定 ⇒ 注释掉的那行不算）',
  )
  assert.match(tools, /^[ \t]*refusal: \{$/m, 'output.schema 必须声明 refusal（否则它是个 schema 外的字段）')
  assert.match(tools, /^[ \t]*associationWarn: \{$/m, 'output.schema 必须声明 associationWarn')
})

test('★★★ 接线守卫：联想深度提示读基线键、且真的拼进 note（不拼进 note = 模型永远看不到）', () => {
  const runtime = read('../src/runtime.ts')
  const warnBody = bodyOf(runtime, 'private associationWarn()', 'private findDuplicateQuery(')
  assert.match(
    warnBody,
    /defaultFor<number>\('recall\.associativeDepthWarn'\)/,
    '**阈值必须读基线**（此前该键零引用；写死 3 的话改参数就撒谎）',
  )
  assert.match(warnBody, /this\.recallThisTurn < warnAt/, '判据必须用真实的同轮计数')
  assert.match(warnBody, /联想深度提示/, '提示文案要在（它会被拼进 note）')

  // 提示必须经过 `recallResult` 收口（所有成功路径共用一个出口，避免某条分支漏提示）
  const resultBody = bodyOf(runtime, 'private recallResult(', 'private associationWarn(')
  assert.match(resultBody, /this\.associationWarn\(\)/, 'recallResult 必须真的取提示')
  assert.match(resultBody, /associationWarn\.hint/, '提示必须**拼进 note**（note 才会被 render 出来）')
  assert.match(resultBody, /notes\.join/, '多段 note（提示 + 无命中说明）要合并，不能互相覆盖')
})

test('★ 文档守卫：代码注释必须明说"这是近似、不是语义相似度"（不许把近似说成语义）', () => {
  const runtime = read('../src/runtime.ts')
  assert.match(runtime, /⚠️ 这不是语义相似度/, '近似手段必须在注释里说明白（审计与后来者都靠这句话）')
  assert.match(runtime, /没有向量库/, '要写清"为什么只能是近似"：仓库没有向量库')
})
