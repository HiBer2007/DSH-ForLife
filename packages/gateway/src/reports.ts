/**
 * 铁律落地（EXECUTION_PLAN §2.17.7，用户逐字要求）。
 *
 * ## 铁律 1：后台任何会影响模型的操作，都必须唤醒模型并向它报告
 *
 * > "后台发生任何会影响模型的操作均需要唤醒模型并向模型报告（如果已经唤醒则直接报告），
 * >  以便模型知晓并同步记忆以避免幻觉/错误问题。"
 *
 * 落地要点：
 *  - 每个此类操作写一条 `effects` 记录（`affects_model=1`、`reported=0`）；
 *  - **合并报告**：短时间内多条操作不逐条吵醒它，等窗口内安静下来再合成一条
 *    （默认 60s —— 与 §2.17.7 的"合并报告管线"一致）；
 *  - 已经醒着（有 running 轮次）就直接注入，不重复唤醒；
 *  - 报告发出后置 `reported=1`，**不会重复报告**。
 *
 * ## 铁律 2：所有唤醒模型的消息都不使用人类发送消息
 *
 * 模型收到的消息来源只有三类：`forlife:system`（系统）、`forlife:qq`（QQ 用户）、
 * `forlife:admin`（后台「对话」页 —— **唯一的人类直发入口**）。
 * `source.kind === 'user'` 在本项目里是**禁止**的，有运行时断言兜底（见 `assertReportSource`）。
 *
 * @module @forlife/gateway/reports
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { listUnreportedEffects, markEffectsReported, recordEffect, type EffectRow } from '@forlife/store'

/** 我们允许的消息来源 kind（铁律 2）。 */
export const ALLOWED_SOURCES = ['forlife:system', 'forlife:qq', 'forlife:admin'] as const

/** 消息来源 kind。 */
export type ForlifeSource = (typeof ALLOWED_SOURCES)[number]

/**
 * 禁止使用的来源 kind。
 *
 * 项目铁律：项目内**绝不**发出 `user` 来源的消息。
 * 这不是洁癖 —— 一旦有代码冒充"人类发言"，模型就无法区分"谁在跟它说话"，
 * 而后台页与 QQ 用户的可信度、审计要求完全不同。
 */
export const FORBIDDEN_SOURCES = ['user'] as const

/**
 * 运行时断言：报告/唤醒消息的来源必须是我们允许的三种之一。
 *
 * @param source - 来源 kind。
 * @throws 当来源是 `user` 或任何未登记的 kind 时。
 */
export function assertReportSource(source: string): asserts source is ForlifeSource {
  if ((FORBIDDEN_SOURCES as readonly string[]).includes(source)) {
    throw new Error(
      `铁律 2 被违反：不得以 "${source}" 来源向模型发送消息。` +
        `允许的来源只有：${ALLOWED_SOURCES.join(' / ')}`,
    )
  }
  if (!(ALLOWED_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`未登记的消息来源 "${source}"（允许：${ALLOWED_SOURCES.join(' / ')}）`)
  }
}

/**
 * 判定某个后台操作是否影响模型（决定要不要报告）。
 *
 * 判定表刻意写死并集中在一处：散落到各处会出现"同一个操作有时报有时不报"，
 * 而那正是幻觉的温床 —— 模型以为没人动过它，其实被改过。
 */
export function affectsModel(action: string): boolean {
  // 影响：改了它的记忆、提示词、工具、唤醒条件、状态、运行环境
  const affecting = [
    'memory.',        // memory.append / memory.edit / memory.delete / memory.settle
    'prompt.',        // prompt.edit / prompt.reload
    'tool.',          // tool.enable / tool.disable
    'wake.',          // wake.rule / wake.budget
    'status.',        // status.set / status.clear
    'model.',         // model.route / model.switch / model.endpoint
    'inference.',     // inference.restart / inference.mode
    'config.',        // config.patch / config.reload
    'compaction.',    // compaction.force / compaction.settle
    'sticker.',       // sticker.add / sticker.delete（影响它能发什么）
    'media.',         // media.delete
    'restart',        // 进程重启
    'plugin.',        // plugin.enable / plugin.disable
  ]
  return affecting.some((prefix) => action === prefix || action.startsWith(prefix))
}

/** 记一次后台操作（`admin_actions` 审计，底层复用 `effects` 表）。 */
export function recordAdminAction(
  db: DatabaseSync,
  input: {
    readonly action: string
    readonly actor: 'admin' | 'system' | 'model'
    readonly subject?: string
    readonly detail: unknown
  },
): EffectRow {
  return recordEffect(db, {
    id: `eff_admin_${randomUUID()}`,
    kind: 'admin_action',
    actor: input.actor,
    subject: input.subject ?? null,
    detail: { action: input.action, ...(typeof input.detail === 'object' && input.detail !== null ? (input.detail as object) : { value: input.detail }) },
    affectsModel: affectsModel(input.action),
  })
}

/** 一条待报告的影响（已归一）。 */
export interface ReportableEffect {
  readonly id: string
  readonly kind: string
  readonly actor: string
  readonly subject: string | null
  readonly detail: string
  readonly createdAt: string
}

/** 合并报告的结果。 */
export interface ReportBatch {
  readonly effects: readonly ReportableEffect[]
  readonly text: string
}

/**
 * 取出该报告的影响（**合并窗口**内安静下来才报）。
 *
 * @param db - 数据库。
 * @param options - 时钟与窗口覆盖。
 * @returns 报告批次；窗口内还有新动作时返回空批次（等下一轮）。
 */
export function collectReportable(
  db: DatabaseSync,
  options: { readonly now?: Date; readonly coalesceMs?: number } = {},
): ReportBatch {
  const now = options.now ?? new Date()
  const coalesceMs = options.coalesceMs ?? defaultFor<number>('admin.report.coalesceMs')
  const pending = listUnreportedEffects(db, 100)
  if (pending.length === 0) return { effects: [], text: '' }

  // 合并：最近一条之后还要安静 coalesceMs，否则再等等（避免被连点按钮刷屏）
  const newest = pending[pending.length - 1]
  if (newest !== undefined && now.getTime() - Date.parse(newest.created_at) < coalesceMs) {
    return { effects: [], text: '' }
  }

  const effects = pending.map((row) => ({
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    subject: row.subject,
    detail: row.detail,
    createdAt: row.created_at,
  }))
  return { effects, text: renderReport(effects) }
}

/**
 * 把影响渲染成给模型看的报告文本。
 *
 * 措辞刻意写清"发生了什么 + 对你有什么影响 + 你需不需要做什么"，
 * 而不是干巴巴列一行日志 —— 模型要据它同步记忆，缺了后半截就只能猜。
 *
 * @param effects - 待报告的影响。
 * @returns 报告文本。
 */
export function renderReport(effects: readonly ReportableEffect[]): string {
  if (effects.length === 0) return ''
  const lines = [`【系统通知】后台发生了 ${String(effects.length)} 项会影响你的操作：`]
  for (const effect of effects) {
    lines.push(`- [${effect.createdAt}] ${describeKind(effect.kind)}｜${effect.actor}｜${effect.subject ?? '全局'}｜${effect.detail}`)
  }
  lines.push(
    '',
    '请注意：上面这些改动已经生效，你的记忆与当前状态可能与你上次的印象不一致。',
    '如与你记得的不符，以本次通知为准；必要时可以检索记忆或询问管理员。',
  )
  return lines.join('\n')
}

/** 把 kind 说成人话。 */
function describeKind(kind: string): string {
  switch (kind) {
    case 'compaction':
      return '压缩了你的记忆（短期轨迹 → 中期记忆）'
    case 'settle':
      return '沉降了旧记忆（中期条目 → 长期记忆 + 碎片指针）'
    case 'admin_action':
      return '管理员操作'
    case 'wake_rule':
      return '改了唤醒规则'
    case 'status_cleared':
      return '清除了系统故障状态'
    default:
      return kind
  }
}

/** 标记这批影响已报告。 */
export function markReported(db: DatabaseSync, effects: readonly ReportableEffect[]): number {
  return markEffectsReported(
    db,
    effects.map((e) => e.id),
  )
}

/** 是否已经醒着（有 running 轮次）。 */
export function isAwake(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM qq_turns WHERE status = 'running'").get() as { n: number }
  return row.n > 0
}

/** 报告投递决策。 */
export type DeliveryDecision =
  | { readonly mode: 'inject'; readonly reason: string }
  | { readonly mode: 'wake'; readonly reason: string }
  | { readonly mode: 'none'; readonly reason: string }

/**
 * 决定怎么把报告交给模型（铁律 1 的"如果已经唤醒则直接报告"）。
 *
 * @param db - 数据库。
 * @param batch - 报告批次。
 * @returns 投递方式。
 */
export function decideDelivery(db: DatabaseSync, batch: ReportBatch): DeliveryDecision {
  if (batch.effects.length === 0) return { mode: 'none', reason: '没有待报告的影响（或还没安静够）' }
  if (isAwake(db)) return { mode: 'inject', reason: '模型当前醒着，直接注入本轮上下文' }
  return { mode: 'wake', reason: '模型在睡，需要唤醒并报告' }
}

/**
 * 一条完整的报告流水：收集 → 决策 → （由调用方执行注入/唤醒）→ 标记已报告。
 *
 * 刻意把"执行投递"留给调用方：网关知道怎么唤醒（wake 引擎），
 * 而报告模块不该依赖唤醒实现（否则两者会纠缠成无法单测的一团）。
 *
 * @param db - 数据库。
 * @param options - 时钟与窗口。
 * @returns 决策 + 批次 + 标记函数。
 */
export function runReportCycle(
  db: DatabaseSync,
  options: { readonly now?: Date; readonly coalesceMs?: number } = {},
): { readonly decision: DeliveryDecision; readonly batch: ReportBatch; readonly commit: () => number } {
  const batch = collectReportable(db, options)
  const decision = decideDelivery(db, batch)
  return { decision, batch, commit: () => markReported(db, batch.effects) }
}
