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

test('★★★ **没换过路由时，宿主给什么就是什么** —— 这一层不许自己挑模型', async () => {
  // ⚠️ 这条测试替换掉了一条**测错行为**的旧断言（它要求"断到候选链第一个"）。
  //
  //   旧行为是**真 bug**，而且方向与用户的目标相反：
  //   `seedOpenCodeGoRoutes()`（`route-seed.ts:162-165`）把 **L2/L3 的 rank 0 种成
  //   `opencode-go`** —— 正是用户说的「GO 额度实际上只有百分之 9」那家。
  //   于是只要开 `apply`，这一层会把**每一个**请求从（P2-b 刚倾过去的）DS 官方
  //   换到快没额度的 GO 上。
  //
  //   ⇒ 正确语义：**只在宿主那条路失败之后才偏离它**。
  const s = setup({ mode: 'apply' })
  const req = s.host.handlers.get('agent/request')
  assert.ok(req !== undefined)

  // 宿主（= profile 的 `agent-default-model`，P2-b 把它倾到了 DS 官方）
  const host = { provider: 'deepseek-official', model: 'deepseek-flash', temperature: 0.3, maxTokens: 4096 }
  const first = (await req({ turn: 1, step: 1 }, async () => ({ ...host }))) as Record<string, unknown>

  assert.equal(first['provider'], 'deepseek-official', '★ 一个失败都还没发生 —— 不许把它换到候选链第一个（那是 GO）')
  assert.equal(first['model'], 'deepseek-flash')
  assert.equal(first['temperature'], 0.3, '其余字段原样带过去')

  // 新的一步（`1:2`）同样必须是宿主给的那条 —— 每一步都重新断言
  const second = (await req({ turn: 1, step: 2 }, async () => ({ ...host }))) as Record<string, unknown>
  assert.equal(second['provider'], 'deepseek-official', '★ 每一步都重新断言回宿主的选择（防粘性）')
})

test('★★★ 降级之后：**同一步**保留换过的路由，**新的一步**回到宿主的选择', async () => {
  const s = setup({ mode: 'apply' })
  const req = s.host.handlers.get('agent/request')
  const err = s.host.handlers.get('agent/request-error')
  assert.ok(req !== undefined && err !== undefined)

  const host = { provider: 'deepseek-official', model: 'deepseek-flash' }
  await req({ turn: 2, step: 1 }, async () => ({ ...host }))

  // 喂到阈值（3 次）让它真的换家
  for (let i = 0; i < 3; i += 1) {
    await err(
      { turn: 2, step: 1, provider: host.provider, failure: { message: '500 server error', code: 'probe' } },
      async () => undefined,
    )
  }
  const swapped = s.failover.currentRoute()
  assert.ok(swapped !== undefined)
  assert.notEqual(swapped.provider, host.provider, '前置：到阈值之后应当已经换到别家')

  // ① **同一步**再请求 ⇒ 沿用换过的路由（不然重试又回坏掉的那家）
  const sameStep = (await req({ turn: 2, step: 1 }, async () => ({ ...host }))) as Record<string, unknown>
  assert.equal(sameStep['provider'], swapped.provider, '★ 同一步重跑必须**保持**已换的路由（否则重试白重试）')

  // ② **新的一步** ⇒ 回到宿主的选择（防粘性：只锁不重断言 ⇒ 一次降级之后永远粘住）
  const newStep = (await req({ turn: 2, step: 2 }, async () => ({ ...host }))) as Record<string, unknown>
  assert.equal(newStep['provider'], host.provider, '★ 新的一步必须重新断言回宿主的选择（防粘性）')
})

/**
 * ★★★ 失败降级是**按阈值**的 —— 而且我必须记下**我在这里判断错了一次**。
 *
 * ## 我上一轮写进仓库的那条"发现记录"是**错的**，已删除
 *
 * 我当时对每种失败**只喂了一次**，看到全是 `keep`/`give-up`，就下了结论
 * 「**这条链实际上没有降级能力**」，还把它写成一条断言"这五种失败没有 swap"的测试。
 *
 * **它错了。** 真相是 `failover-wiring.test.ts:65` 早就写着的一句注释：
 *
 * > `// 默认阈值来自基线（3）⇒ 前两次 keep，第三次 swap`
 *
 * 实测（连续喂同一个失败，看第几次换家）：
 *
 * | 失败 | 序列 |
 * | :--- | :--- |
 * | `500 server error` | keep → keep → **swap** |
 * | `额度用完了` | keep → keep → **swap** |
 * | `timeout` | keep → keep → **swap** |
 * | `ECONNRESET` | keep → keep → keep → **swap** |
 * | `invalid api key` | **give-up**（换家也救不了坏钥匙 —— 这是策略，不是缺陷） |
 *
 * ⇒ **降级能力是通的**，只是要攒够阈值。
 *
 * ## 这条测试同时是那次的教训
 *
 * 本仓那条纪律（"看到一个**像是**消费点/问题的地方别急着下结论，要把上下游读全"）
 * 我这个会话已经栽了**四次**。这次栽得最贵：**我把错结论写进了仓库**，
 * 而且写成"事实表"的样子 —— 那比没有测试更坏，因为它会让后来的人**相信**它。
 *
 * **正确做法**：看到反常，先问"是不是有阈值/状态/前置条件我没喂够"，
 * 再去**上游**（这里是同一文件里那句注释）找答案。
 */
test('★★★ 降级是**按阈值**的：同一失败连喂，第 3 次（ECONNRESET 第 4 次）才换家', () => {
  const candidates = [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  ]
  /** 连续喂同一个失败，返回每一跳的裁决（换家即停）。 */
  const sequence = (message: string, max = 6): string[] => {
    const probe = buildFailoverRuntime({} as never, { candidates: () => candidates, record: () => undefined })
    probe.beginStep('1:1', { provider: 'deepseek-official', model: 'deepseek-flash' })
    const steps: string[] = []
    for (let i = 0; i < max; i += 1) {
      const decision = probe.onError({ provider: 'deepseek-official', model: 'deepseek-flash', message })
      steps.push(decision.action)
      if (decision.action !== 'keep') break
    }
    return steps
  }

  assert.deepEqual(sequence('500 server error'), ['keep', 'keep', 'swap'], '★ 阈值 3：前两次 keep')
  assert.deepEqual(sequence('额度用完了'), ['keep', 'keep', 'swap'])
  assert.deepEqual(sequence('timeout'), ['keep', 'keep', 'swap'])
  assert.deepEqual(sequence('ECONNRESET'), ['keep', 'keep', 'keep', 'swap'], '网络类要攒到第 4 次')

  // 反面对照：**钥匙坏掉换家也救不了** ⇒ 直接 give-up（这是策略，不是缺陷）
  assert.deepEqual(sequence('invalid api key'), ['give-up'], '坏钥匙不换家 —— 换了也一样是坏的')

  // ★ 而"只喂一次就以为没有降级能力"正是我犯过的错：一次一定还没到阈值
  assert.deepEqual(sequence('500 server error', 1), ['keep'], '喂一次必然是 keep —— 别据此下结论')
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

test('★★★ 反面守卫：**不许**再出现"断言成候选链第一个"（那会把流量拽回 GO）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/failover-hooks.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  // 断言必须是"宿主给的那条路"
  assert.match(
    src,
    /options\.failover\.beginStep\(stepKeyOf\(turn, step\), \{\s*provider: config\.provider,\s*model: config\.model,/,
    '★ `beginStep` 断言的必须是**宿主给的那条路**',
  )
  // ★ 反面：不许拿候选链第一个当断言目标
  assert.ok(
    !/candidates\(\)\[0\][\s\S]{0,80}beginStep/.test(src),
    '★★★ **不许**把 `candidates()[0]` 当断言目标 —— `route-seed.ts:162-165` 把 L2/L3 的 rank 0 ' +
      '种成 `opencode-go`（用户说"额度只有 9%"那家），那样开 apply 会把**每一个**请求从 DS 官方换过去',
  )
  // 断言目标里不许出现 `assertRoute`（那个选项已删）
  assert.ok(!/assertRoute/.test(src), '`assertRoute` 选项应当已经删掉（它默认取候选链第一个，是那条 bug 的来源）')
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
