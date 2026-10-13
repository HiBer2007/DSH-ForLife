/**
 * ★★ 维护请求的**接线**守卫（`FIX_PLAN.md` §72 / §74）。
 *
 * ## 用户原话
 * 「所有的沉降**都有手动触发途径，都有工具触发途径**」
 *
 * ## 这条链有四段，每段都能单独断掉
 * 1. ★ **模型侧**：工具 `request_maintenance` 存在、在名表、在返回数组，且**写的是请求**（不是自己跑维护）
 * 2. ★ **认领侧**：`gateway/runtime.ts` **真的启动了**轮询器（本仓栽过 20+ 次"库写好了、生产路径零调用"）
 * 3. ★★ **同一引擎**：认领之后跑的是 **`settleLoop.tick()`** —— 不是另写一套
 * 4. ★ **`only: 'fragments'`**：跳过 blob 与长期沉降，但**碎片那一段照原样跑**
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

const tools = (): string => stripComments(read('../../dsh-component/src/tools.ts'))

// ════════════════════════════════════════════════════════════════════════════
// ① 模型侧：工具存在且**写请求**（不是自己跑维护）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 工具 `request_maintenance` 在名表里、在返回数组里', () => {
  const body = tools()
  const namesIdx = body.indexOf('export const MEMORY_TOOL_NAMES')
  const namesTail = body.slice(namesIdx, body.indexOf('] as const', namesIdx))
  assert.ok(namesTail.includes("'request_maintenance'"), '★ 名表里要有它')
  const retIdx = body.indexOf('return [remember,')
  assert.ok(retIdx >= 0, '找不到 `buildMemoryTools` 的返回数组')
  const returned = body.slice(retIdx, body.indexOf(']', retIdx))
  assert.ok(returned.includes('requestMaintenance'), '★ **只定义不返回 = 模型拿不到它**')
})

test('★★★ 工具写的是**请求**，不是自己跑维护（owner 唯一）', () => {
  const body = tools()
  const idx = body.indexOf("name: 'request_maintenance'")
  assert.ok(idx >= 0, '找不到工具')
  const tool = body.slice(idx, idx + 6000)
  assert.ok(
    tool.includes('enqueueMaintenanceRequest(runtime.db'),
    '★★ 必须**写一条请求**。★ 理由：维护循环**只该有一个 owner**' +
      '（`settle-loop.ts` 的模块头：冷层根路径只有那个进程解析得到；' +
      '插件可能被多个 profile 各起一份 ⇒ 各自搬文件会**互相踩**）。',
  )
  // ★ 反向断言：不许在插件侧直接调那些维护函数（那就成了第二个 owner）
  for (const forbidden of ['settleBlobs(', 'settleLongEntries(', 'evictFragments(']) {
    assert.ok(
      !tool.includes(forbidden),
      `★ 工具里不许直接调 \`${forbidden}\` —— ★ 那会让插件变成**第二个 owner**，` +
        '与"只该有一个 owner"冲突。',
    )
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② 认领侧：轮询器**真的被启动了**
// ════════════════════════════════════════════════════════════════════════════

test('★★★ `gateway/runtime.ts` 真的启动了轮询器（语句位置）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  assert.ok(
    body.includes('const maintenanceRequests = startMaintenanceRequestLoop({'),
    '★★ 必须**真的启动**。★ 本仓栽过 20+ 次"库写好了、生产路径零调用" —— ' +
      '只定义不启动 = 模型写的请求**永远没人认领**。',
  )
  assert.ok(
    body.includes('maintenanceRequests.stop()'),
    '★ 卸载时要停表（热重载不能重复挂）。',
  )
})

test('★★ 轮询器不在时**说清"未启动"**，不静默', () => {
  const body = stripComments(read('../src/maintenance-requests-loop.ts'))
  assert.ok(
    body.includes('维护请求轮询：未启动'),
    '★ 间隔 0 时要喊一声 —— 否则"没启动"与"启动了但没请求"看起来一样（§52）。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ ★★ 同一引擎
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 认领之后跑的是 **`settleLoop.tick()`** —— 不是另写一套', () => {
  const body = stripComments(read('../src/runtime.ts'))
  const idx = body.indexOf('startMaintenanceRequestLoop({')
  assert.ok(idx >= 0, '找不到启动点')
  const call = body.slice(idx, idx + 900)
  assert.ok(
    call.includes('await settleLoop.tick('),
    '★★★ `run` 必须调 **`settleLoop.tick()`**。★ 这是 `ComingSoonView.vue:51` 对用户那句承诺' +
      '「**走与自动路径完全相同的引擎**」的**唯一凭据**。\n' +
      '★ 若换成另写一套，PLAN §2.14.14 说的' +
      '「面板点了压缩，实际参数与自动压缩不一样」就会发生，**且极难发现**。',
  )
})

test('★★★ 轮询器本身**不认识**维护函数（它只负责认领 + 调注入进来的 run）', () => {
  const body = stripComments(read('../src/maintenance-requests-loop.ts'))
  // ★ 反向断言：轮询器里不许出现任何维护实现 —— 它只能调 `options.run`
  for (const forbidden of ['settleBlobs', 'settleLongEntries', 'mergeFragmentIndex', 'evictFragments']) {
    assert.ok(
      !body.includes(forbidden),
      `★ 轮询器里不许出现 \`${forbidden}\` —— ★ 它的职责只是"认领 + 把活交给注入的 run"，` +
        '自己认识维护函数就等于**又开了一条实现路径**。',
    )
  }
  assert.ok(body.includes('await options.run(request.kind)'), '★ 只能通过注入的 `run` 干活')
})

// ════════════════════════════════════════════════════════════════════════════
// ④ `only: 'fragments'` 跳过两段、但碎片那段照跑
// ════════════════════════════════════════════════════════════════════════════

test("★★★ `only === 'fragments'` 跳过 blob 与长期沉降，**碎片那段照原样跑**", () => {
  const body = stripComments(read('../src/settle-loop.ts'))
  const tickIdx = body.indexOf('const tick = async (only?')
  assert.ok(tickIdx >= 0, '找不到 `tick(only?)`')
  const tick = body.slice(tickIdx, body.indexOf('\n  }', tickIdx))

  // ★ 两处闸
  const guards = tick.split("only !== 'fragments'").length - 1
  assert.equal(
    guards,
    2,
    '★ 必须**恰好两处**闸（blob 搬运 + 长期 HDD 沉降）。★ 少一处 ⇒ `fragments` 模式仍会搬文件；' +
      '★ 多一处 ⇒ 碎片维护本身被跳过（那就成了"什么都没做"）。',
  )
  // ★ 语句位置：blob 那段必须在闸里面
  const blobIdx = tick.indexOf('await settleBlobs(')
  const firstGuard = tick.indexOf("only !== 'fragments'")
  assert.ok(
    blobIdx > firstGuard,
    '★ `settleBlobs(` 必须在第一处闸**之后**（在里面），否则 `fragments` 模式照样搬文件。',
  )
  // ★★ 碎片那一段必须在**闸外**（两种模式都跑）。
  //
  // ⚠️ 它的位置是**两处闸之间**（blob 闸之后、长期闸之前）——
  //   ★ 这不是笔误：★ blob 与长期沉降各有一段，碎片维护夹在中间且**不加闸**。
  //   ★ 我第一版断言写成"在两处闸之后"，**那是错的**（断言写错，不是代码错）。
  const fragIdx = tick.indexOf('shouldRunFragmentMaintenance(')
  assert.ok(fragIdx > 0, '找不到碎片维护那段')
  const secondGuard = tick.indexOf("only !== 'fragments'", firstGuard + 1)
  assert.ok(secondGuard > 0, '找不到第二处闸（长期沉降那段）')
  assert.ok(
    fragIdx > firstGuard && fragIdx < secondGuard,
    '★★ 碎片维护那段必须在**两处闸之间** ⇒ ★ 它**不在任何闸里**，`fragments` 模式下照原样跑。' +
      '★ 若它落进任何一处闸，`fragments` 模式就变成"什么都没做"。',
  )
})

test('★ `tick` 的类型签名带上可选参数（面板与认领者都要能用）', () => {
  const body = stripComments(read('../src/settle-loop.ts'))
  assert.ok(
    body.includes("readonly tick: (only?: 'fragments') => Promise<SettleTickResult>"),
    '★ 接口签名要跟着改 —— 否则认领者传 `only` 时类型不过（或者更糟：被静默忽略）。',
  )
})
