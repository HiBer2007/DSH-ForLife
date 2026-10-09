/**
 * QQ **离线积压**：通知、取回、以及"要不要为它单独叫醒模型"。
 *
 * ## 积压到底积在哪（先把这个说清，否则会去错的地方找）
 *
 * 这个 headless QQ 客户端**不存聊天记录**（`nt_qq` 里只有 `login.db`，没有消息库），
 * 消息进来就通过 OneBot 转给我们 ⇒ **积压只可能在我们这一侧**。
 * 我们这一侧有两个池子，分工完全不同：
 *
 * | 池子 | 装什么 | 本模块用不用 |
 * | :--- | :--- | :--- |
 * | `qq_inbox` | **每一条**收到的消息（含未唤醒的），有全文与原始 JSON | 不用（它是全量流水，不是"没读的"） |
 * | **`pending_messages`** | **判定为"不唤醒"的那些消息**的摘要 —— 也就是"没读的" | ★ 就是它 |
 *
 * ⇒ "有 N 条没读"= `pending_messages WHERE read = 0` 的条数。**没有第三张表、没有第二个池子。**
 *
 * ## (a) 通知：**只说"有 N 条"，不把内容塞进上下文**
 *
 * 用户的要求：
 *
 * > 「不用按照完整的合并转发处理，而是通知模型有这些没有读，强制模型去处理这些消息就行，
 * >   然后让模型自己一个一个或者批量取回来。」
 *
 * **为什么不直接把内容塞进提示词**（旧行为就是塞 5 条摘要）：
 * 积压 300 条时那 5 条既不完整、又占了窗口，而模型完全无法判断"还有多少没看"。
 * 这与本项目刚修过的**中期记忆窗口**是同一条原则：
 * **不要一次把大量外部内容塞进活跃上下文** —— 先给索引，让需要的人自己去取。
 *
 * ⇒ `renderBacklogNotice()` 产出的文本里**一个字的正文都没有**，
 * 只有：条数、涉及几个会话、哪几个来源各多少条、时间范围、怎么取。
 *
 * ## (b) 强制：强度选的是"**每轮都出现 + 措辞是硬要求**"，不是"阻塞别的工具"
 *
 * 三种可选强度，逐个说为什么：
 *
 *  1. **只在提示词里软提示**（"你有空可以看看"）—— **不选**。用户的原话是"强制"，
 *     而软提示在实测里就是会被忽略（模型有更急的事要做）。
 *  2. **硬阻塞**（积压没清空就不许调 `qq_reply` 等其它工具）—— **不选**。
 *     积压可能是一条永远处理不完的群（或者 300 条垃圾消息），
 *     硬阻塞会把模型**锁死**在"必须清空积压"上，连有人私聊都回不了 ——
 *     那比不处理积压更糟：用户看到的是机器人**完全不回话**了。
 *  3. ★ **每轮必现 + 硬措辞 + 有额度**（选中）：积压通知**每一轮都出现在提示词里**，
 *     并且写明"这是硬要求，先处理或明确说明为什么跳过"；
 *     同时取回有额度（`qq.backlog.*`），所以它**不会**变成无底洞。
 *
 *     为什么"每轮必现"就等于强制：模型无法假装没看见 ——
 *     它每一轮都要面对这个数字，要么处理、要么显式跳过；
 *     而"显式跳过"这个动作本身也在日志与面板里留下痕迹（`wake_events` 里那条判定）。
 *
 * ## (b2) 单独一组参数（用户明确的"单独的一组"）
 *
 * "因为有没读的消息而唤醒模型"用的是**独立的唤醒条件** `pending_backlog`
 * （见 `wake.ts` 的 `WAKE_CONDITIONS` 与基线的 `wake.rules.pendingBacklog`），
 * 与"收到新消息"的那组（`group_message_any` / `private_message` / …）**互不影响**。
 *
 * ⇒ 于是模型可以"忽略离线期间的**群**消息，但不影响正常在线"：
 * 把 `pending_backlog` 关掉（或用 `minUnread` 调高门槛），
 * 在线时的 `@我` / 私聊唤醒照旧。
 *
 * @module @forlife/gateway/backlog
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { nowIso } from '@forlife/store'

import { decideWake, type PendingItem, type WakeCondition, type WakeVerdict } from './wake.ts'

/** 一个来源的积压概况。 */
export interface BacklogScopeSummary {
  /** `group:88888` / `private:10001`（与 `pending_messages.scope` 同口径）。 */
  readonly scope: string
  readonly kind: 'group' | 'private' | 'other'
  readonly unread: number
  readonly oldestAt: string
  readonly newestAt: string
}

/** 积压概况（**只有计数与时间，没有正文**）。 */
export interface BacklogNotice {
  readonly unread: number
  /** 涉及几个会话（`conversation_key` 的种类数）。 */
  readonly conversations: number
  /** 按来源汇总（按未读数降序）。 */
  readonly scopes: readonly BacklogScopeSummary[]
  /** 最早/最新一条的时间；没有积压时为 undefined。 */
  readonly oldestAt?: string
  readonly newestAt?: string
  /** 其中群聊的未读数（"尤其是群消息"要能一眼看出来）。 */
  readonly groupUnread: number
  /** 其中私聊的未读数。 */
  readonly privateUnread: number
}

/** `scope` 前缀 → kind。 */
function kindOfScope(scope: string): BacklogScopeSummary['kind'] {
  if (scope.startsWith('group:')) return 'group'
  if (scope.startsWith('private:') || scope.startsWith('temp:')) return 'private'
  return 'other'
}

/**
 * 取积压概况（**一次聚合查询，永不返回正文**）。
 *
 * @param db - 数据库。
 * @returns 概况；没有积压时各项为 0/空。
 */
export function backlogNotice(db: DatabaseSync): BacklogNotice {
  const rows = db
    .prepare(
      `SELECT scope, count(*) AS unread, min(at) AS oldest, max(at) AS newest, count(DISTINCT conversation_key) AS convs
         FROM pending_messages WHERE read = 0 GROUP BY scope ORDER BY unread DESC`,
    )
    .all() as unknown as { scope: string; unread: number; oldest: string; newest: string; convs: number }[]

  if (rows.length === 0) return { unread: 0, conversations: 0, scopes: [], groupUnread: 0, privateUnread: 0 }

  const scopes: BacklogScopeSummary[] = rows.map((row) => ({
    scope: row.scope,
    kind: kindOfScope(row.scope),
    unread: row.unread,
    oldestAt: row.oldest,
    newestAt: row.newest,
  }))
  let unread = 0
  let conversations = 0
  let groupUnread = 0
  let privateUnread = 0
  let oldestAt: string | undefined
  let newestAt: string | undefined
  for (const [index, row] of rows.entries()) {
    unread += row.unread
    conversations += row.convs
    const summary = scopes[index]
    if (summary?.kind === 'group') groupUnread += row.unread
    else if (summary?.kind === 'private') privateUnread += row.unread
    if (oldestAt === undefined || row.oldest < oldestAt) oldestAt = row.oldest
    if (newestAt === undefined || row.newest > newestAt) newestAt = row.newest
  }
  return {
    unread,
    conversations,
    scopes,
    ...(oldestAt === undefined ? {} : { oldestAt }),
    ...(newestAt === undefined ? {} : { newestAt }),
    groupUnread,
    privateUnread,
  }
}

/** 人话时长（与 `turns.ts` 的 `formatDuration` 同口径，避免两处说法不一致）。 */
function formatAge(ms: number): string {
  if (ms < 60_000) return `${String(Math.max(0, Math.round(ms / 1000)))} 秒`
  if (ms < 3600_000) return `${String(Math.round(ms / 60_000))} 分钟`
  if (ms < 86_400_000) return `${String(Math.round(ms / 3600_000))} 小时`
  return `${String(Math.round(ms / 86_400_000))} 天`
}

/**
 * 把积压概况渲染成**给模型看的通知文本**。
 *
 * ★ 这个函数的契约：**不许出现任何一条消息的正文**。
 * 违反它会直接退化成"把积压塞进上下文"，而这正是要避免的那件事。
 * 有测试钉住这一点（`backlog.test.ts` 用带哨兵字符串的摘要断言它**不出现**）。
 *
 * @param notice - 概况。
 * @param options.now - 当前时间（算"积压了多久"）。
 * @returns 通知文本；无积压时返回空串（调用方据此决定要不要加这一段）。
 */
export function renderBacklogNotice(notice: BacklogNotice, options: { readonly now?: Date } = {}): string {
  if (notice.unread === 0) return ''
  const now = options.now ?? new Date()
  const age = notice.oldestAt === undefined ? '' : `，最旧的一条已经等了 ${formatAge(now.getTime() - Date.parse(notice.oldestAt))}`

  const lines = [
    `【未读积压】有 ${String(notice.unread)} 条消息没有读，来自 ${String(notice.conversations)} 个会话${age}。`,
  ]
  const topScopes = defaultFor<number>('qq.backlog.noticeTopSources')
  for (const scope of notice.scopes.slice(0, topScopes)) {
    const label = scope.kind === 'group' ? '群' : scope.kind === 'private' ? '私聊' : '其它'
    lines.push(`- ${label} ${scope.scope}：${String(scope.unread)} 条（${scope.oldestAt} ~ ${scope.newestAt}）`)
  }
  if (notice.scopes.length > topScopes) lines.push(`- …还有 ${String(notice.scopes.length - topScopes)} 个来源未列出`)
  if (notice.groupUnread > 0) {
    lines.push(`其中群消息 ${String(notice.groupUnread)} 条、私聊 ${String(notice.privateUnread)} 条。`)
  }
  lines.push(
    '',
    '**这是硬要求**：先用 `read_pending` 把它们取回（可以一条一条取，也可以按来源批量取），再决定怎么回。',
    `取回有额度：单次最多 ${String(defaultFor<number>('qq.backlog.readBatchMax'))} 条，本轮最多 ${String(defaultFor<number>('qq.backlog.readPerTurnBatches'))} 批 / ${String(defaultFor<number>('qq.backlog.readPerTurnMax'))} 条。`,
    '如果判断这批积压**不值得处理**（例如全是群里的闲聊），就明确说明为什么跳过 —— 但不要假装它不存在。',
    '具体的取舍由你决定：私聊通常要紧，群消息可以只挑 @我 的部分看。',
  )
  return lines.join('\n')
}

/** 取回结果。 */
export interface BacklogReadResult {
  readonly items: readonly PendingItem[]
  /** 取完之后还剩多少条未读（**必须报**：否则模型不知道还有没有）。 */
  readonly remaining: number
}

/**
 * 取回积压（**唯一的取回入口**，`read_pending` 工具直接调它）。
 *
 * 它自己不判额度 —— 额度由 `limits.ts` 的 `backlogReadQuota` 判定，
 * 因为"能取多少"要跨调用累计，那是额度的职责不是查询的职责。
 * 这里只负责**按来源筛**：用户要的是"尤其是群消息要能单独忽略"。
 *
 * ## ⚠️ 为什么这里的查询没有复用 `wake.ts` 的 `readPending`
 *
 * `wake.ts` 的 `readPending` 只支持精确 `scope`，而用户要求"**所有群**能单独忽略/处理" ——
 * 那需要按前缀筛（`scope LIKE 'group:%'`）。本轮有**另一个改动正在改 `wake.ts`**，
 * 按纪律不能去动它（改了会撞车）。所以筛选与标记已读实现在这里。
 *
 * **代价是"标记已读"这个写动作出现了第二处实现** —— 这是明知故犯的取舍，
 * 所以配了一条测试钉住两处行为一致（`backlog.test.ts` 里同时用
 * `readBacklog` 与 `wake.ts` 的 `readPending` 读同一批数据，断言结论相同）。
 * 等 `wake.ts` 腾出来之后，这里应当并回去（并把那条测试改成守卫"只有一个实现"）。
 *
 * @param db - 数据库。
 * @param options - 筛选与条数。
 * @returns 取到的条目与剩余未读数。
 */
export function readBacklog(
  db: DatabaseSync,
  options: {
    /** 精确来源：`group:88888` / `private:10001`。 */
    readonly scope?: string
    /** 只取某一类（"群消息单独忽略/单独处理"就靠它）。 */
    readonly kind?: 'group' | 'private'
    /** 只取某个会话（`onebot11:88888`）。 */
    readonly conversationKey?: string
    /** 最多几条（**调用方必须已经过额度判定**）。 */
    readonly limit: number
    /** 是否标记已读（默认 `true`，与 `readPending` 同口径）。 */
    readonly markRead?: boolean
  },
): BacklogReadResult {
  const { where, params } = backlogFilter(options)
  const rows = db
    .prepare(`SELECT * FROM pending_messages WHERE ${where} ORDER BY at ASC LIMIT ?`)
    .all(...params, options.limit) as unknown as Record<string, unknown>[]

  const items: PendingItem[] = rows.map((row) => ({
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

  // 剩余量按**同一个筛选口径**算：不然"取完群消息后说还剩 12 条"其实剩下的是私聊，
  // 模型会以为群里还有 12 条没读。
  const remaining = countUnread(db, options)
  return { items, remaining }
}

/** 把筛选条件变成 SQL（`readBacklog` 与 `countUnread` **必须**用同一份，否则两个数字对不上）。 */
function backlogFilter(options: {
  readonly scope?: string
  readonly kind?: 'group' | 'private'
  readonly conversationKey?: string
}): { readonly where: string; readonly params: readonly string[] } {
  const conditions = ['read = 0']
  const params: string[] = []
  if (options.scope !== undefined) {
    conditions.push('scope = ?')
    params.push(options.scope)
  }
  // `temp:` 与 `private:` 都算私聊 —— 临时会话在界面上就是私聊，
  // 把它漏掉会让"我只想看看私聊"少掉一类最需要及时回的消息。
  if (options.kind === 'group') conditions.push("scope LIKE 'group:%'")
  if (options.kind === 'private') conditions.push("(scope LIKE 'private:%' OR scope LIKE 'temp:%')")
  if (options.conversationKey !== undefined) {
    conditions.push('conversation_key = ?')
    params.push(options.conversationKey)
  }
  return { where: conditions.join(' AND '), params }
}

/** 按筛选口径数未读（与 {@link readBacklog} 同一口径）。 */
export function countUnread(
  db: DatabaseSync,
  options: { readonly scope?: string; readonly kind?: 'group' | 'private'; readonly conversationKey?: string } = {},
): number {
  const { where, params } = backlogFilter(options)
  const row = db.prepare(`SELECT count(*) AS n FROM pending_messages WHERE ${where}`).get(...params) as { n: number }
  return row.n
}

// ── ★ 单独一组参数：`pending_backlog` ───────────────────────────────────────
//
// 用户明确要求：「专用于是否因为有还没有读取的消息而唤醒模型，其参数和收到新消息的那些
// 控制组大差不差，但是**单独的一组**，以便模型可以选择忽略掉线期间的消息（尤其是群消息）
// 而不影响正常在线。」
//
// ## ⚠️ 为什么这一组**没有**进 `wake.ts` 的 `WAKE_CONDITIONS`
//
// 它**应该**在里面（那里才是唤醒条件的真源）。本轮有另一个改动正在改 `wake.ts`，
// 按纪律不能去动 —— 所以这里用**同一张 `wake_rules` 表**（它是 `(scope, condition)` 的
// 通用表，不需要加列、不需要迁移）注册这一条，并复用它的一切判定逻辑
// （`decideWake` 的开关/静默期/日限/最小间隔/概率/预算六道闸门，以及 `wake_events` 留痕）。
//
// ⇒ **行为上与"它是第 16 个唤醒条件"完全一致**，唯一差别是
// `listWakeRules()` 不会自动列出它（本模块的 `listBacklogWakeRule()` 负责列出）。
// 等 `wake.ts` 腾出来后应当把它提升进 `WAKE_CONDITIONS`，并删掉这里的种子与列出逻辑。

/**
 * 这一组参数在 `wake_rules` 表里的 `condition` 取值。
 *
 * 写成 `wake.rules.pendingBacklog`（camel）对应的那个字符串，与其它条件同一命名习惯。
 */
export const BACKLOG_WAKE_CONDITION = 'pending_backlog' as WakeCondition

/** 积压唤醒规则的完整形态（与 `WakeRule` 同形，但别处不需要 import 它）。 */
export interface BacklogWakeRule {
  readonly scope: string
  readonly condition: string
  readonly enabled: boolean
  readonly probability: number
  readonly minIntervalMs: number
  readonly dailyLimit: number
  readonly quietUntil: string | null
  readonly updatedBy: string
  readonly updatedAt: string
}

/**
 * 播种积压唤醒规则（幂等）。
 *
 * 默认值来自基线 `wake.rules.pendingBacklog` —— 与其它 15 个条件**同一种取法**
 * （`wake.ts` 的 `defaultWakeRules()` 读的就是 `wake.rules.<camel>`）。
 *
 * @param db - 数据库。
 * @returns 是否插入了新行。
 */
export function seedBacklogWakeRule(db: DatabaseSync): boolean {
  const value = defaultFor<{ enabled: boolean; probability: number }>('wake.rules.pendingBacklog')
  // 最小间隔单独一个键（`wake.rules.*` 的既有形状只有 enabled/probability，
  // 不往里塞第三个字段 —— 那会让"读那组键的代码"面对两种形状）
  const minIntervalMs = defaultFor<number>('qq.backlog.wakeIntervalMs')
  const changed = db
    .prepare(
      `INSERT INTO wake_rules (scope, condition, enabled, probability, min_interval_ms, daily_limit, quiet_until, updated_by, updated_at)
       VALUES ('*', ?, ?, ?, ?, 0, NULL, 'system', ?)
       ON CONFLICT(scope, condition) DO NOTHING`,
    )
    .run(BACKLOG_WAKE_CONDITION, value.enabled ? 1 : 0, value.probability, minIntervalMs, nowIso()).changes
  return Number(changed) > 0
}

/**
 * 读积压唤醒规则（**不回落到 `wake.ts` 的兜底**：那条兜底只认已知条件，
 * 对这个新条件会给出一套硬编码值，而不是基线值 —— 那正是"参数写在基线里、生效的是别的数字"）。
 *
 * @param db - 数据库。
 * @param scope - 作用域（默认 `*`；也支持给某个群单独关掉）。
 * @returns 规则。
 */
export function listBacklogWakeRule(db: DatabaseSync, scope = '*'): BacklogWakeRule {
  const read = (target: string): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM wake_rules WHERE scope = ? AND condition = ?').get(target, BACKLOG_WAKE_CONDITION) as
      | Record<string, unknown>
      | undefined
  const row = read(scope) ?? read('*')
  if (row === undefined) {
    // 没播种时用基线值兜底（保证"零配置也按文档工作"，与 wake.ts 同一原则）
    const value = defaultFor<{ enabled: boolean; probability: number }>('wake.rules.pendingBacklog')
    return {
      scope: '*',
      condition: BACKLOG_WAKE_CONDITION,
      enabled: value.enabled,
      probability: value.probability,
      minIntervalMs: defaultFor<number>('qq.backlog.wakeIntervalMs'),
      dailyLimit: 0,
      quietUntil: null,
      updatedBy: 'system',
      updatedAt: nowIso(),
    }
  }
  return {
    scope: String(row['scope']),
    condition: BACKLOG_WAKE_CONDITION,
    enabled: Number(row['enabled']) === 1,
    probability: Number(row['probability']),
    minIntervalMs: Number(row['min_interval_ms']),
    dailyLimit: Number(row['daily_limit']),
    quietUntil: row['quiet_until'] === null ? null : String(row['quiet_until']),
    updatedBy: String(row['updated_by']),
    updatedAt: String(row['updated_at']),
  }
}

/** 积压唤醒的判定结果（`undefined` = 没到门槛，压根没判）。 */
export interface BacklogWakeDecision {
  readonly verdict: WakeVerdict
  readonly notice: BacklogNotice
}

/**
 * 判"要不要**因为积压**叫醒模型"。
 *
 * ★ 这里用的是**独立条件** `pending_backlog`（用户要的"单独一组参数"），
 * 所以关掉它**不影响**收到新消息时的那组唤醒规则 ——
 * 这正是"可以选择忽略掉线期间的消息而不影响正常在线"的落地方式。
 *
 * 两道闸门，顺序有意义：
 *  1. `qq.backlog.wakeMinUnread` —— **门槛**：没到条数就不叫（免得为 1 条闲聊把模型吵醒）；
 *  2. `decideWake(pending_backlog)` —— 走**完整的**唤醒矩阵
 *     （开关 / 静默期 / 日限 / 最小间隔 / 概率 / 全局预算，每条都留痕到 `wake_events`）。
 *
 * ⚠️ **不给 `summary`**：`decideWake` 在跳过时会把 `summary` 记进待读池 ——
 * 对积压唤醒来说那等于"把积压又抄一份进积压"，池子会自己长大。
 * 积压唤醒的**全部意义**就是不复制内容。
 *
 * @param db - 数据库。
 * @param options - 概况、时钟、随机数。
 * @returns 判定结果，或 `undefined`（没到门槛）。
 */
export function decideBacklogWake(
  db: DatabaseSync,
  options: { readonly notice?: BacklogNotice; readonly now?: Date; readonly random?: () => number } = {},
): BacklogWakeDecision | undefined {
  const notice = options.notice ?? backlogNotice(db)
  const minUnread = defaultFor<number>('qq.backlog.wakeMinUnread')
  if (notice.unread < minUnread) return undefined

  const verdict = decideWake(
    db,
    {
      // 作用域用 `*`：积压是**全局**现象（可能横跨好几个群），不该被某一个群的规则挡住。
      // 想"只忽略某个群的离线消息"应该用取回时的 `scope`/`kind` 筛选，不是靠唤醒规则。
      scope: '*',
      condition: BACKLOG_WAKE_CONDITION,
      conversationKey: '*',
      // ⚠️ 刻意**不给 summary**（理由见上）
    },
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.random === undefined ? {} : { random: options.random }),
    },
  )
  return { verdict, notice }
}
