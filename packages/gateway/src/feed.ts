/**
 * 手动喂食记忆资料 —— **四条入口共用的唯一写入核心**。
 *
 * 四条入口（`scripts/feed-memory.ts` 的文件/目录扫描与 `--text`、`POST /api/forlife/feed`、
 * 后台「喂食记忆」页、模型可调的 `feed_memory` 工具）**都只走这一条写入路**。
 * 各写一套的直接后果是"某一条入口喂进去的东西在沉降/召回/面板上跟正常记忆不一样"，
 * 而那种不一致只有在出事时才被发现。
 *
 * ## 它与「投喂子系统」（`feed-batch.ts`）的分工（2026-10-09 起）
 *
 * 用户的口径是：**喂食要能接住任意大的输入，切分由系统做、不由调用方做**，
 * 而且要**分段投入**（段间让出控制权，别再被一次性灌爆）。
 * 那套调度（输入形态判定 / 切分 / 分批 / 批间让出 / 会话记账 / 进度）在
 * `feed-batch.ts`（`feedInput()`）里，**本文件仍然是唯一的写入核心**：
 * 子系统**每一批**都调一次 `feedMemory()` —— 没有第二套写入、没有第二张表。
 *
 * | 谁 | 管什么 |
 * | :--- | :--- |
 * | `feed-batch.ts` / `feed-ingest.ts` / `feed-chunk.ts` | 任意大输入 → 有界流 → 切分 → 分批 → 批间让出 → 记账 |
 * | **本文件** | 一个批次内的**记忆语义**：来源与 id 对齐、判重、更新、归档、两条写入路 |
 *
 * ## 它走的是**真实沉降路径**，不是旁路
 *
 *  - `as: 'knowledge'` ⇒ `insertLongEntry()`（长期记忆的既有写入路径）——
 *    自动获得 FTS 索引（`segmentForFts` 的中文切分）、HDD 沉降（`settleLongEntries`）、
 *    归档与恢复（`archiveLongMemory` / `restoreLongMemory`）、面板「记忆」页的编辑；
 *  - `as: 'experience'` ⇒ `appendMidEntry()`（中期记忆的既有写入路径）——
 *    自动获得渲染修订号（进 L3 窗口）、压缩（`compaction-engine`）、
 *    碎片化与淘汰（`planFragmentation` / `evictFragments`）。
 *
 * 反过来说：这里**没有**第二套写入、没有第二张表、没有第二个索引。
 *
 * ## ★ 为什么这里**没有**分块算法、没有去重索引、没有删除接口
 *
 * 用户的原话（2026-10-07）：
 *
 * > 「这些功能更多应该由模型自己决定，而强行删除本身依附于长期记忆/中期记忆的管理
 * >   而不需要再有召回的代码。尤其是分块和去重这本就是属于记忆系统的一部分」
 *
 * 逐条落到代码上：
 *
 *  1. **分块**：段落级只做最朴素的"空行或标题行断开"（`splitIntoFeedChunks`）——
 *     这就是人写 Markdown 时的自然段落边界。**复杂分块不在这里**：
 *     什么时候该把一条记忆切成碎片、碎片留多长，PLAN §5.3 已经有一套
 *     （`fragment.maxHintTokens` / 碎片区占比上限），由压缩与碎片维护实现。
 *
 *     ⚠️ 2026-10-09 补上这条取舍的**边界条件**：段落**超过 `feed.chunkMaxTokens`** 时
 *     由 `feed-chunk.ts` 机械切开（句子边界对齐、不重叠）。原因是真机实测发现
 *     "让压缩去处理超长段落"对**单条就超过窗口**的情况**不成立** ——
 *     压缩看的是"上下文占比"，而占比一开始就爆（中期窗口对"单条超预算"的处理是**整窗为空**）。
 *     所以这里多出来的不是"另一套分块器"，而是"单条不许无界"这条**上界**：
 *     **不超过上限时 `refineFeedChunk()` 原样返回一片，整条链路与过去逐字节一致**。
 *  2. **去重**：复用既有的 FTS 检索（`searchLongFts` / `searchMidFts`）拿候选，
 *     再用**与 recall 重复查询同一份**的 `textSimilarity()` 判近似（阈值 `feed.dedupeSimilarity`）。
 *     **没有 sha256 内容指纹表** —— 那正是"平行机制"：两张表迟早对不上，
 *     而且第二张表里的"重复"跟检索看到的东西没有任何关系。
 *  3. **增量更新**：同源重导**更新**已有条目（长期：`updateLongMemory`，
 *     内部就是同 id 再写一次；中期：只追加，见下），不是无脑插新的。
 *  4. **删除/重导**：**不新建删除接口**。要删就用既有的记忆管理 ——
 *     面板「记忆条目」页按来源（`source_scope` = `feed:<来源>`）过滤后归档，
 *     或 `POST /api/admin/memory-archive`。归档不是真删（记忆是不可再生数据），
 *     而且它引用过的中期条目不会断链。
 *
 * ## 来源追踪（增量更新与重导的支点）
 *
 * 来源记在**既有的** `source_scope` 列上（`feed:<来源>`），**没有加字段、没有加表**。
 * 这一列本来就是"这条记忆是从哪来的"：QQ 侧写 `group:88888` / `private:10001`，
 * 喂食写 `feed:<文件名或批次名>`，两个命名空间不重叠、互不干扰。
 * 长期条目的 id 也由「来源 + 段落序号」稳定派生（`feedIdFor`），
 * 于是"重导落在同一行上"是 id 决定的，**不依赖**任何内容指纹索引。
 *
 * **同一个来源 = 同一份东西**（同一份文件的不同版本）。所以不填来源时按**内容**派生一个
 * （同样的内容重复喂是幂等的，不同的内容互不覆盖）—— 见 `feedMemory` 里那段说明。
 * 分段编号用的是**段落在这次输入里的序号**（`feedIdFor` 的 `index`），
 * 所以"在文档头部插入一段"会让后面所有段落整体错位重写 —— 这是已知取舍：
 * 做真正的 diff 对齐是另一件事（需要给每段算内容指纹并维护映射表），
 * 而那正是这里刻意不引入的第二套索引。
 *
 * @module @forlife/gateway/feed
 */
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { estimateTokens, textSimilarity } from '@forlife/memory-core'
import {
  appendMidEntry,
  getMidEntry,
  insertLongEntry,
  listLongEntriesByScope,
  searchLongFts,
  searchMidFts,
  type LongEntryRow,
} from '@forlife/store'

import { archiveLongMemory, updateLongMemory } from './admin/memory-write.ts'
import { refineFeedChunk, withPieceSuffix, type FeedPiece } from './feed-chunk.ts'

/** 喂食目标：知识进长期记忆，经历进中期记忆。 */
export type FeedKind = 'knowledge' | 'experience'

/** 合法的 `as` 取值（HTTP / CLI / 工具层校验用）。 */
export const FEED_KINDS: readonly FeedKind[] = ['knowledge', 'experience']

/** `as` 是不是合法取值（外部输入是字符串，类型收窄必须显式做）。 */
export function isFeedKind(value: unknown): value is FeedKind {
  return value === 'knowledge' || value === 'experience'
}

/**
 * 来源标记的命名空间前缀。
 *
 * 为什么要前缀：`source_scope` 是**共用**列（QQ 侧写 `group:…` / `private:…`）。
 * 加前缀之后"这条是喂进来的"与"这条是聊出来的"一眼可分，
 * 面板上按 `feed:` 搜索就能列出全部喂食条目（删除/恢复都走那条既有路径）。
 */
export const FEED_SCOPE_PREFIX = 'feed:'

/** 一条待喂食的资料（一段话 + 可选摘要/实体）。 */
export interface FeedItem {
  /** 正文。空白的会被丢掉（不写空记忆）。 */
  readonly content: string
  /** 可选摘要；不给就按首段自动截断（长度上限见基线 `feed.summaryMaxChars`）。 */
  readonly summary?: string
  /** 可选实体（人名 / 项目名 / 技术名）。 */
  readonly entities?: readonly string[]
}

/** 一次喂食的输入。 */
export interface FeedOptions {
  readonly items: readonly FeedItem[]
  readonly as: FeedKind
  /**
   * 来源（文件名 / 批次名 / `model` / `api`）。
   *
   * ⚠️ **同一个来源 = 同一份东西**：长期记忆的同源重导会**更新**已有条目
   * （这正是"增量更新"要的语义）。所以"两段互不相干的内容"必须用**两个不同的来源**，
   * 否则后一次会把前一次盖掉（结果里会如实报 `updated`，但那是事后才知道）。
   *
   * 不填时按**内容**派生一个来源：同样的内容重复喂是幂等的，不同的内容互不覆盖。
   * 想让人名可读、想按文件重导，就显式给一个稳定的来源名。
   */
  readonly source?: string
  /** 只算不写：返回"会发生什么"，一行都不落库（CLI `--dry-run` / 面板预览）。 */
  readonly dryRun?: boolean
  /**
   * 段落序号的**全局偏移**（投喂子系统分批时用）。
   *
   * 为什么要它：段落 id 是「来源 + 段落序号」派生的（`feedIdFor`），
   * 而分批投喂如果每批都从 0 开始编号，第二批的第 0 段就会**顶掉**第一批的第 0 段。
   * 传了偏移之后：同一个来源 = **同一个 scope**、序号全局连续，
   * 于是"批量大小怎么调"都不影响 id（调参不会让整份文档重写一遍）。
   *
   * `details[].index` 报的也是**加上偏移后**的序号（"这次输入"= 整份输入，不是一个批次）。
   */
  readonly indexOffset?: number
  /**
   * 本次调用是否负责"把上一版多出来的段落归档"（默认 `true`，与历史行为一致）。
   *
   * 分批时必须传 `false`：每批都去扫一遍会把**别的批次**的段落判成"上一版多出来的"并归档掉。
   * 收尾那一次归档由调度方在全部喂完之后调用 {@link archiveFeedLeftovers} 完成
   * （与这里用的是同一个实现，不是第二套）。
   */
  readonly archiveLeftovers?: boolean
  /**
   * **整块投喂**：不要把 item 的正文按空行/标题行拆段，一个 item 就是**一段**。
   *
   * ## 为什么需要（用户 2026-10-09 裁定 C-②）
   *
   * 原行为是"每段写一条"，于是 `.runtime/chat-feed-v2` 的 283 段产出 **11,114 条**
   * （一段 50~77 条），条目 token 中位数只有 **106** —— **记忆被切成了碎片**。
   * 用户的判断是：**条目化/总结化/印象化应当由模型来做，不该由喂食机制替它决定**；
   * 喂食只该把 **10k–50k token 的原始片段**整块交给模型。
   *
   * ⇒ 这个开关就是关掉那层"替模型做决定"的切分。
   *
   * ## ⚠️ 它**只关段落切分，不关天花板**
   *
   * `feed.chunkMaxTokens` 那道**天花板**照旧生效（见下面 ①b）——
   * 目的是"别一次撑爆上下文"，而那是**保护**，不是替模型做决定。
   * 「整块」与「有上限」不矛盾：把 `feed.chunkMaxTokens` 定在 10k–50k 这一档，
   * 就是"整块喂进去、但单条不许无限大"。
   */
  readonly whole?: boolean
}

/** 一段资料的处理结果。 */
export type FeedAction =
  /** 新写入。 */
  | 'inserted'
  /** 同源重导覆盖了已有条目（内容变了）。 */
  | 'updated'
  /** 同源重导且内容一致 —— 不必重写。 */
  | 'unchanged'
  /** 判为已有记忆的近似重复 —— 跳过（附 `matchedId` 与相似度）。 */
  | 'duplicate'
  /** 上一版多出来的段落，已交给既有的归档能力。 */
  | 'archived'
  /** `dryRun` 下的预览动作（没有落库）。 */
  | 'planned'

/** 单段的处理明细。 */
export interface FeedChunkResult {
  /**
   * 该段在**这次输入**里的序号（从 0 起，跨 item 连续）。
   *
   * 分批投喂时它是**加上 `indexOffset` 之后**的全局序号（整份输入的口径），
   * 所以同一个来源的两批之间不会出现两个"第 0 段"。
   * 上一版多出来的那些段（归档项）固定报 `-1`。
   */
  readonly index: number
  /** 目标条目 id（`archived` 的段是其上一版留下的那个 id）。 */
  readonly id: string
  readonly action: FeedAction
  /** 人话原因（面板与 CLI 直接显示这行）。 */
  readonly reason: string
  /** 该段的 token 估算（真实估算，不是 0）。 */
  readonly tokenCount: number
  /** 判为重复时的近似相似度（0..1）。 */
  readonly similarity?: number
  /** 判为重复时撞上的那条记忆 id。 */
  readonly matchedId?: string
  /**
   * `action === 'planned'` 时（`dryRun`）**本来会做**什么。
   *
   * 为什么不直接把 `action` 写成"本来会做的动作"：那样 `inserted: 2` 会在
   * "一个字都没写"的预演里出现，而计数是最容易被当成事实的东西 ——
   * 宁可让调用方多读一个字段，也不要让一个会撒谎的数字出现在结果里。
   */
  readonly wouldBe?: FeedAction
}

/** 一次喂食的结果。 */
export interface FeedResult {
  /** 输入是否被接受（`false` 时看 `error`，`details` 为空）。 */
  readonly ok: boolean
  readonly error?: string
  readonly as: FeedKind
  /** 实际使用的来源名。 */
  readonly source: string
  /** 落在库里的来源标记（`feed:<来源>`）。删除/过滤时用这个值。 */
  readonly scope: string
  readonly dryRun: boolean
  /** 分块后的段数。 */
  readonly chunkCount: number
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  readonly duplicates: number
  readonly archived: number
  /** 各段 token 估算之和（真实读数）。 */
  readonly tokens: number
  /** 写入后的渲染修订号（只有 `experience` 会推进它）。 */
  readonly revision?: number
  /** 逐段明细。 */
  readonly details: readonly FeedChunkResult[]
  /** 给人看的一句话（删除/重导该怎么做）。 */
  readonly hint: string
  /**
   * 这次投喂切了几批（**只有投喂子系统**会填；直接调 `feedMemory()` 时没有这个字段 = 一批）。
   *
   * 为什么要报出来：批数是"段间让出控制权"的可见证据 ——
   * 用户看到"1 批"会以为又是"一口气灌进去"，看到"37 批 / 每批之间让出"才敢相信压缩跟得上。
   */
  readonly batches?: number
}

/**
 * 「怎么删掉喂进来的东西」——**指向既有记忆管理，不是新接口**。
 *
 * 写成常量而不是散在各处：四条入口显示的是**同一句话**，
 * 否则用户会在 CLI 里看到一种说法、在面板上看到另一种。
 */
export const FEED_DELETE_HINT =
  '删除不用专门的接口：到后台「记忆条目」页按来源（feed:…）过滤后归档，' +
  '或用既有的 POST /api/admin/memory-archive（restore=true 可恢复）。' +
  '归档不是真删 —— 记忆是不可再生数据，且它引用过的中期条目不会断链。'

// ── 分块：最朴素的段落切分 ───────────────────────────────────────────────────

/**
 * 把一段文本切成"段落"：**空行断开**，`#`~`######` 标题行也断开。
 *
 * ★ 就这么多 —— **段落级的分块策略属于记忆系统本身**（用户的明确要求）。这里刻意不做：
 * 定长滑窗、按 token 预算切、句子边界对齐、重叠窗口……那些一旦做进来，
 * 就会长成"喂食专用的分块器"，与压缩/碎片那套判据并存且互相矛盾。
 *
 * ⚠️ 2026-10-09 起有一层**例外**（`feed-chunk.ts` 的 `refineFeedChunk`）：
 * 单段**超过 `feed.chunkMaxTokens`** 时会被机械切开。这不是"这里的分块策略变了"，
 * 而是补上"单条不许无界"这条**上界** —— 真机教训：一条超过窗口的段落
 * 压缩救不了（压缩看上下文占比，而占比一开始就爆），中期窗口甚至会对它**整窗为空**。
 * **不超过上限时行为与过去逐字节一致**（本函数不变，切分层原样返回一片）。
 *
 * 长段落（不超过上限的那些，比如一整篇没有空行的文章）仍然作为**一整条**进记忆系统，
 * 由既有的压缩/碎片机制决定它的命运（PLAN §5.3 / §4.2）。
 *
 * @param text - 原文（可以是整个文件）。
 * @returns 段落数组（已 trim，空段被丢掉）。
 */
export function splitIntoFeedChunks(text: string): readonly string[] {
  const chunks: string[] = []
  let current: string[] = []
  const flush = (): void => {
    const joined = current.join('\n').trim()
    if (joined !== '') chunks.push(joined)
    current = []
  }
  for (const line of text.split(/\r?\n/)) {
    // 标题行：先收掉上一段，再把标题当新段的开头（标题+紧接着的正文在同一段里）
    if (/^#{1,6}\s/.test(line) && current.length > 0) flush()
    if (line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return chunks
}

/**
 * 摘要：调用方没给时按**首行**截断（上限读基线 `feed.summaryMaxChars`）。
 *
 * 为什么必须有摘要：中期记忆渲染进 L3 窗口的是 `summary`，
 * 长期记忆的列表与检索展示的也是它 —— 空摘要会让这条记忆在界面上是一片空白，
 * 而正文其实很长（`updateLongMemory` 正是因此拒收空摘要）。
 */
export function deriveFeedSummary(content: string): string {
  const max = defaultFor<number>('feed.summaryMaxChars')
  const firstLine = content.split(/\r?\n/).find((line) => line.trim() !== '') ?? content
  const clean = firstLine.replace(/^#{1,6}\s*/, '').trim()
  const base = clean === '' ? content.trim() : clean
  if (base.length <= max) return base
  return `${base.slice(0, max)}…`
}

// ── 来源追踪（id 与 scope 都从来源派生，**不用内容指纹**）─────────────────────

/** 来源标记：`feed:<来源>`。 */
export function feedScopeOf(source: string): string {
  return `${FEED_SCOPE_PREFIX}${source}`
}

/**
 * 缺省来源的派生式：`<as>:<sha1(切分前的段落文本用 \n 连起来) 前 8 位>`。
 *
 * 为什么单独抽出来（而不是留在 `feedMemory` 里算）：**投喂子系统**要在一个批次写库**之前**
 * 就知道来源（多批必须落在同一个 scope 上，见 `feed-batch.ts`），
 * 而它只能以流的方式拿到输入。两处各写一份派生式 = 迟早对不上（"同一个文件换个入口就变成新来源"），
 * 所以真源只有这里一处，两边都调它。
 *
 * ⚠️ 传入的必须是**切分前**的段落文本：这样"天花板调大调小"不会换来源
 * （否则调一次基线，同源的条目就会被当成"另一个文档"重新插一份）。
 *
 * @param as - 喂成知识还是经历（来源的第一段就是它，避免两条路的来源撞车）。
 * @param rawTexts - 切分前的段落文本（顺序即段落序号顺序）。
 * @returns 派生出来的来源名。
 */
export function deriveFeedSource(as: FeedKind, rawTexts: Iterable<string>): string {
  const hash = createHash('sha1')
  let first = true
  for (const text of rawTexts) {
    // 增量 update：与 `rawTexts.join('\n')` 逐字节等价，但不必把整份输入再拼一遍（巨量输入下那是第二份拷贝）
    hash.update(first ? text : `\n${text}`)
    first = false
  }
  return `${as}:${hash.digest('hex').slice(0, 8)}`
}

/**
 * 同源第 `index` 段的目标 id（长期与中期**共用**这一套命名）。
 *
 * ⚠️ 这不是"内容指纹索引"（那套方案被明确否掉了）：id 只跟**来源名 + 序号**有关，
 * 与内容一个字都不相干。它的唯一用途是让"同一个来源的第 N 段"永远落在同一行上，
 * 于是重导就是更新，而不是又插一份。
 *
 * 用 digest 而不是原文：来源可能是任意路径/标题（长度、字符集都不可控），
 * 而 id 会被写进库、显示在面板上、出现在模型的工具返回值里。
 */
export function feedIdFor(source: string, index: number): string {
  const key = createHash('sha1').update(source).digest('hex').slice(0, 10)
  return `feed_${key}_${String(index)}`
}

// ── 去重（复用既有检索 + 与 recall 同一份近似判据）────────────────────────────

/** 一次查重的结论。 */
interface DedupeHit {
  readonly id: string
  readonly similarity: number
}

/**
 * 取一段正文用于**取候选**的关键片段（长度读基线 `feed.probeChars`）。
 *
 * 为什么是**前缀**而不是整段：`searchLongFts` / `searchMidFts` 内部用 `ftsQuery`，
 * 含 CJK 时会拼成**短语查询** —— 短语是「相邻 token 序列」的精确匹配，索引与查询两侧
 * 都过 unicode61 分词（标点不参与，所以 `50%` / `50 %` / `50%` 都能命中），
 * 但只要**多一个词或少一个词**（例如第 6 个字后插了一个"的"）整条短语就匹配不上。
 * 前缀越短，越能在"段落被改过"的情况下仍然取到候选；精度由 `textSimilarity` 负责。
 *
 * 已知边界（不假装它懂语义）：改动落在**前缀之内** ⇒ 取不到候选 ⇒ 判不出重复。
 * 与 recall 侧同一类取舍：**宁漏不误杀**（误杀会让用户以为"喂进去了"，其实一个字都没多）。
 */
function feedProbe(content: string): string {
  const max = defaultFor<number>('feed.probeChars')
  return content.length <= max ? content : content.slice(0, max)
}

/**
 * 在候选里挑最像的一条。
 *
 * `excludeIds`：**同源**的条目要排除掉 —— 它们由"id 对齐"那条路负责
 * （更新或归档），交给查重来拦会把"新段落"误判成重复。
 * 查重要拦的是"**别处**已经记过了"（其它来源的文件、模型自己 `remember` 的东西）。
 */
function bestDedupeHit(
  fullText: string,
  candidates: readonly { readonly id: string; readonly text: string }[],
  excludeIds: ReadonlySet<string>,
  threshold: number,
): DedupeHit | undefined {
  let best: DedupeHit | undefined
  for (const candidate of candidates) {
    if (excludeIds.has(candidate.id)) continue
    if (candidate.text.trim() === '') continue
    const score = textSimilarity(fullText, candidate.text)
    if (score > threshold && (best === undefined || score > best.similarity)) {
      best = { id: candidate.id, similarity: score }
    }
  }
  return best
}

/** 安全解析 `entities`（库里存的是 JSON 文本；脏值按"没有实体"处理，不抛）。 */
function parseEntities(raw: string | null): readonly string[] {
  if (raw === null || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

// ── 中期记忆：只追加，所以"同一段变了"要追加新版本 ────────────────────────────

/**
 * 给中期记忆挑一个还没被占用的 id。
 *
 * 中期记忆**没有 update 原语**（既有系统里只有 `appendMidEntry` / `fragmentMidEntry`），
 * 这是它的设计：中期记忆是一段一段追加的经历流水，改一条会动到 `window_offset`
 * 与渲染修订号，进而让缓存契约（PLAN §10.2）失效。
 *
 * 所以对"同源同序号但**内容变了**"的情况：以 `<基础 id>_<内容短哈希>` 追加**新版本**，
 * 老的那条留在库里，由既有的压缩/碎片维护决定去留。同一份改动重复喂 ⇒ 命中同一个 id
 * ⇒ 判为"已喂过"，不会越喂越多。
 */
function allocateMidId(db: DatabaseSync, base: string, content: string): { readonly id: string; readonly existed: boolean } {
  const current = getMidEntry(db, base)
  if (current === undefined) return { id: base, existed: false }
  if ((current.content ?? '') === content) return { id: base, existed: true }
  const variant = `${base}_${createHash('sha1').update(content).digest('hex').slice(0, 6)}`
  const existingVariant = getMidEntry(db, variant)
  return { id: variant, existed: existingVariant !== undefined }
}

// ── 核心 ─────────────────────────────────────────────────────────────────────

/**
 * 把资料喂进记忆系统（**唯一核心**，四条入口共用）。
 *
 * @param db - 已迁移的数据库连接（CLI / HTTP / 插件工具都传自己那个连接）。
 * @param options - 见 {@link FeedOptions}。
 * @returns 逐段明细与汇总计数；**校验失败返回 `ok: false`**（不是抛异常 —— 入口层要把它
 *          变成 400/一行错误说明，抛异常会变成 500 "服务器内部错误"，说不出哪里错了）。
 */
export function feedMemory(db: DatabaseSync, options: FeedOptions): FeedResult {
  const { as, dryRun = false } = options
  const threshold = defaultFor<number>('feed.dedupeSimilarity')
  const candidateLimit = defaultFor<number>('feed.dedupeCandidates')
  const maxChunks = defaultFor<number>('feed.maxItemsPerCall')
  const maxTokens = defaultFor<number>('feed.chunkMaxTokens')
  const rawOffset = options.indexOffset ?? 0
  const indexOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  // ① 段落切分（朴素段落切；段落级的复杂分块属于记忆系统本身）
  //
  // 每段都记下它来自哪个 item：摘要与实体要按**它所属的那一条输入**取，
  // 不能一律用 `items[0]` 的（那会给第二份文件的段落安上第一份的摘要/实体）。
  //
  // ★ `options.whole` = **不切分**：一个 item 就是一段（用户裁定 C-②：
  //   条目化交给模型，喂食只负责把原始片段交出去）。
  //   ⚠️ 它只关这一层；下面 ①b 的天花板**照旧**（那是防撑爆，不是替模型决定）。
  const paragraphs: { readonly text: string; readonly itemIndex: number }[] = []
  for (const [itemIndex, item] of options.items.entries()) {
    const pieces = options.whole === true ? [item.content] : splitIntoFeedChunks(item.content)
    for (const chunk of pieces) paragraphs.push({ text: chunk, itemIndex })
  }

  // ①b **天花板切分**：只有超过 `feed.chunkMaxTokens` 的段落才被切开（见 `feed-chunk.ts`）。
  //     不超上限 ⇒ 原样一片 ⇒ 段文本、段落序号、来源全都与过去逐字节一致。
  const chunks: { readonly text: string; readonly itemIndex: number; readonly piece?: FeedPiece }[] = []
  for (const paragraph of paragraphs) {
    const pieces = refineFeedChunk(paragraph.text, maxTokens)
    if (pieces.length === 0) continue
    if (pieces.length === 1) {
      chunks.push({ text: paragraph.text, itemIndex: paragraph.itemIndex })
      continue
    }
    for (const piece of pieces) chunks.push({ text: piece.text, itemIndex: paragraph.itemIndex, piece })
  }

  // ② 来源：显式给的用显式的，没给就**按内容派生**（派生式的真源在 `deriveFeedSource`）。
  //
  // ★ 为什么缺省值不能是一个常量（例如 `knowledge:unnamed`）：
  //   来源决定 id（`feed_<来源>_<序号>`），而"同源同序号 = 同一份东西的不同版本"。
  //   若缺省来源是个常量，那么"没填来源地喂 A"之后再"没填来源地喂 B"就会被当成
  //   同一个文档的第 0 段被**更新**掉 —— B 覆盖 A，而用户什么都没被告知。
  //   按内容派生之后：同样的内容重复喂 ⇒ 幂等；不同的内容 ⇒ 天然是两个来源，谁也不会盖谁。
  //   代价是缺省来源长成 `knowledge:3f9a1c2b`（面板「来源」列可见），
  //   想要人名可读、可增量重导的来源，就显式给 `source`。
  //
  // ⚠️ 派生吃的是**切分前**的段落（`paragraphs`）：这样调 `feed.chunkMaxTokens`
  //    不会把同一份文档变成"另一个来源"（那会让重导变成又插一份）。
  const explicitSource = options.source?.trim()
  const source =
    explicitSource !== undefined && explicitSource !== ''
      ? explicitSource
      : deriveFeedSource(
          as,
          paragraphs.map((paragraph) => paragraph.text),
        )
  const scope = feedScopeOf(source)

  /** 失败的统一出口：字段齐、`details` 为空（调用方只要看 `error`）。 */
  const failed = (error: string): FeedResult => ({
    ok: false,
    error,
    as,
    source,
    scope,
    dryRun,
    chunkCount: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    archived: 0,
    tokens: 0,
    details: [],
    hint: FEED_DELETE_HINT,
  })

  if (chunks.length === 0) return failed('没有可喂的内容（items 为空，或分块后全是空白）')
  if (chunks.length > maxChunks) {
    // 只报"超了"不够：这条上限管的是"**一次调用**不许无限大"。
    // ⇒ 出路是走投喂子系统（它自己会分批，段间还会让出控制权），或者调高上限。
    //    ⚠️ 2026-10-09 起**不再**建议"每批用不同的 source"：
    //    那是老办法（会破坏"第 N 段"的全局对齐、面板上也不再是一份文档），
    //    现在有 `indexOffset`（`feed-batch.ts`），同一个来源照样能分批。
    return failed(
      `分块后有 ${String(chunks.length)} 段，超过单次上限 ${String(maxChunks)} 段：` +
        '请走投喂子系统（feed-batch.ts 的 feedInput，它会自动分批且在批间让出控制权），' +
        '或调高 packages/contracts/plan-baseline.json 里的 feed.maxItemsPerCall',
    )
  }

  const details: FeedChunkResult[] = []
  let revision: number | undefined
  let tokens = 0

  if (as === 'knowledge') {
    // ②a 长期记忆：来源 ⇒ 同源条目 ⇒ id 对齐 ⇒ 更新/新增/归档
    const byId = new Map<string, LongEntryRow>(listLongEntriesByScope(db, scope).map((row) => [row.id, row]))
    const touched = new Set<string>()

    for (const [localIndex, chunkItem] of chunks.entries()) {
      const chunk = chunkItem.text
      const owner = options.items[chunkItem.itemIndex]
      const index = indexOffset + localIndex
      const id = feedIdFor(source, index)
      const tokenCount = estimateTokens(chunk)
      tokens += tokenCount
      const previous = byId.get(id)
      const summary = summaryOf(chunk, owner, chunkItem.piece)
      const entities = entitiesOf(owner)

      touched.add(id)
      if (previous !== undefined) {
        // 已沉降到冷层的条目（正文已移入归档、表内 content 置空）：**不在重导时拉回热层**。
        // 冷热是既有沉降策略（`settleLongEntries` / PLAN §6.3）的决定，喂食不该覆盖它；
        // 要把它拿回来得走既有的恢复路径（面板「存储与迁移」页的恢复）。
        if (previous.storage_tier === 'hdd' && previous.content === null) {
          details.push({
            index,
            id,
            action: 'unchanged',
            reason: '这一段已沉降到冷层：重导不把冷数据拉回热层（冷热由既有沉降策略管，恢复请用面板的存储页）',
            tokenCount,
          })
          continue
        }
        const unchanged = (previous.content ?? '') === chunk
        if (unchanged) {
          details.push({ index, id, action: 'unchanged', reason: '同源重导：这一段与库里一致，未改动', tokenCount })
          continue
        }
        if (dryRun) {
          details.push({ index, id, action: 'planned', wouldBe: 'updated', reason: '预览：这一段会被更新（同源重导）', tokenCount })
          continue
        }
        const result = updateLongMemory(db, {
          id,
          content: chunk,
          summary,
          // 手工补的实体不因重导被清掉（除非这次显式给了 entities）
          entities: entities ?? parseEntities(previous.entities),
        })
        if (!result.ok) {
          // 更新被拒 ⇒ 这条记忆**没有变**：如实记成 `unchanged`（不是 duplicate，也不是 updated）。
          // 编一个"判重跳过"会让面板显示得像"内容的锅"，而其实是摘要为空之类的原因。
          details.push({ index, id, action: 'unchanged', reason: `更新被拒：${result.reason}`, tokenCount })
          continue
        }
        details.push({ index, id, action: 'updated', reason: '同源重导：已更新这一段', tokenCount })
        continue
      }

      // 新的一段：先看**别处**是不是已经记过（复用既有 FTS 检索 + 近似判据）
      const probe = feedProbe(chunk)
      const candidates = searchLongFts(db, probe, candidateLimit).map((row) => ({
        id: row.id,
        text: (row.content ?? '') !== '' ? (row.content as string) : (row.summary ?? ''),
      }))
      const hit = bestDedupeHit(chunk, candidates, new Set(byId.keys()), threshold)
      if (hit !== undefined) {
        details.push({
          index,
          id,
          action: 'duplicate',
          reason: `判为已有记忆（相似度 ${(hit.similarity * 100).toFixed(0)}% > ${String(threshold)}）—— 跳过，不重复写`,
          tokenCount,
          similarity: hit.similarity,
          matchedId: hit.id,
        })
        continue
      }
      if (dryRun) {
        details.push({ index, id, action: 'planned', wouldBe: 'inserted', reason: '预览：这一段会新增到长期记忆', tokenCount })
        continue
      }
      insertLongEntry(db, {
        id,
        content: chunk,
        summary,
        ...(entities === undefined ? {} : { entities }),
        sourceScope: scope,
      })
      details.push({ index, id, action: 'inserted', reason: '新增到长期记忆（FTS + 沉降自动生效）', tokenCount })
    }

    // ③a 上一版多出来的段落 ⇒ 交给**既有**归档能力（不新写删除接口）。
    //     分批投喂时这一步由调度方在**全部喂完之后**调同一个实现做（见 `archiveFeedLeftovers`），
    //     否则每一批都会把别的批次的段判成"上一版多出来的"。
    if (options.archiveLeftovers !== false) {
      details.push(...archiveFeedLeftovers(db, { scope, keepIds: touched, dryRun }))
    }
  } else {
    // ②b 中期记忆：只追加（既有系统没有 update 原语）
    for (const [localIndex, chunkItem] of chunks.entries()) {
      const chunk = chunkItem.text
      const owner = options.items[chunkItem.itemIndex]
      const index = indexOffset + localIndex
      const base = feedIdFor(source, index)
      const tokenCount = estimateTokens(chunk)
      tokens += tokenCount
      const allocated = allocateMidId(db, base, chunk)
      if (allocated.existed) {
        details.push({
          index,
          id: allocated.id,
          action: 'duplicate',
          reason: '这一段已经在中期记忆里（同源同序号、正文一致）—— 跳过',
          tokenCount,
        })
        continue
      }

      const probe = feedProbe(chunk)
      // 同源同序号的旧版本要排除掉：它由 `allocateMidId` 的"追加新版本"负责，
      // 交给查重会拦掉"内容更新"这件正当的事。
      const ownIds = new Set<string>([base, allocated.id])
      const candidates = searchMidFts(db, probe, candidateLimit).map((row) => ({
        id: row.id,
        text: (row.content ?? '') !== '' ? (row.content as string) : row.summary,
      }))
      const hit = bestDedupeHit(chunk, candidates, ownIds, threshold)
      if (hit !== undefined) {
        details.push({
          index,
          id: allocated.id,
          action: 'duplicate',
          reason: `判为已有记忆（相似度 ${(hit.similarity * 100).toFixed(0)}% > ${String(threshold)}）—— 跳过，不重复写`,
          tokenCount,
          similarity: hit.similarity,
          matchedId: hit.id,
        })
        continue
      }
      if (dryRun) {
        details.push({ index, id: allocated.id, action: 'planned', wouldBe: 'inserted', reason: '预览：这一段会追加到中期记忆', tokenCount })
        continue
      }
      const entities = entitiesOf(owner)
      const appended = appendMidEntry(db, {
        id: allocated.id,
        summary: summaryOf(chunk, owner, chunkItem.piece),
        content: chunk,
        ...(entities === undefined ? {} : { entities }),
        tokenCount,
        sourceScope: scope,
      })
      revision = appended.revision
      details.push({
        index,
        id: allocated.id,
        action: 'inserted',
        reason: allocated.id === base ? '追加到中期记忆（压缩/沉降自动生效）' : '这一段内容变了：以新条目追加（中期记忆只追加）',
        tokenCount,
      })
    }
  }

  const countOf = (action: FeedAction): number => details.filter((detail) => detail.action === action).length
  return {
    ok: true,
    as,
    source,
    scope,
    dryRun,
    chunkCount: chunks.length,
    inserted: countOf('inserted'),
    updated: countOf('updated'),
    unchanged: countOf('unchanged'),
    duplicates: countOf('duplicate'),
    archived: countOf('archived'),
    tokens,
    ...(revision === undefined ? {} : { revision }),
    details,
    hint: FEED_DELETE_HINT,
  }
}

/**
 * 一条输入自带的实体（空数组按"没给"处理：写空数组等于显式清空，语义不同）。
 *
 * 多段输入时每段都带上它**所属那条输入**的实体 —— 宁可同一份文件的每段都带同样的实体，
 * 也不要给某段安上别人的实体（那会污染检索）。
 */
function entitiesOf(item: FeedItem | undefined): readonly string[] | undefined {
  const entities = item?.entities
  return entities === undefined || entities.length === 0 ? undefined : entities
}

/**
 * 这一段的摘要：调用方给的优先，否则按首行派生；**被天花板切过的片**再加"（第 k/N 段）"。
 *
 * 为什么只给"被切过的片"加后缀：没被切过的段要保持与过去逐字节一致（摘要也一样），
 * 而那正是绝大多数情况；被切过的片如果不加，同一段切出来的 N 条摘要会长得一模一样
 * （面板上看起来像喂重了）。
 *
 * 为什么后缀只动摘要不动正文：`previous.content === chunk` 是"同源重导没变"的判据，
 * 正文一旦掺进标记，重导就永远判成"变了"（幂等破产）。见 `feed-chunk.ts` 的说明。
 */
function summaryOf(chunk: string, owner: FeedItem | undefined, piece: FeedPiece | undefined): string {
  const base = owner?.summary ?? deriveFeedSummary(chunk)
  return piece === undefined ? base : withPieceSuffix(base, piece)
}

/**
 * 上一版多出来的段落 ⇒ 交给**既有**归档能力（`archiveLongMemory`）。
 *
 * 抽出来是因为有**两个调用方**，而它们必须行为一致：
 *  - `feedMemory()` 单次调用（批内：`keepIds` = 本次碰到过的 id）；
 *  - 投喂子系统的收尾（跨批：`keepIds` = 全部批次喂到的 id）。
 * 各写一份的下场是"分批喂和一次性喂对同一份文档给出不同的归档结果"，
 * 而那种不一致只有在用户发现"文档变短了但老条目还活着"时才会被发现。
 *
 * @param db - 数据库连接。
 * @param options.scope - 来源标记（`feed:<来源>`）。
 * @param options.keepIds - **本次喂到的** id（不在这里面、又不是已归档的 ⇒ 上一版多出来的）。
 * @param options.dryRun - 只算不写。
 * @returns 归档项的明细（已经归档过的如实报"已经归档过了"，不重复报"归档了 1 条"）。
 */
export function archiveFeedLeftovers(
  db: DatabaseSync,
  options: { readonly scope: string; readonly keepIds: ReadonlySet<string>; readonly dryRun: boolean },
): readonly FeedChunkResult[] {
  const details: FeedChunkResult[] = []
  for (const row of listLongEntriesByScope(db, options.scope)) {
    if (options.keepIds.has(row.id)) continue
    if (row.status === 'archived') {
      details.push({
        index: -1,
        id: row.id,
        action: 'unchanged',
        reason: '上一版多出来的段落：已经归档过了',
        tokenCount: 0,
      })
      continue
    }
    if (options.dryRun) {
      details.push({ index: -1, id: row.id, action: 'planned', wouldBe: 'archived', reason: '预览：上一版多出的这一段会被归档', tokenCount: 0 })
      continue
    }
    const result = archiveLongMemory(db, row.id)
    details.push({
      index: -1,
      id: row.id,
      action: result.ok ? 'archived' : 'unchanged',
      reason: result.ok ? '上一版多出来的段落：已归档（可恢复）' : `归档未生效：${result.reason}`,
      tokenCount: 0,
    })
  }
  return details
}

// ── 数据库路径推导（CLI 与"仓库内默认库"共用）────────────────────────────────

/**
 * DSH 侧默认的存储根与库文件（与 `packages/dsh-component/src/config.ts` 的
 * `storageRoot` = `forlife` / `dbFile` = `db/forlife.sqlite` 两个默认值一致）。
 *
 * 为什么不从那个包 import：依赖方向是 dsh-component → gateway，反过来会成环。
 * 一致性由 `packages/dsh-component/test/feed-db-path.test.ts` 用**真配置对象**钉住
 * （它同时能 import 两边）—— 而不是靠这里的注释。
 */
const FEED_STORAGE_ROOT = 'forlife'
const FEED_DB_FILE = join('db', 'forlife.sqlite')

/**
 * 解析喂食脚本要打开的数据库（**可移植**：绝不落到宿主 `~/.dsh`）。
 *
 * 优先级（与仓库既有推导一致，见 `gateway/src/server.ts` 的 `resolveRuntimeConfig`）：
 *  1. `FORLIFE_DB` —— 显式指定（部署/测试都靠它）；
 *  2. `DSH_HOME` / `FORLIFE_DSH_HOME` —— 便携默认：`<DSH_HOME>/forlife/db/forlife.sqlite`；
 *  3. 都没有 ⇒ **仓库内**的 `.runtime/dsh/forlife/db/forlife.sqlite`
 *     （与 `resolveRuntimeConfig` 的默认值是同一个文件）。
 *
 * ⚠️ 第 3 条刻意**不**回落到 `~/.dsh`：那是宿主目录，写进去就违反了可移植性红线
 * （`tests/portability.test.ts`）。宁可指向仓库内的开发库，也不要碰宿主。
 *
 * @param env - 环境变量（默认 `process.env`）。
 * @returns 数据库文件的**绝对**路径。
 */
export function resolveFeedDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['FORLIFE_DB']?.trim()
  if (explicit !== undefined && explicit !== '') return isAbsolute(explicit) ? explicit : resolve(explicit)

  const home = env['DSH_HOME']?.trim() ?? env['FORLIFE_DSH_HOME']?.trim()
  if (home !== undefined && home !== '') {
    const root = isAbsolute(home) ? home : resolve(home)
    return join(root, FEED_STORAGE_ROOT, FEED_DB_FILE)
  }

  return fileURLToPath(new URL('../../../.runtime/dsh/forlife/db/forlife.sqlite', import.meta.url))
}
