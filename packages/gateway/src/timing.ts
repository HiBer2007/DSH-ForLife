/**
 * 防抖窗口与同会话串行 —— QQ 侧的两件时序基础设施。
 *
 * 出处：PLAN §8.4「**防抖**：2-3 秒窗口，同会话新消息重置计时」「**并发**：同会话串行，
 * 跨会话并行」；§8.2 的生命周期第一步就是"防抖窗口（3s）→ 合并入队"。
 *
 * 这两件都做成**纯状态机**（注入时钟、不碰 IO），因为它们最容易出错又最难在集成里复现：
 * 时序 bug 一旦混进真实链路，表现为"偶尔吞消息""偶尔并发写坏状态"，几乎无法定位。
 *
 * @module @forlife/gateway/timing
 */

// ── 防抖 ────────────────────────────────────────────────────────────────────

/** 一个会话的防抖状态。 */
interface DebounceEntry {
  /** 已合并的消息 id（按到达顺序）。 */
  ids: string[]
  /** 计时器句柄。 */
  timer: unknown
  /** 窗口开始时间。 */
  openedAt: number
}

/** 防抖调度器选项。 */
export interface DebounceOptions {
  /** 窗口毫秒数（PLAN §8.4：2–3 秒）。 */
  readonly windowMs: number
  /** 窗口关闭时回调（此时才算"一轮的输入定了"）。 */
  readonly onFlush: (conversationKey: string, ids: readonly string[]) => void
  /** 注入时钟与定时器（测试用假时钟）。 */
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

/** 防抖调度器。 */
export class Debouncer {
  private readonly entries = new Map<string, DebounceEntry>()
  private readonly windowMs: number
  private readonly onFlush: (conversationKey: string, ids: readonly string[]) => void
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(options: DebounceOptions) {
    this.windowMs = options.windowMs
    this.onFlush = options.onFlush
    this.now = options.now ?? ((): number => Date.now())
    this.setTimer = options.setTimer ?? ((callback, ms): unknown => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? ((handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /**
   * 推入一条消息：同会话会**重置计时**（这正是"连发 5 条合并为一轮"的机制）。
   *
   * @param conversationKey - 会话键（§8.4：platform:chat_id[:thread_id]）。
   * @param messageId - 消息 id。
   * @returns 当前窗口内已积累的条数。
   */
  push(conversationKey: string, messageId: string): number {
    const existing = this.entries.get(conversationKey)
    if (existing !== undefined) {
      this.clearTimer(existing.timer)
      existing.ids.push(messageId)
      existing.timer = this.setTimer(() => this.flush(conversationKey), this.windowMs)
      return existing.ids.length
    }
    const entry: DebounceEntry = {
      ids: [messageId],
      timer: this.setTimer(() => this.flush(conversationKey), this.windowMs),
      openedAt: this.now(),
    }
    this.entries.set(conversationKey, entry)
    return 1
  }

  /** 立即结算某会话（不等窗口结束）；返回被结算的消息 id。 */
  flush(conversationKey: string): readonly string[] {
    const entry = this.entries.get(conversationKey)
    if (entry === undefined) return []
    this.clearTimer(entry.timer)
    this.entries.delete(conversationKey)
    this.onFlush(conversationKey, entry.ids)
    return entry.ids
  }

  /** 结算全部会话（关闭时用）。 */
  flushAll(): void {
    for (const key of [...this.entries.keys()]) this.flush(key)
  }

  /** 当前正在等待的会话数（诊断用）。 */
  pendingCount(): number {
    return this.entries.size
  }

  /** 某会话窗口内的条数。 */
  sizeOf(conversationKey: string): number {
    return this.entries.get(conversationKey)?.ids.length ?? 0
  }
}

// ── 同会话串行 ──────────────────────────────────────────────────────────────

/**
 * 按 key 串行、跨 key 并行的小调度器（PLAN §8.4 的 `asyncio.Lock` 等价物）。
 *
 * 保证：同一个 key 上的任务**按提交顺序**逐个执行；不同 key 之间互不阻塞。
 * 这是"多会话单窗口"能安全工作的前提 —— 同一个人（模型窗口）同时处理多个会话，
 * 但每个会话内部绝不能交叉。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * 在指定 key 上串行执行任务。
   *
   * @param key - 串行键（通常是会话键）。
   * @param task - 要执行的任务。
   * @returns 任务结果。
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    // 即使前一个任务失败，也不能阻塞后续任务（否则一次失败会永久卡住该会话）
    const next = previous.then(task, task)
    // 存进队列的必须是"永不 reject"的那份，否则一次失败会让后续 await 抛出前一个任务的错误
    const guarded = next.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, guarded)
    try {
      return await next
    } finally {
      // 队列排空后清理，避免长跑进程里 Map 无限增长。
      // 只有当自己**仍是队尾**时才删（后面又排了任务就不能删）。
      if (this.tails.get(key) === guarded) this.tails.delete(key)
    }
  }

  /** 当前有排队任务的 key 数（诊断用）。 */
  activeKeys(): number {
    return this.tails.size
  }

  /** 是否有某 key 正在排队。 */
  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}

// ── 噪音过滤（PLAN §8.5）────────────────────────────────────────────────────

/** 过滤判定。 */
export interface NoiseVerdict {
  readonly noise: boolean
  /** 命中的规则名（进日志与面板，便于调规则）。 */
  readonly rule?: string
  /** 人类可读的原因。 */
  readonly reason?: string
}

/** 一条噪音规则。 */
export interface NoiseRule {
  readonly name: string
  /** 返回 true 表示"这是噪音"。 */
  readonly test: (message: NoiseMessage) => boolean
}

/** 参与判定的消息视图（与具体平台解耦）。 */
export interface NoiseMessage {
  readonly text: string
  readonly isGroup: boolean
  readonly mentionedMe: boolean
  readonly mentionedAll: boolean
  readonly isPoke: boolean
  readonly mediaKind?: string | null
  readonly senderId?: string
}

/** 默认规则集（可在配置里关掉/替换）。 */
export const DEFAULT_NOISE_RULES: readonly NoiseRule[] = [
  {
    name: 'empty',
    test: (m) => m.text.trim() === '' && m.mediaKind == null && !m.isPoke,
  },
  {
    name: 'pure-emoji',
    // 只有表情/符号、没有任何文字信息（贴纸单独走媒体路径，不算噪音）
    test: (m) => m.text.trim() !== '' && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(m.text),
  },
  {
    name: 'too-short-in-group',
    // 群里两字以内的"嗯/哦/哈"不值得我们醒过来。
    // 必须排除带媒体的消息：一张图配空文字不是"嗯哦"，而是值得看的内容。
    test: (m) =>
      m.isGroup && !m.mentionedMe && !m.isPoke && m.mediaKind == null && m.text.trim() !== '' && [...m.text.trim()].length <= 2,
  },
]

/** 噪音过滤器。 */
export interface NoiseFilterOptions {
  readonly rules?: readonly NoiseRule[]
  /** 白名单：这些人说的话永远不算噪音（模型/管理员维护）。 */
  readonly allowedSenders?: readonly string[]
}

/**
 * 判定一条消息是否是噪音。
 *
 * 注意 §8.5 的定位：过滤发生在**队列层**，即"进记忆之前"——
 * 「不值得回复的消息，也不值得进记忆系统」。所以这个判定同时影响"唤不唤醒"和"记不记"。
 *
 * @被提及或拍一拍**永远不算噪音**（那是明确的互动信号）。
 *
 * @param message - 消息视图。
 * @param options - 规则与白名单。
 * @returns 判定结果。
 */
export function classifyNoise(message: NoiseMessage, options: NoiseFilterOptions = {}): NoiseVerdict {
  if (message.mentionedMe || message.isPoke || message.mentionedAll) {
    return { noise: false, rule: 'explicit-signal', reason: '被 @ / 拍一拍 / @全体：明确的互动信号，永不算噪音' }
  }
  const allowed = options.allowedSenders
  if (allowed !== undefined && message.senderId !== undefined && allowed.includes(message.senderId)) {
    return { noise: false, rule: 'allowlist', reason: '在说话人白名单里' }
  }
  for (const rule of options.rules ?? DEFAULT_NOISE_RULES) {
    if (rule.test(message)) return { noise: true, rule: rule.name, reason: `命中噪音规则 ${rule.name}` }
  }
  return { noise: false }
}

