/**
 * 定期复盘与路由落库的测试。
 *
 * 复盘这块最要防的是"产出一份没人能执行的报告"。所以每条建议都要能被断言：
 *  - 有**具体动作**（不是"建议关注一下"）；
 *  - 证据不足时**明确说证据不足**（不许把 3 个样本说成规律）；
 *  - 该说"没有需要改的"时就要说没有（否则人会开始忽略复盘结果）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import {
  deleteModelRoute,
  listModelRoutes,
  listRoutingLog,
  markCaseReviewed,
  openDatabase,
  pendingUncertainCases,
  recordRoutingDecision,
  recordUncertainCase,
  routingStats,
  uncertainStats,
  upsertModelRoute,
} from '@forlife/store'

import { reviewCases, summarizeReview, type ReviewCase } from '../src/review.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-routing-'))
let db: import('node:sqlite').DatabaseSync

before(() => {
  db = openDatabase({ file: join(dir, 'routing.sqlite') }).db
})

after(async () => {
  db.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

test('路由表：按 (role, rank) upsert，且能看出优先级顺序', () => {
  upsertModelRoute(db, { role: 'L2', rank: 0, provider: 'main-a', model: 'mid', reasoningEffort: 'medium' })
  upsertModelRoute(db, { role: 'L2', rank: 1, provider: 'main-b', model: 'mid-backup' })
  upsertModelRoute(db, { role: 'L1', rank: 0, provider: 'fast', model: 'small', reasoningEffort: 'low' })

  const l2 = listModelRoutes(db, 'L2')
  assert.equal(l2.length, 2)
  assert.equal(l2[0]?.provider, 'main-a')
  assert.equal(l2[1]?.provider, 'main-b')

  // 同一个 (role, rank) 再写是更新而不是新增
  upsertModelRoute(db, { role: 'L2', rank: 0, provider: 'main-a2', model: 'mid2' })
  const updated = listModelRoutes(db, 'L2')
  assert.equal(updated.length, 2, '不该多出一行')
  assert.equal(updated[0]?.provider, 'main-a2')

  // 关掉而不是删掉（便于回滚）
  upsertModelRoute(db, { role: 'L2', rank: 0, provider: 'main-a2', model: 'mid2', enabled: false })
  assert.equal(listModelRoutes(db, 'L2')[0]?.enabled, 0)

  assert.equal(deleteModelRoute(db, 'L2', 1), true)
  assert.equal(listModelRoutes(db, 'L2').length, 1)
  assert.equal(deleteModelRoute(db, 'L2', 99), false)
})

test('路由日志：决策的每一层信息都能落库并统计出来', () => {
  recordRoutingDecision(db, {
    tier: 'L2',
    source: 'scorer',
    backend: 'local-container',
    confidence: 0.91,
    latencyMs: 12.4,
    provider: 'main-a',
    model: 'mid',
    reasoningEffort: 'medium',
    routeRank: 0,
  })
  recordRoutingDecision(db, {
    tier: 'L3',
    source: 'heuristic',
    backend: 'heuristic',
    confidence: 0.5,
    escalated: true,
    degraded: true,
    degradeReason: '评分超时（>50ms）',
    latencyMs: 1.2,
    provider: 'strong-b',
    model: 'big-backup',
    routeRank: 1,
    skipped: [{ provider: 'strong-a', model: 'big', reason: '无额度或连续失败' }],
  })

  const log = listRoutingLog(db, 10)
  assert.equal(log.length, 2)
  const degradedRow = log.find((row) => row['degraded'] === 1)
  assert.equal(degradedRow?.['tier'], 'L3')
  assert.equal(degradedRow?.['escalated'], 1)
  assert.match(String(degradedRow?.['degrade_reason']), /超时/)
  assert.match(String(degradedRow?.['skipped']), /无额度/)

  const stats = routingStats(db)
  assert.equal(stats.total, 2)
  assert.equal(stats.degradedRate, 0.5)
  assert.ok(stats.byTier.some((row) => row.tier === 'L2' && row.count === 1))
  assert.ok(stats.bySource.some((row) => row.source === 'scorer'))
})

test('不确定案例：落库为 pending，复盘后转 reviewed', () => {
  const id = recordUncertainCase(db, { textExcerpt: '这个事情你怎么看呢', tier: 'L2', confidence: 0.52, backend: 'local-container' })
  assert.equal(uncertainStats(db).pending, 1)
  assert.equal(pendingUncertainCases(db).length, 1)

  markCaseReviewed(db, id, { note: '归入"请求类"', suggestion: '在评分提示词里补一个例子' })
  assert.equal(uncertainStats(db).pending, 0)
  assert.equal(uncertainStats(db).reviewed, 1)
  assert.equal(pendingUncertainCases(db).length, 0)
})

// ── 复盘建议 ───────────────────────────────────────────────────────────────

/** 造 N 条同特征的案例。 */
function makeCases(n: number, text: string, tier: string, confidence: number, backend = 'local-container'): ReviewCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i)}`,
    textExcerpt: `${text}${String(i)}`,
    tier,
    confidence,
    backend,
  }))
}

test('复盘：判得散 + 置信度低 ⇒ 建议加守卫规则或改提示词，而不是只调阈值', () => {
  const cases: ReviewCase[] = [
    ...makeCases(4, '这个方案你看怎么样呢', 'L1', 0.5),
    ...makeCases(4, '这个方案你觉着呢', 'L2', 0.55),
    ...makeCases(4, '这个方案行不行啊', 'L3', 0.52),
  ]
  const suggestions = reviewCases(cases)
  const guard = suggestions.find((item) => item.kind === 'guard-candidate')
  assert.ok(guard !== undefined, '判得散应当产出 guard-candidate 建议')
  assert.match(guard.action, /不要.*只调阈值|不要\s*\*?\*?只调阈值/)
  assert.match(guard.evidence, /\d+ 例/)
})

test('复盘：判得一致但都不自信 ⇒ 建议补提示词例子（比调阈值更精准）', () => {
  const cases = makeCases(9, '帮我看下这个东西怎么样', 'L2', 0.51)
  const suggestions = reviewCases(cases)
  const threshold = suggestions.find((item) => item.kind === 'threshold')
  assert.ok(threshold !== undefined)
  assert.match(threshold.action, /评分提示词/)
  assert.match(threshold.action, /比调阈值更有效/)
})

test('复盘：样本太少时**明确说证据不足**（不许把 3 个样本说成规律）', () => {
  const cases = makeCases(3, '这个方案你看怎么样呢', 'L1', 0.4)
  assert.deepEqual(reviewCases(cases), [], '样本量不足就不该产出建议')
})

test('复盘：兜底走太多 ⇒ 先查后端为什么不可用，而不是优化兜底权重', () => {
  const cases = [
    ...makeCases(10, '帮我看下这个配置', 'L2', 0.9, 'local-container'),
    ...makeCases(8, '帮我看下那个配置', 'L2', 0.55, 'heuristic'),
  ]
  const suggestions = reviewCases(cases)
  const prompt = suggestions.find((item) => item.kind === 'prompt')
  assert.ok(prompt !== undefined)
  assert.match(prompt.action, /先查评分后端/)
  assert.match(prompt.action, /不要\s*\*?\*?忙着调启发式权重/)
  assert.equal(prompt.confidence, 'high')
})

test('复盘总结：没有案例 / 没有建议 / 有建议 三种说法都要对', () => {
  assert.match(summarizeReview([], 0), /没有待复盘/)
  assert.match(summarizeReview([], 12), /没有发现需要调整的地方/)
  const suggestions = reviewCases([
    ...makeCases(4, '这个方案你看怎么样呢', 'L1', 0.5),
    ...makeCases(4, '这个方案你觉着呢', 'L2', 0.55),
    ...makeCases(4, '这个方案行不行啊', 'L3', 0.52),
  ])
  const summary = summarizeReview(suggestions, 12)
  assert.match(summary, /复盘了 12 条案例/)
  assert.match(summary, /产出 \d+ 条建议/)
})

test('每一条建议都必须带具体动作与证据（不许出现"建议关注一下"这种空话）', () => {
  const all = reviewCases([
    ...makeCases(4, '这个方案你看怎么样呢', 'L1', 0.5),
    ...makeCases(4, '这个方案你觉着呢', 'L2', 0.55),
    ...makeCases(4, '这个方案行不行啊', 'L3', 0.52),
    ...makeCases(9, '帮我看下这个东西怎么样', 'L2', 0.51),
    // 兜底占比要超过 30% 才会产出 prompt 类建议（这里是 12/33）
    ...makeCases(12, '帮我看下那个配置的问题', 'L2', 0.55, 'heuristic'),
  ])
  // 断言语义（三类建议都在）而不是数量：
  // 数量随聚类口径变化，钉死数量只会让测试变成"改一次聚类就红一次"
  const kinds = new Set(all.map((item) => item.kind))
  assert.ok(kinds.has('guard-candidate'), '判得散的那一类应当产出守卫建议')
  assert.ok(kinds.has('threshold'), '判得一致但不自信的那一类应当产出阈值/提示词建议')
  assert.ok(kinds.has('prompt'), '兜底占比过高应当产出 prompt 类建议')
  for (const item of all) {
    assert.ok(item.action.length > 15, `${item.kind} 的动作太短，等于没说`)
    assert.ok(item.evidence.length > 5, `${item.kind} 缺少证据`)
    assert.ok(item.summary.length > 8)
    assert.ok(['low', 'medium', 'high'].includes(item.confidence))
  }
})


