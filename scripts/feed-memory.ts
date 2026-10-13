/**
 * 手动喂食记忆资料 —— **命令行入口**（文件/目录扫描 + 直接传文本）。
 *
 * ## 它只是入口，不是管道
 *
 * 真正的写入只有一条路：`@forlife/gateway` 的 `feedInput()`（**投喂子系统**：
 * 输入形态与附件决策 → 系统切分 → 分批投入 → 批间让出控制权 → 会话记账），
 * 它与面板接口、后台接口、模型工具是**同一个函数**；
 * 而它**每一批**都调 `feedMemory()`（唯一写入核心，走真实沉降路径）。
 *
 * 这里只做三件事：读参数 / 把进度打印成人话 / 把结果汇总成退出码。
 * 切分、分批、去重、增量更新、归档全部在核心那一侧 ——
 * 它们本来就是记忆系统自己的能力（理由见 `packages/gateway/src/feed.ts` 的模块头）。
 *
 * ## ★ 它现在能接住"任意大"（2026-10-09 用户要求）
 *
 * 以前是"一个文件一口气喂进去"，一个 100 MB、没有空行的导出会被当成**一条**记忆写进去。
 * 现在文件是**流式**读的（内存里是有界的块 + 一个切分窗口），切分由系统做：
 * 太长的段落按句子边界切开，一批一批投入，**批与批之间让出控制权**
 * （间隔见基线 `feed.batchIntervalMs`）—— 让压缩/沉降与别的进程有机会动，
 * 而不是把整份东西一次灌进中期记忆。
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
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  feedInput,
  isFeedKind,
  resolveFeedDbPath,
  splitCommandLine,
  type FeedKind,
  type FeedProgress,
  type FeedRefreshSpec,
  type FeedResult,
  type FeedRunResult,
} from '../packages/gateway/src/index.ts'
// 目录扫描与来源命名的**唯一实现在子系统那一侧**（这里只是给老调用方留个名字，
// 免得"脚本自己又长出一份扫描规则" —— 那份规则曾经就在这里，现在搬走了）
export { listFeedFiles as collectFiles, sourceOfFeedFile as sourceOfFile } from '../packages/gateway/src/feed-ingest.ts'
import { openDatabase } from '../packages/store/src/index.ts'

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
  '  --refresh "<命令>"          ★ 投喂前先跑这条命令把源拉新（成功之后才喂）；',
  '                              命令与凭据不进仓库 —— 也可以用环境变量',
  '                              FORLIFE_FEED_REFRESH_COMMAND 配一次（--refresh default 用它）',
  '  --refresh-output            把刷新命令的 stdout 当作要喂的内容（不留中间文件）',
  '  --no-refresh                ★ 显式声明"这份文件没有外部源"（例如刚手写的资料）',
  '                              文件/目录**必须**二选一：--refresh 或 --no-refresh',
  '  --dry-run                   只算不写：报出会发生什么，一行都不落库',
  '  --db <路径>                 指定数据库（默认 FORLIFE_DB → DSH_HOME → 仓库内 .runtime/dsh）',
  '  --verbose                   逐段打印明细 + 每一批的进度',
  '  --help                      打印这份说明',
  '',
  '大文件/大目录会自动切分并分批投入（批间让出控制权），不需要你先切好。',
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
  /** 源刷新的声明（见 `--refresh` / `--no-refresh`）。 */
  readonly refresh?: FeedRefreshSpec
  /** 用刷新命令的 stdout 当内容（`--refresh-output`）。 */
  readonly refreshOutput: boolean
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
  let refreshLine: string | undefined
  let noRefresh = false
  let refreshOutput = false

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
      case '--refresh':
        refreshLine = next()
        break
      case '--refresh-output':
        refreshOutput = true
        break
      case '--no-refresh':
        noRefresh = true
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
  if (refreshLine !== undefined && noRefresh) throw new Error('--refresh 与 --no-refresh 只能给一个（源要么有、要么没有）')
  if (refreshOutput && refreshLine === undefined) throw new Error('--refresh-output 必须与 --refresh 一起用（没刷新就没有输出）')
  if (refreshOutput && text !== undefined) throw new Error('--refresh-output 与 --text 冲突：内容只能有一个来源')
  if (refreshOutput && paths.length > 0) throw new Error('--refresh-output 与文件/目录冲突：内容只能有一个来源')
  if (refreshLine !== undefined && text !== undefined) {
    // `--text` 的内容是**直接给的**，没有源可刷（要用刷新结果当内容就加 --refresh-output）
    throw new Error('--refresh 与 --text 冲突：--text 的内容是直接给的；要用刷新结果当内容请加 --refresh-output')
  }
  if (source !== undefined && paths.length > 1) {
    // 同一个来源 = 同一份东西 ⇒ 两个文件共用一个来源会互相覆盖（第 0 段更新第 0 段）
    throw new Error('--source 只能配**单个**文件：同一个来源是"同一份东西"，多个文件共用它会互相覆盖')
  }

  // 源刷新的声明（**文件/目录必须二选一**；不给就由子系统打回，这里先给出更贴 CLI 的说法）
  let refresh: FeedRefreshSpec | undefined
  if (noRefresh) {
    refresh = { kind: 'none', reason: '命令行显式声明：这是本地资料，没有外部源（--no-refresh）' }
  } else if (refreshLine !== undefined) {
    if (refreshLine.trim() === '' || refreshLine.trim() === 'default') {
      // 用部署配置的命令（环境变量 FORLIFE_FEED_REFRESH_COMMAND 优先）
      refresh = { kind: 'default', ...(refreshOutput ? { useOutputAsText: true } : {}) }
    } else {
      const { command, args } = splitCommandLine(refreshLine)
      if (command === '') throw new Error('--refresh 的命令是空的')
      refresh = {
        kind: 'command',
        command,
        ...(args.length === 0 ? {} : { args }),
        ...(refreshOutput ? { useOutputAsText: true } : {}),
      }
    }
  } else if (paths.length > 0 && text === undefined) {
    throw new Error(
      '文件/目录必须说明源怎么刷新：--refresh "<命令>"（先拉新再喂），' +
        '或 --no-refresh（显式声明它没有外部源，例如刚手写的资料）。' +
        '为什么必须：文件是某个源的快照，用陈旧数据重喂是**破坏性**的（清空重喂会永久丢掉源里新增的内容）',
    )
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
    ...(refresh === undefined ? {} : { refresh }),
    refreshOutput,
  }
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
  // 批数只在**真的分了批**时报：1 批是常态，报出来只是噪音
  if ((result.batches ?? 1) > 1) parts.push(`${String(result.batches)} 批`)
  return parts.join(' / ')
}

/** 逐段明细（`--verbose`，或"有段没有正常写入"时）。 */
function detailLines(result: FeedResult): string[] {
  return result.details
    .filter((detail) => detail.action !== 'inserted' && detail.action !== 'planned')
    .map((detail) => `    · ${detail.index < 0 ? '上一版' : `第 ${String(detail.index + 1)} 段`} → ${detail.action}：${detail.reason}`)
}

/** 一批的进度行（只有 `--verbose` 才逐批打：几百批刷屏没人看得下去）。 */
function progressLine(progress: FeedProgress): string {
  return (
    `    … 第 ${String(progress.batches)} 批：本批 ${String(progress.batchChunks)} 段，` +
    `累计 ${String(progress.chunks)} 段 / ${String(progress.tokens)} token`
  )
}

/**
 * 主流程。
 *
 * ⚠️ 它是 `async` 的（2026-10-09 起）：投喂子系统要**流式**读文件、并在批与批之间
 * `await` 让出控制权 —— "一气呵成地同步写完"正是它要修掉的毛病。
 *
 * @param argv - 命令行参数。
 * @returns 进程退出码（0 = 全部成功，1 = 有失败）。
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`)
    console.error(`\n${USAGE}`)
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

  const showProgress = options.verbose
  let run: FeedRunResult
  try {
    run = await feedInput(opened.db, {
      as: options.as,
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.paths.length === 0 ? {} : { paths: options.paths }),
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(options.dryRun ? { dryRun: true } : {}),
      // ★ 投喂前更新：刷新是**子系统里的前置步骤**（这里只是把声明传下去，
      //   脚本自己不跑命令 —— 谁都能绕过的"约定"等于没有）
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      // 进度：`--verbose` 逐批打印；否则"分了批"时打一行原地刷新的进度
      //（让人知道它真的在分段投入，而不是卡住了）
      onProgress: (progress) => {
        if (showProgress) console.log(progressLine(progress))
        else if (progress.batches > 1) {
          process.stdout.write(`\r    … 已投入 ${String(progress.chunks)} 段（第 ${String(progress.batches)} 批）`)
        }
      },
    })
  } catch (error) {
    // 意外错误（库损坏之类）：如实说，并且**不再往下走** —— 半途而废更难收拾
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    opened.close()
    return 1
  } finally {
    opened.close()
  }
  if (!showProgress && run.units.some((unit) => (unit.result.batches ?? 1) > 1)) process.stdout.write('\n')

  let ok = run.ok
  // ★ 源刷新那两行：先打（它在"喂了什么"之前发生），而且**失败时这就是唯一的解释**
  if (run.refresh !== undefined) {
    const line = `${run.refresh.ok ? (run.refresh.stale === true ? '⚠ ' : '↻ ') : '✗ '}${run.refresh.note}`
    if (run.refresh.ok) console.log(line)
    else console.error(line)
    if (run.refresh.version !== undefined) console.log(`  源版本：${run.refresh.version}`)
  }
  for (const skipped of run.skipped) console.error(`✗ ${skipped.label}：${skipped.reason}`)
  for (const unit of run.units) {
    const result = unit.result
    if (!result.ok) {
      console.error(`✗ ${unit.label}：${result.error ?? '喂食失败'}`)
      ok = false
      continue
    }
    console.log(`${options.dryRun ? '· ' : '✓ '}${unit.label} → ${summarize(result)}（来源 ${result.source}）`)
    const notable = detailLines(result)
    if (options.verbose) {
      for (const line of notable) console.log(line)
    } else if (notable.length > 0) {
      console.log(`    （${String(notable.length)} 段没有直接写入，加 --verbose 看明细）`)
    }
  }
  if (run.units.length === 0) {
    console.error(`✗ ${run.error ?? '没有可喂的内容'}`)
    ok = false
  } else if (run.ok !== true && run.error !== undefined) {
    console.error(`✗ ${run.error}`)
    ok = false
  }
  if (run.units.length > 0) {
    // 投喂期的模式说明（与提示段/工具返回**同一份措辞**）：CLI 这一侧也要让人看到
    // "现在在消化记忆"，而不是以为刚才那堆东西是"刚刚发生的事"
    console.log(`  ${run.note}`)
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
  process.exit(await main(process.argv.slice(2)))
}
