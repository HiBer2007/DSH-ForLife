/**
 * **结构性缺口检测**（`FIX_PLAN.md` §78.41 的教训）。
 *
 * ## 为什么需要它（这次的活证据）
 *
 * 2026-10-13 查库才发现：中期记忆区 **10,914 条**（active 9,714 + 碎片 1,200）的
 * `entities` **全是 `[]`** —— 而 `PLAN.MD` §5.3 有三条规则（单条 entities ≤ 5 · 按 entities 重叠合并）
 * **全部依赖这个字段**。★ 结果是：**规则是死的，而没有任何告警**。
 *
 * 更细的因果链（已查清）：中期条目**全部来自投喂**（`feed.ts` 那条路不产生 entities），
 * 而 entities 的唯一来源（压缩的 `push_to_mid`）**在这个部署里一次都没跑过**
 * （`compaction_log` / `compaction_runs` 各 0 行）。
 *
 * ⇒ ★★ 教训不是"修那个字段"，而是：**"一个结构性字段长期 100% 为空"这件事本身必须有人喊**。
 *   否则每一次都是**靠人肉查库**才发现，而发现时已经过了很久（这里是一万多条）。
 *
 * ## 三条纪律
 *
 * 1. ★ **只读**：只 `SELECT COUNT`，不改任何数据；
 * 2. ★ **样本量门槛**：行数太少（默认 < 100）不报 —— 刚部署的空库不该刷告警；
 * 3. ★ **"100% 为空"才报**：一个字段偶尔为空是正常的（有些条目就是没有关键词）；
 *    而**一条都没有**才说明"上游根本没喂过它" —— 那才是结构性问题。
 *
 * @module @forlife/gateway/admin/structural-gaps
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一条检测：某个表的某个"本该有值"的列。 */
export interface StructuralCheck {
  /** 表名（★ 写死常量，不接受外部输入 —— 表名拼 SQL 是注入面）。 */
  readonly table: string
  /** 列名（同上）。 */
  readonly column: string
  /** 这个字段本该装什么（写给看日志的人）。 */
  readonly what: string
  /** 依赖它的规格在哪（★ 让告警能直接指回条款）。 */
  readonly spec: string
  /** 行数少于它就不检查（默认 100）。 */
  readonly minRows?: number
  /**
   * ★★ 这一列空了会有什么后果（2026-10-13 加）。
   *
   * 为什么必须有它：last_accessed_at 全空不会报错 —— 代码里有 ?? created_at 兜底，
   * 于是「淘汰最久未访问的碎片」悄悄变成了「淘汰最久创建的」。
   * ★ 这种「规格说 A、代码在做 B、而没人知道」比「规则完全没实现」更隐蔽。
   */
  readonly consequence?: string
}

/** 一条缺口。 */
export interface StructuralGap {
  readonly table: string
  readonly column: string
  readonly what: string
  readonly spec: string
  /** ★ 空了会怎样（见 StructuralCheck.consequence）。 */
  readonly consequence?: string
  /** 该表行数。 */
  readonly rows: number
  /** 其中该列为"空"的行数（★ 与 rows 相等才是缺口）。 */
  readonly empty: number
}

/**
 * 要盯的字段（★ **加新项要同时写清"本该装什么 + 哪条规格依赖它"**，
 * 否则这个表会变成"一堆没人看得懂的告警"）。
 */
export const STRUCTURAL_CHECKS: readonly StructuralCheck[] = [
  {
    table: 'mid_memory_entries',
    column: 'entities',
    what: '中期条目的关键词（模型压缩时给出，供"按实体检索"与"按重叠合并"用）',
    spec: 'PLAN.MD §5.3-1（entities ≤ 5）与 §5.3-3（entities 重叠的碎片合并）',
    consequence: '按实体检索、按重叠合并这两条规则目前不生效（合并规则在真数据上永远不会触发）。',
  },
  {
    table: 'mid_memory_entries',
    column: 'last_accessed_at',
    what: '这条中期记忆最后一次被取回的时间',
    spec: 'PLAN.MD §5.3-4（淘汰：最久未访问且 hint 已泛化的碎片）',
    consequence:
      '淘汰规则实际按 created_at 排序（代码里是 last_accessed_at ?? created_at），即「最久创建」而不是「最久未访问」——规则已经变形，且不会报错。',
  },
  {
    table: 'long_memory_entries',
    column: 'last_accessed_at',
    what: '这条长期记忆最后一次被取回的时间',
    spec: 'PLAN.MD §5.3-4（访问时间依据）',
    consequence: '长期侧的热度与新鲜度判断拿不到访问时间，只能退回创建时间。',
  },
  {
    table: 'long_memory_entries',
    column: 'embedding_id',
    what: '长期记忆的向量 id（语义召回用）',
    spec: 'PLAN.MD §5.4（长期记忆的语义检索）',
    consequence: '这一列只写不读且永远为空 ⇒ 语义召回没有落地。',
  },
  {
    table: 'mid_memory_entries',
    column: 'source_short_ids',
    what: '这条中期记忆来自哪几轮短时对话（溯源）',
    spec: 'PLAN.MD §5.2（中期条目保留来源）',
    consequence: '面板上「这条记忆从哪来」答不出来，溯源链是断的。',
  },  {
    table: 'long_memory_entries',
    column: 'entities',
    what: '长期条目的关键词',
    spec: 'PLAN.MD §5.3（长期侧的实体索引）',
  },
]

/** 判定"空"的 SQL 片段（NULL / 空串 / 空 JSON 数组都算空）。 */
function emptyExpression(column: string): string {
  return `(${column} IS NULL OR TRIM(${column}) = '' OR TRIM(${column}) = '[]')`
}

/**
 * 扫一遍，找出"整列 100% 为空"的结构性缺口。
 *
 * @param db - 已打开的库。
 * @param checks - 要检查的项（默认 {@link STRUCTURAL_CHECKS}）。
 * @returns 缺口清单（**没有缺口就是空数组**）。
 */
export function findStructuralGaps(db: DatabaseSync, checks: readonly StructuralCheck[] = STRUCTURAL_CHECKS): readonly StructuralGap[] {
  const gaps: StructuralGap[] = []
  for (const check of checks) {
    const minRows = check.minRows ?? 100
    let rows = 0
    let empty = 0
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS rows, SUM(CASE WHEN ${emptyExpression(check.column)} THEN 1 ELSE 0 END) AS empty FROM ${check.table}`)
        .get() as { rows?: number | null; empty?: number | null } | undefined
      rows = Number(row?.rows ?? 0)
      empty = Number(row?.empty ?? 0)
    } catch {
      // ★ 表/列不存在（老库、测试替身）⇒ 跳过这一项，**不报错**（这不是"缺口"）
      continue
    }
    if (rows < minRows) continue
    if (empty === rows) {
      gaps.push({
        table: check.table,
        column: check.column,
        what: check.what,
        spec: check.spec,
        ...(check.consequence === undefined ? {} : { consequence: check.consequence }),
        rows,
        empty,
      })
    }
  }
  return gaps
}

/**
 * 把缺口拼成**一条一条**的纯文本（★ 面板/日志不渲染 Markdown ⇒ 不用星号、不用反引号）。
 *
 * @param gaps - {@link findStructuralGaps} 的结果。
 * @returns 文本；没有缺口返回 `undefined`。
 */
export function describeStructuralGaps(gaps: readonly StructuralGap[]): string | undefined {
  if (gaps.length === 0) return undefined
  const lines = gaps.map(
    (gap) =>
      `${gap.table}.${gap.column}：${String(gap.rows)} 行全部为空。` +
      `本该装：${gap.what}。依赖它的规格：${gap.spec}。` +
      `⇒ 上游很可能从未写入过这个字段，那些依赖它的规则目前是死条文。` +
      (gap.consequence === undefined ? '' : ` 后果：${gap.consequence}`),
  )
  return `⚠ 结构性缺口（某个字段整列为空，依赖它的规则不会生效）：\n${lines.join('\n')}`
}

/** 一条"本该有活动却一行都没有"的检测。 */
export interface SilentCheck {
  /** 留痕表（★ 常量，不接受外部输入）。 */
  readonly table: string
  /** 它的"上游"表：上游有量、留痕却没有 ⇒ 说明这条链路没跑过。 */
  readonly peerTable: string
  /** 上游行数达到它才检查（默认 1000）。 */
  readonly minPeerRows?: number
  /** 这条留痕本该记录什么。 */
  readonly what: string
  /** 依赖这条链路的规格在哪。 */
  readonly spec: string
}

/** 一条"沉默的链路"。 */
export interface SilentPipeline {
  readonly table: string
  readonly peerTable: string
  readonly peerRows: number
  readonly what: string
  readonly spec: string
}

/**
 * 要盯的"沉默链路"。
 *
 * ★★ 这一条是 2026-10-13 真踩出来的：`compaction_log` 与 `compaction_runs` **各 0 行**，
 *   而中期记忆区已经有 **10,914 条** —— 说明**压缩一次都没跑过**。
 *   后果是 `entities` 全空（压缩的 `push_to_mid` 是它唯一来源）⇒ §5.3-3 的合并规则是死条文。
 *   ★ 而这一切**没有任何告警**：上游表"有量"、留痕表"没量"，这个组合本身就是最强的信号。
 */
export const SILENT_CHECKS: readonly SilentCheck[] = [
  {
    table: 'compaction_log',
    peerTable: 'mid_memory_entries',
    minPeerRows: 1000,
    what: '压缩运行留痕（每次压缩一条）',
    spec: 'PLAN.MD §5.3-3（按 entities 重叠合并）—— entities 的唯一来源就是压缩',
  },
]

/**
 * 找出"上游有量、留痕为空"的沉默链路。
 *
 * @param db - 已打开的库。
 * @param checks - 要检查的项（默认 {@link SILENT_CHECKS}）。
 * @returns 沉默链路清单（没有就是空数组）。
 */
export function findSilentPipelines(db: DatabaseSync, checks: readonly SilentCheck[] = SILENT_CHECKS): readonly SilentPipeline[] {
  const out: SilentPipeline[] = []
  for (const check of checks) {
    const minPeerRows = check.minPeerRows ?? 1000
    let own = 0
    let peer = 0
    try {
      own = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${check.table}`).get() as { n?: number } | undefined)?.n ?? 0)
      peer = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${check.peerTable}`).get() as { n?: number } | undefined)?.n ?? 0)
    } catch {
      continue // 表不存在 ⇒ 不是"沉默"，跳过
    }
    if (own === 0 && peer >= minPeerRows) {
      out.push({ table: check.table, peerTable: check.peerTable, peerRows: peer, what: check.what, spec: check.spec })
    }
  }
  return out
}

/**
 * 把沉默链路拼成纯文本（★ 面板/日志不渲染 Markdown）。
 *
 * @param pipelines - {@link findSilentPipelines} 的结果。
 * @returns 文本；没有就 `undefined`。
 */
export function describeSilentPipelines(pipelines: readonly SilentPipeline[]): string | undefined {
  if (pipelines.length === 0) return undefined
  const lines = pipelines.map(
    (p) =>
      `${p.table} 一行都没有，而 ${p.peerTable} 已有 ${String(p.peerRows)} 行。` +
      `本该记录：${p.what}。依赖这条链路的规格：${p.spec}。` +
      `⇒ 这条链路很可能从未运行过，依赖它的规则目前不生效。`,
  )
  return `⚠ 沉默的链路（上游有数据、留痕为空）：\n${lines.join('\n')}`
}