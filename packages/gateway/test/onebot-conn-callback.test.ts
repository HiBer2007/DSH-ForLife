/**
 * 连接回调的守卫测试（**必须走构造函数**）。
 *
 * ## 这个 bug 为什么单测容易漏
 *
 * 真机 bug（2026-10-06）：transport 的构造函数**逐字段重建** `this.options`，
 * 而 `onConnectionState` 在 `Pick<>` 里是**可选**的 ⇒ TypeScript 不报错，
 * 那一行就这么漏了。
 *
 * 后果：`notifyConnection` 里 `callback === undefined` 直接 `return`，
 * **连接回调永远不触发**，而日志里只有 `QQ 端已连接` / `QQ 端断开` ——
 * 完全看不出"观察者根本没被叫"。
 *
 * **所以这些用例必须走构造函数**（`createOneBotTransport({...})`），
 * 而不是直接调 `notifyConnection` —— 后者是显式传参，绕过构造函数，
 * 正好把要测的那一层跳过去了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import { createOneBotTransport } from '../src/onebot.ts'

/** 用一个固定的高位端口（`port: 0` 时拿不到真实端口）。 */
const PORT = 18299
const TOKEN = 'conn-callback-test-token'

/** 起一个 transport 并连一个假 WS 客户端上去。 */
async function withClient(
  onConnectionState: ((connected: boolean, detail?: string) => void) | undefined,
  body: (helpers: { closeClient: () => void }) => Promise<void>,
): Promise<void> {
  const transport = createOneBotTransport({
    port: PORT,
    host: '127.0.0.1',
    path: '/',
    accessToken: TOKEN,
    log: () => {},
    ...(onConnectionState === undefined ? {} : { onConnectionState }),
  })
  await transport.start()
  const socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, {
    // ★ **鉴权走 `Authorization` 头，不是 `?access_token=` query**
    // （真机排查时踩过：`adopt()` 读的是 `authorization` 参数，
    //  用 query 传会被判"鉴权失败"直接 close，而 `notifyConnection` 根本不会跑。）
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
      setTimeout(() => reject(new Error('客户端连接超时')), 5000)
    })
    // 等 gateway 侧处理 open
    await new Promise((r) => setTimeout(r, 400))
    await body({ closeClient: () => socket.close() })
  } finally {
    try {
      socket.close()
    } catch {
      // 已经关了
    }
    await new Promise((r) => setTimeout(r, 300))
    await transport.stop()
  }
}

test('★ 连接回调必须能穿过构造函数（真机 bug 的守卫）', async () => {
  const seen: boolean[] = []
  await withClient(
    (connected) => {
      seen.push(connected)
    },
    async ({ closeClient }) => {
      // **关键断言**：连上之后回调必须被叫过
      assert.ok(
        seen.includes(true),
        '连接回调没被调用 —— 检查构造函数是否把 onConnectionState 漏掉了（它逐字段重建 this.options）',
      )
      closeClient()
      await new Promise((r) => setTimeout(r, 500))
      assert.ok(seen.includes(false), '断开回调没被调用')
    },
  )
})

test('★ 观察者抛异常不影响连接处理（它是观察者，不是链路的一部分）', async () => {
  let calls = 0
  await withClient(
    () => {
      calls += 1
      throw new Error('观察者炸了')
    },
    async ({ closeClient }) => {
      assert.ok(calls > 0, '回调应当被调用')
      closeClient()
      await new Promise((r) => setTimeout(r, 500))
      // 没抛出去 = 连接处理正常走完
    },
  )
})

test('不传回调时一切照常（它是可选的）', async () => {
  await withClient(undefined, async ({ closeClient }) => {
    closeClient()
    await new Promise((r) => setTimeout(r, 300))
  })
})
