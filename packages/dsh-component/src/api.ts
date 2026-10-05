/**
 * 面板接口（`/api/forlife/*`）。
 *
 * 实测到的宿主契约（`dsh-client-connection/lib/types/rpc.d.ts:111-128`）：
 *  - `register({ path, methods, requestBody, fetch })`，`path` 是 **`/api` 之下的绝对路径**；
 *  - `fetch` 收 `Request` 返 `Response`（标准 Fetch 形态）；
 *  - 返回的是**异步** disposer。
 *
 * 设计上把"处理逻辑"与"注册"分开：处理逻辑是纯函数式的 `Request → Response`，
 * 因此**不开 HTTP 服务器也能验收**（测试直接构造 Request 调用）。
 *
 * @module forlife-memory/api
 */
import {
  listAdminChat,
  listOutbound,
  listWakeRules,
  outboxStats,
  pendingAdminCount,
  pendingStats,
  postHumanMessage,
  recordAdminAction,
  setWakeRule,
  WAKE_CONDITIONS,
} from '@forlife/gateway'
import {
  diffPromptLines,
  estimatePromptTokens,
  hashPromptText,
  normalizePromptText,
  PROMPT_VARIABLES,
  renderPromptPreview,
  validatePromptText,
} from '@forlife/memory-core'
import { defaultFor } from '@forlife/contracts'
import { cacheCurve, expectedMisses, judgeCache, summarizeCache } from '@forlife/memory-core'
import { ROUTE_ROLES, ROLE_PURPOSE, RUN_MODES, validateEndpoint } from '@forlife/router'
import { deleteModelRoute, endpointOverview, getEndpoint, listEndpoints, listModelRoutes, routingStats, uncertainStats, upsertModelRoute } from '@forlife/store'
import { lastCacheUsageAt, listCacheUsage, listTimeDrift, listTimeReadings, timeDriftStats, timeReadingStats, timeReadingTokens } from '@forlife/store'

import type { MemoryRuntime } from './runtime.ts'
import {
  activePrompt,
  listPromptOverrides,
  listPromptRevisions,
  promptRevisionById,
  promptEditCount,
  promptStatus,
  PROMPT_SLUGS,
  rollbackPrompt,
  savePromptRevision,
  setPromptOverride,
  clearPromptOverride,
  type PromptSlug,
} from './prompt-store.ts'
import { listCompactionRuns } from '@forlife/store'

import { contractsSummary } from './diagnostics.ts'

/** 一条面板路由。 */
export interface PanelRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** 宿主 connection.fetch 注册表的最小结构。 */
export interface FetchRegistryLike {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
    readonly requestBody: 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** JSON 响应工具。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 从 URL 取整数查询参数。 */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : undefined
}

/**
 * 构造面板路由集合。
 *
 * @param runtime - 记忆运行时。
 * @returns 路由数组（尚未注册）。
 */
export function buildPanelRoutes(runtime: MemoryRuntime): readonly PanelRoute[] {
  const get = (path: string, handler: (url: URL) => Response): PanelRoute => ({
    path,
    methods: ['GET'],
    fetch: async (request: Request): Promise<Response> => {
      try {
        return handler(new URL(request.url))
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500)
      }
    },
  })

  return [
    // 概览：epoch / revision / 条目数 / 渲染指纹 / 约束违反
    get('/api/forlife/state', () => json({ ok: true, ...runtime.stats(), dbPath: runtime.dbPath })),

    // 条目列表（可按 epoch 与 status 过滤）—— 阶段 1 验收项之一
    get('/api/forlife/entries', (url) => {
      const epoch = intParam(url, 'epoch')
      const status = url.searchParams.getAll('status').filter((s) => s !== '')
      const entries = runtime.listEntries({
        ...(epoch === undefined ? {} : { epoch }),
        ...(status.length === 0 ? {} : { status: status as never }),
      })
      return json({
        ok: true,
        epoch: epoch ?? null, // null = 未按 epoch 过滤（L3 是跨压缩累积的）
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          type: e.entry_type,
          status: e.status,
          summary: e.summary,
          hint: e.fragment_hint,
          entities: e.entities,
          tokenCount: e.token_count,
          windowOffset: e.window_offset,
          epoch: e.compaction_epoch,
          sourceScope: e.source_scope,
          createdAt: e.created_at,
          lastAccessedAt: e.last_accessed_at,
        })),
      })
    }),

    // 压缩日志 + 运行记录（阶段 2 起有数据）。
    // 两份数据用途不同：log 是 PLAN §4.5 的协议字段，runs 是事务视角（含 started/committed/aborted 与回滚结果）。
    get('/api/forlife/compaction', (url) => {
      const limit = intParam(url, 'limit') ?? 20
      return json({
        ok: true,
        log: runtime.compactionLog(limit),
        runs: listCompactionRuns(runtime.db, limit).map((run) => ({
          id: run.id,
          phase: run.phase,
          epochFrom: run.epoch_from,
          epochTo: run.epoch_to,
          sessionId: run.session_id,
          compactionId: run.compaction_id,
          error: run.error,
          startedAt: run.started_at,
          endedAt: run.ended_at,
        })),
      })
    }),

    // 溢出记录（大结果被截断后的全文索引）
    get('/api/forlife/spills', (url) => {
      const session = url.searchParams.get('session') ?? ''
      return json({ ok: true, session, spills: runtime.listSpill(session, intParam(url, 'limit') ?? 20) })
    }),

    // ── 阶段 4：缓存命中率 ──────────────────────────────────────────────────

    // 命中率汇总 + 曲线 + 未命中归因（面板要能回答"缓存到底有没有在省"）
    get('/api/forlife/cache', (url) => {
      const hours = intParam(url, 'hours') ?? 168
      const rows = listCacheUsage(runtime.db, { limit: intParam(url, 'limit') ?? 500, sinceHours: hours })
      const samples = rows.map((row) => ({
        at: row.at,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
        missReason: row.miss_reason,
      }))
      const summary = summarizeCache(samples)

      // 期望未命中数 = 首次 + 压缩次数 + 提示词编辑次数（验收口径）
      const compactions = runtime.db.prepare("SELECT count(*) AS n FROM compaction_runs WHERE phase = 'committed'").get() as { n: number }
      const edits = promptEditCount(runtime.db)
      const expected = expectedMisses({ compactions: compactions.n, promptEdits: edits, samples: summary.samples })
      const verdict = judgeCache(summary, expected)

      return json({
        ok: true,
        windowHours: hours,
        summary,
        expected,
        verdict,
        // 曲线只给最近 60 个点：面板画的是趋势，不是审计明细
        curve: cacheCurve(samples).slice(-60),
        lastSampleAt: lastCacheUsageAt(runtime.db),
        recent: rows.slice(-30).map((row) => ({
          at: row.at,
          input: row.input_tokens,
          read: row.cache_read_tokens,
          write: row.cache_write_tokens,
          output: row.output_tokens,
          reason: row.miss_reason,
          source: row.source,
        })),
      })
    }),
    // ── 阶段 4：时间感知与三层时区 ──────────────────────────────────────────

    // 时间感知指标：最新读数年龄、注入次数与 token 成本、漂移统计、时钟设置
    get('/api/forlife/time', () => {
      const readings = listTimeReadings(runtime.db, 30)
      const latest = readings[0]
      const now = Date.now()
      const settings = runtime.clockSettings()
      const freshMs = 30_000
      const ageMs = latest === undefined ? null : Math.max(0, now - Date.parse(latest.at))
      return json({
        ok: true,
        // 验收项："压缩后/唤醒后/长空闲后都存在一条新鲜读数" —— 面板要能直接看出新鲜度
        settings,
        latest:
          latest === undefined
            ? null
            : {
                at: latest.at,
                reason: latest.reason,
                timezone: latest.timezone,
                ageMs,
                fresh: ageMs !== null && ageMs <= freshMs,
                text: latest.text,
              },
        freshThresholdMs: freshMs,
        byReason: timeReadingStats(runtime.db),
        tokenCost: timeReadingTokens(runtime.db),
        readings: readings.slice(0, 10).map((row) => ({
          at: row.at,
          reason: row.reason,
          timezone: row.timezone,
          tokenCount: row.token_count,
          conversation: row.conversation_key,
        })),
        // 三层时区：按会话覆盖 + 待确认建议（建议不生效，要显眼）
        clocks: runtime.listConversationClocks().map((clock) => ({
          scope: clock.scope,
          timezone: clock.timezone,
          hour24: clock.hour24,
          source: clock.source,
          reason: clock.reason,
          updatedAt: clock.updatedAt,
        })),
        drift: timeDriftStats(runtime.db),
        recentDrift: listTimeDrift(runtime.db, 10).map((row) => ({
          at: row['at'],
          claimed: row['claimed'],
          actualAt: row['actual_at'],
          driftMs: row['drift_ms'],
          severity: row['severity'],
          excerpt: row['excerpt'],
        })),
      })
    }),
    // ── 阶段 5：模型与路由 ────────────────────────────────────────────────

    // 聚合模型列表 + 角色映射 + 校验 + 试跑记录
    get('/api/forlife/routes', () => {
      const entries = listModelRoutes(runtime.db)
      const endpoints = listEndpoints(runtime.db)
      const overview = endpointOverview(runtime.db)
      const stats = routingStats(runtime.db, 24)
      const uncertain = uncertainStats(runtime.db)

      // 角色映射：每个角色一条有序候选链（面板就是编辑这个）
      const roles = ROUTE_ROLES.map((role) => {
        const candidates = entries
          .filter((entry) => entry.role === role)
          .sort((a, b) => a.rank - b.rank)
          .map((entry) => ({
            rank: entry.rank,
            provider: entry.provider,
            model: entry.model,
            effort: entry.reasoning_effort,
            enabled: entry.enabled === 1,
            note: entry.note,
            updatedAt: entry.updated_at,
          }))
        return { role, candidates, purpose: ROLE_PURPOSE[role as keyof typeof ROLE_PURPOSE] ?? undefined }
      })

      // 校验：把"保存即报错"的规则也算给面板看（不是等用户点保存才知道）
      const devices = runtime.deviceProbe()
      const issues = endpoints.flatMap((endpoint) =>
        validateEndpoint(
          {
            id: endpoint.id,
            type: endpoint.type as never,
            mode: endpoint.mode as never,
            backend: endpoint.backend as never,
            baseUrl: endpoint.base_url,
            models: JSON.parse(endpoint.models) as never[],
          },
          { devices },
        ).map((issue) => ({ endpoint: endpoint.id, ...issue })),
      )

      return json({
        ok: true,
        roles,
        endpoints: endpoints.map((endpoint) => ({
          id: endpoint.id,
          type: endpoint.type,
          mode: endpoint.mode,
          backend: endpoint.backend,
          baseUrl: endpoint.base_url,
          deployTarget: endpoint.deploy_target,
          deployHost: endpoint.deploy_host,
          models: JSON.parse(endpoint.models) as unknown[],
          health: {
            ok: endpoint.health_ok === 1,
            checkedAt: endpoint.health_checked_at,
            latencyMs: endpoint.health_latency_ms,
            // **实际生效的后端**：有些镜像会静默回落到 CPU
            effectiveBackend: endpoint.effective_backend,
            note: endpoint.health_note,
          },
        })),
        overview,
        // 试跑：最近的真实延迟与是否降级（"一键试跑"的结果落在这里）
        probe: runtime.probeHistory(),
        stats,
        uncertain,
        devices,
        issues,
        tierOverride: runtime.tierOverride() ?? null,
      })
    }),

      // 角色映射编辑：写一行候选（(role, rank) 唯一）
      {
        path: '/api/forlife/routes',
        methods: ['POST'],
        fetch: async (request: Request): Promise<Response> => {
          try {
            const body = (await request.json()) as {
              role?: unknown
              rank?: unknown
              provider?: unknown
              model?: unknown
              effort?: unknown
              enabled?: unknown
              note?: unknown
            }
            const role = typeof body.role === 'string' ? body.role : ''
            if (!(ROUTE_ROLES as readonly string[]).includes(role)) {
              return json({ ok: false, error: `role 必须是 ${ROUTE_ROLES.join(' / ')} 之一` }, 400)
            }
            const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
            const model = typeof body.model === 'string' ? body.model.trim() : ''
            if (provider === '' || model === '') return json({ ok: false, error: 'provider 与 model 必填' }, 400)

            const id = upsertModelRoute(runtime.db, {
              role,
              rank: typeof body.rank === 'number' ? body.rank : 0,
              provider,
              model,
              reasoningEffort: typeof body.effort === 'string' && body.effort !== '' ? body.effort : null,
              enabled: body.enabled !== false,
              note: typeof body.note === 'string' ? body.note : null,
            })
            return json({ ok: true, id })
          } catch (error) {
            return json({ ok: false, error: String(error) }, 400)
          }
        },
      },

      // 删一行候选。
      // 用 POST 而不是 DELETE：宿主的 fetch 注册表**只支持 GET/HEAD/POST**
      // （见 PanelRoute 的 methods 联合类型），DELETE 注册不上去。
      {
        path: '/api/forlife/routes/delete',
        methods: ['POST'],
        fetch: async (request: Request): Promise<Response> => {
          try {
            const body = (await request.json()) as { role?: unknown; rank?: unknown }
            const role = typeof body.role === 'string' ? body.role : ''
            if (role === '') return json({ ok: false, error: '缺少 role' }, 400)
            const rank = typeof body.rank === 'number' ? body.rank : 0
            const removed = deleteModelRoute(runtime.db, role, rank)
            return removed ? json({ ok: true }) : json({ ok: false, error: '没有这一行' }, 404)
          } catch (error) {
            return json({ ok: false, error: String(error) }, 400)
          }
        },
      },

      // 运行模式切换（排水 + 回滚在 runtime 里做；这里只暴露意图与结果）
      {
        path: '/api/forlife/routes/mode',
        methods: ['POST'],
        fetch: async (request: Request): Promise<Response> => {
          try {
            const body = (await request.json()) as { endpointId?: unknown; mode?: unknown; reason?: unknown }
            const endpointId = typeof body.endpointId === 'string' ? body.endpointId : ''
            const mode = typeof body.mode === 'string' ? body.mode : ''
            if (endpointId === '' || mode === '') return json({ ok: false, error: 'endpointId 与 mode 必填' }, 400)
            if (!RUN_MODES.includes(mode as never)) return json({ ok: false, error: `mode 必须是 ${RUN_MODES.join(' / ')} 之一` }, 400)
            if (getEndpoint(runtime.db, endpointId) === undefined) return json({ ok: false, error: '端点不存在' }, 404)
            const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : '面板手动切换'
            const result = await runtime.switchEndpointMode(endpointId, mode as never, reason)
            // result 里已经有 ok，不要再手写一个（TS 会警告，而且真写错时是静默覆盖）
            return json(result)
          } catch (error) {
            return json({ ok: false, error: String(error) }, 400)
          }
        },
      },

      // 一键试跑：真发一次最小请求，记录真实延迟与**实际生效的后端**
      {
        path: '/api/forlife/routes/probe',
        methods: ['POST'],
        fetch: async (request: Request): Promise<Response> => {
          try {
            const body = (await request.json()) as { endpointId?: unknown; model?: unknown }
            const endpointId = typeof body.endpointId === 'string' ? body.endpointId : ''
            if (endpointId === '') return json({ ok: false, error: 'endpointId 必填' }, 400)
            const result = await runtime.probeEndpoint(endpointId, typeof body.model === 'string' ? body.model : undefined)
            return json(result)
          } catch (error) {
            return json({ ok: false, error: String(error) }, 400)
          }
        },
      },
    // 健康与契约信息（面板首页用）
    get('/api/forlife/health', () => json({ ok: true, contracts: contractsSummary(), dbPath: runtime.dbPath })),

    // ── 阶段 3：QQ 网关与后台对话 ─────────────────────────────────────────
    // 面板要能看到"积压了多少、在等什么、为什么没唤醒"，否则排障只能靠猜。

    // 网关概览：队列、轮次、出站统计、传输层连接状态
    get('/api/forlife/qq/state', () => {
      const stats = qqStats(runtime.db)
      return json({ ok: true, ...stats, transport: runtime.transportStatus() })
    }),

    // 出站队列（含失败原因；面板的"积压"表格）
    get('/api/forlife/qq/queue', (url) => {
      const limit = intParam(url, 'limit') ?? 50
      const status = url.searchParams.get('status')
      const rows = listOutbound(runtime.db, limit).filter((row) => status === null || row.status === status)
      return json({
        ok: true,
        count: rows.length,
        stats: outboxStats(runtime.db),
        rows: rows.map((row) => ({
          id: row.id,
          conversation: row.conversation_key,
          kind: row.kind,
          status: row.status,
          conversationKind: row.conversation_kind,
          source: row.source,
          attempt: row.attempt,
          platformMessageId: row.platform_msg_id,
          error: row.error,
          sentAt: row.sent_at,
          claimedAt: row.claimed_at,
          confirmedAt: row.confirmed_at,
          payload: row.payload,
        })),
      })
    }),

    // 轮次时间线（面板的"它什么时候醒过、花了多少 token"）
    get('/api/forlife/qq/turns', (url) => {
      const limit = intParam(url, 'limit') ?? 50
      const rows = runtime.db
        .prepare('SELECT * FROM qq_turns ORDER BY started_at DESC LIMIT ?')
        .all(limit) as unknown as Record<string, unknown>[]
      return json({
        ok: true,
        count: rows.length,
        turns: rows.map((row) => ({
          id: String(row['id']),
          conversation: String(row['conversation_key']),
          status: String(row['status']),
          startedAt: String(row['started_at']),
          endedAt: row['ended_at'] === null ? null : String(row['ended_at']),
          tokensIn: Number(row['tokens_in']),
          tokensOut: Number(row['tokens_out']),
          toolCalls: Number(row['tool_calls']),
          deferReason: row['defer_reason'] === null ? null : String(row['defer_reason']),
          error: row['error'] === null ? null : String(row['error']),
        })),
      })
    }),

    // 唤醒规则（每个条件独立；面板可直接编辑）
    get('/api/forlife/qq/wake-rules', (url) => {
      const scope = url.searchParams.get('scope') ?? '*'
      return json({
        ok: true,
        scope,
        conditions: [...WAKE_CONDITIONS],
        rules: listWakeRules(runtime.db, scope).map((rule) => ({
          scope: rule.scope,
          condition: rule.condition,
          enabled: rule.enabled,
          probability: rule.probability,
          dailyLimit: rule.dailyLimit,
          minIntervalMs: rule.minIntervalMs,
          quietUntil: rule.quietUntil,
          updatedBy: rule.updatedBy,
          updatedAt: rule.updatedAt,
        })),
      })
    }),

    // 唤醒判定留痕（"为什么没醒"的答案就在这里）
    get('/api/forlife/qq/wake-events', (url) => {
      const limit = intParam(url, 'limit') ?? 50
      const rows = runtime.db
        .prepare('SELECT * FROM wake_events ORDER BY at DESC LIMIT ?')
        .all(limit) as unknown as Record<string, unknown>[]
      return json({ ok: true, count: rows.length, events: rows })
    }),

    // 待读池（不唤醒 ≠ 不知道）
    get('/api/forlife/qq/pending', (url) => {
      const limit = intParam(url, 'limit') ?? 50
      const scope = url.searchParams.get('scope')
      const rows = (
        scope === null
          ? runtime.db.prepare('SELECT * FROM pending_messages ORDER BY at DESC LIMIT ?').all(limit)
          : runtime.db.prepare('SELECT * FROM pending_messages WHERE scope = ? ORDER BY at DESC LIMIT ?').all(scope, limit)
      ) as unknown as Record<string, unknown>[]
      return json({ ok: true, count: rows.length, stats: pendingStats(runtime.db), items: rows })
    }),

    // 后台对话（**唯一的人类直发通道**，铁律 2）
    get('/api/forlife/admin/chat', (url) =>
      json({
        ok: true,
        pending: pendingAdminCount(runtime.db),
        count: listAdminChat(runtime.db, intParam(url, 'limit') ?? 100).length,
        messages: listAdminChat(runtime.db, intParam(url, 'limit') ?? 100).map((m) => ({
          id: m.id,
          role: m.role,
          actor: m.actor,
          text: m.text,
          at: m.at,
          handled: m.handled === 1,
          turnId: m.turnId,
          error: m.error,
        })),
      }),
    ),

    // 人类发消息（面板的输入框走这里）
    {
      path: '/api/forlife/admin/chat',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as { text?: unknown; actor?: unknown }
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') return json({ ok: false, error: '消息不能为空' }, 400)
          const actor = typeof body.actor === 'string' && body.actor !== '' ? body.actor : 'admin'
          const id = postHumanMessage(runtime.db, { actor, text })
          // 记进审计：这是"人类直接对模型说话"，要能回答"谁在什么时候说了什么"
          recordAdminAction(runtime.db, { action: 'admin.chat.post', actor: 'admin', subject: actor, detail: { id, chars: text.length } })
          return json({ ok: true, id, queued: true, note: '已入队，网关会在下一轮把它交给模型' })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },

    // 改唤醒规则（后台改 ⇒ 影响模型 ⇒ 进审计 + 等合并报告）
    {
      path: '/api/forlife/qq/wake-rules',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as {
            scope?: unknown
            condition?: unknown
            enabled?: unknown
            probability?: unknown
            dailyLimit?: unknown
            minIntervalMs?: unknown
            quietUntil?: unknown
          }
          const scope = typeof body.scope === 'string' && body.scope !== '' ? body.scope : '*'
          const condition = String(body.condition ?? '')
          if (!(WAKE_CONDITIONS as readonly string[]).includes(condition)) {
            return json({ ok: false, error: `未知的唤醒条件：${condition}` }, 400)
          }
          const rule = setWakeRule(
            runtime.db,
            scope,
            condition as (typeof WAKE_CONDITIONS)[number],
            {
              ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
              ...(typeof body.probability === 'number' ? { probability: body.probability } : {}),
              ...(typeof body.dailyLimit === 'number' ? { dailyLimit: body.dailyLimit } : {}),
              ...(typeof body.minIntervalMs === 'number' ? { minIntervalMs: body.minIntervalMs } : {}),
              ...(typeof body.quietUntil === 'string' ? { quietUntil: body.quietUntil } : {}),
            },
            'admin',
          )
          // 铁律 1：改了唤醒规则 ⇒ 影响模型 ⇒ 记审计（网关会合并成一条报告交给它）
          recordAdminAction(runtime.db, {
            action: 'wake.rule',
            actor: 'admin',
            subject: `${scope}:${condition}`,
            detail: { enabled: rule.enabled, probability: rule.probability },
          })
          return json({ ok: true, rule })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },

    // ── 阶段 4：提示词（可编辑、版本、diff、预览、回滚、按会话覆盖）──────────

    // 两个槽位的当前状态 + 变量白名单
    get('/api/forlife/prompts', () =>
      json({
        ok: true,
        slugs: promptStatus(runtime.db),
        variables: PROMPT_VARIABLES.map((v) => ({
          name: v.name,
          dynamic: v.dynamic,
          description: v.description,
          sample: v.sample,
        })),
        overrides: listPromptOverrides(runtime.db).map((o) => ({
          scope: o.scope,
          slug: o.slug,
          revisionId: o.revision.id,
          sha256: o.revision.sha256,
        })),
      }),
    ),

    // 历史版本（面板的"回滚"列表）
    get('/api/forlife/prompts/revisions', (url) => {
      const slug = (url.searchParams.get('slug') ?? 'p1-system') as PromptSlug
      if (!PROMPT_SLUGS.includes(slug)) return json({ ok: false, error: `未知槽位：${slug}` }, 400)
      const revisions = listPromptRevisions(runtime.db, slug, intParam(url, 'limit') ?? 30)
      const active = activePrompt(runtime.db, slug)
      return json({
        ok: true,
        slug,
        activeId: active?.id ?? null,
        count: revisions.length,
        revisions: revisions.map((r) => ({
          id: r.id,
          sha256: r.sha256,
          tokenCount: r.tokenCount,
          variables: r.variables,
          note: r.note,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          active: r.active,
          // 列表里带上首行摘要，人一眼能认出是哪版
          excerpt: r.text.split('\n').slice(0, 2).join(' ').slice(0, 120),
        })),
      })
    }),

    // 试渲染 + diff（保存前预览"最终拼装结果"与"改了什么"）
    {
      path: '/api/forlife/prompts/preview',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as { slug?: unknown; text?: unknown; variables?: unknown }
          const slug = String(body.slug ?? 'p1-system') as PromptSlug
          if (!PROMPT_SLUGS.includes(slug)) return json({ ok: false, error: `未知槽位：${slug}` }, 400)
          const text = typeof body.text === 'string' ? body.text : ''
          const variables = {
            ...defaultPromptVariables(),
            ...(typeof body.variables === 'object' && body.variables !== null ? (body.variables as Record<string, string>) : {}),
          }

          const validation = validatePromptText(text, { scope: 'prefix' })
          const preview = renderPromptPreview(text, variables)
          const current = activePrompt(runtime.db, slug)
          const normalized = normalizePromptText(text)
          const diff = current === undefined ? [] : diffPromptLines(current.text, normalized)
          return json({
            ok: validation.ok && preview.ok,
            errors: [...validation.errors, ...preview.errors],
            warnings: validation.warnings,
            variables: validation.variables,
            normalized,
            // 规范化后与当前生效版本是否不同 —— 这是"会不会造成一次缓存未命中"的唯一判据
            willChange: current === undefined || current.sha256 !== hashPromptText(normalized),
            currentSha256: current?.sha256 ?? null,
            nextSha256: hashPromptText(normalized),
            tokenCount: estimatePromptTokens(normalized),
            tokenDelta: estimatePromptTokens(normalized) - (current?.tokenCount ?? 0),
            rendered: preview.text,
            diff: diff.map((line) => ({ kind: line.kind, text: line.text })),
          })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },

    // 保存（先校验，后落库；返回 diff 与缓存影响提示）
    {
      path: '/api/forlife/prompts',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as { slug?: unknown; text?: unknown; note?: unknown }
          const slug = String(body.slug ?? 'p1-system') as PromptSlug
          if (!PROMPT_SLUGS.includes(slug)) return json({ ok: false, error: `未知槽位：${slug}` }, 400)
          const text = typeof body.text === 'string' ? body.text : ''
          const previous = activePrompt(runtime.db, slug)
          const result = savePromptRevision(runtime.db, {
            slug,
            text,
            createdBy: 'admin',
            ...(typeof body.note === 'string' ? { note: body.note } : {}),
          })
          if (!result.ok) return json({ ok: false, errors: result.errors }, 400)
          if (!result.changed) {
            return json({ ok: true, changed: false, revision: result.revision, note: '内容与当前生效版本一致（规范化后），没有产生新版本。' })
          }

          // 铁律 1：改提示词**直接影响模型**（比改记忆更直接）⇒ 记审计，等合并报告
          recordAdminAction(runtime.db, {
            action: 'prompt.edit',
            actor: 'admin',
            subject: slug,
            detail: { from: previous?.sha256 ?? null, to: result.revision.sha256, tokens: result.revision.tokenCount },
          })
          runtime.invalidatePromptCache()

          const diff = previous === undefined ? [] : diffPromptLines(previous.text, result.revision.text)
          return json({
            ok: true,
            changed: true,
            revision: result.revision,
            previousSha256: previous?.sha256 ?? null,
            diff: diff.map((line) => ({ kind: line.kind, text: line.text })),
            // 面板必须明说这件事：改动本身是"一次缓存未命中"，不是 bug
            cacheNote: '此改动将导致**一次**缓存未命中（下一轮前缀变化），之后恢复稳定。',
            effective: '下一轮生效（无需重启）。',
          })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },

    // 一键回滚
    {
      path: '/api/forlife/prompts/rollback',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as { revisionId?: unknown }
          const revisionId = String(body.revisionId ?? '')
          const target = promptRevisionById(runtime.db, revisionId)
          if (target === undefined) return json({ ok: false, error: '找不到该版本' }, 404)
          const rolled = rollbackPrompt(runtime.db, revisionId)
          if (rolled === undefined) return json({ ok: false, error: '回滚失败' }, 500)
          recordAdminAction(runtime.db, {
            action: 'prompt.edit',
            actor: 'admin',
            subject: rolled.slug,
            detail: { rollbackTo: revisionId, sha256: rolled.sha256 },
          })
          runtime.invalidatePromptCache()
          return json({ ok: true, revision: rolled, cacheNote: '回滚同样会造成一次缓存未命中。', effective: '下一轮生效。' })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },

    // 按会话覆盖 P2（作用域遮蔽）
    {
      path: '/api/forlife/prompts/overrides',
      methods: ['POST'],
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = (await request.json()) as { scope?: unknown; slug?: unknown; revisionId?: unknown; clear?: unknown }
          const scope = String(body.scope ?? '')
          if (scope === '') return json({ ok: false, error: '必须给作用域（例如 group:88888）' }, 400)
          const slug = String(body.slug ?? 'p2-style') as PromptSlug

          if (body.clear === true) {
            const cleared = clearPromptOverride(runtime.db, scope, slug)
            recordAdminAction(runtime.db, { action: 'prompt.edit', actor: 'admin', subject: `${scope}:${slug}`, detail: { cleared: true } })
            runtime.invalidatePromptCache()
            return json({ ok: true, cleared })
          }

          const revisionId = String(body.revisionId ?? '')
          if (revisionId === '') return json({ ok: false, error: '必须给 revisionId' }, 400)
          const done = setPromptOverride(runtime.db, { scope, slug, revisionId, createdBy: 'admin' })
          if (!done) return json({ ok: false, error: '写入覆盖失败（版本不存在或槽位不匹配）' }, 400)
          recordAdminAction(runtime.db, { action: 'prompt.edit', actor: 'admin', subject: `${scope}:${slug}`, detail: { revisionId } })
          runtime.invalidatePromptCache()
          return json({
            ok: true,
            note:
              '已按会话覆盖回答风格。注意：多会话共用一个窗口时，覆盖值走**尾部注入**而不是写进稳定前缀 —— ' +
              '写进前缀会让每轮都换前缀，缓存全废。',
          })
        } catch (error) {
          return json({ ok: false, error: String(error) }, 400)
        }
      },
    },
  ]
}

/** 提示词变量的当前取值（面板预览要用真实值）。 */
function defaultPromptVariables(): Record<string, string> {
  return {
    persona_name: defaultFor<string>('prompt.variables.personaName'),
    owner_name: defaultFor<string>('prompt.variables.ownerName'),
    language: defaultFor<string>('prompt.variables.language'),
    persona_role: defaultFor<string>('prompt.variables.personaRole'),
    style_notes: defaultFor<string>('prompt.variables.styleNotes'),
  }
}

/** QQ 侧统计（面板概览用）。 */
function qqStats(db: MemoryRuntime['db']): {
  readonly sessions: number
  readonly inbound: number
  readonly inboundPending: number
  readonly turnsRunning: number
  readonly turnsDeferred: number
  readonly outbox: ReturnType<typeof outboxStats>
  readonly pendingUnread: number
} {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    sessions: count('SELECT count(*) AS n FROM qq_sessions'),
    inbound: count('SELECT count(*) AS n FROM qq_inbox'),
    inboundPending: count('SELECT count(*) AS n FROM qq_inbox WHERE processed = 0'),
    turnsRunning: count("SELECT count(*) AS n FROM qq_turns WHERE status = 'running'"),
    turnsDeferred: count("SELECT count(*) AS n FROM qq_turns WHERE status = 'deferred'"),
    outbox: outboxStats(db),
    pendingUnread: count('SELECT count(*) AS n FROM pending_messages WHERE read = 0'),
  }
}

/**
 * 注册全部面板路由。
 *
 * @param registry - `ctx.connection.fetch`。
 * @param runtime - 记忆运行时。
 * @returns 反注册函数（逐个等待 disposer 完成）。
 */
export function registerPanelRoutes(registry: FetchRegistryLike, runtime: MemoryRuntime): () => Promise<void> {
  const disposers = buildPanelRoutes(runtime).map((route) =>
    registry.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: route.fetch,
    }),
  )
  return async (): Promise<void> => {
    await Promise.all(disposers.map(async (dispose) => dispose()))
  }
}











