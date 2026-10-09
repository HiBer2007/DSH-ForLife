/**
 * 接线守卫：中期层的检索**不再只在长期层为零时才走**（`FIX_PLAN.md` D3 / P0-c）。
 *
 * ## 这条盯的是一个"工具在那儿、路被堵死"的形状
 *
 * `runtime.ts` 原来是：
 *
 * ```ts
 * // 长期库还空时，退一步查中期记忆（避免"刚开始用什么都搜不到"的挫败感）
 * if (entries.length === 0) { …查中期… }
 * ```
 *
 * 那是一个**新手引导性质**的兜底，不是检索路径。代价在长期库有内容之后才显现：
 * **任何能命中长期层的查询，再也不会被告知"中期层里还有 N 条"** ⇒
 * 模型连"要不要 `recall_mid`"都无从判断。
 *
 * 而 P0-a 刚加的 `recall_mid` 正需要这条提示指路 —— 两件事叠起来就是
 * **一整层记忆静默消失**（线上：窗口外那 1455k，占全表 94%）。
 *
 * ## 为什么断言的是**源码形状**而不是行为
 *
 * 这个改动的正确性全在"哪个条件触发、以及提示里有没有 id"上；
 * 而行为测试要搭一整套 runtime 夹具，成本高、且更容易写成"我以为的形状"。
 * 源码守卫在这里更直接：**它抓的正是"路被堵回去"这件事**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const runtimeSrc = (): string => readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8')

/**
 * 去掉行注释与块注释。
 *
 * ★ 必须这么做：`runtime.ts` 的文档注释里**引用**了旧文案（"本次检索也取不回来"），
 * 那是**历史记录**、应当留着；而守卫要判的是**代码里还有没有这么说**。
 * 不剥注释的话，这条守卫会把"注释里记着旧文案"误判成"代码还在撒谎" ——
 * 一个只会误报的守卫，很快就没人看了。
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

test('★★ 守卫：中期层的检索门**不再是"长期层零命中"**（D3 的根因）', () => {
  const src = runtimeSrc()
  const body = code(src)

  assert.ok(
    body.includes('if (entries.length < maxResults) {'),
    '**必须改成"长期层没喂饱这次额度就也看中期层"** —— 退回 `=== 0` 就是退回那个坑',
  )
  // 这一条特意看**原始源码**（含注释）：那句注释是"把门堵回去"的说明书，
  // 留着它，下一个人会照它再把门堵回去。
  assert.ok(
    !src.includes('// 长期库还空时，退一步查中期记忆'),
    '那句"长期库还空时退一步"的注释必须删掉',
  )
})

test('★★ 守卫：长期与中期**都有命中时两边都要说**（否则中期那一层等于不存在）', () => {
  const src = code(runtimeSrc())
  assert.match(
    src,
    /this\.midAlongsideNote\(mid, entries\.length\)/,
    '必须有一条"长期有命中、中期也有"的提示 —— 这是 P0-c 的另一半',
  )
  assert.match(src, /private midAlongsideNote\(/, '那个方法必须真的存在（不是只调用一个不存在的东西）')
})

test('★★ 守卫：提示里**必须带上 id** —— 否则 `recall_mid` 没有路通向它', () => {
  const src = code(runtimeSrc())

  // ★ 必须**两处都有**，所以断言条数而不是"存在"。
  //   这个加固不是洁癖：第一次写这条守卫时只断言了"存在"，
  //   而回退验证里"只替掉第一处"的注入**照样通过** —— 也就是说
  //   **丢掉一半的 id 提示，守卫看不出来**。那正是"工具在那儿、路只通一半"的形状。
  const idSlices = src.match(/hits\.slice\(0, maxIds\)\.map\(\(entry\) => entry\.id\)/g) ?? []
  assert.ok(
    idSlices.length >= 2,
    `id 必须**从命中里真的取出来**，且 fallback 与 alongside 两处都要（实际 ${String(idSlices.length)} 处）`,
  )
  assert.match(src, /recall_mid 逐条取回/, '提示里要点名 `recall_mid`，否则模型不知道该调什么')
  // 两处（fallback 与 alongside）都要带 id —— 只带一处等于另一半场景仍然失联
  const idHints = src.match(/recall_mid 逐条取回/g) ?? []
  assert.ok(idHints.length >= 2, `两个提示都要带 id（实际 ${String(idHints.length)} 处）`)
})

test('★ 守卫：代码里不许再说"本次检索也取不回来"（有了 recall_mid，那句话就成了新的谎）', () => {
  const body = code(runtimeSrc())
  assert.ok(
    !body.includes('本次检索也取不回来'),
    'P0-a 之前这句是对的（当时确实没有回填路径）；`recall_mid` 上线后它变成假话 —— **假绿比报错更贵**',
  )
})
