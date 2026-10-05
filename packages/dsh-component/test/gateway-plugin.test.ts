/**
 * 网关插件的挂载测试：**真 socket + 真库 + 真插件接线**。
 *
 * 为什么必须有这条测试：`dsh --profile forlife-qq "ping"` 这类一次性调用能证明
 * "插件被真实 DSH 加载了"（有日志），但进程随即退出，**没法证明端口真的在监听**。
 * 所以这里补上：按 cordis 的契约调用 `apply()`，再用真 WebSocket 连上去跑一轮收发。
 *
 * 顺带守住一个之前踩过的坑：`ctx.effect(cb)` 的 disposer 是 cb 的**返回值**，
 * 不是 cb 本身。所以这里断言"停止时真的把监听关掉了"。
 *
 * 客户端刻意用 **Node 内置的 WebSocket**（不是 `ws`）：一来 dsh-component 不必多一个依赖，
 * 二来这证明我们的服务端能与**另一套 WebSocket 实现**互通 —— 真实 QQ 端也不是 `ws`。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'


import { apply as applyMemory } from '../src/index.ts'
import { apply as applyGateway, Config, inject, name } from '../src/gateway-plugin.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-gwplug-'))
const port = 37300 + Math.floor(Math.random() * 200)

/**
 * 最小 cordis 替身。
 *
 * 只实现本插件真正用到的四个方法，**并且按契约实现**：
 * `effect(cb)` 存的是 cb 的**返回值**（不是 cb 本身）—— 这个契约我们踩过坑，
 * 所以这里直接断言它，写错了立刻红。
 *
 * `get()` 一律返回 undefined：在裸测试台里没有 systemPrompt / tools 服务，
 * 插件必须能照常 apply（这正是"可选服务用 ctx.get 探测"的设计目的）。
 */
function fakeContext(): {
  readonly disposed: (() => void)[]
  effect(callback: () => () => void): void
  get(name: string): undefined
  on(event: string, callback: () => void): () => void
  inject(names: readonly string[], callback?: () => void): void
} {
  const disposed: (() => void)[] = []
  return {
    disposed,
    effect(callback) {
      const disposer = callback()
      assert.equal(typeof disposer, 'function', 'ctx.effect 的回调必须返回 disposer（契约：disposer 是返回值）')
      disposed.push(disposer)
    },
    get: () => undefined,
    on: () => () => {},
    // 实测：带回调的 ctx.inject 在本宿主里**不会触发**，所以这里也不触发 —— 保持与真实行为一致
    inject: () => {},
  }
}

/** 被测上下文（记忆插件先挂，网关插件后挂 —— 与 profile 里的顺序一致）。 */
const ctx = fakeContext()

before(() => {
  applyMemory(ctx as never, { storageRoot: dir, verbose: false } as never)
})

after(async () => {
  for (const dispose of ctx.disposed.reverse()) {
    try {
      dispose()
    } catch {
      // 清理失败不影响断言结论
    }
  }
  await delay(200)
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

test('插件元信息：不注入任何宿主服务（自管网络与队列）', () => {
  assert.equal(name, 'forlife-gateway')
  assert.deepEqual([...inject], [], '网关不该依赖 DSH 服务 —— 依赖越少越不会被静默跳过')
})

test('配置 schema：端口/驱动/防抖都有默认值', () => {
  const parsed = Config({}) as { port: number; driver: string; debounceMs: number; host: string }
  assert.equal(parsed.port, 3080)
  assert.equal(parsed.driver, 'headless')
  assert.equal(parsed.debounceMs, 3000, 'PLAN §8.4 给的范围是 2–3 秒')
  assert.equal(parsed.host, '127.0.0.1', '默认只绑回环（不能一装上就暴露到局域网）')
})

test('挂载后真的在监听：真 WebSocket 连得上（反向 WS 服务端）', async () => {
  applyGateway(ctx as never, {
    enabled: true,
    port,
    host: '127.0.0.1',
    path: '/',
    accessToken: '',
    driver: 'headless',
    driverProfile: 'forlife-headless',
    debounceMs: 120,
  })

  // 等运行时注册 + 监听建立
  let connected = false
  for (let i = 0; i < 40; i++) {
    await delay(100)
    const result = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
      socket.addEventListener('open', () => {
        socket.close()
        resolve('open')
      })
      socket.addEventListener('error', () => resolve('error'))
    })
    if (result === 'open') {
      connected = true
      break
    }
  }
  assert.equal(connected, true, `网关应当真的在 ${String(port)} 上监听`)
})

test('收一条 QQ 消息 → 轮次被创建（说明插件接线通了：transport → 队列 → 轮次）', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('连接失败')))
  })

  // 私聊消息（默认 80% 唤醒；为了让断言稳定，容器里后续会把它调成 100%）
  socket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      time: Math.floor(Date.now() / 1000),
      self_id: 30001,
      user_id: 10001,
      message_id: 'plug_1',
      message: [{ type: 'text', data: { text: '你好呀' } }],
      sender: { nickname: '老王' },
    }),
  )
  await delay(600)
  socket.close()

  // 入站必须落库（插件接线的最硬证据）
  const { openDatabase } = await import('@forlife/store')
  const opened = openDatabase({ file: join(dir, 'db', 'forlife.sqlite') })
  try {
    const row = opened.db.prepare('SELECT * FROM qq_inbox WHERE id = ?').get('plug_1') as Record<string, unknown> | undefined
    assert.ok(row !== undefined, '消息必须被网关收下并落库')
    assert.equal(row['text'], '你好呀')
    assert.equal(row['conversation_key'], 'onebot11:10001')

    // 唤醒判定也必须发生过（留痕）
    const wake = opened.db.prepare('SELECT * FROM wake_events ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined
    assert.ok(wake !== undefined, '唤醒判定必须留痕')
    assert.equal(wake['condition'], 'private_message')
  } finally {
    opened.close()
  }
})

test('停止：disposer 真的把监听关掉了（不是只存了个回调）', async () => {
  const disposers = [...ctx.disposed].reverse()
  for (const dispose of disposers) dispose()
  await delay(400)

  const stillOpen = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
    socket.addEventListener('open', () => {
      socket.close()
      resolve(true)
    })
    socket.addEventListener('error', () => resolve(false))
    setTimeout(() => resolve(false), 2000)
  })
  assert.equal(stillOpen, false, '停止后不该还能连上（端口必须被释放）')
})


