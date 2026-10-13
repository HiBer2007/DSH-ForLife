/**
 * ★ **接线守卫**：中介层的取数层必须**真的在启动路径上被调用**。
 *
 * ## 为什么要有这个测试
 *
 * 本项目已经栽过 **10+ 次**同一个模式：
 * **"库代码写好了、单元测试全绿、生产路径上零调用"**。
 *
 * 最近的两次实例：
 * - `seedOpenCodeGoRoutes()` —— 只有测试调（第 15 处缺陷）
 * - `router/deploy.ts` + `download.ts`（28 KB 的自动部署能力）—— **生产 0 命中**
 *
 * **⇒ 单元测试永远抓不到它** —— 因为**单元测试自己就是调用者**。
 * 所以每个新接线都必须配一个**读源码**的守卫测试。
 *
 * ## 这个测试怎么判
 *
 * 读 `src/index.ts`，**去掉注释后**断言：
 * ① `fetchHostCatalog` 被 **import** 了
 * ② `fetchHostCatalog(ctx…)` 被**真的调用**
 * ③ **调用的结果被用了**（不是 `void fetchHostCatalog()` 然后丢掉）
 * ④ `probeLlm` 同理（它是验证宿主接口的那只眼睛）
 *
 * ⚠️ **去掉注释再判**：本项目栽过"锚点匹配到注释里 ⇒ 结论相反"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读源码并**去掉注释行**（判配置/接线时只看真代码，这是本项目的教训）。 */
function code(relPath: string): string {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

test('★ 取数层（fetchHostCatalog）在启动路径上被真的调用', () => {
  const src = code('src/index.ts')

  assert.match(src, /import\s*\{[^}]*\bfetchHostCatalog\b[^}]*\}/, 'fetchHostCatalog 没有 import')
  // ★ 必须**语句位置**：行首 `void fetchHostCatalog(ctx…`。
  //   不加这条，`void 0 && fetchHostCatalog(ctx…)` 也能蒙混过关（回退验证时真漏过一次）。
  assert.match(src, /^\s*void\s+fetchHostCatalog\(\s*ctx/m, 'fetchHostCatalog 没有被真的调用（只 import、或写在死代码里）')

  // ③ 结果必须被用 —— 否则等于没调
  assert.match(src, /result\.catalog/, '取数的结果没被用（等于白调）')
})

test('★ LLM 探针（probeLlm）在启动路径上被真的调用', () => {
  const src = code('src/index.ts')
  assert.match(src, /import\s*\{[^}]*\bprobeLlm\b[^}]*\}/, 'probeLlm 没有 import')
  assert.match(src, /^\s*void\s+probeLlm\(\s*ctx/m, 'probeLlm 没有被真的调用（只 import、或写在死代码里）')
  assert.match(src, /report\.summary/, '探针的报告没被用')
})

test('★ 路由表播种（seedOpenCodeGoRoutes / seedDeepSeekFallback）仍在启动路径上', () => {
  const src = code('src/index.ts')
  // 这两条是第 15 处缺陷的修复 —— 别被人顺手删掉
  assert.match(src, /^\s*const\s+\w+\s*=\s*seedOpenCodeGoRoutes\(\s*runtime\.db/m, 'seedOpenCodeGoRoutes 的调用没了（第 15 处缺陷回归）')
  assert.match(src, /^\s*const\s+\w+\s*=\s*seedDeepSeekFallback\(\s*runtime\.db/m, 'seedDeepSeekFallback 的调用没了')
})

test('★ 取数层与探针都不得吞掉异常后**静默** —— 必须有日志', () => {
  const src = code('src/index.ts')
  // 两个异步调用都要有 .catch，且 catch 里要 always(...) —— 否则失败时什么都不说
  for (const name of ['probeLlm', 'fetchHostCatalog']) {
    const idx = src.search(new RegExp('^\\s*void\\s+' + name + '\\(\\s*ctx', 'm'))
    assert.ok(idx !== -1, name + ' 没找到语句位置的调用点')
    const tail = src.slice(idx, idx + 2000)
    assert.match(tail, /\.catch\(/, name + ' 的 Promise 没有 .catch —— 失败会静默')
    const catchIdx = tail.indexOf('.catch(')
    assert.ok(
      /always\(/.test(tail.slice(catchIdx, catchIdx + 400)),
      name + ' 的 .catch 里没有 always(...) —— 失败时一个字都不打，等于静默',
    )
  }
})

test('★ 模型路由（installModelRouter）在启动路径上被真的调用', () => {
  const src = code('src/index.ts')
  assert.match(src, /import\s*\{[^}]*\binstallModelRouter\b[^}]*\}/, 'installModelRouter 没有 import')
  assert.match(src, /^\s*const\s+\w+\s*=\s*installModelRouter\(\s*ctx/m, 'installModelRouter 没有被真的调用')
  assert.match(src, /modelRouter\.mode/, '模型路由的结果没被用（等于白调）')
  assert.match(src, /modelRouter\.dispose\(\)/, '模型路由没有挂 dispose —— 插件卸载时会漏监听器')
})

test('★★★ `getCatalog` **必须真的传进去** —— 不传 ⇒ 判档整块是死的，而上面那条守卫照样绿', () => {
  // ## 这条是怎么被发现的（2026-10-10）
  //
  // 上面那条守卫断言了「import 了 + 调用了 + 结果被用了 + 挂了 dispose」——**四条全绿**。
  // 而真机调用长这样：
  //
  //     installModelRouter(ctx as never, { log: always })      ← 没有 getCatalog
  //
  // ⇒ `input.getCatalog === undefined` ⇒ **判档整块被跳过**（连 `apply` 一起）
  // ⇒ 中介层第 ① 块**在生产里是死的**，而**没有任何测试变红**。
  //
  // ★ 这又是本仓那个最贵的形状：**东西都在，只是没人把它们接起来**（与 §23 同源）。
  //   ⇒ 判据要**两个都问**：「我调它了吗」**和**「喂给它的依赖，谁传？」
  const src = code('src/index.ts')
  assert.match(
    src,
    /installModelRouter\([\s\S]{0,500}?getCatalog:/,
    '★★★ 必须在 `installModelRouter` 的入参里真的传 `getCatalog` —— ' +
      '不传的话 `input.getCatalog === undefined`，**判档与 apply 全部静默失效**',
  )
  // ★ 而且要真的从宿主取数，不是塞一个空目录糊弄
  assert.match(
    src,
    /getCatalog:[\s\S]{0,400}?fetchHostCatalog\(/,
    '★ `getCatalog` 要从宿主取（`fetchHostCatalog`），不是返回一个写死的空表',
  )
  // ★ 取不到时要说出来（静默给空目录会让判档"没得出结果"而看不出为什么）
  assert.match(
    src,
    /unavailableReason[\s\S]{0,200}?log\(/,
    '★ 模型表取不到时要留痕 —— 否则"判档为什么没结果"无从查起',
  )
})
