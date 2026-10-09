/**
 * ★★ 「投喂前必须更新源」的**接线守卫**（读源码 + 行为两层）。
 *
 * ## 为什么必须有这一条
 *
 * 这条要求最容易被做成"文档说了但代码不强制"。用户 2026-10-09 的原话是：
 *
 * > 以后务必在任何试图投喂前更新即可，不必限制立刻更新。
 *
 * —— 而**理由**是当晚的实况：他让"清空重喂"，手上那份是早上切的 281 段；
 * 投喂前拉了一次才发现源里**多了 6 条**（就在干活这段时间聊的），
 * **不查就永久丢**。所以这不是洁癖，是防丢数据。
 *
 * ## 三层守卫
 *
 * | 层 | 断言什么 | 忘了会怎样 |
 * | :--- | :--- | :--- |
 * | **顺序** | `runFeedRefresh(` 出现在 `listFeedFiles(` / `feedMemory(` / `beginFeedSession(` **之前** | 刷新刚写出来的文件看不见（= 用陈旧数据重喂） |
 * | **闸门** | `feedInput` 里 `resolveFeedRefresh(` 的结果被**判断并 return** | 声明了但不生效 = 假刷新 |
 * | **行为** | 文件/流不声明刷新 ⇒ 一条都不写；刷新失败 ⇒ 一条都不写 | 破坏性重喂真的发生 |
 *
 * 顺序那一条是**读源码比对下标**（不是"看着像"）：`indexOf` 的先后就是执行先后，
 * 因为这几处都在 `feedInput` 的直线代码里（没有分支把它挪到别处）。
 *
 * @module tests/feed-refresh-wiring
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { DatabaseSync } from 'node:sqlite'

// ⚠️ 根目录的 tests/ 里用**相对路径**引包：这里的 Node 解析不到 `@forlife/*` 的别名
// （`packages/*/test/` 里的测试才能用别名 —— 那是包内视角）
import { defaultFor } from '../packages/contracts/src/index.ts'
import { feedInput } from '../packages/gateway/src/feed-batch.ts'
import { openDatabase } from '../packages/store/src/index.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 去掉注释（与其它守卫同一套做法）。 */
function code(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

const SUBSYSTEM = 'packages/gateway/src/feed-batch.ts'
const REFRESH = 'packages/gateway/src/feed-refresh.ts'

/** 四条入口：路径 → 人话。 */
const ENTRIES: readonly (readonly [string, string])[] = [
  ['scripts/feed-memory.ts', '① 文件/目录扫描 + ② 命令行直接传文本'],
  ['packages/gateway/src/admin/api.ts', '③ 后台 HTTP 接口（POST /api/admin/feed）'],
  ['packages/dsh-component/src/api.ts', '③ 面板 HTTP 接口（POST /api/forlife/feed）'],
  ['packages/dsh-component/src/feed-tools.ts', '④ 模型工具 feed_memory'],
]

const opened: { close: () => void }[] = []
const tempDirs: string[] = []

process.on('exit', () => {
  for (const handle of opened) handle.close()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-refresh-wiring-'))
  tempDirs.push(dir)
  return dir
}

const countLong = (db: DatabaseSync): number => (db.prepare('SELECT count(*) AS n FROM long_memory_entries').get() as { n: number }).n

test('★★ 顺序：刷新必须发生在**展开输入之前、开写之前**', () => {
  const source = code(SUBSYSTEM)
  // ⚠️ 只比对**feedInput 函数体内**的下标：写入动作在 `feedUnit`（定义在它上面），
  // 直接全文件 `indexOf('feedMemory(')` 会先撞上那个辅助函数 ⇒ 守卫会变成假绿/假红。
  const start = source.indexOf('export async function feedInput(')
  assert.ok(start > 0, '找不到 feedInput（守卫本身失效了）')
  const within = (needle: string): number => source.indexOf(needle, start)
  const resolve = within('resolveFeedRefresh(')
  const refresh = within('runFeedRefresh(')
  const listFiles = within('listFeedFiles(')
  const session = within('beginFeedSession(')
  const feedUnitCall = within('await feedUnit(')
  for (const [name, index] of [
    ['resolveFeedRefresh', resolve],
    ['runFeedRefresh', refresh],
    ['listFeedFiles', listFiles],
    ['beginFeedSession', session],
    ['feedUnit', feedUnitCall],
  ] as const) {
    assert.ok(index >= 0, `feedInput 里找不到 ${name} 的调用点（守卫会因此变成假绿）`)
  }
  assert.ok(resolve < refresh, '先解析声明、再执行刷新')
  assert.ok(refresh < listFiles, '刷新必须在**列目录/读文件之前** —— 否则刷新刚写出来的文件看不见（就是"用陈旧数据重喂"）')
  assert.ok(refresh < session, '刷新必须在开会话之前（会话里要记"基于哪个版本的源"）')
  assert.ok(refresh < feedUnitCall, '刷新必须在**任何一批开始写之前**')
  // 而"写"这件事只发生在 `feedUnit` 里（它在文件里定义在 feedInput **之前**）——
  // 也就是说：只要刷新没过那道闸，就根本走不到写。
  assert.ok(
    source.indexOf('feedMemory(') < start,
    'feedMemory 只该在 feedUnit（定义在 feedInput 之前）里被调用 —— 别把它挪进 feedInput 的直线代码里',
  )
})

test('★★ 闸门：`resolveFeedRefresh` 的结果必须被判断，失败必须 return（声明了不生效 = 假刷新）', () => {
  const source = code(SUBSYSTEM)
  assert.match(source, /if \(!resolvedRefresh\.ok\) return failure\(resolvedRefresh\.error\)/, '解析失败必须直接打回')
  assert.match(source, /if \(!refresh\.ok\) \{/, '刷新失败必须走"不喂"的分支')
  assert.match(source, /return \{ ok: false, error: `投喂前的源刷新未通过：\$\{refresh\.reason\}`/, '失败要带上刷新原因（调用方要能分辨"源没拉到"与"内容有问题"）')
  // 失败的返回里要带上 refresh（CLI/面板要靠它显示"旧 N → 新 M"或失败原因）
  assert.match(source, /refresh\s*\n?\s*\}\s*\n\s*\}/, '刷新结果必须随结果一起返回')
})

test('★★ 入口不许自己跑刷新命令（谁都绕不过子系统那道闸）', () => {
  for (const [rel, what] of ENTRIES) {
    const source = code(rel)
    for (const forbidden of ['child_process', 'execFile(', 'spawn(', 'execSync(']) {
      assert.ok(
        !source.includes(forbidden),
        `${what}（${rel}）里出现了 ${forbidden} —— 刷新只能由子系统（feed-batch + feed-refresh）执行：` +
          '入口自己跑命令 = 又一条绕开闸门的路',
      )
    }
  }
  // 反面：真正执行命令的地方只该有一处
  assert.match(code(REFRESH), /execFile\(/, '刷新适配器必须真的能跑命令')
  assert.match(code('packages/gateway/src/feed-batch.ts'), /runFeedRefresh\(/, '子系统必须调刷新适配器')
})

test('★ 基线：三个开关都被读（不许在代码里写死超时/标记/强制与否）', () => {
  const refresh = code(REFRESH)
  for (const key of ['feed.refresh.required', 'feed.refresh.command', 'feed.refresh.timeoutMs', 'feed.refresh.itemsMarker']) {
    assert.ok(refresh.includes(`'${key}'`), `刷新适配器必须读 ${key}（写死的话改基线就撒谎）`)
  }
  // 运维逃生门的默认值必须是"阻断"（用户口径：用陈旧数据重喂是破坏性的）
  assert.equal(defaultFor<boolean>('feed.refresh.required'), true, '默认必须"刷新失败就不喂"')
  assert.equal(defaultFor<string>('feed.refresh.command'), '', '默认不许把命令写进仓库（凭据纪律）')
})

test('★★ 行为：文件不声明刷新 ⇒ **一条都不写**；显式声明"无源"才放行', async () => {
  const db = freshDb()
  const dir = tempDir()
  writeFileSync(join(dir, 'a.md'), '一份本地资料。', 'utf8')

  const refused = await feedInput(db, { as: 'knowledge', paths: [dir] })
  assert.equal(refused.ok, false, '文件是"某个源的快照" ⇒ 不声明刷新必须打回')
  assert.match(refused.error ?? '', /必须先刷新/)
  assert.equal(countLong(db), 0, '被打回时**一条都不许写**')

  const declared = await feedInput(db, { as: 'knowledge', paths: [dir], refresh: { kind: 'none', reason: '测试：本地手写资料' } })
  assert.equal(declared.ok, true)
  assert.equal(countLong(db), 1)
  assert.equal(declared.refresh?.kind, 'none', '结果里要如实写"这次没有外部源"')
})

test('★★ 行为：刷新命令**先把文件写出来**，被喂进去的必须是刷新后的内容', async () => {
  const db = freshDb()
  const dir = tempDir()
  const target = join(dir, 'export.md')
  writeFileSync(target, '旧的（不该被喂）', 'utf8')

  const run = await feedInput(db, {
    as: 'knowledge',
    paths: [target],
    source: 'refresh/order',
    refresh: {
      kind: 'command',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(process.argv[1], '刷新之后的内容。'); console.log('items=7')`, target],
    },
  })
  assert.equal(run.ok, true, run.error ?? '喂食失败')
  assert.equal(run.refresh?.items, 7)
  const row = db.prepare('SELECT content FROM long_memory_entries').get() as { content: string } | undefined
  assert.equal(row?.content, '刷新之后的内容。', '刷新必须发生在读文件之前 —— 否则喂进去的是旧的（这正是要防的那件事）')
})

test('★★ 行为：刷新失败 ⇒ **一条都不写**，且结果里带着失败原因', async () => {
  const db = freshDb()
  const dir = tempDir()
  const target = join(dir, 'export.md')
  writeFileSync(target, '旧的（不该被喂）', 'utf8')

  const run = await feedInput(db, {
    as: 'knowledge',
    paths: [target],
    refresh: { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(2)'] },
  })
  assert.equal(run.ok, false)
  assert.match(run.error ?? '', /源刷新未通过/)
  assert.equal(run.refresh?.ok, false)
  assert.match(run.refresh?.reason ?? '', /退出码 2/)
  assert.equal(countLong(db), 0, '刷新失败时一条都不许写（用陈旧数据重喂是破坏性的）')
})

test('★ 行为：拒绝时**不碰**源（连命令都不跑）—— 声明不合法就早退', async () => {
  const db = freshDb()
  const marker = join(tempDir(), 'ran.txt')
  const run = await feedInput(db, {
    as: 'knowledge',
    paths: [join(tempDir(), '不存在.md')],
    refresh: {
      kind: 'command',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(process.argv[1], 'x')`, marker],
    },
  })
  // 这里是"声明合法但路径不存在"⇒ 命令会跑（这是对的：刷新与路径无关，源可能就是要新建它）
  assert.equal(run.ok, false)
  assert.equal(countLong(db), 0)

  // 而"声明本身不合法"（kind=none 没给 reason）⇒ 连命令都不该跑
  const bad = await feedInput(db, {
    as: 'knowledge',
    text: 'x',
    refresh: { kind: 'none', reason: '   ' },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /reason/)
  assert.equal(bad.refresh, undefined, '声明不合法时根本没到"跑刷新"那一步')
})
