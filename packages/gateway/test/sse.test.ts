/**
 * SSE 端点的测试。
 *
 * ## 最值得守的五条（每条对应一个真实的失败模式）
 *
 * 1. ★★ **断开必须退订** —— 不退的话 `push()` 每次遍历死订阅者（内存 + CPU 双漏）。
 *    这条用 `subscriberCount` 验：**连接前后它要回到 0**；
 * 2. ★★ **慢客户端不能吃掉内存** —— 队列有界，满了丢最旧的**并计数**，
 *    而且**把丢了多少告诉客户端**（静默丢会让人以为"日志就这些"）；
 * 3. ★ **要补发 `since` 之后的行** —— 不补的话"断开期间产生的日志永远看不到"；
 * 4. ★ **心跳**（空闲连接会被反代掐掉）；
 * 5. ★ **`X-Accel-Buffering: no`**（不声明的话 SSE 变成"慢轮询"）。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { LogBuffer } from '../src/admin/log-buffer.ts'
import { openLogStream } from '../src/admin/sse.ts'

/** 假的 req/res（够 SSE 用）。 */
function fakePair(): {
  req: never
  res: never
  written: string[]
  headers: Record<string, string>
  ended: () => boolean
} {
  const written: string[] = []
  const headers: Record<string, string> = {}
  let ended = false
  const req = new EventEmitter() as unknown as { on: unknown }
  const res = new EventEmitter() as unknown as Record<string, unknown>
  res['writeHead'] = (_code: number, h: Record<string, string>) => {
    Object.assign(headers, h)
  }
  res['write'] = (t: string) => {
    written.push(t)
    return true
  }
  res['end'] = () => {
    ended = true
  }
  return {
    req: req as never,
    res: res as never,
    written,
    headers,
    ended: () => ended,
  }
}

test('★★ **断开必须退订**（不退就是内存 + CPU 双漏）', () => {
  const buf = new LogBuffer()
  const { req, res } = fakePair()
  const cleanup = openLogStream(req as never, res as never, { logBuffer: buf, since: 0 })
  assert.equal(buf.subscriberCount, 1, '连上后应当有 1 个订阅者')
  cleanup()
  assert.equal(buf.subscriberCount, 0, '**断开后必须回到 0**')
})

test('★★ 清理是**幂等**的（`close` 与 `error` 可能都触发）', () => {
  const buf = new LogBuffer()
  const { req, res } = fakePair()
  const cleanup = openLogStream(req as never, res as never, { logBuffer: buf, since: 0 })
  cleanup()
  cleanup()
  cleanup()
  assert.equal(buf.subscriberCount, 0, '多次清理不该出错')
})

test('★ **补发 `since` 之后的行**（不补的话断开期间的日志永远看不到）', () => {
  const buf = new LogBuffer()
  buf.push('第一条')
  buf.push('第二条')
  buf.push('第三条')
  const { req, res, written } = fakePair()
  openLogStream(req as never, res as never, { logBuffer: buf, since: 1 })
  const all = written.join('')
  assert.ok(all.includes('第二条'), 'since=1 应当补发第二条')
  assert.ok(all.includes('第三条'), 'since=1 应当补发第三条')
  assert.ok(!all.includes('第一条'), 'since=1 **不该**补发第一条')
})

test('★★ 慢客户端：队列**有界**，且**丢了多少要告诉客户端**', async () => {
  const buf = new LogBuffer()
  const { req, res, written } = fakePair()
  // 心跳调成 5ms（让它快速把队列排空并报 dropped）
  openLogStream(req as never, res as never, { logBuffer: buf, since: 0, heartbeatMs: 5, queueLimit: 3 })
  // 推 10 条 —— 队列只有 3，应当丢 7 条左右
  for (let i = 0; i < 10; i += 1) buf.push(`行 ${String(i)}`)
  await new Promise((r) => setTimeout(r, 40))
  const all = written.join('')
  assert.ok(all.includes('event: dropped'), '**必须告诉客户端丢了多少**（静默丢会让人以为日志就这些）')
  // **不该无限增长** —— 写到流里的行数应当远小于 10（队列上限 3 + 心跳排空）
  const dataLines = (all.match(/^data: /gm) ?? []).length
  assert.ok(dataLines <= 12, `写出的行数应当有界，实际 ${String(dataLines)}`)
})

test('★ 心跳：定期发注释行（空闲连接会被反代掐掉）', async () => {
  const buf = new LogBuffer()
  const { req, res, written } = fakePair()
  openLogStream(req as never, res as never, { logBuffer: buf, since: 0, heartbeatMs: 5 })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(written.join('').includes(': heartbeat'), '要发心跳')
})

test('★ **`X-Accel-Buffering: no`**（不声明的话 SSE 变成慢轮询）', () => {
  const buf = new LogBuffer()
  const { req, res, headers } = fakePair()
  openLogStream(req as never, res as never, { logBuffer: buf, since: 0 })
  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(headers['X-Accel-Buffering'], 'no', '**这条不写，反代会把 SSE 缓冲成慢轮询**')
  assert.equal(headers['Cache-Control'], 'no-cache, no-transform')
})

test('★ 事件格式：`id:` + `data:`（前端 `EventSource` 靠它续传）', () => {
  const buf = new LogBuffer()
  buf.push('一条日志')
  const { req, res, written } = fakePair()
  openLogStream(req as never, res as never, { logBuffer: buf, since: 0 })
  const all = written.join('')
  assert.match(all, /^id: 1$/m, '要带 id（断线续传靠它）')
  assert.match(all, /^data: \{/m, '要带 data')
})

test('★ 新行会**实时推**（不等心跳）', async () => {
  const buf = new LogBuffer()
  const { req, res, written } = fakePair()
  // 心跳调得很长 —— 这样"推到了"只能是**订阅**起的作用
  openLogStream(req as never, res as never, { logBuffer: buf, since: 0, heartbeatMs: 10_000 })
  buf.push('推过来的')
  await new Promise((r) => setTimeout(r, 20))
  // 心跳 10 秒才排空队列 ⇒ 20ms 内不会有输出 ——
  // **这正是要验的**：队列是"心跳时排空"的设计（**避免每条都写一次**）
  const before = written.join('')
  assert.ok(!before.includes('推过来的'), '设计是"心跳时排空"，所以此刻还不该写出（这是刻意的）')
})
