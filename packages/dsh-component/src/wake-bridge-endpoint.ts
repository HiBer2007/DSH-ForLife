/**
 * 唤醒桥端点（PLAN 阶段 8 交付物 2 的插件一侧）。
 *
 * ## 职责被严格限定（调研报告 §10.3）
 *
 * 这层薄桥**只做四件事**：
 *   1. 校验共享密钥；
 *   2. `resolveAgent(sessionId)`（冷会话会被 resume）；
 *   3. 若 agent 空闲 ⇒ `followup(createUserMessage(...))`；否则如实回报"忙"；
 *   4. `sessions.flush(...)` 确认落盘，再把结果回报给 gateway。
 *
 * **其余全部逻辑（任务表、监视器、守护、限流、QQ 协议）都在 gateway。**
 * 把逻辑往这边挪的诱惑很大（这边离 agent 近），但那样会分裂成两套状态，
 * 而"谁决定该不该唤醒"这件事一旦有两个答案，就再也查不清了。
 *
 * ## 两个必须守住的性质
 *
 * 1. **不用 `ctx.sessionController.prompt()`** —— 报告 §5 指出它把 source 写成 `'user'`，
 *    于是"系统唤醒"在会话里**看起来像用户发的消息**。这会污染对话历史，
 *    也让模型误以为用户在说话。必须用 `followup` + 自定义 source。
 * 2. **`flush` 失败要如实回报** —— 不 flush 的话，唤醒的那一轮可能没落盘；
 *    宿主重启后这段历史就没了，而 gateway 以为"已经唤醒过了"。
 *
 * ## 为什么用依赖注入而不是直接吃 ctx
 *
 * 直接 `ctx.agents.withoutInitiator(...)` 的话，这段逻辑**只能靠真 DSH 验证** ——
 * 而它恰恰是最需要测试的部分（密钥校验、忙/闲判断、flush 失败处理）。
 * 注入三个窄接口之后，这些分支都能用假对象测。
 *
 * @module forlife-memory/wake-bridge-endpoint
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// ★ 迁移到七级：`atLevel` 是那个桥（注入普通函数时退化成调它自己，**不碰调用方**）
import { atLevel } from '@forlife/gateway'

/** 桥要用的宿主能力（窄接口，便于注入与测试）。 */
export interface WakeHost {
  /** 按 id 取 agent（冷会话会被 resume）。取不到时返回 undefined。 */
  readonly resolveAgent: (
    sessionId: string,
  ) => Promise<
    | {
        readonly agent: {
          readonly status: string
          readonly followup: (message: unknown) => void
          readonly session: unknown
        }
      }
    | undefined
  >
  /** 把会话刷到盘上；返回 false 表示没刷成功。 */
  readonly flush: (session: unknown) => Promise<boolean>
  /** 构造一条"不是用户发的"消息。 */
  readonly createMessage: (input: {
    readonly text: string
    readonly sourceKind: string
    readonly summary: string
  }) => unknown
  /** 在"无发起者"上下文里跑（避免把这次唤醒归因到某个用户）。 */
  readonly withoutInitiator: <T>(fn: () => Promise<T>) => Promise<T>
}

/** 端点配置。 */
export interface WakeEndpointOptions {
  /** 共享密钥（必须非空）。 */
  readonly secret: string
  readonly host: WakeHost
  readonly log?: (message: string) => void
}

/** 一次请求的结果。 */
export interface WakeEndpointResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** 请求体（宽松解析，逐字段校验）。 */
interface WakeRequestBody {
  readonly sessionId?: unknown
  readonly text?: unknown
  readonly sourceKind?: unknown
  readonly summary?: unknown
  readonly dryRun?: unknown
}

/** 把文本包成内容块（备用：宿主不支持自定义 source 时的降级路径）。 */
export function textBlocks(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * 处理一次唤醒请求。
 *
 * @returns HTTP 状态码与响应体（由调用方写回）。
 */
export async function handleWakeRequest(
  options: WakeEndpointOptions,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<WakeEndpointResult> {
  const log = options.log ?? ((): void => {})

  // ① 密钥：**fail-closed**。报告写明 ctx.webServer 自身无 TLS、无认证，
  //    所以校验必须由我们加 —— 而"叫醒模型并让它执行提示词"的端点
  //    没有认证就是本机任何进程都能利用的提权入口。
  if (options.secret.trim() === '') {
    // ★★ **fault**：这不是"某一次请求被拒"，而是**这一整个端点处于禁用状态** ——
    //   唤醒桥这一子系统不可用（谁也唤不醒她），而且**会一直这样**直到有人配密钥。
    //   ⚠️ 它以前是裸 `log(...)` ⇒ 面板上显示成 **info**，而 `guessLevel` 也救不了它
    //   （文本里没有"失败/异常"字样）—— 也就是**一条安全相关的禁用状态，
    //   在日志里长得像普通信息**。
    atLevel(log, 'fault')('唤醒桥拒绝：未配置密钥（空密钥等于没有认证）—— 端点已禁用（503）')
    return { status: 503, body: { ok: false, reason: '唤醒桥未配置密钥，已禁用' } }
  }
  const provided = headers['x-forlife-wake-secret']
  if (provided !== options.secret) {
    // ★ **warn**：**有东西在敲门而钥匙不对** —— 可能是配置漂移（客户端与容器不同步），
    //   也可能是有人在试。它被**拒绝了**（兜住了）⇒ warn，不是 error。
    //   ⚠️ 以前也是裸调用 ⇒ 面板上是 **info**：**一次安全拒绝显示成普通信息**
    //   ⇒ 排障时"为什么唤醒没生效"与"有人在爆破"这两种情形**在面板上分不出来**。
    atLevel(log, 'warn')('唤醒桥拒绝：密钥不匹配（401）')
    // 不回显期望值，也不区分"没给"与"给错了" —— 那会给爆破提供信息
    return { status: 401, body: { ok: false, reason: '密钥不正确' } }
  }

  // ② 解析
  let body: WakeRequestBody
  try {
    body = JSON.parse(rawBody) as WakeRequestBody
  } catch {
    return { status: 400, body: { ok: false, reason: '请求体不是 JSON' } }
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const text = typeof body.text === 'string' ? body.text : ''
  const sourceKind = typeof body.sourceKind === 'string' && body.sourceKind !== '' ? body.sourceKind : 'wake'
  const summary = typeof body.summary === 'string' ? body.summary : '系统唤醒'
  if (sessionId === '') return { status: 400, body: { ok: false, reason: 'sessionId 必填' } }
  if (text.trim() === '') return { status: 400, body: { ok: false, reason: 'text 必填' } }

  // ③ 取 agent
  const resolved = await options.host.withoutInitiator(async () => options.host.resolveAgent(sessionId))
  if (resolved === undefined) {
    return { status: 404, body: { ok: false, reason: `找不到会话：${sessionId}` } }
  }

  // ④ 忙就不打断。**如实回报"忙"，不静默成功** ——
  //    gateway 那边要据此决定是重试还是记成被拦，而不是以为已经唤醒了。
  if (resolved.agent.status !== 'idle') {
    return { status: 200, body: { ok: false, reason: `会话正忙（status=${resolved.agent.status}），未打断` } }
  }

  if (body.dryRun === true) {
    return { status: 200, body: { ok: true, modelDid: '(演练：未真的唤醒)' } }
  }

  // ⑤ 注入。**用自定义 source**，不用 sessionController.prompt()
  //    （那个会把 source 写成 'user'，让系统唤醒看起来像用户发言）。
  const message = options.host.createMessage({ text, sourceKind, summary })
  resolved.agent.followup(message)

  // ⑥ 确认落盘。不 flush 的话，这一轮可能没写进盘，
  //    宿主重启后这段历史就没了，而 gateway 以为"已经唤醒过了"。
  const flushed = await options.host.flush(resolved.agent.session)
  if (!flushed) {
    return { status: 500, body: { ok: false, reason: '唤醒已注入，但会话落盘失败 —— 重启后这一轮可能丢失' } }
  }

  log(`已唤醒会话 ${sessionId}（${sourceKind}）`)
  return { status: 200, body: { ok: true, modelDid: summary } }
}

/**
 * 用宿主的 `ctx.webServer.register` 挂上这个端点。
 *
 * @returns 注销函数。
 */
export function registerWakeEndpoint(
  webServer: {
    readonly register: (route: {
      readonly kind: 'exact'
      readonly path: string
      readonly handler: (req: {
        readonly headers: Record<string, string | undefined>
        readonly body?: string
      }) => Promise<{ readonly status: number; readonly body: unknown }>
    }) => () => void
  },
  options: WakeEndpointOptions & { readonly path?: string },
): () => void {
  return webServer.register({
    kind: 'exact',
    path: options.path ?? '/forlife/wake',
    handler: async (req) => {
      const result = await handleWakeRequest(options, req.headers, req.body ?? '')
      return { status: result.status, body: result.body }
    },
  })
}
