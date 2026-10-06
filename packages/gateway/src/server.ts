/**
 * gateway 服务进程 —— 单进程单端口，同时提供管理后台（`/admin`）与它的接口（`/api/admin/*`）。
 *
 * ## 为什么是"单进程单端口"
 *
 * 抄 AstrBot 的第 1 条（计划 §1.3）：前端产物内嵌、接口与页面同源。
 * 好处是部署简单（Caddy 一条 `reverse_proxy` 规则就够）、没有跨域、cookie 天然同源。
 *
 * ## 安全响应头
 *
 * CSP 用**严格版**：`script-src 'self'`（所以主题引导是独立文件而不是内联脚本）、
 * `frame-ancestors 'none'`（禁止被任何站点套框，避免点击劫持）、`base-uri 'none'`。
 * `style-src` 保留 `'unsafe-inline'`：Vue 的 scoped 样式与 `:style` 绑定需要它，
 * 而样式注入的危害远小于脚本注入。
 *
 * @module @forlife/gateway/server
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from './admin/api.ts'
import { serveStatic } from './admin/static.ts'

/** 服务选项。 */
export interface AdminServerOptions {
  /** 数据库文件路径。 */
  readonly dbPath: string
  /** 前端产物目录。 */
  readonly distRoot: string
  readonly host?: string
  readonly port?: number
  readonly log?: (message: string) => void
  readonly transportConnected?: (() => boolean | undefined) | undefined
  readonly sessionTtlMs?: number
}

/** 严进严出的安全头（每个请求都加）。 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // 面板不需要这些能力，直接关掉（能用就用不上，关掉更安全）
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
}

/** 已启动的服务。 */
export interface RunningAdminServer {
  readonly server: Server
  readonly port: number
  readonly host: string
  readonly dbPath: string
  close: () => Promise<void>
}

/** 创建（但不启动）管理后台服务。 */
export function createAdminServer(options: AdminServerOptions): {
  start: () => Promise<RunningAdminServer>
} {
  const log = options.log ?? ((): void => {})
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8081
  const startedAt = Date.now()

  return {
    async start(): Promise<RunningAdminServer> {
      const opened = openDatabase({ file: options.dbPath, log })
      const db = opened.db

      const api = createAdminApi({
        db,
        dbPath: options.dbPath,
        startedAt,
        log,
        transportConnected: options.transportConnected,
        ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
      })

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // 安全头先写，任何分支（含 404/500）都带上
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)

        void (async () => {
          try {
            if (await api(req, res)) return
            if (await serveStatic(req, res, { root: options.distRoot })) return
            // 根路径给一个指路牌，避免访问 `:8081/` 看到一片空白
            if (req.url === '/' || req.url === '') {
              res.writeHead(302, { location: '/admin/' })
              res.end()
              return
            }
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
          } catch (error) {
            log(`[admin] 请求处理失败 ${req.method ?? ''} ${req.url ?? ''}: ${String(error)}`)
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            }
            res.end(JSON.stringify({ error: '服务器内部错误' }))
          }
        })()
      })

      // 慢速请求不该永久占着连接（公网入口必须考虑）
      server.headersTimeout = 30_000
      server.requestTimeout = 60_000
      server.keepAliveTimeout = 15_000

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })

      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port

      return {
        server,
        port: actualPort,
        host,
        dbPath: options.dbPath,
        close: async (): Promise<void> => {
          await new Promise<void>((resolve) => server.close(() => resolve()))
          db.close()
        },
      }
    },
  }
}

/** 解析运行参数（环境变量优先，其次仓库内默认值 —— 绝不碰宿主 `~/.dsh`）。 */
export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): {
  dbPath: string
  distRoot: string
  host: string
  port: number
} {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const dbPath =
    env['FORLIFE_DB'] ??
    fileURLToPath(new URL('../../../.runtime/dsh/forlife/db/forlife.sqlite', import.meta.url))
  const distRoot = env['FORLIFE_ADMIN_DIST'] ?? fileURLToPath(new URL('../../admin-ui/dist', import.meta.url))
  return {
    dbPath,
    distRoot,
    host: env['FORLIFE_ADMIN_HOST'] ?? '127.0.0.1',
    port: Number(env['FORLIFE_ADMIN_PORT'] ?? '8081'),
  }
}

/** CLI 入口：`node --experimental-strip-types packages/gateway/src/server.ts`。 */
async function main(): Promise<void> {
  const config = resolveRuntimeConfig()
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`)
  }

  const running = await createAdminServer({
    dbPath: config.dbPath,
    distRoot: config.distRoot,
    host: config.host,
    port: config.port,
    log,
  }).start()

  // 局域网测试时会绑 0.0.0.0，这条提示必须显眼：那意味着同网段都能访问登录页
  const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost'
  log(`[admin] 管理后台已启动：http://${config.host}:${running.port}/admin/`)
  log(`[admin] 数据库：${running.dbPath}`)
  log(`[admin] 前端产物：${config.distRoot}`)
  if (exposed) {
    log(`[admin] ⚠ 已绑定 ${config.host}：同网段设备都能打开登录页（口令是唯一门槛，请用强口令）`)
  }

  const shutdown = async (signal: string): Promise<void> => {
    log(`[admin] 收到 ${signal}，正在关闭…`)
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 仅在被直接执行时启动（被 import 时不启动，方便测试）。
// 注意：必须用 `pathToFileURL` 构造比较对象。手拼 `file://${path}` 在 Windows 上
// 会得到两个斜杠，而 `import.meta.url` 是三个（`file:///D:/...`），永远不相等 ——
// 表现就是"进程正常退出、日志一片空白"，极难查。
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  void main()
}
