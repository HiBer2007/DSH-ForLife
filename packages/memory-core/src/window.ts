/**
 * 中期记忆**窗口**的选取（纯函数）—— 补上 PLAN §1.2 漏掉的那半句。
 *
 * ## 它修的是什么
 *
 * PLAN §1.2 把中期记忆定义为「**上下文窗口中的稳定前缀**」——
 * 它是"当前在窗口里的那一段"，**不是整张表**；§10.2 / T17 还说它"仅在压缩事件时追加/替换"。
 *
 * 而 `renderView()` 以前把 `listRenderableMidEntries()` 的**全表**渲染进系统提示词。
 * 真机实测（2026-10-09）：10,794 条 / 1,504,850 token 一次性进前缀 ⇒
 * QQ 唤醒直接 `CONTEXT_WINDOW_EXCEEDED: pi-ai detected context overflow`；
 * 压缩又要求"上下文占比"才触发，于是**压缩永远不触发**（`compaction_epoch` 恒为 0、
 * 长期记忆恒为空）—— 四层记忆流水线（短期→中期→长期→冷）第一层就堵死。
 *
 * 所以窗口约束不是新功能，是**把设计补回来**。
 *
 * ## 取法：**从最新往回**，累计到预算为止
 *
 * 中期是"当前活跃的那一段"：预算用完时该丢的是**旧的**，不是新的。
 *
 * ## 输出**保持输入顺序**（不重排）—— 这一条与缓存直接相关
 *
 * 本函数只做**筛选**，返回的条目仍按调用方给的顺序（SQL 是 `ORDER BY window_offset ASC`）。
 * 理由：`render.ts` 的契约本来就是"调用方已排序"，而 L0-L3 是缓存前缀 ——
 * 新条目追加在**尾部**时前缀逐字节不变（只多一行），缓存继续命中；
 * 若这里把它重排到最前，**每次 append 都会改写整个前缀**，稳定前缀的承诺当场破产。
 *
 * ## 排序键为什么是 `(compaction_epoch, window_offset)`，而不是单看 `window_offset`
 *
 * ⚠️ 这是一个真机上**必然**踩到的坑，不是理论问题：
 * `window_offset` 是**按 epoch 分桶**的 —— `appendMidEntry()`（`store/src/repository.ts`）
 * 取的是 `SELECT max(window_offset) … WHERE compaction_epoch = ?`，而压缩事务
 * **先 `bumpEpoch` 再 push**（`compaction-engine.ts` 的 Step 4）。
 * 于是每次压缩之后，新条目的 `window_offset` 从 **0 重新开始**：
 * **offset 最小的反而是最新写进去的那些**。
 *
 * 只按 `window_offset` 从大到小取，会把"本次压缩刚提炼出来的记忆"判成最旧、
 * 第一批丢出窗口，留下来的全是压缩前的老条目 —— 与"最新优先"正好相反，
 * 而且症状很隐蔽（窗口非空、渲染正常，只是永远看不到新记忆）。
 * `(epoch, offset)` 才是真正单调的**写入序**：epoch 只增；同一 epoch 内 offset = max+1。
 *
 * 注：写入侧的分桶（"追加到 L3 尾部"的次序保证）是**另一件事**，
 * 已在 `contracts/src/deviations.ts` 登记为待修副作用；这里只是在窗口选取时
 * 用正确的键去读，没有改表、也没有改渲染顺序。
 *
 * ## 预算口径：`token_count` 之和，不是渲染字节数
 *
 * 每条用表里的 `token_count` 记账（它也是 `midStats` / 面板的口径）。
 * 渲染出来的 `view.tokenEstimate` 会**略高于**这里的和：`renderMidMemory` 还会加
 * 行标记（`[M1] `）、相对年龄后缀与碎片指针后缀。
 * 也就是说窗口是"记忆内容的预算"，不是"渲染字节的硬上限"——
 * 差值有界（每行几 token），比"按渲染文本回算"更容易解释与断言。
 *
 * @module @forlife/memory-core/window
 */
import type { MidEntryRow } from '@forlife/store'

/** 窗口选项。 */
export interface MidWindowOptions {
  /**
   * 窗口的 token 预算（读自基线 `memory.midWindow.maxTokens`，**不在这里写死数字**）。
   *
   * `<= 0`（含 NaN）⇒ **空窗口**：宁可这一轮没有中期记忆，也不要"配置坏了就退回全表" ——
   * 全表正是这次要修的故障形态（1.5M token 进前缀、唤醒即爆上下文）。
   */
  readonly maxTokens: number
}

/** 窗口选取结果。 */
export interface MidWindowResult {
  /** 进窗口的条目（**保持输入顺序**，见模块头）。 */
  readonly entries: readonly MidEntryRow[]
  /** 落在窗口外的条目数（丢的是最旧的那些；面板/诊断要能如实报出来）。 */
  readonly droppedCount: number
  /** 落在窗口外的条目 token 之和。 */
  readonly droppedTokens: number
  /** 进窗口条目的 token 之和（表口径，见模块头）。 */
  readonly tokens: number
}

/** 写入序比较：epoch 优先（只增），同 epoch 内比 `window_offset`（同 epoch 内 = max+1）。 */
function newerFirst(a: MidEntryRow, b: MidEntryRow): number {
  if (a.compaction_epoch !== b.compaction_epoch) return b.compaction_epoch - a.compaction_epoch
  if (a.window_offset !== b.window_offset) return b.window_offset - a.window_offset
  // 末位用 id 兜底：`(epoch, offset)` 在正常写入下不可能重复，
  // 但重复时也必须有一个**确定**的序（否则同一张表两次渲染可能不同字节）。
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * 选取中期记忆窗口（纯函数：不改输入、不读时钟、不碰数据库）。
 *
 * 算法就是"从最新往回装，装不下就停"：
 * 按写入序（新→旧）逐条试装，`已用 + 本条 > maxTokens` 时**立即停**
 * （不是跳过这条再试更旧的 —— 那样窗口会变成"预算内最老的若干条"，与"最新优先"相反）。
 *
 * 边界语义（都有用例钉着）：
 *  - 空表 ⇒ 空窗口；
 *  - `已用 + 本条 === maxTokens` ⇒ **装进去**（判据是"超过"才停，不是"达到"）；
 *  - **单条自身超预算 ⇒ 窗口为空**：刻意不做"至少留一条"的例外 ——
 *    那会让一条无界的条目把窗口炸掉，而"单条超预算"本身是写入方的 bug
 *    （PLAN §5.3 的四层长度限制该在写入时拦住它）。
 *
 * @param entries - 候选条目（调用方已按 `compaction_epoch`/`status` 过滤，通常是 `listRenderableMidEntries()`）。
 * @param options - 预算。
 * @returns 进窗口的条目（保持输入顺序）与丢弃统计。
 */
export function selectMidWindow(
  entries: readonly MidEntryRow[],
  options: MidWindowOptions,
): MidWindowResult {
  const maxTokens = Math.floor(options.maxTokens)
  const totalTokens = entries.reduce((sum, entry) => sum + entry.token_count, 0)
  if (entries.length === 0) {
    return { entries: [], droppedCount: 0, droppedTokens: 0, tokens: 0 }
  }
  // 预算不可用 ⇒ 空窗口（见 MidWindowOptions 的说明：不退回全表）
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { entries: [], droppedCount: entries.length, droppedTokens: totalTokens, tokens: 0 }
  }

  // 排序只作用于**副本**：输入数组可能是调用方持有的缓存，改它的顺序会连带改别处的渲染字节
  const newestFirst = [...entries].sort(newerFirst)

  const keepIds = new Set<string>()
  let tokens = 0
  for (const entry of newestFirst) {
    if (tokens + entry.token_count > maxTokens) break
    tokens += entry.token_count
    keepIds.add(entry.id)
  }

  // 按**输入顺序**输出（见模块头：新条目只能追加在尾部，前缀才逐字节稳定）
  const kept = entries.filter((entry) => keepIds.has(entry.id))
  return {
    entries: kept,
    droppedCount: entries.length - kept.length,
    droppedTokens: totalTokens - tokens,
    tokens,
  }
}
