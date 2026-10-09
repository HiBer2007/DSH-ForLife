/**
 * ★★ 「你的主动性」段的**真宿主**接线守卫。
 *
 * ## 为什么用真 `@deepseek-ai/dsh-system-prompt`
 *
 * 这一段的关键行为全是**宿主的行为**，替身测不出来：
 *  ① 宿主对 `interpolate: false` 的段是**原样透传**，对 `{{…}}` 是**抛错**
 *     （抛错 = 模型完全没有系统提示词）—— 所以"这一段能不能安然装出来"必须实测；
 *  ② 它是**静态文本**（来自基线 `prompt.proactivity`），渲染两次必须逐字节一致 ——
 *     这是前缀缓存的承诺，而"我们没写动态内容"只是意图，字节才是事实；
 *  ③ 它必须真的**出现在装配出来的提示词里**，且**位置对**（在 P2 之后、L2 之前）。
 *
 * ## 它守的是哪条缺陷
 *
 * "库代码写好了、单测全绿、生产路径零调用" —— 本项目栽过 20+ 次的那种。
 * 提示段是这类问题的高发区（注册了但没生效：宿主对 `interpolate`、**空串**、`order` 都有讲究）。
 * 所以这里不看导出、不看常量，只看**渲染出来的字节**，并且是**从 `apply()` 走生产路径**
 * 之后再看（另一条守卫 `wiring.test.ts` 断言注册表；这一条断言字节）。
 *
 * @module forlife-memory/test/proactivity-wiring
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { defaultFor } from '@forlife/contracts'

import { resolveConfig } from '../src/config.ts'
import { seedDefaultPrompts } from '../src/prompt-store.ts'
import {
  FEED_MODE_NAME,
  FEED_MODE_ORDER,
  L2_NAME,
  L2_ORDER,
  L3_NAME,
  L3_ORDER,
  P1_NAME,
  P1_ORDER,
  P2_NAME,
  P2_ORDER,
  PROACTIVITY_NAME,
  PROACTIVITY_ORDER,
  registerMemorySections,
  registerProactivitySection,
  registerPromptSections,
  type SystemPromptLike,
} from '../src/prompt.ts'
import { MemoryRuntime } from '../src/runtime.ts'

/** 真实的 system-prompt 插件（进程内加载）。 */
const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as {
  default: unknown
  renderPrompt(assembly: unknown): string
}

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-proactivity-'))

after(async () => {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

function installPlugin(target: Context, pluginModule: unknown): void {
  const install = target.plugin as unknown as (p: unknown) => unknown
  install.call(target, pluginModule)
}

/** 真宿主 + 真运行时（真库）。`render` 走宿主的 assemble + renderPrompt。 */
async function makeHarness(name: string): Promise<{
  runtime: MemoryRuntime
  systemPrompt: SystemPromptLike
  render: () => Promise<string>
  /** 只反注册「主动性」段（用来做"少一段会怎样"的对照）。 */
  disposeProactivity: () => void
  dispose: () => Promise<void>
}> {
  const root = join(tempRoot, name)
  const ctx = new Context()
  installPlugin(ctx, systemPromptModule.default)
  await delay(120)

  const config = resolveConfig({ storageRoot: root, relativeAges: false })
  const runtime = new MemoryRuntime({ config, dbPath: join(root, 'db', 'forlife.sqlite') })
  // P1/P2 的文本来自 `prompt_revisions`（生产里由 `apply()` 播种，见 index.ts）。
  // 这里必须照做 —— 否则 P1/P2 是空段（宿主会整段跳过），
  // "主动性段排在 P2 之后"这条位置断言就变成了一句空话。
  seedDefaultPrompts(runtime.db)

  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike
  const disposePrompts = registerPromptSections(systemPrompt, runtime, config.promptVariables)
  const disposeAgency = registerProactivitySection(systemPrompt)
  const disposeSections = registerMemorySections(systemPrompt, runtime)
  let agencyDisposed = false
  const disposeProactivity = (): void => {
    if (agencyDisposed) return
    agencyDisposed = true
    disposeAgency()
  }
  await delay(30)

  return {
    runtime,
    systemPrompt,
    render: async (): Promise<string> => {
      const assembly = await (systemPrompt as unknown as { assemble(): Promise<unknown> }).assemble()
      return systemPromptModule.renderPrompt(assembly)
    },
    disposeProactivity,
    dispose: async (): Promise<void> => {
      disposePrompts()
      disposeProactivity()
      disposeSections()
      runtime.close()
      await delay(20)
    },
  }
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

test('★★ 真宿主：这一段真的进了提示词（用户点名的三样都在，且占位符一个不剩）', async () => {
  const h = await makeHarness('present')
  try {
    const rendered = await h.render()

    // 段名是注册用的标识，不该出现在正文里
    assert.ok(!rendered.includes(PROACTIVITY_NAME), '段名不该出现在文本里（它是注册用的标识）')

    // ① 标题必须能被人一眼找到
    assert.ok(rendered.includes('你的主动性'), '标题必须在（用户点名的"主动性"）')
    // ② 主动发消息
    assert.ok(rendered.includes('主动发消息'), '必须讲"可以主动发消息"')
    assert.ok(rendered.includes('qq_reply'), '要给出工具名（否则模型不知道拿什么发）')
    assert.ok(rendered.includes('read_pending'), '要带上"发送前先取回上下文"这条硬要求')
    // ③ 提问题
    assert.ok(rendered.includes('提问题'), '必须讲"可以提问题"')
    assert.ok(/我不知道/.test(rendered), '要明确允许说"我不知道"')
    assert.ok(/要求澄清|反问/.test(rendered), '要明确允许反问/要求澄清')
    // ④ 唤醒自己
    assert.ok(rendered.includes('唤醒自己'), '必须讲"可以唤醒自己"')
    for (const tool of ['schedule_wake', 'list_wakes', 'cancel_wake', 'wake_now', 'register_watcher']) {
      assert.ok(rendered.includes(tool), `要给出唤醒工具名：${tool}`)
    }
    // ⑤ 边界（这条最重要）：该/不该 + "可以主动不等于必须主动"
    assert.ok(rendered.includes('可以主动') && rendered.includes('必须主动'), '必须写出"可以主动 ≠ 必须主动"')
    assert.ok(rendered.includes('拿不准就不发'), '必须给出不确定时的默认动作：不发')
    assert.ok(/不该\*{0,2}主动发|不该主动/m.test(rendered), '必须写清"什么时候不该主动"')

    // ⑥ 不许留下没被替换的占位符：这一段是 interpolate:false，
    //    所以它里面的任何 `{{…}}` 都会**原样发到模型面前**（那等于告诉模型一个不存在的变量）
    assert.ok(!rendered.includes('{{'), `文案里不许有未替换的占位符：${rendered.slice(0, 200)}`)
  } finally {
    await h.dispose()
  }
})

test('★★ 位置契约：P2 之后、L2 之前（真渲染出来的字节顺序，不是常量推理）', async () => {
  const h = await makeHarness('position')
  try {
    const rendered = await h.render()
    const p2 = rendered.indexOf('## 说话方式') // P2 默认文案的标题
    const agency = rendered.indexOf('## 你的主动性')
    const l2 = rendered.indexOf('=== 长期记忆 ===') // L2 默认文案的标题
    assert.ok(p2 >= 0, 'P2 段必须在（否则位置断言没有意义）')
    assert.ok(agency >= 0, '「主动性」段必须在')
    assert.ok(l2 >= 0, 'L2 段必须在')
    assert.ok(p2 < agency, `「主动性」段必须排在 P2 之后（P2@${String(p2)} 主动性@${String(agency)}）`)
    assert.ok(agency < l2, `「主动性」段必须排在 L2 之前（主动性@${String(agency)} L2@${String(l2)}）`)

    // 常量与渲染位置必须说的是同一件事
    assert.ok(PROACTIVITY_ORDER > P2_ORDER && PROACTIVITY_ORDER < L2_ORDER)
    assert.equal(PROACTIVITY_ORDER, 115, '段序就是 115（写在报告里、也写在 prompt.ts 的注释与基线文档里）')
    assert.equal(PROACTIVITY_NAME, 'forlife:proactivity')
  } finally {
    await h.dispose()
  }
})

test('★★ 前缀缓存承诺：静态段连续渲染必须逐字节一致（幂等）', async () => {
  const h = await makeHarness('stable')
  try {
    const first = await h.render()
    const second = await h.render()
    assert.equal(sha(second), sha(first), '同一状态下连续装配必须逐字节一致 —— 否则前缀缓存永远不命中')

    // 写入一次中期记忆（L3 会变）之后，**这一段本身**必须一个字节都没变
    h.runtime.append({ summary: '缓存契约验证用的一条记忆', sourceScope: 'onebot11:1' })
    const afterWrite = await h.render()
    assert.notEqual(sha(afterWrite), sha(first), 'L3 记忆变了，整份提示词应该跟着变（对照组）')
    const slice = (text: string): string => {
      const start = text.indexOf('## 你的主动性')
      const end = text.indexOf('=== 长期记忆 ===')
      return text.slice(start, end)
    }
    assert.equal(slice(afterWrite), slice(first), '「主动性」段自己必须逐字节不变（它没有动态内容）')
  } finally {
    await h.dispose()
  }
})

test('★★ 对照：反注册这一段 ⇒ 提示词里它**真的消失**（而不是"注册了但没人用"）', async () => {
  const h = await makeHarness('control')
  try {
    const withSection = await h.render()
    assert.ok(withSection.includes('## 你的主动性'), '前置条件：这一段本来在')

    h.disposeProactivity()
    const withoutSection = await h.render()
    assert.ok(!withoutSection.includes('## 你的主动性'), '反注册后它必须从提示词里消失（证明前面看到的字节真的是它贡献的）')
    // **字节级**：宿主按 `\n\n` 拼接段，拿走中间一段 ⇒ 差恰好是"这段文本 + 一个分隔符"。
    // 这一条比"长度差不多"强得多：它同时钉住了"文本原样（没被插值改写）"与"只少了这一段"。
    assert.equal(
      withSection.length - withoutSection.length,
      defaultFor<string>('prompt.proactivity').length + 2,
      '反注册那一段后，字节差必须**恰好**是它的文本长度 + 一个 "\\n\\n" 分隔符',
    )
    // 别的东西不许被牵连（反注册只该拿掉这一段）
    assert.ok(withoutSection.includes('## 说话方式'), 'P2 还在')
    assert.ok(withoutSection.includes('=== 长期记忆 ==='), 'L2 还在')
  } finally {
    await h.dispose()
  }
})

test('★ 文案来自基线（改口径改 JSON，不用改代码）——而且是**非空**的', () => {
  const text = defaultFor<string>('prompt.proactivity')
  assert.ok(typeof text === 'string' && text.trim().length > 200, `基线文案太短或不是字符串：${typeof text}`)
  assert.ok(text.startsWith('## 你的主动性'), '基线文案的标题就是段落的标题（人一眼能对上）')
  // 这一段是"能力说明"：工具名必须写全，否则模型只知道自己"可以主动"却不知道拿什么做
  for (const tool of ['qq_reply', 'qq_react', 'qq_typing', 'read_pending', 'schedule_wake', 'register_watcher', 'list_wakes', 'cancel_wake', 'wake_now']) {
    assert.ok(text.includes(tool), `基线文案里缺少工具名：${tool}`)
  }
  // 边界三件套（用户点名最重要的那部分）
  assert.ok(text.includes('拿不准就不发'), '不确定时的默认动作必须写出来')
  assert.ok(text.includes('有代价'), '"主动打扰有代价"必须写出来（否则"可以主动"会被读成"随时打扰"）')
})

test('★ 生产路径：`apply` 必须真的注册它，且启动日志那行清单不许漏（源码级守卫）', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // ① 注册调用本身（拆掉它 ⇒ wiring.test.ts 也会红，两条各守一层）
  assert.match(
    source,
    /disposers\.push\(registerProactivitySection\(systemPrompt\)\)/,
    '`apply()` 里必须真的注册这一段 —— 只导出函数不算接线（本项目栽过 20+ 次"库写好了、生产零调用"）',
  )
  // ② 启动日志里那一行清单必须与 prompt.ts 的六段一一对应
  //    （index.ts 的注释写着"少写一个就是日志撒谎"，所以这条由测试钉住）
  const listMatch = /已注册提示段([\s\S]*?)\n\s*\)/.exec(source)
  assert.ok(listMatch !== null, '找不到启动日志里的提示段清单')
  const line = listMatch[1] ?? ''
  const pairs: readonly (readonly [string, number])[] = [
    [P1_NAME, P1_ORDER],
    [P2_NAME, P2_ORDER],
    [PROACTIVITY_NAME, PROACTIVITY_ORDER],
    [L2_NAME, L2_ORDER],
    [L3_NAME, L3_ORDER],
    [FEED_MODE_NAME, FEED_MODE_ORDER],
  ]
  for (const [name, order] of pairs) {
    assert.ok(line.includes(`${name}(${String(order)}`), `启动日志清单里必须写出 ${name}(${String(order)})（否则日志与实际不符）`)
  }
})
