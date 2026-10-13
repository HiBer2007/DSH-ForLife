/**
 * **碎片语义合并**（`PLAN.MD` §5.3-3 的「合并规则」）—— D8。
 *
 * ## 规格原文（只有一句）
 *
 * > `entities` 重叠的碎片合并为更粗粒度 hint，`long_memory_ids` 变数组。
 *
 * ★ "重叠多少算重叠""粗到什么程度"规格**都没写** ⇒ 由用户 2026-10-13 裁定：
 *
 * | 问题 | 裁定 |
 * | :--- | :--- |
 * | 重叠判据 | ★ **B（交集 ≥ N）与 C（Jaccard ≥ X）都实现**，**配置时选**；★ C 的 X 由测试标定出默认值 |
 * | 粗 hint 生成 | ★ **A（机械拼接）与 B（模型生成）都实现**，**配置时选** |
 * | 落库形态 | ★ **新表 `fragment_merges`**（多对一、可回溯）—— 见 `store` 侧 |
 *
 * ## 本模块只管"算"（纯函数，可单测）
 *
 * - 判据：{@link sharesAtLeast}（B）· {@link jaccard}（C）；
 * - 分组：{@link groupFragments} —— ★ **并查集**（传递闭包：A~B、B~C ⇒ A/B/C 同组），
 *   且**结果稳定**（按输入顺序输出，便于测试与复现）；
 * - 粗 hint：{@link mechanicalHint}（A）· 模型生成（B）走**注入的回调**（本模块不碰网络）；
 * - 计划：{@link planFragmentMerges} ⇒ 每组给出 `sourceIds` / 粗 `hint` / `entities` / `rule`。
 *
 * ★ 为什么"算"与"落库/渲染"分开：合并**改变模型看到的文本**（hint 是碎片唯一进上下文的东西），
 *   所以先把"算得对不对"钉死在单测里，再去接落库与渲染。
 *
 * @module @forlife/memory-core/fragment-merge
 */

/** 重叠判据。 */
export type MergeCriterion = 'intersection' | 'jaccard'

/** 粗 hint 的生成方式。 */
export type MergeHintMode = 'mechanical' | 'model'

/** 合并策略（★ 生产从契约键来，不在代码里写死）。 */
export interface MergePolicy {
  readonly criterion: MergeCriterion
  /** B：至少共享几个 entity 才算重叠。 */
  readonly minShared: number
  /** C：Jaccard 相似度阈值（0–1）。 */
  readonly jaccard: number
  readonly hintMode: MergeHintMode
  /** 粗 hint 的 token 上限（★ 与 `fragment.maxHintTokens` 同源，由调用方传）。 */
  readonly maxHintTokens?: number
}

/** 一条待合并的碎片（只取合并需要的字段）。 */
export interface MergeCandidate {
  readonly id: string
  readonly entities: readonly string[]
  /** 这条碎片的 hint（机械拼接的原料）。 */
  readonly hint: string
}

/** 一组合并结果。 */
export interface MergeGroup {
  /** 组内成员（≥2 条）。 */
  readonly sourceIds: readonly string[]
  /** 粗 hint（模型只看到这个）。 */
  readonly hint: string
  /** 并集后的 entities（★ 上限 5，超出截断 —— 与单条限制同一口径）。 */
  readonly entities: readonly string[]
  /** ★ 用了哪套判据与参数（写进 `fragment_merges.rule`，事后能回答"这条是怎么合的"）。 */
  readonly rule: string
}

/** 合并计划。 */
export interface MergePlan {
  readonly groups: readonly MergeGroup[]
  /** 没进任何组、或组里只有自己 ⇒ 不动。 */
  readonly untouched: readonly string[]
}

/** entities 的并集上限（与 §5.3-1 的"单条 entities ≤ 5"同口径）。 */
export const MAX_MERGED_ENTITIES = 5

/**
 * B：两个 entity 集合**至少共享 `minShared` 个**。
 *
 * @param a - 一侧。
 * @param b - 另一侧。
 * @param minShared - 至少共享几个。
 * @returns 是否算重叠。
 */
export function sharesAtLeast(a: readonly string[], b: readonly string[], minShared: number): boolean {
  if (minShared <= 0) return false
  const setB = new Set(b)
  let shared = 0
  for (const e of new Set(a)) {
    if (setB.has(e)) {
      shared += 1
      if (shared >= minShared) return true
    }
  }
  return false
}

/**
 * C：Jaccard 相似度（交集 ÷ 并集）。
 *
 * ★ 空集约定：两侧都空 ⇒ `0`（★ 不定义成 1 —— 那会让"两条都没有 entities 的碎片"永远合并）。
 *
 * @param a - 一侧。
 * @param b - 另一侧。
 * @returns 0–1。
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const e of setA) if (setB.has(e)) inter += 1
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 按策略判"这两条要不要合"。
 *
 * @param a - 一侧。
 * @param b - 另一侧。
 * @param policy - 策略。
 * @returns 是否合并。
 */
export function shouldMerge(a: MergeCandidate, b: MergeCandidate, policy: MergePolicy): boolean {
  if (policy.criterion === 'intersection') return sharesAtLeast(a.entities, b.entities, policy.minShared)
  return jaccard(a.entities, b.entities) >= policy.jaccard
}

/** 并查集（★ 传递闭包：A~B、B~C ⇒ 三条同组）。 */
function makeUnionFind(ids: readonly string[]): {
  readonly find: (id: string) => string
  readonly union: (a: string, b: string) => void
} {
  const parent = new Map<string, string>()
  for (const id of ids) parent.set(id, id)
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    // 路径压缩
    let cursor = id
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) ?? root
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  return {
    find,
    union: (a: string, b: string): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(rb, ra)
    },
  }
}

/**
 * 按策略分组（★ 并查集 + 稳定输出）。
 *
 * @param items - 待分组碎片。
 * @param policy - 策略。
 * @returns 组（每组 ≥2 条；按**输入顺序**输出，成员也按输入顺序）。
 */
export function groupFragments(items: readonly MergeCandidate[], policy: MergePolicy): readonly (readonly string[])[] {
  const uf = makeUnionFind(items.map((item) => item.id))
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]
      const b = items[j]
      if (a === undefined || b === undefined) continue
      if (shouldMerge(a, b, policy)) uf.union(a.id, b.id)
    }
  }
  const buckets = new Map<string, string[]>()
  for (const item of items) {
    const root = uf.find(item.id)
    const bucket = buckets.get(root) ?? []
    bucket.push(item.id)
    buckets.set(root, bucket)
  }
  // ★ 稳定：按"该组第一条在输入里的位置"排序（不用 Map 的插入顺序去赌）
  const order = new Map(items.map((item, index) => [item.id, index]))
  return [...buckets.values()]
    .filter((group) => group.length > 1)
    .sort((x, y) => (order.get(x[0] ?? '') ?? 0) - (order.get(y[0] ?? '') ?? 0))
}

/**
 * A：**机械拼接**粗 hint（不花钱、可预测、可回滚）。
 *
 * 规则：把各条 hint 去掉首尾空白后按 `；` 连起来；★ 超过 `maxHintTokens` 就按**条边界**截断
 * （★ 不做字符级切断 —— 半句话的 hint 比短一点的 hint 更糟），并标出"还有 N 条"。
 *
 * @param items - 组内碎片（按输入顺序）。
 * @param maxHintTokens - token 上限（不传则不截断）。
 * @param countTokens - token 估算（默认 1 字 ≈ 1 token 的保守估计）。
 * @returns 粗 hint。
 */
export function mechanicalHint(
  items: readonly MergeCandidate[],
  maxHintTokens?: number,
  countTokens: (text: string) => number = (text) => text.length,
): string {
  const parts: string[] = []
  for (const item of items) {
    const text = item.hint.trim()
    if (text === '') continue
    const next = [...parts, text].join('；')
    if (maxHintTokens !== undefined && maxHintTokens > 0 && countTokens(next) > maxHintTokens) {
      // ★ 连第一条都放不下 ⇒ 仍然给第一条（否则 hint 会是空的，比超一点更糟）
      if (parts.length === 0) return text
      const rest = items.length - parts.length
      return rest > 0 ? `${parts.join('；')}；另有 ${String(rest)} 条同类碎片` : parts.join('；')
    }
    parts.push(text)
  }
  return parts.join('；')
}

/** 并集 entities（★ 上限 {@link MAX_MERGED_ENTITIES}，按首次出现顺序）。 */
export function unionEntities(items: readonly MergeCandidate[]): readonly string[] {
  const out: string[] = []
  for (const item of items) {
    for (const e of item.entities) {
      if (!out.includes(e)) out.push(e)
      if (out.length >= MAX_MERGED_ENTITIES) return out
    }
  }
  return out
}

/** 生成粗 hint 的注入点（模型生成走它 —— ★ 本模块不碰网络，便于单测）。 */
export type HintGenerator = (items: readonly MergeCandidate[]) => Promise<string>

/**
 * 算出合并计划（★ 纯计算；模型生成模式下需要 `generate`）。
 *
 * @param items - 待合并碎片。
 * @param policy - 策略。
 * @param options - `generate`（`hintMode: 'model'` 时必需）· `countTokens`。
 * @returns 计划。
 */
export async function planFragmentMerges(
  items: readonly MergeCandidate[],
  policy: MergePolicy,
  options: { readonly generate?: HintGenerator; readonly countTokens?: (text: string) => number } = {},
): Promise<MergePlan> {
  const groups = groupFragments(items, policy)
  const byId = new Map(items.map((item) => [item.id, item]))
  const rule =
    policy.criterion === 'intersection'
      ? `intersection(minShared=${String(policy.minShared)})`
      : `jaccard(>=${String(policy.jaccard)})`
  const out: MergeGroup[] = []
  for (const ids of groups) {
    const members = ids.map((id) => byId.get(id)).filter((item): item is MergeCandidate => item !== undefined)
    if (members.length < 2) continue
    let hint: string
    if (policy.hintMode === 'model' && options.generate !== undefined) {
      hint = (await options.generate(members)).trim()
      // ★ 模型给了空串 ⇒ 退回机械拼接（★ 绝不留空 hint：那是碎片唯一进上下文的东西）
      if (hint === '') hint = mechanicalHint(members, policy.maxHintTokens, options.countTokens)
    } else {
      hint = mechanicalHint(members, policy.maxHintTokens, options.countTokens)
    }
    out.push({ sourceIds: ids, hint, entities: unionEntities(members), rule })
  }
  const merged = new Set(out.flatMap((group) => group.sourceIds))
  return { groups: out, untouched: items.map((item) => item.id).filter((id) => !merged.has(id)) }
}
