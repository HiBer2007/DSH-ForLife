/**
 * 自研回退链的测试。
 *
 * 这里守的是三条**最难在真机上复现**的约束（§2.7.3 第 3/4/5 条）：
 *  - `agent/request` 每次重试都会重跑 ⇒ 换路由必须**幂等**（重跑 N 次只换一次）；
 *  - 换过之后不能粘住 ⇒ 每个 step 必须**重新断言**；
 *  - 有些失败换路由**没意义**（鉴权、请求本身有问题）⇒ 必须尽早失败而不是白换一轮。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'

import {
  assertRouteForStep,
  classifyFailure,
  isSwappable,
  onRequestError,
  startStep,
  type ModelRef,
  type RequestFailure,
} from '../src/failover.ts'

const MAIN: ModelRef = { provider: 'main-a', model: 'mid' }
const CANDIDATES: readonly ModelRef[] = [MAIN, { provider: 'main-b', model: 'mid-backup' }, { provider: 'main-c', model: 'mid-cheap' }]

/** 造一次失败。 */
function failure(kind: RequestFailure['kind'], provider = 'main-a', message = 'boom'): RequestFailure {
  return { kind, provider, message, at: '2026-10-05T12:00:00.000Z' }
}

test('失败分类：能区分"该换路由"与"换了也没用"', () => {
  assert.equal(classifyFailure('HTTP 429 rate limit exceeded'), 'rate-limit')
  assert.equal(classifyFailure('insufficient quota'), 'rate-limit')
  assert.equal(classifyFailure('401 Unauthorized'), 'auth')
  assert.equal(classifyFailure('400 invalid request: unsupported content'), 'bad-request')
  assert.equal(classifyFailure('ETIMEDOUT'), 'timeout')
  assert.equal(classifyFailure('502 Bad Gateway'), 'server')
  assert.equal(classifyFailure('ECONNRESET'), 'transport')
  assert.equal(classifyFailure('empty response'), 'empty-response')
  assert.equal(classifyFailure('发生了某种没见过的错'), 'unknown')

  // 换路由有意义的类别
  assert.equal(isSwappable('rate-limit'), true)
  assert.equal(isSwappable('server'), true)
  assert.equal(isSwappable('timeout'), true)
  assert.equal(isSwappable('empty-response'), true)
  // 换了没意义的
  assert.equal(isSwappable('auth'), false)
  assert.equal(isSwappable('bad-request'), false)
  assert.equal(isSwappable('transport'), false, '网络抖动先重试')
})

test('限流：换到候选链的第二个（并说明原 provider 为什么被放弃）', () => {
  const state = startStep('turn1:step0', MAIN)
  const decision = onRequestError(state, failure('rate-limit'), CANDIDATES, { failuresBeforeSwap: 1 })
  assert.equal(decision.action, 'swap')
  assert.equal(decision.next?.provider, 'main-b')
  assert.match(decision.reason, /main-a\/mid 失败/)
  assert.equal(decision.state.swaps, 1)
  assert.equal(decision.state.cursor, 2, '游标要越过已试过的两个')
})

test('幂等：同一步里重跑多次只换一次（否则会把候选链用光，最后跑到最差的模型上）', () => {
  let state = startStep('turn1:step0', MAIN)
  const first = onRequestError(state, failure('rate-limit'), CANDIDATES, { failuresBeforeSwap: 1 })
  assert.equal(first.action, 'swap')
  state = first.state

  // `agent/request` 每次重试都会重跑 ⇒ 这里再喂一次失败
  const second = onRequestError(state, failure('rate-limit', 'main-b'), CANDIDATES, { failuresBeforeSwap: 1 })
  assert.equal(second.action, 'give-up', '本步已换过一次，不再继续换')
  assert.match(second.reason, /已换过 1 次/)
  assert.match(second.reason, /尽早失败/)
  assert.equal(second.state.current.provider, 'main-b', '当前路由不该再变')
})

test('阈值可配：到阈值就换（不是超过阈值才换）', () => {
  const policy = { failuresBeforeSwap: 2 }
  let state = startStep('turn1:step0', MAIN)
  const first = onRequestError(state, failure('server'), CANDIDATES, policy)
  assert.equal(first.action, 'keep', '第一次失败先重试')
  state = first.state
  const second = onRequestError(state, failure('server'), CANDIDATES, policy)
  assert.equal(second.action, 'swap', '到阈值（第 2 次失败）就该换')
  assert.equal(second.next?.provider, 'main-b')
})

test('鉴权失败：直接放弃并说明"换模型解决不了"（不白换一轮）', () => {
  const state = startStep('turn1:step0', MAIN)
  const decision = onRequestError(state, failure('auth'), CANDIDATES, { failuresBeforeSwap: 1 })
  assert.equal(decision.action, 'give-up')
  assert.match(decision.reason, /换模型也解决不了/)
  assert.match(decision.reason, /需要人处理/)
})

test('请求本身有问题：也直接放弃（换个模型一样失败）', () => {
  const decision = onRequestError(startStep('turn1:step0', MAIN), failure('bad-request'), CANDIDATES, { failuresBeforeSwap: 1 })
  assert.equal(decision.action, 'give-up')
  assert.match(decision.reason, /一样会失败/)
})

test('网络抖动：先重试，但重试到阈值后仍会换（可能只是那个 provider 的网络有问题）', () => {
  let state = startStep('turn1:step0', MAIN)
  const policy = { failuresBeforeSwap: 1 }
  // 网络类失败阈值是 threshold+1：连撞两次才换（第一次先当成抖动）
  const first = onRequestError(state, failure('transport'), CANDIDATES, policy)
  assert.equal(first.action, 'keep')
  assert.match(first.reason, /多给一次机会/)
  state = first.state
  const second = onRequestError(state, failure('transport'), CANDIDATES, policy)
  assert.equal(second.action, 'swap', '连撞两次就不只是抖动了')
})

test('候选链用尽：如实说"这一档没有可用模型"（不掩盖）', () => {
  const onlyOne: readonly ModelRef[] = [MAIN]
  const decision = onRequestError(startStep('turn1:step0', MAIN), failure('rate-limit'), onlyOne, { failuresBeforeSwap: 1 })
  assert.equal(decision.action, 'give-up')
  assert.match(decision.reason, /候选链已用尽/)
  assert.match(decision.reason, /需要人处理/)
})

test('每 step 重新断言：上一步的临时路由**不许粘住**（表现是"今天好像变笨了"）', () => {
  // 第一步换到了备选
  const swapped = onRequestError(startStep('turn1:step0', MAIN), failure('rate-limit'), CANDIDATES, { failuresBeforeSwap: 1 }).state
  assert.equal(swapped.current.provider, 'main-b')

  // 新一步开始：必须重新断言回主选
  const next = assertRouteForStep(swapped, 'turn1:step1', MAIN)
  assert.equal(next.state.current.provider, 'main-a', '新步骤必须回到按档位判定的路由')
  assert.equal(next.state.swaps, 0)
  assert.match(String(next.note), /重新断言/)
  assert.match(String(next.note), /粘住/)
})

test('同一步内重跑：路由**保持**（幂等的另一半）', () => {
  // 显式给阈值 1（默认是基线 3）：这条测的是"重跑要保持"，不是阈值
  const swapped = onRequestError(startStep('turn1:step0', MAIN), failure('rate-limit'), CANDIDATES, { failuresBeforeSwap: 1 }).state
  assert.equal(swapped.current.provider, 'main-b', '前提：已经换过')
  const same = assertRouteForStep(swapped, 'turn1:step0', MAIN)
  assert.equal(same.state.current.provider, 'main-b', '同一步重跑要保持已换的路由（否则又会撞回坏的那个）')
  assert.equal(same.note, undefined, '没有变化就不该有说明')
})

test('默认阈值来自保真度基线（"到阈值就换"，不是"超过阈值才换"）', () => {
  const threshold = defaultFor<number>('router.fallback.failuresBeforeSwitch')
  assert.ok(threshold >= 1, '基线阈值必须是正数')
  let state = startStep('turn1:step0', MAIN)
  // 阈值前都应当 keep
  for (let i = 1; i < threshold; i++) {
    const decision = onRequestError(state, failure('rate-limit'), CANDIDATES)
    assert.equal(decision.action, 'keep', `第 ${String(i)} 次失败不该换（阈值 ${String(threshold)}）`)
    state = decision.state
  }
  // **第 threshold 次失败时换**
  const atThreshold = onRequestError(state, failure('rate-limit'), CANDIDATES)
  assert.equal(atThreshold.action, 'swap', `第 ${String(threshold)} 次失败应当换路由（到阈值就换）`)
  assert.equal(atThreshold.next?.provider, 'main-b')
})

test('第一步：没有历史状态时直接以断言的路由起步', () => {
  const fresh = assertRouteForStep(undefined, 'turn1:step0', MAIN)
  assert.equal(fresh.state.current.provider, 'main-a')
  assert.equal(fresh.state.swaps, 0)
  assert.deepEqual(fresh.state.failures, [])
})
