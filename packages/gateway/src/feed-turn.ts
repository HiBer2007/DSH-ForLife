/**
 * **一轮投喂**的执行器：把游标、排产、工具收窄、30 分钟上限串成一条。
 *
 * ## 用户给的四条，在这里合成一个动作
 *
 * | 用户的话 | 落在哪 |
 * | :--- | :--- |
 * | 「**只开放**有关于记忆和文件读写的工具」 | `restrict` 注入（`ctx.tools.restrict`），**本模块只调不实现** |
 * | 「以**单个轮次**为界，每一个轮次结束就传输下一批次」 | 一次 `runFeedTurn` = **恰好一批** |
 * | 「限制**单个轮次时间为 30 分钟**」 | `AbortSignal.timeout`，**默认 30 分钟** |
 * | 「半途而废……**断点续传**」 | 游标按**实际喂完的段数**推进（不是按"批次大小"推） |
 *
 * ## ★ 两个刻意不在这里做的事
 *
 * **① 不实现工具掩码。** 它属于 DSH 那侧（`ctx.tools.restrict`），本模块只接一个
 * **结构化类型**的 `restrict`。这样它能在没有 DSH 的环境里被测，
 * 也不会让"哪些工具被禁"这件事有两个真源。
 *
 * **② 不自己算"喂了几段"。** 由注入的 `feed` 回报 `fedCount`。
 * 理由：只有真正在写库的那一层知道**中止时到底写进去了几段**
 * （`feedInput` 的 `chunkCount`）。若这里按"批次大小"推进游标，
 * 30 分钟截断时就会**把没喂的段记成已喂** —— 那是**漏喂**，
 * 而漏喂是这套东西里唯一真正不可接受的结果（重喂只是慢，漏喂是丢记忆）。
 *
 * @module @forlife/gateway/feed-turn
 */
import type { DatabaseSync } from 'node:sqlite'

import { advanceFeedCursor, readFeedCursor } from './feed-cursor.ts'
import { describeFeedPlan, nextFeedTurn, type FeedPlan } from './feed-plan.ts'

/** 用户指定的单轮上限：**30 分钟**。 */
export const DEFAULT_FEED_TURN_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 工具掩码的**结构化**接口（与 `dsh-component/src/feed-restrict.ts` 的 `ToolRestrictHost`
 * 形状一致，但**刻意不 import 它** —— 那会让 gateway 依赖 dsh-component，方向反了）。
 */
export interface FeedTurnTools {
  readonly restrict: (filter: {
    readonly allow?: ReadonlySet<string>
    readonly deny?: ReadonlySet<string>
  }) => { readonly dispose: () => void }
}

/** 一批的投喂函数（由调用方适配 `feedInput`）。 */
export type FeedBatchFn = (
  items: readonly unknown[],
  indexOffset: number,
  signal: AbortSignal,
) => Promise<{ readonly fedCount: number; readonly detail?: unknown }>

/** 一次投喂轮次的选项。 */
export interface FeedTurnOptions {
  readonly db: DatabaseSync
  readonly source: string
  /** 这份素材一共几段。 */
  readonly total: number
  /** 每轮喂几段。 */
  readonly perTurn: number
  /** 这一段区间对应的条目（长度应当 = `plan.next.count`）。 */
  readonly items: readonly unknown[]
  readonly feed: FeedBatchFn
  /** 工具掩码（不给就不收窄 —— CLI 路径没有 agent，本来也没有工具可收窄）。 */
  readonly tools?: FeedTurnTools | undefined
  /** 要禁用的工具白名单（`undefined` = 只调 `restrict({allow})` 由调用方决定）。 */
  readonly allowTools?: ReadonlySet<string> | undefined
  readonly timeoutMs?: number | undefined
  readonly now?: (() => Date) | undefined
  readonly log?: ((message: string) => void) | undefined
}

/** 一次投喂轮次的结果。 */
export interface FeedTurnOutcome {
  /** 这一轮**之前**的排产（说清"本轮该喂第几到第几段"）。 */
  readonly plan: FeedPlan
  /** 实际喂进去了几段（中止时可能少于 `plan.next.count`）。 */
  readonly fedCount: number
  /** 是不是被 30 分钟上限（或外部 signal）截断的。 */
  readonly aborted: boolean
  /** 游标推进到了哪。 */
  readonly fedThrough: number
  readonly detail?: unknown
}

/** 一步到位：读游标 → 排产 → 收窄 → 喂 → 推进游标 → 解除。 */
export async function runFeedTurn(options: FeedTurnOptions): Promise<FeedTurnOutcome> {
  const log = options.log ?? ((): void => undefined)
  const now = options.now ?? ((): Date => new Date())

  const cursor = readFeedCursor(options.db, options.source)
  const plan = nextFeedTurn({
    total: options.total,
    fedThrough: cursor?.fedThrough ?? 0,
    perTurn: options.perTurn,
  })

  if (plan.done || plan.next === undefined) {
    log(`投喂已完成：${describeFeedPlan(plan)}`)
    return { plan, fedCount: 0, aborted: false, fedThrough: plan.fed }
  }

  const batch = options.items.slice(0, plan.next.count)
  if (batch.length !== plan.next.count) {
    // 素材与排产对不上：**如实报错而不是照喂**（照喂会把游标推到一个没喂满的位置，
    // 下次就从那儿接着喂 ⇒ 中间那几段**永远不会被喂**）
    throw new Error(
      `投喂排产与素材对不上：本轮该喂 ${String(plan.next.count)} 段，实际只拿到 ${String(batch.length)} 段` +
        `（来源 ${options.source}）`,
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_FEED_TURN_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  const release = acquireToolMask(options, log)

  let fedCount = 0
  let detail: unknown
  let aborted = false
  try {
    const outcome = await options.feed(batch, plan.next.from - 1, signal)
    fedCount = Math.max(0, Math.trunc(outcome.fedCount))
    detail = outcome.detail
    aborted = signal.aborted
  } finally {
    // ★ 无论成功、失败、超时都要解除 —— 这是把 `restrict` 包在 `finally` 里的全部理由
    release()
  }

  // 游标按**实际喂完的段数**推进（见模块头 ②）
  const advanced = advanceFeedCursor(options.db, options.source, {
    fedThrough: plan.fed + fedCount,
    total: options.total,
    now: now(),
  })
  log(
    `投喂一轮：${describeFeedPlan(plan)}｜实际喂入 ${String(fedCount)} 段` +
      `${aborted ? '（**被 30 分钟上限截断**，剩下的留在游标里，下一轮接着喂）' : ''}` +
      `｜游标 ${String(advanced.fedThrough)}/${String(options.total)}`,
  )

  return {
    plan,
    fedCount,
    aborted,
    fedThrough: advanced.fedThrough,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * 套上工具掩码（没给就返回一个空操作）。
 *
 * ★ **幂等在这里也保证了**：即使调用方的 `dispose` 不幂等，`release` 也只被调一次
 *   （它在 `finally` 里，而 `finally` 只跑一次）。
 */
function acquireToolMask(options: FeedTurnOptions, log: (message: string) => void): () => void {
  const tools = options.tools
  if (tools === undefined) return () => undefined

  const allow = options.allowTools
  const handle = tools.restrict(allow === undefined ? {} : { allow })
  log(
    allow === undefined
      ? '投喂期：已套用调用方给的工具掩码'
      : `投喂期工具已收窄：只保留 ${String(allow.size)} 个（记忆 + 文件读写）`,
  )
  return () => {
    handle.dispose()
    log('投喂期工具已恢复（掩码已解除）')
  }
}
