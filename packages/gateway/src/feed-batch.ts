/**
 * 投喂**子系统**的调度面：**任意大的输入** → 系统切分 → 分批投入 → 段间让出 → 会话记账 → 汇总。
 *
 * ## 它解决的是什么（用户 2026-10-09 的口径）
 *
 * > 让系统自动切分，分段投入，这样可以应对**用户自己塞入的巨量记忆**
 * > （尤其是**试图塞入一个巨大的数据库**的）
 *
 * ⇒ **切分由系统做，不由调用方做**。所以这里接受四种输入形态
 * （一段任意大的文本 / 多段 items / 一个流 / 文件或目录），
 * 并且**任何形态都不假设"调用方已经切好了"**。
 *
 * ## ★ 段间为什么必须让出控制权（2026-10-09 真机实测的教训）
 *
 * `renderView()` 曾把整张中期记忆表（10,794 条 / **1,504,850 token**）全量渲染进提示词
 * ⇒ `CONTEXT_WINDOW_EXCEEDED` ⇒ **压缩永远不触发**（压缩看上下文占比，而上下文一开始就爆）
 * ⇒ `compaction_epoch` 一直是 0、`long_memory_entries` 一直是 0
 * ⇒ 四层流水线（短期→中期→长期→冷）**第一层就堵死**。
 *
 * ⇒ 所以这里**不许一口气把 N 段全写进中期记忆**：每批之间 `await` 一个可配的间隔
 * （`feed.batchIntervalMs`；0 = 只让事件循环，走 `setImmediate`）。
 *
 * ⚠️ **让出的是"事件循环与别的进程"，不是"压缩一定会跑"**：
 * 压缩按**轮次/上下文占比**判定，不按时间 —— 投喂在同一轮里跑多久都不会自己触发压缩。
 * 真正的护栏是"单条天花板（`feed.chunkMaxTokens`）+ 中期窗口预算"，
 * 让出给的是"别的进程（gateway 轮次、沉降循环、面板）有机会动"以及"这个进程别卡死"。
 * 注释与文档都按这个口径写，**不承诺做不到的事**。
 *
 * ## 为什么每批还是走 `feedMemory()`（而不是在这里写库）
 *
 * 真实的沉降路径只有一条（`insertLongEntry` / `appendMidEntry` / 检索判重 / 归档），
 * 都在 `feedMemory()` 里。这里只做**调度**：切多大、分几批、批间停多久、怎么记账。
 * 每批一次 `feedMemory()`，带上 `indexOffset`（段落序号全局连续 ⇒ **同一个来源 = 同一个 scope**，
 * 与"调用方自己拆成多个来源"相比：重导幂等、批量大小可调而不动 id、面板上仍然是一份文档一个来源）。
 *
 * ## 批与"tail 归档"的分工
 *
 * 长期记忆的重导语义包含"上一版多出来的段落 ⇒ 归档"。
 * 分批之后**不能每批都去归档**（那会把别的批次的段判成"多出来的"），
 * 所以每批传 `archiveLeftovers: false`，由这里在**全部喂完之后**统一扫一次
 * （`archiveFeedLeftovers()` —— 与核心单次调用用的是同一个实现，不是第二套）。
 *
 * ## ★★ 「投喂前更新」是**机制**：源刷新闸门（2026-10-09 用户裁定）
 *
 * > 以后务必在任何试图投喂前更新即可，不必限制立刻更新。
 *
 * | 输入 | 刷新声明 | 为什么 |
 * | :--- | :--- | :--- |
 * | `text` / `items` | **不声明 ⇒ 自动「无源」** | 它**就是**当下给的内容，没有"陈旧"这个概念 |
 * | `paths` / `stream` | **不声明 ⇒ 直接打回** | 它是某个源的**快照**；"忘了刷新"与"没有源"在代码里长得一模一样 |
 *
 * 刷新的**顺序**是这条机制的要害：**先刷新 → 再展开输入（列目录 / 读文件）→ 才开始写**。
 * 反过来的话，刷新刚生成的文件不会被看见（那就又回到"用陈旧数据重喂"）。
 * 这条顺序由守卫测试钉着（读源码断言调用点的先后）。
 *
 * 刷新失败 ⇒ **不写任何记忆**（用陈旧数据重喂是破坏性的，尤其"清空重喂"）；
 * 想用本地那份陈旧的必须**显式** `allowStale`，那时会如实标出来并记进会话。
 *
 * @module @forlife/gateway/feed-batch
 */
import type { DatabaseSync } from 'node:sqlite'
import { setImmediate as yieldImmediate, setTimeout as delay } from 'node:timers/promises'

import { defaultFor } from '@forlife/contracts'

import { refineFeedChunk, streamFeedChunks, withPieceSuffix, type FeedPiece } from './feed-chunk.ts'
import { feedDigestNote } from './feed-frame.ts'
import { resolveFeedRefresh, runFeedRefresh, type FeedRefreshOutcome, type FeedRefreshSpec } from './feed-refresh.ts'
import {
  deriveFeedSource,
  deriveFeedSummary,
  archiveFeedLeftovers,
  FEED_DELETE_HINT,
  feedMemory,
  splitIntoFeedChunks,
  type FeedChunkResult,
  type FeedItem,
  type FeedKind,
  type FeedResult,
} from './feed.ts'
import { listFeedFiles, readFeedFilePieces, sourceOfFeedFile } from './feed-ingest.ts'
import { advanceFeedSession, beginFeedSession, endFeedSession } from './feed-session.ts'

/** 一批投入的进度读数（给 CLI 打印、给会话记账）。 */
export interface FeedProgress {
  /** 当前这一批是哪个单元（文件相对路径 / 一段文本）。 */
  readonly label: string
  readonly source: string
  /** 已经完成的批数。 */
  readonly batches: number
  /** 已经投入的段数（含判重跳过的）。 */
  readonly chunks: number
  /** 这一批几段。 */
  readonly batchChunks: number
  readonly tokens: number
}

/** 一次投喂请求（**四种输入形态只能给一个**）。 */
export interface FeedRequest {
  readonly as: FeedKind
  /** 来源：不给时按内容派生（流式输入**必须**给，见 `feedInput` 的说明）。 */
  readonly source?: string
  readonly dryRun?: boolean
  /** 形态①：一段任意大的文本。 */
  readonly text?: string
  /** 形态②：多段（每段可选摘要/实体）。 */
  readonly items?: readonly FeedItem[]
  /** 形态③：一个文本流（调用方已经打开的东西）。**必须**配 `source`。 */
  readonly stream?: AsyncIterable<string> | Iterable<string>
  /** 形态④：文件或目录（附件决策在里面：后缀、跳过目录、二进制）。 */
  readonly paths?: readonly string[]
  /** 整份输入共用的实体（`items` 自带的优先）。 */
  readonly entities?: readonly string[]
  /**
   * **整块投喂**：不把每个 item 的正文按空行/标题行拆段，**一个 item = 一段**。
   *
   * 用户裁定 C-② / D5：条目化/总结化/印象化该由**模型**做，喂食只负责把
   * 「10k–50k token 等级的原始片段」整块交给它。默认 `false` = 按段落拆（历史行为）。
   *
   * ⚠️ 它**只关段落切分**；`feed.chunkMaxTokens` 那道天花板照旧生效（那是防撑爆）。
   * ⚠️ 它也**不影响来源派生**（`deriveSourceOfItems` 始终按段落切）——
   *    同一份内容整块喂与分段喂必须落在**同一个来源**，否则会变成两份互相不覆盖的记忆。
   */
  readonly whole?: boolean
  /**
   * ★ **投喂前更新**（源刷新）的声明 —— 见模块头那张表。
   *
   *  - **不给**：`text`/`items` 自动算「无源」；`paths`/`stream` **直接打回**（必须先说清源怎么刷）；
   *  - `{kind:'none', reason}`：显式声明"没有外部源"（reason 会记进会话，供事后追溯）；
   *  - `{kind:'default'}`：用**部署配置**的刷新命令（环境变量 `FORLIFE_FEED_REFRESH_COMMAND`
   *    优先，其次基线 `feed.refresh.command`）—— 凭据留在 `.runtime/`，不进仓库；
   *  - `{kind:'command', command, args?}`：跑这条命令把源拉新，**成功之后才喂**。
   */
  readonly refresh?: FeedRefreshSpec
  readonly onProgress?: (progress: FeedProgress) => void
  /**
   * 批间让出的实现（**测试注入点**：数"让出了几次"）。
   * 不给就用默认实现（`feed.batchIntervalMs` > 0 时 `setTimeout`，否则 `setImmediate`）。
   */
  readonly yieldBetween?: (ms: number) => Promise<void>
  readonly now?: () => Date
  /** 中止（在批与批之间检查）。 */
  readonly signal?: AbortSignal
}

/** 一个输入单元的投喂结果。 */
export interface FeedUnitResult {
  readonly label: string
  readonly source: string
  readonly result: FeedResult
}

/** 明确跳过的东西（附件决策的结论要如实报出来，不能静默）。 */
export interface FeedSkip {
  readonly label: string
  readonly reason: string
}

/** 一次投喂（可能含多个单元：目录）的结果。 */
export interface FeedRunResult {
  readonly ok: boolean
  readonly error?: string
  readonly units: readonly FeedUnitResult[]
  readonly skipped: readonly FeedSkip[]
  /** 投喂期的模式说明（给调用者/模型看的人话，与提示段同源）。 */
  readonly note: string
  /**
   * ★ 这次投喂**基于哪个版本的源**（源刷新的结果）。
   *
   * 为什么必须带出来：`ok:false` 有两种完全不同的原因（"源没刷新成功"与"内容有问题"），
   * 而调用方（CLI/面板/工具）要能把它们说成不同的人话；
   * 另外"旧 N 条 → 新 M 条（+K）"是用户**唯一**能一眼看出"源里多了东西"的地方。
   */
  readonly refresh?: FeedRefreshOutcome
}

/** 一批里的一段（已经切好、已经带好摘要/实体）。 */
interface PlannedChunk {
  readonly text: string
  readonly piece: FeedPiece
  readonly summary?: string
  readonly entities?: readonly string[]
}

/** 一个待喂的单元（`pieces` 是惰性的：目录有几百个文件时不要一次全读进内存）。 */
interface FeedUnit {
  readonly label: string
  readonly source: string
  readonly items?: readonly FeedItem[]
  readonly pieces?: () => AsyncIterable<string> | Iterable<string>
}

/** 默认的"让出"：给事件循环/别的进程一个窗口（见模块头对"让出 ≠ 压缩一定会跑"的说明）。 */
async function defaultYield(ms: number): Promise<void> {
  if (Number.isFinite(ms) && ms > 0) {
    await delay(ms)
    return
  }
  await yieldImmediate()
}

/** 一批几段：既要 ≤ 配置的批大小，也要 ≤ 核心的单次段数上限（否则每批都会被打回）。 */
function resolveBatchSize(): number {
  const configured = defaultFor<number>('feed.batchMaxChunks')
  const cap = defaultFor<number>('feed.maxItemsPerCall')
  const size = Math.floor(Math.min(configured, cap))
  return Number.isFinite(size) && size >= 1 ? size : 1
}

/** 失败的结果（形状与成功时一致，入口层不用分情况处理）。 */
function failure(error: string): FeedRunResult {
  return { ok: false, error, units: [], skipped: [], note: feedDigestNote() }
}

/**
 * 把 `items` 规划成"已切好的段"。
 *
 * ⚠️ **先按段落切、再按天花板切** —— 顺序不能反，也不能省掉段落那一步：
 * 核心（`feedMemory`）拿到 items 后做的第一件事就是 `splitIntoFeedChunks()`，
 * 所以"一段 = 一个段落（或它的一个天花板切片）"才是**原子**的。
 * 如果这里直接把整份 item 内容当天花板切分的输入，一个计划段里就会含多个段落，
 * 核心会把它们再拆开 ⇒ 计划与实际落库的段数不一致、段落序号错位。
 *
 * 关键点：**只有被切过的片才带显式摘要**（并在尾部标"第 k/N 段"）——
 * 没被切过的段一律**不传摘要**，让核心按老规矩 `deriveFeedSummary()` 派生。
 * 这样"不超过上限"的输入与过去**逐字节一致**（连摘要都一样），
 * 而那正是绝大多数情况。
 */
async function* planFromItems(
  items: readonly FeedItem[],
  entities: readonly string[] | undefined,
  maxTokens: number,
  whole = false,
): AsyncGenerator<PlannedChunk> {
  for (const item of items) {
    // ★ `whole`（用户裁定 C-② / D5）：**不切段落** —— 一个 item 就是一段。
    //   用户的判断：条目化/总结化/**印象化**该由**模型**做，喂食只负责把
    //   「10k–50k token 等级的原始片段」整块交出去。
    //   ⚠️ **天花板那一步照旧**（下面 `refineFeedChunk` 不动）：那是**防撑爆上下文**。
    //   ⚠️ 也**不许**影响 `deriveSourceOfItems()`：同一份内容整块喂与分段喂必须派生
    //      同一个来源，否则会变成两份互相不覆盖的记忆。
    //   ⚠️ **核心层也必须收到 `whole`**（见 `feedUnit` 里 `feedMemory` 的调用）——
    //      只改这一层的话，核心会把这"一片整块"再切开（实测 `actual: 3`）。
    const paragraphs = whole ? [item.content] : splitIntoFeedChunks(item.content)
    for (const paragraph of paragraphs) {
      const pieces = refineFeedChunk(paragraph, maxTokens)
      const split = pieces.length > 1
      for (const piece of pieces) {
        const chosen = item.summary ?? (split ? deriveFeedSummary(piece.text) : undefined)
        const summary = chosen === undefined ? undefined : withPieceSuffix(chosen, piece)
        const owned = item.entities ?? entities
        yield {
          text: piece.text,
          piece,
          ...(summary === undefined ? {} : { summary }),
          ...(owned === undefined || owned.length === 0 ? {} : { entities: owned }),
        }
      }
    }
  }
}

/** 把**流**规划成"已切好的段"（内存只留一个窗口，见 `feed-chunk.ts`）。 */
async function* planFromPieces(
  pieces: AsyncIterable<string> | Iterable<string>,
  entities: readonly string[] | undefined,
  maxTokens: number,
): AsyncGenerator<PlannedChunk> {
  for await (const piece of streamFeedChunks(pieces, { maxTokens })) {
    // 流式切分只知道"这一片被切过"（parts 为 undefined）或"这一段没切过"（parts = 1）。
    // 被切过的片才加后缀；没切过的一律不传摘要（与今天一致）。
    const split = piece.parts === undefined || piece.parts > 1
    const summary = split ? withPieceSuffix(deriveFeedSummary(piece.text), piece) : undefined
    yield {
      text: piece.text,
      piece,
      ...(summary === undefined ? {} : { summary }),
      ...(entities === undefined || entities.length === 0 ? {} : { entities }),
    }
  }
}

/** 一次"投喂单元"的上下文（把参数收成一个对象，避免十几个位置参数）。 */
interface UnitContext {
  readonly db: DatabaseSync
  readonly as: FeedKind
  readonly source: string
  readonly dryRun: boolean
  readonly batchSize: number
  readonly intervalMs: number
  readonly yieldBetween: (ms: number) => Promise<void>
  readonly signal?: AbortSignal | undefined
  readonly onBatch: (progress: FeedProgress & { readonly label: string }) => void
  readonly label: string
  /**
   * ★ **整块投喂**（用户裁定 C-②）。**两层都要知道它**：
   *  - 规划层（`planFromItems`）拿它决定"一个 item 切不切段"；
   *  - **核心层**（下面 `feedMemory` 的调用）也必须收到它 ——
   *    否则核心会把"那一片整块"**再切一次**，于是计划 1 段、实际落库 3 段。
   *    （2026-10-10 实测栽过：只传规划层 ⇒ 守卫测试报 `actual: 3, expected: 1`。）
   */
  readonly whole: boolean
}

/**
 * 喂一个单元：切好的段 → 攒批 → `feedMemory()` → 让出 → 下一批 → 收尾 tail 归档。
 *
 * @param context - 见 {@link UnitContext}。
 * @param chunks - 已切好的段（惰性；流式输入时它是边读边产出的）。
 * @returns 汇总成一个 `FeedResult`（形状与核心一致，入口层不用分情况）。
 */
async function feedUnit(context: UnitContext, chunks: AsyncGenerator<PlannedChunk>): Promise<FeedResult> {
  const { db, as, dryRun } = context
  const source = context.source
  const details: FeedChunkResult[] = []
  /** 全部计划段的 id：收尾扫 tail 归档时"这些是本次喂到的"，其余才可能是上一版多出来的。 */
  const keepIds = new Set<string>()
  let batches = 0
  let chunksFed = 0
  let tokens = 0
  let revision: number | undefined
  let failureReason: string | undefined

  const iterator = chunks[Symbol.asyncIterator]()
  let pending: PlannedChunk | undefined
  let exhausted = false

  for (;;) {
    const batch: PlannedChunk[] = []
    if (pending !== undefined) {
      batch.push(pending)
      pending = undefined
    }
    while (batch.length < context.batchSize && !exhausted) {
      const step = await iterator.next()
      if (step.done === true) {
        exhausted = true
        break
      }
      batch.push(step.value)
    }
    if (batch.length === 0) break

    if (context.signal?.aborted === true) {
      failureReason = '投喂被中止（signal）—— 已经写入的批次保持原样，没有回滚'
      break
    }

    const from = chunksFed
    const result = feedMemory(db, {
      items: batch.map((chunk) => ({
        content: chunk.text,
        ...(chunk.summary === undefined ? {} : { summary: chunk.summary }),
        ...(chunk.entities === undefined ? {} : { entities: chunk.entities }),
      })),
      as,
      // ★ 显式来源：多批必须落在**同一个 scope**（否则"同一份文档"会变成 N 个来源，
      //   批量大小一调、id 全变、面板上也不再是一份东西）
      source,
      ...(dryRun ? { dryRun: true } : {}),
      indexOffset: from,
      // ★ 核心层也必须收到 whole（见 `UnitContext.whole` 的说明）
      ...(context.whole ? { whole: true } : {}),
      // tail 归档由本函数在全部喂完之后统一做（每批都做会把别批的段判成"多出来的"）
      archiveLeftovers: false,
    })
    if (!result.ok) {
      failureReason = result.error ?? '喂食失败'
      break
    }

    batches += 1
    chunksFed += result.chunkCount
    tokens += result.tokens
    details.push(...result.details)
    for (const detail of result.details) {
      // 判重跳过的段也是"本次喂到的"（与核心单次调用的 touched 语义一致）
      if (detail.index >= 0) keepIds.add(detail.id)
    }
    if (result.revision !== undefined) revision = result.revision
    context.onBatch({ label: context.label, source, batches, chunks: chunksFed, batchChunks: batch.length, tokens })

    if (batch.length === context.batchSize) {
      // 先探一眼有没有下一批：有才让出（否则每次都在最后白等一个间隔）
      const step = await iterator.next()
      if (step.done === true) exhausted = true
      else {
        pending = step.value
        await context.yieldBetween(context.intervalMs)
      }
    }
  }

  // 一段都没喂出来（空输入 / 全是空白）⇒ 让**核心**去说那句话。
  // 为什么不在这里写文案：文案只有一处真源（四处入口看到的必须一模一样）。
  if (batches === 0 && failureReason === undefined) {
    return feedMemory(db, { items: [], as, source, ...(dryRun ? { dryRun: true } : {}) })
  }

  // 收尾：长期记忆"上一版多出来的段落 ⇒ 归档"（与核心同一个实现）。
  // ⚠️ 只有真的喂过（batches > 0）才扫：一段都没喂时 keepIds 是空的，
  //    拿它去扫会把**这个来源的全部条目**判成"多出来的"并归档掉（灾难）。
  if (failureReason === undefined && batches > 0 && as === 'knowledge') {
    const tail = archiveFeedLeftovers(db, { scope: `feed:${source}`, keepIds, dryRun })
    details.push(...tail)
  }

  const countOf = (action: string): number => details.filter((detail) => detail.action === action).length
  return {
    ok: failureReason === undefined,
    ...(failureReason === undefined ? {} : { error: failureReason }),
    as,
    source,
    scope: `feed:${source}`,
    dryRun,
    chunkCount: chunksFed,
    inserted: countOf('inserted'),
    updated: countOf('updated'),
    unchanged: countOf('unchanged'),
    duplicates: countOf('duplicate'),
    archived: countOf('archived'),
    tokens,
    ...(revision === undefined ? {} : { revision }),
    details,
    hint: FEED_DELETE_HINT,
    batches,
  }
}

/**
 * 投喂（**子系统的唯一入口**）。
 *
 * ## 来源怎么定
 *
 *  - 显式给了 `source` ⇒ 用它；
 *  - `paths` ⇒ 每个文件用"相对当前目录的路径"（可重导的稳定身份）；
 *  - `text` / `items` ⇒ 按**切分前**的段落文本派生（与核心同一条派生式：
 *    同样的内容重复喂是幂等的，不同的内容互不覆盖，来源也不随天花板变）；
 *  - `stream` ⇒ **必须**显式给 `source`：来源要参与段落 id 的派生，
 *    而流只能读一遍（边读边喂），**没法先算完哈希再决定往哪写** ——
 *    与其在这里缓冲整个输入（那就不是流式了），不如明确报错让人给一个来源。
 *
 * @param db - 已迁移的数据库连接。
 * @param request - 见 {@link FeedRequest}。
 * @returns 每个单元的明细 + 跳过项 + 模式说明 + 源刷新结果（**不抛异常**：入口层要把它变成 400/一行错误）。
 */
export async function feedInput(db: DatabaseSync, request: FeedRequest): Promise<FeedRunResult> {
  const as = request.as
  const dryRun = request.dryRun === true
  const maxTokens = defaultFor<number>('feed.chunkMaxTokens')
  const batchSize = resolveBatchSize()
  const intervalMs = defaultFor<number>('feed.batchIntervalMs')
  const yieldBetween = request.yieldBetween ?? defaultYield
  const now = request.now ?? ((): Date => new Date())
  const explicit = request.source?.trim()

  const forms = [request.text !== undefined, request.items !== undefined, request.stream !== undefined, request.paths !== undefined].filter(
    (given) => given,
  ).length
  if (forms === 0) return failure('没有可喂的内容（要给 text / items / stream / paths 之一）')
  if (forms > 1) return failure('一次只能给一种输入（text / items / stream / paths 只能有一个）')
  // 流式输入必须显式给来源：来源要参与段落 id 的派生，而流只能读一遍
  //（这条是**请求形状**的校验，排在刷新闸门之前 —— 让人先看到"少了什么"，而不是"刷新没配"）
  const streamSource = explicit === undefined || explicit === '' ? undefined : explicit
  if (request.stream !== undefined && streamSource === undefined) {
    return failure(
      '流式输入必须显式给 source：来源要参与段落 id 的派生，而流只能读一遍（没法先算完哈希再决定往哪写）',
    )
  }

  // ── ★★ 闸门一：**投喂前必须先刷新源**（用户 2026-10-09 裁定，见模块头）──────────
  //
  // ⚠️ 顺序是要害：**刷新 → 展开输入 → 才开始写**。放在展开之后的话，
  //    刷新刚生成的文件不会被看见（那正是"用陈旧数据重喂"的原样复现）。
  const resolvedRefresh = resolveFeedRefresh(request.refresh, {
    hasContent: request.text !== undefined || request.items !== undefined,
    hasFiles: request.paths !== undefined,
    hasStream: request.stream !== undefined,
  })
  if (!resolvedRefresh.ok) return failure(resolvedRefresh.error)
  const refresh = await runFeedRefresh(db, resolvedRefresh.spec, { now: now() })
  if (!refresh.ok) {
    // 刷新失败 ⇒ **一个字都不写**。把刷新结果一起带出去：调用方要能分辨
    // "源没拉成功"与"内容有问题"（两种 ok:false 的处理方式完全不同）。
    return { ok: false, error: `投喂前的源刷新未通过：${refresh.reason}`, units: [], skipped: [], note: feedDigestNote(), refresh }
  }

  // `useOutputAsText`：把刷新命令的 stdout **当作要喂的内容**（"刷新出来直接喂"，不留中间文件）。
  // 与其它输入形态互斥：内容从哪来必须只有一个答案，否则"到底喂了哪一份"说不清。
  const refreshText = refresh.text
  if (refreshText !== undefined && forms > 0) {
    return {
      ok: false,
      error: '刷新声明说了 useOutputAsText（用命令输出当内容），就不能再给 text/items/stream/paths —— 内容只能有一个来源',
      units: [],
      skipped: [],
      note: feedDigestNote(),
      refresh,
    }
  }
  if (refreshText !== undefined && refreshText.trim() === '') {
    return { ok: false, error: '刷新命令成功了，但它的输出是空的 —— 没有可喂的内容', units: [], skipped: [], note: feedDigestNote(), refresh }
  }

  const units: FeedUnit[] = []
  const skipped: FeedSkip[] = []

  if (request.items !== undefined) {
    const items = request.items.filter((item) => item.content.trim() !== '')
    if (items.length === 0) return failure('没有可喂的内容（items 为空，或全是空白）')
    const source = explicit !== undefined && explicit !== '' ? explicit : deriveSourceOfItems(as, items)
    units.push({ label: `items（${String(items.length)} 段）`, source, items })
  } else if (request.text !== undefined) {
    if (request.text.trim() === '') return failure('没有可喂的内容（text 是空白）')
    const items: readonly FeedItem[] = [{ content: request.text }]
    const source = explicit !== undefined && explicit !== '' ? explicit : deriveSourceOfItems(as, items)
    units.push({ label: `一段文本（${String(request.text.length)} 字）`, source, items })
  } else if (request.stream !== undefined && streamSource !== undefined) {
    units.push({ label: '流式输入', source: streamSource, pieces: () => request.stream as AsyncIterable<string> })
  } else if (refreshText !== undefined) {
    // ★ 「刷新出来直接喂」：内容就是刷新命令的 stdout（不留中间文件、也就没有"文件是不是最新的"这个问题）
    const items: readonly FeedItem[] = [{ content: refreshText }]
    const source = explicit !== undefined && explicit !== '' ? explicit : deriveSourceOfItems(as, items)
    units.push({ label: `刷新输出（${String(refreshText.length)} 字）`, source, items })
  } else {
    const paths = request.paths ?? []
    // ⚠️ 这一段必须跑在**刷新之后**（见闸门一）：刷新命令刚写出来的文件要能被看见
    for (const target of paths) {
      let files: readonly string[]
      try {
        files = listFeedFiles(target)
      } catch (error) {
        skipped.push({ label: target, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (files.length === 0) {
        skipped.push({ label: target, reason: '没找到 .md / .txt 文件' })
        continue
      }
      for (const file of files) {
        const label = sourceOfFeedFile(file)
        units.push({ label, source: explicit !== undefined && explicit !== '' ? explicit : label, pieces: () => readFeedFilePieces(file) })
      }
    }
    // 同一个来源 = 同一份东西：多个文件共用一个来源会互相覆盖（核心对这条有硬要求）
    if (explicit !== undefined && explicit !== '' && units.length > 1) {
      return failure('source 只能配**单个**文件：同一个来源是"同一份东西"，多个文件共用它会互相覆盖')
    }
  }

  if (units.length === 0) {
    const first = skipped[0]
    return {
      ok: false,
      error: first === undefined ? '没有可喂的内容' : `${first.label}：${first.reason}`,
      units: [],
      skipped,
      note: feedDigestNote(),
      refresh,
    }
  }

  // 会话记账：只在**真的会写**的时候开（dryRun 一个字都不写，"我在消化记忆"会是假话）。
  // 刻意**跨单元**保持一条记录（目录几百个文件时不该来回消失/出现）。
  // ★ 刷新的结果一并记进会话：事后要能回答"这次投喂基于**哪个版本**的源"（用户 2026-10-09 的要求）。
  const recordSession = !dryRun
  if (recordSession) beginFeedSession(db, { source: units[0]?.source ?? '', as, now: now(), refresh })

  const results: FeedUnitResult[] = []
  let runError: string | undefined
  /**
   * 跨单元的累计进度（目录一次喂几百个文件时，进度**不许往回跳**）。
   *
   * 每个单元自己的计数从 0 开始（它只知道自己那几批），但报给会话/调用者的必须是
   * **整次投喂**的口径 —— 否则提示段里会出现"已接收 40 段"接着变成"已接收 3 段"，
   * 而那段措辞说的是"记忆一段一段浮上来"。
   */
  let runChunks = 0
  let runBatches = 0
  let runTokens = 0
  const noteError = (message: string): void => {
    if (runError === undefined) runError = message
  }
  // 一开始就有的跳过项（路径不存在 / 目录里没有资料）也算"这次没喂成"：
  // 与老 CLI 的行为一致（它会打一行 ✗ 并以非零退出码结束，但**仍然喂完其它的**）。
  for (const skippedItem of skipped) noteError(`${skippedItem.label}：${skippedItem.reason}`)

  try {
    for (const unit of units) {
      if (request.signal?.aborted === true) {
        noteError('投喂被中止（signal）')
        break
      }
      const chunks =
        unit.items !== undefined
          ? planFromItems(unit.items, request.entities, maxTokens, request.whole === true)
          : planFromPieces((unit.pieces as () => AsyncIterable<string> | Iterable<string>)(), request.entities, maxTokens)
      try {
        const result = await feedUnit(
          {
            db,
            as,
            source: unit.source,
            dryRun,
            // ★ 整块投喂：**规划层与核心层都要收到**（见 `UnitContext.whole`）。
            //   ⚠️ 目前只对 `items` 形态生效（`planFromPieces` 那条流式/路径的路
            //   还没有整块语义）—— 这是**已知边界**，不是漏了。
            whole: request.whole === true,
            batchSize,
            intervalMs,
            yieldBetween,
            signal: request.signal,
            label: unit.label,
            onBatch: (progress) => {
              // 报出去的是**整次投喂**的累计口径（见 runChunks 的说明）
              const total: FeedProgress = {
                ...progress,
                batches: runBatches + progress.batches,
                chunks: runChunks + progress.chunks,
                tokens: runTokens + progress.tokens,
              }
              if (recordSession) {
                advanceFeedSession(db, {
                  source: total.source,
                  as,
                  chunks: total.chunks,
                  batches: total.batches,
                  tokens: total.tokens,
                  now: now(),
                })
              }
              request.onProgress?.(total)
            },
          },
          chunks,
        )
        results.push({ label: unit.label, source: unit.source, result })
        runChunks += result.chunkCount
        runBatches += result.batches ?? 0
        runTokens += result.tokens
        if (!result.ok) noteError(`${unit.label}：${result.error ?? '喂食失败'}`)
      } catch (error) {
        // 附件决策的结论（二进制）与 IO 失败都走这里：**如实报出来**，
        // 不回滚已经写入的批，也不因此停掉后面的文件（半途而废更难收拾）。
        skipped.push({ label: unit.label, reason: error instanceof Error ? error.message : String(error) })
        noteError(`${unit.label}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    if (recordSession) endFeedSession(db)
  }

  return {
    ok: runError === undefined,
    ...(runError === undefined ? {} : { error: runError }),
    units: results,
    skipped,
    note: feedDigestNote(),
    refresh,
  }
}

/**
 * 取单一单元的 `FeedResult`（HTTP/工具那条路用）。
 *
 * 为什么不让 `feedInput` 直接返回一个 `FeedResult`：目录投喂天然是**多个单元**
 * （每个文件一个来源），硬挤成一个结果就得丢掉"哪份文件喂成什么样"。
 * 而 HTTP/工具一次只喂一份东西 ⇒ 这里取第一个单元；没有单元时返回 `undefined`
 * （调用方去看 `run.error`）。
 */
export function firstFeedResult(run: FeedRunResult): FeedResult | undefined {
  return run.units[0]?.result
}

/** 按**切分前**的段落文本派生来源（与核心同一条式子，见 `deriveFeedSource`）。 */
function deriveSourceOfItems(as: FeedKind, items: readonly FeedItem[]): string {
  const raw: string[] = []
  for (const item of items) raw.push(...splitIntoFeedChunks(item.content))
  return deriveFeedSource(as, raw)
}
