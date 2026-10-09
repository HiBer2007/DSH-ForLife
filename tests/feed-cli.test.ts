/**
 * 「手动喂食记忆资料」命令行入口的端到端测试。
 *
 * 这里**直接 import `scripts/feed-memory.ts` 调 `main()`**（不 spawn 子进程）：
 *  - 子进程要管道抓输出，在受限沙箱里会因命名管道被拒而 EPERM —— 那种失败与代码无关；
 *  - 脚本里有"直接运行才执行 main"的闸门，所以 import 不会产生副作用。
 *
 * 守的东西：
 *  ① 文件/目录扫描真的把 `.md`/`.txt` 喂进去了（来源 = 相对路径，可重导）；
 *  ② 重导是**更新**而不是又插一份；`--dry-run` 一个字都不写；
 *  ③ `--as experience` 真的进中期记忆；
 *  ④ 参数错误是**明确的非零退出码 + 人话**（不是静默忽略：把 `--dryrun` 当没看见，
 *     会让人以为已经预演过，然后真写了一库）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { collectFiles, main, parseArgs, sourceOfFile } from '../scripts/feed-memory.ts'
import { openDatabase } from '../packages/store/src/index.ts'

const dirs: string[] = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 静音跑一段（CLI 的产物就是给人看的文本，测试不需要它刷屏）。 */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const o1 = console.log
  const o2 = console.error
  console.log = (): void => {}
  console.error = (): void => {}
  try {
    return await fn()
  } finally {
    console.log = o1
    console.error = o2
  }
}

/**
 * 跑一段并**收集输出**（要断言"人看到了什么"时用）。
 *
 * 与 `quiet` 分开而不是加个开关：`quiet` 是"我不关心输出"，这里是"输出就是被测对象"——
 * 混成一个带布尔参数的函数，调用点会看不出这次到底在意哪一边。
 */
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; output: string[] }> {
  const lines: string[] = []
  const o1 = console.log
  const o2 = console.error
  console.log = (...args: unknown[]): void => void lines.push(args.map(String).join(' '))
  console.error = (...args: unknown[]): void => void lines.push(args.map(String).join(' '))
  try {
    const code = await fn()
    return { code, output: lines }
  } finally {
    console.log = o1
    console.error = o2
  }
}

/** 造一份小资料目录。 */
function makeCorpus(): { root: string; notes: string } {
  const root = tempDir('forlife-feed-cli-')
  const notes = join(root, 'notes')
  mkdirSync(join(notes, 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(notes, 'a.md'), '第一份资料的第一段。\n\n第一份资料的第二段。\n', 'utf8')
  writeFileSync(join(notes, 'deep', 'b.txt'), '第二份资料只有一段。\n', 'utf8')
  writeFileSync(join(notes, 'ignore.json'), '{"not":"memory"}', 'utf8')
  writeFileSync(join(root, 'node_modules', 'c.md'), '依赖目录里的文件不算资料。', 'utf8')
  return { root, notes }
}

/** 数一张表的行数。 */
function count(dbPath: string, table: string): number {
  const opened = openDatabase({ file: dbPath })
  try {
    return (opened.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    opened.close()
  }
}

/** 取一张表里全部来源标记。 */
function scopes(dbPath: string, table: string): string[] {
  const opened = openDatabase({ file: dbPath })
  try {
    return (opened.db.prepare(`SELECT source_scope AS s FROM ${table} ORDER BY source_scope`).all() as unknown as { s: string | null }[])
      .map((row) => row.s ?? '')
  } finally {
    opened.close()
  }
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────

test('参数解析：默认值、各选项、以及"拼错了就直接报错"', () => {
  const options = parseArgs(['docs', '--no-refresh'])
  assert.equal(options.as, 'knowledge', '默认记成知识')
  assert.deepEqual([...options.paths], ['docs'])
  assert.equal(options.dryRun, false)
  assert.equal(options.source, undefined)
  assert.equal(options.refresh?.kind, 'none', '--no-refresh ⇒ 显式声明"无外部源"')

  const full = parseArgs(['--text', '一句话', '--as', 'experience', '--source', 'cli/x', '--db', 'x.sqlite', '--dry-run', '--verbose'])
  assert.equal(full.text, '一句话')
  assert.equal(full.as, 'experience')
  assert.equal(full.source, 'cli/x')
  assert.equal(full.db, 'x.sqlite')
  assert.equal(full.dryRun, true)
  assert.equal(full.verbose, true)

  assert.throws(() => parseArgs(['--as', 'memory']), /knowledge 或 experience/)
  assert.throws(() => parseArgs(['--dryrun']), /未知参数/, '拼错的选项不许被静默忽略')
  assert.throws(() => parseArgs(['--text', 'a', 'docs']), /不能同时给/)
  assert.throws(() => parseArgs(['a.md', 'b.md', '--source', 'same', '--no-refresh']), /只能配\*\*单个\*\*文件/)
  assert.throws(() => parseArgs(['--source']), /缺一个值/)
})

test('★★ 参数解析：源刷新（★ 文件/目录必须说清源怎么刷新，不许沉默地喂陈旧快照）', () => {
  // ① 不给声明 ⇒ 直接打回（这是"投喂前必须更新"的 CLI 侧闸门）
  assert.throws(() => parseArgs(['docs']), /必须说明源怎么刷新/, '文件/目录不许悄悄喂进去')

  // ② 显式"无源"
  assert.equal(parseArgs(['docs', '--no-refresh']).refresh?.kind, 'none')

  // ③ 刷新命令：按命令行拆（带引号的整段算一个参数）
  const command = parseArgs(['docs', '--refresh', 'pwsh -NoProfile -File "D:\\some dir\\fetch.ps1"'])
  assert.equal(command.refresh?.kind, 'command')
  if (command.refresh?.kind === 'command') {
    assert.equal(command.refresh.command, 'pwsh')
    assert.deepEqual([...(command.refresh.args ?? [])], ['-NoProfile', '-File', 'D:\\some dir\\fetch.ps1'], '带空格的路径必须靠引号包成一段')
  }

  // ④ default = 用部署配置的命令（命令本身不进命令行历史/仓库）
  assert.equal(parseArgs(['docs', '--refresh', 'default']).refresh?.kind, 'default')

  // ⑤ --refresh-output：把刷新输出当内容 ⇒ 内容只能有一个来源
  const output = parseArgs(['--refresh', 'pwsh -File x.ps1', '--refresh-output'])
  assert.equal(output.refresh?.kind === 'command' ? output.refresh.useOutputAsText : undefined, true)

  // ⑥ 互相冲突的组合都要报错，而不是"挑一个执行"
  assert.throws(() => parseArgs(['docs', '--refresh', 'x', '--no-refresh']), /只能给一个/)
  assert.throws(() => parseArgs(['--refresh-output']), /必须与 --refresh 一起用/)
  assert.throws(() => parseArgs(['--text', 'a', '--refresh', 'x']), /内容是直接给的/)
  assert.throws(() => parseArgs(['--refresh-output', '--refresh', 'x', 'docs']), /内容只能有一个来源/)
  assert.throws(() => parseArgs(['--refresh-output', '--refresh', 'x', '--text', 'a']), /内容只能有一个来源/)
})

test('目录扫描：递归收 .md/.txt，跳过依赖目录与其它后缀，顺序稳定', () => {
  const { notes, root } = makeCorpus()
  const files = collectFiles(notes).map((file) => file.slice(root.length).replace(/\\/g, '/'))
  assert.deepEqual([...files], ['/notes/a.md', '/notes/deep/b.txt'])
  assert.equal(collectFiles(join(notes, 'a.md')).length, 1, '直接给文件也要认')
  assert.throws(() => collectFiles(join(notes, '不存在.md')))
})

test('来源名：相对当前目录、正斜杠；目录外的文件用绝对路径（绝不含反斜杠）', () => {
  const { root, notes } = makeCorpus()
  assert.equal(sourceOfFile(join(notes, 'a.md'), root), 'notes/a.md')
  assert.ok(!sourceOfFile(join(notes, 'a.md'), root).includes('\\'), '换机器/换平台要得到同一个来源名')
  assert.equal(sourceOfFile(join(notes, 'a.md'), join(root, 'elsewhere')), join(notes, 'a.md').replace(/\\/g, '/'))
})

// ── 端到端 ───────────────────────────────────────────────────────────────────

test('★★ 文件扫描：喂进长期记忆、来源是相对路径、重导变成"更新"而不是又插一份', async () => {
  const { root, notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-db-'), 'forlife.sqlite')

  assert.equal(await quiet(() => main([notes, '--no-refresh', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 3, 'a.md 两段 + b.txt 一段')
  const scopesAfterFirst = scopes(dbPath, 'long_memory_entries')
  assert.ok(
    scopesAfterFirst.includes(`feed:${sourceOfFile(join(notes, 'a.md'), process.cwd())}`),
    `来源必须是"相对当前目录的路径"：${scopesAfterFirst.join(' , ')}`,
  )

  // 重导（内容没变）：不许把条目数喂大
  assert.equal(await quiet(() => main([notes, '--no-refresh', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 3, '重导不许新增')

  // 改一段再重导：还是 3 条（更新其中一条），并且正文真的变了
  writeFileSync(join(notes, 'a.md'), '第一份资料的第一段（改过）。\n\n第一份资料的第二段。\n', 'utf8')
  assert.equal(await quiet(() => main([notes, '--no-refresh', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 3, '同源重导 = 更新，不是新增')
  const opened = openDatabase({ file: dbPath })
  try {
    const row = opened.db.prepare("SELECT content FROM long_memory_entries WHERE content LIKE '%改过%'").get() as
      | { content: string }
      | undefined
    assert.ok(row !== undefined, '改过的正文必须落库')
  } finally {
    opened.close()
  }
})

test('★ --dry-run：一个字都不写（连"新增 0"这种误导都不给，直接说"预计"）', async () => {
  const { notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-dry-'), 'forlife.sqlite')
  assert.equal(await quiet(() => main([notes, '--no-refresh', '--db', dbPath, '--dry-run'])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 0)
  assert.equal(count(dbPath, 'mid_memory_entries'), 0)
})

test('★ --as experience：同样的入口喂进中期记忆（来源标记一致）', async () => {
  const { notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-exp-'), 'forlife.sqlite')
  assert.equal(await quiet(() => main([notes, '--no-refresh', '--as', 'experience', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'mid_memory_entries'), 3)
  assert.equal(count(dbPath, 'long_memory_entries'), 0, '经历不该进长期记忆')
  assert.ok(
    scopes(dbPath, 'mid_memory_entries').every((scope) => scope.startsWith('feed:')),
    '每条都要带来源标记（否则没法重导、也没法按来源归档）',
  )
})

test('★★ --text：直接喂一段文本；重复喂同一段是幂等的', async () => {
  const dbPath = join(tempDir('forlife-feed-text-'), 'forlife.sqlite')
  assert.equal(await quiet(() => main(['--text', '命令行直接喂的一段知识。', '--as', 'knowledge', '--source', 'cli/note', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 1)
  assert.equal(await quiet(() => main(['--text', '命令行直接喂的一段知识。', '--as', 'knowledge', '--source', 'cli/note', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 1, '同源同段重复喂：幂等')
})

test('★★ 投喂前必须刷新：CLI 真的**先跑刷新命令、再读文件**（刷新刚写出来的内容才被喂进去）', async () => {
  const root = tempDir('forlife-feed-refresh-')
  const dbPath = join(root, 'forlife.sqlite')
  const target = join(root, 'export.md')

  // 刷新脚本：写一份"刷新之后才有"的资料，并按约定报条数
  const script = join(root, 'refresh.mjs')
  writeFileSync(
    script,
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      // 报条数时**带上旧的**（模拟"源里多了 2 条"）
      "const previous = (() => { try { return Number(readFileSync(process.argv[3], 'utf8')) } catch { return 0 } })()",
      "writeFileSync(process.argv[2], '刷新之后才有的那一段资料。', 'utf8')",
      "writeFileSync(process.argv[3], '7', 'utf8')",
      "console.log(`items=${previous === 0 ? 5 : 7}`)",
      '',
    ].join('\n'),
    'utf8',
  )
  const cursor = join(root, 'previous.txt')
  // 第一次：脚本报 5 条
  const command = `"${process.execPath}" "${script}" "${target}" "${cursor}"`
  const first = await capture(() => main([target, '--refresh', command, '--source', 'refresh/e2e', '--db', dbPath]))
  assert.equal(first.code, 0, first.output.join('\n'))
  assert.ok(
    first.output.some((line) => line.includes('拉到 5 条')),
    `刷新那一行必须报出条数（"旧 N → 新 M"就靠它）：${first.output.join(' | ')}`,
  )

  // 喂进去的必须是**刷新刚写出来**的内容（证明刷新发生在"读文件"之前）
  const opened = openDatabase({ file: dbPath })
  try {
    const row = opened.db.prepare('SELECT content FROM long_memory_entries').get() as { content: string } | undefined
    assert.equal(row?.content, '刷新之后才有的那一段资料。', '刷新的结果必须被看见（顺序错了就会喂到旧内容）')
  } finally {
    opened.close()
  }

  // 第二次：脚本报 7 条 ⇒ 台账里记着 5 ⇒ 这行必须出现"旧 5 → 新 7（+2）"
  const second = await capture(() => main([target, '--refresh', command, '--source', 'refresh/e2e', '--db', dbPath]))
  assert.equal(second.code, 0, second.output.join('\n'))
  assert.ok(
    second.output.some((line) => /旧\s*5\s*条\s*→\s*新\s*7\s*条（\+2）/.test(line)),
    `要能一眼看出源里多了几条，实际输出：${second.output.join(' | ')}`,
  )
})

test('★ 投喂前必须刷新：刷新命令失败 ⇒ **一个字都不写**（陈旧数据重喂是破坏性的）', async () => {
  const root = tempDir('forlife-feed-refresh-fail-')
  const dbPath = join(root, 'forlife.sqlite')
  const target = join(root, 'export.md')
  writeFileSync(target, '本地那份**旧的**资料（不该被喂进去）。', 'utf8')

  const code = await quiet(() =>
    main([target, '--refresh', `"${process.execPath}" -e "process.exit(3)"`, '--source', 'refresh/fail', '--db', dbPath]),
  )
  assert.equal(code, 1, '刷新失败必须非零退出')
  assert.equal(count(dbPath, 'long_memory_entries'), 0, '刷新失败时**一条都不许写**')
})

test('★ 失败路径：没给东西 / 路径不存在 / 没找到资料 ⇒ 非零退出码', async () => {
  const dbPath = join(tempDir('forlife-feed-bad-'), 'forlife.sqlite')
  assert.equal(await quiet(() => main(['--db', dbPath])), 1, '什么都没给要报错')
  assert.equal(await quiet(() => main([join(tempDir('forlife-feed-none-'), '不存在'), '--no-refresh', '--db', dbPath])), 1)
  const empty = tempDir('forlife-feed-empty-')
  assert.equal(await quiet(() => main([empty, '--no-refresh', '--db', dbPath])), 1, '空目录里没有 .md/.txt 也要如实报')
  assert.throws(() => parseArgs(['--as', 'nope']))
})
