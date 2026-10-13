/**
 * ★★★ **工具 schema 必须是英文**（用户 2026-10-11 裁定：「所有的工具、系统提示词需要修改为英文，
 * 以支持所有模型」）。
 *
 * ## 为什么这条守卫是"棘轮"而不是"全绿"
 *
 * §75 收官的是 **`tools.ts`（记忆工具）** —— 于是全仓一度以为"工具已经全英文了"。
 * 而这一轮把**别的 8 个工具模块**也建出来数了一遍：**还有 208 处中文**躺在
 * `description` / `parameters.*.description` / `output.schema.*.description` 里
 * ★ **那三处都会进工具 schema（也就是稳定前缀），每一轮、每个模型都看得见**。
 *
 * ⇒ 一次翻完 208 处不现实（它们分散在 qq/wake/feed/sticker/clock/router/mention 里，
 *   而且每一句都是给模型的说明书，翻错比不翻更糟）。
 * ⇒ **棘轮**：每个模块一个上限，★ **只能往下调**；已经翻完的模块**钉死为 0**（硬断言）。
 *   这样"今天翻了一半"与"明天又漏回来"在测试上**看得出区别**。
 *
 * ## 为什么必须**真的把工具建出来**（而不是读源码）
 *
 * 读源码只能证明"某个字符串不在文件里"，而模型看到的是**编译后的定义对象**：
 * 描述可能来自常量、可能来自拼接、也可能来自另一个模块。
 * ⇒ 这里用**假的 `defineTool`**（原样返回）+ 真的 `MemoryRuntime`，
 *   把每个 `buildXxxTools` 都跑一遍，直接查**定义对象**。
 *
 * ## 一条防"假绿"的纪律
 *
 * 如果某个 `buildXxxTools` 抛异常或返回空数组，计数会**凭空变小** ⇒ 棘轮会"因为没检查而通过"。
 * ⇒ 所以同时断言**每个模块的工具数量**（清单写死在下面）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { buildClockTools } from '../src/clock-tools.ts'
import { buildFeedTools } from '../src/feed-tools.ts'
import { buildMentionTools } from '../src/mention-tools.ts'
import { buildPortTools } from '../src/port-tools.ts'
import { buildQqTools } from '../src/qq-tools.ts'
import { buildRouterTools } from '../src/router-tools.ts'
import { buildStickerTools } from '../src/sticker-tools.ts'
import { buildMemoryTools } from '../src/tools.ts'
import { buildWakeTools } from '../src/wake-tools.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-schema-en-'))
let runtime: MemoryRuntime

before(() => {
  runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: tempRoot, relativeAges: false }),
    dbPath: join(tempRoot, 'db', 'forlife.sqlite'),
  })
})

after(() => {
  runtime?.close()
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // Windows 上库文件可能还开着 —— 留给系统回收
  }
})

/** 假定义器：**原样返回**（我们要看的就是那份定义对象）。 */
const fakeDefineTool = (definition: unknown): unknown => definition

/** 假唤醒宿主（`wake_now` / `register_watcher` 要它，但**建定义**时不会被调用）。 */
const stubWakeHost = { fireNow: async (): Promise<{ decision: string; reason: string }> => ({ decision: 'allow', reason: 'stub' }) }

/**
 * ★ **棘轮**：每个模块的"含中文的 schema 字段数"上限。
 *
 * - `0` = **已翻完**（硬断言，不许再涨）；
 * - 其它数字 = 还没翻完的余量，★ **只能往下调**。
 *
 * | 模块 | 现状 | 说明 |
 * |---|---|---|
 * | memory | 0 | §75 收官 |
 * | port / mention / router | 0 | §78 第 1 批收官（描述 + 返回值都翻了） |
 * | clock / sticker | 0 | §78 第 2 批收官（描述 + 返回值都翻了） |
 * | feed / wake | 0 | §78 第 3 批收官（描述 + 返回值都翻了） |
 * | qq | 0 | §78.10 第 4 批收官（描述 + 返回值都翻了）—— ★ **九个模块全 0** |
 *
 * ★ **本守卫只管 schema**（`description` / `parameters.*` / `output.schema.*`）。
 *   **工具返回值与 `render()` 里的中文是另一个面**（而且有些来自别的包，例如
 *   `switch_model` 被拒时的 `reason` 来自 `@forlife/router` 的 `decideSwitch`、
 *   `schedule_wake` 的校验原因来自 `@forlife/store` 的 `wake-triggers.ts`）
 *   ⇒ 那张清单见 `FIX_PLAN.md` §78.4 / §78.9，别把"这条绿了"读成"工具全英文了"。
 */
const CEILING: Readonly<Record<string, number>> = {
  memory: 0,
  port: 0,
  mention: 0,
  router: 0,
  clock: 0,
  sticker: 0,
  feed: 0,
  wake: 0,
  qq: 0,
}

/** ★ 每个模块的工具数量（防"因为没建出来而通过"的假绿）。 */
const TOOL_COUNT: Readonly<Record<string, number>> = {
  memory: 12,
  port: 3,
  mention: 2,
  router: 3,
  clock: 4,
  sticker: 4,
  feed: 1,
  wake: 5,
  qq: 23,
}

/**
 * ★★ 端口工具**必须给配置**才会被建出来（`port-tools.ts:75`：缺 Caddy/主机名就返回空数组）。
 *
 * 这一条我差点交出去一个**假绿**：第一版只传了两个参数 ⇒ `port` 建出 **0 个工具** ⇒
 * "port 的中文数 = 0" 看起来像"已经翻完了"，其实**是根本没建**。
 * ⇒ 是下面那条 `TOOL_COUNT` 断言把它顶出来的（"数量不对"比"看起来全绿"有用）。
 */
const PORT_OPTIONS = { caddyAdminUrl: 'http://127.0.0.1:2019', publicHost: 'example.test' }

const sets: readonly (readonly [string, () => readonly unknown[]])[] = [
  ['memory', () => buildMemoryTools(fakeDefineTool as never, runtime)],
  ['port', () => buildPortTools(fakeDefineTool as never, runtime, PORT_OPTIONS)],
  ['mention', () => buildMentionTools(fakeDefineTool as never, runtime)],
  ['router', () => buildRouterTools(fakeDefineTool as never, runtime)],
  ['clock', () => buildClockTools(fakeDefineTool as never, runtime)],
  ['sticker', () => buildStickerTools(fakeDefineTool as never, runtime)],
  ['feed', () => buildFeedTools(fakeDefineTool as never, runtime)],
  ['wake', () => buildWakeTools(fakeDefineTool as never, runtime, stubWakeHost as never)],
  ['qq', () => buildQqTools(fakeDefineTool as never, runtime)],
]

const CJK = /[\u4e00-\u9fff]/

/** 收集一个 schema 节点下所有 `description`（含嵌套 properties / items）。 */
function descriptions(node: unknown, path: string, out: [string, string][], depth = 0): void {
  if (node === null || typeof node !== 'object' || depth > 6) return
  const record = node as Record<string, unknown>
  if (typeof record.description === 'string') out.push([path, record.description])
  for (const [key, value] of Object.entries(record)) {
    if (key === 'description') continue
    descriptions(value, `${path}.${key}`, out, depth + 1)
  }
}

/** 一个工具定义里**会进 schema** 的所有文案。 */
function schemaTexts(tool: unknown): [string, string][] {
  const record = tool as { description?: unknown; parameters?: unknown; output?: { schema?: unknown } }
  const out: [string, string][] = []
  if (typeof record.description === 'string') out.push(['description', record.description])
  descriptions(record.parameters ?? {}, 'parameters', out)
  descriptions(record.output?.schema ?? {}, 'output.schema', out)
  return out
}

test('★★★ 工具 schema 的**英文棘轮**（含中文的字段数不得超过上限）', () => {
  const report: string[] = []
  /**
   * ★★ **按"归属模块"去重**（2026-10-11 第 2 批发现的度量缺陷）：
   *
   *   `buildQqTools` 内部 **spread 了** `buildStickerTools` + `buildMentionTools`
   *   （`qq-tools.ts:1456`）⇒ 同一批工具会在两个模块里**各数一遍**：
   *   翻一个 sticker 字段，`qq` 的读数也会跟着掉。
   *   ⇒ 那会让"还剩多少"这个数**说不清是谁的**（我第一版就是那么写进 §78 的，已更正）。
   *
   *   规则：**一个工具只归"第一个建出它的模块"**（`sets` 的顺序即归属优先级，
   *   sticker/mention 都排在 qq 前面）⇒ 每个模块的数字是**它自己的**。
   */
  const claimed = new Set<string>()
  for (const [label, build] of sets) {
    const tools = build()
    // ① 先钉住"真的建出来了" —— 否则下面的计数会因为没东西可数而通过
    assert.equal(
      tools.length,
      TOOL_COUNT[label],
      `**${label} 的工具数量变了**（${String(tools.length)} ≠ ${String(TOOL_COUNT[label])}）—— ` +
        '要么是新加了工具（把清单改掉），要么是构建失败被吞了（那是假绿）',
    )
    // ② 再数中文（**只数本模块自己的工具**，见上面那段说明）
    let count = 0
    let borrowed = 0
    const samples: string[] = []
    for (const tool of tools) {
      const name = (tool as { name?: string }).name ?? '(无名)'
      if (claimed.has(name)) {
        borrowed += 1
        continue
      }
      claimed.add(name)
      for (const [path, text] of schemaTexts(tool)) {
        if (!CJK.test(text)) continue
        count += 1
        samples.push(`${name}.${path}`)
      }
    }
    const ceiling = CEILING[label] ?? 0
    report.push(
      `${label.padEnd(8)} ${String(count).padStart(3)} / 上限 ${String(ceiling).padStart(3)}` +
        (borrowed > 0 ? `  （另有 ${String(borrowed)} 个工具属于别的模块，不在这里数）` : ''),
    )
    assert.ok(
      count <= ceiling,
      `**${label} 的 schema 中文数涨了**：${String(count)} > 上限 ${String(ceiling)}\n` +
        `  （★ 这个上限只能往下调 —— 见本文件模块头的"棘轮"说明）\n  前几处：${samples.slice(0, 8).join(', ')}`,
    )
    if (ceiling > 0) {
      assert.ok(
        count > 0 || ceiling === count,
        `${label}：上限还写着 ${String(ceiling)}，但实际已经 0 了 ⇒ ★ **把 CEILING 改成 0**（棘轮要往下压）`,
      )
    }
  }
  // 全部工具都被认领过一遍（防"某个模块根本没进 sets"这类静默）
  //
  // ★ 是 **51** 而不是各模块之和 57：`buildQqTools` 内部 spread 了 sticker(4) + mention(2)
  //   ⇒ 那 6 个工具**被两个构建器各返回一次**（这正是上面那段"去重"要处理的事）。
  assert.equal(claimed.size, 51, '51 个**不重复**的工具应当全都被某个模块认领（少了说明构建器漏跑）')
  // 把读数打出来（人要看的是"还剩多少"，不是一个布尔）
  console.log(`\n  工具 schema 英文棘轮：\n    ${report.join('\n    ')}\n`)
})

test('★★★ 已收官的**九个**模块（memory / port / mention / router / clock / sticker / feed / wake / qq）**一处中文都不许有**', () => {
  for (const label of ['memory', 'port', 'mention', 'router', 'clock', 'sticker', 'feed', 'wake', 'qq'] as const) {
    const build = sets.find(([name]) => name === label)?.[1]
    assert.ok(build !== undefined, `${label} 的构建器必须在清单里`)
    const offenders: string[] = []
    for (const tool of build()) {
      const name = (tool as { name?: string }).name ?? '(无名)'
      for (const [path, text] of schemaTexts(tool)) {
        if (CJK.test(text)) offenders.push(`${name}.${path}: ${text.slice(0, 60)}`)
      }
    }
    assert.deepEqual(offenders, [], `**${label} 的 schema 必须全英文**（已收官，不许回退）`)
  }
})

test('★ 工具名一律 ASCII（中文名会让模型与宿主都难处理）', () => {
  const offenders: string[] = []
  for (const [label, build] of sets) {
    for (const tool of build()) {
      const name = (tool as { name?: string }).name ?? ''
      if (!/^[a-z][a-z0-9_]*$/.test(name)) offenders.push(`${label}:${name}`)
    }
  }
  assert.deepEqual(offenders, [], '工具名必须是 `^[a-z][a-z0-9_]*$`')
})
