/**
 * 投喂**游标** —— 「哪些已经投喂、哪些暂未投喂」（用户 2026-10-10 指定）。
 *
 * ## 用户的原话
 *
 * > 「关于**半途而废**，我的意见是给我们的输入资料打上**哪些已经投喂哪些暂未投喂**，
 * >   以支持**断点续传**」
 *
 * ## ★ 先说清它的定位：它是**提示**，不是**正确性机制**
 *
 * 这一点必须写在最前面，否则后来的人会以为"游标丢了 = 会重复投喂 = 数据坏了"。
 *
 * **重复投喂是无害的**：`feedMemory` 的 id 是 `feed_<来源>_<序号>` 派生的，
 * 同一个来源的同一个序号再喂一次是**更新**（幂等），不是又记一遍
 * （见 `feed.ts` 里 `deriveFeedSource` 与同源覆盖那一段）。
 *
 * ⇒ 游标的作用是「**别白干一遍**」，而不是「防止写坏」。所以：
 * **游标坏了/丢了 ⇒ 当成"没有游标" ⇒ 从头喂一遍 ⇒ 结果正确，只是慢。**
 * 这条取舍换来的是：读取路径**永不抛异常**（它会在投喂流程与面板上被调），
 * 与 `readFeedSession` 同一条纪律。
 *
 * ## 为什么用 `forlife_state`，**不加表**
 *
 * `forlife_state` 就是本仓的 key/value 表（`render_revision` / `compaction_epoch` /
 * `feed_session` 都住那儿）。加一张"游标表"要动迁移、要写 DDL、要处理旧库 ——
 * 而游标的数据形状就是"(来源) → (一个数 + 时间)"，kv 正好。
 *
 * ## 为什么**每个来源一个键**，而不是像 `feed_session` 那样一行覆盖
 *
 * `feed_session` 是"**现在**在消化记忆"，它是**瞬时**的，所以一行覆盖是对的
 * （那条取舍它自己的模块头里写了）。**游标相反：它的全部意义就是活过会话结束**
 * —— 半途而废之后要能**下次接着喂**。一行覆盖会让"上次喂到哪"随下一次投喂被抹掉。
 *
 * 键名形如 `feed_cursor:<来源>`。目录投喂时每个文件是一个来源 ⇒ 会有一批键。
 * 每个键的值就是一个小 JSON，**没有单独建表的必要**。
 *
 * @module @forlife/gateway/feed-cursor
 */
import type { DatabaseSync } from 'node:sqlite'

/** `forlife_state` 里键名的前缀（用常量而不是裸字符串：拼错会静默失效）。 */
export const FEED_CURSOR_PREFIX = 'feed_cursor:'

/** 一个来源喂到哪了。 */
export interface FeedCursor {
  /** 已投喂**到**第几段（含）。`0` = 一段都没喂；`undefined` = 没有游标记录。 */
  readonly fedThrough: number
  /** 这份资料的**总段数**（写游标的人知道；不知道就不记 —— 见了下面的 `total`）。 */
  readonly total?: number
  readonly updatedAt: string
}

/** 键名（导出是为了让测试与面板**用同一份拼法**，而不是各自拼字符串）。 */
export function feedCursorKey(source: string): string {
  return FEED_CURSOR_PREFIX + source
}

/**
 * 写一个来源的游标。
 *
 * ⚠️ `fedThrough` 必须**单调不减**：一次投喂被中途打断后，可能有一个更旧的
 * 批次的收尾动作后到；若允许回退，游标就会往后退，于是下次**重喂已喂过的部分**。
 * （那不致命 —— 幂等 —— 但白干。这条在 {@link advanceFeedCursor} 里保证。）
 */
export function writeFeedCursor(
  db: DatabaseSync,
  source: string,
  cursor: { readonly fedThrough: number; readonly total?: number | undefined; readonly now?: Date },
): void {
  const value: Record<string, unknown> = {
    fedThrough: Math.max(0, Math.trunc(cursor.fedThrough)),
    updatedAt: (cursor.now ?? new Date()).toISOString(),
  }
  if (cursor.total !== undefined) value['total'] = Math.max(0, Math.trunc(cursor.total))
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(feedCursorKey(source), JSON.stringify(value))
}

/**
 * 推进一步 —— **只许往前**（见 {@link writeFeedCursor} 的说明）。
 *
 * @returns 推进之后的游标（调用方可以直接拿去渲染"已喂 N/M 段"）。
 */
export function advanceFeedCursor(
  db: DatabaseSync,
  source: string,
  input: { readonly fedThrough: number; readonly total?: number | undefined; readonly now?: Date },
): FeedCursor {
  const previous = readFeedCursor(db, source)
  const next = Math.max(previous?.fedThrough ?? 0, Math.trunc(input.fedThrough))
  // 总段数：本次没给就沿用上一次的（投喂中途才知道总数的情形很常见）
  const total = input.total ?? previous?.total
  writeFeedCursor(db, source, {
    fedThrough: next,
    // ⚠️ 条件展开而不是直接写 `total`/`now`：本仓开了 `exactOptionalPropertyTypes`，
    //    显式传 `undefined` 与"不传这个字段"是**两种类型**（前者不合法）。
    ...(total === undefined ? {} : { total }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return (
    readFeedCursor(db, source) ?? { fedThrough: next, updatedAt: (input.now ?? new Date()).toISOString() }
  )
}

/**
 * 读一个来源的游标。
 *
 * **任何异常路径都返回 `undefined`**（缺键 / 坏 JSON / 字段不全）：
 * 与 `readFeedSession` 同一条纪律 —— 这个函数会在投喂流程与面板上被调，
 * 而"少一条提示"是小事、"因为一条坏记录把投喂搞崩"是大事。
 *
 * ★ 注意：**没有陈旧判定**（与 `feed_session` 的关键区别）。
 *   游标本来就是要长期留着的；"太旧就当没有"会让断点续传**永远失效**。
 */
export function readFeedCursor(db: DatabaseSync, source: string): FeedCursor | undefined {
  let raw: string | undefined
  try {
    const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(feedCursorKey(source)) as
      | { value?: string }
      | undefined
    raw = row?.value
  } catch {
    return undefined
  }
  return parseCursor(raw)
}

/** 坏数据当没有（抽出来是为了 `listFeedCursors` 与 `readFeedCursor` 共用一份判定）。 */
function parseCursor(raw: string | undefined): FeedCursor | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const fedThrough = record['fedThrough']
  const updatedAt = typeof record['updatedAt'] === 'string' ? record['updatedAt'] : ''
  if (typeof fedThrough !== 'number' || !Number.isFinite(fedThrough) || fedThrough < 0) return undefined
  if (updatedAt === '') return undefined
  const total = record['total']
  return {
    fedThrough: Math.trunc(fedThrough),
    updatedAt,
    ...(typeof total === 'number' && Number.isFinite(total) && total >= 0 ? { total: Math.trunc(total) } : {}),
  }
}

/**
 * 列出**所有**游标 —— 面板要能回答用户那句"**哪些已经投喂哪些暂未投喂**"。
 *
 * 返回 `来源 → 游标`。坏记录**跳过而不是让整张表读不出来**
 * （一条坏数据不该让面板上看不到其余 282 个来源的进度）。
 */
export function listFeedCursors(db: DatabaseSync): readonly { readonly source: string; readonly cursor: FeedCursor }[] {
  let rows: readonly { key?: string; value?: string }[] = []
  try {
    rows = db
      .prepare('SELECT key, value FROM forlife_state WHERE key LIKE ? ORDER BY key')
      .all(`${FEED_CURSOR_PREFIX}%`) as readonly { key?: string; value?: string }[]
  } catch {
    return []
  }
  const out: { source: string; cursor: FeedCursor }[] = []
  for (const row of rows) {
    const key = row.key ?? ''
    if (!key.startsWith(FEED_CURSOR_PREFIX)) continue
    const cursor = parseCursor(row.value)
    if (cursor === undefined) continue
    out.push({ source: key.slice(FEED_CURSOR_PREFIX.length), cursor })
  }
  return out
}

/**
 * 清掉一个来源的游标（**"重喂一遍"用**）。
 *
 * 不提供"清全部"：那会是一个**破坏性**操作，而它该由明确的"清空记忆再重导"
 * （P3）来承担，不该藏在一个游标工具里。
 */
export function clearFeedCursor(db: DatabaseSync, source: string): void {
  db.prepare('DELETE FROM forlife_state WHERE key = ?').run(feedCursorKey(source))
}
