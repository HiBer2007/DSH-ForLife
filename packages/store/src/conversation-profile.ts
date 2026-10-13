/**
 * 会话档案：备注（人写）+ AI 画像（模型写）。
 *
 * ## 两条写路径刻意分开
 *
 * - `setConversationNote` —— **只有人能调**（面板）。模型不该有这条路径，
 *   否则它一次自动总结就会覆盖掉用户手写的说明。
 * - `setConversationImpression` —— 模型与人都能调。人改过之后
 *   `impression_source` 变成 `user`，此后模型再写会**保留用户版本**
 *   （见 `writeImpression` 里的判断）。
 *
 * 这个"谁写的"标记是必需的：没有它，模型无法知道"这条画像是我自己猜的，
 * 还是用户亲手纠正过的"，于是会**把用户的纠正覆盖掉**。
 *
 * @module @forlife/store/conversation-profile
 */
import type { DatabaseSync } from 'node:sqlite'

/** 会话档案行。 */
export interface ConversationProfileRow {
  readonly conversation_key: string
  readonly note: string | null
  readonly impression: string | null
  readonly impression_source: string
  readonly updated_by: string
  readonly updated_at: string
}

/** 读一份档案（不存在返回 undefined）。 */
export function getConversationProfile(db: DatabaseSync, conversationKey: string): ConversationProfileRow | undefined {
  return db.prepare('SELECT * FROM conversation_profiles WHERE conversation_key = ?').get(conversationKey) as
    | unknown as ConversationProfileRow | undefined
}

/** 列出全部档案（面板用）。 */
export function listConversationProfiles(db: DatabaseSync, limit = 200): readonly ConversationProfileRow[] {
  return db
    .prepare('SELECT * FROM conversation_profiles ORDER BY updated_at DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, limit))) as unknown as ConversationProfileRow[]
}

/**
 * 写**备注**（用户手写）。
 *
 * 刻意不提供"模型写备注"的入口：备注是用户的权威说明，
 * 模型能写的话，它一次自动总结就会把它覆盖掉，而用户不会收到任何提示。
 */
export function setConversationNote(
  db: DatabaseSync,
  input: { readonly conversationKey: string; readonly note: string | null; readonly updatedBy?: string; readonly now?: Date },
): void {
  const now = (input.now ?? new Date()).toISOString()
  db.prepare(
    `INSERT INTO conversation_profiles (conversation_key, note, impression, impression_source, updated_by, updated_at)
     VALUES (?, ?, NULL, 'model', ?, ?)
     ON CONFLICT(conversation_key) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(input.conversationKey, input.note, input.updatedBy ?? 'user', now)
}

/**
 * 写 **AI 画像**。
 *
 * @param respectUserEdit - 为 `true` 时，若现有画像已被用户改过（`impression_source === 'user'`），
 *   **不覆盖**（返回 `false`）。模型自动更新时应当传 `true`；
 *   用户在面板上手动改时传 `false`（用户的修改当然要生效）。
 * @returns 是否真的写入了。
 */
export function setConversationImpression(
  db: DatabaseSync,
  input: {
    readonly conversationKey: string
    readonly impression: string | null
    readonly source?: 'model' | 'user'
    readonly updatedBy?: string
    readonly respectUserEdit?: boolean
    readonly now?: Date
  },
): boolean {
  const source = input.source ?? 'model'
  const existing = getConversationProfile(db, input.conversationKey)

  if (input.respectUserEdit === true && existing?.impression_source === 'user' && source === 'model') {
    // 用户亲手纠正过 ⇒ 模型不该盖掉它。
    // 不这么做的话，模型下一次自动总结就会把用户的纠正悄悄抹掉，
    // 而用户只会觉得"我改了但它又变回去了"。
    return false
  }

  const now = (input.now ?? new Date()).toISOString()
  db.prepare(
    `INSERT INTO conversation_profiles (conversation_key, note, impression, impression_source, updated_by, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON CONFLICT(conversation_key) DO UPDATE SET
       impression = excluded.impression,
       impression_source = excluded.impression_source,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(input.conversationKey, input.impression, source, input.updatedBy ?? source, now)
  return true
}

/**
 * 组装成给模型看的画像文本。
 *
 * 备注**排在画像前面**，因为备注是用户说的（权威），画像是模型猜的。
 * 顺序本身就在告诉模型该信哪个 —— 比在提示词里写一句"以备注为准"更可靠，
 * 因为它不依赖模型记得住那句话。
 */
export function renderProfileForPrompt(profile: ConversationProfileRow | undefined): string {
  if (profile === undefined) return ''
  const parts: string[] = []
  if (profile.note !== null && profile.note.trim() !== '') parts.push(`主人对这里的说明：${profile.note.trim()}`)
  if (profile.impression !== null && profile.impression.trim() !== '') {
    const label = profile.impression_source === 'user' ? '画像（主人修正过）' : '画像（你自己总结的，可能有误）'
    parts.push(`${label}：${profile.impression.trim()}`)
  }
  return parts.join('\n')
}
