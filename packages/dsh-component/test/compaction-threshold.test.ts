/**
 * 压缩**生效阈值**守卫 —— 抓「参数写在 JSON 里、真正跑的数字却是别人的」这一类问题。
 *
 * ## 为什么需要这一条（2026-10-06 实测的 D）
 *
 * PLAN §4.2 Step 1 / §12.1 要求系统自动压缩阈值 = **50%**，基线键
 * `compaction.autoTriggerRatio = 0.5` 也在 `plan-baseline.json` 里躺着 —— 但：
 *  - 代码从不设置 `thresholdRatio`；
 *  - 四个 profile 插入 `forlife-compaction` 时**都没有 config**；
 *  - ⇒ 生效值来自宿主 `BasicCompactionEngine` 的 `DEFAULT_THRESHOLD_RATIO = 0.8`
 *    （`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:15`）。
 *
 * 而 `contracts/test/fidelity.test.ts` **全绿**：它断言的是
 * `defaultFor(key) === baselineValue(key)`（JSON 对自己），
 * 既看不见消费点，也看不见 profile/宿主那两份覆盖。
 *
 * ## 这一条断言的是什么
 *
 * 真机装配一次（`new Context()` + 真的 `new ForlifeCompactionEngine(...)`），
 * 断言**引擎最终持有的 `config.thresholdRatio`**（宿主 `resolveCompactSpec` 就是拿它
 * 算 `thresholdTokens = contextWindow × ratio`）等于**生效值**，而不是宿主缺省 0.8。
 *
 * ⚠️ 2026-10-09：PLAN §12.1 原文是 **50%**，但我们按用户口径登记了一条数值偏离
 * （`compaction.autoTriggerRatio` → **0.6**，见 `contracts/src/deviations.ts`）。
 * 所以这里断的是 `defaultFor(...)`（= 基线 + 偏离登记），并且**显式钉住 0.6** ——
 * 否则谁把偏离删了、生效值悄悄回到 0.5，这条测试会照样绿。
 *
 * 两条一起才等于"部署里生效"：本文件证「插件缺省 = 生效值」，
 * 下面那条 profile 测试证「四个 profile 挂的都是这份插件」。
 * 消费点本身由 `packages/contracts/test/param-consumption.test.ts` 守。
 *
 * @module forlife-memory/test/compaction-threshold
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { defaultFor } from '@forlife/contracts'

import { ForlifeCompactionEngine } from '../src/compaction-engine.ts'

/**
 * 宿主缺省阈值（`@deepseek-ai/dsh-compaction-basic` 的 `DEFAULT_THRESHOLD_RATIO`）。
 *
 * 写在这里是**故意**的：这条测试要能在"我们不再显式设置阈值"时变红，
 * 而 0.8 就是那种情况下的实际生效值。
 */
const HOST_DEFAULT_THRESHOLD_RATIO = 0.8

/** 四个 profile 目录名。 */
const PROFILES: readonly string[] = [
  'forlife',
  'forlife-headless',
  'forlife-qq',
  'forlife-web',
]

test('★★ 生效阈值 = 生效值（不是宿主缺省 0.8）', () => {
  const engine = new ForlifeCompactionEngine(new Context(), {})

  const expected = defaultFor<number>('compaction.autoTriggerRatio')
  assert.equal(
    expected,
    0.6,
    'PLAN §12.1 原文是 50%（基线 0.5 未动），但用户 2026-10-09 拍板用 60% —— ' +
      '生效值必须来自 contracts/src/deviations.ts 的登记；跌破 0.5 说明登记丢了',
  )
  assert.equal(
    engine.config.thresholdRatio,
    expected,
    '引擎最终持有的 thresholdRatio 必须等于 defaultFor(compaction.autoTriggerRatio) —— ' +
      '否则宿主会用 DEFAULT_THRESHOLD_RATIO 算出别的触发点',
  )
  assert.notEqual(
    engine.config.thresholdRatio,
    HOST_DEFAULT_THRESHOLD_RATIO,
    '宿主缺省 0.8 不是我们的值：说明阈值又没被显式设置',
  )
})

test('★ profile 显式配置仍然优先（运维可覆盖，不被插件缺省吃掉）', () => {
  const engine = new ForlifeCompactionEngine(new Context(), { thresholdRatio: 0.72 })
  assert.equal(engine.config.thresholdRatio, 0.72, '显式配置必须赢过插件缺省')
})

test('★★ 四个 profile 挂的都是我们的引擎（否则那个 profile 生效的还是宿主 0.8）', () => {
  for (const profile of PROFILES) {
    const source = readFileSync(new URL(`../../../profiles/${profile}/cordis.patch.yml`, import.meta.url), 'utf8')
    assert.match(source, /forlife-compaction/, `${profile}：必须插入 forlife-compaction（唯一实现 ctx.compaction）`)
    assert.match(
      source,
      /id:\s*compaction-basic[\s\S]{0,60}?disabled:\s*true/,
      `${profile}：必须禁用宿主的 compaction-basic —— 不禁用的话 ctx.compaction 会是宿主那份（阈值 0.8）`,
    )
  }
})

test('★ 单一真源：profile 里不许硬编码 thresholdRatio（YAML 读不了基线，写死必然漂移）', () => {
  for (const profile of PROFILES) {
    const source = readFileSync(new URL(`../../../profiles/${profile}/cordis.patch.yml`, import.meta.url), 'utf8')
    assert.ok(
      !source.includes('thresholdRatio'),
      `${profile}：profile 里出现了 thresholdRatio 字面量。阈值只有一处真源` +
        '（plan-baseline.json → compaction-engine.ts 的插件缺省）；' +
        '确实要按 profile 覆盖，请同时在 packages/contracts/src/deviations.ts 登记，并同步本条测试。',
    )
  }
})
