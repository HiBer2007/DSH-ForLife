/**
 * **跑一次碎片合并**（D8 的编排层；用户 2026-10-13 裁定"BC 都实现、AB 都实现、配置时选"）。
 *
 * ## 这一层做什么（三层分工）
 *
 * | 层 | 模块 | 干什么 |
 * | :--- | :--- | :--- |
 * | 算 | `memory-core/fragment-merge` | 判据、分组、粗 hint（纯函数） |
 * | 写 | `store/fragment-merges` | 留痕、换 hint、标 `archived`、恢复 |
 * | ★ **编排** | **本模块** | 读候选 → 按契约键定策略 → 算 → （`shadow` 只记日志 / `apply` 落库） |
 *
 * ## ★★ 两条顺序纪律
 *
 * 1. ★ **先合并、后淘汰**：合并会让碎片变少，淘汰再去看"剩下哪些该退场"；
 *    反过来的话，淘汰可能先把"本可以和别人并成一条"的碎片删了 —— 那是**不可逆**的损失；
 * 2. ★ **`shadow` 模式不落库**：合并**改变模型看到的文本**（hint 是碎片唯一进上下文的东西），
 *    所以留了一条"只算不写、把结果写进日志"的路 —— 先看几天真实分组长什么样，再决定开不开。
 *
 * @module @forlife/memory-core/fragment-merge-run
 */
import type { DatabaseSync } from 'node:sqlite'

import { applyFragmentMerge, listMergeCandidates } from '@forlife/store'

import { planFragmentMerges, type HintGenerator, type MergeCandidate } from './fragment-merge.ts'
import { describeMergeSettings, mergeSettingsFromContract, type MergeSettings } from './fragment-merge-policy.ts'

/** 跑一次的结果（★ 无论哪种模式都返回，便于日志与测试）。 */
export interface MergeRunResult {
  /** 这次用的模式（`shadow` 只算不写）。 */
  readonly mode: MergeSettings['mode']
  /** 参与计算的候选数。 */
  readonly candidates: number
  /** 算出来的组数。 */
  readonly groups: number
  /** 组里涉及的碎片总数。 */
  readonly grouped: number
  /** 落库：换成粗 hint 的条数（`shadow` 恒为 0）。 */
  readonly hinted: number
  /** 落库：被标 `archived` 的条数（`shadow` 恒为 0）。 */
  readonly archived: number
  /** 落库：新写的留痕行数（`shadow` 恒为 0）。 */
  readonly recorded: number
  /** ★ 一句话说明（写进日志/审计 —— 事后能回答"当时按哪套判据、合了几组"）。 */
  readonly note: string
}

/** 跑一次的参数。 */
export interface MergeRunOptions {
  /** 策略（不传就按契约键读）。 */
  readonly settings?: MergeSettings
  /** 模型生成粗 hint 的回调（`hintMode: 'model'` 时需要）。 */
  readonly generate?: HintGenerator
  /** 粗 hint 的 token 上限（与 `fragment.maxHintTokens` 同源）。 */
  readonly maxHintTokens?: number
  /** 日志出口（可选；★ 不传就不打日志）。 */
  readonly log?: (message: string) => void
}

/**
 * 跑一次碎片合并。
 *
 * @param db - 库。
 * @param options - 参数。
 * @returns 结果。
 */
export async function runFragmentMerge(db: DatabaseSync, options: MergeRunOptions = {}): Promise<MergeRunResult> {
  const settings = options.settings ?? mergeSettingsFromContract(options.maxHintTokens)
  const rows = listMergeCandidates(db)
  const candidates: MergeCandidate[] = rows.map((row) => ({ id: row.id, entities: row.entities, hint: row.hint }))
  const plan = await planFragmentMerges(candidates, settings, {
    ...(options.generate === undefined ? {} : { generate: options.generate }),
  })
  const grouped = plan.groups.reduce((sum, group) => sum + group.sourceIds.length, 0)
  const base = {
    mode: settings.mode,
    candidates: candidates.length,
    groups: plan.groups.length,
    grouped,
  }

  if (settings.mode === 'shadow') {
    const note =
      `碎片合并（shadow：只算不写）：候选 ${String(candidates.length)} 条 ⇒ ${String(plan.groups.length)} 组、` +
      `涉及 ${String(grouped)} 条。${describeMergeSettings(settings)}`
    options.log?.(note)
    return { ...base, hinted: 0, archived: 0, recorded: 0, note }
  }

  let hinted = 0
  let archived = 0
  let recorded = 0
  for (const group of plan.groups) {
    const [mergedId, ...sourceIds] = group.sourceIds
    if (mergedId === undefined) continue
    const result = applyFragmentMerge(db, {
      mergedId,
      sourceIds,
      hint: group.hint,
      rule: group.rule,
    })
    hinted += result.hinted
    archived += result.archived
    recorded += result.recorded
  }
  const note =
    `碎片合并（apply）：候选 ${String(candidates.length)} 条 ⇒ ${String(plan.groups.length)} 组；` +
    `换 hint ${String(hinted)} 条、归档 ${String(archived)} 条、留痕 ${String(recorded)} 行。` +
    `${describeMergeSettings(settings)}`
  options.log?.(note)
  return { ...base, hinted, archived, recorded, note }
}
