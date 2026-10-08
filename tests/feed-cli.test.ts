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
  const options = parseArgs(['docs'])
  assert.equal(options.as, 'knowledge', '默认记成知识')
  assert.deepEqual([...options.paths], ['docs'])
  assert.equal(options.dryRun, false)
  assert.equal(options.source, undefined)

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
  assert.throws(() => parseArgs(['a.md', 'b.md', '--source', 'same']), /只能配\*\*单个\*\*文件/)
  assert.throws(() => parseArgs(['--source']), /缺一个值/)
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

test('★★ 文件扫描：喂进长期记忆、来源是相对路径、重导变成"更新"而不是又插一份', () => {
  const { root, notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-db-'), 'forlife.sqlite')

  assert.equal(quiet(() => main([notes, '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 3, 'a.md 两段 + b.txt 一段')
  const scopesAfterFirst = scopes(dbPath, 'long_memory_entries')
  assert.ok(
    scopesAfterFirst.includes(`feed:${sourceOfFile(join(notes, 'a.md'), process.cwd())}`),
    `来源必须是"相对当前目录的路径"：${scopesAfterFirst.join(' , ')}`,
  )

  // 重导（内容没变）：不许把条目数喂大
  assert.equal(quiet(() => main([notes, '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 3, '重导不许新增')

  // 改一段再重导：还是 3 条（更新其中一条），并且正文真的变了
  writeFileSync(join(notes, 'a.md'), '第一份资料的第一段（改过）。\n\n第一份资料的第二段。\n', 'utf8')
  assert.equal(quiet(() => main([notes, '--db', dbPath])), 0)
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

test('★ --dry-run：一个字都不写（连"新增 0"这种误导都不给，直接说"预计"）', () => {
  const { notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-dry-'), 'forlife.sqlite')
  assert.equal(quiet(() => main([notes, '--db', dbPath, '--dry-run'])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 0)
  assert.equal(count(dbPath, 'mid_memory_entries'), 0)
})

test('★ --as experience：同样的入口喂进中期记忆（来源标记一致）', () => {
  const { notes } = makeCorpus()
  const dbPath = join(tempDir('forlife-feed-exp-'), 'forlife.sqlite')
  assert.equal(quiet(() => main([notes, '--as', 'experience', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'mid_memory_entries'), 3)
  assert.equal(count(dbPath, 'long_memory_entries'), 0, '经历不该进长期记忆')
  assert.ok(
    scopes(dbPath, 'mid_memory_entries').every((scope) => scope.startsWith('feed:')),
    '每条都要带来源标记（否则没法重导、也没法按来源归档）',
  )
})

test('★★ --text：直接喂一段文本；重复喂同一段是幂等的', () => {
  const dbPath = join(tempDir('forlife-feed-text-'), 'forlife.sqlite')
  assert.equal(quiet(() => main(['--text', '命令行直接喂的一段知识。', '--as', 'knowledge', '--source', 'cli/note', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 1)
  assert.equal(quiet(() => main(['--text', '命令行直接喂的一段知识。', '--as', 'knowledge', '--source', 'cli/note', '--db', dbPath])), 0)
  assert.equal(count(dbPath, 'long_memory_entries'), 1, '同源同段重复喂：幂等')
})

test('★ 失败路径：没给东西 / 路径不存在 / 没找到资料 ⇒ 非零退出码', () => {
  const dbPath = join(tempDir('forlife-feed-bad-'), 'forlife.sqlite')
  assert.equal(quiet(() => main(['--db', dbPath])), 1, '什么都没给要报错')
  assert.equal(quiet(() => main([join(tempDir('forlife-feed-none-'), '不存在'), '--db', dbPath])), 1)
  const empty = tempDir('forlife-feed-empty-')
  assert.equal(quiet(() => main([empty, '--db', dbPath])), 1, '空目录里没有 .md/.txt 也要如实报')
  assert.throws(() => parseArgs(['--as', 'nope']))
})
