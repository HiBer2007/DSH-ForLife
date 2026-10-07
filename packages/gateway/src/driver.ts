/**
 * 轮次驱动器的两个真实实现 + 一个测试替身。
 *
 * ## headless 驱动
 *
 * 起 `dsh --profile <name> headless --json -`，**提示词经 stdin 送进去**，逐行读 **NDJSON** 事件。
 * 这一路的好处是**进程隔离**：一次轮次崩了不会带走网关。
 *
 * ## 提示词为什么必须走 stdin（踩过的坑）
 *
 * 早先的写法是把提示词当**命令行参数**传（`… --json "<提示词>"`）。在 Windows 上
 * `shell: true` 意味着命令串交给 `cmd.exe`，而唤醒提示是**多行**的（见 `wake-prompt.ts`）——
 * 命令串里的换行把命令截断，模型只收到第一行「这不是用户发来的消息，而是你自己之前设的触发器到点了。」，
 * 触发标题/原因/「你当时要自己做的事」**全部丢失** ⇒ 表现为"空唤醒"。
 *
 * `dsh --profile headless` 支持任务参数为 `-` 时从 stdin 读（`dsh-headless/lib/index.js:300`），
 * 所以这里固定传 `-`，提示词原样走 stdin。顺带绕开命令行长度的上限。
 *
 * ## 长连接驱动
 *
 * 复用常驻会话（若 U2 的长连接方案通过）。当前实现走"每轮一个请求"的等价形态，
 * 但**接口与 headless 一致**，所以切换只改配置。
 *
 * ## 为什么带一个 fake
 *
 * 网关的时序（防抖 → 唤醒 → 轮次 → 出站 → 确认）必须能在**没有真模型、没有真 QQ** 的情况下
 * 端到端测通；否则每次改时序都要人工点一遍。fake 驱动就是那条测试腿。
 *
 * @module @forlife/gateway/driver
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { TurnDriver, TurnOutcome, TurnRequest } from './turns.ts'

/** headless 驱动配置。 */
export interface HeadlessDriverOptions {
  /** profile 名（默认 forlife-headless）。 */
  readonly profile?: string
  /** dsh 可执行文件（默认 PATH 里的 dsh）。 */
  readonly bin?: string
  /** 单轮超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 环境变量（例如 DSH_HOME）。 */
  readonly env?: Record<string, string | undefined>
  /**
   * 注入 `spawn`（测试用）。
   *
   * 存在的理由：这里有一条**只会在真机 Windows 上发作**的缺陷史 ——
   * 把多行提示词当命令行参数传，会被 `cmd.exe` 在第一个换行处截断，
   * 而单测里没有真进程就复现不了。注入之后，这条约定（"提示词走 stdin，不进 args"）
   * 就能被一条普通单测钉住。
   */
  readonly spawnImpl?: typeof spawn
  readonly log?: (message: string) => void
}

/**
 * headless 驱动：每轮起一个 `dsh headless --json` 进程。
 */
export class HeadlessTurnDriver implements TurnDriver {
  readonly kind = 'headless' as const
  private readonly options: Required<Pick<HeadlessDriverOptions, 'profile' | 'bin' | 'timeoutMs'>> & HeadlessDriverOptions
  private readonly log: (message: string) => void
  private readonly spawnImpl: typeof spawn

  constructor(options: HeadlessDriverOptions = {}) {
    this.options = {
      profile: options.profile ?? 'forlife-headless',
      bin: options.bin ?? 'dsh',
      timeoutMs: options.timeoutMs ?? 300_000,
      ...options,
    }
    this.log = options.log ?? ((): void => {})
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  /**
   * 跑一轮。
   *
   * @param request - 轮次输入。
   * @returns 轮次结果。
   */
  async run(request: TurnRequest): Promise<TurnOutcome> {
    // **不要把 request.prompt 放进 args**：多行提示词过 shell
    // （Windows 是 cmd.exe）会在第一个换行处被截断。
    //
    // 从 stdin 读的**正确方式是不传任务参数**（不是传 `-`）。
    // 命令自带的说明写着：
    //   dsh --profile headless "run the tests"          answer one task and exit
    //   echo "run the tests" | dsh --profile headless   read the task from stdin  ← ★
    //   dsh --profile headless --json "run the tests"   emit machine-readable run events
    // 而 dsh-headless 的实现是：
    //   const task = program.args.length === 0 ? void 0 : joined
    // 即 `args.length === 0` ⇒ task 为 undefined ⇒ 读 stdin。
    //
    // **踩过的坑**：我先写成了 `… '--json', '-'`，真机报
    //   `` `-` must be the only task argument ``
    // 因为 `--json` 也算进了位置参数（判断是 `args.length > 1 && args.includes('-')`）。
    // **别传 `-`。**
    const args = ['--profile', this.options.profile, 'headless', '--json']
    this.log(`启动 headless：${this.options.bin} ${args.join(' ')}（提示词 ${String(request.prompt.length)} 字符，经 stdin）`)
    const child = this.spawnImpl(this.options.bin, args, {
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上 dsh 是 .cmd/.ps1 垫片，必须走 shell
      shell: true,
    })

    // 子进程早退时写 stdin 会 EPIPE；这不是轮次失败（真正的失败由 close/error 分支给），
    // 所以吞掉它，避免一个未处理的 'error' 事件把整个网关带走。
    child.stdin.on('error', () => {})
    child.stdin.end(request.prompt, 'utf8')

    const segments: string[] = []
    let toolCalls = 0
    let tokensIn = 0
    let tokensOut = 0
    let deferred: TurnOutcome['deferred']
    let error: string | undefined
    let buffer = ''

    const timer = setTimeout(() => {
      error = `轮次超时（${String(this.options.timeoutMs)}ms）`
      child.kill()
    }, this.options.timeoutMs)

    const onAbort = (): void => {
      error = '轮次被取消'
      child.kill()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    try {
      await new Promise<void>((resolve) => {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const parsed = parseNdjson(line)
            if (parsed === undefined) continue
            const type = String(parsed['type'] ?? '')
            if (type === 'text' || type === 'assistant_text' || type === 'message') {
              const text = String(parsed['text'] ?? parsed['content'] ?? '')
              if (text !== '') segments.push(text)
            } else if (type === 'tool_call' || type === 'tool_use') {
              toolCalls += 1
              const name = String(parsed['name'] ?? '')
              if (name === 'defer_turn') {
                deferred = { reason: String(parsed['reason'] ?? '模型要求挂起') }
              }
            } else if (type === 'usage') {
              tokensIn += Number(parsed['input_tokens'] ?? parsed['tokens_in'] ?? 0)
              tokensOut += Number(parsed['output_tokens'] ?? parsed['tokens_out'] ?? 0)
            } else if (type === 'error') {
              error = String(parsed['message'] ?? '未知错误')
            }
          }
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => this.log(`headless stderr：${chunk.trim().slice(0, 200)}`))
        child.on('close', (code) => {
          if (code !== 0 && error === undefined) error = `headless 退出码 ${String(code)}`
          resolve()
        })
        child.on('error', (spawnError) => {
          error = `无法启动 headless：${String(spawnError)}`
          resolve()
        })
      })
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }

    // 尾巴里可能还有一行没有换行结尾
    const tail = parseNdjson(buffer)
    if (tail !== undefined && typeof tail['text'] === 'string') segments.push(tail['text'])

    return {
      segments,
      tokensIn,
      tokensOut,
      toolCalls,
      ...(deferred === undefined ? {} : { deferred }),
      ...(error === undefined ? {} : { error }),
    }
  }
}

/** 解析一行 NDJSON（坏行返回 undefined，不抛）。 */
export function parseNdjson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // 数组不是事件对象：放行会让消费方读到一堆 undefined 字段而困惑，不如直接判为坏行
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 长连接驱动配置。 */
export interface LongConnectionDriverOptions {
  /** 常驻会话的请求入口（例如本地 web 的 API 或 DSH 的长连接端口）。 */
  readonly endpoint: string
  readonly token?: string
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 长连接驱动：把提示词发给常驻会话，读回 NDJSON 流。
 *
 * 与 headless 的差别只在"进程是否复用"；对上层接口完全一致，所以切换是配置行为。
 */
export class LongConnectionTurnDriver implements TurnDriver {
  readonly kind = 'longconnection' as const
  private readonly options: LongConnectionDriverOptions
  private readonly log: (message: string) => void

  constructor(options: LongConnectionDriverOptions) {
    this.options = options
    this.log = options.log ?? ((): void => {})
  }

  /**
   * 跑一轮。
   *
   * @param request - 轮次输入。
   * @returns 轮次结果。
   */
  async run(request: TurnRequest): Promise<TurnOutcome> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300_000)
    const onAbort = (): void => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.token === undefined ? {} : { authorization: `Bearer ${this.options.token}` }),
        },
        body: JSON.stringify({ prompt: request.prompt, conversation: request.conversation, turnId: request.turnId }),
        signal: controller.signal,
      })
      if (!response.ok) return { error: `长连接驱动返回 HTTP ${String(response.status)}` }

      const text = await response.text()
      const segments: string[] = []
      let toolCalls = 0
      for (const line of text.split('\n')) {
        const parsed = parseNdjson(line)
        if (parsed === undefined) continue
        const type = String(parsed['type'] ?? '')
        if (type === 'text' || type === 'assistant_text') {
          const value = String(parsed['text'] ?? '')
          if (value !== '') segments.push(value)
        } else if (type === 'tool_call' || type === 'tool_use') toolCalls += 1
      }
      return { segments, toolCalls }
    } catch (error) {
      return { error: `长连接驱动失败：${String(error)}` }
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

/** fake 驱动的剧本：收到轮次时要做的事。 */
export type FakeScript = (request: TurnRequest) => Promise<TurnOutcome> | TurnOutcome

/**
 * 测试用驱动：按剧本"扮演模型"。
 *
 * 它让网关的**完整时序**可以在没有真模型的情况下端到端跑通 ——
 * 这是把"消息进 → 唤醒 → 轮次 → 出站 → 确认"变成自动化测试的关键。
 */
export class FakeTurnDriver implements TurnDriver {
  readonly kind = 'fake' as const
  private readonly script: FakeScript
  /** 收到的全部请求（测试断言用）。 */
  readonly requests: TurnRequest[] = []

  constructor(script: FakeScript) {
    this.script = script
  }

  async run(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request)
    return await this.script(request)
  }
}

/** 按配置选驱动。 */
export function createDriver(config: {
  readonly kind: 'headless' | 'longconnection'
  readonly headless?: HeadlessDriverOptions
  readonly longConnection?: LongConnectionDriverOptions
}): TurnDriver {
  if (config.kind === 'headless') return new HeadlessTurnDriver(config.headless ?? {})
  if (config.longConnection === undefined) throw new Error('选择长连接驱动时必须提供 longConnection 配置')
  return new LongConnectionTurnDriver(config.longConnection)
}

/** 便于测试的 id 生成。 */
export function newTurnId(): string {
  return `turn_${randomUUID()}`
}

