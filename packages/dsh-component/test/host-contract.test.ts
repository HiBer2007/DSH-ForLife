/**
 * `forlife doctor`（宿主契约探针）的测试。
 *
 * ## 最值得守的四条
 *
 * 1. ★★ **`optional` 缺了 ⇒ `degraded`，不是 `broken`** ——
 *    这正是验收标准后半句"**降级可用**"。
 *    **如果所有依赖都算致命，一次宿主小升级就会让插件拒绝启动** ——
 *    那比降级更糟（用户宁可少一个加固功能，也不愿整个记忆系统不启动）；
 * 2. ★★ **`required` 缺了 ⇒ `broken`**，且**要点名是哪个**；
 * 3. ★ **探针抛异常 = 不满足**（异常本身是要报的信息，
 *    不能让它把 `doctor` 自己搞崩 —— 那会把"诊断"变成"又一次故障"）；
 * 4. ★ **探针只读**（跑两遍结果一样，且不改 ctx）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HOST_REQUIREMENTS, renderDoctorReport, runDoctor, type HostRequirement } from '../src/host-contract.ts'

/** 一个"什么都齐"的假宿主。 */
function fullHost(): unknown {
  return {
    on: () => () => {},
    get: (name: string): unknown => {
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'connection') return { fetch: { register: () => async () => {} } }
      return undefined
    },
  }
}

test('★ 齐全的宿主 ⇒ `ok`', () => {
  const r = runDoctor(fullHost())
  assert.equal(r.verdict, 'ok', r.summary)
  assert.equal(r.missingRequired.length, 0)
  assert.equal(r.missingOptional.length, 0)
})

test('★★ **`optional` 缺了 ⇒ `degraded`，不是 `broken`**（这就是"降级可用"）', () => {
  // 有必需的（on / systemPrompt / tools），但**没有 connection**（面板是 optional）
  const host = {
    on: () => () => {},
    get: (name: string): unknown => {
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return { register: () => () => {} }
      return undefined
    },
  }
  const r = runDoctor(host)
  assert.equal(r.verdict, 'degraded', `**只缺加固功能不该判成 broken**：${r.summary}`)
  assert.equal(r.missingRequired.length, 0, '不该有必需项缺失')
  assert.ok(r.missingOptional.length > 0, '应当报出缺了哪些加固项')
  assert.match(r.summary, /降级可用/, '结论要说清"仍然可用"')
  assert.match(r.summary, /记忆本体正常/, '要说清什么没受影响')
})

test('★★ **`required` 缺了 ⇒ `broken`**，且**要点名是哪个**', () => {
  const r = runDoctor({}) // 什么都没有
  assert.equal(r.verdict, 'broken', r.summary)
  assert.ok(r.missingRequired.length > 0, '要报出缺了哪些必需项')
  assert.match(r.summary, /契约不匹配/, '结论要说清是什么问题')
  // **要点名** —— 只说"契约不匹配"而列不出是哪一项，等于没说
  const text = renderDoctorReport(r)
  for (const m of r.missingRequired) assert.ok(text.includes(m.id), `报告里要点名 ${m.id}`)
})

test('★★ 探针**抛异常 = 不满足**（异常本身是要报的信息）', () => {
  const boom: HostRequirement = {
    id: 'boom',
    what: '会炸的探针',
    level: 'required',
    probe: () => {
      throw new Error('宿主接口变了')
    },
  }
  // **不能让它把 doctor 自己搞崩** —— 那会把"诊断"变成"又一次故障"
  assert.doesNotThrow(() => runDoctor(fullHost(), [boom]))
  const r = runDoctor(fullHost(), [boom])
  assert.equal(r.verdict, 'broken')
  assert.match(r.missingRequired[0]?.detail ?? '', /探测抛了异常/, '要报出"是抛异常了"')
  assert.match(r.missingRequired[0]?.detail ?? '', /宿主接口变了/, '**原始异常信息要留下**')
})

test('★ 探针返回非 `true` 也算不满足（不假设它一定返回布尔）', () => {
  const weird: HostRequirement = { id: 'w', what: 'x', level: 'optional', probe: () => 'yes' as unknown as boolean }
  const r = runDoctor(fullHost(), [weird])
  assert.equal(r.results[0]?.ok, false, '**只有严格 true 才算满足**')
})

test('★ 探针**只读**（跑两遍结果一样）', () => {
  const host = fullHost()
  const a = runDoctor(host)
  const b = runDoctor(host)
  assert.deepEqual(
    a.results.map((r) => [r.id, r.ok]),
    b.results.map((r) => [r.id, r.ok]),
    '两遍结果必须一样（探针不该改状态）',
  )
})

test('★ 报告里**降级说明与失败说明分开**（不能让人以为降级就是坏了）', () => {
  const degraded = runDoctor({ on: () => () => {}, get: () => undefined })
  const text = renderDoctorReport(degraded)
  if (degraded.missingOptional.length > 0) {
    assert.match(text, /不算失败/, '要说清"降级不算失败"')
  }
  const broken = runDoctor({})
  const btext = renderDoctorReport(broken)
  assert.match(btext, /需要处理/, 'broken 要说"需要处理"')
})

test('★ 清单本身**不含"可能有用的"**（只列真的依赖）', () => {
  // 每一项都要有 id / what / level / probe —— 缺一不可
  for (const r of HOST_REQUIREMENTS) {
    assert.ok(r.id.length > 0, '要有 id')
    assert.ok(r.what.length > 0, `**${r.id} 要说清"缺了会怎样"**`)
    assert.ok(r.level === 'required' || r.level === 'optional', `${r.id} 要有级别`)
    assert.equal(typeof r.probe, 'function', `${r.id} 要有探针`)
  }
  // **必须有 required 也要有 optional** —— 全 required 的话就不是"降级可用"了
  assert.ok(HOST_REQUIREMENTS.some((r) => r.level === 'required'), '要有必需项')
  assert.ok(HOST_REQUIREMENTS.some((r) => r.level === 'optional'), '**要有加固项**（否则谈不上降级）')
})
