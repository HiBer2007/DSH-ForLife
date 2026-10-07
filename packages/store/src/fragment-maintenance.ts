/**
 * 碎片索引的合并与淘汰（PLAN 阶段 9 交付物 4）。
 *
 * ## "碎片"是什么
 *
 * 压缩把一批 `mid_memory_entries` 沉淀成一条长期记忆，并把它们标成
 * `status='fragmented'` + `fragmented_into=<长期记忆 id>`。
 * 那些行**已经被更抽象的长期记忆代表了**，但还占着索引与正文。
 *
 * ## 两条**绝不能越过**的红线
 *
 * 1. **只淘汰 `status='fragmented'`** —— `active` 的是还没被代表的原始记忆，
 *    删了就是**真的丢了**。这不是"保守"，是"删错就没救"。
 * 2. **必须 `fragmented_into` 非空、且那条长期记忆还在** ——
 *    否则"碎片"没有归宿，删掉之后**那件事在任何地方都查不到了**。
 *    `fragmented_into` 指向一个已被删除的长期记忆时（压缩回滚过、或有人手动删过），
 *    那些碎片**必须留着** —— 它们是唯一副本。
 *
 * ## 为什么"合并"和"淘汰"是两件事
 *
 * - **合并**：把 FTS 索引里同一批碎片的倒排表整理掉（`optimize`），
 *   让查询更快、索引更小 —— **不动数据**。
 * - **淘汰**：真的删行 —— **动数据**，所以要过红线。
 *
 * 混在一起的话，"整理索引"这个安全操作会带上删除的风险。
 *
 * @module @forlife/store/fragment-maintenance
 */
import type { DatabaseSync } from 'node:sqlite'

/** 淘汰策略。 */
export interface FragmentPolicy {
  /**
   * 沉淀之后保留多少天才淘汰（0 = 不按时间淘汰）。
   *
   * **为什么要有保留期**：刚沉淀完就删的话，
   * "长期记忆写得对不对"还没人验证过 —— 而那时碎片是**唯一的对照物**。
   */
  readonly keepDays: number
  /** 一次最多淘汰几条（防一次删太多把 WAL 撑爆）。 */
  readonly limit: number
}

/** 默认策略：留 30 天，一次最多 200 条。 */
export const DEFAULT_FRAGMENT_POLICY: FragmentPolicy = { keepDays: 30, limit: 200 }

/** 一条可淘汰的碎片（带上它的归宿，便于日志与界面显示）。 */
export interface EvictableFragment {
  readonly id: string
  readonly summary: string
  readonly fragmentedInto: string
  readonly createdAt: string
  readonly tokenCount: number
}

/** 维护计划（**先算后做** —— 让人能在删之前看到要删什么）。 */
export interface FragmentPlan {
  /** 可以淘汰的（已过保留期且归宿还在）。 */
  readonly evictable: readonly EvictableFragment[]
  /** 归宿没了的碎片 —— **必须留着**，但要让界面能看见（它们占着地方又不会被清理）。 */
  readonly orphaned: readonly EvictableFragment[]
  /** 还没到保留期的条数。 */
  readonly tooYoung: number
  /** 合计可回收的 token（面板显示"能省多少"）。 */
  readonly reclaimableTokens: number
  readonly reason: string
}

/**
 * 算一份维护计划（**纯读**，不删任何东西）。
 *
 * 分成"计划"与"执行"两步是**故意的**：删除是不可逆的，
 * 而"先看看要删什么"是唯一能在动手前发现"算法写错了"的机会。
 */
export function planFragmentMaintenance(
  db: DatabaseSync,
  policy: FragmentPolicy = DEFAULT_FRAGMENT_POLICY,
  now: Date = new Date(),
): FragmentPlan {
  const cutoff =
    policy.keepDays > 0 ? new Date(now.getTime() - policy.keepDays * 86_400_000).toISOString() : null

  // **红线 1**：只看 `status='fragmented'`
  // **红线 2**：`fragmented_into` 必须非空，且那条长期记忆还在
  const rows = db
    .prepare(
      `SELECT m.id, m.summary, m.fragmented_into, m.created_at, m.token_count,
              (SELECT COUNT(*) FROM long_memory_entries l WHERE l.id = m.fragmented_into) AS home_alive
       FROM mid_memory_entries m
       WHERE m.status = 'fragmented' AND m.fragmented_into IS NOT NULL
       ORDER BY m.created_at`,
    )
    .all() as unknown as readonly {
    id: string
    summary: string
    fragmented_into: string
    created_at: string
    token_count: number
    home_alive: number
  }[]

  const evictable: EvictableFragment[] = []
  const orphaned: EvictableFragment[] = []
  let tooYoung = 0

  for (const r of rows) {
    const item: EvictableFragment = {
      id: r.id,
      summary: r.summary,
      fragmentedInto: r.fragmented_into,
      createdAt: r.created_at,
      tokenCount: r.token_count,
    }
    if (r.home_alive === 0) {
      // **归宿没了 ⇒ 必须留着** —— 它们是那件事的唯一副本
      orphaned.push(item)
      continue
    }
    if (cutoff !== null && r.created_at > cutoff) {
      tooYoung += 1
      continue
    }
    evictable.push(item)
  }

  // 还有一类"太年轻"：`fragmented_into` 为空的行 —— 它们**不算碎片**（没归宿），
  // 所以既不淘汰也不计入。但要让人知道有多少条处于这种状态。
  const noHome = db
    .prepare("SELECT COUNT(*) AS n FROM mid_memory_entries WHERE status = 'fragmented' AND fragmented_into IS NULL")
    .get() as { n?: number } | undefined

  const limited = evictable.slice(0, policy.limit)
  const reclaimableTokens = limited.reduce((sum, f) => sum + f.tokenCount, 0)
  const parts = [
    `可淘汰 ${String(limited.length)} 条`,
    orphaned.length > 0 ? `**归宿已丢 ${String(orphaned.length)} 条（留着，它们是唯一副本）**` : '',
    tooYoung > 0 ? `未到保留期 ${String(tooYoung)} 条` : '',
    Number(noHome?.n ?? 0) > 0 ? `无归宿标记 ${String(noHome?.n ?? 0)} 条（不算碎片，不动）` : '',
  ].filter((p) => p !== '')

  return {
    evictable: limited,
    orphaned,
    tooYoung,
    reclaimableTokens,
    reason: parts.join('；'),
  }
}

/**
 * 合并索引：对 FTS 表跑 `optimize`（**不动数据**）。
 *
 * `optimize` 把倒排表里同一批碎片的散块合并起来 ——
 * 它只影响**查询性能与索引体积**，不删任何一行记忆。
 * 所以它可以随便跑，不需要过红线。
 */
export function mergeFragmentIndex(db: DatabaseSync): { ok: boolean; reason: string } {
  try {
    // FTS5 的 optimize：把多个 b-tree 段合并成一个
    db.exec("INSERT INTO mid_memory_fts (mid_memory_fts) VALUES ('optimize')")
    return { ok: true, reason: '已合并 mid_memory_fts 索引（不动数据）' }
  } catch (error) {
    return { ok: false, reason: `合并索引失败：${String(error).slice(0, 140)}` }
  }
}

/**
 * 执行淘汰（**删行**）。
 *
 * **每条都要再过一遍红线**（不信任计划里的内容）——
 * 计划算出来到执行之间，那条长期记忆可能刚被删掉。
 * 只信"计划"的话，这段时间差里就会删掉唯一副本。
 */
export function evictFragments(
  db: DatabaseSync,
  ids: readonly string[],
): { evicted: number; refused: readonly { id: string; reason: string }[] } {
  const refused: { id: string; reason: string }[] = []
  let evicted = 0

  for (const id of ids) {
    const row = db
      .prepare(
        `SELECT m.status, m.fragmented_into,
                (SELECT COUNT(*) FROM long_memory_entries l WHERE l.id = m.fragmented_into) AS home_alive
         FROM mid_memory_entries m WHERE m.id = ?`,
      )
      .get(id) as { status: string; fragmented_into: string | null; home_alive: number } | undefined

    if (row === undefined) {
      refused.push({ id, reason: '行已不存在' })
      continue
    }
    if (row.status !== 'fragmented') {
      refused.push({ id, reason: `状态是 ${row.status}，**只有 fragmented 才能淘汰**` })
      continue
    }
    if (row.fragmented_into === null) {
      refused.push({ id, reason: '没有归宿（fragmented_into 为空）—— 它是唯一副本' })
      continue
    }
    if (row.home_alive === 0) {
      refused.push({ id, reason: `归宿 ${row.fragmented_into} 已不存在 —— 它是唯一副本` })
      continue
    }

    db.prepare('DELETE FROM mid_memory_entries WHERE id = ?').run(id)
    evicted += 1
  }

  return { evicted, refused }
}
