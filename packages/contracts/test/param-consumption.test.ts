/**
 * 「doc 参数到底有没有消费者」守卫 —— 补 `fidelity.test.ts` 的**自指盲区**。
 *
 * ## 为什么需要这一条（2026-10-06 实测）
 *
 * `fidelity.test.ts` 的核心断言是 `defaultFor(key) === baselineValue(key)`，
 * 而两边读的是**同一个** `plan-baseline.json` —— 也就是「JSON 对自己」。
 * 它拦不住两类最贵的问题：
 *
 *  1. **参数没有消费者**：基线里写着 0.5，代码从不读它，真正生效的是**别的数字**。
 *     实例：`compaction.autoTriggerRatio`（PLAN §4.2 Step 1 / §12.1 = 50%）曾经在源码里
 *     **零引用**，实际生效阈值来自宿主 `dsh-compaction-basic` 的
 *     `DEFAULT_THRESHOLD_RATIO = 0.8`（四个 profile 也没覆盖）—— 而 fidelity **全绿**，
 *     因为它看不见 `node_modules` 里的第三份数字。
 *  2. **部署里真正生效的值**：那要把「插件缺省 × profile 覆盖 × 宿主缺省」一起看。
 *     这份由 `packages/dsh-component/test/compaction-threshold.test.ts` 守
 *     （真机 `new ForlifeCompactionEngine(ctx, {})` 之后断言生效阈值）。
 *
 * ## 这一条怎么判"有消费者"
 *
 * 扫**非测试源码**（`packages/<包>/src` + `profiles/` + `scripts/`，跳过 `test/`），
 * 看是否出现该参数的**完整点分键**（本仓风格是 `defaultFor<number>('compaction.minTokens')`；
 * 全仓没有任何生产代码用 `defaultsWithPrefix`/`allDefaults` 间接取值，所以"全键字面量"
 * 是一个可靠的消费判据）。
 *
 * 刻意**排除** `packages/contracts/src/deviations.ts` 与 `plan-baseline.json`：
 * 它们是「偏离登记 / 基线」本身，不是消费者。不排除的话这条测试会**自己满足自己** ——
 * 第一版扫描就踩了这个坑（把 `plan-baseline.json` 算进扫描范围 ⇒ 零消费参数 0 个，全绿），
 * 和它要拦的 bug 一模一样。本文件因此专门有一条元测试守着扫描口径。
 *
 * ## 判定方式（为什么是"清单外不许新增"而不是"必须为零"）
 *
 * 已知的零消费参数写进 `KNOWN_UNCONSUMED`（每条标了现状）。断言的是
 * **不出现清单之外的零消费参数**：
 *  - 别的子代理把某个参数**接上了** ⇒ 清单里少一条，不会误报；
 *  - 谁往基线里加了一个"只写进 JSON、代码根本不用"的参数 ⇒ **立刻变红**（正是 D 类问题）。
 *
 * @module @forlife/contracts/test/param-consumption
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { baselineKeys, baselineOrigin } from '../src/baseline.ts'

/** 仓库根（本文件在 packages/contracts/test/ 下）。 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** 扫描时跳过的目录：依赖、运行时数据、**测试**（测试里的引用不算消费者）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', 'research', 'dist', 'test', 'tests'])

/** 不参与扫描的文件：登记表/基线本身（见文件头的"自指"说明）。 */
const NOT_A_CONSUMER = new Set(['deviations.ts', 'plan-baseline.json'])

/**
 * 已知的零消费参数（**不是白名单式的许可，而是现状清单**）。
 *
 * 每一条都在 `docs/audit/PLAN_FIDELITY_AUDIT.md` 的 ❌/❓ 清单里有对应条目。
 * 谁把它们接上了，这里就会少一条（测试不会因此变红）。
 */
const KNOWN_UNCONSUMED = new Set<string>([
  // 中期区独立预算（active 80–85% + 碎片 15–20%，PLAN §5.3）——渲染侧尚未按预算裁剪
  'fragment.activeBudgetRatioMin',
  'fragment.activeBudgetRatioMax',
  // §7.5/§7.6 逃生通道 request_recall_extension 已实现（基线键已被 requestRecallExtension 消费，已移出本清单）
  // §7.4 重复查询检测（>0.9 → duplicate_query）已实现（`recall.duplicateSimilarity` 已被 runtime 消费，已移出本清单）
  // §7.4 联想深度提示（同轮 ≥3 次）已实现（`recall.associativeDepthWarn` 已被 runtime 消费，已移出本清单）
  // （三条的接线守卫在 `packages/dsh-component/test/recall-guardrails-wiring.test.ts` /
  //   `recall-budget-recover-wiring.test.ts`）
  // 路由二阶段（评分模型/预评分开关/批量/延迟预算/定时复核）——部分参数尚未接线
  'router.minimum.quantization',
  'router.minimum.resident',
  'router.confidence.high',
  'router.guards.targetInterceptMin',
  'router.guards.targetInterceptMax',
  'router.preScore.enabled',
  'router.batch.enabled',
  'router.latencyBudgetMs',
  'router.review.intervalHours',
])

/** 递归收集"算消费者"的源码文件（一次扫描，多条断言复用）。 */
function collectSources(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || NOT_A_CONSUMER.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      collectSources(path, out)
      continue
    }
    if (/\.(ts|mjs|js|yml|yaml)$/.test(name)) out.push(path)
  }
  return out
}

/** 全部扫描点：`packages/<包>/src` + `profiles/` + `scripts/`。 */
function scanTargets(): readonly string[] {
  const files: string[] = []
  for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
    const src = join(REPO_ROOT, 'packages', pkg, 'src')
    try {
      if (statSync(src).isDirectory()) collectSources(src, files)
    } catch {
      // 没有 src 的包（例如纯前端包）直接跳过
    }
  }
  collectSources(join(REPO_ROOT, 'profiles'), files)
  collectSources(join(REPO_ROOT, 'scripts'), files)
  return files
}

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**，所以 `'https://…'` 不会被误伤）。
 *
 * 为什么必须去注释：第一版扫描直接 `text.includes(key)`，于是
 * `compaction-engine.ts` 里那句**注释**「唯一真源是 `compaction.autoTriggerRatio`」
 * 就被算成了"消费者" —— 把代码改成硬编码 `0.5` 之后测试**依然全绿**。
 * 那正是这条测试要拦的假绿：**注释不是消费者**。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 一份源码里是否**真的**（非注释地）引用了某个基线键。 */
function hasConsumption(source: string, key: string): boolean {
  return stripComments(source).includes(key)
}

test('★★ 消费点：doc 参数必须在**非测试源码**里被引用（不许只活在 JSON 里）', () => {
  const files = scanTargets()
  assert.ok(
    files.length > 100,
    `扫描到的源码只有 ${String(files.length)} 个 —— 扫描范围可能写错了（REPO_ROOT=${REPO_ROOT}）`,
  )
  const texts = files.map((file) => stripComments(readFileSync(file, 'utf8')))
  const unconsumed = baselineKeys().filter(
    (key) => baselineOrigin(key) === 'doc' && !texts.some((text) => text.includes(key)),
  )
  const unexpected = unconsumed.filter((key) => !KNOWN_UNCONSUMED.has(key))
  assert.deepEqual(
    unexpected,
    [],
    '以下 **doc 来源参数在非测试源码里没有任何引用** —— 它们只写在 plan-baseline.json 里，' +
      '代码（和 profile）都不会用到，部署里的实际取值必然来自别处：\n' +
      unexpected.map((key) => `  - ${key}`).join('\n') +
      '\n修法二选一：① 在真正的消费点用 `defaultFor(...)`/显式配置把它接上；' +
      '② 若确实暂不实现，把它登记进本文件的 `KNOWN_UNCONSUMED` 并说明现状（同时建议登记进 deviations.ts）。',
  )
})

test('★ 扫描口径元测试②：**注释里的键不算消费者**（第一版就栽在这）', () => {
  const key = 'compaction.autoTriggerRatio'
  assert.equal(hasConsumption(`// 见 ${key} 的说明`, key), false, '行注释不算')
  assert.equal(hasConsumption(`/* 见 ${key} */`, key), false, '块注释不算')
  assert.equal(hasConsumption(`const ratio = 0.5 // 对应 '${key}'`, key), false, '行尾注释不算')
  assert.equal(
    hasConsumption(`const ratio = defaultFor<number>('${key}')`, key),
    true,
    '真正的引用（在字符串里传给 defaultFor）必须算',
  )
  assert.equal(
    hasConsumption(`baseURL: 'https://opencode.ai/zen/go/v1', ratio: defaultFor('${key}')`, key),
    true,
    "URL 里的 // 不能把后面真正的引用一起吃掉",
  )
})

test('★ 扫描口径元测试：基线 JSON 与 deviations.ts 不算"消费者"，测试也不算', () => {
  const files = scanTargets()
  for (const file of files) {
    assert.ok(!file.endsWith('plan-baseline.json'), 'plan-baseline.json 不能算消费者（否则测试自己满足自己）')
    assert.ok(!file.endsWith(`${sep}deviations.ts`), 'deviations.ts 是登记表，不是消费者')
    assert.ok(!file.includes(`${sep}test${sep}`), `测试不算消费者：${file}`)
    assert.ok(!file.includes(`${sep}node_modules${sep}`), `依赖不算消费者：${file}`)
  }
})

test('KNOWN_UNCONSUMED 里的键必须真实存在，且都是 doc 来源', () => {
  const keys = new Set(baselineKeys())
  for (const key of KNOWN_UNCONSUMED) {
    assert.ok(keys.has(key), `KNOWN_UNCONSUMED 里有基线中不存在的键（拼写漂移？）：${key}`)
    assert.equal(baselineOrigin(key), 'doc', `${key} 不是 doc 来源，不该出现在这张清单里`)
  }
})
