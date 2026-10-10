/**
 * 初始路由的测试。
 *
 * ## 重点
 *
 * ① **定档顺序**：守卫 → 预评分 → 启发式（**必须一定给得出答案**）
 * ② **可达性是真门槛**：不可达的模型**永远不会被选**（用户明确要求"可达性"是输入之一）
 * ③ **选模型与定档分离**：某个接入点挂了 ⇒ 换模型，**但档位判断不变**
 * ④ **结果稳定**：同分时按坐标排序（否则测试会飘）
 * ⑤ 预评分**置信度不足时不许采信**（宁可退回启发式）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCatalog } from '../src/catalog.ts'
import { decideTier, initialRoute, pickModel, scoreCandidate } from '../src/initial.ts'

/** 造一个目录（省得每个用例都写一遍）。 */
function catalogOf(input: {
  readonly providers?: readonly string[]
  readonly models: readonly { provider: string; id: string; modalities?: readonly string[] }[]
  readonly unreachable?: readonly string[]
}) {
  return buildCatalog({
    providers: (input.providers ?? ['opencode-go', 'deepseek-official']).map((id) => ({ id })),
    models: input.models.map((m) => ({
      provider: m.provider,
      id: m.id,
      ...(m.modalities === undefined ? {} : { inputModalities: m.modalities }),
    })),
    unreachable: new Set(input.unreachable ?? []),
    now: new Date('2026-10-08T00:00:00Z'),
  })
}

const BASIC = catalogOf({
  models: [
    { provider: 'opencode-go', id: 'flash' },
    { provider: 'opencode-go', id: 'pro' },
    { provider: 'deepseek-official', id: 'official-flash' },
  ],
})

/**
 * 一个**守卫抓不到**的文本。
 *
 * ⚠️ 为什么不能用「随便说点什么」：实测它会被内置守卫的 `short-plain` 命中（⇒ L1）。
 * 要测“守卫没命中”就得用**长一点、带技术词**的文本。
 */
const NEUTRAL = '帮我看看这段代码为什么报错 const a = 1'

test('定档：守卫命中就用守卫的档', () => {
  // emoji-only 是内置守卫里的一条（→ L1）
  const result = decideTier('😀')
  assert.equal(result.source, 'guard')
  assert.equal(result.tier, 'L1')
  assert.match(result.why, /守卫命中规则/)
})

test('定档：守卫没命中 ⇒ 启发式兜底（一定给得出答案）', () => {
  const result = decideTier(NEUTRAL)
  assert.equal(result.source, 'heuristic')
  assert.ok(['L1', 'L2', 'L3'].includes(result.tier))
  assert.match(result.why, /启发式兜底/)
})

test('★ 定档：预评分置信度足够时采信它', () => {
  const result = decideTier(NEUTRAL, {
    preScore: { tier: 'L3', confidence: 0.9, reason: '提到架构重构' },
  })
  assert.equal(result.source, 'pre-score')
  assert.equal(result.tier, 'L3')
  assert.match(result.why, /minimum 评分/)
  assert.match(result.why, /架构重构/)
})

test('★ 定档：预评分置信度不足 ⇒ 退回启发式（不许硬信）', () => {
  const result = decideTier(NEUTRAL, { preScore: { tier: 'L3', confidence: 0.2 } })
  assert.equal(result.source, 'heuristic')
  assert.match(result.why, /置信度不足/)
})

test('★ 选模型：不可达的永远不会被选', () => {
  const catalog = catalogOf({
    models: [
      { provider: 'opencode-go', id: 'good' },
      { provider: 'opencode-go', id: 'dead' },
    ],
    unreachable: ['opencode-go/dead'],
  })
  const picked = pickModel(catalog, 'L2')
  assert.equal(picked?.entry.model, 'good')
  assert.ok(!picked?.alternatives.some((a) => a.model === 'dead'))
})

test('★★★ 额度路由（P2-b）：**每个档位都优先 `native`（DS 官方），`ours` 退成兜底**', () => {
  // ## 这条测试原来是反过来的
  //
  // 旧断言是「L1 偏 ours」，而 `TIER_PREFERENCE` 里 L2 的理由写着
  // 「自建接入点优先（**额度可控**）」—— 那句话里有个**不成立的等号**：
  //
  //   ours  = "我们自己注册的 provider"（`catalog.ts:128` 的判据）
  //   额度可控 = "自己搭的、烧自己的电"（注释想说的）
  //
  // 而 `oursProviders` 的默认值是 `['opencode-go']`（`catalog.ts:151`）——
  // **第三方 API**，用户原话「**GO 额度实际上只有百分之 9**」。
  //
  // ⇒ 按分数算：L1 = GO 10 / DS 0，L2 = GO 10 / DS 8 ⇒ **L1 与 L2 全走那家只剩 9% 的**。
  //   用户要的是"**额度路由往 `deepseek-official` 倾**"（P2-b）。
  //
  // ⇒ 三个档位现在都该选 DS。**这不是"改测试让它绿"，是旧断言编码了一个错的判断。**
  for (const tier of ['L1', 'L2', 'L3'] as const) {
    assert.equal(
      pickModel(BASIC, tier)?.entry.provider,
      'deepseek-official',
      `${tier} 应该优先 native（额度在主账户那家）—— 见 FIX_PLAN §25 与 P2-b`,
    )
  }
  // ★ 而 `ours` **必须仍然是备选**（DS 挂了还得能用它）—— 不是"排除 GO"，是"排后面"
  const l1 = pickModel(BASIC, 'L1')
  assert.ok(
    l1?.alternatives.some((a) => a.provider === 'opencode-go'),
    '★ GO 要留在备选里：把首选的额度耗光/挂掉时，兜底还得是它（**不是禁用，是降序**）',
  )
})

test('选模型：一个可达的都没有 ⇒ undefined（不硬编一个）', () => {
  const catalog = catalogOf({
    models: [{ provider: 'opencode-go', id: 'only' }],
    unreachable: ['opencode-go/only'],
  })
  assert.equal(pickModel(catalog, 'L1'), undefined)
})

test('★ 选模型：结果稳定（同分按坐标排序，跑两次一样）', () => {
  const a = pickModel(BASIC, 'L2')
  const b = pickModel(BASIC, 'L2')
  assert.deepEqual(
    a?.entry.provider + '/' + a?.entry.model,
    b?.entry.provider + '/' + b?.entry.model,
  )
})

test('选模型：exclude 能排除掉已试过的（降级时用）', () => {
  const first = pickModel(BASIC, 'L1')
  assert.ok(first !== undefined)
  const second = pickModel(BASIC, 'L1', [first.entry.provider + '/' + first.entry.model])
  assert.notEqual(second?.entry.model, first.entry.model, '排除之后应该换一个')
})

test('打分：不可达的分数被压到最低', () => {
  const reachable = { provider: 'p', model: 'm', name: 'm', marks: ['ours'] as const, reachable: true } as const
  const dead = { provider: 'p', model: 'd', name: 'd', marks: ['ours'] as const, reachable: false } as const
  assert.ok(scoreCandidate(dead as never, 'L1') < scoreCandidate(reachable as never, 'L1'))
})

test('★★ 初始路由：端到端 —— 档位 + 模型 + 理由 + 备选', () => {
  const decision = initialRoute({ turnText: '😀', catalog: BASIC })
  assert.ok(decision !== undefined)
  assert.equal(decision.tier, 'L1')
  assert.equal(decision.tierSource, 'guard')
  // ★ P2-b：额度路由往 DS 官方倾（见上面那条"额度路由"测试里的完整理由）
  assert.equal(decision.provider, 'deepseek-official')
  assert.equal(decision.reasoningEffort, 'low')
  assert.ok(decision.alternatives.length >= 1, '应该有备选')
  assert.match(decision.why, /守卫命中/) // 理由里要能看出"为什么"
  assert.match(decision.why, /备选/)
})

test('★★ 初始路由：目录全不可达 ⇒ 返回 undefined（不假装能路由）', () => {
  const dead = catalogOf({
    models: [{ provider: 'opencode-go', id: 'only' }],
    unreachable: ['opencode-go/only'],
  })
  assert.equal(initialRoute({ turnText: '😀', catalog: dead }), undefined)
})

test('★★ 选模型与定档分离：接入点挂了只换模型，档位判断不变', () => {
  const full = catalogOf({
    models: [
      { provider: 'opencode-go', id: 'ok' },
      { provider: 'deepseek-official', id: 'ok2' },
    ],
  })
  const partial = catalogOf({
    models: [
      { provider: 'opencode-go', id: 'ok' },
      { provider: 'deepseek-official', id: 'ok2' },
    ],
    // ★ 挂的是**首选那家**（P2-b 之后首选是 DS）——
    //   这才真的测到"首选挂了能不能兜住"，比原来更严。
    unreachable: ['deepseek-official/ok2'],
  })

  const d1 = initialRoute({ turnText: '😀', catalog: full })
  const d2 = initialRoute({ turnText: '😀', catalog: partial })

  assert.equal(d1?.tier, d2?.tier, '档位不该因为接入点挂了而变')
  assert.equal(d1?.tierSource, d2?.tierSource)
  assert.notEqual(d1?.provider, d2?.provider, '模型应该换成还活着的那个')
})
