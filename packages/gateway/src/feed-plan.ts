/**
 * 投喂的**排产**：把「哪些已投喂、哪些暂未投喂」算成**一轮一批**（用户 2026-10-10 指定）。
 *
 * ## 用户的原话与前因后果
 *
 * > 「以**单个轮次为界**，每一个轮次结束就**传输下一批次**」
 * > 「限制**单个轮次时间为 30 分钟**来避免过长时间」
 * > 「关于半途而废……**断点续传**」
 *
 * 三句话合起来是一条流水线：
 *
 * ```
 * 读游标 ──▶ 算出"这一轮该喂哪几段" ──▶ 喂 ──▶ 推进游标 ──▶ 下一轮
 *              （就是本模块）                （feed-cursor）
 * ```
 *
 * **为什么排产要单独一个模块、而不是塞进投喂循环里**：
 * "哪几段归这一轮"是个**纯函数**（给总数、游标、每轮几段，答案就定了）。
 * 把它抽出来，就能**不开库、不投喂、不发请求**地测掉所有边界
 * （最后一批不满、游标正好落在批边界、总数中途变大……）——
 * 而那些边界正是"重喂一遍"和"漏喂几段"的发生地。
 *
 * ## 为什么**每轮固定几段**，而不是"喂到 30 分钟为止"
 *
 * 用户给的两条约束是**互补**的：段数是**排产**（可预测、可续传），
 * 30 分钟是**兜底**（防某一段特别大时卡住）。若只按时间切，
 * "这一轮喂了几段"就依赖于机器快慢 ⇒ **游标不可复现**，
 * 断点续传会变得没法验证。
 *
 * ⇒ 本模块只做段数排产；30 分钟上限由调用方用 `signal` 中止，
 *   而**中止后游标停在最后一个真的喂完的批次上**（见 {@link nextFeedTurn}）。
 *
 * @module @forlife/gateway/feed-plan
 */

/** 一段待投喂素材的位置（`from`/`to` **都含**，与人类说法一致："喂第 1 到第 50 段"）。 */
export interface FeedTurnRange {
  /** 本批起始段序号（从 1 开始）。 */
  readonly from: number
  /** 本批结束段序号（含）。 */
  readonly to: number
  /** 本批段数。 */
  readonly count: number
}

/** 排产结果：进度 + 这一轮该喂什么。 */
export interface FeedPlan {
  readonly total: number
  /** 已经喂完的段数（= 游标的 `fedThrough`）。 */
  readonly fed: number
  /** 还没喂的段数。 */
  readonly pending: number
  /** 是否已经全部喂完。 */
  readonly done: boolean
  /**
   * **下一轮**该喂的那一批；`done` 时为 `undefined`。
   *
   * ⚠️ 批次从**游标之后**开始算，而不是从"第 N 个整批"算 ——
   * 否则上一轮被 30 分钟上限截断时（游标停在半个批中间），
   * 下一轮会**重喂**已喂过的那半批（幂等，但白干）。
   */
  readonly next: FeedTurnRange | undefined
}

/** 排产选项。 */
export interface FeedPlanOptions {
  /** 这份素材一共几段。 */
  readonly total: number
  /** 游标：已经喂完几段（缺省 0 = 一段都没喂）。 */
  readonly fedThrough?: number
  /** 每轮喂几段（必须 ≥ 1）。 */
  readonly perTurn: number
}

/**
 * 算出一轮的排产。
 *
 * 纯函数：不碰库、不投喂、不发请求。
 */
export function nextFeedTurn(options: FeedPlanOptions): FeedPlan {
  const total = Math.max(0, Math.trunc(options.total))
  const perTurn = Math.max(1, Math.trunc(options.perTurn))
  // 夹住游标：它可能比总段数大（素材变短了）或是坏的（负数）
  const fed = Math.min(total, Math.max(0, Math.trunc(options.fedThrough ?? 0)))
  const pending = total - fed
  if (pending <= 0) {
    return { total, fed, pending: 0, done: true, next: undefined }
  }
  const from = fed + 1
  const to = Math.min(total, fed + perTurn)
  return { total, fed, pending, done: false, next: { from, to, count: to - from + 1 } }
}

/**
 * 把**还没喂的**全部排成批次（面板要展示"哪些已投喂哪些暂未投喂"时用它）。
 *
 * `limit` 是防呆上限：素材有 283 段而每轮 50 段时这里只该有 6 项，
 * 但**坏的 `perTurn`（例如 0 或负数）会造成死循环** —— 所以即使 `perTurn` 已经被
 * {@link nextFeedTurn} 夹到 ≥1，这里仍然**再夹一次并设一个项数上限**。
 * 一个"展示用"的函数把界面卡死是最没道理的失败方式。
 */
export function pendingFeedTurns(options: FeedPlanOptions & { readonly limit?: number }): readonly FeedTurnRange[] {
  const out: FeedTurnRange[] = []
  const limit = Math.max(1, Math.trunc(options.limit ?? 1000))
  let fed = options.fedThrough
  for (let i = 0; i < limit; i += 1) {
    const plan = nextFeedTurn({ ...options, ...(fed === undefined ? {} : { fedThrough: fed }) })
    if (plan.next === undefined) break
    out.push(plan.next)
    fed = plan.next.to
  }
  return out
}

/** 一行进度（面板 / 日志 / 提示词共用同一份说法，免得三处口径不一致）。 */
export function describeFeedPlan(plan: FeedPlan): string {
  if (plan.done) return `已投喂 ${String(plan.fed)}/${String(plan.total)} 段（全部完成）`
  return (
    `已投喂 ${String(plan.fed)}/${String(plan.total)} 段，` +
    `本轮待喂第 ${String(plan.next?.from ?? 0)}–${String(plan.next?.to ?? 0)} 段，` +
    `剩余 ${String(plan.pending)} 段`
  )
}
