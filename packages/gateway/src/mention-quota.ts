/**
 * 主动 @全体 的**额度闸门**。
 *
 * ## 为什么必须有这道闸门，而且必须在调用侧
 *
 * `OneBotTransport.mentionAll()` 的注释写着「**额度由调用方保证**」——
 * 也就是说传输层**不会替你挡**。不在这边挡，就是"想发就发"，
 * 而 @全体 是**对全群所有人的打扰**，且额度用完后 QQ 侧会直接拒绝，
 * 表现为"偶尔不生效"，非常难查。
 *
 * ## 用户指出的坑：返回值与 group_id **不完全相关**
 *
 * NapCat 的 `get_group_at_all_remain` 返回的剩余次数，**不能只按群理解**：
 * 除了群维度还有**账号维度**（这个 QQ 号整体还剩多少次）。
 * 只看群维度会高估额度 —— 群维度显示还剩 5 次，但账号维度只剩 0 次，
 * 于是我们以为能发，实际发不出去。
 *
 * 所以：**同时看两个维度，保守取最小值**。
 *
 * ## 三个保守原则
 *
 * 1. `can_at_all === false` ⇒ **直接拒绝**（这是 QQ 侧的明确否决，不看数字）
 * 2. 两个维度都拿不到 ⇒ **拒绝**（fail-closed）。
 *    "查不到就当无限"会让闸门在最需要它的时候（接口异常/改名）失效。
 * 3. 只拿到一个维度 ⇒ 用那个，但**不假设另一个很大**。
 *
 * @module @forlife/gateway/mention-quota
 */

/** NapCat 返回的原始额度信息。 */
export interface MentionQuotaSnapshot {
  /** QQ 侧是否允许 @全体。`false` 是明确否决。 */
  readonly canAtAll?: boolean | undefined
  /** **群维度**剩余次数。 */
  readonly remainGroup?: number | undefined
  /** **账号维度**剩余次数（这个号整体还剩多少）。 */
  readonly remainAccount?: number | undefined
}

/** 判定结果。 */
export interface MentionDecision {
  readonly allowed: boolean
  /** 保守估计的剩余次数（拿不到就是 `undefined`）。 */
  readonly remaining?: number
  /** 给模型的说明（拒绝时要说清原因与下一步，不能只说"不行"）。 */
  readonly reason: string
  /** 这次判定依据了哪些维度（排障用：只看了一个维度时要能看出来）。 */
  readonly dimensions: readonly string[]
}

/**
 * 保守判定能不能 @全体。
 *
 * **取最小值**是这里的核心：两个维度只要有一个不够，就发不出去。
 * 取最大值或只看群维度都会高估。
 */
export function decideMentionAll(snapshot: MentionQuotaSnapshot): MentionDecision {
  // ① QQ 侧明确否决 ⇒ 直接拒（数字再好看也没用）
  if (snapshot.canAtAll === false) {
    return { allowed: false, reason: 'QQ 侧当前不允许 @全体（can_at_all=false）—— 可能是新群、被限制，或该号额度已耗尽', dimensions: ['can_at_all'] }
  }

  const dimensions: string[] = []
  const values: number[] = []
  if (typeof snapshot.remainGroup === 'number') {
    dimensions.push('group')
    values.push(snapshot.remainGroup)
  }
  if (typeof snapshot.remainAccount === 'number') {
    dimensions.push('account')
    values.push(snapshot.remainAccount)
  }

  // ② 一个维度都拿不到 ⇒ fail-closed。
  //    "查不到就当无限"会让闸门在接口异常/改名时静默失效 —— 那正是它最该起作用的时刻。
  if (values.length === 0) {
    return {
      allowed: false,
      reason: '查不到 @全体 额度（群维度与账号维度都没有返回）⇒ 保守拒绝。请检查 NapCat 版本是否仍提供 get_group_at_all_remain',
      dimensions,
    }
  }

  const remaining = Math.min(...values)
  const onlyOne = values.length === 1
  const note = onlyOne ? `（只拿到 ${dimensions[0] ?? '?'} 维度，另一个维度未返回，已按保守处理）` : ''

  if (remaining <= 0) {
    return {
      allowed: false,
      remaining,
      reason: `@全体 额度已用尽（保守取值 ${String(remaining)}）${note}。等额度恢复，或改用普通消息/群公告`,
      dimensions,
    }
  }

  return {
    allowed: true,
    remaining,
    reason: `可以 @全体（保守剩余 ${String(remaining)} 次${onlyOne ? '，仅单维度' : ''}）`,
    dimensions,
  }
}

/**
 * 成功发送后递减。
 *
 * 为什么要**本地记账**而不是每次都问 NapCat：
 *  - 接口有延迟，连续两次 @全体 之间可能读到同一个旧值；
 *  - 用户要求"成功发送后剩余额度递减且落审计"。
 *
 * 所以本地保留一份"本轮已用"，判定时取 **min(NapCat 值, 本地推断值)**，
 * 并在每次成功发送后递增。这样即使接口返回滞后，也不会连发超限。
 */
export interface MentionLedger {
  /** 本会话（进程）内已成功发出的 @全体 次数。 */
  sent: number
}

/** 新建账本。 */
export function newMentionLedger(): MentionLedger {
  return { sent: 0 }
}

/**
 * 结合本地账本再判一次。
 *
 * 注意：本地账本**只做减法**，不提供额度。它拿不到"总共有多少"，
 * 只能回答"自从启动以来已经发了几次"，所以它的作用是
 * **防止在 NapCat 返回值滞后时连发超限**。
 */
export function decideWithLedger(snapshot: MentionQuotaSnapshot, ledger: MentionLedger): MentionDecision {
  const base = decideMentionAll(snapshot)
  if (!base.allowed || base.remaining === undefined) return base

  // 账本里已发的次数要从剩余里扣掉（保守：宁可少发一次，不要超发）
  const adjusted = base.remaining - ledger.sent
  if (adjusted <= 0) {
    return {
      ...base,
      allowed: false,
      remaining: 0,
      reason: `${base.reason}；但本进程内已成功发送 ${String(ledger.sent)} 次，按保守口径已无可用额度`,
    }
  }
  return { ...base, remaining: adjusted }
}
