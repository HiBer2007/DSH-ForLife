/**
 * ★★ 维护循环的**手动触发途径**守卫（`FIX_PLAN.md` §72）。
 *
 * ## 用户原话
 * 「新增工具 settle_mid_now（手动触发一次沉降）**PLAN 中有说过，所有的沉降都有手动触发途径，
 *   都有工具触发途径**。忘了？**再看看**」
 *
 * ## PLAN 出处
 * - ★ `src-01.md:342`：「按需触发**沉降/碎片维护/复盘**任务」
 * - ★ `src-08.md:346`：「碎片索引合并与淘汰（**定时 + 手动**）」
 * - ★★ `ComingSoonView.vue:51` 已经对用户承诺过：
 *      「手动触发一次压缩（**走与自动路径完全相同的引擎**）」
 *
 * ## 这条守卫要钉的三件事
 * 1. ★ **句柄真的被交出来了**（`runtime.ts` 的返回里，不是局部变量）
 * 2. ★ **真的被接到了 admin API**（`server.ts` 传参）
 * 3. ★★ **手动触发调的就是自动那条 `tick()`** ——
 *    ★ 这是"走与自动路径完全相同的引擎"这句承诺的**唯一凭据**；
 *    ★ 另写一套实现的话，PLAN §2.14.14 说的
 *      「面板点了压缩，实际参数与自动压缩不一样」就会发生，**且极难发现**。
 *
 * ★ 每条守卫都跑过注入验证。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 去掉注释（尊重字符串/模板字面量）—— 本仓注释里就写着这些约定，不去掉会自己满足自己。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// ① 句柄被交出来了（★ 语句位置：在 return 的对象字面量里）
// ════════════════════════════════════════════════════════════════════════════

test('★★ `createGatewayRuntime` 把维护句柄**放进返回值**（不是局部变量）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  // ★ 接口上有这个字段
  assert.ok(
    body.includes('readonly maintenance: SettleLoop'),
    '★ `RunningGatewayRuntime` 必须有 `maintenance` —— 否则外面拿不到它。',
  )
  // ★★ 语句位置：必须在 `return {` 的那个对象里
  const retIdx = body.indexOf('return {\n    transport,')
  assert.ok(retIdx >= 0, '找不到 `createGatewayRuntime` 的返回对象（形状变了？守卫要跟着改）')
  const returned = body.slice(retIdx, body.indexOf('\n  }', retIdx))
  assert.ok(
    returned.includes('maintenance: settleLoop'),
    '★★ 必须在**返回对象里**交出去。★ 只加接口字段不加返回 = 类型骗人、运行时是 undefined。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ② 被接到了 admin API
// ════════════════════════════════════════════════════════════════════════════

test('★★ `server.ts` 把句柄传给了 `createAdminApi`（在调用实参里）', () => {
  const body = stripComments(read('../src/server.ts'))
  const callIdx = body.indexOf('createAdminApi({')
  assert.ok(callIdx >= 0, '找不到 `createAdminApi` 的调用')
  const call = body.slice(callIdx, body.indexOf('\n      })', callIdx))
  assert.ok(
    call.includes('maintenance: runtime.maintenance'),
    '★★ 必须传进去。★ 只在 `runtime.ts` 暴露、不在这里接上 ⇒ **面板永远看不到它**' +
      '（本仓栽过 20+ 次"库写好了、生产路径零调用"）。',
  )
})

test('★★ `AdminApiOptions` 声明了 `maintenance`（可选）', () => {
  const body = stripComments(read('../src/admin/api.ts'))
  assert.ok(
    body.includes('readonly maintenance?: SettleLoop | undefined'),
    '★ 选项上要有它。★ 可选（测试/未配 `FORLIFE_ROOT_HOT` 时没有）。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ ★★ 手动跑的就是自动那条 tick()（"完全相同的引擎"）
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 端点调的是 `m.tick()` —— 与自动路径**同一条代码路径**', () => {
  const body = stripComments(read('../src/admin/api.ts'))
  const runIdx = body.indexOf("route === '/maintenance/run'")
  assert.ok(runIdx >= 0, '找不到 `/maintenance/run` 端点')
  const handler = body.slice(runIdx, runIdx + 1800)
  assert.ok(
    handler.includes('await m.tick(scope)'),
    '★★★ 必须调 `tick(...)`。★ 这是 `ComingSoonView` 对用户那句承诺' +
      '「**走与自动路径完全相同的引擎**」的**唯一凭据**。\n' +
      '★ 若改成另写一套"整理型"实现，PLAN §2.14.14 说的' +
      '「面板点了压缩，实际参数与自动压缩不一样」就会发生，**且极难发现**。',
  )
  // ★★ 2026-10-12（`FIX_PLAN.md` §76.5④）：端点现在多了一个**可选**作用域
  //    （`{only:'fragments'}` = 只跑碎片维护，PLAN `src-08.md:346` 点名要"定时 + 手动"的那一项）。
  //    ★ 但"不传"必须仍然是 `undefined` —— 那才是三样都跑、与自动那条**完全一致**。
  assert.ok(
    handler.includes("const scope = only === 'fragments' ? ('fragments' as const) : undefined"),
    '★★ 不传 `only` 时必须传 `undefined`（= `tick()` 的三样都跑）。\n' +
      '★ 若默认值变成 `\'fragments\'`，面板上那个"跑一轮"就不再是自动那条腿的同一条路径了。',
  )
})

test('★★★ 定时那条也是 `tick()`（两边确实是同一个函数）', () => {
  const body = stripComments(read('../src/settle-loop.ts'))
  // ★ 定时器的排程里必须调 tick() —— 否则"手动/自动一致"就是空话
  const scheduleIdx = body.indexOf('const schedule = ')
  assert.ok(scheduleIdx >= 0, '找不到 `schedule`')
  const schedule = body.slice(scheduleIdx, scheduleIdx + 400)
  assert.ok(
    schedule.includes('tick()'),
    '★ 定时器排的必须也是 `tick()` —— 这样"手动与自动一致"才是**事实**。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 端点该有的纪律（PLAN src-04.md:277）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 写端点走统一写通道 + 落审计 + 鉴权', () => {
  const body = stripComments(read('../src/admin/api.ts'))
  const runIdx = body.indexOf("route === '/maintenance/run'")
  const handler = body.slice(runIdx, runIdx + 1800)
  assert.ok(handler.includes('checkStateChange(req)'), '★ PLAN `src-04.md:277`：写操作必须走统一写通道')
  assert.ok(handler.includes('requireSession(req, res, path)'), '★ 必须鉴权')
  assert.ok(handler.includes("action: 'maintenance.run'"), '★ 必须落审计（谁、什么时候、跑了什么）')
})

test('★★ 没有句柄时**如实报"跑不了"**，不假装成功', () => {
  const body = stripComments(read('../src/admin/api.ts'))
  const runIdx = body.indexOf("route === '/maintenance/run'")
  const handler = body.slice(runIdx, runIdx + 1800)
  assert.ok(
    handler.includes('m === undefined'),
    '★ 必须有"没有句柄"的分支 —— ★ 否则会出现「面板说跑了、实际什么都没发生」' +
      '（§52：**"没做"与"做了但被挡住"看起来一样**）。',
  )
  // ★ GET 那条也要如实说
  const getIdx = body.indexOf("route === '/maintenance'")
  const getHandler = body.slice(getIdx, getIdx + 900)
  assert.ok(getHandler.includes('available: false'), '★ 状态端点要能说"不可用"')
  assert.ok(
    getHandler.includes('passive:'),
    '★ 要报 `passive`（间隔 0 = 惰性）—— ★ 而"惰性"恰恰是手动触发最有用的场景，' +
      '面板得能看出现在是哪种。',
  )
})
