/**
 * 文本的**词面近似**相似度（0..1）。
 *
 * ## 为什么它在这里（而不是在 `dsh-component/src/runtime.ts`）
 *
 * 这个函数最早只为 recall 的"重复查询"闸门服务，所以住在 DSH 侧的运行时里。
 * 2026-10-07 加了「手动喂食记忆资料」之后，**喂食的查重也需要同一个判据**：
 * 判断"这一段是不是已经记过了"，和判断"这个查询是不是刚查过"是同一类问题
 * （都是"几乎同一条"）。
 *
 * 而喂食的核心函数在 `@forlife/gateway`，网关**不能**依赖 `@forlife/dsh-component`
 * （依赖方向是 dsh-component → gateway，反过来就成环了）。于是把算法**下沉**到
 * 这一层（无 DSH 依赖、可独立单测的纯逻辑层），调用方各自读自己的阈值：
 *  - recall 的重复查询：`recall.duplicateSimilarity`（PLAN §7.4，0.9）
 *  - 喂食的查重：`feed.dedupeSimilarity`（EXECUTION_PLAN §2.19，0.9）
 *
 * ★ 关键是**只有这一份实现** —— 另写一份"喂食专用的相似度"就是又造了一条平行机制，
 * 两边的判据迟早分叉（一个改了、另一个没改，而两边都"有测试"）。
 *
 * ## ⚠️ 这不是语义相似度（先说清楚它是什么）
 *
 * PLAN §7.4 要的是「与上轮**语义**相似度 > 0.9」。语义相似度要向量：
 * 把两条查询各编码成 embedding、再算余弦相似度。而**本仓没有向量库** ——
 * `packages/store/package.json` 只依赖 `@forlife/contracts`，全仓没有 LanceDB / Qdrant /
 * 任何 embedding 依赖（PLAN §6.4 的选型尚未落地，当前检索走 FTS5）。
 * 文本侧能做的只有**词面**近似，所以这里用 **token 集合的 Jaccard 系数**，
 * 并把它的能力边界写在明处（**不假装**它懂语义）：
 *
 *  - **抓得到**：同一段话的重复，含空白 / 大小写 / 标点 / 全半角的表面差异
 *    （`防抖 2-3 秒` vs `防抖2-3秒。`⇒ 1.0）；
 *  - **抓不到**：换一种说法的同义句（`防抖实现` vs `防抖是怎么做的`）、
 *    只共享一两个词的不同主题 —— 那需要向量，需要 PLAN §6.4 落地。
 *    代价是**漏检**（少拦几次重复），而不是把新内容误判成"已经有了"。
 *
 * ## 为什么是 Jaccard（而不是编辑距离 / `loop-guard` 的 `similarity()`）
 *
 *  - **不用 `store/src/loop-guard.ts` 的 `similarity()`**：那个是"公共前后缀占较短一条的比例"，
 *    为模型输出的死循环检测服务，对**语序调换完全不敏感**（`防抖消息队列` vs `消息队列防抖`
 *    前后缀占比是 0，而它明明就是同一件事）。两件事的判据不同，共用一个函数会同时骗过两边
 *    （那边注释解释了它为什么必须 O(n) 且只看首尾）；
 *  - **不用编辑距离**：`O(n·m)` 且对"多加一个词"过于敏感（`消息队列` vs `消息队列延迟`
 *    的编辑距离相似度接近 0.8，几乎要撞上 0.9 的阈值 —— 那是两个**不同**的东西，不该拦）；
 *  - **集合语义（Jaccard）刻意忽略词序与重复词**：`防抖 消息队列` 与 `消息队列 防抖`
 *    判为同一个 —— 换个词序说同一件事，仍然是同一件事。
 *
 * ## 阈值方向：宁漏不误杀（这里有个真实取舍）
 *
 * 阈值**不由本模块决定**，由调用方从保真度基线取值（`defaultFor(...)`）。两个调用点
 * 都取 0.9：Jaccard ≥ 0.9 意味着两边几乎共享全部 bigram ⇒ **只拦"几乎是同一个"**。
 * 刻意不把阈值调低去"凑"语义：
 *  - recall 侧**误杀一个真正不同的查询**会让模型以为"记忆里没有这条"（PLAN §7.3 恰恰
 *    要求它"无结果时先判断信息是否真的存在"）；
 *  - 喂食侧**误杀一段新资料**会让用户以为"喂进去了"，而库里一个字都没多。
 *
 * 空文本（归一化后没有任何 token）返回 0：不判重复，交给调用方如实报"没有命中"。
 *
 * @module @forlife/memory-core/similarity
 */

/**
 * 归一化：把"表面不同、其实是同一个"的差异抹掉。
 *
 * 只动**表面**、不动词：
 *  1. `NFKC` —— 全角/半角与兼容字符统一（`ＱＱ` → `qq`）；
 *  2. 转小写 —— 大小写不该算"换了一个"；
 *  3. 去掉所有空白、标点与符号（Unicode `\p{P}` / `\p{S}`）——
 *     `防抖 2-3 秒` 与 `防抖2-3秒。` 是同一句。
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[\p{P}\p{S}]+/gu, '')
}

/**
 * 把归一化后的文本切成 **token 集合**（近似手段的核心，理由见文件头）。
 *
 *  - **CJK 段取字符二元组（bigram）**：中文没有空格，按空格切词会把整句当成一个 token
 *    ⇒ "防抖窗口"与"防抖窗口延迟"会算成 0 相似（既漏、又没法靠阈值调）；
 *    bigram 不需要分词器，且"多加一个词"会成比例地拉低相似度（`消息队列` vs `消息队列延迟` ⇒ 3/5）。
 *    单字成段时取该字本身 —— 否则"猫"这种单字查询得到**空集合**，永远判不出重复；
 *  - **拉丁/数字段按词切**：`QQ` / `bot` / `2-3`（标点已去掉 ⇒ `23`）。
 *    不切的话 `q` / `qq` / `qqq` 会变成一堆互相相似的 bigram，把"不同的词"判成同一个。
 */
export function similarityTokens(normalized: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) tokens.add(word)
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
  for (const run of normalized.match(cjk) ?? []) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

/**
 * 两段文本的**词面近似**相似度（0..1）。
 *
 * 完整的能力边界与取舍见本文件头部 —— 一句话：它抓得住"同一段的表面变体"，
 * 抓不住"同义改写"，因为它不是语义相似度。
 *
 * @param a - 第一段文本。
 * @param b - 第二段文本。
 * @returns Jaccard 系数（0 = 毫无共同 token，1 = token 集合完全相同）。
 */
export function textSimilarity(a: string, b: string): number {
  const left = similarityTokens(normalizeForSimilarity(a))
  const right = similarityTokens(normalizeForSimilarity(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / (left.size + right.size - shared)
}
