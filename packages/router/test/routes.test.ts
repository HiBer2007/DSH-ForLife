/**
 * 路由表、切换策略与回退链的测试。
 *
 * 守的是一条主线：「**失败/无额度按序自动降级**」必须真的能走通，
 * 而且每一步都可解释（谁被跳过、为什么）。另外守住一对容易互相抵消的机制：
 * 轮次内锁定（防漂移）与每轮重断言（防粘性）—— 少了任何一个都会出问题。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertNotSubagentSwitch,
  assertTierForTurn,
  decideSwitch,
  defaultRouteEntries,
  defaultSwitchPolicy,
  emptyFallbackState,
  lockTierForTurn,
  recordRouteFailure,
  recordRouteSuccess,
  ROUTE_ROLES,
  selectRoute,
  type RouteEntry,
} from '../src/routes.ts'

/** 三档各有一条主选 + 一条备选。 */
const ENTRIES: readonly RouteEntry[] = [
  { role: 'L1', rank: 0, provider: 'fast-a', model: 'small' },
  { role: 'L2', rank: 0, provider: 'main-a', model: 'mid' },
  { role: 'L2', rank: 1, provider: 'main-b', model: 'mid-backup' },
  { role: 'L2', rank: 2, provider: 'main-c', model: 'mid-cheap' },
  { role: 'L3', rank: 0, provider: 'strong-a', model: 'big' },
  { role: 'L3', rank: 1, provider: 'strong-b', model: 'big-backup' },
]

test('角色清单：三档 + 视觉/嵌入/评分器/子代理', () => {
  assert.deepEqual([...ROUTE_ROLES], ['L1', 'L2', 'L3', 'vision', 'embedding', 'scorer', 'subagent'])
})

test('选择：按 rank 取主选，未降级', () => {
  const selection = selectRoute(ENTRIES.filter((e) => e.role === 'L2'))
  assert.equal(selection?.entry.provider, 'main-a')
  assert.equal(selection?.rank, 0)
  assert.equal(selection?.degraded, false)
  assert.deepEqual(selection?.skipped, [])
})

test('降级：主选无额度 ⇒ 按序用下一个，并说明跳过了谁', () => {
  const selection = selectRoute(ENTRIES.filter((e) => e.role === 'L2'), { unavailable: ['main-a'] })
  assert.equal(selection?.entry.provider, 'main-b')
  assert.equal(selection?.rank, 1)
  assert.equal(selection?.degraded, true)
  assert.deepEqual(selection?.skipped, [{ provider: 'main-a', model: 'mid', reason: '无额度或连续失败' }])
})

test('降级：连续跳过两个 ⇒ 用第三个，跳过原因都在', () => {
  const selection = selectRoute(ENTRIES.filter((e) => e.role === 'L2'), { unavailable: ['main-a'], unhealthy: ['main-b'] })
  assert.equal(selection?.entry.provider, 'main-c')
  assert.equal(selection?.skipped.length, 2)
  assert.match(selection?.skipped[1]?.reason ?? '', /健康检查/)
})

test('降级：全部不可用 ⇒ undefined（调用方必须处理"这一档没有模型"）', () => {
  const selection = selectRoute(ENTRIES.filter((e) => e.role === 'L3'), { unavailable: ['strong-a', 'strong-b'] })
  assert.equal(selection, undefined)
})

test('关掉的条目不参与选择（但仍在表里，便于回滚）', () => {
  const withDisabled: readonly RouteEntry[] = [
    { role: 'L1', rank: 0, provider: 'a', model: 'm', enabled: false },
    { role: 'L1', rank: 1, provider: 'b', model: 'm2' },
  ]
  assert.equal(selectRoute(withDisabled)?.entry.provider, 'b')
})

test('档位映射：reasoningEffort 按档位递增（弱模型不需要想很久）', () => {
  const entries = defaultRouteEntries({
    l1: { provider: 'p', model: 'small' },
    l2: { provider: 'p', model: 'mid' },
    l3: { provider: 'p', model: 'big' },
    vision: { provider: 'p', model: 'vl' },
    embedding: { provider: 'p', model: 'emb' },
    scorer: { provider: 'p', model: 'score' },
    subagent: { provider: 'p', model: 'sub' },
  })
  assert.equal(entries.find((e) => e.role === 'L1')?.reasoningEffort, 'low')
  assert.equal(entries.find((e) => e.role === 'L3')?.reasoningEffort, 'high')
  assert.equal(entries.length, 7, '七个角色都要有默认映射')
  const roles = new Set(entries.map((e) => e.role))
  for (const role of ROUTE_ROLES) assert.ok(roles.has(role), `缺少 ${role} 的默认路由`)
})

test('轮次内锁定：同一轮里不允许换档位（§8.6 轮次内不换模型）', () => {
  const first = lockTierForTurn(undefined, 'L2')
  assert.equal(first.tier, 'L2')
  assert.equal(first.locked, false)
  assert.equal(first.refusedSwitch, false)

  const second = lockTierForTurn('L2', 'L3')
  assert.equal(second.tier, 'L2', '同一轮里必须沿用原档位')
  assert.equal(second.locked, true)
  assert.equal(second.refusedSwitch, true, '被拒绝的切换要能看出来（进日志）')

  const same = lockTierForTurn('L2', 'L2')
  assert.equal(same.refusedSwitch, false, '没换就不算拒绝')
})

test('每轮重断言：只锁不重断言会变成粘性（成本悄悄翻倍而没人发现）', () => {
  // 上一轮锁定在 L3，这一轮判出来是 L1 ⇒ 必须回到 L1（而不是继续 L3）
  const next = assertTierForTurn('L1')
  assert.equal(next.tier, 'L1', '每轮重新断言：不能继承上一轮的档位')

  // 管理员显式钉住是**显式行为**，不算粘性
  const pinned = assertTierForTurn('L1', { pinned: 'L3' })
  assert.equal(pinned.tier, 'L3')
  assert.match(String(pinned.note), /显式覆盖，不是粘性/)

  // 上限控制（省成本）
  const capped = assertTierForTurn('L3', { maxTier: 'L2' })
  assert.equal(capped.tier, 'L2')
  assert.match(String(capped.note), /降下来/)
  assert.equal(assertTierForTurn('L1', { maxTier: 'L2' }).tier, 'L1', '没超上限就不动')
})

test('回退链：连续失败到阈值才排除（偶发失败不该误伤）', () => {
  let state = emptyFallbackState()
  const first = recordRouteFailure(state, 'main-a')
  state = first.state
  assert.equal(first.newlyExhausted, false, '一次失败不该排除')

  const second = recordRouteFailure(state, 'main-a')
  state = second.state
  assert.equal(second.newlyExhausted, false)
  assert.equal(state.failures['main-a'], 2)

  // 阈值默认 3（见基线 router.fallback.failuresBeforeSwitch）
  const third = recordRouteFailure(state, 'main-a')
  state = third.state
  assert.equal(third.newlyExhausted, true, '到阈值就该排除并换路由')
  assert.deepEqual(state.exhausted, ['main-a'])

  // 排除之后：选择器会跳过它
  const selection = selectRoute(ENTRIES.filter((e) => e.role === 'L2'), { unavailable: state.exhausted })
  assert.equal(selection?.entry.provider, 'main-b')
})

test('回退链：一次成功就把失败计数清掉（否则偶发失败攒够阈值会误排除）', () => {
  let state = emptyFallbackState()
  state = recordRouteFailure(state, 'p').state
  state = recordRouteFailure(state, 'p').state
  state = recordRouteSuccess(state, 'p')
  assert.equal(state.failures['p'], undefined)
  assert.deepEqual(state.exhausted, [])
  // 再失败一次也只是第 1 次
  assert.equal(recordRouteFailure(state, 'p').state.failures['p'], 1)
})

test('切换裁决：理由太短、冷却中、预算用尽都要拦住（切换贵于委派）', () => {
  const policy = defaultSwitchPolicy()
  assert.ok(policy.cooldownMs > 0 && policy.perHour > 0)

  const at = new Date('2026-10-05T12:00:00.000Z')
  const noReason = decideSwitch({ at, reason: '换' }, [], policy)
  assert.equal(noReason.approved, false)
  assert.match(noReason.reason, /理由太短/)

  const ok = decideSwitch({ at, reason: '弱模型答不了这个架构问题' }, [], policy)
  assert.equal(ok.approved, true)
  assert.match(ok.reason, /还剩/)

  // 冷却中
  const tooSoon = decideSwitch({ at: new Date(at.getTime() + 5_000), reason: '再换一次试试' }, [{ at: at.toISOString() }], policy)
  assert.equal(tooSoon.approved, false)
  assert.match(tooSoon.reason, /冷却中/)
  assert.ok(tooSoon.cooldownRemainingMs > 0)

  // 冷却结束后可以切
  const later = decideSwitch({ at: new Date(at.getTime() + policy.cooldownMs + 1_000), reason: '确实需要更强的模型' }, [{ at: at.toISOString() }], policy)
  assert.equal(later.approved, true)

  // 预算用尽
  const many = Array.from({ length: policy.perHour }, (_, i) => ({ at: new Date(at.getTime() - (i + 1) * (policy.cooldownMs + 1_000)).toISOString() }))
  const exhausted = decideSwitch({ at, reason: '还想再切一次' }, many, policy)
  assert.equal(exhausted.approved, false)
  assert.match(exhausted.reason, /预算已用完/)
})

test('子代理不得自切：运行时断言必须抛错（不是静默忽略）', () => {
  assert.throws(() => assertNotSubagentSwitch({ isSubagent: true }), /子代理不得自行切换模型/)
  assert.doesNotThrow(() => assertNotSubagentSwitch({ isSubagent: false }))
  // 错误信息要给出"应该怎么做"，而不是只说"不行"
  try {
    assertNotSubagentSwitch({ isSubagent: true })
  } catch (error) {
    assert.match(String(error), /让主代理决定/)
  }
})
