/**
 * **一次投喂运行**的登记（模型驱动路径的地基）。
 *
 * ## 为什么需要它
 *
 * 「以单个轮次为界，每一个轮次结束就传输下一批次」这条要在 `turn/start` 里执行，
 * 而那时系统必须能回答三个问题：
 *
 * 1. **这是哪一次投喂？**（来源、算知识还是经历）
 * 2. **一共几段、这一轮该喂第几段？**（→ `feed-cursor` + `feed-plan`）
 * 3. ★ **那一段"是什么"？** —— 这一段是**要模型去读的东西**，所以它必须带
 *    **可读的路径**，不能只是一个序号
 *
 * 前两个问题由 `feed-cursor` / `feed-plan` 回答。**第三个是本模块存在的理由**：
 * 模型驱动路径里素材是**模型自己去 `read`** 的（白名单里留文件读写工具就是这个原因），
 * 所以"第 24 段"这句话对它是**没法执行的** —— 它需要知道**去读哪个文件**。
 *
 * ## 为什么不复用 `feed_session`
 *
 * `feed_session`（`forlife_state` 里的 `feed_session` 键）回答的是
 * "**现在在不在消化记忆**" —— 它是一行**瞬时状态**，且必须能被提示段**廉价地**读到。
 * 而一次投喂运行要带**每一段的路径**（283 段 ⇒ 一大坨 JSON），
 * 塞进那条会话记录会让每次渲染提示词都去解析它。
 *
 * ⇒ 分开：**会话**说"在不在消化"，**运行登记**说"消化的是哪一份、每一段在哪"。
 * 两者用同一个 `source` 关联（游标也是按 source 记的）。
 *
 * ## ★ 坏数据一律当"没有这次运行"
 *
 * 与 `feed-session` / `feed-cursor` 同一条纪律：读取路径**永不抛**。
 * 没有运行登记 ⇒ 投喂期的轮次推进**什么都不做**（而不是猜一份出来）。
 *
 * @module @forlife/gateway/feed-run
 */
import type { DatabaseSync } from 'node:sqlite'

import type { FeedKind } from './feed.ts'

/** `forlife_state` 里的键名。 */
export const FEED_RUN_KEY = 'feed_run'

/** 一段素材：模型要读的那个东西。 */
export interface FeedRunSegment {
  /** 段序号（从 1 开始，与 `feed-plan` 的口径一致）。 */
  readonly index: number
  /**
   * ★ **模型该去读的路径**（绝对或相对于 DSH 工作目录）。
   *
   * 这就是"模型驱动投喂"能转起来的关键：不告诉它读哪儿，它就只能瞎猜。
   */
  readonly path: string
  /** 可选：给人看的标签（文件名 / 标题），面板与日志用。 */
  readonly label?: string
}

/** 一次投喂运行。 */
export interface FeedRun {
  readonly source: string
  readonly kind: FeedKind
  /** 每轮喂几段（「以单个轮次为界」的那个"一批"有多大）。 */
  readonly perTurn: number
  readonly segments: readonly FeedRunSegment[]
  readonly startedAt: string
}

/** 开一次投喂运行（同源重复开 = 覆盖，投喂是低频人工动作）。 */
export function startFeedRun(db: DatabaseSync, run: Omit<FeedRun, 'startedAt'> & { readonly now?: Date }): FeedRun {
  const record: FeedRun = {
    source: run.source,
    kind: run.kind,
    perTurn: run.perTurn,
    segments: run.segments,
    startedAt: (run.now ?? new Date()).toISOString(),
  }
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(FEED_RUN_KEY, JSON.stringify(record))
  return record
}

/** 结束（**删掉**，与 `endFeedSession` 同一个理由：边界要干净，"已经结束的运行"留着只会误导）。 */
export function endFeedRun(db: DatabaseSync): void {
  db.prepare('DELETE FROM forlife_state WHERE key = ?').run(FEED_RUN_KEY)
}

/** 读当前运行。**任何异常路径都返回 `undefined`**（缺键 / 坏 JSON / 字段不全）。 */
export function readFeedRun(db: DatabaseSync): FeedRun | undefined {
  let raw: string | undefined
  try {
    const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(FEED_RUN_KEY) as
      | { value?: string }
      | undefined
    raw = row?.value
  } catch {
    return undefined
  }
  if (raw === undefined || raw.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const source = typeof record['source'] === 'string' ? record['source'] : ''
  const kind = record['kind']
  const perTurn = record['perTurn']
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : ''
  if (source === '' || startedAt === '') return undefined
  if (kind !== 'knowledge' && kind !== 'experience') return undefined
  if (typeof perTurn !== 'number' || !Number.isFinite(perTurn) || perTurn < 1) return undefined

  const segments = readSegments(record['segments'])
  if (segments.length === 0) return undefined
  return { source, kind, perTurn: Math.trunc(perTurn), segments, startedAt }
}

/**
 * 读段清单。
 *
 * ⚠️ **一段坏就整份当没有**吗？不 —— 那是这里唯一一处与"坏数据当没有"不同的地方，
 * 理由：段清单是**连续**的（序号就是它的位置）。若跳过中间一段，
 * `feed-plan` 会按"剩下 N-1 段"排产 ⇒ **后面所有段的序号都错位** ⇒
 * 模型会被指到**错误的文件**上。**宁可整份作废重来**（投喂幂等），也不要错位。
 */
function readSegments(value: unknown): readonly FeedRunSegment[] {
  if (!Array.isArray(value)) return []
  const out: FeedRunSegment[] = []
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const index = record['index']
    const path = record['path']
    if (typeof index !== 'number' || Math.trunc(index) !== i + 1) return []
    if (typeof path !== 'string' || path.trim() === '') return []
    const label = typeof record['label'] === 'string' ? record['label'] : undefined
    out.push({ index: i + 1, path, ...(label === undefined ? {} : { label }) })
  }
  return out
}

/**
 * 取"本轮该读的那几段"。
 *
 * @param run - 当前运行。
 * @param from - 从第几段开始（= 游标 + 1）。
 * @param to - 到第几段为止（含，= `feed-plan` 算出来的 `to`）。
 * @returns 段清单里的那一片；**越界时返回 `[]`**（宁可什么都不给，也不给错的文件）。
 */
export function sliceSegments(
  run: FeedRun,
  from: number,
  to: number,
): readonly FeedRunSegment[] {
  if (from < 1 || to < from || to > run.segments.length) return []
  return run.segments.slice(from - 1, to)
}

/**
 * 把"本轮该读哪几段"说成**模型能执行的一句话**。
 *
 * ★ 这是整条链上**唯一**给模型看的说法，所以两种情形都要能读懂：
 *  - 有路径 ⇒ 直接把路径列出来（它照着 `read` 就行）
 *  - 一条路径都没有 ⇒ **明说"没有可读的东西"**，而不是留一句空的
 *    （留空会让它去猜，而猜出来的路径是读不到的）
 */
export function describeFeedRunBatch(segments: readonly FeedRunSegment[]): string {
  if (segments.length === 0) return '（本轮没有可读的素材：请从这一份尚未投喂的部分接着读）'
  const paths = segments.map((segment) => segment.path)
  if (paths.length === 1) return paths[0] as string
  return paths.join('、')
}
