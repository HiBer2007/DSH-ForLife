/**
 * **开始一次投喂运行** —— `startFeedRun()` 的生产入口（`FIX_PLAN.md` §23 那个洞）。
 *
 * ## 为什么需要它（这不是"再加个方便函数"）
 *
 * §23 的专项审计发现：`startFeedRun()` **零生产调用方**（全仓只有两个测试文件调它）
 * ⇒ `turn/start` 上 `readFeedRun()` **永远返回 `undefined`**
 * ⇒ 投喂轮次钩子判定"这一轮不是投喂轮" ⇒ **不排产、不写批次指针、不收窄工具**。
 *
 * ⇒ **整套投喂闭环（八块模块、40 条测试）在生产里是死的。**
 * 它不"错"，而是**没有入口去启动它** —— 与 `buildFailoverRuntime` 之前的状态一模一样。
 *
 * ## 它做什么
 *
 * 把**一份文件清单**变成一次**运行登记**（`forlife_state` 的 `feed_run` 键）：
 * 每段一个**可读路径**（模型要靠它去 `read`）、按**自然序**编号 1..N。
 *
 * ```
 * 一个目录里的 seg*.md  ──▶  segments: [{1, /…/seg2-006.md}, {2, …}, …]
 *                                     │
 *                                     ▼
 *                            startFeedRun(db, {source, kind, perTurn, segments})
 *                                     │
 *                                     ▼
 *            turn/start 才有东西可排产（游标 + feed-plan 才知道"这一轮喂哪几段"）
 * ```
 *
 * ## ★ 三个刻意的设计
 *
 * **① 按自然序排（`numeric: true`），不是字典序。**
 *   字典序下 `seg2-10.md` < `seg2-9.md` —— 那会让**投喂顺序错乱**，
 *   而投喂顺序就是"记忆形成的先后"，错乱之后很难发现（数字看起来都连续）。
 *   （素材若是零填充的 `006`/`010` 两者一样；但**不能依赖素材恰好零填充**。）
 *
 * **② 空清单 ⇒ 抛错，不许开一次"零段的运行"。**
 *   开了的话钩子会认为"在投喂"，于是**收窄她的工具却没有任何东西可喂** ——
 *   她会既不能正常用工具、又没活干。
 *
 * **③ 已经喂过的不重置。**
 *   本函数**只登记素材**，不碰游标（`feed-cursor.ts`）——
 *   于是"上次喂到第 58 段"这件事**自然保留**，这就是断点续传。
 *   想从头喂就显式 `clearFeedCursor()`。
 *
 * @module @forlife/gateway/feed-run-start
 */
import type { DatabaseSync } from 'node:sqlite'

import type { FeedKind } from './feed.ts'
import { startFeedRun, type FeedRun, type FeedRunSegment } from './feed-run.ts'

/** 开始一次运行要什么。 */
export interface StartFeedRunOptions {
  /** 来源名（**必须与游标、会话用同一个** —— 三者靠它关联）。 */
  readonly source: string
  readonly kind: FeedKind
  /** 每轮喂几段（「以单个轮次为界」的那个"一批"有多大）。 */
  readonly perTurn: number
  /** 有序的段路径（本函数会重新按自然序排一次，见模块头 ①）。 */
  readonly files: readonly string[]
  readonly now?: Date
}

/**
 * 自然序比较器（`seg2-9` < `seg2-10`）。
 *
 * 用 `Intl.Collator` 而不是手写 `parseInt` 切分：
 * 手写版要处理"同一目录里混着 `seg-006.md` 与 `seg-7.md`"这类情形，
 * 而 `Collator` 的 `numeric` 就是为这件事设计的。
 */
const NATURAL = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** 把一份文件清单排成段清单（**纯函数**，不碰库）。 */
export function planSegmentsFromFiles(files: readonly string[]): readonly FeedRunSegment[] {
  return [...files]
    .filter((path) => typeof path === 'string' && path.trim() !== '')
    .sort((a, b) => NATURAL.compare(a, b))
    .map((path, index) => {
      // 标签取**文件名**（面板与日志里比全路径好读；路径太长会把一行撑爆）
      const label = path.split(/[/\\]/).pop() ?? path
      return { index: index + 1, path, label }
    })
}

/**
 * 从一份文件清单开始一次投喂运行。
 *
 * @param db - 数据库。
 * @param options - 见 {@link StartFeedRunOptions}。
 * @returns 登记好的运行。
 * @throws 清单为空时（见模块头 ②）—— **宁可开不起来，也不要开一次"零段的运行"**。
 */
export function startFeedRunFromFiles(db: DatabaseSync, options: StartFeedRunOptions): FeedRun {
  const segments = planSegmentsFromFiles(options.files)
  if (segments.length === 0) {
    throw new Error(
      `投喂运行没开起来：素材清单是空的（来源 ${options.source}）—— ` +
        '开一次"零段的运行"会让钩子以为在投喂，于是**收窄她的工具却没有任何东西可喂**',
    )
  }
  if (!Number.isFinite(options.perTurn) || options.perTurn < 1) {
    throw new Error(`每轮段数必须是 ≥1 的整数（实际 ${String(options.perTurn)}）`)
  }
  return startFeedRun(db, {
    source: options.source,
    kind: options.kind,
    perTurn: Math.trunc(options.perTurn),
    segments,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}
