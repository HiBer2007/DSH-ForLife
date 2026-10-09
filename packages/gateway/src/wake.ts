/**
 * 唤醒条件矩阵（EXECUTION_PLAN §2.17.2，规则按用户拍板）。
 *
 * ## 核心设计：**每个条件互相独立，不派生**
 *
 * 用户明确要求："直接把每个唤醒条件拆分为独立的开关/概率调节器，不再设置关系等级"，
 * 并特别强调 `@全体成员` **另外算**（默认 50%），与 `@我`（100%）分开。
 * 所以这里没有任何"等级/关系"推导 —— 每个 `(scope, condition)` 一行规则，各判各的。
 *
 * ## 默认值（用户拍板，写进保真度基线）
 *
 * | 条件 | 默认 |
 * | :--- | :--- |
 * | 群聊里任何消息（`group_message_any`） | **完全关**（默认群聊零唤醒） |
 * | `@我`（`group_mention`） | 100% |
 * | `@全体成员`（`group_mention_all`） | **50%，独立算** |
 * | 拍一拍（`group_poke`） | 100% |
 * | 私聊（`private_message`） | 80% |
 * | 临时会话（`temp_message`） | 20% |
 *
 * ## 判定顺序（很重要）
 *
 * 关闭 → 静默期 → 频率/日限 → 概率 → 全局预算。顺序决定了"为什么没唤醒"的归因，
 * 每次判定都写 `wake_events`，面板与排障全靠它。
 *
 * @module @forlife/gateway/wake
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { nowIso } from '@forlife/store'

/** 全部唤醒条件（与基线 `wake.rules.*` 一一对应）。 */
export const WAKE_CONDITIONS = [
  'private_message',
  'temp_message',
  'group_message_any',
  'group_mention',
  'group_mention_all',
  'group_poke',
  'reply_to_me',
  'peer_input_status',
  'peer_status_change',
  'media_received',
  'file_received',
  'bot_offline',
  'message_recalled',
  'external_request',
  'self_message_sent',
] as const

/** 唤醒条件。 */
export type WakeCondition = (typeof WAKE_CONDITIONS)[number]

/** 一条唤醒规则。 */
export interface WakeRule {
  readonly scope: string
  readonly condition: WakeCondition
  readonly enabled: boolean
  readonly probability: number
  readonly minIntervalMs: number
  readonly dailyLimit: number
  readonly quietUntil: string | null
  readonly updatedBy: 'system' | 'model' | 'admin'
  readonly updatedAt: string
}

/** 判定结果的原因码。 */
export type WakeReason =
  | 'matched'
  | 'disabled'
  | 'quiet_hours'
  | 'daily_limit'
  | 'min_interval'
  | 'probability'
  | 'budget'

/** 判定结果。 */
export interface WakeVerdict {
  readonly decision: 'wake' | 'skip'
  readonly reason: WakeReason
  readonly condition: WakeCondition
  readonly scope: string
  /** 命中的规则（含概率），便于解释。 */
  readonly rule: WakeRule
  /** 概率判定用的随机数（可复算，排障用）。 */
  readonly roll?: number
}

/** 判定请求。 */
export interface WakeRequest {
  /** 规则作用域：`*` 全局，`private:<id>` / `group:<id>` 覆盖。 */
  readonly scope: string
  readonly condition: WakeCondition
  readonly conversationKey: string
  /** 被判定消息的摘要（跳过时进待读池）。 */
  readonly summary?: string
  readonly senderName?: string
}

/** 每次判定都要留痕，这里对上账。 */
export interface WakeDecisionOptions {
  readonly now?: Date
  /** 注入随机数（测试用固定序列）。 */
  readonly random?: () => number
  /** 全局预算覆盖（测试用）。 */
  readonly budget?: { readonly globalPerHour: number; readonly globalPerDay: number }
}

/** 从保真度基线取默认规则（保证与文档一比一）。 */
/**
 * ★ 唤醒条件的**生产者登记表** —— 回答"面板上这条规则真的会触发吗"。
 *
 * ## 为什么必须有一张机器可读的表（而不是写在注释里）
 *
 * 2026-10-09 的入站事件审计发现：**15 个唤醒条件里有 7 个没有任何生产者**
 * （`turns.ts` 的 `defaultConditionOf` 是唯一的产出点）。后果是面板上改那些规则的
 * 开关/概率**什么都不会发生，而且不报错** —— 用户以为配好了，其实永远不会触发。
 *
 * 这类缺陷在行为层看不出来（不抛异常、不留痕、面板照样能点），所以只能靠**登记 + 守卫**：
 *  1. 本表把每个条件的生产者写成**仓库相对路径**；`null` = 没有，且**必须**写 `waitingOn`
 *     说清卡在哪、等什么；
 *  2. `wake-runtime.ts` 启用时把缺口打进日志（`describeWakeProducerGaps()`）——
 *     让"配了不会发生"从"事后审计才发现"变成"启动第一眼就能看到"；
 *  3. `gateway/test/wake-condition-producers-wiring.test.ts` 逐条核对：
 *     声称的生产者文件里**真的有产出它的那一行**（去注释、语句位置）。
 *
 * ⇒ 以后再加一个条件，要么接上生产者，要么在表里写明卡在哪 —— **不能两不选**。
 */
export interface WakeConditionProducer {
  /** 产出它的模块（仓库相对 `packages/` 的路径，或 `turns.ts` 这样的文件名）；`null` = 当前没有生产者。 */
  readonly by: string | null
  /** 没有生产者时**必须**写清"卡在哪、等什么"（否则这张表会变成新的谎话）。 */
  readonly waitingOn?: string
  /** 一句话说明它靠什么信号产出。 */
  readonly note: string
}

/** 条件 → 生产者（见类型注释里的三条纪律）。 */
export const WAKE_CONDITION_PRODUCERS: Readonly<Record<WakeCondition, WakeConditionProducer>> = {
  private_message: { by: 'turns.ts', note: '私聊消息（`defaultConditionOf` 的兜底分支）' },
  temp_message: { by: 'turns.ts', note: '临时会话（`kind = temp`）' },
  group_message_any: { by: 'turns.ts', note: '群里既没 @ 也没拍一拍时的兜底（默认关闭）' },
  group_mention: { by: 'turns.ts', note: '`at` 段命中自己的 QQ 号' },
  group_mention_all: { by: 'turns.ts', note: '`at` 段的 `qq = all`' },
  group_poke: { by: 'turns.ts', note: '`notice/notify/poke` 合成的拍一拍消息' },
  reply_to_me: {
    by: 'turns.ts',
    note: '`reply` 段的 `data.id` 能在 `qq_outbox.platform_msg_id` 里查到 ⇒ 这条在回我（★ 2026-10-09 补）',
  },
  media_received: { by: 'turns.ts', note: '`image` / `record` / `video` 段（`mediaKind` 非空）' },
  file_received: { by: 'turns.ts', note: '`file` 段（`mediaKind = file`，比 media_received 更具体）' },
  external_request: {
    by: 'wake-external-source.ts',
    note: '外部系统带令牌触发时过这道矩阵（★ 2026-10-09 补：此前它没有消费者）',
  },
  bot_offline: {
    by: 'wake-liveness.ts',
    note: '心跳断/心跳 online=false/bot_offline 通知 ⇒ 存活判据判定离线后过这道矩阵（★ 2026-10-09 补）',
  },
  peer_input_status: {
    by: null,
    // ★ 2026-10-09 更正：这里原来写的是「onebot.ts 还没把它归一成事件（P1-3）」。
    //   那句话**已经过时了** —— 而这张表存在的唯一理由就是"不能变成新的谎话"，
    //   所以指错文件比不写更糟：下一个人会去 onebot.ts 白找一遍。
    //
    //   事实是：事件**早就有**了。`onebot.ts:463` 归一出 `InboundEvent{type:'peer_input_status'}`，
    //   `gateway.ts:237` 也认它。真正的卡点在**事件被有意分流**：
    //   `gateway.ts:231-246` 对非消息事件先 `recordTyping()` 写进 `forlife_state`
    //   （自带过期时刻，由 `read_pending` 现问现答），然后**直接 return** ——
    //   根本走不到 `decideWake`。那段代码的注释写明了理由：
    //   「正在输入是瞬时信号，不该进待办队列、也不该靠 effects 报告」。
    //
    //   ⇒ 所以这**不是"忘了接"，是设计上决定不接**。
    //   但基线仍然给它 25% 的唤醒概率（`scheduler.ts`）、面板也让人配它、分组里也列着它
    //   —— 三处都当它是个能唤醒的条件，只有事件路径不当。**两边对不上。**
    //
    //   **该由用户拍板**（两条都自洽，选哪条取决于"正在输入值不值得打断模型"）：
    //     ① 把它从 `WAKE_CONDITIONS` 摘掉，承认它只是「记录 + 现问现答」；
    //     ② 真把它接进 `decideWake`（在 `recordTyping` 之后补一次唤醒判定）。
    waitingOn:
      '★ 不是缺事件，是**有意分流**：`gateway.ts:237` 把它 recordTyping 进 forlife_state 后直接 return，' +
      '从不进 decideWake（设计上视它为瞬时信号，由 read_pending 现问现答）。' +
      '**待用户拍板**：从 WAKE_CONDITIONS 摘掉，还是真接进唤醒矩阵。',
    note: '对方正在输入 —— 只有 C2C 有；当前只记录、不唤醒（与基线的 25% 概率不一致）',
  },
  peer_status_change: {
    by: null,
    waitingOn: '需要按人轮询 `nc_get_user_status`（EXECUTION_PLAN §2.17.4 的 `person_status` 工具）；默认关',
    note: '对方在线状态变化 —— NapCat **没有**这个事件，只能主动查',
  },
  message_recalled: {
    by: null,
    waitingOn: 'gateway.ts 的事件路径：事件已归一（`InboundEvent{type:message_recalled}`），目前只落 `effects`',
    note: '撤回 —— 事件源已经有，缺的是把它接到唤醒判定上的那一行',
  },
  self_message_sent: {
    by: null,
    waitingOn: 'NapCat `reportSelfMessage: false`（生产配置不发）+ gateway.ts 把 `isSelf` 消息送进条件判定',
    note: '主人自己在别处发的消息 —— 基线里是"仅记录"（概率 0）',
  },
}

/** 当前**没有生产者**的条件（启动日志、面板与报告共用这一份事实）。 */
export function wakeConditionsWithoutProducer(): readonly WakeCondition[] {
  return WAKE_CONDITIONS.filter((condition) => WAKE_CONDITION_PRODUCERS[condition].by === null)
}

/**
 * 把"配了也不会发生"的条件渲染成一句人话。
 *
 * 没有缺口时返回 `undefined`（而不是"全部正常"那种噪音日志）——
 * 日志里只该有需要人知道的事。
 */
export function describeWakeProducerGaps(): string | undefined {
  const gaps = wakeConditionsWithoutProducer()
  if (gaps.length === 0) return undefined
  const detail = gaps
    .map((condition) => `${condition}（等：${WAKE_CONDITION_PRODUCERS[condition].waitingOn ?? '未写明'}）`)
    .join('；')
  return `⚠ 以下唤醒条件**当前没有生产者**，面板上改它们的开关/概率不会发生任何事：${detail}`
}

/**
 * 唤醒条件的**会话类型分组**（面板按它展示，人才能一眼看出"不同会话等级不同"）。
 *
 * 为什么要在这里（而不是面板里）定义：这是 **QQ 语义**，不是展示偏好 ——
 * `peer_input_status` 只有 C2C 有（群聊没有 typing 接口），
 * `temp_message` 是临时会话（陌生人第一条），群聊那四个各管一类触发。
 * 放在网关里保证"判定用哪些条件"与"面板展示哪些条件"是同一份事实。
 */
export const WAKE_CONDITION_GROUPS: readonly {
  readonly kind: string
  readonly note: string
  readonly conditions: readonly WakeCondition[]
}[] = [
  {
    kind: '私聊',
    note: '好友/单向好友的直接消息',
    conditions: ['private_message', 'peer_input_status'],
  },
  {
    kind: '临时会话',
    note: '非好友（群临时会话）的第一条消息 —— 默认只给很低概率，避免被陌生人刷屏',
    conditions: ['temp_message'],
  },
  {
    kind: '群聊',
    note: '四个触发各管一类：@我 / @全体 / 普通消息抽样 / 拍一拍',
    conditions: ['group_mention', 'group_mention_all', 'group_message_any', 'group_poke'],
  },
  {
    kind: '不分会话类型',
    note: '这些条件与"在哪说的"无关（回复我、媒体、撤回、机器人掉线等）',
    conditions: ['reply_to_me', 'media_received', 'file_received', 'message_recalled', 'bot_offline', 'external_request', 'peer_status_change', 'self_message_sent'],
  },
]

export function defaultWakeRules(): readonly Omit<WakeRule, 'scope' | 'quietUntil' | 'updatedAt'>[] {
  const read = (name: WakeCondition): { enabled: boolean; probability: number } => {
    const key = `wake.rules.${camel(name)}`
    return defaultFor<{ enabled: boolean; probability: number }>(key)
  }
  return WAKE_CONDITIONS.map((condition) => {
    const value = read(condition)
    return {
      condition,
      enabled: value.enabled,
      probability: value.probability,
      minIntervalMs: 0,
      dailyLimit: 0,
      updatedBy: 'system' as const,
    }
  })
}

/** `group_mention_all` → `groupMentionAll`。 */
function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase())
}

/**
 * 播种默认规则（幂等：已有规则不覆盖）。
 *
 * @param db - 数据库。
 * @returns 本次新增的规则数。
 */
export function seedWakeRules(db: DatabaseSync): number {
  let inserted = 0
  const statement = db.prepare(
    `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until, updated_by, updated_at)
     VALUES ('*', ?, ?, ?, ?, ?, NULL, 'system', ?)
     ON CONFLICT(scope, condition) DO NOTHING`,
  )
  const at = nowIso()
  for (const rule of defaultWakeRules()) {
    inserted += Number(statement.run(rule.condition, rule.enabled ? 1 : 0, rule.probability, rule.minIntervalMs, rule.dailyLimit, at).changes)
  }
  return inserted
}

/** 读一条规则（先查精确作用域，再回落到 `*`）。 */
export function resolveWakeRule(db: DatabaseSync, scope: string, condition: WakeCondition): WakeRule {
  const read = (target: string): WakeRule | undefined => {
    const row = db.prepare('SELECT * FROM wake_rules WHERE scope = ? AND condition = ?').get(target, condition) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) return undefined
    return {
      scope: String(row['scope']),
      condition,
      enabled: Number(row['enabled']) === 1,
      probability: Number(row['probability']),
      minIntervalMs: Number(row['min_interval_ms']),
      dailyLimit: Number(row['daily_limit']),
      quietUntil: row['quiet_until'] === null ? null : String(row['quiet_until']),
      updatedBy: String(row['updated_by']) as WakeRule['updatedBy'],
      updatedAt: String(row['updated_at']),
    }
  }
  const exact = read(scope)
  if (exact !== undefined) return exact
  const global = read('*')
  if (global !== undefined) return global
  // 兜底：表没播种时用基线默认值（保证"零配置也能按文档工作"）
  const fallback = defaultWakeRules().find((r) => r.condition === condition)
  return {
    scope: '*',
    condition,
    enabled: fallback?.enabled ?? true,
    probability: fallback?.probability ?? 100,
    minIntervalMs: 0,
    dailyLimit: 0,
    quietUntil: null,
    updatedBy: 'system',
    updatedAt: nowIso(),
  }
}

/** 列出规则（可按作用域过滤；含继承来的全局规则）。 */
export function listWakeRules(db: DatabaseSync, scope?: string): readonly WakeRule[] {
  return WAKE_CONDITIONS.map((condition) => resolveWakeRule(db, scope ?? '*', condition))
}

/**
 * 修改一条规则（模型自调 / 后台调节都走这里）。
 *
 * @param db - 数据库。
 * @param scope - 作用域。
 * @param condition - 条件。
 * @param patch - 要改的字段。
 * @param updatedBy - 谁改的（进审计与面板）。
 * @returns 修改后的规则。
 */
export function setWakeRule(
  db: DatabaseSync,
  scope: string,
  condition: WakeCondition,
  patch: Partial<Pick<WakeRule, 'enabled' | 'probability' | 'minIntervalMs' | 'dailyLimit' | 'quietUntil'>>,
  updatedBy: 'system' | 'model' | 'admin' = 'model',
): WakeRule {
  const current = resolveWakeRule(db, scope, condition)
  const next = {
    enabled: patch.enabled ?? current.enabled,
    probability: Math.max(0, Math.min(100, patch.probability ?? current.probability)),
    minIntervalMs: Math.max(0, patch.minIntervalMs ?? current.minIntervalMs),
    dailyLimit: Math.max(0, patch.dailyLimit ?? current.dailyLimit),
    quietUntil: patch.quietUntil === undefined ? current.quietUntil : patch.quietUntil,
  }
  db.prepare(
    `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, condition) DO UPDATE SET
       enabled = excluded.enabled, probability = excluded.probability,
       min_interval_ms = excluded.min_interval_ms, daily_limit = excluded.daily_limit,
       quiet_until = excluded.quiet_until, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(
    scope,
    condition,
    next.enabled ? 1 : 0,
    next.probability,
    next.minIntervalMs,
    next.dailyLimit,
    next.quietUntil,
    updatedBy,
    nowIso(),
  )
  return resolveWakeRule(db, scope, condition)
}

/** 统计某规则近期唤醒次数（用于日限与最小间隔）。 */
function recentWakes(db: DatabaseSync, scope: string, condition: WakeCondition, sinceIso: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM wake_events WHERE scope = ? AND condition = ? AND decision = 'wake' AND at >= ?")
    .get(scope, condition, sinceIso) as { n: number }
  return row.n
}

/** 全局唤醒预算检查（§2.14.5）。 */
function budgetExceeded(db: DatabaseSync, at: Date, budget: { globalPerHour: number; globalPerDay: number }): boolean {
  const hourAgo = new Date(at.getTime() - 3600_000).toISOString()
  const dayAgo = new Date(at.getTime() - 86_400_000).toISOString()
  const hour = db.prepare("SELECT count(*) AS n FROM wake_events WHERE decision = 'wake' AND at >= ?").get(hourAgo) as { n: number }
  if (hour.n >= budget.globalPerHour) return true
  const day = db.prepare("SELECT count(*) AS n FROM wake_events WHERE decision = 'wake' AND at >= ?").get(dayAgo) as { n: number }
  return day.n >= budget.globalPerDay
}

/**
 * 判定一次唤醒（并在 `wake_events` 留痕；跳过时把摘要放进待读池）。
 *
 * @param db - 数据库。
 * @param request - 判定请求。
 * @param options - 时钟与随机数注入。
 * @returns 判定结果。
 */
export function decideWake(db: DatabaseSync, request: WakeRequest, options: WakeDecisionOptions = {}): WakeVerdict {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const at = now.toISOString()
  const budget = options.budget ?? {
    globalPerHour: defaultFor<number>('wake.budget.globalPerHour'),
    globalPerDay: defaultFor<number>('wake.budget.globalPerDay'),
  }

  const rule = resolveWakeRule(db, request.scope, request.condition)
  const finish = (decision: 'wake' | 'skip', reason: WakeReason, roll?: number): WakeVerdict => {
    db.prepare(
      `INSERT INTO wake_events (id, scope, condition, conversation_key, decision, reason, roll, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), request.scope, request.condition, request.conversationKey, decision, reason, roll ?? null, at)
    if (decision === 'skip' && request.summary !== undefined) {
      recordPending(db, {
        scope: request.scope,
        conversationKey: request.conversationKey,
        summary: request.summary,
        ...(request.senderName === undefined ? {} : { senderName: request.senderName }),
        at,
      })
    }
    return { decision, reason, condition: request.condition, scope: request.scope, rule, ...(roll === undefined ? {} : { roll }) }
  }

  // ① 开关（默认群聊零唤醒就靠这里）
  if (!rule.enabled || rule.probability === 0) return finish('skip', 'disabled')

  // ② 静默期
  if (rule.quietUntil !== null && rule.quietUntil > at) return finish('skip', 'quiet_hours')

  // ③ 日限
  if (rule.dailyLimit > 0) {
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString()
    if (recentWakes(db, request.scope, request.condition, dayAgo) >= rule.dailyLimit) return finish('skip', 'daily_limit')
  }

  // ④ 最小间隔
  if (rule.minIntervalMs > 0) {
    const last = db
      .prepare("SELECT at FROM wake_events WHERE scope = ? AND condition = ? AND decision = 'wake' ORDER BY at DESC LIMIT 1")
      .get(request.scope, request.condition) as { at: string } | undefined
    if (last !== undefined && now.getTime() - Date.parse(last.at) < rule.minIntervalMs) return finish('skip', 'min_interval')
  }

  // ⑤ 概率
  const roll = random() * 100
  if (roll >= rule.probability) return finish('skip', 'probability', roll)

  // ⑥ 全局预算（概率过了也要看预算，避免一天被叫醒几百次）
  if (budgetExceeded(db, now, budget)) return finish('skip', 'budget', roll)

  return finish('wake', 'matched', roll)
}

// ── 待读池（§2.17.3）────────────────────────────────────────────────────────

/** 池容量与窗口（来自基线，超限时删最旧的）。 */
function pendingLimits(): { perScope: number; windowHours: number } {
  return {
    perScope: defaultFor<number>('wake.pending.perScope'),
    windowHours: defaultFor<number>('wake.pending.windowHours'),
  }
}

/** 记一条待读（跳过唤醒时自动调用，也可手动）。 */
export function recordPending(
  db: DatabaseSync,
  input: { readonly scope: string; readonly conversationKey: string; readonly summary: string; readonly senderName?: string; readonly at?: string },
): void {
  const { perScope } = pendingLimits()
  const at = input.at ?? nowIso()
  db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
  ).run(randomUUID(), input.scope, input.conversationKey, input.senderName ?? null, input.summary, at)

  // 有界：超出容量就删该 scope 最旧的（未读优先保留？不 —— 最旧的先走，宁可丢陈旧的）
  const count = db.prepare('SELECT count(*) AS n FROM pending_messages WHERE scope = ?').get(input.scope) as { n: number }
  if (count.n > perScope) {
    db.prepare(
      `DELETE FROM pending_messages WHERE id IN (
         SELECT id FROM pending_messages WHERE scope = ? ORDER BY at ASC LIMIT ?
       )`,
    ).run(input.scope, count.n - perScope)
  }
}

/** 待读条目。 */
export interface PendingItem {
  readonly id: string
  readonly scope: string
  readonly conversationKey: string
  readonly senderName: string | null
  readonly summary: string
  readonly at: string
}

/**
 * 主动读待读池（模型调 `read_pending` 时用）。
 *
 * @param db - 数据库。
 * @param options - 范围、条数与是否标记已读。
 * @returns 待读条目（按时间升序，保证阅读顺序）。
 */
export function readPending(
  db: DatabaseSync,
  options: { readonly scope?: string; readonly limit?: number; readonly markRead?: boolean } = {},
): readonly PendingItem[] {
  const limit = options.limit ?? 20
  const rows = (
    options.scope === undefined
      ? db.prepare('SELECT * FROM pending_messages WHERE read = 0 ORDER BY at ASC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM pending_messages WHERE read = 0 AND scope = ? ORDER BY at ASC LIMIT ?').all(options.scope, limit)
  ) as unknown as Record<string, unknown>[]

  const items = rows.map((row) => ({
    id: String(row['id']),
    scope: String(row['scope']),
    conversationKey: String(row['conversation_key']),
    senderName: row['sender_name'] === null ? null : String(row['sender_name']),
    summary: String(row['summary']),
    at: String(row['at']),
  }))

  if (options.markRead !== false && items.length > 0) {
    const statement = db.prepare('UPDATE pending_messages SET read = 1, read_at = ? WHERE id = ?')
    const at = nowIso()
    for (const item of items) statement.run(at, item.id)
  }
  return items
}

/** 待读池统计（面板用）。 */
export function pendingStats(db: DatabaseSync): { readonly unread: number; readonly total: number } {
  const unread = db.prepare('SELECT count(*) AS n FROM pending_messages WHERE read = 0').get() as { n: number }
  const total = db.prepare('SELECT count(*) AS n FROM pending_messages').get() as { n: number }
  return { unread: unread.n, total: total.n }
}
