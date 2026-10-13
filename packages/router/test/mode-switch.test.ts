/**
 * 运行模式切换的测试。
 *
 * 这一批守的是**最难在真机上复现**的几条路径：
 *  - 排水没排完就切换（表现为"机器人答到一半没了"）；
 *  - 排水超时该**放弃切换**而不是强切（宁可这次没切成，也不要打断轮次）；
 *  - 切换失败要回滚；**回滚也失败**时要如实说"状态未知，需要人工介入"；
 *  - 幂等（重复切到同一模式不做任何动作，但仍留审计）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adviseAutoSwitch, defaultSwitchOptions, switchMode, type ModeSwitchEffects, type SwitchModeRequest } from '../src/mode-switch.ts'

/** 造一套可控的副作用。 */
function makeEffects(options: {
  inFlightSeq?: readonly number[]
  applyFails?: boolean
  rollbackFails?: boolean
  resumeFails?: boolean
} = {}): ModeSwitchEffects & { readonly audits: Record<string, unknown>[]; readonly calls: string[]; inFlight: () => number } {
  const audits: Record<string, unknown>[] = []
  const calls: string[] = []
  let index = 0
  let current = options.inFlightSeq?.[0] ?? 0
  return {
    audits,
    calls,
    inFlight: () => current,
    async stopAccepting() {
      calls.push('stopAccepting')
    },
    async resumeAccepting() {
      calls.push('resumeAccepting')
      if (options.resumeFails === true) throw new Error('恢复入口失败')
    },
    async apply(request: SwitchModeRequest) {
      calls.push(`apply:${request.from}->${request.to}`)
      // 回滚调用（to 是原 from）与首次切换区分开
      const isRollback = request.reason.startsWith('回滚')
      if (isRollback && options.rollbackFails === true) throw new Error('回滚失败')
      if (!isRollback && options.applyFails === true) throw new Error('切换失败')
      // 每次 apply 往前走一格在途数（模拟"排水后确实空了"）
      index += 1
      current = options.inFlightSeq?.[index] ?? 0
    },
    audit(entry) {
      audits.push(entry)
    },
    async sleep() {
      // 不真的睡：让排水循环靠 inFlightSeq 推进
      index += 1
      current = options.inFlightSeq?.[index] ?? 0
    },
    now: () => new Date('2026-10-05T12:00:00.000Z'),
  }
}

const REQUEST: SwitchModeRequest = { endpointId: 'ep1', from: 'resident', to: 'on-demand', actor: 'admin', reason: '省内存' }

test('切换成功：先关入口 → 排水 → 执行 → 审计留痕', async () => {
  const effects = makeEffects({ inFlightSeq: [2, 1, 0] })
  const result = await switchMode(REQUEST, effects)
  assert.equal(result.ok, true)
  assert.equal(result.effectiveMode, 'on-demand')
  assert.equal(result.drained, true)
  assert.deepEqual(effects.calls.slice(0, 2), ['stopAccepting', 'apply:resident->on-demand'])
  assert.equal(effects.audits.length, 1)
  assert.equal(effects.audits[0]?.['ok'], true)
  assert.match(String(effects.audits[0]?.['note']), /排水等待/)
})

test('幂等：已经是目标模式 ⇒ 不做任何动作，但仍写审计（"谁试过切"要有迹可查）', async () => {
  const effects = makeEffects()
  const result = await switchMode({ ...REQUEST, to: 'resident' }, effects)
  assert.equal(result.ok, true)
  assert.equal(result.note.includes('未做改动'), true)
  assert.deepEqual(effects.calls, [], '幂等路径不该碰任何副作用')
  assert.equal(effects.audits.length, 1)
  assert.match(String(effects.audits[0]?.['note']), /幂等跳过/)
})

test('排水超时 ⇒ **放弃切换并恢复入口**（宁可这次没切成，也不打断轮次）', async () => {
  // 在途永远不归零
  const effects = makeEffects({ inFlightSeq: [3, 3, 3, 3, 3, 3, 3, 3] })
  const result = await switchMode(REQUEST, effects, { drainTimeoutMs: 600, drainPollMs: 200, forceOnDrainTimeout: false })
  assert.equal(result.ok, false)
  assert.equal(result.effectiveMode, 'resident', '必须留在原模式')
  assert.equal(result.drained, false)
  assert.match(result.note, /排水超时/)
  assert.ok(effects.calls.includes('resumeAccepting'), '放弃切换后必须恢复入口，否则端点会一直不接受请求')
  assert.ok(!effects.calls.some((call) => call.startsWith('apply:')), '不该执行切换')
  assert.match(String(effects.audits[0]?.['note']), /放弃切换/)
})

test('排水超时但策略允许强切 ⇒ 照切，并在审计里写明"强切"', async () => {
  const effects = makeEffects({ inFlightSeq: [3, 3, 3, 3] })
  const result = await switchMode(REQUEST, effects, { drainTimeoutMs: 400, drainPollMs: 200, forceOnDrainTimeout: true })
  assert.equal(result.ok, true)
  assert.equal(result.drained, false)
  assert.match(result.note, /强切/)
  assert.match(String(effects.audits[0]?.['note']), /超时后强切/)
})

test('切换失败 ⇒ 自动回滚到上一个模式，并恢复入口', async () => {
  const effects = makeEffects({ inFlightSeq: [0], applyFails: true })
  const result = await switchMode(REQUEST, effects)
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.equal(result.effectiveMode, 'resident', '回滚成功时模式应当是原来的')
  assert.ok(effects.calls.some((call) => call === 'apply:on-demand->resident'), '回滚要走同一条 apply 路径')
  assert.ok(effects.calls.includes('resumeAccepting'))
  assert.match(String(effects.audits[0]?.['note']), /已回滚/)
})

test('回滚也失败 ⇒ 如实说"状态未知，需要人工介入"，不假装干净', async () => {
  const effects = makeEffects({ inFlightSeq: [0], applyFails: true, rollbackFails: true })
  const result = await switchMode(REQUEST, effects)
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, false)
  assert.equal(result.effectiveMode, 'on-demand', '回滚没成功 ⇒ 实际状态是切换后的（或者更糟）')
  assert.match(result.note, /回滚也失败了/)
  assert.match(result.note, /需要人工介入/)
  assert.match(String(effects.audits[0]?.['note']), /状态未知/)
  assert.ok(effects.calls.includes('resumeAccepting'), '即使回滚失败也要尽量恢复入口')
})

test('连恢复入口都失败 ⇒ 也要在审计里说出来（这是最糟的情况）', async () => {
  const effects = makeEffects({ inFlightSeq: [0], applyFails: true, rollbackFails: true, resumeFails: true })
  const result = await switchMode(REQUEST, effects)
  assert.equal(result.ok, false)
  assert.match(String(effects.audits[0]?.['note']), /连恢复入口都失败/)
})

test('默认排水参数：有界（无限等会让切换永远挂住）', () => {
  const defaults = defaultSwitchOptions()
  assert.ok(defaults.drainTimeoutMs > 0 && defaults.drainTimeoutMs <= 60_000)
  assert.ok(defaults.drainPollMs > 0)
  assert.equal(defaults.forceOnDrainTimeout, false, '默认不强切：不打断轮次优先')
})

// ── 自动切换策略 ───────────────────────────────────────────────────────────

/** 基本信号。 */
const BASE_SIGNALS = {
  hour: 14,
  memoryFreeRatio: 0.6,
  requestsLastHour: 5,
  current: 'resident' as const,
  endpointType: 'local' as const,
}

test('自动策略：内存告急优先卸载（这条压过其它所有考虑）', () => {
  const advice = adviseAutoSwitch({ ...BASE_SIGNALS, memoryFreeRatio: 0.08, requestsLastHour: 100 })
  assert.equal(advice.to, 'on-demand')
  assert.equal(advice.shouldSwitch, true, '内存告急时必须卸载，哪怕正忙')
  assert.match(advice.reason, /可用内存只剩/)
})

test('自动策略：深夜不忙 ⇒ 按需；白天忙 ⇒ 常驻', () => {
  const night = adviseAutoSwitch({ ...BASE_SIGNALS, hour: 3, requestsLastHour: 1 })
  assert.equal(night.to, 'on-demand')
  assert.equal(night.shouldSwitch, true)
  assert.match(night.reason, /深夜/)

  const busy = adviseAutoSwitch({ ...BASE_SIGNALS, hour: 14, requestsLastHour: 50, current: 'on-demand' })
  assert.equal(busy.to, 'resident')
  assert.equal(busy.shouldSwitch, true)
  assert.match(busy.reason, /常驻避免冷启动/)
})

test('自动策略：没有明显倾向时保持现状（不为了切换而切换）', () => {
  const advice = adviseAutoSwitch({ ...BASE_SIGNALS, hour: 15, requestsLastHour: 5 })
  assert.equal(advice.shouldSwitch, false)
  assert.match(advice.reason, /保持现状/)
})

test('自动策略：已是目标模式时 shouldSwitch=false（避免每次扫描都写审计）', () => {
  const advice = adviseAutoSwitch({ ...BASE_SIGNALS, hour: 3, requestsLastHour: 0, current: 'on-demand' })
  assert.equal(advice.to, 'on-demand')
  assert.equal(advice.shouldSwitch, false)
})

test('自动策略：云模型与宿主内置不受本地容器模式影响', () => {
  const cloud = adviseAutoSwitch({ ...BASE_SIGNALS, endpointType: 'cloud-api', current: 'resident' })
  assert.equal(cloud.to, 'remote-api')
  assert.equal(cloud.shouldSwitch, true)

  const native = adviseAutoSwitch({ ...BASE_SIGNALS, endpointType: 'host-native', current: 'on-demand' })
  assert.equal(native.to, 'host-native')
  assert.equal(native.shouldSwitch, true)

  // 已经是正确模式就不动
  assert.equal(adviseAutoSwitch({ ...BASE_SIGNALS, endpointType: 'cloud-api', current: 'remote-api' }).shouldSwitch, false)
})
