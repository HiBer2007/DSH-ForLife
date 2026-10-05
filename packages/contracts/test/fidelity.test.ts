/**
 * 保真度测试（EXECUTION_PLAN §2.6 的强制机制）。
 *
 * 断言的层次很关键 —— **只对 `doc` 来源的参数强制一比一**，
 * 我们自己新增的设计参数（`design`）不受文档约束但仍必须集中管理。
 *
 *  1. 基线里每条参数都能被 `defaultFor` 取出（没有孤儿键）；
 *  2. **`doc` 来源**的参数：未登记偏离时，生效值必须严格等于基线值；
 *  3. `design` 来源的参数：不约束取值，但不得出现"基线里没有却在代码里硬编码"的情况（由 lint 阶段 1 补强）；
 *  4. 登记的数值偏离：键必须存在、必须是 `doc` 来源、值必须真的不同、理由/依据必须写清；
 *  5. 规则级偏离：四要素必须齐全；
 *  6. 每条参数与时机都必须有出处；时机 id 不重复；数量不低于防误删阈值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baselineKeys, baselineOrigin, baselineParam, baselineTimings, baselineValue, docOriginKeys } from '../src/baseline.ts'
import { DEVIATIONS, RULE_DEVIATIONS, deviationMap } from '../src/deviations.ts'
import { allDefaults, defaultFor } from '../src/defaults.ts'

test('基线：每条参数都能取出生效默认值', () => {
  const defaults = allDefaults()
  for (const key of baselineKeys()) {
    assert.ok(key in defaults, `defaults 缺少基线参数：${key}`)
  }
})

test('一比一：doc 来源的参数必须严格等于文档值（除非登记偏离）', () => {
  const deviations = deviationMap()
  const offenders: string[] = []
  for (const key of docOriginKeys()) {
    if (deviations.has(key)) continue
    const actual = defaultFor(key)
    const expected = baselineValue(key)
    if (!deepEqual(actual, expected)) {
      offenders.push(`${key}（${baselineParam(key).src}）基线=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
    }
  }
  assert.deepEqual(offenders, [], `以下**文档参数**偏离了基线却没有登记：\n${offenders.join('\n')}`)
})

test('doc 与 design 两类参数都真实存在（防止 origin 判定失效）', () => {
  const doc = docOriginKeys()
  const design = baselineKeys().filter((key) => baselineOrigin(key) === 'design')
  assert.ok(doc.length >= 40, `doc 来源参数过少（${doc.length}），src 前缀可能写错`)
  assert.ok(design.length >= 30, `design 来源参数过少（${design.length}）`)
})

test('数值偏离：键存在、属 doc 来源、值真的不同、理由与依据齐全', () => {
  const keys = new Set(baselineKeys())
  for (const deviation of DEVIATIONS) {
    assert.ok(keys.has(deviation.key), `偏离登记了基线中不存在的键：${deviation.key}`)
    assert.equal(baselineOrigin(deviation.key), 'doc', `偏离 ${deviation.key} 不是 doc 来源，应直接从基线改值而不是登记偏离`)
    assert.ok(!deepEqual(deviation.value, baselineValue(deviation.key)), `偏离 ${deviation.key} 的值与基线相同，应删除该登记`)
    assert.ok(deepEqual(defaultFor(deviation.key), deviation.value), `偏离 ${deviation.key} 登记值与生效值不一致`)
    assert.ok(deviation.reason.length > 20, `偏离 ${deviation.key} 必须写清理由`)
    assert.ok(deviation.approvedBy.length > 0, `偏离 ${deviation.key} 必须写清依据`)
  }
})

test('规则级偏离：四要素齐全', () => {
  for (const rd of RULE_DEVIATIONS) {
    assert.ok(rd.rule.length > 10, '规则级偏离必须引用到具体规则')
    assert.ok(rd.behavior.length > 20, '规则级偏离必须写清我们的实际做法')
    assert.ok(rd.reason.length > 20, '规则级偏离必须写清理由')
    assert.ok(rd.approvedBy.length > 0, '规则级偏离必须写清批准来源')
  }
})

test('基线：参数与时机数量符合预期（防误删）', () => {
  assert.ok(baselineKeys().length >= 90, `基线参数过少（${baselineKeys().length}），疑似被误删`)
  assert.ok(baselineTimings().length >= 20, `时机数量过少（${baselineTimings().length}）`)
  const ids = baselineTimings().map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, '时机 id 有重复')
})

test('基线：每条参数与时机都必须有出处', () => {
  for (const key of baselineKeys()) {
    assert.ok(baselineParam(key).src.length > 0, `${key} 缺少 src`)
  }
  for (const timing of baselineTimings()) {
    assert.ok(timing.src.length > 0 && timing.landing.length > 0, `${timing.id} 缺少 src/landing`)
  }
})

/** 结构化深比较（基线只含 JSON 值）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
