/**
 * 缓存指标的纯逻辑测试。
 *
 * 这里守的是**口径**：四类 token 互不重叠，分母算错命中率就会虚高，
 * 而"命中率虚高"是最糟的一类错误 —— 它让人以为优化生效了，实际在烧钱。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  attributeMiss,
  cacheCurve,
  expectedMisses,
  isMiss,
  judgeCache,
  promptTokensOf,
  summarizeCache,
  type UsageSample,
} from '../src/cache-metrics.ts'

/** 造一次采样。 */
function sample(partial: Partial<UsageSample> = {}): UsageSample {
  return {
    at: '2026-10-05T12:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  }
}

test('口径：提示词总 token = 未命中 + 命中 + 写入（三者互不重叠）', () => {
  const s = sample({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 30 })
  assert.equal(promptTokensOf(s), 1050, 'inputTokens 只是"未命中"的那部分，不能当总输入')
})

test('未命中判定：有提示词但一个都没命中', () => {
  assert.equal(isMiss(sample({ inputTokens: 100, cacheReadTokens: 0 })), true)
  assert.equal(isMiss(sample({ inputTokens: 100, cacheReadTokens: 1 })), false, '哪怕命中 1 个 token 也不算全未命中')
  assert.equal(isMiss(sample({ cacheWriteTokens: 50 })), true, '只写不读也是未命中')
  assert.equal(isMiss(sample({})), false, '根本没有提示词就不该算未命中')
})

test('汇总：命中率按提示词总 token 算', () => {
  const summary = summarizeCache([
    sample({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000 }), // 首次：写缓存
    sample({ inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 50 }),
    sample({ inputTokens: 0, cacheReadTokens: 1050, cacheWriteTokens: 0 }),
  ])
  assert.equal(summary.samples, 3)
  assert.equal(summary.cacheReadTokens, 2050)
  assert.equal(summary.cacheWriteTokens, 1050)
  assert.equal(summary.promptTokens, 3100)
  assert.equal(summary.hitRate, 2050 / 3100)
  assert.ok(summary.hitRate > 0.66 && summary.hitRate < 0.67)
})

test('汇总：未命中要区分"可解释"与"不可解释"', () => {
  const summary = summarizeCache([
    sample({ cacheWriteTokens: 1000, missReason: 'first-call' }),
    sample({ inputTokens: 1000, missReason: 'compaction' }),
    sample({ inputTokens: 1000, missReason: 'prompt-edit' }),
    sample({ inputTokens: 1000, missReason: 'unexplained' }),
    sample({ inputTokens: 1000 }), // 还没归因
    sample({ cacheReadTokens: 1000 }), // 命中，不算未命中
  ])
  assert.equal(summary.misses, 5)
  assert.equal(summary.explainedMisses, 3)
  assert.equal(summary.unexplainedMisses, 2, '未归因的也算不可解释（宁可报警，不要自欺）')
})

test('归因：首次调用优先于其它原因（第一次必然未命中，不是异常）', () => {
  const s = sample({ cacheWriteTokens: 1000, at: '2026-10-05T12:00:00.000Z' })
  assert.equal(attributeMiss(s, { isFirstSample: true, changes: [{ kind: 'compaction', at: '2026-10-05T11:59:00.000Z' }] }), 'first-call')
})

test('归因：窗口内的压缩与编辑分别归到各自原因，取最近的一次', () => {
  const s = sample({ inputTokens: 500, at: '2026-10-05T12:00:00.000Z' })
  assert.equal(attributeMiss(s, { changes: [{ kind: 'compaction', at: '2026-10-05T11:59:30.000Z' }] }), 'compaction')
  assert.equal(attributeMiss(s, { changes: [{ kind: 'prompt-edit', at: '2026-10-05T11:59:30.000Z' }] }), 'prompt-edit')
  // 两个都有 ⇒ 取最近的
  assert.equal(
    attributeMiss(s, {
      changes: [
        { kind: 'compaction', at: '2026-10-05T11:59:00.000Z' },
        { kind: 'prompt-edit', at: '2026-10-05T11:59:55.000Z' },
      ],
    }),
    'prompt-edit',
  )
})

test('归因：窗口外的事件不算数（否则"很久以前改过"会永远替未命中背锅）', () => {
  const s = sample({ inputTokens: 500, at: '2026-10-05T12:00:00.000Z' })
  assert.equal(attributeMiss(s, { changes: [{ kind: 'compaction', at: '2026-10-05T11:00:00.000Z' }], windowMs: 300_000 }), 'unexplained')
})

test('归因：命中的采样不需要原因', () => {
  assert.equal(attributeMiss(sample({ cacheReadTokens: 900 }), { changes: [] }), null)
})

test('期望未命中数：= 首次 + 压缩 + 编辑（并把三部分分开给）', () => {
  const expected = expectedMisses({ compactions: 2, promptEdits: 3, samples: 10 })
  assert.equal(expected.total, 6)
  assert.deepEqual(expected, { total: 6, firstCall: 1, compaction: 2, promptEdit: 3 })
  assert.equal(expectedMisses({ compactions: 0, promptEdits: 0, samples: 0 }).total, 0, '没跑过就不该期望有首次未命中')
})

test('结论：不可解释的未命中优先报警（它意味着前缀在无故漂移）', () => {
  const summary = summarizeCache([sample({ cacheWriteTokens: 1000 }), sample({ inputTokens: 1000 })])
  const verdict = judgeCache(summary, { total: 2 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.verdict, /无法解释/)
  assert.match(verdict.verdict, /前缀在无故漂移/)
})

test('结论：全都可解释但命中率过低也要提示', () => {
  const summary = summarizeCache([
    sample({ cacheWriteTokens: 1000, missReason: 'first-call' }),
    sample({ inputTokens: 9000, missReason: 'compaction' }),
  ])
  const verdict = judgeCache(summary, { total: 2 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.verdict, /命中率/)
  assert.match(verdict.verdict, /命中太少/)
})

test('结论：健康时给一句人话（含命中率与未命中对照）', () => {
  const samples = [sample({ cacheWriteTokens: 1000, missReason: 'first-call' })]
  for (let i = 0; i < 19; i++) samples.push(sample({ cacheReadTokens: 1000 }))
  const summary = summarizeCache(samples)
  const verdict = judgeCache(summary, { total: 1 })
  assert.equal(verdict.ok, true)
  assert.match(verdict.verdict, /命中率 95\.0%/)
  assert.match(verdict.verdict, /全部可解释/)
})

test('曲线：累计命中率随时间上升，单次命中率反映当次', () => {
  const curve = cacheCurve([
    sample({ at: '2026-10-05T12:00:00.000Z', cacheWriteTokens: 1000 }),
    sample({ at: '2026-10-05T12:01:00.000Z', cacheReadTokens: 1000 }),
  ])
  assert.equal(curve.length, 2)
  assert.equal(curve[0]?.hitRate, 0, '首次没命中')
  assert.equal(curve[0]?.cumulativeHitRate, 0)
  assert.equal(curve[1]?.hitRate, 1, '第二次全命中')
  assert.equal(curve[1]?.cumulativeHitRate, 0.5, '累计摊平')
})

test('曲线：输入顺序不影响结果（按时间排序）', () => {
  const a = sample({ at: '2026-10-05T12:00:00.000Z', cacheWriteTokens: 100 })
  const b = sample({ at: '2026-10-05T12:01:00.000Z', cacheReadTokens: 100 })
  assert.deepEqual(cacheCurve([b, a]), cacheCurve([a, b]))
})
