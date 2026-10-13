/**
 * 「提示词」与「路由与端点」两个板块的只读查询。
 *
 * 定位：这批函数是**管理后台的取数层**，只做三件事 —— 读 SQLite、把行整成面板要的形状、
 * 算几个统计数字。它不写库、不鉴权、不缓存（鉴权与 HTTP 在 `admin/api.ts` 那一层）。
 *
 * ## 三条贯穿全文件的取舍
 *
 * 1. **JSON 列解析失败返回空数组，绝不抛。**
 *    `inference_endpoints.models` 这类列不由数据库约束保证形状：它可能来自我们自己的写入、
 *    更早的版本、或一次手工 SQL。面板恰恰是**排障的地方** —— 如果一条脏 JSON 能让整个
 *    路由面板 500，用户就在最需要看面板的时候看不到它。宁可显示"这个端点没有模型"
 *    （明显的坏味道，会有人去查），也不要整块版面炸掉。
 *
 * 2. **NULL ≠ false / 0 / ''。**
 *    最典型的是 `inference_endpoints.health_ok IS NULL`：它的意思是"**从未探测过**"，
 *    不是"不健康"。把没测过的端点画成红色，会让人去修一个可能根本没坏的东西 ——
 *    所以这类字段在有 NULL 时**整个键缺席**，界面显示"—"，而不是显示一个假值。
 *
 * 3. **不猜列名。** 所有列名以 `packages/store/src/migrations.ts` 的建表语句为准
 *    （`prompt_revisions` / `prompt_overrides` / `model_routes` / `inference_endpoints` /
 *    `routing_log` / `uncertain_cases`），并已用运行库的 `PRAGMA table_info` 复核过。
 *
 * @module @forlife/gateway/admin/queries-model
 */
import type { DatabaseSync } from 'node:sqlite'

// ── 提示词板块 ─────────────────────────────────────────────────────────────

/** 一个槽位的当前状态（面板上的槽位卡）。 */
export interface PromptSlotOverview {
  readonly slug: string
  /** 生效版本 id；**没有生效版本时整个键缺席**（面板据此显示"未设置"，而不是空字符串）。 */
  readonly activeRevisionId?: string
  readonly tokenCount: number
  readonly sha256: string
  /**
   * **生效版本的创建时间**。
   *
   * 注意语义边界：`prompt_revisions` 没有 `activated_at` 列，所以这里给的是这一版**写出来**的时间。
   * 回滚（把旧版本重新置为 active）**不会**让它变新 —— 想看"最近发生过什么"要看 `revisions` 列表。
   */
  readonly updatedAt?: string
  /** 该 slug 的历史版本总数（**不受 `revisionLimit` 影响**）。 */
  readonly revisionCount: number
  /** 生效文本的前 300 字符（没有生效版本时是空串）。 */
  readonly textPreview: string
}

/** 一版历史提示词。 */
export interface PromptRevisionOverview {
  readonly id: string
  readonly slug: string
  readonly tokenCount: number
  readonly createdBy: string
  readonly createdAt: string
  readonly active: boolean
  readonly note?: string
  readonly variables: readonly string[]
}

/** 一条按会话覆盖。 */
export interface PromptOverrideOverview {
  readonly scope: string
  readonly slug: string
  readonly revisionId: string
  readonly createdBy: string
  readonly createdAt: string
}

/** 「提示词」板块的完整载荷。 */
export interface PromptsOverview {
  readonly slots: readonly PromptSlotOverview[]
  readonly revisions: readonly PromptRevisionOverview[]
  readonly overrides: readonly PromptOverrideOverview[]
  readonly stats: {
    readonly slots: number
    readonly revisions: number
    readonly overrides: number
    /** 生效版本（active）的 token 之和。 */
    readonly totalTokens: number
  }
}

/**
 * 已知槽位：**库里一条都没有时也必须出现在面板上**。
 *
 * 与 `dsh-component/prompt-store.ts` 的 `PROMPT_SLUGS` 同一个事实，但这里**故意不 import 它**
 * （gateway 不该依赖 DSH 组件包），改成"已知槽位 ∪ 库里出现过的 slug"：
 * 将来加了 P3，或有人手工插了一个新 slug，面板也不会把它藏起来。
 */
const KNOWN_PROMPT_SLUGS: readonly string[] = ['p1-system', 'p2-style']

/** 文本预览的截断长度。 */
const TEXT_PREVIEW_LIMIT = 300

/** 历史版本的默认条数。 */
const DEFAULT_REVISION_LIMIT = 40

/** 路由日志的默认条数。 */
const DEFAULT_LOG_LIMIT = 50

/** 不确定案例的固定条数（它只用来"定期复盘"，不是给人翻页的）。 */
const UNCERTAIN_LIMIT = 30

/**
 * 条数上限的兜底：面板是**一次性取回再渲染**的，没有分页，
 * 所以不设上限等于允许一次把整张表读进内存（表会一直长）。
 *
 * `0` 是合法输入（调用方明确表示"这次不要列表"）；负数/NaN 是**非法**输入，
 * 回落到默认值 —— 负数如果按"夹到 0"处理，一个算错的参数就会让面板安静地显示"没有数据"，
 * 那比报错难查得多。超过上限则夹到上限（这时候语义是明确的，只是量太大）。
 */
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) return fallback
  return Math.min(max, Math.floor(limit))
}

/** NULL → undefined。收窄成局部变量后再决定要不要放进对象，是 `exactOptionalPropertyTypes` 的写法要求。 */
function optionalText(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value
}

/** SQLite 的 0/1 → boolean；NULL 保持 undefined（"没记录"与"否"不是一回事）。 */
function optionalFlag(value: number | bigint | null | undefined): boolean | undefined {
  if (value === null || value === undefined) return undefined
  return Number(value) === 1
}

/** INTEGER 列 → number；NULL 保持 undefined。 */
function optionalNumber(value: number | bigint | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'bigint' ? Number(value) : value
}

/** `SELECT count(*) AS n ...` 的单值。 */
function countOf(db: DatabaseSync, sql: string, ...params: readonly (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n?: number | bigint | null } | undefined
  return optionalNumber(row?.n) ?? 0
}

/**
 * 解析 JSON 数组列（`variables` 这类），坏数据返回 `[]`。
 *
 * 只保留字符串元素：面板要把它当标签逐个渲染，混进数字/对象只会在渲染层炸掉。
 */
function parseStringArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 取舍见文件头第 1 条：脏数据只让这一格变空，不能连累整个面板
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

/**
 * 解析 `inference_endpoints.models`，**两种形态都要认**：
 *
 *  - 对象数组：`[{"id":"qwen","image":true,"contextLength":32000}]`（`store/endpoints.ts` 的正式写法）；
 *  - 字符串数组：`["qwen","bge-m3"]`（探测日志、手工 SQL、早期数据里出现过）。
 *
 * 两种形态混着、或夹杂数字/null/缺 `id` 的对象，都只跳过那一项而不是整列报废 ——
 * 一个端点里有一个坏元素，不该让另外几个正常模型消失。
 *
 * 只取 `id`：面板这一格只用来显示"这个端点有哪些模型"。
 *
 * @param raw - `models` 列的原始文本。
 * @returns 归一化后的模型列表（任何异常情况都给 `[]`，**不抛**）。
 */
function parseModelList(raw: string | null | undefined): { id: string }[] {
  if (raw === null || raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  // `{}` / `"abc"` / `42` 都能被 JSON.parse 成功解析，但它们不是列表
  if (!Array.isArray(parsed)) return []

  const out: { id: string }[] = []
  for (const item of parsed) {
    if (typeof item === 'string') {
      if (item !== '') out.push({ id: item })
      continue
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = (item as Record<string, unknown>)['id']
    if (typeof id === 'string' && id !== '') out.push({ id })
  }
  return out
}

/** 截断预览：**严格 300 字符封顶**，不追加省略号 —— 长度本身要可预测（前端按它算行数）。 */
function textPreview(text: string): string {
  return text.length > TEXT_PREVIEW_LIMIT ? text.slice(0, TEXT_PREVIEW_LIMIT) : text
}

/** `prompt_revisions` 里生效的那一行的部分列。 */
interface ActivePromptRow {
  readonly slug: string
  readonly id: string
  readonly text: string
  readonly sha256: string
  readonly token_count: number
  readonly created_at: string
}

/** `prompt_revisions` 的历史行。 */
interface PromptRevisionRow {
  readonly id: string
  readonly slug: string
  readonly token_count: number
  readonly note: string | null
  readonly created_by: string
  readonly created_at: string
  readonly active: number
  readonly variables: string
}

/** `prompt_overrides` 的行。 */
interface PromptOverrideRow {
  readonly scope: string
  readonly slug: string
  readonly revision_id: string
  readonly created_by: string
  readonly created_at: string
}

/**
 * 「提示词」板块。
 *
 * @param db - 数据库（由调用方负责打开与鉴权）。
 * @param options - `revisionLimit`：历史版本条数，默认 40，上限 500。
 * @returns 槽位、历史版本、覆盖与统计。
 */
export function queryPrompts(db: DatabaseSync, options: { readonly revisionLimit?: number } = {}): PromptsOverview {
  const revisionLimit = clampLimit(options.revisionLimit, DEFAULT_REVISION_LIMIT, 500)

  // 每个 slug 至多一行 active（迁移 0009 的部分唯一索引保证），但仍用 Map 收集：
  // 万一有人手工把索引删了，这里也只会"取到其中一条"，而不是抛异常把面板打挂。
  const activeRows = db
    .prepare('SELECT slug, id, text, sha256, token_count, created_at FROM prompt_revisions WHERE active = 1')
    .all() as unknown as ActivePromptRow[]
  const activeBySlug = new Map<string, ActivePromptRow>()
  for (const row of activeRows) activeBySlug.set(row.slug, row)

  const countRows = db.prepare('SELECT slug, count(*) AS n FROM prompt_revisions GROUP BY slug').all() as unknown as {
    slug: string
    n: number
  }[]
  const revisionCountBySlug = new Map<string, number>()
  for (const row of countRows) revisionCountBySlug.set(row.slug, Number(row.n))

  const overrideSlugRows = db.prepare('SELECT DISTINCT slug FROM prompt_overrides').all() as unknown as { slug: string }[]

  // 槽位集合 = 已知槽位 ∪ 库里出现过的 slug ∪ 覆盖里引用到的 slug。
  // 后两者都要并进来：一个只在覆盖里出现的 slug（数据不一致）如果在面板上"消失"，
  // 用户就看不到这处不一致，也就永远修不掉它。
  const extraSlugs = new Set<string>()
  for (const row of countRows) if (!KNOWN_PROMPT_SLUGS.includes(row.slug)) extraSlugs.add(row.slug)
  for (const row of overrideSlugRows) if (!KNOWN_PROMPT_SLUGS.includes(row.slug)) extraSlugs.add(row.slug)
  const slugs: string[] = [...KNOWN_PROMPT_SLUGS, ...[...extraSlugs].sort()]

  let activeTokens = 0
  const slots: PromptSlotOverview[] = slugs.map((slug) => {
    const active = activeBySlug.get(slug)
    const revisionCount = revisionCountBySlug.get(slug) ?? 0
    if (active === undefined) {
      // 没有生效版本：字段留空，但**槽位必须出现** ——
      // "这个槽位现在是空的"本身就是要给用户看的信息（否则面板看起来像少了一格）
      return { slug, tokenCount: 0, sha256: '', revisionCount, textPreview: '' }
    }
    activeTokens += Number(active.token_count)
    return {
      slug,
      activeRevisionId: active.id,
      tokenCount: Number(active.token_count),
      sha256: active.sha256,
      updatedAt: active.created_at,
      revisionCount,
      textPreview: textPreview(active.text),
    }
  })

  // 排序用 `created_at DESC, rowid DESC`：ISO 字符串只到毫秒，
  // 同一毫秒里连续保存两版（脚本、连点）顺序会**不确定**，而"历史列表"的价值就在于顺序可信。
  const revisionRows = db
    .prepare(
      `SELECT id, slug, token_count, note, created_by, created_at, active, variables
         FROM prompt_revisions
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(revisionLimit) as unknown as PromptRevisionRow[]

  const revisions: PromptRevisionOverview[] = revisionRows.map((row) => {
    const note = optionalText(row.note)
    return {
      id: row.id,
      slug: row.slug,
      tokenCount: Number(row.token_count),
      createdBy: row.created_by,
      createdAt: row.created_at,
      active: Number(row.active) === 1,
      ...(note === undefined ? {} : { note }),
      variables: parseStringArray(row.variables),
    }
  })

  const overrideRows = db
    .prepare('SELECT scope, slug, revision_id, created_by, created_at FROM prompt_overrides ORDER BY scope, slug')
    .all() as unknown as PromptOverrideRow[]

  const overrides: PromptOverrideOverview[] = overrideRows.map((row) => ({
    scope: row.scope,
    slug: row.slug,
    revisionId: row.revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }))

  return {
    slots,
    revisions,
    overrides,
    stats: {
      slots: slots.length,
      // 全表计数，**不受 revisionLimit 影响**：面板上"共 N 版"和下面列的 40 条不是一回事
      revisions: countOf(db, 'SELECT count(*) AS n FROM prompt_revisions'),
      overrides: overrides.length,
      // 只算生效版本：面板关心的是"现在注入的前缀有多大"。
      // 把历史版本也加进去会得到一个只增不减、没人能解释的数字。
      totalTokens: activeTokens,
    },
  }
}

// ── 路由与端点板块 ─────────────────────────────────────────────────────────

/** 一个候选项。 */
export interface RoutingCandidate {
  readonly rank: number
  readonly provider: string
  readonly model: string
  /** `model_routes.reasoning_effort`；库里是 NULL 时键缺席。 */
  readonly effort?: string
  readonly enabled: boolean
  readonly note?: string
}

/** 一个角色及其有序候选。 */
export interface RoutingRole {
  readonly role: string
  /** 组内按 `rank` 升序（rank 越小越优先，这是自动降级的唯一依据）。 */
  readonly candidates: readonly RoutingCandidate[]
}

/** 端点上的一个模型（只保留 id，够面板这一格显示）。 */
export interface RoutingEndpointModel {
  readonly id: string
}

/** 一个推理端点。 */
export interface RoutingEndpoint {
  readonly id: string
  readonly type: string
  readonly mode: string
  readonly backend: string
  readonly baseUrl: string
  readonly deployTarget?: string
  readonly deployHost?: string
  readonly models: readonly RoutingEndpointModel[]
  /** `undefined` = **从未探测过**（不是"不健康"）。 */
  readonly healthOk?: boolean
  readonly healthCheckedAt?: string
  readonly healthLatencyMs?: number
  /** 实际生效的后端（有些镜像会静默回落到 CPU，与 `backend` 不一致就是证据）。 */
  readonly effectiveBackend?: string
  readonly healthNote?: string
  readonly enabled: boolean
  readonly updatedAt: string
}

/** 一条路由决策日志。 */
export interface RoutingLogEntry {
  readonly at: string
  readonly tier: string
  readonly source: string
  readonly rule?: string
  readonly confidence: number
  readonly escalated: boolean
  readonly degraded: boolean
  readonly degradeReason?: string
  readonly latencyMs: number
  readonly provider?: string
  readonly model?: string
  readonly switched: boolean
  readonly switchReason?: string
}

/** 一条不确定案例。 */
export interface UncertainCaseOverview {
  readonly id: string
  readonly at: string
  readonly textExcerpt: string
  readonly tier: string
  readonly confidence: number
  readonly backend?: string
  readonly status: string
  readonly suggestion?: string
}

/** 「路由与端点」板块的完整载荷。 */
export interface RoutingOverview {
  readonly roles: readonly RoutingRole[]
  readonly endpoints: readonly RoutingEndpoint[]
  readonly log: readonly RoutingLogEntry[]
  readonly uncertain: readonly UncertainCaseOverview[]
  readonly stats: {
    readonly endpoints: number
    readonly healthy: number
    readonly degraded24h: number
    readonly total24h: number
    readonly byTier: readonly { readonly tier: string; readonly count: number }[]
    readonly bySource: readonly { readonly source: string; readonly count: number }[]
  }
}

/** `model_routes` 的行。 */
interface ModelRouteRow {
  readonly role: string
  readonly rank: number
  readonly provider: string
  readonly model: string
  readonly reasoning_effort: string | null
  readonly enabled: number
  readonly note: string | null
}

/** `inference_endpoints` 的行。 */
interface InferenceEndpointRow {
  readonly id: string
  readonly type: string
  readonly mode: string
  readonly backend: string
  readonly base_url: string
  readonly deploy_target: string | null
  readonly deploy_host: string | null
  readonly models: string
  readonly health_ok: number | null
  readonly health_checked_at: string | null
  readonly health_latency_ms: number | null
  readonly effective_backend: string | null
  readonly health_note: string | null
  readonly enabled: number
  readonly updated_at: string
}

/** `routing_log` 的行。 */
interface RoutingLogRow {
  readonly at: string
  readonly tier: string
  readonly source: string
  readonly rule: string | null
  readonly confidence: number
  readonly escalated: number
  readonly degraded: number
  readonly degrade_reason: string | null
  readonly latency_ms: number
  readonly provider: string | null
  readonly model: string | null
  readonly switched: number
  readonly switch_reason: string | null
}

/** `uncertain_cases` 的行。 */
interface UncertainCaseRow {
  readonly id: string
  readonly at: string
  readonly text_excerpt: string
  readonly tier: string
  readonly confidence: number
  readonly backend: string | null
  readonly status: string
  readonly suggestion: string | null
}

/**
 * 「路由与端点」板块。
 *
 * @param db - 数据库。
 * @param options - `logLimit`：路由日志条数，默认 50，上限 500。
 * @returns 路由表、端点、日志、不确定案例与 24 小时统计。
 */
export function queryRouting(db: DatabaseSync, options: { readonly logLimit?: number } = {}): RoutingOverview {
  const logLimit = clampLimit(options.logLimit, DEFAULT_LOG_LIMIT, 500)
  // 24 小时窗口的**字符串比较**：时间列统一是 ISO-8601 UTC，
  // 字典序等于时间序，所以 `at >= ?` 不需要 strftime（也就不依赖 SQLite 对 `Z` 后缀的解析行为）
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // ── 路由表 ──
  // `ORDER BY role, rank` 与 `store/routing.ts` 的 listModelRoutes 一致：组内升序在这里就排好了，
  // 分组时不再二次排序（两处各排一次，就会出现"界面顺序"与"SQL 顺序"两个真源）
  const routeRows = db
    .prepare('SELECT role, rank, provider, model, reasoning_effort, enabled, note FROM model_routes ORDER BY role, rank')
    .all() as unknown as ModelRouteRow[]

  const candidatesByRole = new Map<string, RoutingCandidate[]>()
  for (const row of routeRows) {
    const effort = optionalText(row.reasoning_effort)
    const note = optionalText(row.note)
    const candidate: RoutingCandidate = {
      rank: Number(row.rank),
      provider: row.provider,
      model: row.model,
      ...(effort === undefined ? {} : { effort }),
      enabled: Number(row.enabled) === 1,
      ...(note === undefined ? {} : { note }),
    }
    const list = candidatesByRole.get(row.role)
    if (list === undefined) candidatesByRole.set(row.role, [candidate])
    else list.push(candidate)
  }
  // Map 保持插入顺序 = SQL 给的角色顺序（确定性：同一份数据每次渲染顺序都一样）
  const roles: RoutingRole[] = [...candidatesByRole].map(([role, candidates]) => ({ role, candidates }))

  // ── 端点 ──
  const endpointRows = db
    .prepare(
      `SELECT id, type, mode, backend, base_url, deploy_target, deploy_host, models,
              health_ok, health_checked_at, health_latency_ms, effective_backend, health_note,
              enabled, updated_at
         FROM inference_endpoints
        ORDER BY type, id`,
    )
    .all() as unknown as InferenceEndpointRow[]

  const endpoints: RoutingEndpoint[] = endpointRows.map((row) => {
    // 先把每个可空列收窄成局部变量：`exactOptionalPropertyTypes` 下不能把 `undefined` 直接塞进可选属性
    const deployTarget = optionalText(row.deploy_target)
    const deployHost = optionalText(row.deploy_host)
    const healthOk = optionalFlag(row.health_ok)
    const healthCheckedAt = optionalText(row.health_checked_at)
    const healthLatencyMs = optionalNumber(row.health_latency_ms)
    const effectiveBackend = optionalText(row.effective_backend)
    const healthNote = optionalText(row.health_note)
    return {
      id: row.id,
      type: row.type,
      mode: row.mode,
      backend: row.backend,
      baseUrl: row.base_url,
      ...(deployTarget === undefined ? {} : { deployTarget }),
      ...(deployHost === undefined ? {} : { deployHost }),
      // 解析失败给 []（见文件头第 1 条）：坏 JSON 只让这一格空着，不让整个面板 500
      models: parseModelList(row.models),
      ...(healthOk === undefined ? {} : { healthOk }),
      ...(healthCheckedAt === undefined ? {} : { healthCheckedAt }),
      ...(healthLatencyMs === undefined ? {} : { healthLatencyMs }),
      ...(effectiveBackend === undefined ? {} : { effectiveBackend }),
      ...(healthNote === undefined ? {} : { healthNote }),
      enabled: Number(row.enabled) === 1,
      updatedAt: row.updated_at,
    }
  })

  // ── 路由日志 ──
  const logRows = db
    .prepare(
      `SELECT at, tier, source, rule, confidence, escalated, degraded, degrade_reason,
              latency_ms, provider, model, switched, switch_reason
         FROM routing_log
        ORDER BY at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(logLimit) as unknown as RoutingLogRow[]

  const log: RoutingLogEntry[] = logRows.map((row) => {
    const rule = optionalText(row.rule)
    const degradeReason = optionalText(row.degrade_reason)
    const provider = optionalText(row.provider)
    const model = optionalText(row.model)
    const switchReason = optionalText(row.switch_reason)
    return {
      at: row.at,
      tier: row.tier,
      source: row.source,
      ...(rule === undefined ? {} : { rule }),
      confidence: Number(row.confidence),
      escalated: Number(row.escalated) === 1,
      degraded: Number(row.degraded) === 1,
      ...(degradeReason === undefined ? {} : { degradeReason }),
      latencyMs: Number(row.latency_ms),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      switched: Number(row.switched) === 1,
      ...(switchReason === undefined ? {} : { switchReason }),
    }
  })

  // ── 不确定案例（条数固定，不开放参数：它只服务"定期复盘"这一个用途）──
  const uncertainRows = db
    .prepare(
      `SELECT id, at, text_excerpt, tier, confidence, backend, status, suggestion
         FROM uncertain_cases
        ORDER BY at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(UNCERTAIN_LIMIT) as unknown as UncertainCaseRow[]

  const uncertain: UncertainCaseOverview[] = uncertainRows.map((row) => {
    const backend = optionalText(row.backend)
    const suggestion = optionalText(row.suggestion)
    return {
      id: row.id,
      at: row.at,
      textExcerpt: row.text_excerpt,
      tier: row.tier,
      confidence: Number(row.confidence),
      ...(backend === undefined ? {} : { backend }),
      status: row.status,
      ...(suggestion === undefined ? {} : { suggestion }),
    }
  })

  // ── 统计 ──
  // 口径说明：`endpoints` / `healthy` 数的是**表里的全部行**，与上面的 `endpoints` 列表长度对齐
  // （列表里也含禁用端点 —— 禁用不是"不存在"，用户还得看得见并把它打开）。
  // `overview.ts` 那边用的是"仅 enabled"的口径，因为总览看的是"正在跑的东西"；
  // 两个口径不同是有意的，不是笔误。
  const endpointTotal = countOf(db, 'SELECT count(*) AS n FROM inference_endpoints')
  const healthy = countOf(db, 'SELECT count(*) AS n FROM inference_endpoints WHERE health_ok = 1')
  const total24h = countOf(db, 'SELECT count(*) AS n FROM routing_log WHERE at >= ?', since24h)
  const degraded24h = countOf(db, 'SELECT count(*) AS n FROM routing_log WHERE at >= ? AND degraded = 1', since24h)

  // 分组统计都限定在 24 小时窗口内（与 total24h 同分母，否则百分比对不上）
  const byTierRows = db
    .prepare('SELECT tier, count(*) AS n FROM routing_log WHERE at >= ? GROUP BY tier ORDER BY tier')
    .all(since24h) as unknown as { tier: string; n: number }[]
  const bySourceRows = db
    .prepare('SELECT source, count(*) AS n FROM routing_log WHERE at >= ? GROUP BY source ORDER BY source')
    .all(since24h) as unknown as { source: string; n: number }[]

  return {
    roles,
    endpoints,
    log,
    uncertain,
    stats: {
      endpoints: endpointTotal,
      healthy,
      degraded24h,
      total24h,
      byTier: byTierRows.map((row) => ({ tier: row.tier, count: Number(row.n) })),
      bySource: bySourceRows.map((row) => ({ source: row.source, count: Number(row.n) })),
    },
  }
}
