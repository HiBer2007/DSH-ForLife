/**
 * 「手动喂食记忆资料」在**插件侧**的两条入口的接线守卫：
 *  - 模型工具 `feed_memory`（模型自己决定记成知识还是经历）；
 *  - 面板接口 `POST /api/forlife/feed`（DSH Web UI 那一侧）。
 *
 * ## 为什么这类守卫必须存在（本仓最贵的一课）
 *
 * `buildQqTools` 曾经"写好了、单测全绿、而 `apply()` 里从来没调它" ⇒
 * 9 个 QQ 工具在生产里**根本不存在**，而测试全绿（测试直接调 builder，绕过了注册那一步）。
 * 所以这里同样三层：
 *  1. **读源码**：`apply()` 里真的调了 `buildFeedTools`（并且走 `registerOne`）；
 *  2. **跑真 `apply()`**：注册表里必须出现 `feed_memory`；
 *  3. **真执行**：工具真的能把内容写进记忆（而不是只有个名字）。
 *
 * ## 四条入口共用一个核心
 *
 * 工具与面板接口都必须落在**同一张表、同一套来源标记**上（都调 `@forlife/gateway` 的
 * `feedMemory`）。这里用一个"先经面板喂、再用工具喂同一段"的用例把它钉住：
 * 第二次必须判重，而不是各写各的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { resolveFeedDbPath } from '@forlife/gateway'
import { listEffects, openDatabase } from '@forlife/store'

import { buildPanelRoutes, type PanelRoute } from '../src/api.ts'
import { resolveConfig } from '../src/config.ts'
import { FEED_TOOL_NAMES } from '../src/feed-tools.ts'
import { apply } from '../src/index.ts'
import { MemoryRuntime, resolveDbPath } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-feed-wiring-'))
let runtime: MemoryRuntime
let routes: readonly PanelRoute[]

/** 静音（`apply()` 会打印一段诊断日志）。 */
function quiet<T>(fn: () => T): T {
  const o1 = console.log
  const o2 = console.error
  console.log = (): void => {}
  console.error = (): void => {}
  try {
    return fn()
  } finally {
    console.log = o1
    console.error = o2
  }
}

/** 假上下文：**真的注册**（把定义对象存下来），所以既能验名字、也能真执行。 */
function fakeCtx(): { ctx: never; registered: { name?: string; execute?: (args: never, exec: never) => Promise<unknown> }[] } {
  const registered: { name?: string; execute?: (args: never, exec: never) => Promise<unknown> }[] = []
  const ctx = {
    get: (name: string): unknown => {
      if (name === 'tools') {
        return {
          register: (definition: { name?: string }): (() => void) => {
            registered.push(definition)
            return (): void => {}
          },
        }
      }
      if (name === 'systemPrompt') return { section: (): (() => void) => (): void => {} }
      return undefined
    },
    inject: (): void => {},
    effect(callback: () => void | (() => void)): void {
      const dispose = callback()
      if (typeof dispose === 'function') void dispose
    },
    on: (): (() => void) => (): void => {},
  }
  return { ctx: ctx as never, registered }
}

before(async () => {
  // ⚠️ 数据库路径必须与 `apply()` 派生出来的**是同一个文件**：
  // `apply()` 用 `resolveDbPath(config, DSH_HOME)`，`storageRoot` 是绝对路径时
  // 与 DSH_HOME 无关 ⇒ 两边都落在 `<dir>/db/forlife.sqlite`。
  // 早先这里写成 `<dir>/forlife.sqlite`，于是"工具写到 A 库、断言读的是 B 库" ——
  // 四条用例全红而代码其实是对的（这正是要避免的**测试自己的**假阴性）。
  const config = resolveConfig({ storageRoot: dir, contextWindowTokens: 8000, verbose: false })
  runtime = new MemoryRuntime({ config, dbPath: resolveDbPath(config, dir) })
  routes = buildPanelRoutes(runtime)
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 发一个 POST 到面板接口。 */
async function postFeed(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.find((item) => item.path === '/api/forlife/feed' && item.methods.includes('POST'))
  assert.ok(route !== undefined, '缺少路由 POST /api/forlife/feed')
  const response = await route.fetch(
    new Request('http://local/api/forlife/feed', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 一个注册进来的工具定义（我们只用到 name 与 execute）。 */
interface RegisteredTool {
  readonly name?: string
  readonly execute?: (args: never, exec: never) => Promise<unknown>
}

/**
 * 取 `feed_memory` 的**可执行**入口。
 *
 * 写成"取不到就抛"而不是在每处 `tool?.execute?.(...)`：后者会让"工具根本没注册成功"
 * 表现成"什么都没发生"，而这类测试的全部意义就是抓那件事（宿主返回的定义是可选的）。
 */
function feedTool(registered: readonly RegisteredTool[]): (args: unknown) => Promise<unknown> {
  const tool = registered.find((definition) => definition.name === 'feed_memory')
  if (tool === undefined || tool.execute === undefined) {
    throw new Error('注册表里没有可执行的 feed_memory —— 接线断了')
  }
  const execute = tool.execute
  return (args: unknown) => execute(args as never, undefined as never)
}

// ── ① 接线守卫（读源码）────────────────────────────────────────────────────

test('★★ 接线守卫（读源码）：`apply()` 真的调了 `buildFeedTools`，且走 `registerOne`', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ buildFeedTools \} from '\.\/feed-tools\.ts'/, '要真的导入')
  assert.match(
    source,
    /for \(const definition of buildFeedTools\(defineToolImpl, runtime\)\) \{\s*\n\s*registerOne\(definition\)/,
    '**`buildFeedTools` 必须在 `apply()` 的注册循环里、且经由 `registerOne`** —— ' +
      '绕过它，生产日志里的工具数就不含 feed_memory（"一个会说谎的证据源比没有证据更危险"）',
  )
})

// ── ③ 真执行：工具真的能写记忆 ───────────────────────────────────────────────

test('★ 跑真 `apply()`：`feed_memory` 进了注册表，且真的能把知识写进长期记忆', async () => {
  const { ctx, registered } = fakeCtx()
  quiet(() => apply(ctx, resolveConfig({ storageRoot: dir, verbose: false })))
  await delay(40)

  const names = registered.map((definition) => definition.name)
  for (const required of FEED_TOOL_NAMES) {
    assert.ok(names.includes(required), `注册表里缺少工具 ${required}（实际：${names.join(', ')}）`)
  }

  const tool = feedTool(registered)

  const outcome = (await tool(
    { as: 'knowledge', content: '喂食工具写进来的第一条知识：分层降噪把大结果放进 spill。', source: 'tool/selftest' },
  )) as { ok: boolean; inserted: number; source: string; scope: string; note: string }
  assert.equal(outcome.ok, true)
  assert.equal(outcome.inserted, 1)
  assert.equal(outcome.source, 'tool/selftest')
  assert.equal(outcome.scope, 'feed:tool/selftest')

  // 真的落库了（不是只返回了一个好看的 JSON），而且带来源标记
  const row = runtime.db.prepare('SELECT source_scope FROM long_memory_entries WHERE id LIKE ?').get('feed_%') as
    | { source_scope: string }
    | undefined
  assert.equal(row?.source_scope, 'feed:tool/selftest')

  // 再喂一次同样的内容：判重（工具要如实说"已跳过"）
  const again = (await tool(
    { as: 'knowledge', content: '喂食工具写进来的第一条知识：分层降噪把大结果放进 spill。', source: 'tool/selftest' },
  )) as { ok: boolean; unchanged: number; note: string }
  assert.equal(again.ok, true)
  assert.equal(again.unchanged, 1, '同源同段重导：内容一致 ⇒ 未改动（不是又写一条）')
  assert.match(again.note, /未改动/)
})

test('★ 工具：喂经历进中期记忆；参数不对时返回完整形状的失败（不是抛异常）', async () => {
  const { ctx, registered } = fakeCtx()
  quiet(() => apply(ctx, resolveConfig({ storageRoot: dir, verbose: false })))
  await delay(40)
  const tool = feedTool(registered)

  const before = (runtime.db.prepare('SELECT count(*) AS n FROM mid_memory_entries').get() as { n: number }).n
  const outcome = (await tool(
    { as: 'experience', content: '今天主人把喂食入口接上了模型工具。', source: 'tool/exp' },
  )) as { ok: boolean; inserted: number; as: string; note: string; error?: string }
  assert.equal(outcome.ok, true, `工具执行失败：${outcome.error ?? ''} ${outcome.note}`)
  assert.equal(outcome.as, 'experience')
  assert.equal(outcome.inserted, 1, `应当新增 1 段，实际 ${String(outcome.inserted)}（${outcome.note}）`)
  const after = (runtime.db.prepare('SELECT count(*) AS n FROM mid_memory_entries').get() as { n: number }).n
  assert.equal(after, before + 1, `经历必须真的进中期记忆（前 ${String(before)} 后 ${String(after)}）`)

  // ① 宿主层：`as` 的 enum 真的进了 schema（非法值在**调用前**就被拦掉）
  await assert.rejects(
    async () => await tool({ as: 'nonsense', content: 'x' }),
    /must be one of/,
    'enum 必须真的进 schema —— 不然模型会拿"随便写个 as"去撞运行期',
  )

  // ② 我们自己这层：过了 schema 但内容空 ⇒ 返回 ok=false + 完整字段
  //（缺字段会让宿主按 schema 报错，模型就更看不懂了）
  const bad = (await tool({ as: 'knowledge', content: '   ' })) as {
    ok: boolean
    error?: string
    inserted: number
    note: string
  }
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /content 或 items/)
  assert.equal(bad.inserted, 0)
  assert.notEqual(bad.note, '')
})

// ── 面板接口：与工具共用同一个核心 ───────────────────────────────────────────

test('★★ 面板接口：POST /api/forlife/feed 真写库，且与工具**共用同一个核心**', async () => {
  const first = await postFeed({ items: [{ content: '面板喂进来的知识：迁移只前滚、不改旧迁移。' }], as: 'knowledge', source: 'panel/self' })
  assert.equal(first.status, 200)
  const result = first.body['result'] as { ok: boolean; inserted: number; scope: string }
  assert.equal(result.ok, true)
  assert.equal(result.inserted, 1)
  assert.equal(result.scope, 'feed:panel/self')

  const row = runtime.db
    .prepare('SELECT source_scope FROM long_memory_entries WHERE source_scope = ?')
    .get('feed:panel/self') as { source_scope: string } | undefined
  assert.equal(row?.source_scope, 'feed:panel/self', '面板喂的必须落在**同一张表**、同一套来源标记上')

  // 同一段再用**工具**喂一次：必须判重（两条入口共用 feedMemory 的直接证据）
  const { ctx, registered } = fakeCtx()
  quiet(() => apply(ctx, resolveConfig({ storageRoot: dir, verbose: false })))
  await delay(40)
  const tool = feedTool(registered)
  const outcome = (await tool(
    { as: 'knowledge', content: '面板喂进来的知识：迁移只前滚、不改旧迁移。', source: 'panel/self/again' },
  )) as { duplicates: number }
  assert.equal(outcome.duplicates, 1, '换个来源再喂同一段 ⇒ 判重（去重是记忆系统自己的能力，两条入口都享受）')
})

test('★ 面板接口：坏参数是 400（带原因），不是 500', async () => {
  const noKind = await postFeed({ items: [{ content: 'x' }], as: 'whatever' })
  assert.equal(noKind.status, 400)
  assert.match(String(noKind.body['error']), /knowledge 或 experience/)

  const noItems = await postFeed({ as: 'knowledge' })
  assert.equal(noItems.status, 400)
  assert.match(String(noItems.body['error']), /items/)

  const empty = await postFeed({ items: [{ content: '   ' }], as: 'knowledge' })
  assert.equal(empty.status, 400)
  assert.match(String(empty.body['error']), /没有可喂的内容/)
})

test('★ 铁律 1：喂食**影响模型记得什么** ⇒ 必须记一笔后台动作（affects_model=1）', async () => {
  const posted = await postFeed({ items: [{ content: '这条只为验证审计留痕。' }], as: 'knowledge', source: 'panel/audit' })
  assert.equal(posted.status, 200, `喂食应当成功：${JSON.stringify(posted.body)}`)
  const effects = listEffects(runtime.db, 50, 'admin_action')
  const feed = effects.find((effect) => effect.detail.includes('memory.feed') && effect.subject === 'panel/audit')
  assert.ok(feed !== undefined, '喂食必须留痕（否则模型以为没人动过它的记忆）')
  assert.equal(feed.affects_model, 1, 'affects_model 必须为 1（它决定要不要向模型报告）')
})

// ── DB 路径推导：与插件自己的 storageRoot / dbFile 默认值一致 ─────────────────

test('★ DB 路径：feed 脚本的 DSH_HOME 推导 == 插件配置的 storageRoot/dbFile 解析结果', () => {
  const home = join(dir, 'fake-home')
  const config = resolveConfig({})
  assert.equal(
    resolveFeedDbPath({ DSH_HOME: home }),
    resolveDbPath(config, home),
    '两处各写一份路径，迟早会喂到"另一个库"里去 —— 这条断言就是防那个',
  )
})
