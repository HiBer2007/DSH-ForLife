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

/** 用户口径里"等效 600k"的那个数（`compaction.autoTriggerRatio` × 模型总上下文）。 */
const EFFECTIVE_THRESHOLD_TOKENS = 600_000

/** 这个项目实际跑的模型（四个 profile 的 `agent-default-model` 都是它）。 */
const DEFAULT_MODEL_ID = 'deepseek-v4.1-flash'

/**
 * 取某个 profile 里某个模型声明的 `contextWindow`。
 *
 * ## 为什么逐行扫、而且"遇到下一个 `- id:` 就停"
 *
 * 这段是 patch 结构（`config.providers.opencode-go.models[]`），为了取一个数字引 YAML 解析器
 * 不划算。但**必须逐行 + 遇下一个模型就停**：全局 `match(/contextWindow: (\d+)/)`
 * 抓的是文件里**第一个**模型的窗口 —— 四个模型的值不同（1000000 / 262144 / 204800…）时
 * 它会抓到别人的，于是这条守卫在"我们改错了模型"的情况下照样绿。
 *
 * @param source - profile 的 `cordis.patch.yml` 全文。
 * @param modelId - 模型 id（`- id: <modelId>`）。
 * @returns 该模型声明的 `contextWindow`。
 */
function contextWindowOf(source: string, modelId: string): number {
  const lines = source.split('\n')
  const startAt = lines.findIndex((line) => line.trim() === `- id: ${modelId}`)
  assert.ok(startAt >= 0, `profile 里找不到模型 ${modelId} 的声明（id 写错了？还是整段被删了？）`)
  for (let i = startAt + 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (line.startsWith('- id:')) break // 已经走到下一个模型 ⇒ 这个模型没声明 contextWindow
    const match = /^contextWindow:\s*(\d+)$/.exec(line)
    if (match !== null) return Number(match[1])
  }
  assert.fail(
    `模型 ${modelId} 没有声明 contextWindow —— 缺了它宿主会退回 adapter 的兜底默认值` +
      '（`dsh-llm-pi-ai` 的 DEFAULT_CONTEXT_WINDOW = 262144），压缩阈值会悄悄变成 ≈157k',
  )
}

/**
 * ★★ 用户 2026-10-09 裁定 ①：**分母**必须写对，否则"60%"是空话。
 *
 * ## 为什么这条非有不可（它是本次改动里最容易静默失效的一条）
 *
 * 用户的原话是「改成阈值百分之60吧，等效600k，因为现在模型总上下文空间是1M」。
 * 而宿主算的是 `thresholdTokens = floor(contextWindow × ratio)` —— `ratio` 由我们的
 * 插件缺省给出（上面那条测试守着它 = 0.6），**`contextWindow` 却来自 profile 里
 * adapter 的模型声明**。四个 profile 原本写的是 `262144`（那是 `dsh-llm-pi-ai` 的
 * **通用兜底默认值**，不是这个模型的事实）⇒ 生效阈值 ≈ **157k**，与 600k 差了近 4 倍。
 *
 * 也就是说：**比例改对了、分母不对，用户拿到的还是错的东西** ——
 * 而 `fidelity.test.ts`（JSON 对自己）与 `param-consumption.test.ts`（键有没有被引用）
 * **都看不见 profile 里这个数**。这里补上。
 *
 * ⚠️ **只钉 `deepseek-v4.1-flash`**（四个 profile 的默认模型，也是用户点名的那个）。
 * 其余三个模型（`deepseek-v4-pro` / `glm-5.3` / `glm-5.3-flash`）的窗口值**故意没动**：
 * 第三方模型库（models.dev）给的是 1,000,000，但本仓没有第一手依据，
 * 而"声明得比真实值大"会让压缩永不触发（上下文直接溢出）—— 那是更坏的方向。
 * 谁来定这件事：用户。定完之后在这里补一条同样形状的断言（别只改 profile）。
 */
test('★★ 生效触发点 = 600k：四个 profile 的 `contextWindow × ratio` 必须真的到 60 万', () => {
  const ratio = defaultFor<number>('compaction.autoTriggerRatio')
  for (const profile of PROFILES) {
    const source = readFileSync(new URL(`../../../profiles/${profile}/cordis.patch.yml`, import.meta.url), 'utf8')

    // ① 60k 那个口径只对**默认模型**成立 —— 先把"默认模型是它"钉住
    assert.match(
      source,
      new RegExp(`id:\\s*agent-default-model[\\s\\S]{0,120}?model:\\s*${DEFAULT_MODEL_ID}`),
      `${profile}：默认模型必须是 ${DEFAULT_MODEL_ID} —— 换默认模型的话，"600k"这句话就不再成立于实际跑的那个模型`,
    )

    // ② 分母：模型总上下文（用户澄清是 1M）
    const contextWindow = contextWindowOf(source, DEFAULT_MODEL_ID)
    assert.equal(
      contextWindow,
      1_000_000,
      `${profile}：${DEFAULT_MODEL_ID} 的总上下文是 **1M**（用户 2026-10-09 裁定 ①）。` +
        '`262144` 是 `dsh-llm-pi-ai` 的**通用兜底默认值**，不是这个模型的事实。',
    )

    // ③ 乘出来必须真的是 600k —— 这一条才是用户要的那个数
    assert.equal(
      Math.floor(contextWindow * ratio),
      EFFECTIVE_THRESHOLD_TOKENS,
      `${profile}：用户口径是「60% 等效 600k」。宿主算的是 \`contextWindow × ratio\`，` +
        `当前 ${String(contextWindow)} × ${String(ratio)} = ${String(Math.floor(contextWindow * ratio))} —— ` +
        '分母错了，比例改对了也没用（修之前正是 0.6 × 262144 ≈ 157k）。',
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-09（用户裁定：**把所有值都补上**）—— 逐模型钉住真值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 兜底默认值（`dsh-llm-pi-ai/lib/index.js:923` 的 `DEFAULT_CONTEXT_WINDOW`，
 * 以及 `:1114` 的 `source.defaultContextWindow ?? 262144`）。
 *
 * **它不是任何模型的真值**，只是一个"没人填时别算出 0"的占位。
 * 写进 profile 反而比留空更坏：留空时 pi-ai 会退回**包内目录**
 * （`@earendil-works/pi-ai/dist/providers/data/opencode-go.json`）里的真值，
 * 而显式写的数字**优先于目录**（`resolveRouteModels()` 里 `entry.contextWindow ?? base?.contextWindow`）。
 */
const PI_AI_FALLBACK_CONTEXT_WINDOW = 262_144

/**
 * **每个模型的窗口真值登记表**：`[模型 id, 真值, 来源]`。
 *
 * ## 为什么是"登记真值"，而不是"卡一个下限"或"只查兜底值"
 *
 * 用户给的两个候选都试过一遍，各自的洞：
 *  - **「≥ 某个下限」**：① 下限本身又是一个没有出处的数字（这次栽的就是"抄了一个
 *    没人负责的数字"）；② 它只挡**偏小**，挡不住**偏大** —— 而偏大才是危险方向
 *    （声明 > 真实 ⇒ 压缩永不触发 ⇒ 上下文直接溢出，`isContextOverflow` 也失灵）。
 *    一个被写成 `2000000` 的错值会照样通过。
 *  - **「≠ 262144」**：只挡一个特定的错值。本次四个模型里**有三个根本不是兜底值**
 *    （`262144` / `204800` / `204800` 是当初手抄的臆测值），只查 `262144` 会漏掉三分之二。
 *
 * ⇒ 用**真值登记表**：它是上面两条的**严格超集** ——
 *  ① "每个模型都必须显式声明"由 `contextWindowOf()` 兜（缺了直接 fail，不允许退回兜底）；
 *  ② "抄错"由逐值相等兜（错方向、错值都挡）；
 *  ③ "新增模型忘了登记"由下面的**集合比对**兜；
 *  ④ 来源就写在断言旁边，改值时必须连来源一起改。
 * 另外单独留一条 "≠ 兜底值" 的断言：它挡的重复，但报错信息最直白，值得留着。
 *
 * ⚠️ **查不到就别填**：表里每个数字都必须有可核对的来源。真值存疑时正确的做法是
 * 让 `contextWindowOf()` 红着并把来源查清楚，不是"先填个看起来像的"。
 */
const MODEL_CONTEXT_WINDOWS: readonly (readonly [string, number, string])[] = [
  [
    'deepseek-v4.1-flash',
    1_000_000,
    '用户 2026-10-09 裁定 ①；models.dev 的 opencode-go 页 limit.context=1000000。' +
      '⚠️ 它是**唯一**真正吃到过 pi-ai 兜底的那个 —— 包内 opencode-go.json 里没有这个 id。',
  ],
  [
    'deepseek-v4-pro',
    1_000_000,
    'pi-ai 包内目录 providers/data/opencode-go.json 该模型 contextWindow=1000000' +
      '（`generatedAt 2026-09-05`）；models.dev 的 opencode-go 页同值。',
  ],
  [
    'glm-5.3-flash',
    1_000_000,
    '同 `deepseek-v4-pro`（pi-ai 包内 opencode-go.json + models.dev 的 opencode-go 页）。',
  ],
  ['glm-5.3', 1_000_000, '同 `deepseek-v4-pro`。'],
]

/**
 * 列出 profile 里 `models:` 块下的全部模型 id（按出现顺序）。
 *
 * 为什么需要它：只逐个断言登记表里的模型，就**永远发现不了"有人加了第五个模型但没登记"**——
 * 那条新模型的窗口是什么、有没有留空，没有任何断言看得见。
 * 判据用**缩进**：`- id:` 与 `models:` 的下级同缩进（比 `models:` 深一级）才是模型项；
 * 文件里其它 `- id:`（插件、insert 项）都不在那个块里。
 *
 * @param source - profile 的 `cordis.patch.yml` 全文。
 * @returns 模型 id 列表。
 */
function modelIdsOf(source: string): string[] {
  const lines = source.split('\n')
  const modelsAt = lines.findIndex((line) => line.trim() === 'models:')
  assert.ok(modelsAt >= 0, 'profile 里找不到 `models:` —— provider 的模型清单整段被删了？')
  const entryIndent = (lines[modelsAt] ?? '').search(/\S/) + 2
  const ids: string[] = []
  for (let i = modelsAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') continue
    const indent = line.search(/\S/)
    if (indent < entryIndent) break // 走出 models 块了
    if (indent !== entryIndent) continue // 模型项内的字段 / 注释
    const match = /^- id:\s*(\S+)$/.exec(trimmed)
    assert.ok(
      match !== null,
      `models: 下面第 ${String(i + 1)} 行的缩进像模型项，但不是 \`- id: <模型>\`（结构变了？）`,
    )
    ids.push(match[1] as string)
  }
  return ids
}

test('★★ 守卫：四个 profile 的**每个**模型都显式声明了窗口，且等于登记的真值', () => {
  for (const profile of PROFILES) {
    const source = readFileSync(new URL(`../../../profiles/${profile}/cordis.patch.yml`, import.meta.url), 'utf8')

    // ① 模型集合必须与登记表一致：新增模型不许"悄悄带一个没来源的窗口值"进来
    assert.deepEqual(
      modelIdsOf(source).slice().sort(),
      MODEL_CONTEXT_WINDOWS.map(([id]) => id).slice().sort(),
      `${profile}：profile 里的模型集合与 \`MODEL_CONTEXT_WINDOWS\` 登记表不一致。` +
        '新增/删除模型时**必须一起更新登记表**（并给出可核对的来源）—— ' +
        '否则新模型的 contextWindow 是什么、有没有留空，没有任何断言看得见。',
    )

    for (const [id, expected, note] of MODEL_CONTEXT_WINDOWS) {
      const actual = contextWindowOf(source, id)
      assert.notEqual(
        actual,
        PI_AI_FALLBACK_CONTEXT_WINDOW,
        `${profile}：${id} 的 contextWindow 是 ${String(PI_AI_FALLBACK_CONTEXT_WINDOW)} —— ` +
          '这是 `dsh-llm-pi-ai` 的**通用兜底默认值**，不是任何模型的真值。' +
          '（留空时它也会被兜上来，所以这个数字既可能是"没填"也可能是"抄错了"，两种都不许放过。）',
      )
      assert.equal(
        actual,
        expected,
        `${profile}：${id} 的 contextWindow 应为 ${String(expected)}，实际 ${String(actual)}。\n` +
          `来源：${note}\n` +
          '⚠️ 改这个数**必须同时改登记表里的来源**。声明值 > 真实值 ⇒ 压缩永不触发' +
          '（上下文直接溢出），比声明偏小坏得多 —— 所以查不到可靠来源时**不要填**。',
      )
    }
  }
})
