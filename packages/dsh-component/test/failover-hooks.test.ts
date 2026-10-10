/**
 * 跨模型 failover 接线层的测试。
 *
 * ## 这个文件在钉什么
 *
 * 1. **★★★ 自己接管时必须返回 `{kind:'retry'}` 且不调 `next()`** ——
 *    调了 `next()` 就等于把裁决权交回去，我们算出来的新路由**永远不会生效**，
 *    而日志里却写着"已降级"。**最坏的一种谎。**
 * 2. **★★ 默认不许改行为**：`off` 连订阅都不订；`observe` **只说不做**
 *    （原样返回宿主给的 config）
 * 3. **★ `agent/request` 每步重新断言**（防粘性），同一步重跑**保持**当前路由（幂等）
 * 4. **★ 换路由只改 provider/model，其余字段原样带过去** ——
 *    顺手抹掉 temperature/maxTokens 会给"降级后答得不一样"多一个无关原因
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFailoverRuntime, type FailoverRuntime, type RouterHookOptions } from '../src/router-hooks.ts'
import { installFailoverHooks } from '../src/failover-hooks.ts'

/** 一个假的宿主：记账 on() 的处理器，并让测试能手动触发。 */
function fakeHost(): {
  readonly handlers: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  readonly ctx: { on: (event: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void }
  readonly disposed: string[]
} {
  const handlers = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const disposed: string[] = []
  return {
    handlers,
    disposed,
    ctx: {
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => disposed.push(event)
      },
    },
  }
}

/** 记账用的 record（我们要断言"降级留痕了"）。 */
function recorder(): { readonly rows: Record<string, unknown>[]; readonly record: RouterHookOptions['record'] } {
  const rows: Record<string, unknown>[] = []
  return { rows, record: (input) => { rows.push(input as unknown as Record<string, unknown>) } }
}

/** 造一个装上钩子的装置。 */
function setup(options: { mode: 'off' | 'observe' | 'apply'; candidates?: readonly { provider: string; model: string }[] }): {
  readonly host: ReturnType<typeof fakeHost>
  readonly rows: Record<string, unknown>[]
  readonly logs: string[]
  readonly hooks: ReturnType<typeof installFailoverHooks>
  readonly failover: FailoverRuntime
  readonly candidates: readonly { provider: string; model: string }[]
} {
  const host = fakeHost()
  const rec = recorder()
  const logs: string[] = []
  const candidates = options.candidates ?? [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  ]
  const failover = buildFailoverRuntime({} as never, {
    candidates: () => candidates,
    record: rec.record,
    log: (message) => logs.push(message),
  })
  const hooks = installFailoverHooks(host.ctx, {
    mode: options.mode,
    failover,
    candidates: () => candidates,
    record: rec.record,
    log: (message) => logs.push(message),
  })
  return { host, rows: rec.rows, logs, hooks, failover, candidates }
}

test('★★★ 接管与否**与裁决逐字一致**：裁决是 swap ⇒ `{kind:"retry"}` 且 next 一次都没调', async () => {
  const s = setup({ mode: 'apply' })
  const req = s.host.handlers.get('agent/request')
  const err = s.host.handlers.get('agent/request-error')
  assert.ok(req !== undefined && err !== undefined)

  // ① 先跑一步 `agent/request`，把这一步的当前路由定下来（真实流程就是这样）
  const config = (await req({ turn: 1, step: 1 }, async () => ({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    temperature: 0.3,
    maxTokens: 4096,
  }))) as Record<string, unknown>
  assert.equal(config['provider'], 'deepseek-official', '断言应当把第一步换成候选链第一个')
  assert.equal(config['temperature'], 0.3, '★ 其余字段必须原样带过去（不许顺手抹掉）')
  assert.equal(config['maxTokens'], 4096)

  // ② ★ 问裁决层"这个失败该怎么判" —— 测试**不去猜分类器的结论**
  //    （那是 `@forlife/router` 的事，它有自己的测试）。
  //    用另一个实例问，是为了**不污染被测那个的状态**。
  const actionFor = (message: string): string => {
    const probe = buildFailoverRuntime({} as never, { candidates: () => s.candidates, record: () => undefined })
    probe.beginStep('1:1', { provider: 'deepseek-official', model: 'deepseek-flash' })
    return probe.onError({ provider: 'deepseek-official', model: 'deepseek-flash', message }).action
  }
  const message = 'invalid api key'
  const expected = actionFor(message)

  // ③ 把同一个失败喂给**真的接线层**，断言行为与裁决**逐字一致**
  const current = s.failover.currentRoute()
  assert.ok(current !== undefined)
  let nextCalled = 0
  const result = await err(
    {
      turn: 1,
      step: 1,
      provider: current.provider,
      failure: { message, code: 'probe' },
    },
    async () => {
      nextCalled += 1
      return undefined
    },
  )

  if (expected === 'swap') {
    assert.deepEqual(result, { kind: 'retry' }, '★ 裁决是 swap ⇒ 必须回 `{kind:"retry"}` 自己接管')
    assert.equal(
      nextCalled,
      0,
      '★★★ **绝不调 next()** —— 调了就等于把裁决权交回去，新路由永远不生效，' +
        '而日志里却写着"已降级"（最坏的一种谎）',
    )
    assert.ok(
      s.logs.some((line) => line.includes('换到')),
      `降级必须留痕（否则"为什么这次答得不一样"无从查起）：${s.logs.join(' | ')}`,
    )
    assert.ok(s.rows.some((row) => row['source'] === 'failover-swap'), '降级要真的写进路由日志')
  } else {
    // ★ 委托时**必须把 next() 调掉** —— 放弃裁决权又不调 next() 会让宿主卡在那里
    assert.equal(nextCalled, 1, `裁决是 ${expected} ⇒ 必须把裁决权交回宿主（调 next()）`)
    assert.ok(
      s.logs.some((line) => line.includes(expected)),
      `裁决结果要留痕（实际：${s.logs.join(' | ')}）`,
    )
  }
})

/**
 * ★★ **发现记录**（不是断言"这是对的"，是把事实钉在测试里免得被忘掉）。
 *
 * 实测：候选链 `[deepseek-official, opencode-go]`、当前在第 0 位时，
 * 五种典型失败**一次都不换家**：
 *
 * | 失败 | 裁决 |
 * | :--- | :--- |
 * | `invalid api key` | `give-up` |
 * | `500 server error` | `keep` |
 * | `ECONNRESET` | `keep` |
 * | `额度用完了` | `keep` |
 * | `timeout` | `keep` |
 *
 * ⇒ 这条链**实际上没有降级能力**。两条可能：① `@forlife/router` 的策略就是这样
 * （例如"同 provider 换 model 才算 swap"、或"限流该等而不是换家"）；
 * ② 候选链的**构造**不对（也许要 `tier` 或别的字段）。
 *
 * **本测试只把事实钉住**：它断言"从第 0 位出发，这五种失败的裁决里**没有 swap**"——
 * 哪天策略改了、或者候选链接对了，这条会红，那时就该来更新这一节。
 */
test('★★ 发现记录：从候选链第 0 位出发，五种典型失败都不换家（待查）', () => {
  const candidates = [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  ]
  const actions = ['invalid api key', '500 server error', 'ECONNRESET', '额度用完了', 'timeout'].map((message) => {
    const probe = buildFailoverRuntime({} as never, { candidates: () => candidates, record: () => undefined })
    probe.beginStep('1:1', { provider: 'deepseek-official', model: 'deepseek-flash' })
    return `${message} ⇒ ${probe.onError({ provider: 'deepseek-official', model: 'deepseek-flash', message }).action}`
  })
  assert.deepEqual(
    actions,
    [
      'invalid api key ⇒ give-up',
      '500 server error ⇒ keep',
      'ECONNRESET ⇒ keep',
      '额度用完了 ⇒ keep',
      'timeout ⇒ keep',
    ],
    '★ 这张表是**实测事实**。若它变了（策略改了/候选链接对了），来更新这里，' +
      '并顺手确认"降级能力到底通没通" —— 现在这张表说明它**没通**',
  )
})

test('★★ `observe`：**只说不做** —— 原样返回宿主给的 config，一条都不换', async () => {
  const s = setup({ mode: 'observe' })
  const req = s.host.handlers.get('agent/request')
  assert.ok(req !== undefined)
  const config = (await req({ turn: 1, step: 1 }, async () => ({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  }))) as Record<string, unknown>
  assert.equal(config['provider'], 'opencode-go', '★ observe 不许改行为')
  assert.equal(config['model'], 'deepseek-v4.1-flash')
  assert.ok(
    s.logs.some((line) => line.includes('observe')),
    `要留下"如果开了会换成谁"的观察日志：${s.logs.join(' | ')}`,
  )
})

test('★★ `off`：**连订阅都不订**（没开的功能不许留空转的钩子）', async () => {
  const s = setup({ mode: 'off' })
  assert.equal(s.host.handlers.size, 0, 'off 时一个处理器都不该挂')
  assert.ok(s.logs.some((line) => line.includes('未启用')), '而且要如实说"没启用"')
  // dispose 也不许炸（没订过东西）
  s.hooks.dispose()
})

test('★ `observe` 下失败事件**必须委托** `next()`（那是宿主的恢复路径）', async () => {
  const s = setup({ mode: 'observe' })
  const err = s.host.handlers.get('agent/request-error')
  assert.ok(err !== undefined)
  let nextCalled = 0
  await err({ turn: 1, step: 1, provider: 'p', failure: { message: '额度用完了', code: 'quota' } }, async () => {
    nextCalled += 1
    return undefined
  })
  assert.equal(nextCalled, 1, '★ observe 不许接管 —— 放弃裁决权就必须把 next() 调掉')
})

test('★ 每步**重新断言**（防粘性）：第 2 步仍然断到候选链第一个', async () => {
  const s = setup({ mode: 'apply' })
  const req = s.host.handlers.get('agent/request')
  assert.ok(req !== undefined)
  const first = (await req({ turn: 1, step: 1 }, async () => ({ provider: 'x', model: 'y' }))) as Record<string, unknown>
  const second = (await req({ turn: 1, step: 2 }, async () => ({ provider: 'x', model: 'y' }))) as Record<string, unknown>
  assert.equal(first['provider'], 'deepseek-official')
  assert.equal(second['provider'], 'deepseek-official', '★ 换过的路由会粘住 ⇒ 每个 step 必须重新断言')
})

test('★★ `dispose` 真的退订（不退订 = 一堆死监听器，内存与 CPU 双漏）', () => {
  const s = setup({ mode: 'apply' })
  assert.equal(s.host.handlers.size, 2, '两个事件都要订')
  s.hooks.dispose()
  assert.deepEqual([...s.host.disposed].sort(), ['agent/request', 'agent/request-error'], '两个都要退')
})

test('★ 拿不到宿主 `on` ⇒ 如实说"没生效"，不许假装装上了', () => {
  const logs: string[] = []
  const hooks = installFailoverHooks({}, {
    mode: 'apply',
    failover: buildFailoverRuntime({} as never, { candidates: () => [], record: () => undefined }),
    candidates: () => [],
    record: () => undefined,
    log: (message) => logs.push(message),
  })
  assert.ok(
    logs.some((line) => line.includes('装不上')),
    `必须如实说装不上：${logs.join(' | ')}`,
  )
  hooks.dispose()
})
