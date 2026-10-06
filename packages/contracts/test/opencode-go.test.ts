/**
 * OpenCode Go 接入点的守卫测试。
 *
 * 重点守两件**会真出问题**的事：
 *  1. 免费模型到期必须自动禁用（fail-closed）—— 我们没有任何接口能问"它现在还免费吗"，
 *     所以只能靠"复核时间 + 到期停用"。写错方向（先信任）会在它悄悄计费后继续跑量。
 *  2. 每个请求必须带自己的 User-Agent 与**稳定的会话 id** ——
 *     文档明确要求，且会话 id 直接决定提示词缓存命中（成本与延迟）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildHeaders,
  isModelUsable,
  modelUrl,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_SESSION_HEADER,
  OPENCODE_GO_USER_AGENT,
  planOpenCodeGoRoutes,
  protocolPath,
  usableModels,
} from '../src/opencode-go.ts'

/** 复核期内的时间点。 */
const IN_WINDOW = new Date('2026-10-08T00:00:00Z')
/** 复核期外（免费模型应被禁用）。 */
const EXPIRED = new Date('2026-11-01T00:00:00Z')

test('清单只包含被授权的 5 个模型（能用 ≠ 允许用）', () => {
  const ids = OPENCODE_GO_MODELS.map((model) => model.id).sort()
  assert.deepEqual(ids, [
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'longcat-2.5-preview-free',
    'mimo-v2.6-flash',
    'space-bunny-free',
  ])
  // Go 的模型列表里有几十个，清单外的必须被判不可用
  assert.equal(isModelUsable('kimi-k3', IN_WINDOW).usable, false)
  assert.match(isModelUsable('kimi-k3', IN_WINDOW).reason, /不在授权清单/)
})

test('免费模型：复核期内可用，过期即禁用（fail-closed）', () => {
  assert.equal(isModelUsable('space-bunny-free', IN_WINDOW).usable, true)

  const expired = isModelUsable('space-bunny-free', EXPIRED)
  assert.equal(expired.usable, false, '免费状态过期后必须不可用')
  assert.match(expired.reason, /未复核/, '原因要说清是"未复核"而不是"模型不存在"')

  // 付费模型不受复核期影响（它们不依赖"是否免费"这个前提）
  assert.equal(isModelUsable('deepseek-v4.1-flash', EXPIRED).usable, true)
})

test('过期后可用清单与路由计划都自动收缩', () => {
  assert.equal(usableModels(IN_WINDOW).length, 5, '复核期内 5 个都能用')
  assert.equal(usableModels(EXPIRED).length, 3, '过期后只剩 3 个付费模型')

  const plan = planOpenCodeGoRoutes(EXPIRED)
  const models = plan.map((row) => row.model)
  assert.ok(!models.includes('space-bunny-free'), '不可用的模型**绝不能进计划**（写进库就等于承诺可用）')
  assert.ok(models.includes('deepseek-v4.1-flash'))
})

test('路由计划：每个角色都有降级链，且 rank 从 0 连续', () => {
  const plan = planOpenCodeGoRoutes(IN_WINDOW)
  const roles = [...new Set(plan.map((row) => row.role))].sort()
  assert.deepEqual(roles, ['L1', 'L2', 'L3', 'scorer'], '四个必需角色都要有候选')

  for (const role of roles) {
    const ranks = plan.filter((row) => row.role === role).map((row) => row.rank)
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${role} 的 rank 必须升序`)
    assert.equal(ranks[0], 0, `${role} 必须从 rank 0 开始`)
    // 降级链至少要两条：只有一条时 provider 一抖就是整轮失败
    if (role !== 'scorer') {
      assert.ok(ranks.length >= 2, `${role} 至少要有 2 个候选（降级链）`)
    }
  }

  // 档位只影响推理强度（既有设计）
  assert.equal(plan.find((row) => row.role === 'L1')?.reasoningEffort, 'low')
  assert.equal(plan.find((row) => row.role === 'L3')?.reasoningEffort, 'high')
})

test('请求头：必须带自己的 UA 与稳定的会话 id', () => {
  const headers = buildHeaders({ apiKey: 'k', sessionId: 'onebot11:10001' })
  assert.equal(headers['user-agent'], OPENCODE_GO_USER_AGENT)
  assert.ok(!/node|undici|openai|fetch/i.test(headers['user-agent']), 'UA 不能是 SDK / HTTP 库的名字')
  assert.equal(headers[OPENCODE_GO_SESSION_HEADER], 'onebot11:10001', '会话 id 要原样透传（缓存命中靠它）')
  assert.equal(headers['authorization'], 'Bearer k')
})

test('协议路径：chat / responses / messages 各自映射正确', () => {
  assert.equal(protocolPath('chat'), '/chat/completions')
  assert.equal(protocolPath('responses'), '/responses')
  assert.equal(protocolPath('messages'), '/messages')
  // 授权清单里的模型都走 chat；地址要拼在 Go 的基址上
  assert.equal(modelUrl('deepseek-v4.1-flash'), `${OPENCODE_GO_BASE_URL}/chat/completions`)
  // 未登记的模型按默认协议处理（不抛），但会被 isModelUsable 挡住
  assert.equal(modelUrl('kimi-k3'), `${OPENCODE_GO_BASE_URL}/chat/completions`)
})
