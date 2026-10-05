/**
 * 子代理模型分配的测试。
 *
 * 重点三条：
 *  - **异构优先**（子代理要和主模型不同，否则拿不到独立视角）；
 *  - **`reasoningEffort` 绝不硬编码**（它是模型声明的合法集合，取不到就不传）；
 *  - 子代理不得在任何一层换模型（工具不存在 + 运行时断言 + 分配决定）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RouteEntry } from '../src/routes.ts'
import { assignAll, assignSubagent, assertNoRuntimeModelChange, ROLE_PURPOSE, ROLE_TIER, SUBAGENT_ROLES } from '../src/subagents.ts'

/** 一份典型路由表：L1/L3 各有同价位的两个不同 provider。 */
const ROUTES: readonly RouteEntry[] = [
  { role: 'L1', rank: 0, provider: 'cheap-a', model: 'small-a' },
  { role: 'L1', rank: 1, provider: 'cheap-b', model: 'small-b' },
  { role: 'L3', rank: 0, provider: 'strong-a', model: 'big-a', reasoningEffort: 'high' },
  { role: 'L3', rank: 1, provider: 'strong-b', model: 'big-b', reasoningEffort: 'high' },
  { role: 'vision', rank: 0, provider: 'vlm', model: 'vl-7b' },
]

const MAIN = { provider: 'strong-a', model: 'big-a' }

/** 模型能力表。 */
const INFO: Record<string, { reasoningEfforts?: readonly string[]; image?: boolean }> = {
  'cheap-a/small-a': { reasoningEfforts: ['off', 'low'] },
  'cheap-b/small-b': {},
  'strong-a/big-a': { reasoningEfforts: ['off', 'low', 'high', 'max'] },
  'strong-b/big-b': { reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  'vlm/vl-7b': { image: true },
}

const CTX = { routes: ROUTES, mainModel: MAIN, modelInfo: (p: string, m: string): { reasoningEfforts?: readonly string[]; image?: boolean } | undefined => INFO[`${p}/${m}`] }

test('角色清单：七个子代理角色，每个都有档位与用途说明', () => {
  assert.equal(SUBAGENT_ROLES.length, 7)
  for (const role of SUBAGENT_ROLES) {
    assert.ok(ROLE_TIER[role] !== undefined, `${role} 缺少档位映射`)
    assert.ok((ROLE_PURPOSE[role] ?? '').length > 6, `${role} 缺少用途说明`)
  }
})

test('档位分配：搬运型用便宜模型，思考型用强模型（想错的代价远大于 token 费）', () => {
  assert.equal(ROLE_TIER.retrieval, 'L1')
  assert.equal(ROLE_TIER.archival, 'L1')
  assert.equal(ROLE_TIER.formatting, 'L1')
  assert.equal(ROLE_TIER.planning, 'L3')
  assert.equal(ROLE_TIER.review, 'L3')
  assert.equal(ROLE_TIER.compaction, 'L3')
  assert.equal(ROLE_TIER.vision, 'vision')
})

test('异构优先：子代理与主模型不同（否则它只是"同一张嘴换个说法"）', () => {
  // 主模型是 strong-a/big-a ⇒ L3 角色应当选 strong-b/big-b
  const planning = assignSubagent('planning', CTX)
  assert.equal(planning?.options.provider, 'strong-b')
  assert.equal(planning?.options.model, 'big-b')
  assert.equal(planning?.heterogeneous, true)
  assert.match(String(planning?.note), /与主模型异构/)

  // L1 角色本来就和主模型不是同一个 ⇒ 也是异构
  const retrieval = assignSubagent('retrieval', CTX)
  assert.equal(retrieval?.heterogeneous, true)
  assert.equal(retrieval?.options.provider, 'cheap-a')
})

test('异构拿不到时退回同模型，但必须**留下警告**（不许静默退化）', () => {
  const onlyOne: readonly RouteEntry[] = [{ role: 'L3', rank: 0, provider: 'strong-a', model: 'big-a', reasoningEffort: 'high' }]
  const planning = assignSubagent('planning', { ...CTX, routes: onlyOne })
  assert.equal(planning?.options.provider, 'strong-a')
  assert.equal(planning?.heterogeneous, false)
  assert.match(String(planning?.warning), /拿不到独立视角/)
  assert.match(String(planning?.warning), /同价位的备选模型/)
})

test('reasoningEffort **绝不硬编码**：只在模型声明的合法集合里才传', () => {
  // strong-b 的集合是 pi-ai 风格（含 minimal/xhigh），high 在集合里 ⇒ 传
  const planning = assignSubagent('planning', CTX)
  assert.equal(planning?.options.reasoningEffort, 'high')

  // 把主模型换成 strong-a，异构候选是 strong-b：仍然合法
  // 但如果候选模型声明的集合里没有 desired ⇒ 不传，并且说明原因
  const weird: readonly RouteEntry[] = [{ role: 'L3', rank: 0, provider: 'odd', model: 'odd-1', reasoningEffort: 'high' }]
  const noEffort = assignSubagent('planning', {
    ...CTX,
    routes: weird,
    modelInfo: () => ({ reasoningEfforts: ['off'] }),
  })
  assert.equal(noEffort?.options.reasoningEffort, undefined, '不在合法集合里就不能传')
  assert.match(String(noEffort?.note), /不在该模型的合法集合里/)

  // 能力信息查不到 ⇒ 也不传（硬编码会让请求被拒或静默忽略）
  const unknownInfo = assignSubagent('planning', { ...CTX, routes: weird, modelInfo: () => undefined })
  assert.equal(unknownInfo?.options.reasoningEffort, undefined)
  assert.match(String(unknownInfo?.note), /未取到推理强度合法集合/)
})

test('视觉角色必须落到 vision 档位（不能拿纯文本模型去读图）', () => {
  const vision = assignSubagent('vision', CTX)
  assert.equal(vision?.options.provider, 'vlm')
  assert.equal(vision?.options.model, 'vl-7b')
  assert.equal(vision?.routeRank, 0)
})

test('不可用 provider 会被跳过（降级到下一个候选并说明）', () => {
  // 主模型是 cheap-a/small-a ⇒ 异构候选是 cheap-b/small-b；把它标记不可用
  const retrieval = assignSubagent('retrieval', { ...CTX, mainModel: { provider: 'cheap-a', model: 'small-a' }, unavailable: ['cheap-b'] })
  // 异构候选全不可用 ⇒ 退回同模型，并给警告
  assert.equal(retrieval?.options.provider, 'cheap-a')
  assert.equal(retrieval?.heterogeneous, false)
  assert.ok(retrieval?.warning !== undefined)
})

test('批量分配：七个角色一次算清，分不到的返回 undefined', () => {
  const all = assignAll(CTX)
  assert.equal(all.length, 7)
  assert.ok(all.every((item) => item !== undefined), '这份路由表能覆盖全部七个角色')

  const sparse = assignAll({ ...CTX, routes: [ROUTES[0] as RouteEntry] })
  // 只有 L1 ⇒ 三个搬运型角色能分到，L3 的三个 + 视觉都没得选（7 - 3 = 4）
  assert.equal(sparse.filter((item) => item === undefined).length, 4, '缺路由的角色应当是 undefined 而不是乱选')
})

test('子代理不得在运行期换模型（第三道防线：分配决定，运行期不许改）', () => {
  const assigned = { provider: 'cheap-a', model: 'small-a' }
  // 没换 ⇒ 放行
  assert.doesNotThrow(() => assertNoRuntimeModelChange({ isSubagent: true, assigned, requested: assigned }))
  // 换了 ⇒ 抛错，且错误信息要说清"该找主代理"
  assert.throws(
    () => assertNoRuntimeModelChange({ isSubagent: true, assigned, requested: { provider: 'strong-a', model: 'big-a' } }),
    /子代理不得在运行期更换模型/,
  )
  try {
    assertNoRuntimeModelChange({ isSubagent: true, assigned, requested: { provider: 'strong-a', model: 'big-a' } })
  } catch (error) {
    assert.match(String(error), /让主代理决定/)
    assert.match(String(error), /代价由主对话承担/)
  }
  // 主代理自己可以换（那是 switch_model 的事，走冷却与预算）
  assert.doesNotThrow(() => assertNoRuntimeModelChange({ isSubagent: false, assigned, requested: { provider: 'strong-a', model: 'big-a' } }))
})


