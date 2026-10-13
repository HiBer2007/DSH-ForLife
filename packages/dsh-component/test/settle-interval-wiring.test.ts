/**
 * ★★ 沉降循环间隔的守卫（`FIX_PLAN.md` §69）。
 *
 * ## 用户原话
 * 「沉降循环不用 30 分钟一轮这么频繁，可以**可调**，**最低为惰性**
 *  （即**被动模式，不主动通过计时器来触发**）同样由**模型和外部共同决定**，
 *   且在**工具的说明中提示 AI 越低越好（遗忘慢、省钱）**，**默认为惰性**」
 *
 * ## 五件事，各自都能单独坏掉
 * 1. ★ **默认为惰性**：不配任何东西 ⇒ `intervalMs === 0`
 * 2. ★ **惰性 = 不排计时器**（不是"排一个 0ms 的表"，也不是"未启用"）
 * 3. ★ **模型可改**：工具写 `forlife_state`，且**改了立刻生效**（`reconfigure()`）
 * 4. ★ **外部可改**：环境变量优先
 * 5. ★★ **工具描述里必须有"越低越好（遗忘慢、省钱）"** —— ★ 这是**用户点名要的**，
 *    也是这条工具存在的意义（模型天然倾向"多做点事"，而沉降跑得越勤**忘得越快、越费钱**）
 *
 * ★ 每条守卫都跑过注入验证。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { getState } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import {
  MemoryRuntime,
  SETTLE_INTERVAL_STATE_KEY,
  settleTimerConfigFromEnv,
  startSettleTimer,
  type SettleTimerTarget,
} from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

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

function tempRuntime(tag: string): { readonly runtime: MemoryRuntime; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `forlife-${tag}-`))
  const runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
  return {
    runtime,
    cleanup: () => {
      try {
        runtime.close()
      } catch {
        // 关库失败不影响断言
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 文件锁
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ① 默认惰性
// ════════════════════════════════════════════════════════════════════════════

test('★★ 基线 `tiering.settleIntervalMs` = **0（惰性）**', () => {
  assert.equal(
    defaultFor<number>('tiering.settleIntervalMs'),
    0,
    '★ 用户要「**默认为惰性**」⇒ 基线必须是 0（改之前是代码里写死的 30 分钟）。',
  )
})

test('★★ 不配任何环境变量 ⇒ 配置成惰性，但**仍然是"已启用"**', () => {
  const cfg = settleTimerConfigFromEnv({})
  assert.equal(cfg.intervalMs, 0, '★ 默认惰性')
  assert.equal(
    cfg.enabled,
    true,
    '★ 惰性**不是**"未启用" —— 循环还在（`tick()` 仍能手动跑），只是不排计时器。' +
      '★ 这两件事混起来的话，日志里"被动模式"与"没挂上"就分不出来了。',
  )
})

test('★★ `0` 是**合法**取值（惰性），非法值才退回默认', () => {
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: '0' }).intervalMs, 0, '★ 显式 0 ⇒ 惰性')
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: '-1' }).intervalMs, 0, '负数 ⇒ 基线默认')
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: 'abc' }).intervalMs, 0, 'NaN ⇒ 基线默认')
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: '3600000' }).intervalMs, 3_600_000)
})

// ════════════════════════════════════════════════════════════════════════════
// ② 惰性 = 不排计时器
// ════════════════════════════════════════════════════════════════════════════

test('★★ 惰性 ⇒ **一次表都不排**（但 `tick()` 还能手动跑）', () => {
  let scheduled = 0
  const logs: string[] = []
  const timer = startSettleTimer(
    { settle: () => ({ fragmented: 0, archived: 0, notes: ['替身'] }) },
    {
      log: (m) => logs.push(m),
      env: {},
      setTimeoutImpl: () => {
        scheduled += 1
        return { unref: () => {} }
      },
    },
  )
  assert.equal(scheduled, 0, '★ 惰性 = **不主动通过计时器触发**（用户原话）')
  assert.equal(typeof timer.tick, 'function', '★ 循环还在 —— `tick()` 仍然能手动跑')
  assert.ok(
    logs.some((m) => m.includes('被动模式')),
    `★ 必须说清"它是被动模式"，而不是让人以为"没挂上"。实际日志：${logs.join(' | ')}`,
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 模型可改 + 改了立刻生效
// ════════════════════════════════════════════════════════════════════════════

test('★★ 模型设的间隔**真的**落进 `forlife_state`，且 `0` 能被区分出来', () => {
  const { runtime, cleanup } = tempRuntime('settle-int')
  try {
    assert.equal(runtime.settleIntervalOverrideMs(), undefined, '★ 没设过 ⇒ `undefined`（"没表态"）')
    runtime.setSettleInterval(3_600_000)
    assert.equal(getState(runtime.db, SETTLE_INTERVAL_STATE_KEY), '3600000')
    assert.equal(runtime.settleIntervalOverrideMs(), 3_600_000)
    runtime.setSettleInterval(0)
    assert.equal(
      runtime.settleIntervalOverrideMs(),
      0,
      '★ **0 与"没表态"必须分得开** —— 否则模型选了惰性会被当成"没配"、退回基线的值',
    )
  } finally {
    cleanup()
  }
})

test('★★ 改间隔会**立刻重排表**（`reconfigure()` 被真的调到）', () => {
  const { runtime, cleanup } = tempRuntime('settle-reconf')
  try {
    let reconfigured = 0
    runtime.attachSettleTimer({
      reconfigure: () => {
        reconfigured += 1
      },
    })
    runtime.setSettleInterval(60_000)
    assert.equal(reconfigured, 1, '★ 改完必须踢一下定时器')
    runtime.setSettleInterval(0)
    assert.equal(reconfigured, 2, '★ 切成惰性时也要踢（要取消已排的表）')
  } finally {
    cleanup()
  }
})

test('★★ 负数被挡住，且**不留半截值**', () => {
  const { runtime, cleanup } = tempRuntime('settle-neg')
  try {
    assert.throws(() => runtime.setSettleInterval(-1), /不小于 0/)
    assert.throws(() => runtime.setSettleInterval(Number.NaN), /不小于 0/)
    assert.equal(getState(runtime.db, SETTLE_INTERVAL_STATE_KEY), undefined, '★ 挡住之后不许写坏值')
  } finally {
    cleanup()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 每轮现读（模型的改动不用重启）
// ════════════════════════════════════════════════════════════════════════════

test('★★ `startSettleTimer` **每轮现读**间隔（模型的改动不用重启）', () => {
  let interval = 0
  let scheduled = 0
  const timers: (() => void)[] = []
  const timer = startSettleTimer(
    {
      settle: () => ({ fragmented: 0, archived: 0, notes: ['替身'] }),
      settleIntervalOverrideMs: () => interval,
    },
    {
      log: () => {},
      env: { FORLIFE_SETTLE_INTERVAL_MS: '60000' },
      setTimeoutImpl: (fn) => {
        scheduled += 1
        timers.push(fn)
        return { unref: () => {} }
      },
      clearTimeoutImpl: () => {},
    },
  )
  // ★ 模型说惰性（0）⇒ 覆盖环境变量的 60000 ⇒ 一次都不排
  assert.equal(scheduled, 0, '★ **模型的值优先于环境变量**（用户要"由模型和外部共同决定"）')
  // ★ 模型改成 1 小时 ⇒ 踢一下 ⇒ 排上了
  interval = 3_600_000
  timer.reconfigure()
  assert.equal(scheduled, 1, '★ 从惰性切到定时：`reconfigure()` 之后必须排上')
  // ★ 再切回惰性 ⇒ 踢一下 ⇒ 取消（不再排新的）
  interval = 0
  timer.reconfigure()
  const before = scheduled
  timers[0]?.() // 让已排的那一轮跑掉，它会尝试排下一轮
  assert.equal(scheduled, before, '★ 切回惰性之后，跑完这一轮**不该再排下一轮**')
  timer.stop()
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 工具描述里那句"越低越好"（★ 用户点名要的）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 工具描述里必须有「LOWER IS BETTER」以及"忘得快、费钱"的道理', () => {
  const body = stripComments(read('../src/tools.ts'))
  const start = body.indexOf("name: 'set_settle_interval'")
  assert.ok(start >= 0, '找不到 `set_settle_interval` 工具')
  const tool = body.slice(start, start + 2400)
  assert.ok(
    tool.includes('LOWER IS BETTER'),
    '★ 用户**点名要**「在工具的说明中提示 AI **越低越好**」—— 这是这条工具存在的意义：' +
      '★ 模型天然倾向"多做点事"，不写这句它会想把沉降调勤，而**跑得越勤、忘得越快**。',
  )
  assert.ok(
    tool.includes('faster you forget') || tool.includes('forget'),
    '★ 要说清代价：**忘得越快**（entries disappear from your view）',
  )
  assert.ok(
    tool.includes('costs') || tool.includes('cost'),
    '★ 要说清代价：**越费钱**（every round scans and writes）',
  )
  assert.ok(
    tool.includes('`0`') && tool.includes('passive'),
    '★ 要说清 `0` = **passive** —— 否则模型不知道该拿什么值表达"最省"。',
  )
})

test('★★★ 拥挤时**优先手动**，而不是首选开定时器；且说清"二者完全一致"', () => {
  // ★★ 用户 2026-10-11 原话：
  //   「明确感到"中期区太挤、检索变慢" 应该提醒模型此情况下**优先使用手动触发中期压缩的工具**，
  //     而不是**首选启动自动触发机制**。提醒模型**二者的工作原理完全一致**。」
  const body = stripComments(read('../src/tools.ts'))

  // ① `set_settle_interval` 必须**劝退**，并把模型指向手动工具
  const autoIdx = body.indexOf("name: 'set_settle_interval'")
  const auto = body.slice(autoIdx, autoIdx + 2400)
  assert.ok(
    auto.includes('do NOT reach for this tool first'),
    '★ 定时器那条必须**明确劝退**（"do NOT reach for this tool first"）—— ' +
      '★ 否则模型看到"中期区太挤"的第一反应就是来这里开个定时器。',
  )
  assert.ok(
    auto.includes('settle_mid_now'),
    '★ 劝退之后必须**给出替代**（指向 `settle_mid_now`）—— 只说"别用这个"等于没说。',
  )
  assert.ok(
    auto.includes('exactly the same work'),
    '★ 用户要求「提醒模型**二者的工作原理完全一致**」—— 这句必须出现。',
  )

  // ② 手动工具必须存在，且同样说清"完全一致" + "优先用它"
  const nowIdx = body.indexOf("name: 'settle_mid_now'")
  assert.ok(nowIdx >= 0, '★ 手动触发工具必须存在 —— 这是用户这条指令的核心缺口')
  const manual = body.slice(nowIdx, nowIdx + 2400)
  assert.ok(
    manual.includes('EXACTLY the same work'),
    '★ 手动那条也要说「**二者完全一致**」—— ★ 两边都写，模型从哪条进来都能看到。',
  )
  assert.ok(
    manual.includes('prefer it over turning on the auto timer'),
    '★ 手动那条要**明确说优先**（"prefer it over turning on the auto timer"）。',
  )

  // ③ ★ "完全一致"必须**是真的**：两边调用同一个 `runtime.settle()`
  //    —— 否则描述就是在骗模型（本仓最忌讳"文档说一套、代码做一套"）
  const manualBody = body.slice(nowIdx, body.indexOf('})', nowIdx))
  assert.ok(
    manualBody.includes('runtime.settle()'),
    '★ 手动工具的 `execute` 必须调 `runtime.settle()` —— 定时器的 `tick()` 调的就是它。' +
      '★ 只有这样"二者工作原理完全一致"才是**事实**而不是安慰话。',
  )
})

test('★★ 工具在名表里、在返回数组里（语句位置）', () => {
  const body = stripComments(read('../src/tools.ts'))
  const namesIdx = body.indexOf('export const MEMORY_TOOL_NAMES')
  const namesTail = body.slice(namesIdx, body.indexOf('] as const', namesIdx))
  assert.ok(namesTail.includes("'set_settle_interval'"), '★ 名表里要有它')
  assert.ok(namesTail.includes("'settle_mid_now'"), '★ 名表里也要有手动触发那条')
  const retIdx = body.indexOf('return [remember,')
  assert.ok(retIdx >= 0, '找不到 `buildMemoryTools` 的返回数组')
  const returned = body.slice(retIdx, body.indexOf(']', retIdx))
  assert.ok(returned.includes('setSettleInterval'), '★ **只定义不返回 = 模型拿不到它**')
  assert.ok(returned.includes('settleMidNow'), '★ 手动触发那条也要在返回数组里')
})
