/**
 * 多会话调度（EXECUTION_PLAN §2.17.1，用户明确要求）。
 *
 * ## 要解决的问题
 *
 * 一个模型窗口同时服务多个会话。最坏情况是**一个话痨群刷 50 条**：
 * 如果按到达顺序处理，其它会话会被饿死 —— 私聊里有人等着，而模型在群里陪聊。
 * 验收标准写得很具体：「一个话痨群刷 50 条时，其它会话仍在 SLO 内被响应」。
 *
 * ## 三个机制
 *
 * 1. **优先级**：明确信号（@我 / 拍一拍）> 私聊 > 引用我 > @全体 > 普通群聊。
 *    这是"该先理谁"的判断，不是"要不要理"（后者是唤醒矩阵的事）。
 * 2. **老化**：等得越久分数越高。没有它，低优先级会话在持续高优先级流量下会**永远**排不上。
 * 3. **每会话冷却与配额**：同一会话两次轮次之间强制间隔、每窗口限次。
 *    这是直接针对"话痨群"的闸门 —— 它再能刷，也只能占到自己那一份。
 *
 * ## 为什么做成纯状态机
 *
 * 调度逻辑最怕"看起来公平、实际有偏"。纯状态机 + 注入时钟 ⇒ 可以用确定性测试
 * 把"50 条刷屏时私聊第几个被服务"这种问题钉死，而不是靠线上观察。
 *
 * @module @forlife/gateway/scheduler
 */
import type { WakeCondition } from './wake.ts'

/** 排队中的一项（同一会话的多批消息会合并成一项）。 */
export interface ScheduleItem {
  readonly conversationKey: string
  /** 本项里最高优先级的条件（合并时取最高）。 */
  condition: WakeCondition
  /** 最早入队时间（用于老化）。 */
  readonly enqueuedAt: number
  /** 累计合并了多少条消息。 */
  messageCount: number
  /** 已排队多久没被服务（诊断用）。 */
  waitedMs: number
  /** 当前分数（诊断用）。 */
  score: number
}

/** 入队请求。 */
export interface ScheduleEnqueue {
  readonly conversationKey: string
  readonly condition: WakeCondition
}

/** 调度器选项。 */
export interface SchedulerOptions {
  readonly now?: () => number
  /** 同一会话两次轮次之间的最小间隔（毫秒）。默认 3000（防话痨的直接闸门）。 */
  readonly perConversationCooldownMs?: number
  /** 每会话每窗口最多轮次。默认 10 次 / 60 秒。 */
  readonly perConversationMaxTurns?: number
  readonly perConversationWindowMs?: number
  /**
   * 老化速度：每等这么多毫秒，分数 +1。
   * 默认 1000ms/分 —— 等一分钟就相当于跨过一档优先级（10 分一档），
   * 保证低优先级会话不会无限期排不上。
   */
  readonly agingMsPerPoint?: number
}

/** 条件 → 基础优先级（分数越高越先被处理）。 */
export const CONDITION_PRIORITY: Readonly<Record<WakeCondition, number>> = {
  group_mention: 100, // 明确的求助/点名
  group_poke: 100, // 拍一拍就是"喂，看我"
  private_message: 80, // 私聊默认更该理
  reply_to_me: 60,
  temp_message: 50, // 临时会话：低概率唤醒，但一旦醒了就正常对待
  bot_offline: 90, // 系统类事件：需要尽快知道
  message_recalled: 55,
  external_request: 70,
  group_mention_all: 40,
  media_received: 30,
  file_received: 30,
  peer_input_status: 25,
  peer_status_change: 20,
  self_message_sent: 10,
  group_message_any: 20,
}

/** 调度快照（面板用）。 */
export interface SchedulerSnapshot {
  readonly queued: readonly ScheduleItem[]
  readonly cooling: readonly { readonly conversationKey: string; readonly readyInMs: number }[]
  readonly served: readonly { readonly conversationKey: string; readonly turns: number }[]
}

/**
 * 多会话调度器。
 */
export class TurnScheduler {
  private readonly now: () => number
  private readonly cooldownMs: number
  private readonly maxTurns: number
  private readonly windowMs: number
  private readonly agingMsPerPoint: number
  /** 排队中的项（每会话至多一项 —— 同一会话的新消息合并进去）。 */
  private readonly items = new Map<string, ScheduleItem>()
  /** 每会话的上次服务时间。 */
  private readonly lastServedAt = new Map<string, number>()
  /** 每会话的窗口内服务次数与窗口起点。 */
  private readonly windows = new Map<string, { count: number; since: number }>()

  constructor(options: SchedulerOptions = {}) {
    this.now = options.now ?? ((): number => Date.now())
    this.cooldownMs = options.perConversationCooldownMs ?? 3000
    this.maxTurns = options.perConversationMaxTurns ?? 10
    this.windowMs = options.perConversationWindowMs ?? 60_000
    this.agingMsPerPoint = options.agingMsPerPoint ?? 1000
  }

  /**
   * 入队一批消息；同会话已在排队时**合并**（保留更高的优先级）。
   *
   * 合并而不是各排各的，正是"防话痨"的另一半：话痨群刷 50 条只会占**一个**排队位。
   *
   * @param request - 会话与条件。
   * @returns 合并后该项的消息数。
   */
  enqueue(request: ScheduleEnqueue): number {
    const existing = this.items.get(request.conversationKey)
    if (existing !== undefined) {
      const better =
        CONDITION_PRIORITY[request.condition] > CONDITION_PRIORITY[existing.condition] ? request.condition : existing.condition
      this.items.set(request.conversationKey, {
        ...existing,
        condition: better,
        messageCount: existing.messageCount + 1,
        waitedMs: existing.waitedMs,
        score: existing.score,
      })
      return existing.messageCount + 1
    }
    this.items.set(request.conversationKey, {
      conversationKey: request.conversationKey,
      condition: request.condition,
      enqueuedAt: this.now(),
      messageCount: 1,
      waitedMs: 0,
      score: 0,
    })
    return 1
  }

  /** 该会话现在是否可被服务（冷却与配额）。 */
  private readyAt(key: string): number {
    const now = this.now()
    const last = this.lastServedAt.get(key)
    const cooldownReady = last === undefined ? 0 : last + this.cooldownMs
    const window = this.windows.get(key)
    // 窗口过期则配额重置
    const quotaBlocked = window !== undefined && now - window.since < this.windowMs && window.count >= this.maxTurns
    return quotaBlocked ? Math.max(cooldownReady, (window?.since ?? now) + this.windowMs) : cooldownReady
  }

  /**
   * 取出下一个该处理的会话（**不**移除；处理完调 `complete`）。
   *
   * @returns 选中的项，或 undefined（都还在冷却/配额里，或队列空）。
   */
  next(): ScheduleItem | undefined {
    const now = this.now()
    let best: ScheduleItem | undefined
    let bestScore = Number.NEGATIVE_INFINITY

    for (const item of this.items.values()) {
      if (now < this.readyAt(item.conversationKey)) continue
      const waitedMs = Math.max(0, now - item.enqueuedAt)
      // 分数 = 基础优先级 + 老化（等待越久越高）
      const score = CONDITION_PRIORITY[item.condition] + waitedMs / this.agingMsPerPoint
      if (score > bestScore) {
        bestScore = score
        best = { ...item, waitedMs, score }
      }
    }
    return best
  }

  /**
   * 把某会话从队列里取走但**不记账**（不冷却、不占配额）。
   *
   * 用途：调度器取出任务后要先移除它（否则同一项会被反复取到），
   * 而"是否真的消耗了模型资源"要等轮次跑完才知道 ⇒ 先 release，跑完再决定 charge。
   *
   * @param conversationKey - 会话键。
   */
  release(conversationKey: string): void {
    this.items.delete(conversationKey)
  }

  /**
   * 记账：该会话刚刚真的消耗了一轮模型资源 ⇒ 进入冷却并占用配额。
   *
   * **只有真正唤醒（调用了模型）的轮次才该记账**。早期版本对"判定为不唤醒"的批次
   * 也记了账，后果是：群里闲聊每 3 秒就刷新一次冷却，等真的有人 @ 我时反而要排队 ——
   * 明明没花任何模型资源，却按花了算。
   *
   * @param conversationKey - 会话键。
   */
  charge(conversationKey: string): void {
    const now = this.now()
    this.lastServedAt.set(conversationKey, now)

    const window = this.windows.get(conversationKey)
    if (window === undefined || now - window.since >= this.windowMs) {
      this.windows.set(conversationKey, { count: 1, since: now })
    } else {
      window.count += 1
    }
  }

  /**
   * 标记某会话的一轮已完成（= release + charge）。
   *
   * 语义上等价于"这一轮确实消耗了模型资源"。只想取走不记账请用 `release`。
   *
   * @param conversationKey - 会话键。
   */
  complete(conversationKey: string): void {
    this.release(conversationKey)
    this.charge(conversationKey)
  }

  /** 队列里还有多少会话在等。 */
  size(): number {
    return this.items.size
  }

  /** 某个会话是否正在排队。 */
  has(conversationKey: string): boolean {
    return this.items.has(conversationKey)
  }

  /** 快照（面板与排障）。 */
  snapshot(): SchedulerSnapshot {
    const now = this.now()
    return {
      queued: [...this.items.values()].map((item) => {
        const waitedMs = Math.max(0, now - item.enqueuedAt)
        return {
          ...item,
          waitedMs,
          score: CONDITION_PRIORITY[item.condition] + waitedMs / this.agingMsPerPoint,
        }
      }),
      cooling: [...this.items.keys()]
        .map((key) => ({ conversationKey: key, readyInMs: Math.max(0, this.readyAt(key) - now) }))
        .filter((entry) => entry.readyInMs > 0),
      served: [...this.windows.entries()].map(([conversationKey, window]) => ({ conversationKey, turns: window.count })),
    }
  }
}

