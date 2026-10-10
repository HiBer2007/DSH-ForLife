/**
 * 投喂的**轮次钩子** —— 「以单个轮次为界」那条规则的落点（用户 2026-10-10）。
 *
 * ## 它把前面六块串成一个闭环
 *
 * ```
 * turn/start ──▶ 读运行登记 ──▶ 读游标 ──▶ 排产
 *                    │                          │
 *                    │                          ├─▶ 写"本轮范围"进会话（提示段会渲染它）
 *                    │                          └─▶ 收窄工具（只留记忆 + 文件读写）
 *                    ▼
 *            （模型自己 read 素材 → feed_memory 整块记下）
 *                    ▼
 * turn/end   ──▶ 按**实际喂进去的段数**推进游标 ──▶ 解除工具掩码 ──▶ 喂完就收尾
 * ```
 *
 * ## ★ 三个"必须做对，做错了不会立刻炸"的地方
 *
 * 1. **`turn/start` 与 `turn/end` 必须配对**：掩码在 start 收窄、在 end 解除。
 *    若某条路径只进不出，**她的正常对话从此发不出 QQ 消息，而且没人会发现**。
 *    所以本模块把掩码句柄**攥在自己手里**（`#mask`），并且在 `turn/start`
 *    发现"上一轮的掩码还在"时**先解除再重新收窄**（自愈，而不是叠加）。
 * 2. **游标按实际喂进的段数推**（不是按批次大小）—— 按批次大小会让没喂的段
 *    被记成已喂 ⇒ **漏喂 = 丢记忆**（重喂只是慢）。
 * 3. **喂完要收尾**：结束运行登记 + 结束会话（"醒来"）。
 *    否则提示段会**永远**说"你在半梦半醒"，而那正是 `feed-frame.ts` 里
 *    那条"记忆 vs 现在"的边界被破坏的样子。
 *
 * ## 与 `runFeedTurn` 的分工
 *
 * `runFeedTurn`（`gateway/src/feed-turn.ts`）是**脚本驱动**路径：系统自己去调 `feed`。
 * 本模块是**模型驱动**路径：系统只负责"告诉它读哪一段 + 收窄工具 + 记账"，
 * 真正写库的是模型调用的 `feed_memory`。
 * 两条路共用 `feed-cursor` / `feed-plan`（那两个是纯逻辑），**不共用驱动器** ——
 * 因为"谁在喂"这件事根本不同。
 *
 * @module forlife-memory/feed-turn-hook
 */
import type { DatabaseSync } from 'node:sqlite'

import {
  advanceFeedCursor,
  advanceFeedSession,
  beginFeedSession,
  describeFeedPlan,
  endFeedRun,
  endFeedSession,
  nextFeedTurn,
  readFeedCursor,
  readFeedRun,
  readFeedSession,
  sliceSegments,
  type FeedRun,
} from '@forlife/gateway'

import { FEED_ALLOWED_TOOLS, type ToolRestrictHost } from './feed-restrict.ts'

/** 依赖（全部注入，便于在无 DSH 环境里测）。 */
export interface FeedTurnHookDeps {
  readonly db: DatabaseSync
  /** 宿主 `ctx.tools`（不给 = 不收窄，用于 CLI/测试）。 */
  readonly tools?: ToolRestrictHost | undefined
  readonly log: (message: string) => void
  readonly now?: (() => Date) | undefined
}

/** `turn/start` 的结果。 */
export interface FeedTurnStart {
  /** 这一轮是不是投喂轮。 */
  readonly active: boolean
  /** 本轮该读的段（含路径）—— 调用方拿它渲染"读哪儿"。 */
  readonly segments: readonly { readonly index: number; readonly path: string }[]
  /** 给人看的一行。 */
  readonly note: string
}

/** `turn/end` 的结果。 */
export interface FeedTurnEnd {
  readonly active: boolean
  /** 这一轮推进了几段。 */
  readonly advanced: number
  /** 是不是整份喂完了（喂完就该"醒来"）。 */
  readonly finished: boolean
  readonly note: string
}

/** 轮次钩子。 */
export interface FeedTurnHook {
  readonly onTurnStart: () => FeedTurnStart
  readonly onTurnEnd: (input: { readonly fedCount: number }) => FeedTurnEnd
  /** 当前有没有攥着掩码（测试与自愈用）。 */
  readonly maskHeld: () => boolean
}

const INACTIVE_START: FeedTurnStart = { active: false, segments: [], note: '' }

/**
 * 建一个轮次钩子。
 *
 * @param deps - 见 {@link FeedTurnHookDeps}。
 */
export function createFeedTurnHook(deps: FeedTurnHookDeps): FeedTurnHook {
  const log = deps.log
  const now = deps.now ?? ((): Date => new Date())
  /** ★ 自己攥着掩码句柄 —— 解除的责任只有一个地方，不会被两条路径各管一半。 */
  let mask: (() => void) | undefined

  const releaseMask = (): void => {
    if (mask === undefined) return
    const dispose = mask
    mask = undefined
    try {
      dispose()
      log('投喂期工具已恢复（掩码已解除）')
    } catch (error: unknown) {
      log(`⚠️ 解除工具掩码失败（已忽略）：${String(error).slice(0, 120)}`)
    }
  }

  const acquireMask = (): void => {
    // ★ 自愈：上一轮的掩码还攥着就先解除，而不是叠加（叠加会让"解除"变成减法，
    //   少解一次就永久留着收窄）
    releaseMask()
    if (deps.tools === undefined) return
    try {
      const handle = deps.tools.restrict({ allow: new Set(FEED_ALLOWED_TOOLS) })
      mask = () => {
        handle.dispose()
      }
      log(`投喂期工具已收窄：只保留 ${String(FEED_ALLOWED_TOOLS.length)} 个（记忆 + 文件读写）`)
    } catch (error: unknown) {
      log(`⚠️ 收窄工具失败（这一轮不做限制，但**不假装成功了**）：${String(error).slice(0, 120)}`)
    }
  }

  /** 收尾：结束运行登记 + 结束会话（"醒来"）。 */
  const finish = (run: FeedRun): void => {
    releaseMask()
    try {
      endFeedRun(deps.db)
      const session = readFeedSession(deps.db, { ignoreStale: true })
      if (session?.source === run.source) {
        // ⚠️ `endFeedSession` 是"删掉会话记录"= 提示段整段消失 = 她**醒来**
        //    （`feed-session.ts` 里写了为什么是删而不是标记 done）
        endFeedSession(deps.db)
      }
    } catch (error: unknown) {
      log(`⚠️ 投喂收尾失败（已忽略）：${String(error).slice(0, 120)}`)
    }
  }

  return {
    maskHeld: () => mask !== undefined,

    onTurnStart(): FeedTurnStart {
      let run: FeedRun | undefined
      try {
        run = readFeedRun(deps.db)
      } catch {
        run = undefined
      }
      if (run === undefined) {
        // ★ 没有投喂运行 ⇒ **必须把可能留着的掩码解除掉**。
        //   这条路径正是"上一轮崩了、掩码永远留着"的解药。
        releaseMask()
        return INACTIVE_START
      }

      const cursor = readFeedCursor(deps.db, run.source)
      const plan = nextFeedTurn({
        total: run.segments.length,
        fedThrough: cursor?.fedThrough ?? 0,
        perTurn: run.perTurn,
      })
      if (plan.done || plan.next === undefined) {
        log(`投喂已完成，收尾：${describeFeedPlan(plan)}`)
        finish(run)
        return { ...INACTIVE_START, note: describeFeedPlan(plan) }
      }

      const segments = sliceSegments(run, plan.next.from, plan.next.to)
      if (segments.length !== plan.next.count) {
        // 排产与素材对不上：**收窄工具比给错文件安全**，所以先解除，再如实说
        releaseMask()
        return {
          ...INACTIVE_START,
          note: `投喂运行与游标对不上（本轮该 ${String(plan.next.count)} 段、实际 ${String(segments.length)} 段）—— 这一轮不投喂`,
        }
      }

      // 把"本轮范围"写进会话 ⇒ 提示段渲染 `{{batch}}` 时就能告诉模型读哪儿
      const session = readFeedSession(deps.db, { ignoreStale: true })
      if (session === undefined) {
        beginFeedSession(deps.db, {
          source: run.source,
          as: run.kind,
          now: now(),
          batch: { from: plan.next.from, to: plan.next.to, total: run.segments.length },
        })
      } else {
        advanceFeedSession(deps.db, {
          source: run.source,
          as: run.kind,
          chunks: session.chunks,
          batches: session.batches,
          tokens: session.tokens,
          now: now(),
          batch: { from: plan.next.from, to: plan.next.to, total: run.segments.length },
        })
      }

      acquireMask()
      const note = describeFeedPlan(plan)
      log(`投喂轮次开始：${note}`)
      return { active: true, segments, note }
    },

    onTurnEnd(input): FeedTurnEnd {
      let run: FeedRun | undefined
      try {
        run = readFeedRun(deps.db)
      } catch {
        run = undefined
      }
      // ★ 无论有没有运行，**掩码都要解除** —— 这是"只进不出"那条故障的兜底
      if (run === undefined) {
        const held = mask !== undefined
        releaseMask()
        return { active: false, advanced: 0, finished: false, note: held ? '（已解除遗留的工具掩码）' : '' }
      }

      const fedCount = Math.max(0, Math.trunc(input.fedCount))
      const cursor = readFeedCursor(deps.db, run.source)
      const advanced = advanceFeedCursor(deps.db, run.source, {
        fedThrough: (cursor?.fedThrough ?? 0) + fedCount,
        total: run.segments.length,
        now: now(),
      })

      const plan = nextFeedTurn({
        total: run.segments.length,
        fedThrough: advanced.fedThrough,
        perTurn: run.perTurn,
      })
      releaseMask()
      if (plan.done) {
        finish(run)
        const note = `投喂完成（共 ${String(advanced.fedThrough)} 段）—— 收尾，醒来`
        log(note)
        return { active: true, advanced: fedCount, finished: true, note }
      }
      const note = `本轮喂入 ${String(fedCount)} 段；${describeFeedPlan(plan)}`
      log(note)
      return { active: true, advanced: fedCount, finished: false, note }
    },
  }
}
