/**
 * 模型目录的测试。
 *
 * ## 重点测什么
 *
 * ① **标记规则必须"窄"** —— 宁可少标，不要标错。
 *    标错一个 `local` 会让小模型把远程模型当零成本用。
 * ② **不可达的行要标出来**（用户明确要求"各模型当前可达性"是初始路由的三个输入之一）。
 * ③ **一个模型都没枚举出来的接入点要留一行** —— 那本身就是信息。
 * ④ **给小模型看的文本要一行一个**（0.5B 那个量级读 JSON 容易串行）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCatalog, marksOf, renderCatalogForPrompt, TIER_EFFORT } from '../src/catalog.ts'

test('标记：本地自部署的几种写法都认得出', () => {
  const cases = ['scorer.gguf', 'llama-3-8b', 'ollama/qwen', 'vllm-server', 'local-model']
  for (const model of cases) {
    assert.ok(
      marksOf({ provider: 'x', model }).includes('local'),
      `「${model}」应该被认成 local`,
    )
  }
})

test('★ 标记：窄 —— 不许把普通模型误标成 local', () => {
  // 这几个都**不该**被判成 local（含 l/o 之类字母组合，但不是本地推理的信号）
  const cases = ['glm-5.3-flash', 'deepseek-v4.1-flash', 'mimo-v2.6-flash', 'kimi-k3', 'longcat-2.5-preview-free']
  for (const model of cases) {
    assert.ok(
      !marksOf({ provider: 'opencode-go', model }).includes('local'),
      `「${model}」被误标成 local 了 —— 规则太宽`,
    )
  }
})

test('标记：free 只认作为一个词出现的 free', () => {
  assert.ok(marksOf({ provider: 'p', model: 'longcat-2.5-preview-free' }).includes('free'))
  assert.ok(marksOf({ provider: 'p', model: 'free-tier' }).includes('free'))
  // 「freedom」不该算
  assert.ok(!marksOf({ provider: 'p', model: 'freedom-7b' }).includes('free'))
})

test('标记：视觉靠 host 给的 inputModalities', () => {
  assert.ok(marksOf({ provider: 'p', model: 'm', inputModalities: ['text', 'image'] }).includes('vision'))
  assert.ok(!marksOf({ provider: 'p', model: 'm', inputModalities: ['text'] }).includes('vision'))
  // 没给 modalities ⇒ 不猜（"absent means unknown"，宿主的原话）
  assert.ok(!marksOf({ provider: 'p', model: 'm' }).includes('vision'))
})

test('标记：接入点归属（自建 / 原生 / 账号）', () => {
  const base = { oursProviders: ['opencode-go'], nativeProviders: ['deepseek-official'], accountProviders: ['deepseek-account'] }
  assert.ok(marksOf({ provider: 'opencode-go', model: 'm', ...base }).includes('ours'))
  assert.ok(marksOf({ provider: 'deepseek-official', model: 'm', ...base }).includes('native'))
  assert.ok(marksOf({ provider: 'deepseek-account', model: 'm', ...base }).includes('account'))
  assert.ok(!marksOf({ provider: 'unknown', model: 'm', ...base }).includes('ours'))
})

test('目录：整理 + 排序 + 可达性', () => {
  const catalog = buildCatalog({
    providers: [
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
    ],
    models: [
      { provider: 'opencode-go', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
      { provider: 'opencode-go', id: 'mimo-v2.6-flash', name: 'MiMo' },
      { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek Flash', description: '自带' },
    ],
    unreachable: new Set(['opencode-go/mimo-v2.6-flash']),
    now: new Date('2026-10-08T00:00:00Z'),
  })

  assert.equal(catalog.entries.length, 3)
  assert.equal(catalog.builtAt, '2026-10-08T00:00:00.000Z')

  const mimo = catalog.entries.find((e) => e.model === 'mimo-v2.6-flash')
  assert.ok(mimo !== undefined)
  assert.equal(mimo.reachable, false, '不可达的要标出来')
  assert.ok(mimo.unreachableReason !== undefined)

  const glm = catalog.entries.find((e) => e.model === 'glm-5.3-flash')
  assert.equal(glm?.reachable, true)

  // 简介原样带过来（**宿主给的事实，不是我们编的**）
  assert.equal(catalog.entries.find((e) => e.model === 'deepseek-flash')?.description, '自带')

  // 排序稳定
  assert.deepEqual(
    catalog.entries.map((e) => e.provider + '/' + e.model),
    ['deepseek-official/deepseek-flash', 'opencode-go/glm-5.3-flash', 'opencode-go/mimo-v2.6-flash'],
  )

  assert.match(catalog.summary, /接入点 2 个/)
  assert.match(catalog.summary, /可达 2 个/)
})

test('★ 目录：一个模型都没枚举出来的接入点要留一行（那本身就是信息）', () => {
  const catalog = buildCatalog({
    providers: [{ id: 'opencode-go' }, { id: 'deepseek-account', name: '账号' }],
    models: [{ provider: 'opencode-go', id: 'm', name: 'M' }],
  })
  assert.equal(catalog.entries.length, 2)
  const acct = catalog.entries.find((e) => e.provider === 'deepseek-account')
  assert.ok(acct !== undefined, '零模型的接入点被整行丢掉了')
  assert.equal(acct.reachable, false)
  assert.match(acct.unreachableReason ?? '', /没有枚举出任何模型/)
})

test('目录：没有 provider 的模型被跳过（宿主理论上不会给，但别崩）', () => {
  const catalog = buildCatalog({ providers: [{ id: 'p' }], models: [{ id: 'orphan' }] })
  assert.ok(!catalog.entries.some((e) => e.model === 'orphan'))
})

test('★ 给小模型的文本：一行一个 + 带坐标 + 标出不可用', () => {
  const catalog = buildCatalog({
    providers: [{ id: 'opencode-go' }],
    models: [
      { provider: 'opencode-go', id: 'a-free', name: 'A', inputModalities: ['text', 'image'] },
      { provider: 'opencode-go', id: 'b', name: 'B' },
    ],
    unreachable: new Set(['opencode-go/b']),
  })
  const text = renderCatalogForPrompt(catalog)
  const lines = text.split('\n')
  assert.match(lines[0] ?? '', /可用模型/)
  assert.match(text, /可用 opencode-go\/a-free \[免费\/视觉\/自建\] A/)
  assert.match(text, /不可用 opencode-go\/b \[自建\] B/)
  // 每个模型恰好一行
  assert.equal(lines.filter((l) => l.includes('opencode-go/')).length, 2)
})

test('给小模型的文本：超过上限要说明还有多少', () => {
  const models = Array.from({ length: 5 }, (_, i) => ({ provider: 'p', id: 'm' + String(i) }))
  const catalog = buildCatalog({ providers: [{ id: 'p' }], models })
  const text = renderCatalogForPrompt(catalog, { maxEntries: 2 })
  assert.match(text, /还有 3 个未列出/)
})

test('档位 → 推理强度：与播种一致', () => {
  assert.equal(TIER_EFFORT['L1'], 'low')
  assert.equal(TIER_EFFORT['L2'], 'high')
  assert.equal(TIER_EFFORT['L3'], 'max')
  assert.equal(TIER_EFFORT['minimum'], 'low')
})
