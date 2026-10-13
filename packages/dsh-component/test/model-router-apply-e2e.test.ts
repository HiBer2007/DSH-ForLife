/**
 * **apply 的行为级端到端测试**（不是读源码，是真跑一遍）。
 *
 * ## 为什么要有它 —— 上一轮的守卫有个缺口
 *
 * 上一轮（`db432f6`）我给 apply 配的守卫**全是读源码的**：
 * 断言 `on('agent/request', …)` 在、断言 `provider: locked.provider` 在。
 * **它们证明不了"跑起来真的会改"** —— 比如：
 *
 * - 锁的键算错（`sessionId:turn` 拼错）⇒ 订阅在、赋值在，**但永远取不到锁**
 * - `pre-step` 与 `request` 的**载荷字段名不一致** ⇒ 同上
 * - `next()` 的结果被整体替换而不是 spread ⇒ `temperature` 静默消失
 *
 * 这三样**都不会让任何源码守卫变红**。⇒ 本文件把两个事件**真的串起来跑**。
 *
 * ## 串起来跑的顺序（与真机一致）
 *
 * ```
 * agent/pre-step(有 messages)  →  判档 → 存锁
 * agent/request(next() 给 config) →  apply 时改三个字段
 * ```
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCatalog } from '@forlife/router'

import { installModelRouter } from '../src/model-router.ts'

type Handler = (payload: unknown, next: () => Promise<unknown>) => unknown

/** 假 ctx：**记下每个事件的处理器**，好让测试按真顺序去调。 */
function recordingCtx(): { readonly ctx: never; readonly handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    on(name: string, fn: Handler): () => void {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
  }
  return { ctx: ctx as never, handlers }
}

const CATALOG = buildCatalog({
  providers: [{ id: 'opencode-go' }, { id: 'deepseek-official' }].map((p) => p as never),
  models: [
    { provider: 'opencode-go', id: 'flash' },
    { provider: 'deepseek-official', id: 'flash' },
  ] as never,
  unreachable: new Set<string>(),
  now: new Date('2026-10-10T00:00:00Z'),
} as never)

/** 走一遍 `agent/pre-step`（带 messages ⇒ 判档能算出东西）。 */
async function runPreStep(
  handlers: Map<string, Handler>,
  input: { readonly sessionId: string; readonly turn: number; readonly text: string },
): Promise<void> {
  const fn = handlers.get('agent/pre-step')
  assert.ok(fn !== undefined, '没订阅 agent/pre-step')
  await fn(
    {
      agent: { id: input.sessionId },
      turn: input.turn,
      step: 1,
      messages: [{ role: 'user', content: input.text }],
    },
    async () => ({ kind: 'continue' }),
  )
}

/** 走一遍 `agent/request`，返回**宿主原本会用的 config 变成了什么**。 */
async function runRequest(
  handlers: Map<string, Handler>,
  input: { readonly sessionId: string; readonly turn: number },
  hostConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fn = handlers.get('agent/request')
  assert.ok(fn !== undefined, '没订阅 agent/request')
  const out = await fn(
    { agent: { id: input.sessionId }, turn: input.turn, step: 1 },
    async () => ({ ...hostConfig }),
  )
  return out as Record<string, unknown>
}

function install(mode: string): { readonly handlers: Map<string, Handler>; readonly logs: string[] } {
  const f = recordingCtx()
  const logs: string[] = []
  installModelRouter(f.ctx, {
    log: (m: string) => logs.push(m),
    env: { FORLIFE_ROUTER_MODE: mode },
    getCatalog: async () => CATALOG,
  } as never)
  return { handlers: f.handlers, logs }
}

test('★★★ apply：判档结果**真的落到了 config 上**（端到端，两个事件串起来）', async () => {
  const { handlers } = install('apply')
  // 「😀」会被内置守卫判成 L1（emoji-only）—— 与 router 那边的测试同一个入口
  await runPreStep(handlers, { sessionId: 's1', turn: 1, text: '😀' })

  const host = { provider: 'some-other', model: 'whatever', temperature: 0.5, maxTokens: 1234 }
  const out = await runRequest(handlers, { sessionId: 's1', turn: 1 }, host)

  // ★ P2-b 串进来了：L1 现在也该选 deepseek-official（`dbc7ad3` 改的偏好序）
  assert.equal(out['provider'], 'deepseek-official', '★ 判档选的 provider 要真的落到请求上')
  assert.equal(out['model'], 'flash')
  assert.equal(out['reasoningEffort'], 'low', 'L1 的强度是 low —— 档位的意义一半在这里')
  // ★★ 宿主原本的字段**必须原样保留**（整体替换会静默丢掉它们）
  assert.equal(out['temperature'], 0.5, '★★ temperature 不许被抹掉')
  assert.equal(out['maxTokens'], 1234, '★★ maxTokens 不许被抹掉')
})

test('★★★ observe：**一个字都不改**（这是"先 observe 再 apply"的全部意义）', async () => {
  const { handlers, logs } = install('observe')
  await runPreStep(handlers, { sessionId: 's1', turn: 1, text: '😀' })

  const host = { provider: 'some-other', model: 'whatever', temperature: 0.5 }
  const out = await runRequest(handlers, { sessionId: 's1', turn: 1 }, host)

  assert.deepEqual(out, host, '★★★ observe 模式下 config 必须**逐字段不变**')
  assert.ok(
    logs.some((l) => l.includes('🎚️ 判档')),
    '但要有判档日志 —— 这正是 observe 的用处：**看得见，但不动手**',
  )
})

test('★★ `pre-step` 没跑过 ⇒ `request` 原样放行（没有锁就不猜）', async () => {
  const { handlers } = install('apply')
  const host = { provider: 'host-said-so', model: 'm' }
  const out = await runRequest(handlers, { sessionId: 's1', turn: 7 }, host)
  assert.deepEqual(out, host, '★ 没判过档就别动 —— 猜一个模型比不换更糟（花钱且看不出来）')
})

test('★★ 锁是**按 会话:轮次** 认的 —— 换了轮次/换了会话就对不上了', async () => {
  const { handlers } = install('apply')
  await runPreStep(handlers, { sessionId: 's1', turn: 1, text: '😀' })

  const host = { provider: 'host', model: 'm' }
  // 同一会话、**别的轮次** ⇒ 没锁过 ⇒ 放行
  assert.deepEqual(await runRequest(handlers, { sessionId: 's1', turn: 2 }, host), host, '★ 轮次对不上就别用')
  // **别的会话**、同一个轮号 ⇒ 也不能串味（多 agent 并发时这就是 bug）
  assert.deepEqual(await runRequest(handlers, { sessionId: 's2', turn: 1 }, host), host, '★ 会话对不上就别用')
})

test('★★ 取不到 user 文本 ⇒ 不判档、不锁 ⇒ request 放行（**不猜**）', async () => {
  const { handlers } = install('apply')
  const fn = handlers.get('agent/pre-step')
  assert.ok(fn !== undefined)
  // 只有 assistant 消息 ⇒ `extractTurnText` 给 undefined
  await fn(
    { agent: { id: 's1' }, turn: 1, step: 1, messages: [{ role: 'assistant', content: '我说' }] },
    async () => ({ kind: 'continue' }),
  )
  const host = { provider: 'host', model: 'm' }
  assert.deepEqual(await runRequest(handlers, { sessionId: 's1', turn: 1 }, host), host)
})

test('★★ `agent/request` **必须把宿主的决定传下去**（瀑布事件少了 next() 会把整轮干掉）', async () => {
  const { handlers } = install('apply')
  const fn = handlers.get('agent/request')
  assert.ok(fn !== undefined)
  let called = 0
  // 即使我们不改，也要 `await next()` —— 这是 `dsh-plan-mode` 那次 TypeError 的教训
  await fn({ agent: { id: 's9' }, turn: 1, step: 1 }, async () => {
    called += 1
    return { provider: 'p', model: 'm' }
  })
  assert.equal(called, 1, '★★★ 不调 `next()` ⇒ 上一个监听器拿到 undefined ⇒ `decision.kind` 直接 TypeError，整轮失败')
})
