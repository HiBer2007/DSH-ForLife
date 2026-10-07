/**
 * 验收标准 #4：**碎片超限时自动合并/淘汰**。
 *
 * ## 这条标准缺的是什么
 *
 * 交付物 4 已经实现了「合并 + 淘汰」，维护循环也已经**每 30 分钟跑一次**。
 * 缺的是**"超限"这个触发条件** —— 现在的行为是"到点就扫一遍"，
 * 而不是"**攒到一定程度才动手**"。
 *
 * 两者的差别在**代价**：
 *  - "到点就扫"：每 30 分钟全表扫一遍，**大部分时候什么也没做**；
 *  - "超限才动手"：平时不扫，**攒到阈值才扫** —— 而那正是"超限"要表达的意思。
 *
 * ## 阈值怎么定（**不是拍脑袋**）
 *
 * 用**占比**而不是绝对条数：
 *  - 绝对条数在"小库"上永远触发不了（10 条碎片对大库是噪音，对小库是全部）；
 *  - 占比能表达"碎片**占了多少地方**" —— 那才是"渲染区占比"的意思。
 *
 * 所以：`fragmented / (fragmented + active) >= 阈值` ⇒ 动手。
 *
 * ## 为什么保留"时间兜底"
 *
 * 只看占比的话，一个**永远达不到阈值**的库会**永远不清理** ——
 * 而碎片是**只增不减**的（每次压缩都产生一批）。
 * 所以再加一条"距上次清理超过 N 天也动手"，两条满足其一即可。
 *
 * @module @forlife/store/fragment-threshold
 */
import type { DatabaseSync } from 'node:sqlite'

/** 阈值策略。 */
export interface FragmentThresholdPolicy {
  /** 碎片占比达到多少就动手（0 = 不按占比触发）。 */
  readonly ratio: number
  /** 碎片条数至少这么多才考虑（防小库抖动：3 条碎片占 30% 是噪音）。 */
  readonly minCount: number
  /** 距上次清理超过多少天也动手（0 = 不按时间兜底）。 */
  readonly staleDays: number
}

/** 默认：占比 20%、至少 100 条、7 天兜底。 */
export const DEFAULT_FRAGMENT_THRESHOLD: FragmentThresholdPolicy = {
  ratio: 0.2,
  minCount: 100,
  staleDays: 7,
}

/** 判定结果。 */
export interface ThresholdDecision {
  readonly shouldRun: boolean
  readonly reason: string
  readonly fragmented: number
  readonly active: number
  readonly ratio: number
}

/** 从环境变量读阈值。 */
export function fragmentThresholdFromEnv(env: Record<string, string | undefined>): FragmentThresholdPolicy {
  const num = (key: string, fallback: number, min: number): number => {
    const text = env[key]
    // ★ **必须先判空**（踩过的坑）：`Number('')` 是 **0**，而 `0 >= min` 成立 ⇒
    // 环境变量**没设**时会被当成"0 = 关闭该条"，而不是用默认值。
    // **空值与 0 分不开** —— 这个项目里已经反复踩到（沉降策略、限额…）。
    if (text === undefined || text.trim() === '') return fallback
    const raw = Number(text)
    // 非法值（NaN）也回落默认；**负数非法**
    return Number.isFinite(raw) && raw >= min ? raw : fallback
  }
  return {
    // 占比是 0..1
    ratio: num('FORLIFE_FRAGMENT_RATIO', DEFAULT_FRAGMENT_THRESHOLD.ratio, 0),
    minCount: num('FORLIFE_FRAGMENT_MIN_COUNT', DEFAULT_FRAGMENT_THRESHOLD.minCount, 0),
    staleDays: num('FORLIFE_FRAGMENT_STALE_DAYS', DEFAULT_FRAGMENT_THRESHOLD.staleDays, 0),
  }
}

/** 上次清理时间存在 `forlife_state` 里（**跨重启保留**）。 */
export const LAST_FRAGMENT_CLEAN_KEY = 'fragment.last_clean_at'

/**
 * 判定"该不该动手"。
 *
 * **纯函数**（除了读两个计数与上次清理时间）—— 便于测试，
 * 也便于在面板上显示"为什么现在不动手"。
 */
export function shouldRunFragmentMaintenance(
  db: DatabaseSync,
  policy: FragmentThresholdPolicy = DEFAULT_FRAGMENT_THRESHOLD,
  now: Date = new Date(),
): ThresholdDecision {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'fragmented' THEN 1 ELSE 0 END) AS fragmented,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM mid_memory_entries`,
    )
    .get() as { fragmented?: number | null; active?: number | null } | undefined

  const fragmented = Number(counts?.fragmented ?? 0)
  const active = Number(counts?.active ?? 0)
  const total = fragmented + active
  const ratio = total === 0 ? 0 : fragmented / total

  if (fragmented === 0) {
    return { shouldRun: false, reason: '没有碎片', fragmented, active, ratio }
  }

  // ① 占比触发（**要先过最小条数** —— 3 条碎片占 30% 是噪音，不是信号）
  if (policy.ratio > 0 && fragmented >= policy.minCount && ratio >= policy.ratio) {
    return {
      shouldRun: true,
      reason: `碎片占比 ${(ratio * 100).toFixed(1)}% ≥ ${(policy.ratio * 100).toFixed(0)}%（且 ≥ ${String(policy.minCount)} 条）`,
      fragmented,
      active,
      ratio,
    }
  }

  // ② 时间兜底（**只看占比的话，永远达不到阈值的库会永远不清理**，
  //    而碎片是只增不减的 —— 每次压缩都产生一批）
  // **时间兜底也要过最小条数**（测试暴露的）：
  // 不过的话，3 条碎片也会触发一次全表扫描 ——
  // 而"最小条数"的本意正是挡这种噪音。兜底是"防漏"，不是"绕过闸门"。
  if (policy.staleDays > 0 && fragmented >= policy.minCount) {
    const last = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(LAST_FRAGMENT_CLEAN_KEY) as
      | { value: string }
      | undefined
    if (last === undefined) {
      return { shouldRun: true, reason: '从未清理过（时间兜底）', fragmented, active, ratio }
    }
    const ageDays = (now.getTime() - new Date(last.value).getTime()) / 86_400_000
    if (ageDays >= policy.staleDays) {
      return {
        shouldRun: true,
        reason: `距上次清理 ${ageDays.toFixed(1)} 天 ≥ ${String(policy.staleDays)} 天（时间兜底）`,
        fragmented,
        active,
        ratio,
      }
    }
  }

  return {
    shouldRun: false,
    reason:
      fragmented < policy.minCount
        ? `碎片 ${String(fragmented)} 条 < 最小条数 ${String(policy.minCount)}（太少，扫一遍不值得）`
        : `碎片 ${String(fragmented)} 条（占比 ${(ratio * 100).toFixed(1)}%），未到阈值且未过期`,
    fragmented,
    active,
    ratio,
  }
}

/** 记下"刚清理过"（**跨重启保留** —— 否则每次重启都会触发一次时间兜底）。 */
export function markFragmentCleaned(db: DatabaseSync, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(LAST_FRAGMENT_CLEAN_KEY, now.toISOString())
}
