/**
 * ★ 「对方正在输入」的**临时状态**（P1-4 事件的下游，兑现 `read_pending` 的 `typing`）。
 *
 * ## 为什么用 `forlife_state` 而不是给 `pending_messages` 加一列
 *
 * 这个信息与"积压"是**两种东西**：
 *  - `pending_messages` 是**待办队列**（有界、要标记已读、要能被筛选）；
 *  - "正在输入"是**几秒钟就过期的瞬时信号**（NapCat 上报 `notify/input_status`）。
 *
 * 把它塞进队列表有两个后果：① 每个会话一行、要加列要迁移（本轮多人在共享迁移文件）；
 * ② 一条瞬时信号混进"未读条数"的统计口径里 —— 那会让"还剩 N 条"变得没有意义。
 *
 * ⇒ 用 `forlife_state`（本来就有的键值表）+ **自带过期时刻**：
 * 模型问的时候只有"新鲜到还在 TTL 内"才算 `true`，过了就**自动不算**，
 * 于是它天然不会变成"僵尸正在输入"。**停止输入**（`event_type === 2`）或超时都会清键。
 *
 * ## ⚠️ 一处如实说明
 *
 * `event_type` 的取值含义（1 = 正在输入 / 2 = 停止）**没有跑真机验证过**
 * （本轮的 QQ 账号处于登出状态，收不到任何真实事件）。所以：
 *  - 除了 `2` 之外的值都按"正在输入"处理（宁多提示一秒，不假装没有）；
 *  - 识别错也不会造成持久错误 —— TTL 一到就自己过期。
 *
 * @module @forlife/gateway/typing-state
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { deleteState, getState, setState } from '@forlife/store'

/** 状态键前缀。 */
export const TYPING_STATE_PREFIX = 'qq_typing:'

/** 一个会话的输入状态值（存 JSON：`until` 是**过期时刻**，让读取方自己判新鲜度）。 */
interface TypingValue {
  readonly at: string
  readonly until: string
  readonly statusText: string
}

/** 键。 */
export function typingStateKey(conversationKey: string): string {
  return `${TYPING_STATE_PREFIX}${conversationKey}`
}

/**
 * 记一次输入状态事件。
 *
 * @param db - 数据库。
 * @param input - 会话键、事件类型、协议端给的状态文案。
 */
export function recordTyping(
  db: DatabaseSync,
  input: {
    readonly conversationKey: string
    readonly eventType: number
    readonly statusText: string
    readonly now?: Date
    readonly ttlMs?: number
  },
): void {
  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? defaultFor<number>('qq.typing.ttlMs')
  const key = typingStateKey(input.conversationKey)
  // `event_type === 2` = 明确"停止输入" ⇒ **直接删键**（而不是写一个 until=now 的假值）：
  // 删掉之后"表里有多少键"就准确等于"现在有几个人在打字"。
  if (input.eventType === 2) {
    deleteState(db, key)
    return
  }
  const value: TypingValue = {
    at: now.toISOString(),
    until: new Date(now.getTime() + ttlMs).toISOString(),
    statusText: input.statusText,
  }
  setState(db, key, JSON.stringify(value))
}

/**
 * 现在这个人还在打字吗（**按 TTL 判新鲜度**）。
 *
 * @param db - 数据库。
 * @param conversationKey - 会话键。
 * @param now - 注入时钟（测试用）。
 * @returns 是否还在 TTL 内。
 */
export function isPeerTyping(db: DatabaseSync, conversationKey: string, now: Date = new Date()): boolean {
  const raw = getState(db, typingStateKey(conversationKey))
  if (raw === undefined || raw === '') return false
  try {
    const parsed = JSON.parse(raw) as { until?: unknown }
    if (typeof parsed.until !== 'string') return false
    return Date.parse(parsed.until) > now.getTime()
  } catch {
    // 脏值当"没有"处理（读个提示不该让取消息失败）
    return false
  }
}

/**
 * 一次问一批会话（工具层渲染要按条给 `typing`，一条一次查询也能用，
 * 但同一批里往往有十几条，逐条查会变成 N 次 IO）。
 *
 * @param db - 数据库。
 * @param conversationKeys - 会话键。
 * @param now - 注入时钟。
 * @returns 正在打字的那个子集。
 */
export function typingConversations(
  db: DatabaseSync,
  conversationKeys: readonly string[],
  now: Date = new Date(),
): ReadonlySet<string> {
  const typing = new Set<string>()
  for (const key of new Set(conversationKeys)) {
    if (isPeerTyping(db, key, now)) typing.add(key)
  }
  return typing
}
