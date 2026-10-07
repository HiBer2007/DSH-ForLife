/**
 * **端到端接线 + 形状**：真 `apply()` + 宿主真形状的 `session/event` ⇒ `cache_metrics` 真的多一行。
 *
 * ## 为什么必须有这一条
 *
 * `cache-collector.test.ts` 证明的是"`extractUsage()` 对**宿主形状**解析正确"。
 * 但"形状对不对"和"接线通不通"是两件事：
 * `apply()` 可能订阅了、也可能**根本没订阅**；可能把事件原样传下去、也可能换了个形状。
 * 而且——本项目已经栽过 7 次——单元测试**只测得到函数**，测不到生产路径。
 *
 * 所以这里用**假 ctx 驱动真 `apply()`**（与 `turn-accounting-wiring.test.ts` 同风格），
 * 喂的是宿主 `Session.append()` 产出的**信封** `{type, seq, time, data}` ——
 * **载荷在 `data` 里**（`node_modules/@deepseek-ai/dsh-session/lib/index.js` 的组装点）。
 *
 * 修复前的现场：这条测试会红在"表里没有多行"——
 * 采集器读的是顶层 `event.usage`，而生产事件里那个字段**不存在**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { cacheUsageCount, listCacheUsage } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { activeRuntimes, apply } from '../src/index.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-cachewiring-'))

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

/** 假上下文（与 `turn-accounting-wiring.test.ts` / `loop-guard-register.test.ts` 同风格）。 */
function fakeCtx(): {
  readonly ctx: never
  readonly events: string[]
  readonly fire: (session: unknown, event: unknown) => void
} {
  const events: string[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ctx: Record<string, unknown> = {
    get: (name: string): unknown => (name === 'tokenMeter' ? undefined : undefined),
  }
  ctx['on'] = (event: string, handler: (...args: unknown[]) => void): (() => void) => {
    events.push(event)
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return (): void => {}
  }
  return {
    ctx: ctx as never,
    events,
    // 驱动**所有** session/event 订阅者（apply() 里不止一个）
    fire: (session: unknown, event: unknown) => {
      for (const handler of handlers.get('session/event') ?? []) handler(session, event)
    },
  }
}

/** 宿主真实信封：`{type, seq, time, data}` —— 载荷在 `data` 里。 */
function sessionEvent(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type, seq: 1, time: Date.now(), data }
}

/** 一次 `assistant/message` 结算的 `data`（与宿主 `SessionEventMap` 一致）。 */
function assistantData(
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [] },
    stream: [],
    ...(usage === undefined ? {} : { usage }),
    ...extra,
  }
}

/** 一条 `usage` chunk（宿主 `AssistantStreamRecord` 的 `chunk` 形态）。 */
function usageChunk(usage: Record<string, unknown>): Record<string, unknown> {
  return { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }
}

test('★★★ 端到端：`apply()` 订阅了 session/event，真形状的事件 ⇒ `cache_metrics` 真的多一行', async () => {
  const dir = tempDir()
  const messages: string[] = []
  const original = console.log
  const effects: (() => void)[] = []
  try {
    const fake = fakeCtx()
    const ctx = {
      ...(fake.ctx as unknown as Record<string, unknown>),
      effect(callback: () => void | (() => void)): void {
        const disposer = callback()
        if (typeof disposer === 'function') effects.push(disposer as () => void)
      },
    }
    console.log = (...args: unknown[]): void => {
      messages.push(args.join(' '))
    }
    apply(ctx as never, resolveConfig({ storageRoot: dir, verbose: true }))
    await delay(30)

    const runtime = activeRuntimes().at(-1)
    assert.ok(runtime !== undefined, '运行时必须登记（面板/诊断靠它取）')
    assert.ok(fake.events.includes('session/event'), `apply() 没有订阅 session/event —— 事件只有：${fake.events.join(', ')}`)
    assert.ok(
      messages.some((m) => m.includes('已订阅会话事件：采集缓存命中率')),
      `缓存采集这条订阅没有真的挂上 —— apply() 的日志：${messages.join(' | ')}`,
    )

    const before = cacheUsageCount(runtime.db)
    assert.equal(before, 0, '新库，起点是空表（这正是修复前生产里的**永久状态**）')

    // ── ① 宿主真形状：`{type, seq, time, data:{...usage}}` ──────────────────
    fake.fire(
      { id: 'sess_e2e' },
      sessionEvent(
        'assistant/message',
        assistantData({ inputTokens: 2048, outputTokens: 64, cacheWriteTokens: 512 }, { turn: 7, step: 2 }),
      ),
    )

    assert.equal(
      cacheUsageCount(runtime.db),
      before + 1,
      '**宿主形状的事件必须真的落库** —— 修复前这里恒为 0（读的是顶层 `event.usage`，生产里没有这个字段）',
    )
    const rows = listCacheUsage(runtime.db)
    const row = rows[rows.length - 1]
    assert.equal(row?.input_tokens, 2048)
    assert.equal(row?.cache_write_tokens, 512)
    assert.equal(row?.output_tokens, 64)
    assert.equal(row?.session_id, 'sess_e2e', '会话 id 由订阅者从第一个参数取')
    assert.equal(row?.turn, 7, '`turn` 在 `data` 里（顶层没有），也必须落库')
    assert.equal(row?.step, 2)
    assert.equal(row?.source, 'session')
    assert.equal(row?.miss_reason, 'first-call', '第一次采样：缓存还没建立')

    // ── ② 命中采样：走 `data.stream` 里的 `usage` chunk（宿主另一个真实位置）──
    fake.fire(
      { id: 'sess_e2e' },
      sessionEvent(
        'assistant/message',
        assistantData(undefined, {
          stream: [usageChunk({ inputTokens: 16, outputTokens: 8, cacheReadTokens: 8192 })],
        }),
      ),
    )
    assert.equal(cacheUsageCount(runtime.db), before + 2)
    const hit = listCacheUsage(runtime.db).at(-1)
    assert.equal(hit?.cache_read_tokens, 8192, '缓存命中数必须真的记上（`cache_metrics` 就是为它存在的）')
    assert.equal(hit?.miss_reason, null, '有命中 ⇒ 不归因')

    // ── ③ 顶层平铺的"想象形状"什么都不产生（严格只认宿主形状）──────────
    fake.fire({ id: 'sess_e2e' }, { type: 'assistant/message', turn: 7, step: 3, usage: { inputTokens: 9999, outputTokens: 1 } })
    assert.equal(cacheUsageCount(runtime.db), before + 2, '顶层平铺的 `usage` **不该**被接受（那正是修复前被喂绿的想象形状）')

    // ── ④ 不带用量的事件同样不写库 ────────────────────────────────────────
    fake.fire({ id: 'sess_e2e' }, sessionEvent('turn/start', { turn: 8 }))
    fake.fire({ id: 'sess_e2e' }, sessionEvent('assistant/message', assistantData(undefined)))
    assert.equal(cacheUsageCount(runtime.db), before + 2, '没有报账的事件不能写垃圾行')
  } finally {
    console.log = original
    for (const disposer of effects) disposer()
    await cleanup(dir)
  }
})
