/**
 * **分区预算检查**（`FIX_PLAN.md` §76.5⑦ / `PLAN.MD` 附录 A.4 的最后一个 ❌）。
 *
 * ## 为什么需要它
 *
 * `PLAN.MD` 附录 A.1 给四层各定了一个**上限**：
 *
 * | 层 | 上限 | 例（1M 上下文） |
 * | :--- | :--- | :--- |
 * | L2 长期记忆手册/索引 | ≤ **10%** | 100K |
 * | L3 中期记忆区 | ≤ 50% | 500K |
 * | L4 短期记忆区 | ≤ 10% | 100K |
 *
 * 而 `PLAN.MD` §A.4 自己列了"实现现状 vs PLAN"的对照表，里面三条 ❌：
 * L3 的渲染窗口偏小、**L4 没有任何键在管它**、**L2 没有任何键在管它**。
 * ★ 前两条 2026-10-11 已经补上（`memory.midWindow.maxTokens` = 500000 ·
 *   `memory.shortBudgetTokens` = 100000），**L2 一直没有** ——
 *   于是"L2 手册涨到 30 万 token 了"这件事，**没有任何人会知道**
 *   （它每轮都在上下文里，而"上下文变贵/变慢"通常先被归到别的原因上）。
 *
 * ## ★ 只量、只喊，**不动内容**
 *
 * `PLAN.MD` §A.1 有一条必须记住的话：「**以上都是「最大值」（上限），不是目标值**
 * ⇒ 没到上限就不该动它」。⇒ 本模块**绝不截断** L2 文本（那会改变模型看到的东西，
 * 是产品决策，不是守卫该做的事）。它做的是：**量出来、跨线时喊一声**。
 *
 * ## ★ 边沿检测（与存储指标同一条纪律）
 *
 * L2 超预算会**一直**超 ⇒ 每轮都喊会把日志库灌满。所以只在**跨线**时喊一次，
 * 回落到线内再喊一次"恢复了"。
 *
 * @module @forlife/dsh-component/budget-check
 */
import { estimateTokens } from '@forlife/memory-core'

/** 预算告警用的模块名（面板按模块筛得到；与 `storage` 那套同一个约定）。 */
export const BUDGET_LOG_MODULE = 'memory-budget'

/** 一次检查的结果。 */
export interface BudgetCheckResult {
  /** 量出来的 token 数。 */
  readonly tokens: number
  /** 预算（token）。 */
  readonly budgetTokens: number
  /** 是否超了。 */
  readonly over: boolean
  /** ★ 这一次**是否真的喊了**（跨线才 true —— 边沿检测）。 */
  readonly warned: boolean
}

/** 检查器选项。 */
export interface BudgetCheckOptions {
  /** 预算（token）；★ 生产里传契约值，不写死。 */
  readonly budgetTokens: number
  /** 喊话出口（`warn` / `note` 两级：超线 / 恢复）。 */
  readonly warn: (message: string) => void
  /** 恢复时的出口；不传就复用 `warn`。 */
  readonly note?: (message: string) => void
  /** 分区名（写进消息里，例如 `L2`）。 */
  readonly label?: string
}

/** 检查器。 */
export interface BudgetCheck {
  /**
   * 量一次。
   *
   * @param text - 该分区的文本。
   * @returns 结果（`warned` 表示这一次真的喊了）。
   */
  readonly check: (text: string) => BudgetCheckResult
  /** 当前是否处于"超线"状态（排障用）。 */
  readonly over: () => boolean
}

/**
 * 造一个预算检查器。
 *
 * @param options - 见 {@link BudgetCheckOptions}。
 * @returns 检查器。
 */
export function createBudgetCheck(options: BudgetCheckOptions): BudgetCheck {
  const label = options.label ?? 'L2'
  const note = options.note ?? options.warn
  let overNow = false
  /** ★ 还没记过基线。 */
  let baselineDone = false

  return {
    check: (text: string): BudgetCheckResult => {
      const tokens = estimateTokens(text)
      const budgetTokens = options.budgetTokens
      // ★ 预算 <= 0 视为"没在管"：不许把"没配"当成"超了"（那会是误报）
      const over = budgetTokens > 0 && tokens > budgetTokens
      let warned = false
      // ★★ 第一次检查记一条**基线**（与 `storage-metrics.ts` 同一条纪律）。
      //
      //   为什么必须记：只有"超预算才喊"的话，日志里**没有记录**这件事
      //   既可能是"没超"、也可能是"这个检查根本没跑" —— 两者分不开。
      //   ★ 而"检查有没有真的跑"正是本仓反复栽的那一类（库写好了、生产零调用）。
      //   ⇒ 基线这条 `note` 就是"它活着"的凭据，同时把**量出来的数字**留档。
      if (!baselineDone) {
        baselineDone = true
        note(
          `预算基线：${label} ${String(tokens)} token / 上限 ${String(budgetTokens)}` +
            `（${budgetTokens > 0 ? `${((tokens / budgetTokens) * 100).toFixed(1)}%` : '未配上限 ⇒ 不判'}）`,
        )
      }
      if (over && !overNow) {
        overNow = true
        warned = true
        options.warn(
          `★ ${label} 超预算：${String(tokens)} token > ${String(budgetTokens)}（` +
            `${((tokens / budgetTokens) * 100).toFixed(0)}%）—— ` +
            `PLAN.MD 附录 A.1 的上限是"最大值不是目标值"，★ 没超就不该动它，` +
            `超了要么精简这段文本、要么（要改产品行为的话）先问用户`,
        )
      } else if (!over && overNow) {
        overNow = false
        warned = true
        note(`✓ ${label} 回到预算内：${String(tokens)} token ≤ ${String(budgetTokens)}`)
      }
      return { tokens, budgetTokens, over, warned }
    },
    over: () => overNow,
  }
}
