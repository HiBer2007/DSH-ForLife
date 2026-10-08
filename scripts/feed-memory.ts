/**
 * 手动喂食记忆资料 —— **命令行入口**（文件/目录扫描 + 直接传文本）。
 *
 * ## 它只是入口，不是管道
 *
 * 真正的写入只有一条路：`@forlife/gateway` 的 `feedMemory()`（与面板接口、
 * 后台接口、模型工具是**同一个函数**）。这里只做三件事：
 * 读文件 / 解析参数 / 把结果打印成人话。分块、去重、增量更新、归档全部在核心那一侧，
 * 它们本来就是记忆系统自己的能力（理由见 `packages/gateway/src/feed.ts` 的模块头）。
 *
 * ## 可以直接复制的用法
 *
 * ```powershell
 * # 1) 扫一个文件（来源默认取"相对当前目录的路径"）
 * node scripts/feed-memory.ts docs\notes\deploy.md
 *
 * # 2) 扫一个目录（递归、只认 .md / .txt）
 * node scripts/feed-memory.ts docs
 *
 * # 3) 直接喂一段文本，记成**知识**（长期记忆）
 * node scripts/feed-memory.ts --text "WAL 模式下多个进程可以共享同一个库文件。" --as knowledge --source cli/note-1
 *
 * # 4) 直接喂一段文本，记成**经历**（中期记忆）
 * node scripts/feed-memory.ts --text "今天把喂食入口接上了。" --as experience
 *
 * # 5) 只看会发生什么，一个字都不写
 * node scripts/feed-memory.ts docs --dry-run --verbose
 *
 * # 6) 指定库（默认 FORLIFE_DB，其次 DSH_HOME 推导，最后仓库内 .runtime/dsh/…）
 * node scripts/feed-memory.ts docs --db .runtime\dsh\forlife\db\forlife.sqlite
 * ```
 *
 * ## 重导与删除
 *
 *  - **重导**：同一个 `--source` 再喂一次就是"更新那一份东西"（长期记忆按段落更新，
 *    多出来的段落自动归档）；来源默认是文件路径，所以"改完文件再跑一遍"就是重导。
 *  - **删除**：**没有删除参数** —— 用既有的记忆管理（后台「记忆条目」页按
 *    `feed:<来源>` 过滤后归档，或 `POST /api/admin/memory-archive`）。归档不是真删。
 *
 * @module scripts/feed-memory
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { feedMemory, isFeedKind, resolveFeedDbPath, type FeedKind, type FeedItem, type FeedResult } from '../packages/gateway/src/feed.ts'
import { openDatabase } from '../packages/store/src/index.ts'

/** 目录扫描认识的后缀（其余文件**静默跳过** —— 别把二进制读进来当记忆）。 */
const TEXT_EXTENSIONS = ['.md', '.txt']

/** 目录扫描跳过的目录名（它们不属于"资料"）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', 'dist'])

/** 用法（`--help` 与参数错误都打印它）。 */
const USAGE = [
  '用法：',
  '  node scripts/feed-memory.ts <文件或目录…> [选项]',
  '  node scripts/feed-memory.ts --text "一段话" [选项]',
  '',
  '选项：',
  '  --as knowledge|experience   记成知识（长期记忆，默认）还是经历（中期记忆）',
  '  --source <名字>             来源标记（同一来源 = 同一份东西，重导会更新它）',
  '                              只能与**单个**文件或 --text 一起用',
  '  --text <文本>               直接喂一段文本（与位置参数二选一）',
  '  --dry-run                   只算不写：报出会发生什么，一行都不落库',
  '  --db <路径>                 指定数据库（默认 FORLIFE_DB → DSH_HOME → 仓库内 .runtime/dsh）',
  '  --verbose                   逐段打印明细',
  '  --help                      打印这份说明',
].join('\n')

/** 解析后的参数。 */
interface CliOptions {
  readonly paths: readonly string[]
  readonly text?: string
  readonly as: FeedKind
  readonly source?: string
  readonly dryRun: boolean
  readonly db?: string
  readonly verbose: boolean
  readonly help: boolean
}

/**
 * 解析命令行参数。
 *
 * 手写而不是引依赖：本仓的脚本从不引第三方（可移植性优先），而参数就这几个。
 * 未知参数**直接报错**（不是忽略）—— 把 `--dryrun` 这种拼写错误静默忽略，
 * 会让人以为"已经预演过了"，然后真写了一库。
 *
 * @param argv - `process.argv.slice(2)`。
 * @returns 解析结果。
 * @throws 参数不合法时抛 Error（消息即人话原因）。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const paths: string[] = []
  let text: string | undefined
  let as: FeedKind = 'knowledge'
  let source: string | undefined
  let dryRun = false
  let db: string | undefined
  let verbose = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 后面缺一个值`)
      i += 1
      return value
    }
    switch (arg) {
      case '--help':
      case '-h':
        help = true
        break
      case '--as': {
        const value = next()
        if (!isFeedKind(value)) throw new Error(`--as 只能是 knowledge 或 experience，收到：${value}`)
        as = value
        break
      }
      case '--source':
        source = next()
        break
      case '--text':
        text = next()
        break
      case '--db':
        db = next()
        break
      case '--dry-run':
        dryRun = true
        break
      case '--verbose':
        verbose = true
        break
      default:
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
        paths.push(arg)
    }
  }

  if (text !== undefined && paths.length > 0) throw new Error('--text 与文件/目录路径不能同时给（一批一批喂）')
  if (source !== undefined && paths.length > 1) {
    // 同一个来源 = 同一份东西 ⇒ 两个文件共用一个来源会互相覆盖（第 0 段更新第 0 段）
    throw new Error('--source 只能配**单个**文件：同一个来源是"同一份东西"，多个文件共用它会互相覆盖')
  }
  return {
    paths,
    ...(text === undefined ? {} : { text }),
    as,
    ...(source === undefined || source.trim() === '' ? {} : { source: source.trim() }),
    dryRun,
    ...(db === undefined ? {} : { db }),
    verbose,
    help,
  }
}

/** 递归收集资料文件（跳过 `SKIP_DIRS` 与不认识的后缀）。 */
export function collectFiles(target: string): readonly string[] {
  const absolute = resolve(target)
  const stats = statSync(absolute)
  if (stats.isFile()) return [absolute]
  const out: string[] = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...collectFiles(join(absolute, entry.name)))
      continue
    }
    if (entry.isFile() && TEXT_EXTENSIONS.includes(extname(entry.name).toLowerCase())) out.push(join(absolute, entry.name))
  }
  return out.sort()
}

/**
 * 来源名：相对当前目录的路径、一律用正斜杠。
 *
 * 为什么用相对路径而不是绝对路径：来源是"同一份东西"的身份标识。
 * 用绝对路径的话，换机器、换 checkout 目录、甚至换个盘符，都会让"重导"变成"新喂一份"。
 * 为什么统一正斜杠：Windows 与容器里同一个文件要能得到**同一个**来源名。
 */
export function sourceOfFile(file: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, file)
  const chosen = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel
  return chosen.replace(/\\/g, '/')
}

/**
 * 一行结果汇总（人话）。
 *
 * `--dry-run` 下**如实说"预计"**：这时 `inserted/updated/archived` 都是 0
 * （一个字都没写），真实信息在每段的 `wouldBe` 里 —— 打印 "新增 0" 会让人以为
 * "这段内容没用"，而其实只是没执行。
 */
function summarize(result: FeedResult): string {
  const planned = (action: string): number => result.details.filter((detail) => detail.wouldBe === action).length
  const parts = result.dryRun
    ? [
        `预计新增 ${String(planned('inserted'))}`,
        `预计更新 ${String(planned('updated'))}`,
        `预计归档 ${String(planned('archived'))}`,
      ]
    : [`新增 ${String(result.inserted)}`]
  if (!result.dryRun && result.updated > 0) parts.push(`更新 ${String(result.updated)}`)
  if (result.duplicates > 0) parts.push(`判重跳过 ${String(result.duplicates)}`)
  if (result.unchanged > 0) parts.push(`未改动 ${String(result.unchanged)}`)
  if (!result.dryRun && result.archived > 0) parts.push(`归档 ${String(result.archived)}`)
  parts.push(`${String(result.tokens)} token`)
  return parts.join(' / ')
}

/** 逐段明细（`--verbose`，或"有段没有正常写入"时）。 */
function detailLines(result: FeedResult): string[] {
  return result.details
    .filter((detail) => detail.action !== 'inserted' && detail.action !== 'planned')
    .map((detail) => `    · ${detail.index < 0 ? '上一版' : `第 ${String(detail.index + 1)} 段`} → ${detail.action}：${detail.reason}`)
}

/**
 * 主流程。
 *
 * @param argv - 命令行参数。
 * @returns 进程退出码（0 = 全部成功，1 = 有失败）。
 */
export function main(argv: readonly string[]): number {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}\n`)
    console.error(USAGE)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  if (options.text === undefined && options.paths.length === 0) {
    console.error(`没给要喂的东西。\n\n${USAGE}`)
    return 1
  }

  // 数据库：--db > FORLIFE_DB > DSH_HOME 推导 > 仓库内 .runtime/dsh（**绝不碰宿主 ~/.dsh**）
  const dbPath = options.db !== undefined ? resolve(options.db) : resolveFeedDbPath(process.env)

  // ★★ 2026-10-08 安全护栏：**默认拒绝写到宿主 ~/.dsh**。
  //
  //   推导顺序本身是对的（--db > FORLIFE_DB > DSH_HOME > 仓库内 .runtime/dsh），
  //   但**全局 `DSH_HOME` 可能指向宿主 `~/.dsh`** ——
  //   那样不带 `DSH_HOME` 跑这条命令就会写到**宿主的记忆库**。
  //
  //   项目硬约束：「**绝不碰宿主 ~/.dsh**」。
  //   ⇒ **不是推导错了，是没人拦着**。
  //
  //   为什么默认拒绝：这条命令会**改记忆库**，
  //   而"改错库"的代价是**污染宿主的记忆**。
  //
  //   为什么**不给** `--allow-host-home` 开关：
  //   出路有两条（`--db` 或 `DSH_HOME`），都指向仓库内；
  //   **少一个开关 = 少一条误用的路**。
  const hostDsh = resolve(join(homedir(), '.dsh'))
  const resolvedDb = resolve(dbPath)
  if (resolvedDb === hostDsh || resolvedDb.startsWith(hostDsh + sep)) {
    console.error('✗ 拒绝写入宿主 ~/.dsh —— 这是本项目的硬约束（可移植性）。')
    console.error('  解析到的库：' + dbPath)
    console.error('')
    console.error('  两条出路：')
    console.error('    1) 显式指定仓库内的库：--db .runtime\\dsh\\forlife\\db\\forlife.sqlite')
    console.error('    2) 或设环境变量：$env:DSH_HOME = "D:\\DSH-ForLife\\.runtime\\dsh"')
    return 1
  }
  console.log(`库：${dbPath}${options.dryRun ? '（dry-run：一个字都不写）' : ''}`)

  let opened: ReturnType<typeof openDatabase>
  try {
    opened = openDatabase({ file: dbPath })
  } catch (error) {
    console.error(`打不开数据库：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  /** 一批（一个文件 / 一段文本）的喂食。 */
  const feedOne = (label: string, items: readonly FeedItem[], source: string | undefined): boolean => {
    let result: FeedResult
    try {
      result = feedMemory(opened.db, {
        items,
        as: options.as,
        ...(source === undefined ? {} : { source }),
        ...(options.dryRun ? { dryRun: true } : {}),
      })
    } catch (error) {
      // 意外错误（库损坏之类）：如实说，并且**继续喂下一批** —— 半途而废更难收拾
      console.error(`✗ ${label}：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    if (!result.ok) {
      console.error(`✗ ${label}：${result.error ?? '喂食失败'}`)
      return false
    }
    console.log(`${options.dryRun ? '· ' : '✓ '}${label} → ${summarize(result)}（来源 ${result.source}）`)
    if (options.verbose) {
      for (const line of detailLines(result)) console.log(line)
    } else {
      const notable = detailLines(result)
      if (notable.length > 0) console.log(`    （${String(notable.length)} 段没有直接写入，加 --verbose 看明细）`)
    }
    return true
  }

  let ok = true
  try {
    if (options.text !== undefined) {
      ok = feedOne(`--text（${String(options.text.length)} 字）`, [{ content: options.text }], options.source)
    } else {
      for (const target of options.paths) {
        let files: readonly string[]
        try {
          files = collectFiles(target)
        } catch (error) {
          console.error(`✗ ${target}：${error instanceof Error ? error.message : String(error)}`)
          ok = false
          continue
        }
        if (files.length === 0) {
          console.error(`✗ ${target}：没找到 .md / .txt 文件`)
          ok = false
          continue
        }
        for (const file of files) {
          const label = sourceOfFile(file)
          let content: string
          try {
            content = readFileSync(file, 'utf8')
          } catch (error) {
            console.error(`✗ ${label}：读不到文件（${error instanceof Error ? error.message : String(error)}）`)
            ok = false
            continue
          }
          // 来源：单个文件且显式给了 --source 就用它，否则用相对路径
          const source = options.source ?? label
          if (!feedOne(label, [{ content }], source)) ok = false
        }
      }
    }
  } finally {
    opened.close()
  }

  if (!ok) {
    console.error('有失败项（见上面带 ✗ 的行）。')
    return 1
  }
  console.log(
    options.dryRun
      ? '预演结束：没有任何写入。去掉 --dry-run 才会真喂。'
      : '完成。要删除：后台「记忆条目」页按来源（feed:…）过滤后归档，或用既有的 POST /api/admin/memory-archive —— 归档不是真删，可恢复。',
  )
  return 0
}

// 直接运行时才执行 main —— 测试会 import 本文件来调 `main()` / `parseArgs()`，
// 没有这道闸门的话"一 import 就喂了一次"，那是测试里最难查的一类副作用。
//
// 判据用 `pathToFileURL` 而不是手拼 `file://`：Windows 的盘符、空格、非 ASCII 路径
// 手拼必错（而且错法是"静默地什么都不做" —— 命令行看起来跑成功了）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
