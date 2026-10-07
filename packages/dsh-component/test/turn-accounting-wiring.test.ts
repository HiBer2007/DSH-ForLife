/**
 * **接线守卫**：轮次记账（A）、召回额度重置（B）、启动回滚与沉降循环（E）。
 *
 * ## 为什么单独一个文件
 *
 * 这一批缺陷的共同形状是：**函数写好了、单测全绿、生产路径上零调用**。
 *  - `beginTurn()` / `observeShortTokens()` 只被测试调用
 *    ⇒ `acct_short_tokens` / `acct_turns_since_compaction` 恒为 0
 *    ⇒ `decideCompaction` 一律 `too_thin` ⇒ **模型自主压缩在生产里不可用**；
 *  - `resetCycle()` **全仓零调用** ⇒ `recallThisCycle` 只增不减
 *    ⇒ 额度用光之后**模型再也想不起长期记忆**；
 *  - `recoverPendingCompactions()` 零调用 ⇒ 崩溃后残留的半写压缩事务永不回滚；
 *  - `settle()` 只有验收测试在调 ⇒ "定时沉降"只存在于测试里。
 *
 * 单元测试**抓不到这一类问题**（它们直接调函数，绕过接线）。
 * 所以这里有两层：
 *  ① **读源码断言调用点存在**（不好看，但拦的正是"线上根本没跑"）；
 *  ② **用假 ctx 驱动真函数**（喂 `turn/start` / `turn/end` 事件，看库里的状态真的变了）。
 *
 * 每一条都做过"最小翻转"验证：把接线去掉一个条件，它必须变红。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { beginCompactionRun, getCompactionRun, openDatabase } from '@forlife/store'

import { applyCompactionDecision } from '../src/compaction-engine.ts'
import { resolveConfig } from '../src/config.ts'
import { activeRuntimes, apply, registerTurnAccounting, shortTokensFromUsage } from '../src/index.ts'
import { MemoryRuntime, settleTimerConfigFromEnv, startSettleTimer, type SettleTimerTarget } from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-turnacct-'))

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

/** 某个函数体（从签名切到下一个顶层 `export`）—— 源码守卫用，避免匹配到别处。 */
function bodyOf(src: string, signature: string, nextSignature: string): string {
  const from = src.indexOf(signature)
  assert.ok(from > 0, `源码里找不到 ${signature}（接线被删了？）`)
  const to = src.indexOf(nextSignature, from)
  return src.slice(from, to > from ? to : undefined)
}

// ── 假上下文（与 loop-guard-register.test.ts / wiring.test.ts 同风格）──────────

interface FakeCtx {
  readonly ctx: never
  readonly events: string[]
  readonly handlers: Map<string, ((...args: unknown[]) => void)[]>
  readonly fire: (...args: unknown[]) => void
  readonly disposeCount: () => number
}

function fakeCtx(
  options: { readonly withOn?: boolean; readonly tokenMeter?: (session: unknown) => unknown } = {},
): FakeCtx {
  const events: string[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  let disposed = 0
  const ctx: Record<string, unknown> = {
    get: (name: string): unknown =>
      name === 'tokenMeter' && options.tokenMeter !== undefined ? { measure: options.tokenMeter } : undefined,
  }
  if (options.withOn !== false) {
    ctx['on'] = (event: string, handler: (...args: unknown[]) => void): (() => void) => {
      events.push(event)
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return (): void => {
        disposed += 1
      }
    }
  }
  return {
    ctx: ctx as never,
    events,
    handlers,
    disposeCount: () => disposed,
    // 驱动**所有** session/event 订阅者（apply() 里不止一个）
    fire: (...args: unknown[]) => {
      for (const handler of handlers.get('session/event') ?? []) handler(...args)
    },
  }
}

function acctOptions(): {
  logs: string[]
  alerts: string[]
  disposers: (() => void)[]
  log: (m: string) => void
  always: (m: string) => void
} {
  const logs: string[] = []
  const alerts: string[] = []
  return { logs, alerts, disposers: [], log: (m) => logs.push(m), always: (m) => alerts.push(m) }
}

/** 宿主真实形状：`{type, seq, time, data}` —— 载荷在 `data` 里（不是平铺在顶层）。 */
function sessionEvent(type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq: 1, time: Date.now(), data }
}

const fakeSession = { id: 'sess_wiring' }

// ════════════════════════════════════════════════════════════════════════════
// ① 源码守卫：调用点必须存在
// ════════════════════════════════════════════════════════════════════════════

test('★★ 守卫：`apply()` 真的调了 `registerTurnAccounting`（只定义不调用 = 又是死代码）', () => {
  const src = read('../src/index.ts')
  assert.match(
    src,
    /registerTurnAccounting\(ctx, runtime, \{ log, always, disposers \}\)/,
    '**apply() 里必须真的调用它** —— 否则 beginTurn/observeShortTokens 依旧是"库代码先写、接线没做"',
  )
})

test('★★ 守卫：`turn/start` ⇒ `beginTurn()`；`turn/end` ⇒ `observeShortTokens()`', () => {
  const body = bodyOf(read('../src/index.ts'), 'export function registerTurnAccounting(', 'export function apply(')
  const turnStartAt = body.indexOf("type === 'turn/start'")
  const beginAt = body.indexOf('runtime.beginTurn()')
  assert.ok(turnStartAt > 0, '必须认宿主 `agent-loop` 的 `turn/start` 事件')
  assert.ok(beginAt > turnStartAt, '`turn/start` 分支里必须真的调 `runtime.beginTurn()`')

  const turnEndAt = body.indexOf("type === 'turn/end'")
  const observeAt = body.indexOf('runtime.observeShortTokens(')
  assert.ok(turnEndAt > 0, '必须认 `turn/end` 事件')
  assert.ok(observeAt > turnEndAt, '`turn/end` 分支里必须真的调 `runtime.observeShortTokens()`')
})

test('★★ 守卫：短期读数是**真实读数**（tokenMeter 优先、usage 退化），拿不到时**不写 0**', () => {
  const body = bodyOf(read('../src/index.ts'), 'export function registerTurnAccounting(', 'export function apply(')
  assert.match(body, /meter\.measure\(session\)/, '优先用宿主 tokenMeter 的权威计量')
  assert.match(body, /shortTokensFromUsage\(data\['usage'\]\)/, '退化路径必须读 `data.usage`（宿主事件载荷在 data 里）')
  assert.match(body, /保留上次读数/, '拿不到真实读数时**宁可不写** —— 写 0 会让裁决判 too_thin')
})

test('★★ 守卫：`resetCycle()` 由压缩提交触发（`resetCompactionAccounting` → `resetCycle`）', () => {
  const src = read('../src/runtime.ts')
  const body = bodyOf(src, 'resetCompactionAccounting(): void {', '  settle(')
  assert.match(body, /this\.resetCycle\(\)/, '**压缩提交后必须重置召回周期额度**（否则额度只增不减）')
})

test('★★ 守卫：`resetCycle` 读的是契约里的 `recall.resetPolicy`（不是写死的）', () => {
  const src = read('../src/runtime.ts')
  assert.match(src, /defaultFor<unknown>\('recall\.resetPolicy'\)/, 'PLAN §7.6 的 reset_policy 必须有代码引用')
  const body = bodyOf(src, 'resetCycle(): void {', '  /** 关闭（checkpoint')
  assert.match(body, /isKnownResetPolicy\(/, '认不出的策略值要喊一声（不能静默当成没配）')
  assert.match(body, /this\.recallThisCycle = 0/, '压缩后周期额度必须归零')
  const beginBody = bodyOf(src, 'beginTurn(): void {', '  /** 记一次工具调用')
  assert.match(beginBody, /isPerTurnResetPolicy\(/, '按轮重置的策略要真的按轮重置（不然改了个寂寞）')
})

test('★★ 守卫：启动回滚在 `apply()` 里，且**在注册工具之前**', () => {
  const src = read('../src/index.ts')
  const recoverAt = src.indexOf('recoverPendingCompactions(runtime.db)')
  const toolsAt = src.indexOf('buildMemoryTools(')
  assert.ok(recoverAt > 0, '**apply() 必须真的调 recoverPendingCompactions** —— 否则半写的压缩事务永不回滚')
  assert.ok(toolsAt > recoverAt, '必须在**注册工具之前**回滚（模型不能在一个半写的库上做决策）')
})

test('★★ 守卫：沉降循环真的启动了（`startSettleTimer` → `target.settle()`），且能停', () => {
  const src = read('../src/index.ts')
  assert.match(src, /startSettleTimer\(runtime, /, '**apply() 必须真的启动沉降循环**')
  assert.match(src, /disposers\.push\(settleTimer\.stop\)/, '反注册器要进 disposers（否则热重载会重复挂）')
  assert.match(read('../src/runtime.ts'), /target\.settle\(/, '**定时器里必须真的调 settle()**')
})

// ════════════════════════════════════════════════════════════════════════════
// ② 行为：假 ctx 驱动真函数
// ════════════════════════════════════════════════════════════════════════════

test('★ `shortTokensFromUsage`：整通口径（totalTokens 优先，四类互不重叠相加）', () => {
  assert.equal(shortTokensFromUsage({ totalTokens: 5000, inputTokens: 1 }), 5000, 'provider 的整通总量优先')
  assert.equal(
    shortTokensFromUsage({ inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 300, outputTokens: 50 }),
    1550,
    '没有 totalTokens 时按 未命中输入 + 缓存读 + 缓存写 + 输出 相加',
  )
  assert.equal(shortTokensFromUsage({ inputTokens: 0, outputTokens: 0 }), undefined, '全 0 不算读数')
  assert.equal(shortTokensFromUsage({}), undefined, '没有数字就不编一个出来')
  assert.equal(shortTokensFromUsage(undefined), undefined)
  assert.equal(shortTokensFromUsage('nonsense'), undefined)
})

test('★★ 行为：`turn/start` 真的推进"自上次压缩以来的轮次"', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const fake = fakeCtx()
  const options = acctOptions()
  try {
    assert.equal(registerTurnAccounting(fake.ctx, runtime, options), true)
    assert.deepEqual(fake.events, ['session/event'])
    assert.equal(runtime.compactionStats().turnsSinceLast, 0, '起点是 0')

    fake.fire(fakeSession, sessionEvent('turn/start', { turn: 1 }))
    fake.fire(fakeSession, sessionEvent('turn/start', { turn: 2 }))
    assert.equal(runtime.compactionStats().turnsSinceLast, 2, '**真实轮次必须进库**（否则裁决永远 too_thin）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★★ 行为：recall 每轮额度真的重置（修 B —— 不重置的话第 3 次就永久失效）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const fake = fakeCtx()
  const options = acctOptions()
  try {
    registerTurnAccounting(fake.ctx, runtime, options)
    // 同一轮里用满每轮额度（配置默认 recallMaxPerTurn=2）
    runtime.recallLongterm('第一条')
    runtime.recallLongterm('第二条')
    const blocked = runtime.recallLongterm('第三条')
    assert.match(blocked.note ?? '', /本轮 recall 次数已达上限/, '同一轮里第 3 次必须被拦（这是道硬约束）')

    // ★ 关键：**新一轮开始**必须把额度还回来
    fake.fire(fakeSession, sessionEvent('turn/start', { turn: 2 }))
    const afterNewTurn = runtime.recallLongterm('新的一轮再查')
    assert.ok(
      !(afterNewTurn.note ?? '').includes('已达上限'),
      '**新的一轮必须重新给额度** —— 否则跑一会儿之后模型再也想不起长期记忆（本仓最致命的一条）',
    )
    assert.equal(afterNewTurn.budget.usedThisTurn, 1, '新轮从 1 起算')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 行为：`turn/end` 用 provider 的 usage 写真短期读数', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const fake = fakeCtx()
  const options = acctOptions()
  try {
    registerTurnAccounting(fake.ctx, runtime, options)
    fake.fire(fakeSession, sessionEvent('turn/start', { turn: 1 }))
    fake.fire(
      fakeSession,
      sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 300, outputTokens: 50 },
      }),
    )
    assert.equal(runtime.compactionStats().shortTokens, 0, '轮次没结束前不写（读数属于"轮末"）')
    fake.fire(fakeSession, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    assert.equal(runtime.compactionStats().shortTokens, 1550, '**轮末必须写真实读数**（不是 0）')
    assert.ok(
      options.alerts.some((m) => m.includes('轮次记账已生效')),
      '第一轮读数要留一行**不进 verbose 也能看见**的日志（"在跑"和"没挂上"必须能分开）',
    )
    assert.ok(options.alerts.some((m) => m.includes('too_thin')), '要说清这行日志为什么重要（它以前是死的）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 行为：有宿主 tokenMeter 时以它为准（usage 只是退化路径）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const meterCalls: unknown[] = []
  const fake = fakeCtx({
    tokenMeter: (session) => {
      meterCalls.push(session)
      return { totalTokens: 9999 }
    },
  })
  const options = acctOptions()
  try {
    registerTurnAccounting(fake.ctx, runtime, options)
    fake.fire(
      fakeSession,
      sessionEvent('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } }),
    )
    fake.fire(fakeSession, sessionEvent('turn/end', { turn: 1 }))
    assert.equal(meterCalls.length, 1, 'tokenMeter 必须被真的调用（并拿到 session）')
    assert.equal(runtime.compactionStats().shortTokens, 9999, '**宿主权威计量优先**')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 行为：拿不到真实读数时**保留上次读数**，绝不写 0', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const fake = fakeCtx()
  const options = acctOptions()
  try {
    registerTurnAccounting(fake.ctx, runtime, options)
    runtime.observeShortTokens(777)
    // 既没有 tokenMeter，也没有 usage ⇒ 不能把 777 覆盖成 0
    fake.fire(fakeSession, sessionEvent('turn/end', { turn: 1 }))
    fake.fire(fakeSession, sessionEvent('assistant/message', { usage: { inputTokens: 0, outputTokens: 0 } }))
    fake.fire(fakeSession, sessionEvent('turn/end', { turn: 2 }))
    assert.equal(runtime.compactionStats().shortTokens, 777, '**"没有数据"和"上下文是空的"是两回事**')
    assert.ok(options.logs.some((m) => m.includes('保留上次读数')), '这件事要留下痕迹')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 行为：拿不到 `ctx.on` 时**明说**（静默的话"在跑"和"没挂上"看不出来）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const options = acctOptions()
  try {
    const fake = fakeCtx({ withOn: false })
    assert.equal(registerTurnAccounting(fake.ctx, runtime, options), false)
    assert.ok(options.alerts.some((m) => m.includes('轮次记账未挂载')), '必须报警')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ 行为：反注册器进了 disposers，且能真的反注册', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const options = acctOptions()
  try {
    const fake = fakeCtx()
    registerTurnAccounting(fake.ctx, runtime, options)
    assert.equal(options.disposers.length, 1, '**必须收进 disposers**（否则热重载会重复记账）')
    options.disposers[0]?.()
    assert.equal(fake.disposeCount(), 1, '反注册器要真的能反注册')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★ 行为：handler 遇到垃圾形状**绝不抛异常**（它跑在每一次会话事件上）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  const fake = fakeCtx()
  const options = acctOptions()
  try {
    registerTurnAccounting(fake.ctx, runtime, options)
    assert.doesNotThrow(() => {
      fake.fire(undefined, undefined)
      fake.fire({}, 'not-an-event')
      fake.fire(fakeSession, { type: 'turn/end' }) // 没有 data
      fake.fire(fakeSession, { type: 'turn/end', data: { usage: 'garbage' } })
      fake.fire(fakeSession, sessionEvent('assistant/message', { usage: { inputTokens: 'NaN' } }))
      // tokenMeter 直接抛错
      const throwing = fakeCtx({
        tokenMeter: () => {
          throw new Error('计量炸了')
        },
      })
      registerTurnAccounting(throwing.ctx, runtime, options)
      throwing.fire(fakeSession, sessionEvent('turn/end', { turn: 9 }))
    }, '**绝不能让记账毁掉整轮**')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

test('★★ 行为：压缩提交后周期额度真的归零（B 的另一半：on_compaction 语义）', async () => {
  const dir = tempDir()
  const runtime = makeRuntime(dir)
  try {
    // 用满周期额度（maxPerCycle=5；每轮额度 2 ⇒ 分 3 轮用掉）
    runtime.beginTurn()
    runtime.recallLongterm('查询 1')
    runtime.recallLongterm('查询 2')
    runtime.beginTurn()
    runtime.recallLongterm('查询 3')
    runtime.recallLongterm('查询 4')
    runtime.beginTurn()
    const exhausted = runtime.recallLongterm('查询 5')
    assert.equal(exhausted.budget.usedThisCycle, 5, '周期额度应当已经用满')
    assert.equal(exhausted.budget.remainingThisCycle, 0)

    // 走真实的压缩提交路径（`compaction-engine.ts` 在事务 commit 后调 resetCompactionAccounting）
    applyCompactionDecision(
      { runtime, reason: '接线测试' },
      { push_to_mid: [], keep_in_short: [], fragment_mid: [], reasoning: '测试' },
      'sess_wiring',
    )

    const afterCompaction = runtime.recallLongterm('压缩之后应当重新有额度')
    assert.equal(afterCompaction.budget.usedThisCycle, 1, '**压缩完成 ⇒ 周期额度重置**（PLAN §7.6 reset_policy=on_compaction）')
  } finally {
    runtime.close()
    await cleanup(dir)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 沉降定时循环
// ════════════════════════════════════════════════════════════════════════════

test('★ 沉降循环配置：默认 30 分钟、太小的值视为没配、可显式关闭', () => {
  const defaults = settleTimerConfigFromEnv({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.intervalMs, 30 * 60_000)
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: '1000' }).intervalMs, 30 * 60_000, '太小 ⇒ 用默认')
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_INTERVAL_MS: '60000' }).intervalMs, 60_000)
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_DISABLED: '1' }).enabled, false)
  assert.equal(settleTimerConfigFromEnv({ FORLIFE_SETTLE_LIMIT: '7' }).limit, 7)
})

test('★★ 沉降循环：到点**真的调 `settle()`**，且一轮跑完再排下一轮（不堆轮次）', () => {
  const calls: (number | undefined)[] = []
  const target: SettleTimerTarget = {
    settle: (options) => {
      calls.push(options?.limit)
      return { fragmented: 1, archived: 0, notes: ['搬了一条'] }
    },
  }
  const timers: (() => void)[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const timer = startSettleTimer(target, {
    log: (m) => logs.push(m),
    always: (m) => alerts.push(m),
    env: {},
    intervalMs: 1000,
    limit: 3,
    setTimeoutImpl: (fn) => {
      timers.push(fn)
      return { unref: () => {} }
    },
    clearTimeoutImpl: () => {},
  })

  assert.equal(timers.length, 1, '启动时排一轮（不立刻跑 —— 沉降是低频动作）')
  assert.equal(calls.length, 0)
  timers[0]?.()
  assert.deepEqual(calls, [3], '**到点必须真的调 settle()**，且带上批量上限')
  assert.equal(timers.length, 2, '一轮跑完再排下一轮')
  assert.ok(logs.some((m) => m.includes('沉降循环已启动')), '要留一行"它真的启动了"')
  assert.equal(alerts.length, 0, '一切正常时不该报警')

  timer.stop()
  const scheduled = timers.length
  timers[scheduled - 1]?.()
  assert.equal(timers.length, scheduled, '停表之后不再排下一轮')
})

test('★★ 沉降循环：一轮抛异常**不能杀死循环**（下一轮照排），但必须让人看见', () => {
  let attempts = 0
  const target: SettleTimerTarget = {
    settle: () => {
      attempts += 1
      throw new Error('库被锁住了')
    },
  }
  const timers: (() => void)[] = []
  const alerts: string[] = []
  const timer = startSettleTimer(target, {
    log: () => {},
    always: (m) => alerts.push(m),
    env: {},
    intervalMs: 1000,
    setTimeoutImpl: (fn) => {
      timers.push(fn)
      return { unref: () => {} }
    },
    clearTimeoutImpl: () => {},
  })
  assert.doesNotThrow(() => timers[0]?.(), '定时器里抛异常会静默杀死整个循环')
  assert.equal(attempts, 1)
  assert.equal(timers.length, 2, '**失败也要继续排下一轮**')
  assert.ok(alerts.some((m) => m.includes('沉降一轮失败')), '静默的沉降失效与"没有东西可沉"从日志上看一模一样')
  timer.stop()
})

test('★ 沉降循环：显式关闭时不启动（但不静默）', () => {
  let called = 0
  const target: SettleTimerTarget = {
    settle: () => {
      called += 1
      return { fragmented: 0, archived: 0, notes: [] }
    },
  }
  const logs: string[] = []
  const timer = startSettleTimer(target, {
    log: (m) => logs.push(m),
    env: { FORLIFE_SETTLE_DISABLED: '1' },
    setTimeoutImpl: () => {
      assert.fail('关闭时不该排定时器')
    },
  })
  timer.tick()
  assert.equal(called, 1, 'tick() 是可以手动调的（测试/排障用）')
  assert.equal(timer.config.enabled, false)
  assert.ok(logs.some((m) => m.includes('沉降循环未启动')), '要说清为什么没跑')
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 端到端：跑真的 `apply()`
// ════════════════════════════════════════════════════════════════════════════

test('★★★ 端到端：`apply()` ⇒ 轮次记账挂上了，库里状态真的变', async () => {
  const dir = tempDir()
  const messages: string[] = []
  const original = console.log
  const effects: (() => void)[] = []
  try {
    const fake = fakeCtx()
    const ctx = {
      ...(fake.ctx as unknown as Record<string, unknown>),
      effect(callback: () => void | (() => void)): void {
        const disposer = callback()
        if (typeof disposer === 'function') effects.push(disposer as () => void)
      },
    }
    console.log = (...args: unknown[]): void => {
      messages.push(args.join(' '))
    }
    apply(ctx as never, resolveConfig({ storageRoot: dir, verbose: true }))
    await delay(30)
    console.log = original

    assert.ok(
      fake.events.includes('session/event'),
      `apply() 没有订阅 session/event —— 事件只有：${fake.events.join(', ')}`,
    )

    const runtime = activeRuntimes().at(-1)
    assert.ok(runtime !== undefined, '运行时必须登记（面板/诊断靠它取）')

    // ① 轮次开始 ⇒ 记账推进（真链路）
    fake.fire(fakeSession, sessionEvent('turn/start', { turn: 1 }))
    assert.equal(runtime.compactionStats().turnsSinceLast, 1, '**apply() 之后轮次记账必须真的在跑**')

    // ② 轮次结束 ⇒ 真实短期读数进库
    fake.fire(fakeSession, sessionEvent('assistant/message', { usage: { inputTokens: 2048, outputTokens: 64 } }))
    fake.fire(fakeSession, sessionEvent('turn/end', { turn: 1 }))
    assert.equal(runtime.compactionStats().shortTokens, 2112, '**轮末必须写真实读数**')

    // ③ 沉降循环真的启动了（日志是唯一能看见它的地方）
    assert.ok(
      messages.some((m) => m.includes('沉降循环已启动')),
      `沉降循环没有启动 —— apply() 的日志：${messages.join(' | ')}`,
    )
    // ④ 启动回滚跑过了（没有残留时说"库是完整的"）
    assert.ok(
      messages.some((m) => m.includes('启动回滚')),
      `启动回滚没有跑 —— apply() 的日志：${messages.join(' | ')}`,
    )
  } finally {
    console.log = original
    for (const disposer of effects) disposer()
    await cleanup(dir)
  }
})

test('★★★ 端到端：崩溃遗留的压缩事务在 `apply()` 时被回滚（PLAN §15）', async () => {
  const dir = tempDir()
  const dbFile = join(dir, 'db', 'forlife.sqlite')
  const messages: string[] = []
  const original = console.log
  const effects: (() => void)[] = []
  try {
    // ── 造一个"上次进程在压缩中途被杀"的现场（phase='started' 残留）
    const crashed = openDatabase({ file: dbFile, log: () => {} })
    beginCompactionRun(crashed.db, {
      id: 'run_crash_wiring',
      sessionId: 'sess_crash',
      epochFrom: 0,
      plan: { pushedIds: ['mid_never_written'], fragmentedIds: [], longIds: [] },
    })
    crashed.close()

    const fake = fakeCtx()
    const ctx = {
      ...(fake.ctx as unknown as Record<string, unknown>),
      effect(callback: () => void | (() => void)): void {
        const disposer = callback()
        if (typeof disposer === 'function') effects.push(disposer as () => void)
      },
    }
    console.log = (...args: unknown[]): void => {
      messages.push(args.join(' '))
    }
    apply(ctx as never, resolveConfig({ storageRoot: dir, verbose: true }))
    await delay(30)
    console.log = original

    const runtime = activeRuntimes().at(-1)
    assert.ok(runtime !== undefined)
    const run = getCompactionRun(runtime.db, 'run_crash_wiring')
    assert.equal(
      run?.phase,
      'aborted',
      '**apply() 必须把残留的 started 事务回滚掉** —— 否则模型会在一个半写的库上做决策',
    )
    assert.ok(
      messages.some((m) => m.includes('启动回滚')),
      `回滚必须留下痕迹 —— 日志：${messages.join(' | ')}`,
    )
  } finally {
    console.log = original
    for (const disposer of effects) disposer()
    await cleanup(dir)
  }
})
