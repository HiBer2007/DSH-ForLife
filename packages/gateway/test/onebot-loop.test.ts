/**
 * 整条链的自动化验证：**模拟 NapCat** 连上我们的反向 WS，走完
 * 「入站 → 入库 → 唤醒判定 → 轮次 → 出站 → 确认」。
 *
 * ## 为什么这条测试值得单独存在
 *
 * 真实 QQ 那一跳（NapCat 登录、腾讯服务器）是**我们控制不了**的，也不该进自动化测试。
 * 但它前面的每一段都该被钉死：一旦哪一段坏了，出问题时人根本分不清
 * "是链路坏了"还是"是 QQ 没登录"。这条测试把可控的部分全部覆盖，
 * 于是排障时能一句话回答："链路是绿的，问题在 QQ 侧。"
 *
 * 它同时是"驱动可切换"这个设计的兑现：用 fake 驱动跑完整时序，
 * 不需要任何模型凭据 —— 这正是当初把驱动做成可切换的原因。
 *
 * 真实格式取自 `onebot.test.ts` 里喂给传输层的原始事件，不是编的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FLAG_QQ_TAKEOVER, openDatabase, setFlag } from '@forlife/store'
import { WebSocket } from 'ws'

import { startGatewayRuntime, type RunningGatewayRuntime } from '../src/runtime.ts'

/** 固定高位端口：避免与开发机上真在跑的服务（8081/3010）撞车。 */
const PORT = 39_117
const TOKEN = 'loop-test-token'

/** 轮询等待条件成立（比固定 sleep 稳，也比它快）。 */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`等待超时：${what}`)
}

/** 查一个计数。 */
function count(db: ReturnType<typeof openDatabase>['db'], sql: string): number {
  const row = db.prepare(sql).get() as { v?: number } | undefined
  return row?.v ?? 0
}

test('接管模式：消息只入库、不产生轮次，且保持"待人工处理"', async () => {
  // 这条守的是"接管"这个功能的核心承诺：**模型完全不参与**。
  // 如果接管开着却仍然跑了轮次，用户会以为"接管了"，实际模型还在回话 —— 那是最糟的失败方式。
  const opened = openDatabase({ file: ':memory:' })
  const db = opened.db
  let runtime: RunningGatewayRuntime | undefined
  let client: WebSocket | undefined

  try {
    setFlag(db, FLAG_QQ_TAKEOVER, true)
    runtime = await startGatewayRuntime({
      db,
      log: () => {},
      onebot: { port: PORT + 1, host: '127.0.0.1', path: '/', accessToken: TOKEN },
      driver: 'fake',
      disableNoiseFilter: true,
      debounceMs: 30,
      outboxPollMs: 40,
      random: () => 0,
    })

    client = new WebSocket(`ws://127.0.0.1:${String(PORT + 1)}/`, { headers: { authorization: `Bearer ${TOKEN}` } })
    await new Promise<void>((resolve, reject) => {
      client?.once('open', () => resolve())
      client?.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    })

    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        time: Math.floor(Date.now() / 1000),
        self_id: 3112546448,
        user_id: 10001,
        message_id: 80001,
        message: [{ type: 'text', data: { text: '这条应该被接管' } }],
        sender: { nickname: '海波_HiBer' },
      }),
    )

    // 消息必须入库（运维要看得到）
    await waitFor('接管下消息仍入库', () => count(db, 'SELECT COUNT(*) AS v FROM qq_inbox') === 1)
    // 给足时间让"本该发生"的轮次发生 —— 它不该发生
    await new Promise((resolve) => setTimeout(resolve, 600))

    assert.equal(count(db, 'SELECT COUNT(*) AS v FROM qq_turns'), 0, '接管模式下**绝不能**产生轮次')
    assert.equal(count(db, 'SELECT COUNT(*) AS v FROM qq_outbox'), 0, '接管模式下模型不该发出任何消息')
    assert.equal(
      count(db, 'SELECT COUNT(*) AS v FROM qq_inbox WHERE processed = 0'),
      1,
      'processed 必须保持 0：它是运维的待办箱，不能被标成"已处理"',
    )

    // 关掉开关后应当立刻恢复（读取器是每次入站都问一次，不需要重启）
    setFlag(db, FLAG_QQ_TAKEOVER, false)
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        time: Math.floor(Date.now() / 1000),
        self_id: 3112546448,
        user_id: 10001,
        message_id: 80002,
        message: [{ type: 'text', data: { text: '这条应该恢复路由' } }],
        sender: { nickname: '海波_HiBer' },
      }),
    )
    await waitFor('关掉接管后恢复路由', () => count(db, 'SELECT COUNT(*) AS v FROM qq_turns') === 1)
  } finally {
    client?.close()
    await runtime?.stop()
    db.close()
  }
})
test('整条链：模拟 NapCat → 入库 → 轮次 → 出站 → 确认', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const db = opened.db
  let runtime: RunningGatewayRuntime | undefined
  let client: WebSocket | undefined

  try {
    runtime = await startGatewayRuntime({
      db,
      log: () => {
        /* 测试里不打印 */
      },
      onebot: { port: PORT, host: '127.0.0.1', path: '/', accessToken: TOKEN },
      driver: 'fake',
      // 噪音过滤会按规则丢掉消息，那样测的就不是链路而是过滤器了
      disableNoiseFilter: true,
      // 防抖与出站轮询都调到最小，让这条测试在几百毫秒内跑完
      debounceMs: 30,
      outboxPollMs: 40,
      // 唤醒判定有概率规则（private_message 是 80%）。注入 0 让它必然唤醒 ——
      // 不注入的话这条测试会随机变红，那比没有测试更糟。
      random: () => 0,
    })

    // ── 扮演 NapCat：带 token 连上来 ─────────────────────────────────
    const actions: { action?: string; params?: Record<string, unknown>; echo?: unknown }[] = []
    client = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    await new Promise<void>((resolve, reject) => {
      client?.once('open', () => resolve())
      client?.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    })

    client.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: unknown }
      actions.push(message)
      // 动作调用必须回执，否则出站会一直等到超时、永远不会被确认。
      //
      // 注意：**不要按动作名判断** —— 私聊的真实动作是 `send_private_msg`，
      // 我第一版只回执 `send_msg`，于是回复明明发出去了却卡在 status='sending'
      // （排查时现场就是"出站队列里有一行 sending、动作调用列表里也有它"）。
      // 凡是带 echo 的调用一律回执，这才是 OneBot 客户端的正确行为。
      if (message.action !== undefined && message.echo !== undefined) {
        client?.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: message.echo }))
      }
    })

    // ── 发一条真实的私聊消息（格式与 NapCat 实际发送的一致）──────────
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        time: Math.floor(Date.now() / 1000),
        self_id: 3112546448,
        user_id: 10001,
        message_id: 70001,
        message: [{ type: 'text', data: { text: '你好呀' } }],
        sender: { nickname: '海波_HiBer' },
      }),
    )

    // ── 断言：消息入库 ──────────────────────────────────────────────
    await waitFor('入站消息落库', () => count(db, 'SELECT COUNT(*) AS v FROM qq_inbox') === 1)
    const inbox = db.prepare('SELECT text, sender_name, is_group FROM qq_inbox LIMIT 1').get() as
      | { text: string; sender_name: string | null; is_group: number }
      | undefined
    assert.equal(inbox?.text, '你好呀', '文本要原样入库')
    assert.equal(inbox?.sender_name, '海波_HiBer', '发送者昵称要带上')
    assert.equal(inbox?.is_group, 0, '私聊不该被标成群聊')

    // 已处理标记必须被写上：它是面板"待处理入站"的唯一来源，
    // 只写入不标记的话那个数字只增不减（用户实测看到"待处理入站 7 条"）。
    // 把 `markProcessed` 删掉，这条断言必须变红。
    await waitFor('入站被标记为已处理', () => count(db, 'SELECT COUNT(*) AS v FROM qq_inbox WHERE processed = 1') === 1)
    const merged = db.prepare('SELECT merged_into FROM qq_inbox LIMIT 1').get() as { merged_into: string | null } | undefined
    assert.match(String(merged?.merged_into), /^turn_/, '要记下这批进了哪一轮（防抖合并的证据）')

    // 会话表也要被建出来（否则面板上"会话"一栏永远是空的）
    await waitFor('会话被登记', () => count(db, 'SELECT COUNT(*) AS v FROM qq_sessions') === 1)
    const session = db.prepare('SELECT conversation_key, kind FROM qq_sessions LIMIT 1').get() as
      | { conversation_key: string; kind: string }
      | undefined
    assert.equal(session?.conversation_key, 'onebot11:10001')
    assert.equal(session?.kind, 'private')

    // ── 断言：轮次跑完 ──────────────────────────────────────────────
    await waitFor('轮次结束', () => count(db, "SELECT COUNT(*) AS v FROM qq_turns WHERE status = 'done'") === 1)
    const turn = db.prepare('SELECT status, conversation_key FROM qq_turns LIMIT 1').get() as
      | { status: string; conversation_key: string }
      | undefined
    assert.equal(turn?.conversation_key, 'onebot11:10001', '轮次要挂在正确的会话上')

    // ── 断言：出站被发出并确认 ──────────────────────────────────────
    // 失败时把现场打出来：这条链横跨"轮次→出站队列→传输层动作→回执"，
    // 只说"超时"等于让人从零开始查（我自己就先卡在这里）。
    try {
      await waitFor('出站消息被确认', () => count(db, 'SELECT COUNT(*) AS v FROM qq_outbox WHERE confirmed = 1') === 1)
    } catch (error) {
      const rows = db.prepare('SELECT id, status, attempt, confirmed, error FROM qq_outbox').all()
      const sends = actions.filter((action) => action.action !== undefined)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `  出站队列：${JSON.stringify(rows)}\n` +
          `  已收到的动作调用：${JSON.stringify(sends)}\n` +
          `  网关状态：${JSON.stringify(runtime.state())}`,
      )
    }

    const sendAction = actions.find((action) => action.action !== undefined)
    assert.ok(sendAction !== undefined, '必须通过 WS 发出动作调用（这是"真的发出去了"的唯一证据）')
    assert.match(String(sendAction.action), /send_(private|group)_msg/, '私聊应走 send_private_msg（真实动作名，别按 send_msg 猜）')
    const params = sendAction.params ?? {}
    assert.equal(String(params['user_id']), '10001', '私聊要发给对的人')
    // fake 驱动的回复文本要能被认出来（生产换成 headless 后这里会是模型输出）
    assert.match(JSON.stringify(params), /联调脚本/, '回复内容应来自 fake 驱动的剧本')

    // 网关自己的计数也要对得上
    const state = runtime.state()
    assert.equal(state.turnsHandled, 1, '网关应记录 1 次轮次')
    assert.equal(state.outboundSent, 1, '网关应记录 1 次成功出站')
  } finally {
    client?.close()
    await runtime?.stop()
    db.close()
  }
})