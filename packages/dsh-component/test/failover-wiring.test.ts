/**
 * 回退链接线的测试。
 *
 * 这里证明的是"钩子层的记账与裁决"是对的（宿主的钩子调用方式在真机上验证）：
 *  - 降级**必须落 routing_log**（否则"为什么这次答得不一样"无从查起）；
 *  - 同一步重跑**只换一次**（宿主每次重试都会重跑 `agent/request`）；
 *  - 每 step **重新断言**（否则一次偶发失败会让后面所有步骤都用备模型）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { listRoutingLog, openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { buildFailoverRuntime, FailoverRuntime } from '../src/router-hooks.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-failover-'))
let runtime: MemoryRuntime
const logged: string[] = []

before(() => {
  openDatabase({ file: join(dir, 'seed.sqlite') }).close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'forlife.sqlite') })
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 造一个回退链运行时。 */
function makeFailover(candidates = [
  { provider: 'main-a', model: 'mid' },
  { provider: 'main-b', model: 'backup' },
]): FailoverRuntime {
  return buildFailoverRuntime(runtime, {
    candidates: () => candidates,
    record: (input) => runtime.recordRoutingDecision({ ...input, latencyMs: input.latencyMs ?? 0 }),
    log: (message) => void logged.push(message),
  })
}

test('正常路径：beginStep 返回断言的路由，不产生任何降级记录', () => {
  const failover = makeFailover()
  const route = failover.beginStep('turn1:step0', { provider: 'main-a', model: 'mid' })
  assert.equal(route.provider, 'main-a')
  assert.equal(failover.swaps(), 0)
})

test('失败降级：到阈值时换路由并**落 routing_log**（含理由）', () => {
  const failover = makeFailover()
  failover.beginStep('turn2:step0', { provider: 'main-a', model: 'mid' })
  // 默认阈值来自基线（3）⇒ 前两次 keep，第三次 swap
  const first = failover.onError({ provider: 'main-a', model: 'mid', message: 'HTTP 429 rate limit', tier: 'L2' })
  assert.equal(first.action, 'keep')
  const second = failover.onError({ provider: 'main-a', model: 'mid', message: 'HTTP 429 rate limit', tier: 'L2' })
  assert.equal(second.action, 'keep')
  const third = failover.onError({ provider: 'main-a', model: 'mid', message: 'HTTP 429 rate limit', tier: 'L2' })
  assert.equal(third.action, 'swap')
  assert.equal(third.next?.provider, 'main-b')
  assert.equal(failover.currentRoute()?.provider, 'main-b')

  const rows = listRoutingLog(runtime.db, 50)
  const swapped = rows.find((row) => row['source'] === 'failover-swap')
  assert.ok(swapped !== undefined, '降级必须落 routing_log')
  assert.equal(swapped['switched'], 1)
  assert.match(String(swapped['switch_reason']), /换到 main-b/)
})

test('幂等：同一步里重跑多次只换一次（宿主每次重试都会重跑 agent/request）', () => {
  const failover = makeFailover()
  failover.beginStep('turn3:step0', { provider: 'main-a', model: 'mid' })
  for (let i = 0; i < 3; i++) failover.onError({ provider: 'main-a', model: 'mid', message: '429 rate limit', tier: 'L2' })
  assert.equal(failover.currentRoute()?.provider, 'main-b')

  // 再失败：本步已换过一次 ⇒ 放弃而不是继续换
  const after = failover.onError({ provider: 'main-b', model: 'backup', message: '429 rate limit', tier: 'L2' })
  assert.equal(after.action, 'give-up')
  assert.match(after.reason, /已换过 1 次/)
  assert.equal(failover.currentRoute()?.provider, 'main-b', '不该继续往后换')
})

test('每 step 重新断言：上一步的临时路由不许粘住', () => {
  const failover = makeFailover()
  failover.beginStep('turn4:step0', { provider: 'main-a', model: 'mid' })
  for (let i = 0; i < 3; i++) failover.onError({ provider: 'main-a', model: 'mid', message: '502 bad gateway', tier: 'L2' })
  assert.equal(failover.currentRoute()?.provider, 'main-b', '前提：已经降级')

  const next = failover.beginStep('turn4:step1', { provider: 'main-a', model: 'mid' })
  assert.equal(next.provider, 'main-a', '新步骤必须回到断言的路由（否则会一直粘在备模型上）')
  assert.ok(logged.some((line) => line.includes('重新断言')), '重新断言这件事要留痕（便于发现粘性）')
})

test('鉴权失败：直接放弃，不再重试（换了也没用）', () => {
  const failover = makeFailover()
  failover.beginStep('turn5:step0', { provider: 'main-a', model: 'mid' })
  const decision = failover.onError({ provider: 'main-a', model: 'mid', message: '401 Unauthorized', tier: 'L2' })
  assert.equal(decision.action, 'give-up')
  assert.ok(listRoutingLog(runtime.db, 50).some((row) => row['source'] === 'failover-give-up'), '放弃也要留痕')
})

test('没有 beginStep 就失败：仍要给出裁决（不能因为缺状态就崩）', () => {
  const failover = makeFailover()
  const decision = failover.onError({ provider: 'main-a', model: 'mid', message: '503 server error', tier: 'L3' })
  assert.equal(decision.action, 'keep', '以当前 provider 为起点，第一次失败先重试')
  assert.ok(listRoutingLog(runtime.db, 50).some((row) => row['source'] === 'failover-retry'))
})

test('reset：清掉状态（新会话不该继承上一轮的降级）', () => {
  const failover = makeFailover()
  failover.beginStep('turn6:step0', { provider: 'main-a', model: 'mid' })
  failover.onError({ provider: 'main-a', model: 'mid', message: '429 rate limit', tier: 'L2' })
  failover.reset()
  assert.equal(failover.currentRoute(), undefined)
  assert.equal(failover.swaps(), 0)
})
