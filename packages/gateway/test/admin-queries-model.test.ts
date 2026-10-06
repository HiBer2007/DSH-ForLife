/**
 * 管理后台「提示词」「路由与端点」取数层的测试。
 *
 * 这些查询是**面板唯一的数据来源**，所以它们错起来是最难受的一类错：
 * 界面不会报错，只会安静地显示一个错的数字。因此这里守的是四件事：
 *
 *  ① **空库不抛**：全新装好的机器上，这两个页面必须能打开（显示"还没数据"）；
 *  ② **分组与排序**：按 slug / role 分组、组内按 rank 升序、历史按时间倒序 ——
 *     顺序错了，"哪一版在生效""哪个模型优先"就全读反了；
 *  ③ **JSON 列容错**：`models` 的两种形态（对象数组 / 字符串数组）都要认，
 *     坏数据要退化成 `[]` 而**不是把整个面板打挂**（这是本文件里最要命的一条）；
 *  ④ **NULL 与假值不等价**：`health_ok IS NULL` 是"从未探测"，不是"不健康"。
 *
 * 每个用例一个全新的内存库（`:memory:`，迁移会建好全部表）：
 * 用例之间不共享数据，才敢断言精确的顺序与计数。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import {
  queryPrompts,
  queryRouting,
  type PromptSlotOverview,
  type PromptsOverview,
  type RoutingEndpoint,
  type RoutingRole,
} from '../src/admin/queries-model.ts'

/** 开一个迁到最新 schema 的内存库，用例结束自动关。 */
function freshDb(t: TestContext): DatabaseSync {
  const opened = openDatabase({ file: ':memory:' })
  t.after(() => opened.close())
  return opened.db
}

/** 填一个两位数（时间字符串拼接用）。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// ── 造数据的小工具（直接写真实表，不经过上层，避免"上层的错"掩盖"查询的错"） ──

function insertRevision(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly slug: string
    readonly text: string
    readonly createdAt: string
    readonly active?: boolean
    readonly tokenCount?: number
    readonly sha256?: string
    readonly variables?: string
    readonly note?: string | null
    readonly createdBy?: string
  },
): void {
  db.prepare(
    `INSERT INTO prompt_revisions (id, slug, text, sha256, token_count, variables, note, created_by, created_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.slug,
    input.text,
    input.sha256 ?? `sha-${input.id}`,
    input.tokenCount ?? 10,
    input.variables ?? '[]',
    input.note ?? null,
    input.createdBy ?? 'admin',
    input.createdAt,
    (input.active ?? false) ? 1 : 0,
  )
}

function insertOverride(
  db: DatabaseSync,
  input: { readonly scope: string; readonly slug: string; readonly revisionId: string; readonly createdAt: string },
): void {
  db.prepare(
    `INSERT INTO prompt_overrides (scope, slug, revision_id, created_by, created_at)
     VALUES (?, ?, ?, 'admin', ?)`,
  ).run(input.scope, input.slug, input.revisionId, input.createdAt)
}

function insertRoute(
  db: DatabaseSync,
  input: {
    readonly role: string
    readonly rank: number
    readonly provider: string
    readonly model: string
    readonly effort?: string | null
    readonly enabled?: boolean
    readonly note?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO model_routes (id, role, rank, provider, model, reasoning_effort, enabled, note, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', '2026-10-05T00:00:00.000Z')`,
  ).run(
    `mr_${input.role}_${String(input.rank)}`,
    input.role,
    input.rank,
    input.provider,
    input.model,
    input.effort ?? null,
    (input.enabled ?? true) ? 1 : 0,
    input.note ?? null,
  )
}

function insertEndpoint(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly type: string
    /** 直接给列的原始文本：本文件要测的正是"列里到底写了什么"。 */
    readonly models: string
    readonly healthOk?: number | null
    readonly healthCheckedAt?: string | null
    readonly healthLatencyMs?: number | null
    readonly effectiveBackend?: string | null
    readonly healthNote?: string | null
    readonly deployTarget?: string | null
    readonly deployHost?: string | null
    readonly enabled?: boolean
  },
): void {
  db.prepare(
    `INSERT INTO inference_endpoints (id, type, mode, backend, base_url, deploy_target, deploy_host, models,
                                       health_ok, health_checked_at, health_latency_ms, effective_backend, health_note,
                                       enabled, created_at, updated_at)
     VALUES (?, ?, 'resident', 'cpu', 'http://127.0.0.1:8080/v1', ?, ?, ?,
             ?, ?, ?, ?, ?, ?, '2026-10-05T00:00:00.000Z', '2026-10-05T01:00:00.000Z')`,
  ).run(
    input.id,
    input.type,
    input.deployTarget ?? null,
    input.deployHost ?? null,
    input.models,
    input.healthOk ?? null,
    input.healthCheckedAt ?? null,
    input.healthLatencyMs ?? null,
    input.effectiveBackend ?? null,
    input.healthNote ?? null,
    (input.enabled ?? true) ? 1 : 0,
  )
}

function insertLog(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly at: string
    readonly tier: string
    readonly source: string
    readonly confidence: number
    readonly rule?: string | null
    readonly escalated?: boolean
    readonly degraded?: boolean
    readonly degradeReason?: string | null
    readonly latencyMs?: number
    readonly provider?: string | null
    readonly model?: string | null
    readonly switched?: boolean
    readonly switchReason?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO routing_log (id, at, tier, source, rule, confidence, escalated, degraded, degrade_reason,
                              latency_ms, provider, model, switched, switch_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.at,
    input.tier,
    input.source,
    input.rule ?? null,
    input.confidence,
    (input.escalated ?? false) ? 1 : 0,
    (input.degraded ?? false) ? 1 : 0,
    input.degradeReason ?? null,
    input.latencyMs ?? 0,
    input.provider ?? null,
    input.model ?? null,
    (input.switched ?? false) ? 1 : 0,
    input.switchReason ?? null,
  )
}

function insertUncertain(
  db: DatabaseSync,
  input: {
    readonly id: string
    readonly at: string
    readonly textExcerpt: string
    readonly tier: string
    readonly confidence: number
    readonly backend?: string | null
    readonly status: string
    readonly suggestion?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO uncertain_cases (id, at, text_excerpt, tier, confidence, backend, status, suggestion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.at,
    input.textExcerpt,
    input.tier,
    input.confidence,
    input.backend ?? null,
    input.status,
    input.suggestion ?? null,
  )
}

// ── 取结果的小工具（用 throw 收窄类型，同时给出比 `slots[0]!` 有用得多的失败信息） ──

function slotOf(overview: PromptsOverview, slug: string): PromptSlotOverview {
  const found = overview.slots.find((slot) => slot.slug === slug)
  if (found === undefined) throw new Error(`槽位 ${slug} 必须出现在面板上（现有：${overview.slots.map((s) => s.slug).join(',')}）`)
  return found
}

function roleOf(roles: readonly RoutingRole[], role: string): RoutingRole {
  const found = roles.find((item) => item.role === role)
  if (found === undefined) throw new Error(`角色 ${role} 必须出现在路由表里`)
  return found
}

function endpointOf(endpoints: readonly RoutingEndpoint[], id: string): RoutingEndpoint {
  const found = endpoints.find((item) => item.id === id)
  if (found === undefined) throw new Error(`端点 ${id} 必须出现在列表里`)
  return found
}

/** 某个端点的模型 id 列表（断言 models 解析结果用）。 */
function modelIds(endpoints: readonly RoutingEndpoint[], id: string): string[] {
  return endpointOf(endpoints, id).models.map((model) => model.id)
}

// ── 空库 ───────────────────────────────────────────────────────────────────

test('空库：两个板块都不抛，槽位仍列出 p1-system / p2-style', (t) => {
  const db = freshDb(t)

  const prompts = queryPrompts(db)
  assert.deepEqual(
    prompts.slots.map((slot) => slot.slug),
    ['p1-system', 'p2-style'],
    '空库也必须给出两个槽位：否则面板上连"去写第一版提示词"的入口都没有',
  )
  // deepEqual（严格版）会连"有哪些键"一起比：没有生效版本时必须是**键缺席**，不是空字符串
  assert.deepEqual(prompts.slots[0], { slug: 'p1-system', tokenCount: 0, sha256: '', revisionCount: 0, textPreview: '' })
  assert.deepEqual(prompts.revisions, [])
  assert.deepEqual(prompts.overrides, [])
  assert.deepEqual(prompts.stats, { slots: 2, revisions: 0, overrides: 0, totalTokens: 0 })

  const routing = queryRouting(db)
  assert.deepEqual(routing.roles, [])
  assert.deepEqual(routing.endpoints, [])
  assert.deepEqual(routing.log, [])
  assert.deepEqual(routing.uncertain, [])
  assert.deepEqual(routing.stats, { endpoints: 0, healthy: 0, degraded24h: 0, total24h: 0, byTier: [], bySource: [] })
})

// ── 提示词 ─────────────────────────────────────────────────────────────────

test('提示词：生效版本、历史计数、预览截断、覆盖与统计', (t) => {
  const db = freshDb(t)
  const longText = '甲'.repeat(400)

  insertRevision(db, {
    id: 'r1',
    slug: 'p1-system',
    text: '最早的一版',
    createdAt: '2026-10-05T08:00:00.000Z',
    tokenCount: 30,
    variables: '["persona_name"]',
    note: '内置默认值',
    createdBy: 'system',
  })
  insertRevision(db, { id: 'r2', slug: 'p1-system', text: '中间的一版', createdAt: '2026-10-05T09:00:00.000Z' })
  insertRevision(db, {
    id: 'r3',
    slug: 'p1-system',
    text: longText,
    createdAt: '2026-10-05T10:00:00.000Z',
    active: true,
    tokenCount: 287,
  })
  // p2-style：只有历史版本、**没有 active** —— 这正是"字段留空但仍要出现"的场景
  insertRevision(db, { id: 'r4', slug: 'p2-style', text: '回答风格', createdAt: '2026-10-05T11:00:00.000Z', tokenCount: 206 })
  // 将来加的槽位（或手工插的数据）：也不能被面板藏起来
  insertRevision(db, { id: 'r5', slug: 'p3-extra', text: '额外槽位', createdAt: '2026-10-05T12:00:00.000Z', active: true, tokenCount: 7 })
  insertOverride(db, { scope: 'group:88888', slug: 'p2-style', revisionId: 'r4', createdAt: '2026-10-05T13:00:00.000Z' })

  const overview = queryPrompts(db)

  assert.deepEqual(overview.slots.map((slot) => slot.slug), ['p1-system', 'p2-style', 'p3-extra'])

  const p1 = slotOf(overview, 'p1-system')
  assert.equal(p1.activeRevisionId, 'r3', '生效的必须是 active=1 的那条')
  assert.equal(p1.tokenCount, 287)
  assert.equal(p1.sha256, 'sha-r3')
  assert.equal(p1.updatedAt, '2026-10-05T10:00:00.000Z')
  assert.equal(p1.revisionCount, 3, 'revisionCount 是这个 slug 的历史总数')
  assert.equal(p1.textPreview.length, 300, '超过 300 字符必须截断')
  assert.equal(p1.textPreview, longText.slice(0, 300))

  const p2 = slotOf(overview, 'p2-style')
  assert.deepEqual(
    p2,
    { slug: 'p2-style', tokenCount: 0, sha256: '', revisionCount: 1, textPreview: '' },
    '没有 active 时：字段留空（键缺席），但 revisionCount 仍要如实报',
  )

  // 历史版本：默认按 created_at DESC
  assert.deepEqual(overview.revisions.map((revision) => revision.id), ['r5', 'r4', 'r3', 'r2', 'r1'])
  const r1 = overview.revisions.find((revision) => revision.id === 'r1')
  assert.deepEqual(r1, {
    id: 'r1',
    slug: 'p1-system',
    tokenCount: 30,
    createdBy: 'system',
    createdAt: '2026-10-05T08:00:00.000Z',
    active: false,
    note: '内置默认值',
    variables: ['persona_name'],
  })
  assert.equal(overview.revisions.find((revision) => revision.id === 'r3')?.active, true)

  assert.deepEqual(overview.overrides, [
    {
      scope: 'group:88888',
      slug: 'p2-style',
      revisionId: 'r4',
      createdBy: 'admin',
      createdAt: '2026-10-05T13:00:00.000Z',
    },
  ])

  // totalTokens 只算生效版本：287（r3）+ 7（r5），历史版本不计入
  assert.deepEqual(overview.stats, { slots: 3, revisions: 5, overrides: 1, totalTokens: 294 })
})

test('提示词：revisionLimit 生效（默认 40 / 可缩小 / 0 = 不要列表），同毫秒用 rowid 兜底', (t) => {
  const db = freshDb(t)
  const sameMs = '2026-10-05T10:00:00.000Z'
  for (let i = 0; i < 45; i += 1) {
    insertRevision(db, {
      id: `r${pad(i)}`,
      slug: 'p1-system',
      text: `第 ${String(i)} 版`,
      createdAt: sameMs,
      active: i === 44,
    })
  }

  const byDefault = queryPrompts(db)
  assert.equal(byDefault.revisions.length, 40, '默认取 40 条')
  assert.equal(byDefault.revisions[0]?.id, 'r44', '同一毫秒内后写的更新：必须用 rowid 兜底，否则顺序不确定')
  assert.equal(byDefault.revisions[39]?.id, 'r05')
  assert.equal(byDefault.stats.revisions, 45, '总数是整表计数，不能被 limit 截成 40')
  assert.equal(slotOf(byDefault, 'p1-system').revisionCount, 45)

  assert.deepEqual(
    queryPrompts(db, { revisionLimit: 2 }).revisions.map((revision) => revision.id),
    ['r44', 'r43'],
  )
  assert.deepEqual(queryPrompts(db, { revisionLimit: 0 }).revisions, [], '0 是合法输入：明确表示不要列表')
  assert.equal(queryPrompts(db, { revisionLimit: -5 }).revisions.length, 40, '非法值回落到默认值，而不是抛')
})

test('提示词：variables 是脏 JSON 时给空数组（不抛）', (t) => {
  const db = freshDb(t)
  insertRevision(db, { id: 'v-bad', slug: 'p1-system', text: 'a', createdAt: '2026-10-05T01:00:00.000Z', variables: '不是 JSON' })
  insertRevision(db, { id: 'v-obj', slug: 'p1-system', text: 'b', createdAt: '2026-10-05T02:00:00.000Z', variables: '{"a":1}' })
  insertRevision(db, {
    id: 'v-mixed',
    slug: 'p1-system',
    text: 'c',
    createdAt: '2026-10-05T03:00:00.000Z',
    variables: '["ok", 7, null, {"x":1}, ""]',
  })

  const overview = queryPrompts(db)
  const variablesOf = (id: string): readonly string[] | undefined =>
    overview.revisions.find((revision) => revision.id === id)?.variables

  assert.deepEqual(variablesOf('v-bad'), [])
  assert.deepEqual(variablesOf('v-obj'), [], '解析成功但不是数组，同样不算数')
  assert.deepEqual(variablesOf('v-mixed'), ['ok'], '只保留字符串元素：面板要把它逐个当标签渲染')
})

// ── 路由表 ─────────────────────────────────────────────────────────────────

test('路由表：按 role 分组、组内按 rank 升序、NULL 字段不出现在载荷里', (t) => {
  const db = freshDb(t)
  // 故意乱序插入：顺序必须由查询保证，而不是靠插入顺序
  insertRoute(db, { role: 'L1', rank: 1, provider: 'deepseek-official', model: 'backup', effort: 'low', note: '备用' })
  insertRoute(db, { role: 'scorer', rank: 0, provider: 'local', model: 'judge' })
  insertRoute(db, { role: 'L1', rank: 0, provider: 'deepseek-official', model: 'main' })
  insertRoute(db, { role: 'L2', rank: 0, provider: 'deepseek-official', model: 'mid', enabled: false })

  const { roles } = queryRouting(db)
  assert.deepEqual(roles.map((role) => role.role), ['L1', 'L2', 'scorer'])

  const l1 = roleOf(roles, 'L1')
  assert.deepEqual(
    l1.candidates.map((candidate) => [candidate.rank, candidate.model]),
    [
      [0, 'main'],
      [1, 'backup'],
    ],
    '组内必须按 rank 升序：rank 就是自动降级的顺序',
  )
  assert.deepEqual(l1.candidates[0], { rank: 0, provider: 'deepseek-official', model: 'main', enabled: true }, 'effort/note 为 NULL 时键缺席')
  assert.equal(l1.candidates[1]?.effort, 'low')
  assert.equal(l1.candidates[1]?.note, '备用')

  const l2 = roleOf(roles, 'L2')
  assert.equal(l2.candidates[0]?.enabled, false, '禁用的候选要留着（面板得能把它重新打开），只是标记出来')
})

// ── 端点 ───────────────────────────────────────────────────────────────────

test('端点：models 的两种 JSON 形态都能解析，坏数据返回 [] 且不抛', (t) => {
  const db = freshDb(t)
  insertEndpoint(db, {
    id: 'ep-object',
    type: 'local',
    models: JSON.stringify([
      { id: 'qwen2.5', image: false, contextLength: 32_000 },
      { id: 'bge-m3', embeddingDimensions: 1024 },
    ]),
  })
  insertEndpoint(db, { id: 'ep-string', type: 'local', models: JSON.stringify(['qwen2.5', 'bge-m3']) })
  insertEndpoint(db, {
    id: 'ep-mixed',
    type: 'cloud-api',
    models: JSON.stringify([{ id: 'a' }, 'b', 42, null, [], { noId: true }, { id: 7 }, { id: '' }]),
  })
  insertEndpoint(db, { id: 'ep-bad', type: 'cloud-api', models: '{ 这不是 JSON' })
  insertEndpoint(db, { id: 'ep-nonarray', type: 'cloud-api', models: '{"id":"a"}' })
  insertEndpoint(db, { id: 'ep-empty', type: 'cloud-api', models: '[]' })

  const { endpoints, stats } = queryRouting(db)

  assert.deepEqual(modelIds(endpoints, 'ep-object'), ['qwen2.5', 'bge-m3'], '对象数组取 id')
  assert.deepEqual(modelIds(endpoints, 'ep-string'), ['qwen2.5', 'bge-m3'], '字符串数组直接当 id')
  assert.deepEqual(modelIds(endpoints, 'ep-mixed'), ['a', 'b'], '混着写也只跳过坏的那一项，不整列报废')
  assert.deepEqual(modelIds(endpoints, 'ep-bad'), [], '坏 JSON = 空列表（这一个端点空着），绝不是抛异常')
  assert.deepEqual(modelIds(endpoints, 'ep-nonarray'), [], '能解析但不是数组，同样给 []')
  assert.deepEqual(modelIds(endpoints, 'ep-empty'), [])
  assert.equal(stats.endpoints, 6)
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.id),
    ['ep-bad', 'ep-empty', 'ep-mixed', 'ep-nonarray', 'ep-object', 'ep-string'],
    '列表按 type, id 排：顺序稳定，界面才不会每次刷新都跳',
  )
})

test('端点：health_ok 为 NULL 表示从未探测（键缺席），0 才是不健康', (t) => {
  const db = freshDb(t)
  insertEndpoint(db, { id: 'ep-never', type: 'local', models: '[]' })
  insertEndpoint(db, {
    id: 'ep-sick',
    type: 'local',
    models: '[]',
    healthOk: 0,
    healthCheckedAt: '2026-10-05T01:00:00.000Z',
    healthLatencyMs: 1200,
    effectiveBackend: 'cpu',
    healthNote: '镜像静默回落到 CPU',
  })
  insertEndpoint(db, { id: 'ep-ok', type: 'local', models: '[]', healthOk: 1, deployTarget: 'local-docker', deployHost: 'gpu-box' })

  const { endpoints, stats } = queryRouting(db)

  const never = endpointOf(endpoints, 'ep-never')
  assert.equal('healthOk' in never, false, '从未探测 ≠ 不健康：键必须缺席，界面显示"—"')
  assert.equal('healthCheckedAt' in never, false)
  assert.equal('effectiveBackend' in never, false)
  assert.equal('deployTarget' in never, false)
  assert.equal(never.baseUrl, 'http://127.0.0.1:8080/v1')

  const sick = endpointOf(endpoints, 'ep-sick')
  assert.equal(sick.healthOk, false)
  assert.equal(sick.healthLatencyMs, 1200)
  assert.equal(sick.effectiveBackend, 'cpu')
  assert.equal(sick.healthNote, '镜像静默回落到 CPU')
  assert.equal(sick.healthCheckedAt, '2026-10-05T01:00:00.000Z')

  const ok = endpointOf(endpoints, 'ep-ok')
  assert.equal(ok.healthOk, true)
  assert.equal(ok.deployTarget, 'local-docker')
  assert.equal(ok.deployHost, 'gpu-box')
  assert.equal(ok.updatedAt, '2026-10-05T01:00:00.000Z')

  assert.equal(stats.endpoints, 3, '总数与上面的列表长度对齐（禁用端点也在列表里）')
  assert.equal(stats.healthy, 1)
})

test('端点：禁用的端点照样列出，只是 enabled=false', (t) => {
  const db = freshDb(t)
  insertEndpoint(db, { id: 'ep-on', type: 'local', models: '[]', healthOk: 1 })
  insertEndpoint(db, { id: 'ep-off', type: 'local', models: '[]', enabled: false })

  const { endpoints, stats } = queryRouting(db)
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.id),
    ['ep-off', 'ep-on'],
  )
  assert.equal(endpointOf(endpoints, 'ep-off').enabled, false)
  assert.equal(stats.endpoints, 2, '禁用不是"不存在"：用户还得在面板里看见它才能把它打开')
})

// ── 路由日志与统计 ─────────────────────────────────────────────────────────

test('路由日志：倒序、limit、NULL 字段缺席，24h 统计只算窗口内', (t) => {
  const db = freshDb(t)
  const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()

  insertLog(db, {
    id: 'l1',
    at: at(1),
    tier: 'L1',
    source: 'guard',
    confidence: 1,
    rule: 'force-l1',
    degraded: true,
    degradeReason: 'quota',
    latencyMs: 12,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  insertLog(db, { id: 'l2', at: at(2), tier: 'L1', source: 'scorer', confidence: 0.4, escalated: true, switched: true, switchReason: 'escalate', latencyMs: 230 })
  insertLog(db, { id: 'l4', at: at(3), tier: 'L2', source: 'heuristic', confidence: 0.6, latencyMs: 5 })
  insertLog(db, { id: 'l3', at: at(25), tier: 'L3', source: 'scorer', confidence: 0.9, latencyMs: 99 })

  const overview = queryRouting(db)
  assert.deepEqual(
    overview.log.map((entry) => entry.tier),
    ['L1', 'L1', 'L2', 'L3'],
    '日志按 at DESC；25 小时前那条仍在列表里（它是历史，只是不进 24h 统计）',
  )

  const first = overview.log[0]
  assert.ok(first !== undefined)
  assert.equal(first.degraded, true)
  assert.equal(first.escalated, false, '布尔量不能把 0 漏成 undefined')
  assert.equal(first.switched, false)
  assert.equal(first.degradeReason, 'quota')
  assert.equal(first.rule, 'force-l1')
  assert.equal('switchReason' in first, false)
  assert.equal(first.confidence, 1)
  assert.equal(first.latencyMs, 12)

  const second = overview.log[1]
  assert.ok(second !== undefined)
  assert.equal(second.escalated, true)
  assert.equal(second.switched, true)
  assert.equal(second.switchReason, 'escalate')
  assert.equal('degradeReason' in second, false)
  assert.equal('provider' in second, false, 'provider 为 NULL 时键缺席，界面留空')
  assert.equal('model' in second, false)

  assert.equal(overview.stats.total24h, 3, '24 小时窗口内的决策数')
  assert.equal(overview.stats.degraded24h, 1)
  assert.deepEqual(overview.stats.byTier, [
    { tier: 'L1', count: 2 },
    { tier: 'L2', count: 1 },
  ])
  assert.deepEqual(overview.stats.bySource, [
    { source: 'guard', count: 1 },
    { source: 'heuristic', count: 1 },
    { source: 'scorer', count: 1 },
  ])

  assert.equal(queryRouting(db, { logLimit: 2 }).log.length, 2)
  assert.deepEqual(queryRouting(db, { logLimit: 0 }).log, [])
})

// ── 不确定案例 ─────────────────────────────────────────────────────────────

test('不确定案例：倒序、固定 30 条上限、可空字段缺席', (t) => {
  const db = freshDb(t)
  insertUncertain(db, {
    id: 'u-new',
    at: '2026-10-05T00:02:00.000Z',
    textExcerpt: '这条到底在说啥',
    tier: 'L3',
    confidence: 0.31,
    status: 'pending',
  })
  insertUncertain(db, {
    id: 'u-old',
    at: '2026-10-05T00:01:00.000Z',
    textExcerpt: '另一条',
    tier: 'L2',
    confidence: 0.55,
    backend: 'scorer-local',
    status: 'reviewed',
    suggestion: '建议升到 L3',
  })
  // 再灌 30 条更早的：总数 32 > 30，验证上限**确实在截断**（而不是碰巧没超）
  for (let i = 1; i <= 30; i += 1) {
    insertUncertain(db, {
      id: `u-fill-${pad(i)}`,
      at: `2026-10-04T00:${pad(i)}:00.000Z`,
      textExcerpt: `填充 ${String(i)}`,
      tier: 'L1',
      confidence: 0.2,
      status: 'pending',
    })
  }

  const { uncertain } = queryRouting(db)
  assert.equal(uncertain.length, 30)
  assert.equal(uncertain[0]?.id, 'u-new')
  assert.equal(uncertain[1]?.id, 'u-old')
  assert.equal(uncertain[29]?.id, 'u-fill-03', '最旧的两条被截掉（32 条里留最新的 30 条）')

  const latest = uncertain[0]
  assert.ok(latest !== undefined)
  assert.deepEqual(latest, {
    id: 'u-new',
    at: '2026-10-05T00:02:00.000Z',
    textExcerpt: '这条到底在说啥',
    tier: 'L3',
    confidence: 0.31,
    status: 'pending',
  })

  const reviewed = uncertain[1]
  assert.ok(reviewed !== undefined)
  assert.equal(reviewed.backend, 'scorer-local')
  assert.equal(reviewed.suggestion, '建议升到 L3')
  assert.equal(reviewed.status, 'reviewed')
})
