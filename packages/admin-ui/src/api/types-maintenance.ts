/**
 * 「维护」接口返回类型 —— `GET /api/admin/maintenance` 与 `POST /api/admin/maintenance/run` 的契约。
 *
 * ★ 与 `packages/gateway/src/admin/api.ts` 的那两个端点一一对应；
 * ★ 形状对齐 `SettleTickResult`（`packages/gateway/src/settle-loop.ts`）。
 *
 * ## 为什么面板需要这一页（`FIX_PLAN.md` §76.5④）
 *
 * 后端端点 §74 就有了，但**前端一处都没接** ⇒ 人只能眼看着"自动那条腿"跑，
 * 没法手动催一轮。而 `ComingSoonView.vue:51` 早就对用户承诺过
 * 「手动触发一次压缩（**走与自动路径完全相同的引擎**）」——
 * 手动那条腿调的必须是**同一个 `tick()`**（守卫见
 * `packages/gateway/test/maintenance-manual-trigger-wiring.test.ts`）。
 */

/** 维护循环的状态（`GET /api/admin/maintenance`）。 */
export type MaintenanceStatus =
  | {
      /** ★ 本进程没有维护句柄（未配 `FORLIFE_ROOT_HOT` 或未启动）—— **如实说"没有"**。 */
      readonly available: false
      readonly reason: string
    }
  | {
      readonly available: true
      /** 自动那条腿开没开。 */
      readonly enabled: boolean
      readonly intervalMs: number
      /** ★ `intervalMs <= 0` ⇒ **惰性**：循环在、但不排计时器 —— 手动触发最有用的场景。 */
      readonly passive: boolean
      /** 一轮最多搬多少。 */
      readonly limit: number
      readonly disabledReason?: string
    }

/** 碎片维护那一段（只有跑了才会带回）。 */
export interface MaintenanceFragments {
  readonly merged: boolean
  readonly evicted: number
  readonly refused: number
  readonly orphans: number
}

/** 长期记忆的 HDD 沉降那一段（与 blob 沉降分开报）。 */
export interface MaintenanceLongTerm {
  readonly settled: number
  readonly skipped: number
  readonly failed: number
  readonly failures: readonly string[]
  readonly coldRoot: string
  readonly fellBack: boolean
}

/** 一轮的结果（`POST /api/admin/maintenance/run`）。 */
export interface MaintenanceRunResponse {
  readonly ok: true
  readonly result: {
    readonly moved: number
    readonly skipped: number
    readonly failed: number
    /** 失败原因（最多几条，够排障就行）。 */
    readonly failures: readonly string[]
    readonly fragments?: MaintenanceFragments
    readonly longTerm?: MaintenanceLongTerm
  }
}

/**
 * 一轮跑什么。
 *
 * ★ 不传 = **三样都跑**（沉降 / 碎片维护 / 复盘）—— 与自动那条腿**完全同一条代码路径**；
 * ★ `'fragments'` = 只跑碎片索引合并与淘汰（PLAN `src-08.md:346` 点名要"定时 + 手动"的那一项）。
 */
export type MaintenanceScope = 'all' | 'fragments'
