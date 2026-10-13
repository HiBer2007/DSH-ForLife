/**
 * ★★ 投喂期「工作模式」段的**真宿主**接线守卫。
 *
 * ## 为什么用真 `@deepseek-ai/dsh-system-prompt`
 *
 * 这一段的关键行为全是**宿主的行为**，替身测不出来：
 *  ① 空闲时 `text` 返回空串 ⇒ 宿主到底跳不跳过这一段？（实测：跳过；
 *     但**只含空白**的串会被原样插进提示词 —— 所以必须返回严格空串，本文件钉住这条）；
 *  ② 它在**没投喂时不许改变提示词的任何一个字节**（前缀缓存承诺）。
 *     这条只能靠"装配出来的字节"来判，不能靠"我们没写死内容"来猜；
 *  ③ 投喂期它必须**立刻**出现在提示词里（函数型 section 每轮重算），
 *     而投喂结束（醒来）必须**立刻**回到空闲那一份字节。
 *
 * ## 它守的是哪条缺陷
 *
 * "会话记账写好了、单测全绿、提示段零调用" —— 本项目栽过 19 次的那种。
 * 所以这里不看导出、不看常量，只看**渲染出来的字节**。
 *
 * @module forlife-memory/test/feed-mode-wiring
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { defaultFor } from '@forlife/contracts'
import { beginFeedSession, endFeedSession, FEED_SESSION_KEY } from '@forlife/gateway'

import { resolveConfig } from '../src/config.ts'
import {
  FEED_MODE_NAME,
  FEED_MODE_ORDER,
  L2_NAME,
  L2_ORDER,
  L3_NAME,
  L3_ORDER,
  registerMemorySections,
  registerPromptSections,
  type SystemPromptLike,
} from '../src/prompt.ts'
import { MemoryRuntime } from '../src/runtime.ts'

/** 真实的 system-prompt 插件（进程内加载）。 */
const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as {
  default: unknown
  renderPrompt(assembly: unknown): string
}

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-feed-mode-'))

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
  /** 反注册记忆那三段（L2/L3/投喂模式）—— 用来做"少一段会怎样"的对照。 */
  disposeMemory: () => void
  dispose: () => Promise<void>
}> {
  const root = join(tempRoot, name)
  const ctx = new Context()
  installPlugin(ctx, systemPromptModule.default)
  await delay(120)

  const config = resolveConfig({ storageRoot: root, relativeAges: false })
  const runtime = new MemoryRuntime({ config, dbPath: join(root, 'db', 'forlife.sqlite') })

  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike
  const disposePrompts = registerPromptSections(systemPrompt, runtime, config.promptVariables)
  const disposeSections = registerMemorySections(systemPrompt, runtime)
  let memoryDisposed = false
  const disposeMemory = (): void => {
    if (memoryDisposed) return
    memoryDisposed = true
    disposeSections()
  }
  await delay(30)

  return {
    runtime,
    systemPrompt,
    render: async (): Promise<string> => {
      const assembly = await (systemPrompt as unknown as { assemble(): Promise<unknown> }).assemble()
      return systemPromptModule.renderPrompt(assembly)
    },
    disposeMemory,
    dispose: async (): Promise<void> => {
      disposePrompts()
      disposeMemory()
      runtime.close()
      await delay(20)
    },
  }
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

test('★★ 空闲时：投喂段**不贡献任何一个字节**（真宿主实测，不是推理）', async () => {
  const h = await makeHarness('idle-bytes')
  try {
    const withFeed = await h.render()
    assert.ok(!withFeed.includes(FEED_MODE_NAME), '段名不该出现在文本里（它是注册用的标识）')

    // 对照：把 L2/L3/投喂三段一起反注册，再**手动**只把 L2/L3 注册回去
    //（真宿主会拒绝对同名段的重复注册，所以不能"再注册一次投喂段"来做对照）。
    h.disposeMemory()
    const disposeL2 = h.systemPrompt.section({
      name: L2_NAME,
      order: L2_ORDER,
      text: () => h.runtime.l2Text(),
      interpolate: false,
    })
    const disposeL3 = h.systemPrompt.section({
      name: L3_NAME,
      order: L3_ORDER,
      text: () => h.runtime.renderView().text,
      interpolate: false,
    })
    try {
      const withoutFeed = await h.render()
      assert.equal(
        sha(withoutFeed),
        sha(withFeed),
        '空闲时投喂段必须让字节逐字节一致（空串 ⇒ 宿主整段跳过）；' +
          '只含空白的串会被原样插进去 —— 那会白白作废稳定前缀',
      )
    } finally {
      disposeL2()
      disposeL3()
    }
  } finally {
    await h.dispose()
  }
})

test('★★ 投喂期：这一段真的出现在提示词里（带进度、带来源、占位符全部替换）', async () => {
  const h = await makeHarness('active')
  try {
    const idle = await h.render()
    assert.ok(!idle.includes('半梦半醒'), '没投喂时不该出现框架措辞')

    beginFeedSession(h.runtime.db, { source: 'notes/long.md', as: 'knowledge' })
    const active = await h.render()
    assert.notEqual(sha(active), sha(idle), '投喂期必须改变提示词（否则模型不知道自己半梦半醒）')
    assert.ok(active.includes('半梦半醒'), '框架措辞必须进去（用户口径）')
    assert.ok(active.includes('notes/long.md'), '要报出当前来源（在消化哪一份）')
    assert.ok(active.includes('知识（长期记忆）'), '要报出喂成什么（knowledge/experience 的人话）')
    assert.ok(!active.includes('{{'), `占位符必须全部替换掉：${active.slice(0, 200)}`)
    // 边界必须写出来（"这些是记忆、不是刚发生的事"）—— 这是两条红线里的第一条
    assert.ok(/不是刚刚发生的事/.test(active), '框架必须把「记忆 vs 现在」的边界说出来')

    // 同一会话状态下连续渲染必须逐字节稳定（缓存承诺）
    const again = await h.render()
    assert.equal(sha(again), sha(active), '同一会话状态下必须逐字节稳定')

    // ★ 醒来：结束会话 ⇒ 字节回到空闲那一份
    endFeedSession(h.runtime.db)
    const awake = await h.render()
    assert.equal(sha(awake), sha(idle), '投喂结束 = 醒来：提示词必须逐字节回到空闲那一份')
  } finally {
    await h.dispose()
  }
})

test('★ 进程崩了（会话太旧）⇒ 提示词也回到空闲那一份（不会永远半梦半醒）', async () => {
  const h = await makeHarness('stale')
  try {
    const idle = await h.render()
    const stale = new Date(Date.now() - defaultFor<number>('feed.sessionStaleMs') * 2)
    beginFeedSession(h.runtime.db, { source: 'crashed/run', as: 'experience', now: stale })
    const rendered = await h.render()
    assert.equal(sha(rendered), sha(idle), '陈旧会话必须被当成"没有"（渲染路径只读不写，靠这条判定兜底）')
  } finally {
    await h.dispose()
  }
})

test('★ 段序：投喂段在 L3 之后、工具段之前（不改任何既有编号）', () => {
  assert.ok(FEED_MODE_ORDER > L3_ORDER, '必须排在 L3 之后（L3 是最常变的那段，投喂段排它后面代价最小）')
  assert.ok(FEED_MODE_ORDER <= 499, '必须还在稳定前缀区间内（>499 就是工具/尾部区）')
  assert.equal(FEED_MODE_ORDER, 140, '段序就是 140（写在报告里、也写在 prompt.ts 的注释里）')
  assert.equal(FEED_MODE_NAME, 'forlife:feed-mode')
})

test('★ 数据库里那条会话记录是唯一的跨进程载体（不是内存标志）', async () => {
  const h = await makeHarness('carrier')
  try {
    beginFeedSession(h.runtime.db, { source: 'x', as: 'knowledge' })
    const row = h.runtime.db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(FEED_SESSION_KEY) as
      | { value: string }
      | undefined
    assert.ok(row !== undefined, '会话必须落在 forlife_state 上 —— CLI / gateway 与 DSH 不是同一个进程，内存标志传不过去')
    assert.ok((row?.value ?? '').includes('x'))
  } finally {
    await h.dispose()
  }
})
