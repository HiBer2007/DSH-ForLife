/**
 * **分层降噪（PLAN §3.2）的接线守卫**测试。
 *
 * ## 为什么必须有这一条
 *
 * `tool-spill.test.ts` 验的是"接缝接上之后行为对不对"。但它**证明不了接缝还接着** ——
 * 而这个仓库里 `spill()` 已经**零调用**地活了很久，后果是
 * `spill_entries` 表永远是空的、`recall_full` **永远返回 `found:false`**，
 * 而当时的测试**全绿**（它们绕过真实写入路径）。
 *
 * 所以这一条**读源码断言调用点还在**。它不好看，但它拦的正是
 * "功能写好了、测试全绿、而线上根本没跑"这一类问题（本项目已栽过 4 次）。
 *
 * ## 最值得守的几条
 *
 * 1. **每个工具定义都必须经过接缝** —— 漏一个，那个工具的大结果就永远不进 spill；
 * 2. **接缝必须真的调 `runtime.spill`** —— 只"判断要不要截"而不落库，
 *    结果是"模型看不到全文、`recall_full` 也取不回来"，那是**信息直接丢失**，比不截更糟；
 * 3. **阈值必须来自基线** —— 代码里硬编码数字会让"调阈值"变成改代码；
 * 4. **`recall_full` 自己不截断** —— 截它 = 取回全文时又被截，永远拿不到完整内容；
 * 5. **钩子要先 `next()` 再替换** —— 抢在前面返回会把别的策略的 `block`/值替换整个吞掉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('★★ 接线守卫：`buildMemoryTools` 的每个工具都经过 `withToolResultSpill`', () => {
  const src = read('../src/tools.ts')
  assert.match(src, /const defineSpillingTool = withToolResultSpill\(defineTool, runtime\)/, '**接缝必须真的建起来**')
  const through = (src.match(/= defineSpillingTool\(\{/g) ?? []).length
  assert.equal(through, 5, `五个记忆工具都必须走接缝（实际 ${String(through)} 个）`)
  assert.ok(!/= defineTool\(\{/.test(src), '**不能有绕过接缝的工具定义**（那个工具的大结果会直接丢失）')
})

test('★★ 接线守卫：`buildQqTools` 的每个工具也都经过接缝', () => {
  const src = read('../src/qq-tools.ts')
  assert.match(src, /const defineSpillingTool = withToolResultSpill\(defineTool, runtime\)/)
  const through = (src.match(/= defineSpillingTool\(\{/g) ?? []).length
  const direct = (src.match(/= defineTool\(\{/g) ?? []).length
  assert.equal(direct, 0, `不能有绕过接缝的 QQ 工具（实际 ${String(direct)} 个）`)
  assert.ok(through >= 9, `QQ 工具集要全覆盖（实际 ${String(through)} 个）`)
})

test('★★ 接缝**真的写库**：必须调 `runtime.spill(...)`（只判断不落库 = 信息直接丢失）', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /input\.runtime\.spill\(\{/, '**必须调用 spill 落库**')
  const runtimeSrc = read('../src/runtime.ts')
  assert.match(runtimeSrc, /insertSpill\(this\.db, \{/, 'spill() 必须真的写 spill_entries 表')
  assert.match(runtimeSrc, /getSpill\(this\.db, id\)/, '读路径（recallFull）也必须是真的')
})

test('★★ 阈值来自基线，**不在代码里硬编码数字**', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /defaultFor<number>\('tool\.spill\.thresholdBytes'\)/, '阈值必须经 defaultFor 取')
  assert.match(read('../src/runtime.ts'), /defaultFor<number>\('tool\.spill\.headLines'\)/, 'head 行数也必须经 defaultFor 取')
  assert.ok(!/16\s*\*\s*1024|16384/.test(src), '阈值不能在代码里写死（改阈值不该改代码）')
})

test('★★ 用宿主的 `finalizeContent`（`output.render` 必须保持纯投影）', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /finalizeContent:/, '必须注入宿主提供的最后一公里变换')
  assert.ok(!/output\s*:\s*\{[^}]*render\s*:/.test(src), '**不许改 output.render** —— 项目里有测试断言 render 不产生副作用')
  assert.match(src, /return defineTool\(withFinalizer\)/, '注入后必须交给宿主的 defineTool 编译')
})

test('★★ 替换文本必须给出**溢出 id** 与 `recall_full` 的取回指示', () => {
  const src = read('../src/tool-spill.ts')
  const start = src.indexOf('export function renderSpillNotice')
  assert.ok(start > 0, '找不到 renderSpillNotice')
  const seg = src.slice(start, src.indexOf('/**', start + 10))
  assert.match(seg, /\$\{input\.id\}/, '**id 必须在提示里**（没有 id 就取不回全文）')
  assert.match(seg, /recall_full/, '**必须告诉模型用 recall_full 取回**')
  assert.match(seg, /SPILL_NOTICE_MARK/, '要有可识别的标记（二次截断防护靠它）')
})

test('★★ `recall_full` 自己**不截断**（截它 = 永远拿不到全文）', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /TOOL_RESULT_SPILL_SKIP[^\n]*=\s*\[[^\]]*'recall_full'/, '**recall_full 必须在跳过名单里**')
  assert.match(src, /if \(TOOL_RESULT_SPILL_SKIP\.includes\(input\.toolName\)\) return \{ kind: 'keep', reason: 'skipped' \}/, '跳过名单必须真的被用上')
})

test('★★ 覆盖宿主工具：钩子挂 `tools/post-execute`，且**先 next() 再替换**', () => {
  const src = read('../src/tool-spill.ts')
  const hookAt = src.indexOf("'tools/post-execute'")
  assert.ok(hookAt > 0, '**必须订阅 tools/post-execute**（否则宿主工具 pwsh/read/web_fetch 的大结果永远接不住）')
  const nextAt = src.indexOf('await (next as () => Promise<unknown>)()', hookAt)
  const replaceAt = src.indexOf('content: plan.content', hookAt)
  assert.ok(nextAt > hookAt, '**必须先委托 next()**')
  assert.ok(replaceAt > nextAt, '**替换必须在 next() 之后** —— 否则会把别人的 block / 值替换吞掉')
  assert.match(src.slice(hookAt), /\{ prepend: true \}/, 'prepend：先跑才能看到别人处理后的最终内容')
  assert.match(src, /options\.disposers\.push\(dispose\)/, '**必须交出反注册器**（否则热重载重复挂 ⇒ 一个结果被处理两遍）')
})

test('★ 拿不到钩子要**明说**，不能静默（否则"在跑"和"没挂上"从日志上看一模一样）', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /工具结果分层降噪未挂载/, '必须 `always` 报出来')
  assert.match(src, /已订阅 tools\/post-execute/, '挂上时也要留一行日志')
})

test('★ 失败**不静默**：落库失败要计数（finalizeContent 必须 total，不能抛）', () => {
  const src = read('../src/tool-spill.ts')
  assert.match(src, /stats\.failed \+= 1/, '失败必须计数')
  assert.match(src, /export function toolSpillStats\(\)/, '计数必须能读出来（面板/doctor/测试）')
})

test('★ `recall_full` 工具的 execute 真的读 runtime（读路径没断）', () => {
  const src = read('../src/tools.ts')
  const start = src.indexOf("name: 'recall_full'")
  const seg = src.slice(start, src.indexOf('requestCompaction', start))
  assert.match(seg, /runtime\.recallFull\(a\.id\)/, '**必须真的去读溢出记录**')
  assert.match(seg, /found: true/, 'found=true 的分支必须真的存在（原事故：永远走 found:false）')
})

test('★ index.ts 的接线状态（宿主工具全覆盖需要它；未挂时点名，不静默）', (t) => {
  const src = read('../src/index.ts')
  const wired = /registerToolResultSpill\(/.test(src)
  t.diagnostic(
    wired
      ? '✅ index.ts 已挂 tools/post-execute：宿主工具（pwsh / read / web_fetch / 子代理）的大结果也进 spill'
      : '⚠️ index.ts 尚未挂 registerToolResultSpill ⇒ 目前只有我们自己注册的工具走接缝；宿主工具的大结果仍会整段进上下文',
  )
  // 不管挂没挂，接缝本身必须可用（否则"补一行"也挂不上）
  assert.match(read('../src/tool-spill.ts'), /export function registerToolResultSpill\(/, '注册函数必须存在且已导出')
})
