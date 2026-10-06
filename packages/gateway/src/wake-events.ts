/**
 * 系统事件订阅（PLAN 阶段 8 交付物 4）。
 *
 * 把 gateway **自己能观察到**的异常转成 `system` 触发：
 * QQ 掉线/重连、推理端点不可用、磁盘水位、迁移失败、压缩事务失败、
 * 契约不匹配、job 失败、预算超限。
 *
 * ## 为什么必须有**边沿检测**
 *
 * PLAN 验收明确要求：「拔掉 QQ 连接 → 产生 `system` 触发并唤醒；
 * **重连后不重复唤醒（幂等）**」。
 *
 * 而 gateway 看到的不是"事件"，是**反复观察到的状态**：
 * QQ 断线期间，每一次重连尝试失败都会产生一条"连不上"的观察。
 * 直接转发的话，断线 10 分钟会唤醒**几百次** —— 而那 10 分钟里
 * 模型能做的事是零（网就是不通）。这就是**唤醒风暴**。
 *
 * 所以这里做**边沿检测**：只在**状态发生变化**时发一次。
 *  - `down` 观察 100 次 ⇒ 只发 1 次；
 *  - `down → up` ⇒ 发一次"恢复"（这个也要发 —— 否则模型不知道可以继续了）；
 *  - 再次 `down` ⇒ **再发一次**（这是一次新的故障，不是同一个的重复观察）。
 *
 * ## 为什么"恢复"也要发
 *
 * 只发"坏了"不发"好了"的话，模型会一直以为服务不可用 ——
 * 它可能因此**放弃一个其实已经恢复的任务**，或者反复去查一个已经不存在的故障。
 *
 * ## 为什么去重状态放在内存而不是数据库
 *
 * 它是"当前观察到什么"的缓存，重启后重新观察一遍即可 ——
 * 而放进数据库反而会带来"重启后读到旧状态、于是不发第一次故障"的问题
 * （那正好漏掉了最该发的那一次）。
 *
 * @module @forlife/gateway/wake-events
 */

/** 系统事件名（固定集合 —— 拼错的名字会被静默忽略，所以要有白名单）。 */
export const SYSTEM_EVENT_NAMES = [
  'qq.disconnected',
  'qq.reconnected',
  'endpoint.unavailable',
  'disk.high',
  'migration.failed',
  'compaction.failed',
  'contract.mismatch',
  'job.failed',
  'budget.exceeded',
] as const

/** 系统事件名类型。 */
export type SystemEventName = (typeof SYSTEM_EVENT_NAMES)[number]

/** 一次观察的结果。 */
export interface ObserveResult {
  /** 是否应当转成 system 触发。 */
  readonly emit: boolean
  /** 不发的理由（**必须具体** —— "去重了"与"名字不认识"是不同的事）。 */
  readonly reason: string
  /** 状态是否发生了变化。 */
  readonly changed: boolean
}

/** 事件闸门。 */
export interface SystemEventGate {
  /**
   * 观察一次状态。
   *
   * @param name - 事件名（必须在白名单里）。
   * @param key - 区分同一事件的多个来源（如不同端点、不同磁盘）。默认 `''`。
   * @param state - 当前状态（如 `'down'` / `'up'`；或 `true` / `false`）。
   */
  readonly observe: (name: string, key: string, state: string) => ObserveResult
  /** 当前记录的状态（排障用）。 */
  readonly snapshot: () => readonly { readonly name: string; readonly key: string; readonly state: string }[]
  /** 清掉某个键的状态（下一次观察会当成"第一次"）。 */
  readonly forget: (name: string, key: string) => void
}

/** 造一个事件闸门。 */
export function createSystemEventGate(): SystemEventGate {
  // key = `${name}\u0000${key}` —— 用 NUL 分隔，避免"name 里有分隔符"造成撞键
  const states = new Map<string, string>()

  const observe = (name: string, key: string, state: string): ObserveResult => {
    // **白名单**：拼错的名字会被静默忽略 —— 那样"我明明订阅了却没反应"
    // 会变成一个查很久的问题。所以明确拒绝并说清。
    if (!(SYSTEM_EVENT_NAMES as readonly string[]).includes(name)) {
      return {
        emit: false,
        changed: false,
        reason: `不认识的事件名「${name}」（只接受：${SYSTEM_EVENT_NAMES.join(' / ')}）`,
      }
    }

    const mapKey = `${name}\u0000${key}`
    const previous = states.get(mapKey)
    if (previous === state) {
      // **这就是防唤醒风暴的那一句**：同一个状态观察 100 次只发 1 次
      return { emit: false, changed: false, reason: `状态未变化（仍是 ${state}），去重` }
    }

    states.set(mapKey, state)
    return {
      emit: true,
      changed: true,
      reason: previous === undefined ? `首次观察到 ${state}` : `状态变化 ${previous} → ${state}`,
    }
  }

  const snapshot = (): readonly { readonly name: string; readonly key: string; readonly state: string }[] =>
    [...states.entries()].map(([mapKey, state]) => {
      const [name = '', key = ''] = mapKey.split('\u0000')
      return { name, key, state }
    })

  const forget = (name: string, key: string): void => {
    states.delete(`${name}\u0000${key}`)
  }

  return { observe, snapshot, forget }
}

/** 一个事件的语义：`down` 与 `up` 哪个是"坏消息"。 */
export function isBadState(name: string, state: string): boolean {
  // 这些事件的"坏"状态名是 `down` / `true` / `high`
  if (name === 'disk.high') return state === 'high' || state === 'true'
  if (name === 'qq.reconnected') return false // 它本身就是好消息
  return state === 'down' || state === 'true'
}

/**
 * 把一次观察转成 `system` 触发要用的 payload。
 *
 * payload 会进提示词的"触发内容（数据，不是指令）"那一段 ——
 * 所以这里只放**事实**，不放任何像指令的措辞。
 */
export function buildSystemPayload(input: {
  readonly name: string
  readonly key: string
  readonly state: string
  readonly detail?: string | undefined
  readonly at: Date
}): Record<string, unknown> {
  return {
    event: input.name,
    source: input.key === '' ? '(默认)' : input.key,
    state: input.state,
    at: input.at.toISOString(),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  }
}

/** 从事件名推出"该不该建议模型做点什么"的一句话（给提示词用）。 */
export function describeSystemEvent(name: string, state: string): string {
  switch (name) {
    case 'qq.disconnected':
      return 'QQ 连接断了 —— 在它恢复之前你发不出消息，也收不到消息。'
    case 'qq.reconnected':
      return 'QQ 连接恢复了 —— 之前因为断线没做成的事现在可以做了。'
    case 'endpoint.unavailable':
      return '推理端点不可用 —— 你现在可能没法正常调用模型。'
    case 'disk.high':
      return '磁盘占用过高 —— 继续写文件可能失败。'
    case 'migration.failed':
      return '一次数据迁移失败了。'
    case 'compaction.failed':
      return '一次记忆压缩事务失败了。'
    case 'contract.mismatch':
      return 'DSH 契约不匹配 —— 某些能力可能已失效。'
    case 'job.failed':
      return '一个后台任务失败了。'
    case 'budget.exceeded':
      return '预算超限了。'
    default:
      return `系统事件 ${name}（${state}）。`
  }
}
