/**
 * 压缩纯逻辑的测试 —— 阈值与字段必须与 PLAN §4.4 逐字段一致。
 *
 * 这里刻意把 PLAN 原文的数值**再写一遍**（而不是从基线读），
 * 这样"代码改了但文档没改"或"文档改了但代码没改"都会红：
 * 测试是第三方见证，不能跟着实现一起漂。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decideCompaction,
  defaultCompactionThresholds,
  extractJsonObject,
  makeFragmentHint,
  parseCompactionDecision,
  planFragmentation,
  renderKeepInShort,
  type CompactionStats,
} from '../src/compaction.ts'

/** 造一份"远超所有阈值"的状态，方便单项调整。 */
function stats(overrides: Partial<CompactionStats> = {}): CompactionStats {
  return {
    shortTokens: 3000,
    turnsSinceLast: 8,
    toolCallsSinceLast: 10,
    tokenDeltaSinceLast: 3000,
    timeSinceLastMs: 120_000,
    shortRatio: 0.3,
    ...overrides,
  }
}

test('阈值：默认值必须等于 PLAN §4.4 原文', () => {
  const t = defaultCompactionThresholds()
  // 最小内容阈值（防太薄）
  assert.equal(t.minTokens, 2000, 'PLAN §4.4：短期 token 数 ≥ 2000')
  assert.equal(t.minTurns, 3, 'PLAN §4.4：自上次压缩轮次数 ≥ 3')
  assert.equal(t.minToolCalls, 5, 'PLAN §4.4：自上次压缩工具调用数 ≥ 5')
  // 豁免
  assert.equal(t.waiveMinTurnsAboveTokens, 6000, 'PLAN §4.4：token ≥ 6000 绕过轮次约束')
  // 冷却期（防太密）
  assert.equal(t.cooldownTurns, 5, 'PLAN §4.4：距上次压缩轮次数 ≥ 5')
  assert.equal(t.cooldownMs, 60_000, 'PLAN §4.4：距上次压缩真实时间 ≥ 60s')
  assert.equal(t.cooldownTokenDelta, 1500, 'PLAN §4.4：距上次压缩 token 增量 ≥ 1500')
  // 豁免
  assert.equal(t.emergencyBypassRatio, 0.75, 'PLAN §4.4：短期占比 ≥ 75% 绕过冷却期')
})

test('裁决：全部达标时通过', () => {
  const verdict = decideCompaction(stats())
  assert.equal(verdict.approved, true)
  assert.equal(verdict.reason, undefined)
})

test('裁决：太薄被拒，反馈字段与 §4.4 示例逐字段一致', () => {
  // 用 PLAN 示例里的数值：current = {1200, 2, 3}，required = {2000, 3, 5}
  const verdict = decideCompaction(
    stats({ shortTokens: 1200, turnsSinceLast: 2, toolCallsSinceLast: 3, tokenDeltaSinceLast: 1200, timeSinceLastMs: 120_000 }),
  )
  assert.equal(verdict.approved, false)
  assert.equal(verdict.reason, 'too_thin')
  assert.deepEqual(verdict.current, { tokens: 1200, turns: 2, tool_calls: 3 })
  assert.deepEqual(verdict.required, { tokens: 2000, turns: 3, tool_calls: 5 })
  assert.equal(verdict.hint, '再完成至少 1 轮对话或累积 800 token 后可再次请求', 'hint 必须按差额算出来')
})

test('裁决：豁免 —— token ≥ 6000 时绕过"最小轮次"约束', () => {
  // 这个豁免只在"从未压缩过"时可观测：一旦压缩过，冷却期的轮次要求（5）比最小轮次（3）更严，
  // 绕过后者并不会让请求通过（见下一条测试）。第一次压缩正是最需要它的场景。
  const verdict = decideCompaction(
    stats({ shortTokens: 6500, turnsSinceLast: 1, toolCallsSinceLast: 10, hasPreviousCompaction: false }),
  )
  assert.equal(verdict.approved, true)
  assert.equal(verdict.waiver, 'token_threshold')

  // 反证：同样 1 轮，但 token 不到 6000 ⇒ 判"太薄"
  const thin = decideCompaction(
    stats({ shortTokens: 3000, turnsSinceLast: 1, toolCallsSinceLast: 10, hasPreviousCompaction: false }),
  )
  assert.equal(thin.approved, false)
  assert.equal(thin.reason, 'too_thin')
})

test('裁决：从未压缩过时冷却期不适用（否则第一次压缩永远被卡住）', () => {
  // 数值刻意卡在"最小阈值都满足、但冷却期三项全不满足"的位置：
  // 轮次 3（≥ minTurns 3，< cooldownTurns 5）、时间 0、增量 0。
  const base = { shortTokens: 3000, turnsSinceLast: 3, toolCallsSinceLast: 10, tokenDeltaSinceLast: 0, timeSinceLastMs: 0 }
  const first = decideCompaction(stats({ ...base, hasPreviousCompaction: false }))
  assert.equal(first.approved, true, '"距上次压缩"在从未压缩过时无意义，不该拦')

  // 反证：有压缩史时同样数值必须被冷却期拦下
  const later = decideCompaction(stats({ ...base, hasPreviousCompaction: true }))
  assert.equal(later.approved, false)
  assert.equal(later.reason, 'too_frequent')
})
test('裁决：占比告急时即便"太薄"也放行（宁可压薄也不能爆上下文）', () => {
  const verdict = decideCompaction(stats({ shortTokens: 500, shortRatio: 0.9, turnsSinceLast: 0, toolCallsSinceLast: 0 }))
  assert.equal(verdict.approved, true)
  assert.equal(verdict.waiver, 'context_pressure')
})

test('裁决：冷却期内被拒，reason = too_frequent 且 hint 说清差多少', () => {
  // 注意：轮次取 4 —— 既要 ≥ minTurns(3) 以免先被判"太薄"，又要 < cooldownTurns(5) 才落进冷却期。
  // 两个约束同时不满足时报告"太薄"（更根本的那个），这是刻意的判定顺序。
  const verdict = decideCompaction(
    stats({ turnsSinceLast: 4, timeSinceLastMs: 10_000, tokenDeltaSinceLast: 100 }),
  )
  assert.equal(verdict.approved, false)
  assert.equal(verdict.reason, 'too_frequent')
  assert.match(verdict.hint ?? '', /再 1 轮/)
  assert.match(verdict.hint ?? '', /再等 50 秒/)
  assert.match(verdict.hint ?? '', /再累积 1400 token/)
  assert.match(verdict.hint ?? '', /75%/)
})

test('裁决：冷却期三个维度任一不满足即拒（逐维验证）', () => {
  assert.equal(decideCompaction(stats({ turnsSinceLast: 4 })).reason, 'too_frequent', '轮次不足（4 < 冷却 5，但 ≥ 最小 3）')
  assert.equal(decideCompaction(stats({ timeSinceLastMs: 59_000 })).reason, 'too_frequent', '时间不足')
  assert.equal(decideCompaction(stats({ tokenDeltaSinceLast: 1499 })).reason, 'too_frequent', '增量不足')
  assert.equal(decideCompaction(stats({ turnsSinceLast: 5, timeSinceLastMs: 60_000, tokenDeltaSinceLast: 1500 })).approved, true)
})

test('解析：标准输出被正确解析', () => {
  const result = parseCompactionDecision(
    JSON.stringify({
      push_to_mid: [
        { content: '用户偏好 Rust 写系统工具', summary: '用户偏好 Rust', entities: ['Rust', '系统工具'], importance: 0.9 },
      ],
      keep_in_short: ['正在实现记忆系统'],
      fragment_mid: ['M5', 'M8'],
      reasoning: '短期轨迹已达 3000 token',
    }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.decision.push_to_mid.length, 1)
  assert.equal(result.decision.push_to_mid[0]?.summary, '用户偏好 Rust')
  assert.equal(result.decision.push_to_mid[0]?.importance, 0.9)
  assert.deepEqual(result.decision.fragment_mid, ['M5', 'M8'])
  assert.deepEqual(result.decision.keep_in_short, ['正在实现记忆系统'])
  assert.deepEqual(result.dropped, [])
})

test('解析：容忍 ```json 代码块与前后说明文字', () => {
  const raw = '好的，这是我的压缩结果：\n```json\n{"push_to_mid":[],"keep_in_short":["x"],"fragment_mid":[],"reasoning":"r"}\n```\n希望有帮助。'
  const result = parseCompactionDecision(raw)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.decision.keep_in_short, ['x'])
})

test('解析：允许 push 空列表（PLAN §4.3：压缩不等于必须产生中期记忆）', () => {
  const result = parseCompactionDecision('{"push_to_mid":[],"keep_in_short":[],"fragment_mid":[],"reasoning":"无事可记"}')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.decision.push_to_mid, [])
    assert.deepEqual(result.decision.keep_in_short, [])
  }
})

test('质量约束 §4.3：丢弃含指代、纯工具记录、空条目', () => {
  const result = parseCompactionDecision(
    JSON.stringify({
      push_to_mid: [
        { summary: '见上文所述', content: '见上文' },
        { summary: 'tool call: read_file(x)', content: '' },
        { summary: '', content: '' },
        { summary: '用户养了一只叫团子的猫', content: '团子是一只橘猫' },
      ],
      keep_in_short: [],
      fragment_mid: [],
      reasoning: 'r',
    }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.decision.push_to_mid.length, 1, '只有合规的那条留下')
  assert.equal(result.decision.push_to_mid[0]?.summary, '用户养了一只叫团子的猫')
  assert.equal(result.dropped.length, 3)
  assert.ok(result.dropped.some((d) => d.includes('指代')))
  assert.ok(result.dropped.some((d) => d.includes('工具调用')))
})

test('质量约束 §4.3：entities 超量被截断到 5 个（并告警）', () => {
  const result = parseCompactionDecision(
    JSON.stringify({
      push_to_mid: [{ summary: 'x', content: 'y', entities: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
      keep_in_short: [],
      fragment_mid: [],
      reasoning: 'r',
    }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.decision.push_to_mid[0]?.entities.length, 5)
  assert.ok(result.warnings.some((w) => w.includes('entities')))
})

test('解析：结构不合规时明确报错（不写半成品记忆）', () => {
  assert.equal(parseCompactionDecision('这里没有 JSON').ok, false)
  assert.equal(parseCompactionDecision('{"push_to_mid":"不是数组"}').ok, false)
  assert.equal(parseCompactionDecision('{"keep_in_short":42}').ok, false)
  const notObject = parseCompactionDecision('[1,2,3]')
  assert.equal(notObject.ok, false)
})

test('extractJsonObject：带花括号的字符串不会骗过括号计数', () => {
  const raw = '{"a":"这里有个 } 花括号","b":{"c":1}}'
  assert.equal(extractJsonObject(raw), raw)
  const nested = 'prefix {"x":{"y":"}"}} suffix'
  assert.equal(extractJsonObject(nested), '{"x":{"y":"}"}}')
})

test('renderKeepInShort：空列表也要给出明确文本（替换节点不能是空的）', () => {
  const text = renderKeepInShort([])
  assert.ok(text.length > 0)
  assert.match(text, /压缩/)
  const withItems = renderKeepInShort(['任务 A 未完成'], '轨迹过长')
  assert.match(withItems, /- 任务 A 未完成/)
  assert.match(withItems, /压缩说明：轨迹过长/)
})

test('碎片 §5.3：单条限制 —— hint ≤ 80 token，entities ≤ 5', () => {
  const long = '防'.repeat(200)
  const { hint, entities } = makeFragmentHint(long, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.ok(hint.length < long.length, 'hint 必须被裁剪')
  assert.ok(hint.endsWith('…'), '裁剪要留省略号，让人知道被截断')
  assert.equal(entities.length, 5)

  const short = makeFragmentHint('QQ bot 防抖策略', ['QQ', '防抖'])
  assert.equal(short.hint, 'QQ bot 防抖策略', '没超限就不该动它')
  assert.deepEqual(short.entities, ['QQ', '防抖'])
})

test('碎片 §5.3：总量限制 —— 占比越过上限即停止新增，并转为淘汰候选', () => {
  const candidates = [
    { id: 'M1', summary: 'a', entities: [], tokenCount: 40, hintTokens: 6, lastAccessedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'M2', summary: 'b', entities: [], tokenCount: 40, hintTokens: 6, lastAccessedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' },
  ]
  // 正常规模的池子：活跃 1000 / 碎片 20（2%）。两个候选各 40 token、碎片化后各占 6 token。
  const plan = planFragmentation(candidates, { activeTokens: 1000, fragmentTokens: 20, fragmentCount: 1 })
  assert.equal(plan.toFragment.length, 2, '余量充足时两个都该碎片化')

  // 池子很小的情况：活跃 60 / 碎片 10，碎片化一个 40-token 条目后占比会跳到 40% > 20% ⇒ 必须停
  const tight = planFragmentation(candidates, { activeTokens: 60, fragmentTokens: 10, fragmentCount: 1 })
  assert.deepEqual(tight.toFragment, [], '余量不足时一条都不该碎片化')
  assert.ok(tight.notes.some((n) => n.includes('20%')), '要说明为什么停')

  // 已经超限 ⇒ 一条都不加，只给淘汰候选
  const over = planFragmentation(candidates, { activeTokens: 10, fragmentTokens: 90, fragmentCount: 3 })
  assert.deepEqual(over.toFragment, [])
  assert.ok(over.toArchive.length > 0, '超限时要给出淘汰候选')
  assert.equal(over.toArchive[0], 'M1', '淘汰最久未访问的')
})

test('碎片 §5.3：绝对上限 50 条', () => {
  const candidates = [
    { id: 'M1', summary: 'a', entities: [], tokenCount: 1, lastAccessedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
  ]
  const plan = planFragmentation(candidates, { activeTokens: 100000, fragmentTokens: 1, fragmentCount: 50 })
  assert.deepEqual(plan.toFragment, [])
  assert.ok(plan.notes.some((n) => n.includes('50')))
})

test('碎片 §5.3：合并规则 —— entities 重叠的碎片成组', () => {
  const plan = planFragmentation(
    [
      { id: 'M1', summary: 'QQ 防抖', entities: ['QQ', '防抖'], tokenCount: 5, lastAccessedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'M2', summary: 'QQ 消息队列', entities: ['QQ', '队列'], tokenCount: 5, lastAccessedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'M3', summary: '向量库', entities: ['LanceDB'], tokenCount: 5, lastAccessedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    { activeTokens: 1000, fragmentTokens: 0, fragmentCount: 0 },
  )
  assert.equal(plan.mergeGroups.length, 1, 'M1/M2 因 QQ 重叠成一组，M3 独立')
  assert.deepEqual([...plan.mergeGroups[0]!].sort(), ['M1', 'M2'])
})

test('碎片 §5.3：独立预算 —— 碎片与活跃分别计量', () => {
  const plan = planFragmentation([], { activeTokens: 800, fragmentTokens: 200, fragmentCount: 5 })
  // 200/1000 = 20% 恰好到顶 ⇒ 不该再加
  assert.deepEqual(plan.toFragment, [])
  assert.ok(plan.notes.some((n) => n.includes('占比')))
})



