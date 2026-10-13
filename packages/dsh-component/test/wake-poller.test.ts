/**
 * 唤醒轮询器的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **`sourceKind` 绝不能是 `user`** —— 那等于伪造人类授权。
 * 2. **会话忙 ⇒ 不打断、也不标记完成** —— 标记完成那次唤醒就丢了；
 *    打断会把用户正在等的回答截断。
 * 3. **flush 失败 ⇒ 算失败** —— 没落盘的话进程一挂那次唤醒就没了，
 *    而模型可能已经做了动作（比如发了消息）—— 账对不上。
 * 4. **会话不存在 ⇒ 标记完成** —— 重试也没用，留着只会永远卡在队列里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimWakeRequests, enqueueWakeRequest, listWakeRequests, openDatabase } from '@forlife/store'

import { deliverWakeRequest, startWakePoller, type WakeDeliveryHost } from '../src/wake-poller.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 造一行唤醒请求（不走 db，直接构造对象）。 */
function row(over: Partial<Record<string, unknown>> = {}): Parameters<typeof deliverWakeRequest>[1] {
  return {
    id: 'wr_1',
    trigger_id: 'wt_1',
    session_id: 'onebot11:123',
    text: '该醒醒了',
    source_kind: 'wake-timer',
    summary: '测试',
    status: 'claimed',
    created_at: AT.toISOString(),
    claimed_at: AT.toISOString(),
    claimed_by: 'p',
    done_at: null,
    result: null,
    ...over,
  } as never
}

/** 造一个可控的 host。 */
function host(over: Partial<WakeDeliveryHost> & { status?: string; flushOk?: boolean; resolve?: boolean } = {}): {
  host: WakeDeliveryHost
  sent: unknown[]
  flushed: number
} {
  const sent: unknown[] = []
  let flushed = 0
  const built: WakeDeliveryHost = {
    resolveAgent: async (sessionId: string) => {
      if (over.resolve === false) return undefined
      return {
        agent: {
          status: over.status ?? 'idle',
          followup: (m: unknown) => {
            sent.push(m)
          },
          session: { id: sessionId },
        },
      }
    },
    flush: async () => {
      flushed += 1
      return over.flushOk !== false
    },
    createMessage: (input) => ({ text: input.text, source: { kind: input.sourceKind, summary: input.summary } }),
    withoutInitiator: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    ...over,
  }
  return { host: built, sent, get flushed() { return flushed } } as never
}

test('★ 正常投递：followup 被调用、flush 被调用、算完成', async () => {
  const h = host()
  const result = await deliverWakeRequest(h.host, row())
  assert.equal(result.done, true)
  assert.equal(h.sent.length, 1)
  const msg = h.sent[0] as { text: string; source: { kind: string } }
  assert.equal(msg.text, '该醒醒了', '提示词要原样传过去')
  assert.equal(msg.source.kind, 'wake-timer')
  assert.equal(h.flushed, 1, '必须落盘确认')
})

test('★ sourceKind 是 user ⇒ **拒绝投递**（不能伪造人类授权）', async () => {
  const h = host()
  const result = await deliverWakeRequest(h.host, row({ source_kind: 'user' }))
  assert.equal(result.done, true)
  assert.equal(h.sent.length, 0, '**绝不能发出去**')
  assert.match(result.reason, /伪装成用户消息/)
})

test('sourceKind 为空 ⇒ 也拒绝（空值同样是"没说清是谁发的"）', async () => {
  const h = host()
  const result = await deliverWakeRequest(h.host, row({ source_kind: '  ' }))
  assert.equal(result.done, true)
  assert.equal(h.sent.length, 0)
})

test('★ 会话忙 ⇒ **不打断、不标记完成**（等超时回收后重试）', async () => {
  const h = host({ status: 'busy' })
  const result = await deliverWakeRequest(h.host, row())
  assert.equal(result.done, false, '不能标记完成 —— 那会丢掉这次唤醒')
  assert.equal(h.sent.length, 0, '**不能打断**正在跑的会话')
  assert.match(result.reason, /正忙/)
})

test('★ flush 失败 ⇒ 算失败（没落盘的话进程一挂就没了）', async () => {
  const h = host({ flushOk: false })
  const result = await deliverWakeRequest(h.host, row())
  assert.equal(result.done, false)
  assert.match(result.reason, /落盘/)
})

test('★ 会话不存在 ⇒ 标记完成（重试也没用，留着只会永远卡住）', async () => {
  const h = host({ resolve: false })
  const result = await deliverWakeRequest(h.host, row())
  assert.equal(result.done, true, '应当标记完成而不是无限重试')
  assert.match(result.reason, /不存在/)
})

test('★ 轮询器：认领 → 投递 → 标记完成', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    enqueueWakeRequest(opened.db, {
      triggerId: 'wt_1', sessionId: 'onebot11:123', text: '起来干活', sourceKind: 'wake-timer', summary: '定时', now: AT,
    })
    const h = host()
    const poller = startWakePoller({
      db: opened.db, host: h.host, claimer: 'test',
      setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {},
    })
    const out = await poller.tick()
    assert.equal(out.length, 1)
    assert.equal(out[0]?.result.done, true)
    assert.equal(h.sent.length, 1)
    // 库里应当已标记完成
    assert.equal(listWakeRequests(opened.db)[0]?.status, 'done')
  } finally {
    opened.db.close()
  }
})

test('★ 忙的时候**留在队列里**（不标记完成，下一轮还能拿到）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    enqueueWakeRequest(opened.db, {
      triggerId: 'wt_1', sessionId: 'onebot11:123', text: 'x', sourceKind: 'wake-timer', summary: 's', now: AT,
    })
    const h = host({ status: 'busy' })
    const poller = startWakePoller({
      db: opened.db, host: h.host, claimer: 'test',
      setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {},
    })
    await poller.tick()
    // 还是 claimed（没完成）⇒ 超时回收后会被重新认领
    const st = listWakeRequests(opened.db)[0]?.status
    assert.notEqual(st, 'done', '忙的时候不能标记完成')
    // 超时之后能重新认领
    // 轮询器认领时用的是**真实当前时间**（claimWakeRequests 默认 new Date()）——
    // 所以超时判断也必须基于当前时间，不能用测试里的固定 AT
    const reclaimed = claimWakeRequests(opened.db, 'other', 5, new Date(Date.now() + 10 * 60_000))
    assert.equal(reclaimed.length, 1, '超时后应当能重新认领')
  } finally {
    opened.db.close()
  }
})

test('★ 投递抛异常 ⇒ 不标记完成、不拖垮整轮', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    enqueueWakeRequest(opened.db, {
      triggerId: 'wt_1', sessionId: 'onebot11:123', text: 'x', sourceKind: 'wake-timer', summary: 's', now: AT,
    })
    const h = host({
      resolveAgent: async () => {
        throw new Error('resolveAgent 炸了')
      },
    })
    const poller = startWakePoller({
      db: opened.db, host: h.host, claimer: 'test',
      setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {},
    })
    const out = await poller.tick()
    assert.equal(out.length, 1)
    assert.equal(out[0]?.result.done, false, '异常不能算完成')
    assert.notEqual(listWakeRequests(opened.db)[0]?.status, 'done')
  } finally {
    opened.db.close()
  }
})

test('claim 的认领者标识会记下来（排障要知道是谁拿走的）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    enqueueWakeRequest(opened.db, {
      triggerId: 'wt_1', sessionId: 's', text: 'x', sourceKind: 'wake-timer', summary: 's', now: AT,
    })
    const h = host()
    const poller = startWakePoller({
      db: opened.db, host: h.host, claimer: 'plugin-abc',
      setIntervalImpl: () => ({ unref: () => {} }), clearIntervalImpl: () => {},
    })
    await poller.tick()
    // 完成后 claimed_by 仍在（审计线索）
    assert.equal(listWakeRequests(opened.db)[0]?.claimed_by, 'plugin-abc')
  } finally {
    opened.db.close()
  }
})
