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
  ]
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



