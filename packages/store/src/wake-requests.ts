/**
 * 唤醒请求队列（PLAN 阶段 8 的**方向性调整**）。
 *
 * ## 为什么不再用 HTTP
 *
 * 原设计：gateway 通过 HTTP 调 DSH 的 `/api/forlife/wake`。
 * 真机验证时卡在 **DSH 自己的鉴权**上：
 *
 * > DSH 的类型注释（`dsh-client-connection/lib/types/rpc.d.ts:118`）：
 * > `Handle one request **after** the physical carrier has applied its trust and authentication p…`
 *
 * 也就是说**注册的路由是在 DSH 鉴权之后才被调用的，没法绕过**。
 * 而 DSH 的 web token 是"基于时间的 HMAC，**重启后立即失效**"——
 * gateway 拿不到一个稳定凭据。真机表现：`桥拒绝（HTTP 401）：unauthorized`。
 *
 * ## 反转方向：数据库就是通道
 *
 * ```
 * gateway 引擎决定唤醒 → 写一行 wake_requests（status=pending）
 *                              ↓
 * 插件侧（DSH 进程内）每秒轮询 → 认领 → 直接调 agent.followup()
 * ```
 *
 * **为什么这是对的**：
 *  - **没有 HTTP、没有鉴权、没有 token 轮换** —— 问题从根上消失；
 *  - 与本项目**已经到处在用的"数据库即通道"完全一致**
 *    （工具→引擎、监视源→引擎、插件→引擎，都是这个模式）；
 *  - 插件**本来就在 DSH 进程内**，有 `sessionController` / `sessions` / `agents` 的完整访问权；
 *  - 延迟与引擎 tick 同量级（1 秒）。
 *
 * ## 认领（claim）而不是"读了就删"
 *
 * 插件可能**处理到一半崩掉**。读了就删的话那次唤醒**静默丢失**——
 * 而"模型该做的事没做"是最难发现的一种失败。
 * 认领 + 超时回收的话，崩溃后那一行会被重新认领。
 *
 * @module @forlife/store/wake-requests
 */
import type { DatabaseSync } from 'node:sqlite'


/** 一行唤醒请求。 */
export interface WakeRequestRow {
  readonly id: string
  readonly trigger_id: string
  readonly session_id: string
  readonly text: string
  readonly source_kind: string
  readonly summary: string
  readonly status: string
  readonly created_at: string
  readonly claimed_at: string | null
  readonly claimed_by: string | null
  readonly done_at: string | null
  readonly result: string | null
}

/** 认领超时（毫秒）：超过这个时间还没完成，就认为认领者崩了。 */
export const CLAIM_TIMEOUT_MS = 120_000

/** 入队一条唤醒请求。 */
export function enqueueWakeRequest(
  db: DatabaseSync,
  input: {
    readonly triggerId: string
    readonly sessionId: string
    readonly text: string
    readonly sourceKind: string
    readonly summary: string
    readonly now?: Date
  },
): string {
  const id = `wr_${crypto.randomUUID()}`
  const at = (input.now ?? new Date()).toISOString()
  db.prepare(
    `INSERT INTO wake_requests (id, trigger_id, session_id, text, source_kind, summary, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, input.triggerId, input.sessionId, input.text, input.sourceKind, input.summary, at)
  return id
}

/**
 * 认领待处理的请求（**含超时回收**）。
 *
 * @param claimer - 认领者标识（如插件进程的 pid），排障时能看出是谁拿走的。
 * @param limit - 一次最多认领几条（防一次吃太多把内存打满）。
 */
export function claimWakeRequests(
  db: DatabaseSync,
  claimer: string,
  limit = 5,
  now: Date = new Date(),
): readonly WakeRequestRow[] {
  const at = now.toISOString()
  const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString()

  // **超时回收**：认领了但太久没完成的，放回 pending。
  // 不做这一步的话，插件崩一次那一行就永久卡在 claimed —— 而没人会去看。
  db.prepare(
    `UPDATE wake_requests SET status = 'pending', claimed_at = NULL, claimed_by = NULL
     WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
  ).run(staleBefore)

  // 认领：先选出 id，再逐个标记（SQLite 没有 UPDATE ... LIMIT）
  const rows = db
    .prepare("SELECT * FROM wake_requests WHERE status = 'pending' ORDER BY created_at LIMIT ?")
    .all(limit) as unknown as WakeRequestRow[]
  for (const row of rows) {
    db.prepare("UPDATE wake_requests SET status = 'claimed', claimed_at = ?, claimed_by = ? WHERE id = ?").run(at, claimer, row.id)
  }
  return rows.map((r) => ({ ...r, status: 'claimed', claimed_at: at, claimed_by: claimer }))
}

/** 标记完成（成功或失败）。 */
export function completeWakeRequest(db: DatabaseSync, id: string, result: string, now: Date = new Date()): void {
  db.prepare("UPDATE wake_requests SET status = 'done', done_at = ?, result = ? WHERE id = ?").run(now.toISOString(), result, id)
}

/** 待处理条数（面板与排障用）。 */
export function countPendingWakeRequests(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM wake_requests WHERE status != 'done'").get() as { n: number } | undefined
  return row?.n ?? 0
}

/** 列出最近的请求（面板用）。 */
export function listWakeRequests(db: DatabaseSync, limit = 20): readonly WakeRequestRow[] {
  return db.prepare('SELECT * FROM wake_requests ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as WakeRequestRow[]
}
