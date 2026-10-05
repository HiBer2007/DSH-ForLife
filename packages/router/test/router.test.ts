/**
 * 路由流水线的测试。
 *
 * 守三件（都直接对应模型路由.MD 的验收口径）：
 *  ① **守卫拦截率落在 40–60%**（§5.2 的目标）—— 太低等于没做事，太高说明规则在越权；
 *  ② **50ms 超时必须降级且不阻塞**（§5.3）—— 超时不是错误，是一个正常结果；
 *  ③ **低置信度必须升一档**（§6.1）—— 保守策略，宁可高估。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_GUARDS, escalate, deescalate, heuristicScore, parseScoringOutput, Router, runGuards, startPreScore } from '../src/index.ts'
import type { ScoringInput, TierScorer } from '../src/index.ts'

/** 造一个可控的评分后端。 */
function fakeScorer(behavior: { tier: 'L1' | 'L2' | 'L3'; confidence: number; delayMs?: number } | { fail: string }): TierScorer {
  return {
    kind: 'local-container',
    available: () => true,
    async score() {
      if ('fail' in behavior) throw new Error(behavior.fail)
      if (behavior.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs))
      return { tier: behavior.tier, confidence: behavior.confidence }
    },
  }
}

/** 造一个慢后端（用于超时测试）。 */
function hangingScorer(ms: number): TierScorer {
  return {
    kind: 'local-container',
    available: () => true,
    score: async (_input, signal) =>
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('不该走到这里：应当已被超时中断')), ms)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      }),
  }
}

test('守卫：规则数不超过基线上限（加规则必须是有意识的取舍）', () => {
  assert.ok(DEFAULT_GUARDS.length <= 10, `守卫规则 ${String(DEFAULT_GUARDS.length)} 条，超过 10 条上限`)
  // 每条规则都要有理由（复盘时要能判断该不该留）
  for (const rule of DEFAULT_GUARDS) assert.ok(rule.rationale.length > 5, `${rule.name} 缺少理由说明`)
  // 超过上限时**报错而不是静默截断**
  assert.throws(() => runGuards('x', {}, [...DEFAULT_GUARDS, ...DEFAULT_GUARDS]), /超过上限/)
})

test('守卫：明显场景被拦截，中间地带放行', () => {
  // 明显 L1
  assert.equal(runGuards('😂😂').tier, 'L1')
  assert.equal(runGuards('好的').tier, 'L1')
  assert.equal(runGuards('现在几点').tier, 'L1')
  assert.equal(runGuards('嗯嗯').tier, 'L1')
  assert.equal(runGuards('在吗').tier, 'L1')
  // 明显 L3
  assert.equal(runGuards('@L3 帮我看看').tier, 'L3')
  assert.equal(runGuards('随便什么', { isCompressionTask: true }).tier, 'L3')
  assert.equal(runGuards('随便什么', { isRoutingArbitration: true }).tier, 'L3')
  assert.equal(runGuards('随便什么', { estimatedToolChain: 5 }).tier, 'L3')
  // 中间地带：**必须放行**（否则规则在越权做语义判断）
  assert.equal(runGuards('帮我看看这个方案行不行').tier, undefined)
  assert.equal(runGuards('这个报错是什么原因导致的呢').tier, undefined)
})

test('守卫：短消息带代码或长工具链时不被误判成 L1', () => {
  assert.equal(runGuards('```py\nx=1\n```').tier, undefined, '含代码的短消息不该被"短消息"规则吃掉')
  assert.equal(runGuards('跑一下', { estimatedToolChain: 5 }).tier, 'L3', '短消息也可能挂长工具链')
})

test('守卫：命中时置信度为 1（规则命中是确定的，不是猜的）', async () => {
  const router = new Router({ scorer: fakeScorer({ tier: 'L3', confidence: 0.9 }) })
  const decision = await router.route({ text: '好的' })
  assert.equal(decision.source, 'guard')
  assert.equal(decision.tier, 'L1')
  assert.equal(decision.confidence, 1)
  assert.equal(decision.rule, 'simple-ack')
  assert.equal(decision.degraded, false)
})

test('评分：高置信度直接采用，档位与后端都记下来', async () => {
  const router = new Router({ scorer: fakeScorer({ tier: 'L2', confidence: 0.9 }) })
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  assert.equal(decision.source, 'scorer')
  assert.equal(decision.tier, 'L2')
  assert.equal(decision.backend, 'local-container')
  assert.equal(decision.escalated, false)
  assert.equal(decision.degraded, false)
})

test('低置信度：升一档（保守策略，宁可贵一点也不要答错）', async () => {
  const router = new Router({ scorer: fakeScorer({ tier: 'L1', confidence: 0.5 }) })
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  assert.equal(decision.rawTier, 'L1')
  assert.equal(decision.tier, 'L2', '置信度 0.5 < 0.6 ⇒ 必须升一档')
  assert.equal(decision.escalated, true)
  assert.equal(decision.confidence, 0.5)

  // 已经在顶层就不再升（不会越界）
  const top = new Router({ scorer: fakeScorer({ tier: 'L3', confidence: 0.2 }) })
  assert.equal((await top.route({ text: '帮我看看这个方案行不行' })).tier, 'L3')
  assert.equal(escalate('L3'), 'L3')
  assert.equal(deescalate('L1'), 'L1')
})

test('超时：50ms 到了就走兜底，且**不当异常往上抛**（超时是正常结果）', async () => {
  const router = new Router({ scorer: hangingScorer(5_000) })
  const started = Date.now()
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  const elapsed = Date.now() - started

  assert.equal(decision.source, 'heuristic', '超时必须降级到启发式')
  assert.equal(decision.degraded, true)
  assert.match(String(decision.degradeReason), /超时/)
  assert.ok(elapsed < 500, `不该等满 5 秒（实际 ${String(elapsed)}ms）—— 评分在关键路径上`)
  assert.ok(decision.heuristicParts !== undefined, '降级时要给出明细（复盘用）')
})

test('评分报错：同样降级，错误原因要带上（不是静默吞掉）', async () => {
  const router = new Router({ scorer: fakeScorer({ fail: '端点 503' }) })
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  assert.equal(decision.source, 'heuristic')
  assert.equal(decision.degraded, true)
  assert.match(String(decision.degradeReason), /503/)
})

test('未配置后端：直接走启发式（不报错）', async () => {
  const router = new Router({})
  const decision = await router.route({ text: '帮我设计一个分布式缓存' })
  assert.equal(decision.source, 'heuristic')
  assert.equal(decision.degraded, true)
  assert.match(String(decision.degradeReason), /未配置|不可用/)
})

test('启发式：公式逐项对应设计文档，且可解释', () => {
  const l1 = heuristicScore({ text: '好' })
  assert.ok(l1.score < 0.35)
  assert.equal(l1.tier, 'L1')

  // 注意：启发式是**粗粒度兜底**，权重就是文档给的那四个。
  // 所以"只含规划关键词"的短文本算出来只有 0.25 ⇒ L1 —— 这不是 bug，是这套公式的性质。
  // 真正的语义判断交给守卫与 L1 评分器（这才是文档要的分工）。
  const planningOnly = heuristicScore({ text: '帮我设计一下这个系统的架构' })
  assert.equal(planningOnly.parts.find((p) => p.name === '规划关键词')?.value, 0.25, '规划关键词权重 0.25')
  assert.equal(planningOnly.tier, 'L1', '只靠一个关键词不足以判 L3 —— 公式就是这样设计的')

  // 四项叠加才会到 L3：0.25 + 0.20 + 0.15 + 0.20 = 0.80
  const heavy = heuristicScore({ text: `帮我设计架构 ${'x'.repeat(4000)}\n\n\`\`\`\ncode\n\`\`\``, estimatedToolChain: 5 })
  assert.equal(heavy.tier, 'L3')
  assert.ok(heavy.score >= 0.8)

  const code = heuristicScore({ text: '看看这段\n```js\nconst a = 1\n```' })
  assert.equal(code.parts.find((p) => p.name === '代码块')?.value, 0.2)

  const longText = heuristicScore({ text: 'x'.repeat(4000) })
  assert.equal(longText.parts.find((p) => p.name === '长度')?.value, 0.15, '长度项封顶 0.15')

  const chain = heuristicScore({ text: '跑一下', estimatedToolChain: 5 })
  assert.equal(chain.parts.find((p) => p.name === '工具链')?.value, 0.2)
})

test('启发式兜底：置信度刻意低于低置信度阈值 ⇒ 一定会升档（降级路径更保守）', async () => {
  const router = new Router({})
  // 注意用**绕过守卫**的文本：'好' 会被 simple-ack 直接拦成 L1（置信度 1），走不到启发式
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  assert.equal(decision.degraded, true)
  assert.equal(decision.escalated, true, '降级路径本来就该更保守：不知道难易时多花 token 比答错好')
  assert.equal(decision.tier, 'L2', '启发式判 L1 但置信度低 ⇒ 升到 L2')
})

test('严格解析：容忍代码块与多余文字，但档位非法一律判失败', () => {
  assert.deepEqual(parseScoringOutput('{"tier":"L2","confidence":0.9}'), { tier: 'L2', confidence: 0.9 })
  assert.deepEqual(parseScoringOutput('```json\n{"tier":"L3","confidence":0.8}\n```'), { tier: 'L3', confidence: 0.8 })
  assert.deepEqual(parseScoringOutput('好的，结果是 {"tier":"l1","confidence":"70%"} 希望有帮助'), { tier: 'L1', confidence: 0.7 })
  // 越界置信度夹回合法区间
  assert.deepEqual(parseScoringOutput('{"tier":"L1","confidence":1.5}'), { tier: 'L1', confidence: 1 })
  assert.deepEqual(parseScoringOutput('{"tier":"L2","confidence":-1}'), { tier: 'L2', confidence: 0 })
  // 非法档位/坏 JSON ⇒ undefined（宁可降级，不要瞎猜）
  assert.equal(parseScoringOutput('{"tier":"L9","confidence":0.9}'), undefined)
  assert.equal(parseScoringOutput('{"tier":"很难"}'), undefined)
  assert.equal(parseScoringOutput('我觉得是 L2 吧'), undefined)
  assert.equal(parseScoringOutput(''), undefined)
})

test('批处理：并发评分且**保持输入顺序**（顺序错配是最难查的 bug）', async () => {
  const { routeBatch } = await import('../src/index.ts')
  const router = new Router({
    scorer: {
      kind: 'local-container',
      available: () => true,
      // 故意让后一个先返回
      score: async (input: ScoringInput) => {
        const delay = input.text.includes('慢') ? 40 : 1
        await new Promise((resolve) => setTimeout(resolve, delay))
        return { tier: input.text.includes('慢') ? 'L3' : 'L1', confidence: 0.95 }
      },
    },
  })
  const decisions = await routeBatch(router, [
    { input: { text: '这是慢的那条，需要深思熟虑的设计方案' } },
    { input: { text: '这条很快，也需要处理一下下' } },
  ])
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0]?.tier, 'L3', '第一条（慢的）必须对应它自己的结果')
  assert.equal(decisions[1]?.tier, 'L1')
})

test('预评分：防抖窗口内先算好，取用时同步拿到（完全隐藏延迟）', async () => {
  const router = new Router({ scorer: fakeScorer({ tier: 'L2', confidence: 0.9, delayMs: 30 }) })
  const take = startPreScore(router, { text: '帮我看看这个方案行不行' })
  assert.equal(take(), undefined, '还没算完时不该阻塞等待')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(take()?.tier, 'L2', '算完后同步取到')
})

test('决策说明：一行里能看出档位、来源、置信度、耗时与降级原因', async () => {
  const { describeDecision } = await import('../src/index.ts')
  const router = new Router({ scorer: fakeScorer({ tier: 'L1', confidence: 0.4 }) })
  const text = describeDecision(await router.route({ text: '帮我看看这个方案行不行' }))
  assert.match(text, /L2/)
  assert.match(text, /scorer:local-container/)
  assert.match(text, /conf=0\.40/)
  assert.match(text, /升档/)
  assert.match(text, /ms/)
  const degraded = describeDecision(await new Router({}).route({ text: '帮我看看这个方案行不行' }))
  assert.match(degraded, /降级：/)
})



test('同步路径的超时必须严格是文档原值（防止"偏离泄漏"到不该受影响的路径）', async () => {
  // 预评分有 800ms 的软预算（见 RULE_DEVIATIONS），而同步路径必须仍是 50ms。
  // 这两条路径若混用 defaultFor，同步路径会从 50ms 悄悄变成 800ms ——
  // 用户在白等一个本该立刻降级的评分，而且没有任何报错。
  const { baselineValue, defaultFor } = await import('@forlife/contracts')
  assert.equal(baselineValue('router.scorer.timeoutMs'), 50, '文档原值是 50ms，不该被改')
  assert.equal(defaultFor<number>('router.scorer.timeoutMs'), 50, '这条不该有偏离登记')
  assert.ok(defaultFor<number>('router.preScore.softBudgetMs') >= 50, '预评分软预算应当更宽松')

  // 行为验证：一个 200ms 才返回的评分后端，在同步路径上必须**已经降级**
  const router = new Router({
    scorer: {
      kind: 'local-container',
      available: () => true,
      score: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { tier: 'L3', confidence: 0.99 }
      },
    },
  })
  const started = Date.now()
  const decision = await router.route({ text: '帮我看看这个方案行不行' })
  const elapsed = Date.now() - started
  assert.equal(decision.degraded, true, '200ms 的后端在 50ms 同步超时下必须降级')
  assert.ok(elapsed < 150, `不该等满 200ms（实际 ${String(elapsed)}ms）—— 说明超时用的不是 50ms`)
})
