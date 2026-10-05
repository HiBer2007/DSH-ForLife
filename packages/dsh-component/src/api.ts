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
import type { MemoryRuntime } from './runtime.ts'
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
  ]
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




