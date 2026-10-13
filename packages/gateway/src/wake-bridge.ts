/**
 * 唤醒桥客户端（PLAN 阶段 8 交付物 2 的 gateway 一侧）。
 *
 * ## 桥是什么，为什么必须有
 *
 * gateway **无法从外部调 `agent.followup()`** —— 那是 DSH 进程内的对象方法。
 * 所以插件侧要暴露一个 **loopback 端点**，gateway 通过它请求"叫醒某个会话"。
 * 调研报告 §10.3 把这层薄桥的职责限定得很死：
 * 只做 `resolveAgent` → `followup` → `sessions.flush`，**其余全部逻辑在 gateway**。
 *
 * ## 为什么必须带共享密钥
 *
 * 报告明确写了：`ctx.webServer` **自身无 TLS、无认证**
 * （`dsh-host-webserver\README.zh.md:113`）。
 * 一个没有认证的"叫醒模型并让它执行提示词"的端点，是本机任何进程都能利用的
 * **提权入口** —— 所以密钥校验必须由我们自己加，而且**失败要 fail-closed**。
 *
 * ## 为什么"桥断了"不能当成"唤醒成功"
 *
 * 桥不通时如果静默返回成功，`wake_events` 里会记成 `fired`，
 * 面板显示"已唤醒"而模型**根本没动** —— 这类假成功比明确的失败难查得多。
 * 所以连不上就是失败，并如实写进事件。
 *
 * @module @forlife/gateway/wake-bridge
 */
import type { FetchLike } from './sticker-vision.ts'

/** 桥的一次调用结果。 */
export interface BridgeResult {
  readonly ok: boolean
  readonly reason: string
  /** 模型这次做了什么（桥回报的摘要，面板要显示）。 */
  readonly modelDid?: string
}

/** 桥客户端配置。 */
export interface WakeBridgeOptions {
  /** 桥的地址，如 `http://127.0.0.1:3080/forlife/wake`。 */
  readonly url: string
  /** 共享密钥（必须非空 —— 空密钥等于没有认证）。 */
  readonly secret: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}

/** 桥客户端。 */
export interface WakeBridge {
  /** 请求叫醒一个会话。 */
  readonly wake: (input: {
    readonly sessionId: string
    readonly text: string
    /** 触发来源（用于桥侧的消息 source 标记，不要用 'user'）。 */
    readonly sourceKind: string
    readonly summary: string
    /** 只演练不真的叫醒（排障用）。 */
    readonly dryRun?: boolean
  }) => Promise<BridgeResult>
  /** 桥是否可达（健康检查）。 */
  readonly healthy: () => Promise<boolean>
}

/** 造一个桥客户端。 */
/**
 * 密钥能不能当 **HTTP 头**发出去。
 *
 * HTTP 头只允许 latin-1（ByteString）。密钥里有中文/emoji 时，
 * `fetch` 会在**构造请求时**抛一句 `Cannot convert argument to a ByteString` ——
 * 那句话完全看不出真正原因（谁会想到是密钥的字符集问题）。
 *
 * **所以要在配置时就拦住，并说清是哪个变量、哪个字符。**
 */
export function isHeaderSafe(value: string): { ok: true } | { ok: false; reason: string } {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code > 255) {
      return {
        ok: false,
        reason: `第 ${String(i + 1)} 个字符「${value[i] ?? "?"}」(U+${code.toString(16).toUpperCase()}) 不是 latin-1 —— HTTP 头不能带它` ,
      }
    }
  }
  return { ok: true }
}

export function createWakeBridge(options: WakeBridgeOptions): WakeBridge {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const timeout = options.timeoutMs ?? 15_000

  const call = async (path: string, body: unknown): Promise<BridgeResult> => {
    // **空密钥直接拒绝**：配漏了的话，一个没有认证的"叫醒并执行"端点就是提权入口。
    // 与其发一个空密钥让对面决定，不如在这里就失败。
    if (options.secret.trim() === '') {
      return { ok: false, reason: '唤醒桥密钥为空 —— 拒绝调用（空密钥等于没有认证）' }
    }

    try {
      const response = await doFetch(`${options.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forlife-wake-secret': options.secret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      } as never)

      const text = await response.text()
      if (!response.ok) {
        return { ok: false, reason: `桥拒绝（HTTP ${String(response.status)}）：${text.slice(0, 200)}` }
      }
      try {
        const parsed = JSON.parse(text) as { ok?: unknown; reason?: unknown; modelDid?: unknown }
        if (parsed.ok !== true) {
          return { ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason : '桥返回 ok=false' }
        }
        return {
          ok: true,
          reason: '已唤醒',
          ...(typeof parsed.modelDid === 'string' ? { modelDid: parsed.modelDid } : {}),
        }
      } catch {
        // 返回不是 JSON ⇒ 不能当成功（可能是反代返回了一个 HTML 错误页）
        return { ok: false, reason: `桥返回的不是 JSON：${text.slice(0, 120)}` }
      }
    } catch (error) {
      // 连不上就是失败 —— **不能当成功**，否则面板显示"已唤醒"而模型根本没动
      return { ok: false, reason: `连不上唤醒桥（${options.url}）：${String(error).slice(0, 140)}` }
    }
  }

  const wake: WakeBridge['wake'] = async (input) =>
    call('', {
      sessionId: input.sessionId,
      text: input.text,
      sourceKind: input.sourceKind,
      summary: input.summary,
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    })

  const healthy: WakeBridge['healthy'] = async () => {
    const result = await call('/health', {})
    return result.ok
  }

  return { wake, healthy }
}
