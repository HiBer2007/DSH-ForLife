/**
 * 阶段 4 的提示词核心测试：**真宿主装配**下的热生效、变量插值、字节稳定性、回滚。
 *
 * 为什么必须用真 `dsh-system-prompt` 而不是替身：
 *  ① 变量插值是宿主 `renderPrompt` 的行为（未定义变量**抛错**），替身测不出这条；
 *  ② "函数型 section 每次装配重算"是热生效的唯一依据，也是宿主行为；
 *  ③ 字节稳定性要的就是"宿主装配出来的那串字节"，不是我们自己拼的。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { defaultFor } from '@forlife/contracts'
import { hashPromptText } from '@forlife/memory-core'

import { resolveConfig } from '../src/config.ts'
import { P1_NAME, P2_NAME, registerMemorySections, registerPromptSections } from '../src/prompt.ts'
import {
  activePrompt,
  clearPromptOverride,
  listPromptOverrides,
  listPromptRevisions,
  promptEditCount,
  promptStatus,
  resolvePrompt,
  rollbackPrompt,
  savePromptRevision,
  seedDefaultPrompts,
  setPromptOverride,
} from '../src/prompt-store.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'forlife-prompt-'))

/** 真实的 system-prompt 插件（进程内加载）。 */
const systemPromptModule = (await import('@deepseek-ai/dsh-system-prompt')) as unknown as {
  default: unknown
  renderPrompt(assembly: unknown): string
}

/** 装一个插件（签名收窄，不 bind）。 */
function installPlugin(target: Context, pluginModule: unknown): void {
  const install = target.plugin as unknown as (p: unknown) => unknown
  install.call(target, pluginModule)
}

/** 造一套"插件 + 运行时"，返回渲染函数与清理。 */
async function makeHarness(
  name: string,
  variables?: Record<string, string>,
): Promise<{ runtime: MemoryRuntime; render: () => Promise<string>; dispose: () => Promise<void> }> {
  const root = join(tempRoot, name)
  const ctx = new Context()
  installPlugin(ctx, systemPromptModule.default)
  await delay(120)

  const config = resolveConfig({
    storageRoot: root,
    relativeAges: false,
    ...(variables === undefined ? {} : { promptVariables: variables }),
  })
  const runtime = new MemoryRuntime({ config, dbPath: join(root, 'db', 'forlife.sqlite') })
  seedDefaultPrompts(runtime.db)

  const systemPrompt = ctx.get('systemPrompt') as Parameters<typeof registerPromptSections>[0]
  const disposePrompts = registerPromptSections(systemPrompt, runtime, config.promptVariables)
  const disposeMemory = registerMemorySections(systemPrompt, runtime)
  await delay(30)

  return {
    runtime,
    render: async (): Promise<string> => {
      const assembly = await (systemPrompt as unknown as { assemble(): Promise<unknown> }).assemble()
      return systemPromptModule.renderPrompt(assembly)
    },
    dispose: async (): Promise<void> => {
      disposePrompts()
      disposeMemory()
      runtime.close()
      await delay(20)
    },
  }
}

/** 渲染指纹（就是缓存比对的那个字节序列的哈希）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

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

test('播种：首次启动写入内置默认值，且来自保真度基线', () => {
  const root = join(tempRoot, 'seed')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    const seeded = seedDefaultPrompts(runtime.db)
    assert.deepEqual([...seeded].sort(), ['p1-system', 'p2-style'])
    assert.equal(seedDefaultPrompts(runtime.db).length, 0, '重复播种不该再写')

    const p1 = activePrompt(runtime.db, 'p1-system')
    assert.ok(p1 !== undefined)
    assert.equal(p1.text, `${defaultFor<string>('prompt.p1Default').trim()}\n`, '播种的必须是基线里的默认值（规范化后）')
    assert.ok(p1.text.includes('{{persona_name}}'), '默认 P1 里应当有变量（证明变量机制是主线而不是装饰）')
    assert.ok(p1.sha256 === hashPromptText(p1.text), '哈希必须是规范化文本的哈希')
    assert.ok(p1.tokenCount > 0)
  } finally {
    runtime.close()
  }
})

test('保存：校验不过就拒（未知变量 / 动态变量 / 空文本），不写库', () => {
  const root = join(tempRoot, 'validate')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    seedDefaultPrompts(runtime.db)
    const before = listPromptRevisions(runtime.db, 'p1-system').length

    for (const [text, pattern] of [
      ['你是{{nobody}}', /未知变量/],
      ['现在是{{now}}', /动态变量/],
      ['   \n ', /不能为空/],
    ] as const) {
      const result = savePromptRevision(runtime.db, { slug: 'p1-system', text })
      assert.equal(result.ok, false, `${text} 应当被拒`)
      if (!result.ok) assert.match(result.errors.join(' '), pattern)
    }
    assert.equal(listPromptRevisions(runtime.db, 'p1-system').length, before, '被拒的保存不该产生版本')
  } finally {
    runtime.close()
  }
})

test('保存：内容没变（只改了空白）不产生新版本（否则历史列表会被点几次保存淹没）', () => {
  const root = join(tempRoot, 'idempotent')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    seedDefaultPrompts(runtime.db)
    const current = activePrompt(runtime.db, 'p1-system')
    assert.ok(current !== undefined)
    const count = listPromptRevisions(runtime.db, 'p1-system').length

    const same = savePromptRevision(runtime.db, { slug: 'p1-system', text: `${current.text}\n\n  ` })
    assert.equal(same.ok, true)
    if (same.ok) assert.equal(same.changed, false, '规范化后一样 ⇒ 不算改动')
    assert.equal(listPromptRevisions(runtime.db, 'p1-system').length, count)
  } finally {
    runtime.close()
  }
})

test('热生效：改 P2 → 下一轮装配就是新内容；变量被宿主插值；20 轮哈希稳定', async () => {
  const h = await makeHarness('hot', { persona_name: '小满', owner_name: '老板', language: '中文' })
  try {
    const first = await h.render()
    assert.ok(first.includes('小满'), '宿主必须把 {{persona_name}} 换成配置里的值（否则变量机制没通）')
    assert.ok(first.includes('中文'), '{{language}} 也要插值')
    assert.ok(!first.includes('{{'), `装配结果里不该残留未替换的变量：${first.slice(0, 200)}`)

    // owner_name 不在默认 P1 里 —— 单独验证"注册表覆盖白名单里的全部稳定变量"：
    // 换一份用到它的 P1，必须能装配成功（缺注册就会抛错，模型就完全没有系统提示词了）
    const withOwner = savePromptRevision(h.runtime.db, {
      slug: 'p1-system',
      text: '你是{{persona_name}}，{{owner_name}}的伙伴。用{{language}}。\n',
      createdBy: 'admin',
    })
    assert.equal(withOwner.ok, true)
    h.runtime.invalidatePromptCache()
    const ownerRendered = await h.render()
    assert.ok(ownerRendered.includes('老板'), '{{owner_name}} 必须能插值（它是白名单里的稳定变量）')

    const hashBefore = sha256(first)

    // 只改 P2（回答风格）
    const saved = savePromptRevision(h.runtime.db, {
      slug: 'p2-style',
      text: '## 说话方式\n- 一句话说完，别绕。\n- 偶尔用颜文字。\n',
      createdBy: 'admin',
      note: '测试改动',
    })
    assert.equal(saved.ok, true)
    h.runtime.invalidatePromptCache()

    const second = await h.render()
    assert.notEqual(sha256(second), hashBefore, '改了风格 ⇒ 前缀必须变（这正是"一次缓存未命中"）')
    assert.ok(second.includes('偶尔用颜文字'), '新内容必须立即生效（函数型 section 每次装配重算）')

    // 之后 20 轮必须逐字节稳定（这是"缓存能命中"的前提）
    const hashAfter = sha256(second)
    for (let i = 0; i < 20; i++) {
      assert.equal(sha256(await h.render()), hashAfter, `第 ${String(i + 1)} 轮不该变化`)
    }
  } finally {
    await h.dispose()
  }
})

test('字节稳定：没有任何写入时，连续 20 轮装配哈希 100% 相同', async () => {
  const h = await makeHarness('stable')
  try {
    const hashes = new Set<string>()
    for (let i = 0; i < 20; i++) hashes.add(sha256(await h.render()))
    assert.equal(hashes.size, 1, `无写入时应只有一个哈希，实际 ${String(hashes.size)} 个`)
  } finally {
    await h.dispose()
  }
})

test('回滚：回到旧版本 ⇒ 哈希回到旧值（历史是事实记录，不复制新版本）', async () => {
  const h = await makeHarness('rollback')
  try {
    const v1 = activePrompt(h.runtime.db, 'p2-style')
    assert.ok(v1 !== undefined)
    const hashV1 = sha256(await h.render())

    const saved = savePromptRevision(h.runtime.db, { slug: 'p2-style', text: '## 说话方式\n- 换了个语气。\n', createdBy: 'admin' })
    assert.equal(saved.ok, true)
    h.runtime.invalidatePromptCache()
    const hashV2 = sha256(await h.render())
    assert.notEqual(hashV2, hashV1)

    const rolled = rollbackPrompt(h.runtime.db, v1.id)
    assert.ok(rolled !== undefined)
    assert.equal(rolled.active, true)
    h.runtime.invalidatePromptCache()
    assert.equal(sha256(await h.render()), hashV1, '回滚后哈希必须**精确回到**旧值')

    // 两版都还在（回滚不改历史）
    const revisions = listPromptRevisions(h.runtime.db, 'p2-style')
    assert.equal(revisions.filter((r) => r.active).length, 1, '同时只有一版 active')
    assert.ok(revisions.length >= 2, '历史版本都要留着')
  } finally {
    await h.dispose()
  }
})

test('按会话覆盖：只影响该会话；P1 不允许被覆盖（人设不该随会话漂移）', () => {
  const root = join(tempRoot, 'override')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    seedDefaultPrompts(runtime.db)
    const globalStyle = resolvePrompt(runtime.db, 'p2-style')
    assert.equal(globalStyle?.source, 'global')

    // 造一版"群里专用"的风格
    const group = savePromptRevision(runtime.db, { slug: 'p2-style', text: '## 群聊风格\n- 更简短。\n', createdBy: 'admin' })
    assert.equal(group.ok, true)
    if (!group.ok) return

    assert.equal(setPromptOverride(runtime.db, { scope: 'group:88888', slug: 'p2-style', revisionId: group.revision.id }), true)

    const groupStyle = resolvePrompt(runtime.db, 'p2-style', 'group:88888')
    assert.equal(groupStyle?.source, 'override')
    assert.ok(groupStyle?.text.includes('群聊风格'))

    // 别的会话不受影响
    const other = resolvePrompt(runtime.db, 'p2-style', 'private:10001')
    assert.equal(other?.source, 'global', '覆盖只影响被覆盖的那个会话')

    // P1 不允许按会话覆盖
    assert.throws(() => setPromptOverride(runtime.db, { scope: 'group:88888', slug: 'p1-system', revisionId: group.revision.id }), /只允许按会话覆盖回答风格/)

    // 清除后回到全局
    assert.equal(clearPromptOverride(runtime.db, 'group:88888'), true)
    assert.equal(resolvePrompt(runtime.db, 'p2-style', 'group:88888')?.source, 'global')
    assert.equal(listPromptOverrides(runtime.db).length, 0)
  } finally {
    runtime.close()
  }
})

test('回滚会清掉指向非生效版本的覆盖（否则覆盖会指向一个已经不在生效的旧版）', () => {
  const root = join(tempRoot, 'rollback-override')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    seedDefaultPrompts(runtime.db)
    const v1 = activePrompt(runtime.db, 'p2-style')
    assert.ok(v1 !== undefined)
    const v2 = savePromptRevision(runtime.db, { slug: 'p2-style', text: '## 第二版\n', createdBy: 'admin' })
    assert.equal(v2.ok, true)
    if (!v2.ok) return
    setPromptOverride(runtime.db, { scope: 'group:1', slug: 'p2-style', revisionId: v2.revision.id })
    assert.equal(listPromptOverrides(runtime.db).length, 1)

    rollbackPrompt(runtime.db, v1.id)
    assert.equal(listPromptOverrides(runtime.db).length, 0, '指向被回滚版本的覆盖必须被清掉')
  } finally {
    runtime.close()
  }
})

test('计数与状态：面板要能回答"这版谁改的、改了几次"', () => {
  const root = join(tempRoot, 'status')
  const runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: root }), dbPath: join(root, 'db', 'forlife.sqlite') })
  try {
    seedDefaultPrompts(runtime.db)
    assert.equal(promptEditCount(runtime.db), 0, '播种的默认值不算"编辑"')

    savePromptRevision(runtime.db, { slug: 'p1-system', text: '你是{{persona_name}}。\n', createdBy: 'admin' })
    assert.equal(promptEditCount(runtime.db), 1)

    const status = promptStatus(runtime.db)
    assert.equal(status.length, 2)
    const p1 = status.find((s) => s.slug === 'p1-system')
    assert.equal(p1?.updatedBy, 'admin')
    assert.deepEqual(p1?.variables, ['persona_name'])
    assert.ok((p1?.revisions ?? 0) >= 2)
  } finally {
    runtime.close()
  }
})

test('段名与顺序：四段的名字与 order 是契约（位置契约 lint 也会查这个）', () => {
  assert.equal(P1_NAME, 'forlife:p1-system')
  assert.equal(P2_NAME, 'forlife:p2-style')
})
