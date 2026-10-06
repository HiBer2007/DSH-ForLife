/**
 * 提示词版本管理（原在 `dsh-component`，2026-10-06 下沉到 store）。
 *
 * 为什么下沉：网关（独立进程、部署目标是一个 Docker 容器）也要能编辑提示词，
 * 而它**不能依赖插件** —— 插件的 HTTP 接口只在 DSH 宿主跑着插件时才存在。
 * 放在 store 之后，插件与网关共用同一份，不会分叉。
 *
 * 原文件保留再导出，既有 import 不用改。
 *
 * @module @forlife/store/prompt-store
 *
 * 原注释：
 * 提示词存储：版本、生效、回滚、按会话覆盖。
 *
 * ## 为什么提示词要版本化
 *
 * 它是**影响模型行为最直接的东西**（比记忆改动影响更大）：改一句人设，语气就变了。
 * 而"可编辑"如果没有"可回滚"，等于给了用户一个可能再也回不去的开关。
 *
 * ## 默认值从哪来
 *
 * 首次启动时把内置默认文本写成第 1 版（`created_by: 'system'`）。
 * 这样用户在后台看到的不是空白框，而是**当前真正生效的内容** ——
 * "编辑"的前提是"看得见现在是什么"。
 *
 * @module forlife-memory/prompt-store
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { estimatePromptTokens, hashPromptText, normalizePromptText, validatePromptText } from './prompt-text.ts'
import { nowIso } from './repository.ts'

/** 提示词槽位。 */
export type PromptSlug = 'p1-system' | 'p2-style'

/** 全部槽位。 */
export const PROMPT_SLUGS: readonly PromptSlug[] = ['p1-system', 'p2-style']

/** 一版提示词。 */
export interface PromptRevision {
  readonly id: string
  readonly slug: PromptSlug
  readonly text: string
  readonly sha256: string
  readonly tokenCount: number
  readonly variables: readonly string[]
  readonly note: string | null
  readonly createdBy: string
  readonly createdAt: string
  readonly active: boolean
}

/** 保存结果。 */
export type SavePromptResult =
  | { readonly ok: true; readonly revision: PromptRevision; readonly changed: boolean }
  | { readonly ok: false; readonly errors: readonly string[] }

/** 行 → 对象。 */
function toRevision(row: Record<string, unknown>): PromptRevision {
  return {
    id: String(row['id']),
    slug: String(row['slug']) as PromptSlug,
    text: String(row['text']),
    sha256: String(row['sha256']),
    tokenCount: Number(row['token_count']),
    variables: JSON.parse(String(row['variables'])) as string[],
    note: row['note'] === null ? null : String(row['note']),
    createdBy: String(row['created_by']),
    createdAt: String(row['created_at']),
    active: Number(row['active']) === 1,
  }
}

/** 当前生效的一版。 */
export function activePrompt(db: DatabaseSync, slug: PromptSlug): PromptRevision | undefined {
  const row = db.prepare('SELECT * FROM prompt_revisions WHERE slug = ? AND active = 1').get(slug) as
    | Record<string, unknown>
    | undefined
  return row === undefined ? undefined : toRevision(row)
}

/** 历史版本（新的在前）。 */
export function listPromptRevisions(db: DatabaseSync, slug: PromptSlug, limit = 30): readonly PromptRevision[] {
  const rows = db
    .prepare('SELECT * FROM prompt_revisions WHERE slug = ? ORDER BY created_at DESC LIMIT ?')
    .all(slug, limit) as unknown as Record<string, unknown>[]
  return rows.map(toRevision)
}

/** 按 id 取一版。 */
export function promptRevisionById(db: DatabaseSync, id: string): PromptRevision | undefined {
  const row = db.prepare('SELECT * FROM prompt_revisions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row === undefined ? undefined : toRevision(row)
}

/**
 * 保存一版提示词并使其生效。
 *
 * **保存前必须过校验与试渲染**：未知变量会让整个提示词装配失败，
 * 那种错误一旦生效，模型下一轮就没有系统提示词了。
 *
 * @param db - 数据库。
 * @param input - 槽位、文本、作者与备注。
 * @returns 保存结果（校验失败时 `ok:false`，不写库）。
 */
export function savePromptRevision(
  db: DatabaseSync,
  input: { readonly slug: PromptSlug; readonly text: string; readonly createdBy?: string; readonly note?: string },
): SavePromptResult {
  const validation = validatePromptText(input.text, { scope: 'prefix' })
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const text = normalizePromptText(input.text)
  const sha256 = hashPromptText(text)
  const current = activePrompt(db, input.slug)

  // 内容没变就别造新版本（否则历史列表会被"多点了几次保存"淹没）
  if (current !== undefined && current.sha256 === sha256) {
    return { ok: true, revision: current, changed: false }
  }

  const id = `pr_${randomUUID()}`
  const at = nowIso()
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE prompt_revisions SET active = 0 WHERE slug = ? AND active = 1').run(input.slug)
    db.prepare(
      `INSERT INTO prompt_revisions (id, slug, text, sha256, token_count, variables, note, created_by, created_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      input.slug,
      text,
      sha256,
      estimatePromptTokens(text),
      JSON.stringify(validation.variables),
      input.note ?? null,
      input.createdBy ?? 'admin',
      at,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const saved = promptRevisionById(db, id)
  if (saved === undefined) throw new Error('写入后读不到提示词版本')
  return { ok: true, revision: saved, changed: true }
}

/**
 * 回滚到某一版（本质是把它重新置为生效，**不改历史**）。
 *
 * 为什么不复制成新版本：历史是事实记录。回滚产生的"新版本"会让
 * "这版到底改了什么"变得难以回答。用 active 标记就够，且哈希能直接对回去。
 *
 * @param db - 数据库。
 * @param id - 目标版本 id。
 * @returns 回滚后的版本，或 undefined（版本不存在）。
 */
export function rollbackPrompt(db: DatabaseSync, id: string): PromptRevision | undefined {
  const target = promptRevisionById(db, id)
  if (target === undefined) return undefined
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE prompt_revisions SET active = 0 WHERE slug = ?').run(target.slug)
    db.prepare('UPDATE prompt_revisions SET active = 1 WHERE id = ?').run(id)
    // 覆盖里指向被回滚掉的版本的引用也要清掉，否则会指向一个非 active 的旧版
    db.prepare('DELETE FROM prompt_overrides WHERE slug = ? AND revision_id NOT IN (SELECT id FROM prompt_revisions WHERE active = 1)').run(
      target.slug,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return promptRevisionById(db, id)
}

// ── 按会话覆盖（P2）────────────────────────────────────────────────────────

/**
 * 覆盖某会话的 P2 风格。
 *
 * **重要取舍**：覆盖值**不进稳定前缀**，而是作为尾部注入（P3）。
 * 理由：一个模型窗口同时服务多个会话（§2.17.1），
 * 如果 P2 按会话写进前缀，那么每换一个会话前缀就变一次 ⇒ 前缀缓存全废，
 * 而阶段 4 的全部努力就是为了让前缀稳定。尾部注入既满足"按会话覆盖只影响该会话"，
 * 又不破坏缓存。
 *
 * @param db - 数据库。
 * @param input - 作用域、槽位（目前只允许 p2-style）、版本与作者。
 * @returns 是否写入。
 */
export function setPromptOverride(
  db: DatabaseSync,
  input: { readonly scope: string; readonly slug: PromptSlug; readonly revisionId: string; readonly createdBy?: string },
): boolean {
  if (input.slug !== 'p2-style') {
    // P1 是全局人设：按会话分裂它会让"它是谁"随会话漂移，那不是我们想要的
    throw new Error('只允许按会话覆盖回答风格（p2-style）；系统提示词是全局人设，不应按会话分裂')
  }
  const revision = promptRevisionById(db, input.revisionId)
  if (revision === undefined || revision.slug !== input.slug) return false
  db.prepare(
    `INSERT INTO prompt_overrides (scope, slug, revision_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, slug) DO UPDATE SET revision_id = excluded.revision_id, created_by = excluded.created_by, created_at = excluded.created_at`,
  ).run(input.scope, input.slug, input.revisionId, input.createdBy ?? 'admin', nowIso())
  return true
}

/** 删除会话覆盖（回到全局）。 */
export function clearPromptOverride(db: DatabaseSync, scope: string, slug: PromptSlug = 'p2-style'): boolean {
  return Number(db.prepare('DELETE FROM prompt_overrides WHERE scope = ? AND slug = ?').run(scope, slug).changes) > 0
}

/** 列出全部覆盖。 */
export function listPromptOverrides(db: DatabaseSync, scope?: string): readonly { scope: string; slug: PromptSlug; revision: PromptRevision }[] {
  const rows = (
    scope === undefined
      ? db.prepare('SELECT * FROM prompt_overrides ORDER BY scope').all()
      : db.prepare('SELECT * FROM prompt_overrides WHERE scope = ?').all(scope)
  ) as unknown as Record<string, unknown>[]
  const out: { scope: string; slug: PromptSlug; revision: PromptRevision }[] = []
  for (const row of rows) {
    const revision = promptRevisionById(db, String(row['revision_id']))
    if (revision !== undefined) out.push({ scope: String(row['scope']), slug: String(row['slug']) as PromptSlug, revision })
  }
  return out
}

/**
 * 解析某会话最终该用的提示词。
 *
 * @param db - 数据库。
 * @param slug - 槽位。
 * @param scope - 会话作用域（`group:88888` 这类）；不给则用全局。
 * @returns 生效文本（含来源，便于面板解释"为什么它现在是这个语气"）。
 */
export function resolvePrompt(
  db: DatabaseSync,
  slug: PromptSlug,
  scope?: string,
): { readonly text: string; readonly source: 'global' | 'override'; readonly revision?: PromptRevision } | undefined {
  if (scope !== undefined && slug === 'p2-style') {
    const row = db
      .prepare('SELECT * FROM prompt_overrides WHERE scope = ? AND slug = ?')
      .get(scope, slug) as Record<string, unknown> | undefined
    if (row !== undefined) {
      const revision = promptRevisionById(db, String(row['revision_id']))
      if (revision !== undefined) return { text: revision.text, source: 'override', revision }
    }
  }
  const global = activePrompt(db, slug)
  return global === undefined ? undefined : { text: global.text, source: 'global', revision: global }
}

// ── 默认值播种 ─────────────────────────────────────────────────────────────

/**
 * 播种默认提示词（幂等：已有 active 版本就不动）。
 *
 * @param db - 数据库。
 * @returns 本次播种了哪些槽位。
 */
export function seedDefaultPrompts(db: DatabaseSync): readonly PromptSlug[] {
  const seeded: PromptSlug[] = []
  for (const slug of PROMPT_SLUGS) {
    if (activePrompt(db, slug) !== undefined) continue
    const text = defaultFor<string>(slug === 'p1-system' ? 'prompt.p1Default' : 'prompt.p2Default')
    const result = savePromptRevision(db, { slug, text, createdBy: 'system', note: '内置默认值（首次启动播种）' })
    if (!result.ok) {
      // 默认值校验都过不了，那是我们自己的 bug —— 必须炸，不能静默留空
      throw new Error(`内置默认提示词 ${slug} 未通过校验：${result.errors.join('；')}`)
    }
    seeded.push(slug)
  }
  return seeded
}

/**
 * 提示词编辑次数（用于验收："未命中次数 == 压缩次数 + 提示词编辑次数"）。
 *
 * @param db - 数据库。
 * @returns 真正产生新版本的编辑次数。
 */
export function promptEditCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM prompt_revisions WHERE created_by != 'system'").get() as { n: number }
  return row.n
}

/** 全部槽位的当前状态（面板概览用）。 */
export function promptStatus(db: DatabaseSync): readonly {
  slug: PromptSlug
  /** **当前生效的文本**：面板的编辑器要靠它填进去（第一版没给，界面上就是四个空框）。 */
  text: string
  sha256: string
  tokenCount: number
  variables: readonly string[]
  updatedAt: string
  updatedBy: string
  revisions: number
}[] {
  return PROMPT_SLUGS.map((slug) => {
    const active = activePrompt(db, slug)
    const count = db.prepare('SELECT count(*) AS n FROM prompt_revisions WHERE slug = ?').get(slug) as { n: number }
    return {
      slug,
      text: active?.text ?? '',
      sha256: active?.sha256 ?? '',
      tokenCount: active?.tokenCount ?? 0,
      variables: active?.variables ?? [],
      updatedAt: active?.createdAt ?? '',
      updatedBy: active?.createdBy ?? '',
      revisions: count.n,
    }
  })
}
