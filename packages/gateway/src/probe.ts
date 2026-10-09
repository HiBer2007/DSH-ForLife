/**
 * **跨进程只读查询**的接缝（`probe`）。
 *
 * ## 为什么需要它（这是拓扑决定的，不是设计偏好）
 *
 * 工具在 **DSH 进程**里执行，而 QQ 连接在**网关进程**里（见 `outbox.ts` 的模块头）。
 * 于是"发"很容易 —— 写一行 `qq_outbox` 让网关去发就行；
 * 但"**读**"（`get_forward_msg` / `get_friend_list` / `get_group_list` /
 * `get_group_member_list`）需要**把结果拿回来**，而 `qq_outbox` 是**单向**的。
 *
 * ## 做法：复用同一个接缝，把结果放在 `forlife_state` 里
 *
 * ```
 * 工具 → enqueue(kind='probe', payload={action,args}) → 轮询等确认
 * 网关 → 执行 transport 上对应的方法 → 结果写 forlife_state[q<id>] → 标记 sent
 * 工具 → 读到结果 → 清掉那个键
 * ```
 *
 * **为什么结果不放新列**：`qq_outbox` 加一列要迁移（本轮有三个改动共享迁移文件，
 * 能不加就不加）；而 `forlife_state` 本来就是"随进程共享的键值"。
 * 键**用完即清**（`clearProbeResult`），所以它不会随查询次数无限增长。
 *
 * ## ⚠️ 这里**不是**第二条发送路径
 *
 * 这个模块**只做只读查询**，而且 action 名是**白名单枚举**（不是任意字符串）——
 * 想加一个查询必须在这里加一项，不可能拿着它去调 `send_packet` 之类的危险动作
 * （`onebot.ts` 的模块头写着"不实现 send_packet / 凭据类动作"的红线）。
 *
 * @module @forlife/gateway/probe
 */
import type { DatabaseSync } from 'node:sqlite'

import { deleteState, getState, setState } from '@forlife/store'

import type { ForwardContent, FriendBrief, GroupBrief, GroupMemberBrief, QqTransport } from './transport.ts'

/** 允许的只读查询（**白名单**：想加必须在这里加一项）。 */
export const PROBE_ACTIONS = ['get_forward_msg', 'get_friend_list', 'get_group_list', 'get_group_member_list'] as const

/** 一个查询动作。 */
export type ProbeAction = (typeof PROBE_ACTIONS)[number]

/** 是不是允许的查询动作。 */
export function isProbeAction(value: unknown): value is ProbeAction {
  return typeof value === 'string' && (PROBE_ACTIONS as readonly string[]).includes(value)
}

/** 查询结果（写进 `forlife_state` 的形状）。 */
export interface ProbeResult {
  readonly ok: boolean
  /** 成功时的载荷（各 action 形状自定）。 */
  readonly data?: unknown
  readonly error?: string
}

/** 结果在 `forlife_state` 里的键（按 outbox 行 id 唯一）。 */
export function probeStateKey(outboxId: string): string {
  return `qq_probe:${outboxId}`
}

/**
 * 执行一个查询（**网关侧**调用）。
 *
 * @param transport - 传输层。
 * @param action - 白名单里的动作。
 * @param args - 参数。
 * @returns 结果；参数不合法或传输层返回 undefined 时 `ok: false`（**不抛** —— 抛出去会变成 500）。
 */
export async function runProbe(
  transport: QqTransport,
  action: ProbeAction,
  args: Record<string, unknown>,
): Promise<ProbeResult> {
  const str = (key: string): string | undefined => {
    const value = args[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  switch (action) {
    case 'get_forward_msg': {
      const messageId = str('message_id')
      if (messageId === undefined) return { ok: false, error: 'get_forward_msg 需要 message_id' }
      const content: ForwardContent | undefined = await transport.getForward(messageId)
      if (content === undefined) return { ok: false, error: `取合并转发失败（message_id=${messageId}）：协议端没返回内容，或该消息已过期` }
      return { ok: true, data: content }
    }
    case 'get_friend_list': {
      const friends: readonly FriendBrief[] | undefined = await transport.listFriends()
      if (friends === undefined) return { ok: false, error: '取好友列表失败（协议端未返回，或 QQ 端未连接）' }
      return { ok: true, data: friends }
    }
    case 'get_group_list': {
      const groups: readonly GroupBrief[] | undefined = await transport.listGroups()
      if (groups === undefined) return { ok: false, error: '取群列表失败（协议端未返回，或 QQ 端未连接）' }
      return { ok: true, data: groups }
    }
    case 'get_group_member_list': {
      const groupId = str('group_id')
      if (groupId === undefined) return { ok: false, error: 'get_group_member_list 需要 group_id' }
      const members: readonly GroupMemberBrief[] | undefined = await transport.listGroupMembers(groupId)
      if (members === undefined) return { ok: false, error: `取群 ${groupId} 的成员列表失败（协议端未返回，或机器人不在该群）` }
      return { ok: true, data: members }
    }
  }
}

/** 写查询结果（**网关侧**调用）。 */
export function writeProbeResult(db: DatabaseSync, outboxId: string, result: ProbeResult): void {
  setState(db, probeStateKey(outboxId), JSON.stringify(result))
}

/**
 * 读查询结果（**工具侧**调用）。
 *
 * @param db - 数据库。
 * @param outboxId - 队列行 id。
 * @returns 结果；还没写时为 `undefined`。
 */
export function readProbeResult(db: DatabaseSync, outboxId: string): ProbeResult | undefined {
  const raw = getState(db, probeStateKey(outboxId))
  if (raw === undefined || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as ProbeResult
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 清掉结果键（**工具侧读完就调**）。
 *
 * 为什么必须清：`forlife_state` 是**一张没有过期机制的表**，
 * 每次查询留一行会让它随查询次数无限长 —— 那是另一种漏水。
 *
 * ★ 审计 §10.8：以前这里是 `setState(key, '')`（**留一个空串行**），
 * 于是一万次查询就在表里留一万行垃圾（`readProbeResult` 靠"空串当没写"躲过去，
 * 但表本身不再能回答"现在有多少状态"）。现在**真的删行**。
 *
 * @param db - 数据库。
 * @param outboxId - 队列行 id。
 */
export function clearProbeResult(db: DatabaseSync, outboxId: string): void {
  deleteState(db, probeStateKey(outboxId))
}
