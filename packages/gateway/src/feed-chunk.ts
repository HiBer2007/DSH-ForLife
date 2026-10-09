/**
 * 投喂的**机械切分**：把一段超过天花板的正文按句子边界切开。
 *
 * ## 为什么需要它（2026-10-09 真机教训）
 *
 * 用户会把**巨量记忆**塞进来（尤其是"试图塞一个巨大的数据库"）。
 * 而 `feedMemory()` 原来的守卫只数**段数**（`feed.maxItemsPerCall`），**不看段有多大**：
 * 一个 100 MB、没有空行的一坨（JSONL / SQL dump 正好长这样）会被
 * `splitIntoFeedChunks()` 切成**一段** ⇒ 一枚守卫都不触发 ⇒ 作为**一条**记忆写进去。
 * 后果不是"慢"，是**窗口被一条炸掉**：中期窗口的选取对"单条自身超预算"的处理是
 * **整窗为空**（见 `memory-core/src/window.ts` 的边界语义），
 * 而 L3 一旦为空，"压缩看上下文占比"这条链也跟着失真。
 *
 * ⇒ 所以必须有**单条天花板**：超过就机械切开，与"用户喂了多少"无关。
 *
 * ## ★ 这是「上限」，不是「分块策略」（与 feed.ts 既有取舍的关系）
 *
 * `feed.ts` 的模块头明确写过：这里**不做**定长滑窗、按 token 预算切、句子边界对齐、
 * 重叠窗口 —— 因为"分块属于记忆系统本身"（用户的明确要求），
 * 长段落该由既有的压缩/碎片机制（PLAN §5.3）处理。
 *
 * 那条取舍在**正常情况下依然成立**，本文件只补上它的边界条件：
 *
 * | | 谁负责 |
 * | :--- | :--- |
 * | 一段**没超上限**的正文怎么进记忆、以后怎么被压缩/碎片化 | 记忆系统（压缩/碎片），**本文件不碰** |
 * | 一段**超过上限**的正文（单条 > 窗口预算 ⇒ 压缩救不了） | 本文件的**机械切分** |
 *
 * 也就是说：**不超过上限时，本文件原样返回一片**，整条链路与今天逐字节一致；
 * 只有超限才切。这不是"另一套分块器"，是把"单条不许无界"这条**上界**补上
 * （与 `feed.maxItemsPerCall` 的"一次调用不许无限大"同一性质，只是一个管条数、一个管大小）。
 *
 * **重叠窗口继续不做**：中期记忆是只追加的（`appendMidEntry`），
 * 重叠会让同一段内容进两次记忆，而且会与喂食自己的查重判据（`bestDedupeHit`）打架。
 *
 * ## 边界优先级（对齐"句子"而不是"字符"）
 *
 * 1. **句末**：`。！？；…` 与换行；ASCII 的 `.!?;` 只有后面是空白/结尾才算句末
 *    （这样 `3.14`、`v1.2` 不会被当成句子结尾）；
 * 2. **子句**：`，、：` 与 ASCII `,:`；
 * 3. **硬切**：两者都没有（比如一整坨 base64 / 一条超长 JSON）才按字符切。
 *
 * 切出来的每一片**包含边界符**（下一片从边界之后开始），并且**不重叠**。
 *
 * ## 不变量（都有用例钉着）
 *
 *  - 每一片 `estimateTokens() <= 上限`；上限不可用（<=0 / NaN）时**原样一整片返回** ——
 *    配置坏了宁可"这条超大"也不要**静默丢内容**；
 *  - 不超上限 ⇒ **只返回一片**（调用方据此判断"这一条没被切过"）；
 *  - 流式切分与整段切分对**同一份输入**给出**同样的正文切片**
 *    （`streamFeedChunks` 是 `refineFeedChunk` 的有界内存版本，差分测试钉着）。
 *
 * ## 流式（内存有界）那一半为什么存在
 *
 * V8 的单个字符串上限约 512M 字符 ⇒ "任意大"的输入**不可能**先读成一个字符串。
 * 所以除了整段版本（`refineFeedChunk`），这里还有一个按块消费的
 * `streamFeedChunks`：它只在内存里留"当前这一段 + 一个窗口"，与输入总量无关。
 * 两者共用同一套切点算法（`longestPrefixWithin`），差别只在**能不能提前知道
 * 这一段一共被切成几片**：整段版本能（`parts` 有值），
 * 流式版本在"这一段还没读完"时不能（中途片 `parts` 为 undefined）。
 * 于是摘要后缀会出现"（第 k/N 段）"与"（第 k 段）"两种 —— 见 `withPieceSuffix`。
 *
 * @module @forlife/gateway/feed-chunk
 */
import { estimateTokens } from '@forlife/memory-core'

/**
 * 切片的边界"往回找"时，最少要填满窗口的多少比例。
 *
 * 存在的理由：只有句末/子句标点才能切，而一个"标点出现在第 3 个字"的窗口
 * 会切出 3 个字的一片 —— 那会让巨量输入被切成几十万片小碎片（写入、查重、记账全都按片走）。
 * 所以往回找有下限：找不到就用子句边界，再找不到就**硬切**，
 * 宁可切断一个句子，也不要制造碎片风暴。
 *
 * 刻意不做成基线键：它不是"用户能定的策略"，而是让切分**不发散**的内部保护
 * （改大改小都不改变"每片 ≤ 上限"这条承诺）。
 */
const MIN_FILL_RATIO = 0.5

/** 非空白字符里"每 token 最多几个字符"（ASCII ≈ 4）。窗口按它取上界，保证不会漏切。 */
const CHARS_PER_TOKEN_MAX = 4

/** 收缩重试的次数：按实测比例收敛，两三次足够；兜底那一步保证一定不超限。 */
const SHRINK_ATTEMPTS = 3

/**
 * 一片切好的正文。
 *
 * `parts` 为 `undefined` = **"这一段还没读完，不知道一共几片"**（流式切分的中途片）。
 * 刻意不用 `0` / 负数表示"未知"：那种哨兵值总会在某处被当成数字用。
 */
export interface FeedPiece {
  readonly text: string
  /** 这一段里的第几片（从 1 起）。 */
  readonly part: number
  /** 这一段一共几片；`undefined` = 流式切分时还不知道。 */
  readonly parts?: number
}

/** 字符是不是**句末**（`i` 处；ASCII 标点要求后面是空白或结尾）。 */
function isSentenceEnd(text: string, i: number): boolean {
  const ch = text.charAt(i)
  if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '…' || ch === '\n') return true
  if (ch === '.' || ch === '!' || ch === '?' || ch === ';') {
    const next = text.charAt(i + 1)
    return next === '' || /\s/.test(next)
  }
  return false
}

/** 字符是不是**子句**边界（句末找不到时的次选）。 */
function isClauseEnd(text: string, i: number): boolean {
  const ch = text.charAt(i)
  return ch === '，' || ch === '、' || ch === '：' || ch === ',' || ch === ':'
}

/**
 * 切点不要落在**代理对中间**（那会把一个 emoji 劈成两个孤立代理，落库后是乱码）。
 *
 * 只在切点前一个字符是高位代理时退一格；退一格只可能让这一片更短，仍然 ≤ 上限。
 */
function safeCut(text: string, cut: number): number {
  if (cut <= 0) return 0
  const prev = text.charCodeAt(cut - 1)
  return prev >= 0xd800 && prev <= 0xdbff ? cut - 1 : cut
}

/**
 * 在 `[minCut, len)` 里往回找一个切点（**包含边界符**，所以返回值是"切到这里"的下标）。
 *
 * 优先句末、其次子句、都没有就硬切在 `len`。
 * 句末**优先于**更近的子句：需求是"句子边界对齐"，宁可少填一点。
 */
function boundaryCut(text: string, len: number): number {
  const minCut = Math.max(1, Math.floor(len * MIN_FILL_RATIO))
  let clause = -1
  for (let i = len - 1; i >= minCut - 1; i -= 1) {
    if (isSentenceEnd(text, i)) return safeCut(text, i + 1)
    if (clause < 0 && isClauseEnd(text, i)) clause = i + 1
  }
  return safeCut(text, clause > 0 ? clause : len)
}

/**
 * 取"不超过 `maxTokens` 的**最长**前缀"的切点（对齐边界后）。
 *
 * ## 为什么不是"逐字符试算 token"
 *
 * `estimateTokens()` 是 O(n) 的：对每个前缀都算一次就是 O(n²)，
 * 一份 100 MB 的输入能跑到天亮。这里用**字符窗口**先框一个上界再验算：
 *  - 上界 `maxTokens * 4` 字符（ASCII 的"每 token 最多 4 字符"），
 *    超出这个长度的前缀不可能装下 ⇒ 一次就把候选压到常数大小；
 *  - 验算发现还是超了（CJK 是 1 字 ≈ 1 token）⇒ 按实测比例收缩，
 *    最多 {@link SHRINK_ATTEMPTS} 次；
 *  - 还不行的兜底是 `maxTokens` 个字符 —— 每个字符最多 1 token，**必然不超限**。
 *
 * 每次迭代处理的都是"不超过 4×上限"的常数窗口 ⇒ 整体线性。
 *
 * @param text - 待切正文（调用方保证非空）。
 * @param maxTokens - 单条上限（调用方保证 > 0）。
 * @returns 切点（已做边界与代理对调整）与**这一片**的 token 估算。
 */
function longestPrefixWithin(text: string, maxTokens: number): { readonly cut: number; readonly tokens: number } {
  let len = Math.min(text.length, maxTokens * CHARS_PER_TOKEN_MAX)
  let tokens = estimateTokens(text.slice(0, len))
  for (let attempt = 0; attempt < SHRINK_ATTEMPTS && tokens > maxTokens; attempt += 1) {
    // 0.98：比例收缩后再留一点余量，避免在边界上来回抖（每次都要重新验算，抖动=多花时间）
    const next = Math.max(1, Math.floor((len * maxTokens * 0.98) / tokens))
    if (next >= len) break
    len = next
    tokens = estimateTokens(text.slice(0, len))
  }
  if (tokens > maxTokens) {
    len = Math.min(len, maxTokens)
    tokens = estimateTokens(text.slice(0, len))
  }
  const cut = boundaryCut(text, len)
  return { cut, tokens: cut === len ? tokens : estimateTokens(text.slice(0, cut)) }
}

/** 这一片能不能整片收下（与 `refineFeedChunk` 的循环条件**同一判据**）。 */
function fitsWithin(text: string, maxTokens: number): boolean {
  return text.length <= maxTokens * CHARS_PER_TOKEN_MAX && estimateTokens(text) <= maxTokens
}

/**
 * 把**一整段**正文按上限切成若干片（不超过上限 ⇒ 原样一片）。
 *
 * @param text - 一段正文（调用方给的是"段落"：`splitIntoFeedChunks()` 的产物）。
 * @param maxTokens - 单条 token 上限（读基线 `feed.chunkMaxTokens`）。
 * @returns 切片数组（已 trim；全空白 ⇒ 空数组）。
 */
export function refineFeedChunk(text: string, maxTokens: number): readonly FeedPiece[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  // 上限不可用 ⇒ **原样返回一整片**：宁可"这条超大"（面板/诊断看得见），
  // 也不要静默丢内容（切分的任何分支都不许吞字）。
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [{ text: trimmed, part: 1, parts: 1 }]

  const slices: string[] = []
  let rest = trimmed
  while (rest !== '') {
    // 可能装得下 ⇒ 做 O(n) 的精确验算（这一层判断让巨大输入不会在每个循环里重扫全文）
    if (fitsWithin(rest, maxTokens)) {
      slices.push(rest)
      break
    }
    const { cut } = longestPrefixWithin(rest, maxTokens)
    const head = rest.slice(0, cut).trim()
    if (head === '') {
      // 防御：切不出东西（理论上到不了）⇒ 原样收下，绝不死循环、绝不吞字
      slices.push(rest)
      break
    }
    slices.push(head)
    // 片与片之间不留跨片空白：每片自带首尾裁剪（否则下一片会以一个空格开头）
    rest = rest.slice(cut).trim()
  }
  return slices.map((slice, index) => ({ text: slice, part: index + 1, parts: slices.length }))
}

/** 把 `Iterable` / `AsyncIterable` 统一成异步迭代（`streamFeedChunks` 只认后者）。 */
async function* toAsync(pieces: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string> {
  if (typeof (pieces as AsyncIterable<string>)[Symbol.asyncIterator] === 'function') {
    for await (const piece of pieces as AsyncIterable<string>) yield piece
    return
  }
  for (const piece of pieces as Iterable<string>) yield piece
}

/**
 * **流式**切分：边读边切，内存只留"当前这一段 + 一个窗口"，与输入总量无关。
 *
 * 与 `refineFeedChunk()` 的关系（很重要，差分测试钉着"两者正文切片一致"）：
 *  - 切点算法完全共用（`longestPrefixWithin` + 边界优先级 + `fitsWithin` 判据）；
 *  - 整段版本先看全文，所以知道 `parts`；流式版本在"这一段还没读完"时**不知道**
 *    ⇒ 中途片只给 `part`，只有**这一段的最后一片**（读完了才算得出来）能带上 `parts`。
 *
 * 段落边界与 `splitIntoFeedChunks()` **逐字节一致**：空行断开、`#`~`######` 标题行断开、
 * 行内单换行不断开。这里是它的流式等价实现（差分测试钉着）。
 *
 * ## ★ 什么时候可以切（这条判据必须与整段版本**逐字一致**，否则两条入口切点不同）
 *
 * 整段版本的循环是："装得下就整段收下，装不下就从 `min(剩余, 4×上限)` 个字符里
 * 找最长能装下的前缀"。而 `剩余 > 4×上限` 时它**必然切**（字符数就已经超了，
 * 因为每个字符最多 1 token）—— 与 token 估算无关。
 *
 * ⇒ 流式版本只在 **缓冲字符数 > 4×上限** 时切，不去做"增量 token 估算触发"：
 * 那种触发会在**不同的起点长度**上做收缩（整段版本总是从 4×上限 起步），
 * 于是同一个段落被两条入口切成不同的片 —— 而片号就是段落 id（`feedIdFor`），
 * 切点不同 = 同一个文件换个入口喂就变成"另一份文档"、重导整体重写。
 * （这不是理论担心：差分测试第一版就是在这里红的。）
 *
 * 剩下的情况（缓冲 ≤ 4×上限）都交给**段落结束**时的 `refineFeedChunk()` 处理 ——
 * 那正是整段版本在同一位置的判据（"剩余 ≤ 4×上限 且装得下 ⇒ 整段一片"）。
 *
 * @param pieces - 输入块（文件流 / 字符串数组都行；块边界可以落在任何地方）。
 * @param options - `maxTokens` 见 {@link refineFeedChunk}。
 */
export async function* streamFeedChunks(
  pieces: AsyncIterable<string> | Iterable<string>,
  options: { readonly maxTokens: number },
): AsyncGenerator<FeedPiece> {
  const maxTokens = options.maxTokens
  const usable = Number.isFinite(maxTokens) && maxTokens > 0
  const windowChars = usable ? maxTokens * CHARS_PER_TOKEN_MAX : 0

  let carry = ''
  /** 当前这一段的正文（按行拼好，未裁剪）。 */
  let buffer = ''
  /** 当前这一段已经吐出去几片（0 = 一片都没切过）。 */
  let part = 0

  /** 待吐出的片：用游标消费，不用 `shift()`（那是 O(n)）。 */
  let emitted: FeedPiece[] = []
  let cursor = 0
  const flush = function* (): Generator<FeedPiece> {
    while (cursor < emitted.length) yield emitted[cursor++] as FeedPiece
    emitted = []
    cursor = 0
  }

  /** 吐一片（`parts` 留空 = "这一段还没读完，不知道一共几片"）。 */
  const push = (text: string): void => {
    emitted.push({ text, part })
  }

  /** 缓冲超过一个窗口 ⇒ 切一片出去（见模块头的"什么时候可以切"）。 */
  const drainWindow = (): void => {
    if (!usable) return
    while (buffer.length > windowChars) {
      const { cut } = longestPrefixWithin(buffer, maxTokens)
      const head = buffer.slice(0, cut).trim()
      if (head === '') break // 防御：切不出东西就别切（绝不死循环）
      part += 1
      push(head)
      buffer = buffer.slice(cut).trim()
    }
  }

  /** 段落结束：把剩下的收成最后一片。 */
  const finalize = (): void => {
    const rest = buffer.trim()
    buffer = ''
    if (rest === '') {
      part = 0
      return
    }
    if (part === 0) {
      // 整段没切过 ⇒ 走整段版本（它知道 parts；常见情况与今天逐字节一致）
      for (const piece of refineFeedChunk(rest, maxTokens)) emitted.push(piece)
      return
    }
    // 已经吐过片 ⇒ 剩下的收尾。可能不止一片（剩下的是密集型内容时）。
    // **一律不带 parts**：这一段的前面几片早就吐出去了（那时不知道总数），
    // 收尾片若单独报一个总数，同一段里会出现"（第 2 段）"与"（第 3/3 段）"两种后缀。
    for (const piece of refineFeedChunk(rest, maxTokens)) {
      part += 1
      push(piece.text)
    }
    part = 0
  }

  /** 处理一整行（与 `splitIntoFeedChunks` 的分支一一对应）。 */
  const takeLine = (line: string): void => {
    if (/^#{1,6}\s/.test(line) && buffer !== '') finalize()
    if (line.trim() === '') {
      finalize()
      return
    }
    buffer = buffer === '' ? line : `${buffer}\n${line}`
    drainWindow()
  }

  for await (const piece of toAsync(pieces)) {
    carry += piece
    let start = 0
    for (;;) {
      const newline = carry.indexOf('\n', start)
      if (newline < 0) break
      let line = carry.slice(start, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      takeLine(line)
      yield* flush()
      start = newline + 1
    }
    carry = carry.slice(start)
  }
  // 收尾：末尾没有换行时剩下的就是最后一行。
  // 空 carry **不当**成空行 —— `text.split(/\r?\n/)` 在这种情况下多出来的空元素只起
  // flush 作用，而下面这次 finalize 已经覆盖了它。
  if (carry !== '') takeLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
  finalize()
  yield* flush()
}

/**
 * 摘要后缀：**只动摘要、不动正文**。
 *
 * 为什么需要：一段长文被切成 N 片后，每片的**首行**往往相同（同一个段落），
 * 于是面板/列表上 N 条摘要一模一样 —— 看起来像"喂重了"。
 *
 * 为什么不加在正文上：`feed.ts` 判"同源重导没变"用的是 `previous.content === chunk`，
 * 往正文插标记会让每次重导都判成"变了"（幂等直接破产），而且正文是记忆本体，
 * 会一直被检索/沉降/展示。
 *
 * `parts === undefined`（流式切分的中途片）⇒ 只标"第 k 段"：这时**还不知道**一共几片
 * （要读完这一段才知道，而流式投喂不能为了一个后缀把整段留在内存里）。
 * 注意 `part === 1` 也一样要标 —— `parts` 缺失本身就说明"这一片是被切出来的"
 * （整段装得下时走的是另一条路，它会带上 `parts`），所以第一片要和后几片看起来一致。
 *
 * @param summary - 已经算好的摘要（调用方给的或 `deriveFeedSummary` 派生的）。
 * @param piece - 这一片的编号信息。
 * @returns 带后缀的摘要（不需要后缀时原样返回）。
 */
export function withPieceSuffix(summary: string, piece: { readonly part: number; readonly parts?: number | undefined }): string {
  if (piece.parts !== undefined && piece.parts <= 1) return summary
  const label = piece.parts === undefined ? `第 ${String(piece.part)} 段` : `第 ${String(piece.part)}/${String(piece.parts)} 段`
  return `${summary}（${label}）`
}
