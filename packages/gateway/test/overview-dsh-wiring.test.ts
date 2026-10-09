/**
 * 总览 `dsh` 字段的**接线守卫**（用户 2026-10-09 裁定 ③）。
 *
 * ## 它拦的是什么
 *
 * `buildOverview()` 里那行
 * `...(context.dsh === undefined ? {} : { dsh: context.dsh })`
 * 原来**被写在 `time` 对象里面**（缩进也是错的），而 `Overview` 把 `dsh` 声明在**顶层**。
 *
 * 后果不是报错，是**彻底静默**：
 *  - `overview.dsh` 永远是 `undefined` ⇒ 面板永远显示"DSH 状态未知"；
 *  - 而这个字段存在的**全部理由**就是"**DSH 挂了时面板看起来一切正常**"
 *    （见 `src/dsh-status.ts` 的模块注释）—— 它失效得毫无声息，正是它要防的那种故障；
 *  - 探针**照跑、开销照付**（`api.ts` 里 `dsh: await dshStatusProbe()`），返回值被扔进
 *    `time` 里没人读 —— 白探。
 *
 * TypeScript **拦不住**：对象字面量里的**展开不触发多余属性检查**（展开的键被视为
 * "可能存在"），所以 `{ time: { …, dsh } }` 与 `Overview` 的 `time: {…}`
 * 类型兼容。⇒ 只有断言能守住，而且必须同时在**行为**和**语句位置**两层守。
 *
 * ## 为什么两层都要
 *
 *  - 只有行为层：有人把 `dsh` 挪回 `time` 里，行为层立刻红 —— 够，但它解释不了
 *    "为什么红"，也守不住"结果被丢掉但恰好没触发断言"的变体；
 *  - 只有源码层：源码长得对、运行时却因为别的分支没赋值 —— 行为层才看得见。
 *
 * @module forlife-gateway/test/overview-dsh-wiring
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import { buildOverview } from '../src/admin/overview.ts'
import type { DshStatus } from '../src/dsh-status.ts'

const opened: { close: () => void }[] = []

after(() => {
  for (const handle of opened) handle.close()
})

/** 全新的内存库（迁移会自动建表）。 */
function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

/**
 * 一份"DSH 连不上"的探针返回值 —— 正是这个字段存在的理由。
 *
 * 刻意用 `reachable: false`（而不是 `undefined`）：`undefined` 表示"没配 URL、
 * 无法判断"，两者混起来正是 `dsh-status.ts` 明确要避免的事，测试里也不该混。
 */
const PROBE: DshStatus = {
  reachable: false,
  latencyMs: 812,
  error: 'TimeoutError: The operation was aborted due to timeout',
  at: '2026-10-09T12:00:00.000Z',
  url: 'http://127.0.0.1:3080',
  wakeBridgeConfigured: true,
  wakeBridgeUrl: 'http://127.0.0.1:3080/forlife/wake',
  note: 'DSH web 后端连不上 —— 模型那一侧可能没在跑（面板与 QQ 仍然正常，这是最难查的一种故障）',
}

const readSource = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * 必须去注释：本仓注释写得很细，`dsh` / `time` 这类词在说明里反复出现 ——
 * 直接 `text.includes(...)` 会让守卫**自己满足自己**（本项目在
 * `param-consumption.test.ts` 与 `mid-window-wiring.test.ts` 上都栽过这个坑）。
 */
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

/**
 * 取 `buildOverview()` 的函数体（去注释后按花括号配平）。
 *
 * ⚠️ **不能从签名行就开始配平**：参数表里有一个内联对象类型（`context: { … }`），
 * 那对花括号会让配平在函数体开始之前就归零。先定位函数体开头那一行（`): Overview {`）。
 */
function buildOverviewBody(): readonly string[] {
  const lines = stripComments(readSource('../src/admin/overview.ts')).split('\n')
  const sigAt = lines.findIndex((line) => line.includes('export function buildOverview('))
  assert.ok(sigAt >= 0, 'overview.ts 里找不到 `export function buildOverview(` —— 接线被删了？')
  const bodyAt = lines.findIndex((line, index) => index > sigAt && /^\s*\):\s*\w+\s*\{/.test(line))
  assert.ok(bodyAt >= 0, '找不到 `): Overview {` 这一行（返回类型改了？守卫要跟着改，别静默通过）')
  const out: string[] = []
  let depth = 0
  for (let i = bodyAt; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    out.push(line)
    if (depth === 0) return out
  }
  assert.fail('`buildOverview()` 的花括号没有配平 —— 守卫取不到函数体，不能静默通过')
}

/** `dsh` 那一行在函数体里出现的位置（找不到就 fail，不许静默通过）。 */
function dshLineIndex(body: readonly string[]): number {
  const at = body.findIndex((line) => line.includes('dsh: context.dsh'))
  assert.ok(
    at >= 0,
    '`buildOverview()` 里找不到把 `context.dsh` 展开进返回值的语句 —— ' +
      '要么字段被删了，要么写法变了（守卫要跟着改，别静默通过）',
  )
  return at
}

/**
 * 某一行**开始之前**的花括号深度。
 *
 * 层数是这样叠的：
 *  - 函数体 `): Overview {` ⇒ 1；
 *  - 返回的对象字面量 `const overview: Overview = {` ⇒ 2 ——
 *    **所以"返回对象的顶层属性"深度是 2**，嵌在 `time: { … }` 里的属性是 3。
 *
 * ⚠️ 别把它当成 1：函数体自己就占了一层（第一版按 1 写，守卫拿自己的正确代码变红了）。
 */
function depthBefore(body: readonly string[], target: number): number {
  let depth = 0
  for (let i = 0; i < target; i += 1) {
    for (const ch of body[i] ?? '') {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  }
  return depth
}

/** 返回对象**顶层属性**应有的花括号深度（函数体 1 层 + 对象字面量 1 层）。 */
const TOP_LEVEL_PROPERTY_DEPTH = 2

/** 按花括号配平取出某个顶层块（例如 `time: {`）的整段源码。 */
function blockAt(body: readonly string[], startAt: number): string {
  const out: string[] = []
  let depth = 0
  for (let i = startAt; i < body.length; i += 1) {
    const line = body[i] ?? ''
    out.push(line)
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth === 0) return out.join('\n')
  }
  assert.fail('块的花括号没有配平 —— 守卫取不到它，不能静默通过')
}

// ════════════════════════════════════════════════════════════════════════════
// ① 行为层：`dsh` 真的在**顶层**，而且就是探针给的那份
// ════════════════════════════════════════════════════════════════════════════

test('★★★ `buildOverview()` 的返回值**顶层**真的有 `dsh`，内容来自探针', () => {
  const db = freshDb()
  const overview = buildOverview(db, { dbPath: ':memory:', startedAt: Date.now(), dsh: PROBE })

  assert.notEqual(
    overview.dsh,
    undefined,
    '`overview.dsh` 是 `undefined` —— 这正是那个缺陷的形态：字段被展开进了别的对象里，' +
      '面板因此永远显示"DSH 状态未知"，而 DSH 挂掉时面板看起来一切正常',
  )
  assert.deepEqual(overview.dsh, PROBE, '`overview.dsh` 必须**原样**是 `dshStatusProbe()` 的返回值')
  assert.equal(
    (overview.time as Record<string, unknown>)['dsh'],
    undefined,
    '`time` 里不该有 `dsh` —— 有它说明字段又被写回 `time` 对象里了（谁都不读那个键）',
  )
})

test('★★ 未探到（`dsh` 不传）⇒ 顶层整个字段不出现（界面显示"—"，不是假的"连不上"）', () => {
  const db = freshDb()
  const overview = buildOverview(db, { dbPath: ':memory:', startedAt: Date.now() })
  assert.equal(
    Object.hasOwn(overview, 'dsh'),
    false,
    '`dsh` 没传进来时该键必须**缺席**（`undefined` 与 `false` 是两件事：' +
      '前者 = 无法判断，后者 = 配了但连不上）',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ② 源码层：语句位置 —— 必须是返回对象的**顶层属性**，不许再钻回 `time` 里
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 守卫：`dsh` 的展开写在返回对象的**顶层**（深度 = 2）', () => {
  const body = buildOverviewBody()
  const at = dshLineIndex(body)
  const depth = depthBefore(body, at)
  assert.equal(
    depth,
    TOP_LEVEL_PROPERTY_DEPTH,
    `\`dsh\` 的展开在花括号深度 ${String(depth)} —— 返回对象的顶层属性应当是 ` +
      `${String(TOP_LEVEL_PROPERTY_DEPTH)}（函数体 1 层 + 对象字面量 1 层）。` +
      '深度 3 就是"被写进了另一个对象里"（原缺陷正是被写进 `time`）：' +
      '`Overview` 把 `dsh` 声明在顶层，展开进别处的键谁都不读 ⇒ 字段永远 `undefined`。',
  )
})

test('★★★ 守卫：`time` 块里不许出现 `dsh`（原缺陷的精确形状）', () => {
  const body = buildOverviewBody()
  const timeAt = body.findIndex((line) => /^\s*time:\s*\{\s*$/.test(line))
  assert.ok(timeAt >= 0, '`buildOverview()` 里找不到顶层 `time: {` 块 —— 结构变了，守卫要跟着改')
  const block = blockAt(body, timeAt)
  assert.ok(
    !block.includes('dsh'),
    '`time` 块里出现了 `dsh` —— 这就是用户报的那个缺陷：' +
      '`overview.dsh` 永远是 `undefined`，面板永远显示"DSH 状态未知"，' +
      '而"DSH 挂了"恰恰是这个字段唯一要报的事',
  )
  // 顺带钉住 `time` 自己的字段没被顺手删掉（改这一行时最容易带走的两个）
  assert.match(block, /authorityTz/, '`time.authorityTz` 不见了 —— 改 dsh 时误删了同块字段？')
  assert.match(block, /lastReadingAt/, '`time.lastReadingAt` 不见了 —— 改 dsh 时误删了同块字段？')
})

test('★★ 守卫：探针的返回值真的被**用上**了（`api.ts` 里传进了 `buildOverview`）', () => {
  const api = stripComments(readSource('../src/admin/api.ts'))
  const at = api.indexOf('buildOverview(db, {')
  assert.ok(at >= 0, 'api.ts 里找不到 `buildOverview(db, {` —— /overview 的组装点变了？')
  // 取这次调用的实参片段（够长即可，不必精确解析）
  const call = api.slice(at, at + 400)
  assert.match(
    call,
    /dsh:\s*await dshStatusProbe\(\)/,
    '`dsh: await dshStatusProbe()` 必须作为**实参**传进 `buildOverview(...)` —— ' +
      '否则探针白探（原缺陷里它传进来了，只是被函数内部展开错了地方）',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 两端一致：前端**声明了**吗、**渲染了**吗
//
// ⚠️ 修之前这里两边都缺：`admin-ui` 全仓没有一处提过 `dsh` —— 类型没声明、界面没渲染。
// 于是"修好数据链"这句话只做了一半：接口给了字段，面板照样永远显示不出 DSH 状态，
// 而"DSH 挂了时面板看起来一切正常"这个故障**一点没被解决**。
// ════════════════════════════════════════════════════════════════════════════

const ADMIN_UI_TYPES = stripComments(readSource('../../admin-ui/src/api/types.ts'))
const OVERVIEW_VIEW = stripComments(readSource('../../admin-ui/src/views/OverviewView.vue'))

test('★★ 守卫：`admin-ui` 的类型里有 `dsh`（两端契约对齐）', () => {
  assert.match(
    ADMIN_UI_TYPES,
    /export interface DshStatus\s*\{/,
    '`admin-ui/src/api/types.ts` 必须声明 `DshStatus` —— gateway 给了字段而前端没类型，' +
      '下一步就一定有人用 `any` 绕过它',
  )
  // 必须在 `Overview` 里、且是可选的（服务端未探到时整段缺席）
  const overviewAt = ADMIN_UI_TYPES.indexOf('export interface Overview')
  assert.ok(overviewAt >= 0, '找不到 `export interface Overview`')
  const overviewBody = ADMIN_UI_TYPES.slice(overviewAt, ADMIN_UI_TYPES.indexOf('\n}', overviewAt))
  assert.match(
    overviewBody,
    /readonly dsh\?: DshStatus/,
    '`Overview` 必须有 `readonly dsh?: DshStatus` —— 可选是**语义**（缺席 = 服务端没探到，' +
      '与 `reachable: undefined`（没配 URL）是两件事）',
  )
})

test('★★★ 守卫：总览页**真的渲染** `dsh`（不是声明了就完）', () => {
  assert.match(
    OVERVIEW_VIEW,
    /dshCard\(d\.dsh\)/,
    '总览页必须把 `d.dsh` 交给 `dshCard()` —— 只声明不渲染等于白探，' +
      '而"DSH 挂了时面板看起来一切正常"正是这个字段唯一要报的事',
  )
  // 语句位置：要在**第一排**（"现在要不要动手"）里，不是藏在某个角落的说明文字里
  const healthAt = OVERVIEW_VIEW.indexOf('const health = computed')
  assert.ok(healthAt >= 0, '找不到 `const health = computed` —— 第一排指标卡被重写了？')
  const healthBody = OVERVIEW_VIEW.slice(healthAt, OVERVIEW_VIEW.indexOf('})', healthAt))
  assert.match(healthBody, /dshCard\(d\.dsh\)/, 'DSH 卡必须在第一排的 `health` 列表里（它挂了，下面每一张卡看起来都正常）')
  // 三种"不知道"必须分开，不许塌成一个布尔
  assert.match(OVERVIEW_VIEW, /dsh\.reachable === undefined/, '"没配 URL" 必须与 "连不上" 分开判断')
  assert.match(OVERVIEW_VIEW, /dsh === undefined/, '"服务端没探到" 也必须单独判——三种状态塌成一个就白做了')
})
