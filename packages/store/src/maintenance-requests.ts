/**
 * ★★ 维护请求 —— "**数据库即通道**"（`FIX_PLAN.md` §72 / §74）。
 *
 * ## 用户裁定
 * 「所有的沉降**都有手动触发途径，都有工具触发途径**」
 * （PLAN `src-01.md:342`「按需触发**沉降/碎片维护/复盘**任务」·
 *   `src-08.md:346`「碎片索引合并与淘汰（**定时 + 手动**）」）。
 *
 * ## ★ 为什么不能"让插件直接跑维护"
 * ★ `gateway/src/settle-loop.ts` 的模块头写明了为什么维护循环**只该有一个 owner**：
 *   ① **冷层根路径（`FORLIFE_ROOT_COLD`）是那个进程解析的** ——
 *      "不知道往哪搬"时唯一诚实的做法是不搬；
 *   ② HDD 沉降是**全局运维**，而插件可能被多个 profile 各起一份。
 * ⇒ ★ 让每个 profile 都去搬文件 = 互相踩。
 *
 * ## ★★ 所以走"请求"这条路（与 `wake_requests` 同一套做法）
 * ★ `wake_requests` 的建表注释写着：「**没有 HTTP、没有鉴权、没有 token 轮换**，
 *   与本项目到处在用的"数据库即通道"完全一致」。
 * ★ 方向相反：那边是 gateway 写、插件认领；**这边是插件写、gateway 认领**。
 * ★★ 而 **owner 认领之后跑的是同一条 `tick()`** ——
 *   ★ 这是"手动与自动走同一引擎"这句承诺的凭据（PLAN §2.14.14 警告过"两份实现迟早分叉"）。
 *
 * @module forlife-memory/maintenance-requests
 */
import type { DatabaseSync } from 'node:sqlite'

import { randomUUID } from 'node:crypto'

/**
 * 认领超时：认领了但这么久还没完成 ⇒ **放回 pending**。
 *
 * ★ 与 `wake-requests.ts` 同一条纪律：**不做这一步的话，认领者崩一次，
 *   那一行就永久卡在 `claimed` —— 而没人会去看**。
 * ★ 取 10 分钟：一轮维护最慢的是 blob 搬运与 HDD 沉降，正常远小于它。
 */
export const MAINTENANCE_CLAIM_TIMEOUT_MS = 10 * 60_000

/** 请求的维护种类。 */
export type MaintenanceKind =
  /** 三样都跑（blob 分层沉降 + 碎片维护 + 长期记忆 HDD 沉降）—— 与自动那条 `tick()` 完全一样。 */
  | 'full'
  /** 只跑碎片索引合并与淘汰（PLAN `src-08.md:346` 点名要"定时 + 手动"的那一项）。 */
  | 'fragments'

/** 一行维护请求。 */
export interface MaintenanceRequestRow {
  readonly id: string
  readonly kind: string
  readonly reason: string | null
  readonly requested_by: string
  readonly status: string
  readonly created_at: string
  readonly claimed_at: string | null
  readonly claimed_by: string | null
  readonly done_at: string | null
  readonly result: string | null
}

/**
 * 写一条维护请求。
 *
 * @param db - 库。
 * @param options - 种类、谁请求的、为什么。
 * @returns 新请求的 id。
 */
export function enqueueMaintenanceRequest(
  db: DatabaseSync,
  options: {
    readonly kind: MaintenanceKind
    readonly requestedBy: string
    readonly reason?: string | undefined
    readonly now?: Date | undefined
  },
): string {
  const id = `mreq_${randomUUID()}`
  const at = (options.now ?? new Date()).toISOString()
  db.prepare(
    `INSERT INTO maintenance_requests (id, kind, reason, requested_by, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, options.kind, options.reason ?? null, options.requestedBy, at)
  return id
}

/**
 * 认领待处理的请求（**owner 调它**）。
 *
 * ★ 先做**超时回收**（见 `MAINTENANCE_CLAIM_TIMEOUT_MS`），再认领。
 * ★ SQLite 没有 `UPDATE ... LIMIT` ⇒ **先选出 id，再逐个标记**（与 `claimWakeRequests` 一致）。
 *
 * @param db - 库。
 * @param claimer - 谁在认领（排障用，如 `gateway`）。
 * @param limit - 一次最多认领几条。
 * @param now - 当前时间（测试注入）。
 * @returns 被认领的行（`status` 已标成 `claimed`）。
 */
export function claimMaintenanceRequests(
  db: DatabaseSync,
  claimer: string,
  limit = 3,
  now: Date = new Date(),
): readonly MaintenanceRequestRow[] {
  const at = now.toISOString()
  const staleBefore = new Date(now.getTime() - MAINTENANCE_CLAIM_TIMEOUT_MS).toISOString()

  // **超时回收**：认领了但太久没完成的，放回 pending。
  // 不做这一步的话，认领者崩一次那一行就永久卡在 claimed —— 而没人会去看。
  db.prepare(
    `UPDATE maintenance_requests SET status = 'pending', claimed_at = NULL, claimed_by = NULL
     WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
  ).run(staleBefore)

  const rows = db
    .prepare("SELECT * FROM maintenance_requests WHERE status = 'pending' ORDER BY created_at LIMIT ?")
    .all(limit) as unknown as MaintenanceRequestRow[]
  for (const row of rows) {
    db.prepare("UPDATE maintenance_requests SET status = 'claimed', claimed_at = ?, claimed_by = ? WHERE id = ?").run(
      at,
      claimer,
      row.id,
    )
  }
  return rows.map((r) => ({ ...r, status: 'claimed', claimed_at: at, claimed_by: claimer }))
}

/**
 * 标记完成（成功或失败）。
 *
 * ★ **失败也要落 `result`** —— ★ 否则面板上看到的是"跑过了"，而实际什么都没做
 *   （§52：**"没做"与"做了但被挡住"看起来一样**）。
 *
 * @param db - 库。
 * @param id - 请求 id。
 * @param ok - 是否成功。
 * @param result - 人话说明（含失败原因）。
 * @param now - 当前时间。
 */
export function finishMaintenanceRequest(
  db: DatabaseSync,
  id: string,
  ok: boolean,
  result: string,
  now: Date = new Date(),
): void {
  db.prepare('UPDATE maintenance_requests SET status = ?, done_at = ?, result = ? WHERE id = ?').run(
    ok ? 'done' : 'failed',
    now.toISOString(),
    result,
    id,
  )
}

/** 待处理条数（面板与排障用）。 */
export function countPendingMaintenanceRequests(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM maintenance_requests WHERE status IN ('pending', 'claimed')")
    .get() as { n: number } | undefined
  return row?.n ?? 0
}

/** 最近的请求（面板用）。 */
export function listMaintenanceRequests(db: DatabaseSync, limit = 20): readonly MaintenanceRequestRow[] {
  return db
    .prepare('SELECT * FROM maintenance_requests ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as MaintenanceRequestRow[]
}
