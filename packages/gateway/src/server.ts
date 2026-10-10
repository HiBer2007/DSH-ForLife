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
import { createPortRuntime } from './port-runtime.ts'
import type { PortService } from './port-service.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openDatabase } from '@forlife/store'

import { createAdminApi } from './admin/api.ts'
import { LEGACY_LOG_MODULE, LogBuffer, guessLevel } from './admin/log-buffer.ts'
// ★ 七级 + "存哪些"的判定（用户 2026-10-10 指定的分级制度）
import { disabledLevelsFromEnv } from './admin/log-levels.ts'
// ★ 结构化日志的落点（`createLogger()` 产出的记录从这里进来）
import { installLogSink } from './admin/log.ts'
// ★ 落盘 + 保留期（用户 2026-10-10「可以设置保留事件」）
import { createLogStore, resolveLogDir, retentionDaysFromEnv } from './admin/log-store.ts'
import { redact } from './redact.ts'
import { serveStatic } from './admin/static.ts'
import { startGatewayRuntime, type RunningGatewayRuntime } from './runtime.ts'

/** 服务选项。 */
export interface AdminServerOptions {
  /** 数据库文件路径。 */
  readonly dbPath: string
  /** 前端产物目录。 */
  readonly distRoot: string
  readonly host?: string
  readonly port?: number
  readonly log?: (message: string) => void
  readonly sessionTtlMs?: number
  /** NapCat WebUI 的位置（面板里内嵌它做扫码登录）。 */
  readonly napcat?: { readonly webuiPort: number; readonly token?: string | undefined } | undefined
    /**
     * 端口出口（PLAN 阶段 7）。
     *
     * 未配置 Caddy 时给 `{ whitelist }`（service 为 undefined）——
     * 界面据此**禁用按钮并显示原因**，而不是等一次失败去推断。
     */
    readonly ports?:
      | {
          readonly service?: PortService | undefined
          readonly disabledReason?: string | undefined
          readonly whitelist: readonly { readonly from: number; readonly to: number }[]
        }
      | undefined
  /**
   * 给了就同时起 QQ 链路（OneBot 反向 WS + 网关 + 轮次）。
   * 不给则只跑管理后台 —— 两种模式都能单独工作，排障时能分清是谁的问题。
   */
  readonly onebot?:
    | {
        readonly port: number
        readonly host: string
        readonly path: string
        readonly accessToken?: string | undefined
        readonly driver: 'headless' | 'fake'
        readonly dshHome?: string | undefined
        readonly profile?: string | undefined
        readonly disableNoiseFilter?: boolean
      }
    | undefined
}

/** 严进严出的安全头（每个请求都加）。CSP 单独构造，见 `buildCsp`。 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // 面板不需要这些能力，直接关掉（能用就用不上，关掉更安全）
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
}

/**
 * 构造 CSP。
 *
 * `frame-src` 要放行 NapCat 的 WebUI（面板里内嵌了它），但**必须按当前主机名精确放行**：
 * 图省事写 `frame-src http:` 等于允许页面嵌入任意站点，那就白设了。
 * 主机名取自请求的 `Host`，所以手机访问时放行的正是手机能访问到的那个地址。
 */
function buildCsp(hostname: string, napcatPort: number | undefined): string {
  const frameSrc =
    napcatPort === undefined
      ? "'self'"
      : `'self' http://${hostname}:${String(napcatPort)} http://127.0.0.1:${String(napcatPort)}`
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // 我们自己绝不被任何站点套框（注意与 frame-src 是两件事）
    "frame-ancestors 'none'",
  ].join('; ')
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
  // 面板的「实时日志」页读的是这个**内存缓冲**（不读日志文件：
  // 文件位置随部署形态变、还可能被轮转截断，而"最近发生了什么"才是排障要的）
  const logBuffer = new LogBuffer(500)
  /**
   * 落盘那一侧（用户 2026-10-10：「可以设置**保留事件**」）。
   *
   * 目录：`FORLIFE_LOG_DIR` → 否则从 `FORLIFE_DB_PATH` 推 → 否则进程目录下的 `.forlife/logs`
   * （**可移植**：绝不碰宿主 `~`）。保留天数：`FORLIFE_LOG_RETENTION_DAYS`，`0` = 不裁剪。
   * 关掉哪些等级：`FORLIFE_LOG_DISABLE`（默认只关 `debug`）。
   */
  const logStore = createLogStore({
    dir: resolveLogDir(process.env),
    retentionDays: retentionDaysFromEnv(process.env['FORLIFE_LOG_RETENTION_DAYS']),
    disabledLevels: disabledLevelsFromEnv(process.env['FORLIFE_LOG_DISABLE']).disabled,
    onError: (message) => {
      // 落盘自己出错时**只喊到 stdout**（再往缓冲里写会递归）
      options.log?.(`[forlife] ${message}`)
    },
  })
  /**
   * **唯一的日志汇聚点** —— 脱敏放在这里，两条出口就都被覆盖。
   *
   * 挂在某一个出口上是不够的：漏掉的那条照样把原文写进日志文件，
   * 而**日志一旦写下去就收不回来了**（会被复制、打包、发给别人看）。
   *
   * 这也正是 `log-buffer.ts` 那条判断的落点：
   * "脱敏属于**写入侧**的职责" —— 这里就是写入侧。
   *
   * ## ★ 2026-10-10：现在有**两条**入口，级别真假不同
   *
   * | 入口 | 谁在用 | 级别 |
   * | :--- | :--- | :--- |
   * | 这个 `log(message)` | **127 处旧调用点** | **猜的**（只 `info`/`warn`/`error`） |
   * | {@link installLogSink} 那个回调 | `createLogger(module)` | **真的**（七级 + 模块） |
   *
   * 两条都写**同一个缓冲**与**同一个落盘**，所以面板与文件里是混在一起的。
   * 旧调用点先猜着，是为了"**不改完 127 处也能跑**"—— 但**不许长期如此**
   * （真正的 `fault`/`crash` 写成裸字符串就永远筛不出来）。
   */
  const log = (message: string): void => {
    const safe = redact(message)
    // ★ 猜测只做**一次**，缓冲与落盘用同一个结果 ——
    //   各猜一次会让同一行在两处显示成不同等级（面板与文件对不上，最难查）
    const at = new Date().toISOString()
    const record = { level: guessLevel(safe), module: LEGACY_LOG_MODULE, text: safe, at }
    logBuffer.pushRecord(record)
    logStore.write(record)
    options.log?.(safe)
  }
  /**
   * ★ 把 `createLogger()` 的结构化记录接到**同样的两条出口**上。
   *
   * 用 `installLogSink` 而不是给每个调用点传 logger：127 处调用点不该各自知道
   * "日志去哪"。落点在 `start()` 里装、在服务关闭时卸 —— 否则
   * **测试之间会互相串**（上一轮装的落点还在，把这一轮的日志写进上一个临时目录）。
   */
  const uninstallLogSink = installLogSink((record) => {
    const safe = { ...record, text: redact(record.text) }
    logBuffer.pushRecord(safe)
    logStore.write(safe)
    options.log?.(safe.text)
  })
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8081
  const startedAt = Date.now()

  return {
    async start(): Promise<RunningAdminServer> {
      const opened = openDatabase({ file: options.dbPath, log })
      const db = opened.db

  // 端口出口（PLAN 阶段 7）。没配 FORLIFE_CADDY_ADMIN / FORLIFE_PUBLIC_HOST 时
  // service 为 undefined —— 功能**明确禁用**，而不是等一次失败去推断
  // （"配置失败"会让人去排查 Caddy，而其实是根本没配）。
  const portRuntime =
    options.ports ??
    createPortRuntime({ db, env: process.env, log })

      // QQ 链路先起：管理后台要能立刻反映它的真实连接状态（而不是等第一次请求才发现没连上）
      let runtime: RunningGatewayRuntime | undefined
      if (options.onebot !== undefined) {
        runtime = await startGatewayRuntime({
          db,
          log,
          onebot: {
            port: options.onebot.port,
            host: options.onebot.host,
            path: options.onebot.path,
            accessToken: options.onebot.accessToken,
          },
          driver: options.onebot.driver,
          ...(options.onebot.dshHome === undefined && options.onebot.profile === undefined
            ? {}
            : {
                headless: {
                  dshHome: options.onebot.dshHome,
                  profile: options.onebot.profile,
                },
              }),
          ...(options.onebot.disableNoiseFilter === true ? { disableNoiseFilter: true } : {}),
        })
      }

      const api = createAdminApi({
        db,
        dbPath: options.dbPath,
        startedAt,
        log,
        // 真实连接状态：没有 runtime 时返回 undefined（= 本服务没接管，界面显示"—"而不是"离线"）
        transportConnected: runtime === undefined ? undefined : () => runtime.transport.status().connected,
        ...(options.napcat === undefined ? {} : { napcat: options.napcat }),
      ports: portRuntime,
        logBuffer,
        ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
      })

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // 安全头先写，任何分支（含 404/500）都带上
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
        const hostname = (req.headers.host ?? 'localhost').split(':')[0] ?? 'localhost'
        res.setHeader('content-security-policy', buildCsp(hostname, options.napcat?.webuiPort))

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

      // ★★ **保留期必须真的跑一次**，否则 `log-store.ts` 那套只是摆设
      //    （本仓栽过这个跟头："函数写好了、测试全绿、线上根本没跑"）。
      //    放在启动时：进程活着期间最多留到次日；重启即清 —— 对"保留 N 天"够用，
      //    而**不引入一个定时器**（一个为清理日志而常驻的定时器，本身就是新的故障源）。
      const pruned = logStore.prune()
      if (pruned > 0) log(`日志保留期：已清理 ${String(pruned)} 个过期日志文件（保留 ${String(retentionDaysFromEnv(process.env['FORLIFE_LOG_RETENTION_DAYS']))} 天）`)
      log(`日志落盘：${resolveLogDir(process.env)}`)

      return {
        server,
        port: actualPort,
        host,
        dbPath: options.dbPath,
        close: async (): Promise<void> => {
          // ★ **先卸落点**：不卸的话它会一直指着这个已经关掉的 server
          //   （测试里表现为"上一轮的日志写进这一轮的目录"）
          uninstallLogSink()
          await runtime?.stop()
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
  napcat?: { webuiPort: number; token?: string | undefined }
  onebot?: {
    port: number
    host: string
    path: string
    accessToken?: string | undefined
    driver: 'headless' | 'fake'
    dshHome?: string | undefined
    profile?: string | undefined
    disableNoiseFilter?: boolean
  }
} {
  const dbPath =
    env['FORLIFE_DB'] ??
    fileURLToPath(new URL('../../../.runtime/dsh/forlife/db/forlife.sqlite', import.meta.url))
  const distRoot = env['FORLIFE_ADMIN_DIST'] ?? fileURLToPath(new URL('../../admin-ui/dist', import.meta.url))

  const base = {
    dbPath,
    distRoot,
    host: env['FORLIFE_ADMIN_HOST'] ?? '127.0.0.1',
    port: Number(env['FORLIFE_ADMIN_PORT'] ?? '8081'),
  }

  // NapCat 的 WebUI 位置：面板里内嵌它做扫码登录。
  // 给了端口就同时放行 CSP 的 frame-src（见 buildCsp）—— 没给则 CSP 保持最严。

  const napcatPort = Number(env['FORLIFE_NAPCAT_WEBUI_PORT'] ?? '0')
  const napcatToken = env['FORLIFE_NAPCAT_TOKEN']
  const napcat =
    napcatPort > 0
      ? {
          webuiPort: napcatPort,
          ...(napcatToken === undefined || napcatToken === '' ? {} : { token: napcatToken }),
        }
      : undefined

  // QQ 链路默认**不开**：只有显式设置 FORLIFE_ONEBOT=1 才起。
  // 这样"只想看面板"的场景不会因为 QQ 连不上而受影响。
  if (env['FORLIFE_ONEBOT'] !== '1') return { ...base, ...(napcat === undefined ? {} : { napcat }) }

  const token = env['FORLIFE_ONEBOT_TOKEN']
  const dshHome = env['FORLIFE_DSH_HOME']
  const profile = env['FORLIFE_DSH_PROFILE']
  const timeout = Number(env['FORLIFE_TURN_TIMEOUT_MS'] ?? '0')
  return {
    ...base,
    ...(napcat === undefined ? {} : { napcat }),
    onebot: {
      port: Number(env['FORLIFE_ONEBOT_PORT'] ?? '3010'),
      // 默认绑 0.0.0.0：NapCat 在容器里，必须能从外面连进来（accessToken 是唯一门槛）
      host: env['FORLIFE_ONEBOT_HOST'] ?? '0.0.0.0',
      path: env['FORLIFE_ONEBOT_PATH'] ?? '/',
      ...(token === undefined || token === '' ? {} : { accessToken: token }),
      driver: env['FORLIFE_DRIVER'] === 'headless' ? 'headless' : 'fake',
      ...(dshHome === undefined ? {} : { dshHome }),
      ...(profile === undefined ? {} : { profile }),
      ...(timeout > 0 ? { timeoutMs: timeout } : {}),
      ...(env['FORLIFE_NOISE'] === 'off' ? { disableNoiseFilter: true } : {}),
    },
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
    ...(config.onebot === undefined ? {} : { onebot: config.onebot }),
    // 漏传这个会让 CSP 的 frame-src 停在 'self'，内嵌的 NapCat 页会白屏
    ...(config.napcat === undefined ? {} : { napcat: config.napcat }),
  }).start()

  // 局域网测试时会绑 0.0.0.0，这条提示必须显眼：那意味着同网段都能访问登录页
  const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost'
  log(`[admin] 管理后台已启动：http://${config.host}:${running.port}/admin/`)
  log(`[admin] 数据库：${running.dbPath}`)
  log(`[admin] 前端产物：${config.distRoot}`)
  if (exposed) {
    log(`[admin] ⚠ 已绑定 ${config.host}：同网段设备都能打开登录页（口令是唯一门槛，请用强口令）`)
  }
  if (config.onebot === undefined) {
    log('[admin] QQ 链路未启用（要启用请设 FORLIFE_ONEBOT=1）')
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
