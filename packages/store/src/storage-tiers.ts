/**
 * 存储分层：根路径解析与沉降策略（PLAN 阶段 9 交付物 1 的基础）。
 *
 * ## 三层不是"三个盘"，而是**三种访问模式**
 *
 * | 层 | 放什么 | 典型介质 |
 * |---|---|---|
 * | `hot` | 最近在用（渲染区、当前会话、表情库）| SSD |
 * | `warm` | 偶尔用（近期的长期记忆、媒体）| SSD 或 HDD |
 * | `cold` | 归档（老条目、导出、备份）| HDD |
 *
 * 阶段 9 的验收明确写着「**冷层指向 HDD 与指向 SSD 两种配置下，功能完全一致**」——
 * 也就是说**分层是"路径不同"，不是"代码路径不同"**。
 * 所以这一层的全部职责就是：**把逻辑层名解析成实际路径，其余代码不该知道盘是什么**。
 *
 * ## 为什么"没配就退回上一层"而不是报错
 *
 * 只配了 hot 的用户（单盘部署）应该能正常跑 —— 把 warm/cold 都退回 hot。
 * 报错的话，最小可用部署就变成"必须先准备三个目录"，而那是没必要的门槛。
 * **但要在返回值里说清"退回了"**，否则用户会以为数据真的分了三层在放。
 *
 * ## 为什么沉降策略是**纯函数**
 *
 * "这条该不该沉到冷层"的判定会被定时任务、面板手动按钮、CLI 三处调用。
 * 写成带副作用的话，三处会各有一套阈值 —— 而**三套阈值不一致**
 * 会让同一条数据在面板上显示"该沉降"、实际却没沉。
 *
 * @module @forlife/store/storage-tiers
 */

/** 逻辑层名。 */
export type StorageTier = 'hot' | 'warm' | 'cold'

/** 全部层（顺序即"由热到冷"）。 */
export const STORAGE_TIERS: readonly StorageTier[] = ['hot', 'warm', 'cold']

/** 解析结果。 */
export interface TierRoots {
  /** 每层的实际路径。 */
  readonly roots: Readonly<Record<StorageTier, string>>
  /** 哪些层是**退回**来的（没配，用了上一层）。界面要显示它。 */
  readonly fellBack: readonly { readonly tier: StorageTier; readonly from: StorageTier }[]
}

/**
 * 从环境变量解析三层根路径。
 *
 * 环境变量：`FORLIFE_ROOT_HOT` / `FORLIFE_ROOT_WARM` / `FORLIFE_ROOT_COLD`。
 * **只配 hot 也能跑** —— warm/cold 依次退回上一层。
 */
export function resolveTierRoots(env: Record<string, string | undefined>): TierRoots {
  const read = (key: string): string | undefined => {
    const v = env[key]
    return v === undefined || v.trim() === '' ? undefined : v.trim()
  }

  const hot = read('FORLIFE_ROOT_HOT')
  if (hot === undefined) {
    // 连 hot 都没有 ⇒ **必须报错**：没有"默认路径"这种东西 ——
    // 猜一个（比如 cwd）会把数据写到用户没想到的地方，而那种错很难发现
    throw new Error('缺少 FORLIFE_ROOT_HOT：至少要配一个热层根路径（没有"默认路径"这种东西）')
  }

  const roots: Record<StorageTier, string> = { hot, warm: hot, cold: hot }
  const fellBack: { tier: StorageTier; from: StorageTier }[] = []

  const warm = read('FORLIFE_ROOT_WARM')
  if (warm !== undefined) roots.warm = warm
  else fellBack.push({ tier: 'warm', from: 'hot' })

  const cold = read('FORLIFE_ROOT_COLD')
  if (cold !== undefined) roots.cold = cold
  else {
    // cold 没配时退到 **warm**（而不是 hot）—— 如果用户配了 warm 却没配 cold，
    // 他的意图显然是"温的和冷的一起放那块盘上"
    roots.cold = roots.warm
    fellBack.push({ tier: 'cold', from: warm !== undefined ? 'warm' : 'hot' })
  }

  return { roots, fellBack }
}

/** 一条数据的沉降判定输入。 */
export interface SettleCandidate {
  /** 逻辑层名（当前在哪层）。 */
  readonly tier: StorageTier
  /** 上次访问时间（ISO）；从未访问过则为 undefined。 */
  readonly lastAccessedAt: string | undefined
  /** 创建时间（ISO）。 */
  readonly createdAt: string
  /** 大小（字节）。 */
  readonly bytes: number
}

/** 沉降策略。 */
export interface SettlePolicy {
  /** 多少天没访问就沉到 warm（0 = 不按时间沉）。 */
  readonly warmAfterDays: number
  /** 多少天没访问就沉到 cold。 */
  readonly coldAfterDays: number
  /** 小于这个大小的一律留 hot（小条目搬来搬去不划算）。 */
  readonly minBytesToSettle: number
}

/** 默认策略。 */
export const DEFAULT_SETTLE_POLICY: SettlePolicy = {
  // 7 天没用 → 温层；30 天没用 → 冷层。
  // 比这更激进的话，用户回头找上周的东西会频繁触发回读（体验差）；
  // 更保守的话 SSD 会被慢慢填满。
  warmAfterDays: 7,
  coldAfterDays: 30,
  // 4 KiB 以下不值得搬 —— 搬一次的元数据开销可能比数据本身还大
  minBytesToSettle: 4096,
}

/** 判定结果。 */
export interface SettleDecision {
  /** 该去哪层；`undefined` 表示不动。 */
  readonly target: StorageTier | undefined
  readonly reason: string
}

/**
 * 判一条数据该不该沉降、沉到哪层。
 *
 * **只能往更冷的层沉**，不能反向 —— 提升回热层是 `recover()` 的事，
 * 而且必须由"访问"触发（那才有依据）。让沉降任务顺手把东西提上来
 * 会让"为什么这条突然变热了"变成一个查不出来的问题。
 */
export function decideSettle(
  candidate: SettleCandidate,
  now: Date,
  policy: SettlePolicy = DEFAULT_SETTLE_POLICY,
): SettleDecision {
  // 已经在最冷层 ⇒ 不动
  if (candidate.tier === 'cold') return { target: undefined, reason: '已在冷层' }

  if (candidate.bytes < policy.minBytesToSettle) {
    return { target: undefined, reason: `太小（${String(candidate.bytes)} < ${String(policy.minBytesToSettle)} 字节），搬动不划算` }
  }

  // **没访问过用创建时间** —— 用 0 或"很久以前"会让新写入的大条目立刻被沉下去，
  // 而那正是用户马上要用的
  const reference = candidate.lastAccessedAt ?? candidate.createdAt
  const ageMs = now.getTime() - new Date(reference).getTime()
  if (Number.isNaN(ageMs)) return { target: undefined, reason: `时间解析不了：${reference}` }
  const ageDays = ageMs / 86_400_000

  if (policy.coldAfterDays > 0 && ageDays >= policy.coldAfterDays) {
    return { target: 'cold', reason: `${String(Math.floor(ageDays))} 天没动（≥ ${String(policy.coldAfterDays)} 天）` }
  }
  if (policy.warmAfterDays > 0 && ageDays >= policy.warmAfterDays) {
    // 已在 warm 且只够 warm 的条件 ⇒ 不动
    if (candidate.tier === 'warm') return { target: undefined, reason: '已在温层，且没到冷层条件' }
    return { target: 'warm', reason: `${String(Math.floor(ageDays))} 天没动（≥ ${String(policy.warmAfterDays)} 天）` }
  }
  return { target: undefined, reason: `还新（${String(Math.floor(ageDays))} 天）` }
}

/** 从环境变量读沉降策略（0 表示该档不启用）。 */
export function settlePolicyFromEnv(env: Record<string, string | undefined>): SettlePolicy {
  const num = (key: string, fallback: number): number => {
    const v = Number(env[key])
    return Number.isFinite(v) && v >= 0 ? v : fallback
  }
  return {
    warmAfterDays: num('FORLIFE_SETTLE_WARM_DAYS', DEFAULT_SETTLE_POLICY.warmAfterDays),
    coldAfterDays: num('FORLIFE_SETTLE_COLD_DAYS', DEFAULT_SETTLE_POLICY.coldAfterDays),
    minBytesToSettle: num('FORLIFE_SETTLE_MIN_BYTES', DEFAULT_SETTLE_POLICY.minBytesToSettle),
  }
}
