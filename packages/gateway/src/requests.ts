/**
 * QQ **好友申请 / 群邀请**：落库、通知、待处理查询、处理留痕。
 *
 * ## 先回答一个要命的问题：**现在这些请求会不会静默丢？**
 *
 * **会。** 而且比"没收到"更隐蔽 —— 链路是通的，只是**没人告诉模型**：
 *
 *  1. NapCat **确实会上报** `request` 事件（实读 `napcat.mjs`：
 *     `class UEe extends XU { request_type = "friend"; ... }`、
 *     `class ym extends XU { request_type = "group"; ... }`，父类 `XU.post_type = REQUEST`）；
 *  2. 我们的适配器**也确实收到了**并归一化成 `{type:'request'}`（`onebot.ts` 的 `normalizeEvent`）；
 *  3. 但网关的 `onEvent` 对非消息事件只做一件事：
 *     `recordNonMessageEvent(event)` → 往 `effects` 表写一行审计，**然后 return**。
 *     **不入队、不唤醒、不通知**；
 *  4. 而"把 `effects` 里未报告的行告诉模型"那条管线（`reports.ts` 的 `runReportCycle`）
 *     **在生产里零调用** —— 只有测试调它（见 `reports.ts` 的模块头与本仓 20+ 次同类教训）。
 *
 *  ⇒ 三条合起来的净效果：**别人加你，你永远不会知道**（除非人工去看 `effects` 表）。
 *  本模块把第 3 步接上：请求**结构化落库** + **计入通知** + **可用工具查**。
 *
 * ## 为什么**不新建表**（复用 `effects`）
 *
 * `effects` 表本来就是"谁在什么时候因为什么改了什么"的统一审计面，
 * 而且它已经有 `kind` / `subject` / `detail` / `created_at` 四列，正好够用：
 *
 * | 需求 | 映射 |
 * | :--- | :--- |
 * | 这是哪条请求 | `subject` = **flag**（OneBot 用来标识请求的不透明串，处理时必须原样回传） |
 * | 请求内容 | `detail` = JSON（kind / userId / groupId / comment / subType） |
 * | 幂等 | `id` 由 `kind + flag` 派生（同一条请求重复上报**不会**变成两条） |
 * | "已经处理过了吗" | 另写一行 `kind='qq_request_handled'`、`subject` 同一个 flag |
 *
 * 新建一张 `qq_requests` 表的代价是**两张表迟早对不上**
 * （`feed.ts` 模块头里已经把这条取舍讲透了：本项目刻意不引入平行表）。
 *
 * ⚠️ 一个必须记下来的**格式事实**（实读 `napcat.mjs`，别照 OneBot 文档猜）：
 *  - `set_friend_add_request` 的 `flag` 其实是 **`buddyReqs[].reqTime`**
 *    （`find((i) => i.reqTime === e.flag.toString())`）——
 *    所以 flag **只能从上报里拿**，凭空构造一定失败（`No such request`）。
 *  - `set_group_add_request` 的 `flag` 是群系统通知的 **`seq`**，
 *    NapCat 会先按"可疑申请"找、再按普通申请找（`findNotify`），
 *    **不需要** OneBot 文档里写的 `sub_type`（实读的 schema 里根本没有这一项）。
 *
 * @module @forlife/gateway/requests
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { recordEffect } from '@forlife/store'

/** 请求种类。 */
export type RequestKind = 'friend' | 'group'

/** 一条收到的请求（已归一）。 */
export interface InboundRequest {
  readonly kind: RequestKind
  /** 申请人的 QQ 号。 */
  readonly userId: string
  /** 群邀请时的群号（好友申请没有）。 */
  readonly groupId?: string
  /** 附言（"我是某某"）。 */
  readonly comment: string
  /** OneBot 的 flag —— 处理时必须原样回传。 */
  readonly flag: string
  /** 群请求的子类型（`add` 自己申请入群 / `invite` 被邀请）。 */
  readonly subType?: string
  readonly at: string
}

/** 一条待处理的请求（从 `effects` 读回来）。 */
export interface PendingRequest {
  /** 请求 id（effects 行 id）。 */
  readonly id: string
  readonly kind: RequestKind
  readonly userId: string
  readonly groupId?: string
  readonly comment: string
  readonly flag: string
  readonly subType?: string
  readonly at: string
}

/** 请求 id：由 `kind + flag` 派生（同一条请求重复上报是幂等的）。 */
function requestEffectId(kind: RequestKind, flag: string): string {
  const key = createHash('sha1').update(`${kind}:${flag}`).digest('hex').slice(0, 16)
  return `qqreq_${key}`
}

/** 已处理标记的 id。 */
function handledEffectId(flag: string): string {
  const key = createHash('sha1').update(flag).digest('hex').slice(0, 16)
  return `qqreqdone_${key}`
}

/**
 * 记一条收到的请求（**幂等**）。
 *
 * @param db - 数据库。
 * @param request - 归一后的请求。
 * @returns 这条请求的 effects 行 id。
 */
export function recordInboundRequest(db: DatabaseSync, request: InboundRequest): string {
  const id = requestEffectId(request.kind, request.flag)
  recordEffect(db, {
    id,
    kind: 'qq_request',
    actor: 'system',
    subject: request.flag,
    detail: {
      requestKind: request.kind,
      userId: request.userId,
      ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      comment: request.comment,
      ...(request.subType === undefined ? {} : { subType: request.subType }),
      at: request.at,
    },
    // 影响模型：它会因此多一个"要不要加这个人"的判断，铁律 1 要求报告
    affectsModel: true,
  })
  return id
}

/**
 * 记一条"已处理"。
 *
 * `affectsModel: false` 是刻意的：这个动作**是模型自己做的**（它调的工具），
 * 再报告回给它只是噪音。而"别人加我"必须报告，因为那是**外部**发生的事。
 *
 * @param db - 数据库。
 * @param input - flag / 是否同意 / 理由 / 谁处理的。
 */
export function markRequestHandled(
  db: DatabaseSync,
  input: { readonly flag: string; readonly kind: RequestKind; readonly approve: boolean; readonly reason?: string; readonly actor: 'model' | 'admin' },
): void {
  recordEffect(db, {
    id: handledEffectId(input.flag),
    kind: 'qq_request_handled',
    actor: input.actor,
    subject: input.flag,
    detail: {
      requestKind: input.kind,
      approve: input.approve,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      at: new Date().toISOString(),
    },
    affectsModel: false,
  })
}

/** 安全解析 detail。 */
function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 从字符串取字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 列**待处理**的请求（已处理的不再出现）。
 *
 * "待处理"的判据是**没有对应的 `qq_request_handled` 行** ——
 * 所以从面板上手动处理掉、模型处理掉、还是别人先同意了，结论一致。
 *
 * @param db - 数据库。
 * @param options - 种类过滤与条数。
 * @returns 待处理请求（按时间升序，先来先处理）。
 */
export function listPendingRequests(db: DatabaseSync, options: { readonly kind?: RequestKind; readonly limit?: number } = {}): readonly PendingRequest[] {
  const limit = options.limit ?? 50
  const rows = db
    .prepare(
      `SELECT r.id, r.subject, r.detail, r.created_at FROM effects r
        WHERE r.kind = 'qq_request'
          AND NOT EXISTS (SELECT 1 FROM effects h WHERE h.kind = 'qq_request_handled' AND h.subject = r.subject)
        ORDER BY r.created_at ASC LIMIT ?`,
    )
    .all(limit) as unknown as { id: string; subject: string; detail: string; created_at: string }[]

  const out: PendingRequest[] = []
  for (const row of rows) {
    const detail = parseDetail(row.detail)
    const kind = detail['requestKind'] === 'group' ? 'group' : 'friend'
    if (options.kind !== undefined && kind !== options.kind) continue
    const userId = str(detail['userId']) ?? ''
    const groupId = str(detail['groupId'])
    const subType = str(detail['subType'])
    out.push({
      id: row.id,
      kind,
      userId,
      ...(groupId === undefined ? {} : { groupId }),
      comment: str(detail['comment']) ?? '',
      flag: row.subject,
      ...(subType === undefined ? {} : { subType }),
      at: str(detail['at']) ?? row.created_at,
    })
  }
  return out
}

/** 待处理请求的概况（计数，供通知用）。 */
export interface RequestNotice {
  readonly pending: number
  readonly friend: number
  readonly group: number
  readonly items: readonly PendingRequest[]
}

/**
 * 取请求概况。
 *
 * ★ 与积压通知**不同**：这里**允许带上"是谁 + 附言"**。
 * 理由：请求是**低频且必须逐条判断**的（不能让模型"批量忽略"掉一个加好友申请 ——
 * 那是有安全含义的动作），而附言通常就一句话，不会撑爆上下文。
 *
 * `items` **返回全部待处理**（最多 200 条，防有人疯狂申请把内存撑住）——
 * 截断只发生在**渲染**那一层（{@link renderRequestNotice} 按 `qq.requests.noticeMaxItems` 切）。
 * 为什么不让这个函数就切掉：调用方（网关的监督循环）要靠它拿到
 * **全部**待处理请求的 id 去标记"已报告"，切掉的话没被列出的那些会被反复报告。
 *
 * @param db - 数据库。
 * @returns 概况。
 */
export function requestNotice(db: DatabaseSync): RequestNotice {
  const all = listPendingRequests(db, { limit: 200 })
  return {
    pending: all.length,
    friend: all.filter((r) => r.kind === 'friend').length,
    group: all.filter((r) => r.kind === 'group').length,
    items: all,
  }
}

/**
 * 把请求概况渲染成给模型看的通知文本。
 *
 * @param notice - 概况。
 * @returns 通知文本；没有待处理请求时返回空串。
 */
export function renderRequestNotice(notice: RequestNotice): string {
  if (notice.pending === 0) return ''
  const maxItems = defaultFor<number>('qq.requests.noticeMaxItems')
  const shown = notice.items.slice(0, maxItems)
  const lines = [`【待处理请求】有 ${String(notice.pending)} 条加好友/入群请求等着你决定（好友 ${String(notice.friend)}、群 ${String(notice.group)}）：`]
  for (const item of shown) {
    const who =
      item.kind === 'friend'
        ? `好友申请 来自 ${item.userId}`
        : `${item.subType === 'invite' ? '被邀请入群' : '入群申请'} 群 ${item.groupId ?? '?'} 来自 ${item.userId}`
    lines.push(`- ${who}${item.comment === '' ? '' : `，附言：「${item.comment}」`}（[${item.at}]）`)
  }
  if (notice.pending > shown.length) lines.push(`- …还有 ${String(notice.pending - shown.length)} 条未列出（用 qq_requests 看全部）`)
  lines.push(
    '',
    '要不要接受由你判断。**加好友是有安全含义的动作**：加了之后对方就能直接给你发消息、也会看到你的动态，',
    '陌生人的申请尤其要谨慎（可以先用 `qq_contacts` 看看你已经有哪些好友/群做参照）。',
    '同意/拒绝用 `qq_handle_request`（需要 `flag`，从 `qq_requests` 取）。**不要**凭空构造 flag —— 协议端会拒绝。',
  )
  return lines.join('\n')
}
