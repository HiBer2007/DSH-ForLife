/**
 * 额度查询的守卫测试。
 *
 * 最值得守的一条：**`percent` 是"已用"还是"剩余"**。
 * 搞反的话，告警会在**余额充足**时狂响、在**快没钱**时安静 —— 完全反向，
 * 而且因为"平时也在响"，没人会去查。
 *
 * 另外守：本地端点必须被识别为"没有额度这回事"（不是"不健康"），
 * 否则本地模型会被面板标红，而它其实好好的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeQuota,
  parseDeepSeekBalance,
  parseOpenCodeGoUsage,
  probeQuota,
  QUOTA_PROVIDERS,
  quotaBlocksRouting,
  resolveApiKey,
  resolveQuotaProvider,
} from '../src/quota.ts'

/** 真实响应（2026-10-06 实测 GET /v1/usage）。 */
const REAL_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 22, resetsAt: '2026-10-06T07:49:52.000Z' },
    weekly: { status: 'ok', percent: 40, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 70, resetsAt: '2026-11-02T01:39:42.000Z' },
  },
}

test('★ percent 是「已用」，必须换算成「剩余」（搞反会让告警完全反向）', () => {
  const result = parseOpenCodeGoUsage(REAL_USAGE)
  assert.equal(result.kind, 'windows')
  if (result.kind !== 'windows') return

  const rolling = result.windows.find((w) => w.name === 'rolling')
  assert.equal(rolling?.remainingPercent, 78, '已用 22% ⇒ 剩余必须是 78%（不是 22）')

  const monthly = result.windows.find((w) => w.name === 'monthly')
  assert.equal(monthly?.remainingPercent, 30, '已用 70% ⇒ 剩余 30%')
  assert.equal(monthly?.resetsAt, '2026-11-02T01:39:42.000Z', '重置时间要带回来')
})

test('取最低的那个窗口作为结论（月度过半了才是真信号，不能只看滚动窗）', () => {
  const result = parseOpenCodeGoUsage(REAL_USAGE)
  if (result.kind !== 'windows') throw new Error('应为 windows')
  // 剩余最低的是 monthly（30%）
  assert.match(result.note, /monthly/)
  assert.equal(result.ok, true, '还有 30% 剩余 ⇒ 不算不可用')
})

test('额度用尽 ⇒ ok=false（这才是"钱包空空"）', () => {
  const exhausted = parseOpenCodeGoUsage({ usage: { rolling: { percent: 100 }, weekly: { percent: 50 }, monthly: { percent: 60 } } })
  assert.equal(exhausted.ok, false)
  assert.match(exhausted.note, /已用尽/)
  assert.equal(quotaBlocksRouting(exhausted), true)
})

test('额度偏低 ⇒ ok 仍为 true，但备注要提醒（不要一低就拦）', () => {
  const low = parseOpenCodeGoUsage({ usage: { rolling: { percent: 90 }, weekly: { percent: 10 }, monthly: { percent: 20 } } })
  assert.equal(low.ok, true, '还剩 10% 不该直接拦掉路由')
  assert.match(low.note, /偏低/)
})

test('响应形状变了 ⇒ 如实报 error，不假装健康', () => {
  for (const bad of [{}, { usage: {} }, { usage: { rolling: {} } }, null, 'x']) {
    const result = parseOpenCodeGoUsage(bad)
    assert.equal(result.kind, 'error', `坏输入应报 error：${JSON.stringify(bad)}`)
    assert.equal(result.ok, false, '查不到额度不能当健康')
  }
})

test('DeepSeek 官方：金额余额，且 is_available=false 要能识别出欠费', () => {
  const ok = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  })
  assert.equal(ok.kind, 'balance')
  assert.equal(ok.ok, true)
  assert.match(ok.note, /110\.00 CNY/)

  const zero = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] })
  assert.equal(zero.ok, false, '余额 0 必须判为不可用')
  assert.match(zero.note, /钱包空空/)

  const disabled = parseDeepSeekBalance({ is_available: false, balance_infos: [] })
  assert.equal(disabled.ok, false)
  assert.match(disabled.note, /欠费|不可用/)
})

test('★ 本地端点：识别为「没有额度这回事」，**不是不健康**', () => {
  assert.equal(resolveQuotaProvider('http://127.0.0.1:11434/v1'), undefined, '本地端点不该匹配任何 provider')

  return probeQuota({ baseUrl: 'http://127.0.0.1:11434/v1' }).then((result) => {
    assert.equal(result.kind, 'unsupported')
    assert.equal(result.ok, true, '本地端点没有额度概念 ⇒ 必须算健康，否则面板会把好好的本地模型标红')
    assert.equal(quotaBlocksRouting(result), false)
  })
})

test('注册表可扩展：新增一家只需加一项（匹配是按 baseUrl）', () => {
  assert.equal(resolveQuotaProvider('https://opencode.ai/zen/go/v1')?.id, 'opencode-go')
  assert.equal(resolveQuotaProvider('https://api.deepseek.com/v1')?.id, 'deepseek')
  assert.ok(QUOTA_PROVIDERS.length >= 2)
  // 每个 provider 都要有 id/label/matches/probe —— 少一个主流程就会崩
  for (const provider of QUOTA_PROVIDERS) {
    assert.ok(provider.id !== '' && provider.label !== '')
    assert.equal(typeof provider.matches, 'function')
    assert.equal(typeof provider.probe, 'function')
  }
})

test('key 只按引用名从环境变量取（端点里不存明文）', () => {
  assert.equal(resolveApiKey('FORLIFE_X', { FORLIFE_X: 'sk-1' }), 'sk-1')
  assert.equal(resolveApiKey('FORLIFE_X', {}), undefined)
  assert.equal(resolveApiKey(null), undefined)
  assert.equal(resolveApiKey(''), undefined)
})

test('没有 key ⇒ 报 error 而不是假装健康', async () => {
  const result = await probeQuota({ baseUrl: 'https://opencode.ai/zen/go/v1', keyRef: 'NOT_SET_ANYWHERE', env: {} })
  assert.equal(result.kind, 'error')
  assert.equal(result.ok, false)
  assert.match(describeQuota(result), /额度未知/)
})

test('HTTP 失败/非 JSON ⇒ 报 error（带上响应片段，便于排障）', async () => {
  const failing = await probeQuota({
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyRef: 'K',
    env: { K: 'x' },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  })
  assert.equal(failing.kind, 'error')
  assert.match(failing.note, /401.*unauthorized/s)

  const notJson = await probeQuota({
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyRef: 'K',
    env: { K: 'x' },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }),
  })
  assert.equal(notJson.kind, 'error')
  assert.match(notJson.note, /不是 JSON/)
})
