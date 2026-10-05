/**
 * 后台「对话」通道（铁律 2 的另一半）。
 *
 * 用户原话："人类发送消息保留到后台的一个区域，是唯一直接向模型发送人类消息的位置。"
 *
 * ## 为什么它必须与 QQ 消息走**不同**的入口
 *
 * 不是因为"能说什么"不同，而是**可信度与审计要求**不同：
 *  - QQ 里的消息来自不可信的外部（要过滤、要防注入、要限流）；
 *  - 后台面板里打字的是**运维本人**（要留痕"谁在什么时候说了什么"，但不该被当噪音过滤）。
 *
 * 所以这里是唯一写 `forlife:admin` 来源的地方，QQ 侧永远只能产生 `forlife:qq`。
 *
 * ## 与唤醒矩阵的关系
 *
 * 后台留言**不走唤醒判定**：面板里有人打字就是在直接跟它说话，
 * 没有"要不要吵醒它"的问题（唤醒矩阵管的是 QQ 侧的自主决定）。
 *
 * @module @forlife/gateway/admin-chat
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

/** 一条后台对话消息。 */
export interface AdminChatMessage {
  readonly id: string
  readonly role: 'human' | 'model'
  readonly actor: string | null
  readonly text: string
  readonly at: string
  readonly handled: number
  readonly turnId: string | null
  readonly error: string | null
}

/** 后台对话的会话键（面板不是 QQ 会话，用独立的 platform 标识）。 */
export const ADMIN_CHAT_KEY = 'panel:admin'

/**
 * 写一条人类消息（**只有后台页面能调**）。
 *
 * @param db - 数据库。
 * @param input - 管理员标识与正文。
 * @returns 新消息 id。
 */
export function postHumanMessage(db: DatabaseSync, input: { readonly actor: string; readonly text: string }): string {
  const id = `adm_${randomUUID()}`
  db.prepare(
    `INSERT INTO admin_chat (id, role, actor, text, at, handled, turn_id, error)
     VALUES (?, 'human', ?, ?, ?, 0, NULL, NULL)`,
  ).run(id, input.actor, input.text, nowIso())
  return id
}

/** 取还没送进模型的人类消息（按时间升序，保证顺序）。 */
export function takePendingHumanMessages(db: DatabaseSync, limit = 10): readonly AdminChatMessage[] {
  return db
    .prepare("SELECT * FROM admin_chat WHERE role = 'human' AND handled = 0 ORDER BY at ASC LIMIT ?")
    .all(limit) as unknown as AdminChatMessage[]
}

/** 标记人类消息已处理（可带失败原因）。 */
export function markHandled(db: DatabaseSync, ids: readonly string[], options: { readonly turnId?: string; readonly error?: string } = {}): void {
  const statement = db.prepare('UPDATE admin_chat SET handled = 1, turn_id = ?, error = ? WHERE id = ?')
  for (const id of ids) statement.run(options.turnId ?? null, options.error ?? null, id)
}

/**
 * 写一条模型的回复。
 *
 * @param db - 数据库。
 * @param input - 回复正文与来源轮次。
 * @returns 新消息 id。
 */
export function appendModelReply(db: DatabaseSync, input: { readonly text: string; readonly turnId?: string; readonly error?: string }): string {
  const id = `adm_${randomUUID()}`
  db.prepare(
    `INSERT INTO admin_chat (id, role, actor, text, at, handled, turn_id, error)
     VALUES (?, 'model', NULL, ?, ?, 1, ?, ?)`,
  ).run(id, input.text, nowIso(), input.turnId ?? null, input.error ?? null)
  return id
}

/** 列最近的后台对话（面板用；按时间升序，便于直接渲染成聊天记录）。 */
export function listAdminChat(db: DatabaseSync, limit = 100): readonly AdminChatMessage[] {
  const rows = db.prepare('SELECT * FROM admin_chat ORDER BY at DESC LIMIT ?').all(limit) as unknown as AdminChatMessage[]
  return [...rows].reverse()
}

/** 未处理的人类消息数（面板红点用）。 */
export function pendingAdminCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM admin_chat WHERE role = 'human' AND handled = 0").get() as { n: number }
  return row.n
}

/**
 * 把一批人类消息拼成给模型的提示词。
 *
 * 明确标注"来自后台面板"，让模型能区分"运维在跟我说话"与"QQ 上有人找我"——
 * 两者的回复去处完全不同（一个回面板，一个回 QQ）。
 *
 * @param messages - 人类消息。
 * @param now - 当前时间。
 * @returns 提示词。
 */
export function buildAdminPrompt(messages: readonly AdminChatMessage[], now = new Date()): string {
  const lines = [
    '【后台对话】以下消息来自后台管理面板（运维本人直接对你说话，不是 QQ 用户）：',
    `时间：${now.toISOString()}（UTC）`,
    '',
  ]
  for (const message of messages) {
    lines.push(`- [${message.at}] ${message.actor ?? '管理员'}：${message.text}`)
  }
  lines.push(
    '',
    '说明：',
    '- 这条消息**不是 QQ 消息**，不要用 qq_reply 回复 —— 你的回答会直接显示在后台面板里。',
    '- 如果这次对话让你改动了什么（记忆、唤醒规则、状态），请在回答里说清楚你改了什么。',
  )
  return lines.join('\n')
}
