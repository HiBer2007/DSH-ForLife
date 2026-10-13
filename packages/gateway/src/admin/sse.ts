/**
 * SSE 端点：把实时日志推给面板（替代 2 秒轮询）。
 *
 * ## 为什么值得换掉轮询
 *
 * 面板现在是 `LogsView.vue` 每 2 秒 `since(seq)` 拉一次。轮询的两个毛病：
 * 1. **延迟**：日志最多晚 2 秒才出现（**排障时那 2 秒很难受**）；
 * 2. **空转**：没事发生时也每 2 秒发一个请求。
 *
 * ## ★ 五条必须做的事（每一条都对应一个真实的失败模式）
 *
 * 1. **鉴权与别的路由完全一致**（`requireSession`）——
 *    SSE 是个长连接，**忘了鉴权就等于开了一个持续泄露日志的口子**；
 * 2. **每个连接一个有界队列** —— 慢客户端不能吃掉内存。
 *    满了**丢最旧的并计数**，而且**把丢了多少告诉客户端**
 *    （**静默丢**会让人以为"日志就这些"）；
 * 3. **断开时必须退订** —— 不退的话 `push()` 每次都遍历死订阅者
 *    （**内存与 CPU 双漏**）；
 * 4. **心跳** —— 中间可能有反代（Caddy），**空闲连接会被它掐掉**。
 *    定期发一个 SSE 注释行（`:` 开头，客户端忽略）保活；
 * 5. **`X-Accel-Buffering: no`** —— 反代默认会缓冲，那样 SSE 就**变成了慢轮询**。
 *
 * ## ⚠️ 一个如实说的限制
 *
 * **本机没有真跑过端到端**（没有浏览器 + 反代）。
 * 验过的是：单元测试（含慢客户端、退订、心跳）+ typecheck。
 *
 * @module @forlife/gateway/admin/sse
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { LogBuffer, LogLine } from './log-buffer.ts'

/** SSE 每连接的队列上限（**慢客户端保护**）。 */
export const SSE_QUEUE_LIMIT = 200

/** 心跳间隔（毫秒）。Caddy 默认空闲超时远大于这个数。 */
export const SSE_HEARTBEAT_MS = 15_000

export interface SseOptions {
  readonly logBuffer: LogBuffer
  /** 起始序号（客户端上次看到的）—— 先补发它之后的行。 */
  readonly since: number
  /** 心跳间隔（测试可缩短）。 */
  readonly heartbeatMs?: number
  /** 队列上限（测试可缩短）。 */
  readonly queueLimit?: number
}

/**
 * 把一个 HTTP 响应变成 SSE 流。
 *
 * **返回清理函数**（连接断了要调它 —— 退订 + 停心跳）。
 */
export function openLogStream(req: IncomingMessage, res: ServerResponse, options: SseOptions): () => void {
  const queueLimit = options.queueLimit ?? SSE_QUEUE_LIMIT
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // ★ **反代默认会缓冲** —— 不声明的话 SSE 就变成了"慢轮询"
    'X-Accel-Buffering': 'no',
  })

  /** 待发队列（**有界**）。 */
  const queue: LogLine[] = []
  let dropped = 0
  let closed = false

  const write = (text: string): void => {
    if (closed) return
    try {
      res.write(text)
    } catch {
      // 对端断了 —— 交给 close 事件收尾
      closed = true
    }
  }

  /** 发一条日志事件。 */
  const emit = (line: LogLine): void => {
    write(`id: ${String(line.seq)}\ndata: ${JSON.stringify(line)}\n\n`)
  }

  // ★ **先补发**（客户端可能断过一会儿，它带 `since` 来）——
  // 不补的话，"断开期间产生的日志"就**永远看不到了**。
  const backlog = options.logBuffer.since(options.since)
  for (const line of backlog.slice(-queueLimit)) emit(line)

  // ★ **订阅**（返回退订函数）
  const unsubscribe = options.logBuffer.subscribe((line) => {
    if (closed) return
    if (queue.length >= queueLimit) {
      // **丢最旧的并计数** —— 静默丢会让人以为"日志就这些"
      queue.shift()
      dropped += 1
      return
    }
    queue.push(line)
  })

  // ★ **心跳**：空闲连接会被反代掐掉。
  // 用 SSE 注释行（`:` 开头）—— 客户端会忽略它。
  const heartbeat = setInterval(() => {
    if (closed) return
    // 心跳时**顺便把队列排空**（一次定时器做两件事，少一个定时器）
    while (queue.length > 0) {
      const line = queue.shift()
      if (line !== undefined) emit(line)
    }
    if (dropped > 0) {
      // **把丢了多少告诉客户端** —— 不然它以为日志是连续的
      write(`event: dropped\ndata: ${JSON.stringify({ dropped })}\n\n`)
      dropped = 0
    }
    write(': heartbeat\n\n')
  }, heartbeatMs)
  // 心跳定时器**不该拖住进程退出**
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  /** 清理（**幂等** —— close 与 error 可能都触发）。 */
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    try {
      res.end()
    } catch {
      // 已经断了
    }
  }

  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)

  return cleanup
}
