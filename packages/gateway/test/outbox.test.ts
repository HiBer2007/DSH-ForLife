/**
 * 动作队列的测试。
 *
 * 这层守的是**跨进程的正确性**：工具以为发出去了、实际没发出去，是最难发现的一类 bug。
 * 所以重点测：认领的原子性（不能重复发）、失败的可重试性区分、崩溃自愈（sending 卡住要退回）、
 * 以及"超时不是错误"这条语义。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { openDatabase } from '@forlife/store'

import {
  claimPendingOutbound,
  confirmOutbound,
  enqueueOutbound,
  failOutbound,
  getOutbound,
  listOutbound,
  outboxStats,
  reclaimStaleOutbound,
  waitForConfirmation,
} from '../src/outbox.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-outbox-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
})

after(async () => {
  close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

test('入队：状态为 pending，可被取回', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:88888', kind: 'text', payload: { segments: [{ kind: 'text', text: '你好' }] } })
  const row = getOutbound(db, id)
  assert.equal(row?.status, 'pending')
  assert.equal(row?.attempt, 0)
  assert.equal(row?.confirmed, 0)
  assert.equal(row?.source, 'model')
  assert.equal(row?.conversation_key, 'onebot11:88888')
  assert.deepEqual(JSON.parse(row?.payload ?? '{}'), { segments: [{ kind: 'text', text: '你好' }] })
})

test('认领：原子且不重复（两个消费者抢不到同一条）', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:1', kind: 'text', payload: {} })
  const first = claimPendingOutbound(db, { limit: 50 })
  assert.ok(first.some((r) => r.id === id), '第一次应当认领到')
  assert.equal(getOutbound(db, id)?.status, 'sending')
  assert.equal(getOutbound(db, id)?.attempt, 1, '认领要计数')

  // 第二次认领不该再拿到它（否则会重复发送）
  const second = claimPendingOutbound(db, { limit: 50 })
  assert.ok(!second.some((r) => r.id === id), '已被认领的动作不能再被认领')
})

test('确认：写入平台消息 id 且状态变 sent', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:2', kind: 'text', payload: {} })
  claimPendingOutbound(db, { limit: 50 })
  confirmOutbound(db, id, '12345')
  const row = getOutbound(db, id)
  assert.equal(row?.status, 'sent')
  assert.equal(row?.confirmed, 1)
  assert.equal(row?.platform_msg_id, '12345')
  assert.ok((row?.confirmed_at ?? '') > '')
  assert.equal(row?.error, null)
})

test('失败：不可重试直接 failed，可重试退回 pending', () => {
  const fatal = enqueueOutbound(db, { conversationKey: 'onebot11:3', kind: 'text', payload: {} })
  claimPendingOutbound(db, { limit: 50 })
  failOutbound(db, fatal, 'retcode=1400 风控拒绝')
  assert.equal(getOutbound(db, fatal)?.status, 'failed')
  assert.match(getOutbound(db, fatal)?.error ?? '', /风控/)

  const transient = enqueueOutbound(db, { conversationKey: 'onebot11:4', kind: 'text', payload: {} })
  claimPendingOutbound(db, { limit: 50 })
  failOutbound(db, transient, '连接断了', { retryable: true })
  assert.equal(getOutbound(db, transient)?.status, 'pending', '可重试的应当退回队列')
  assert.equal(getOutbound(db, transient)?.attempt, 1, '重试次数要保留（避免无限重试）')
})

test('重试上限：超过 maxAttempt 的动作不再被认领', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:5', kind: 'text', payload: {} })
  for (let i = 0; i < 3; i++) {
    claimPendingOutbound(db, { limit: 50 })
    failOutbound(db, id, '一直失败', { retryable: true })
  }
  assert.equal(getOutbound(db, id)?.attempt, 3)
  const claimed = claimPendingOutbound(db, { limit: 50, maxAttempt: 3 })
  assert.ok(!claimed.some((r) => r.id === id), '到达重试上限后不该再被认领（避免毒丸消息占满队列）')
})

test('崩溃自愈：卡在 sending 太久的动作被退回 pending', () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:6', kind: 'text', payload: {} })
  claimPendingOutbound(db, { limit: 50 })
  assert.equal(getOutbound(db, id)?.status, 'sending')

  // 立刻回收：这一行不该被动（还没超时）。
  // 注意断言的是**这一行**的状态而不是全局回收数 —— 别的用例也会留下 sending 行，
  // 用全局计数会让这条测试变得依赖执行顺序。
  reclaimStaleOutbound(db, 60_000)
  assert.equal(getOutbound(db, id)?.status, 'sending', '没超时就不该被回收')

  // 用一个"未来 10 分钟"的时钟回收：这一行应当退回
  reclaimStaleOutbound(db, 60_000, new Date(Date.now() + 600_000))
  assert.equal(getOutbound(db, id)?.status, 'pending', '网关崩溃后未完成的动作要能自愈')
})

test('送达确认：成功路径带回 messageId', async () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:7', kind: 'text', payload: {} })
  const waiting = waitForConfirmation(db, id, { timeoutMs: 1000, pollMs: 20 })
  claimPendingOutbound(db, { limit: 50 })
  confirmOutbound(db, id, '999')
  const result = await waiting
  assert.equal(result.confirmed, true)
  assert.equal(result.messageId, '999')
})

test('送达确认：超时**不是错误**，而是"未确认 + 自助提示"', async () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:8', kind: 'text', payload: {} })
  const result = await waitForConfirmation(db, id, { timeoutMs: 120, pollMs: 20 })
  assert.equal(result.confirmed, false, '没人确认 ⇒ 不能谎报成功')
  assert.equal(result.status, 'pending', '状态要如实回报（还是 pending，说明网关没认领）')
  assert.match(result.error ?? '', /未在 120ms 内收到送达确认/)
  assert.ok(getOutbound(db, id) !== undefined, '超时不该删掉队列行 —— 它可能稍后才发出去')
})

test('送达确认：失败路径把原因带回来', async () => {
  const id = enqueueOutbound(db, { conversationKey: 'onebot11:9', kind: 'text', payload: {} })
  const waiting = waitForConfirmation(db, id, { timeoutMs: 1000, pollMs: 20 })
  claimPendingOutbound(db, { limit: 50 })
  failOutbound(db, id, '群被解散了')
  const result = await waiting
  assert.equal(result.confirmed, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, '群被解散了')
})

test('送达确认：id 不存在时明确报错（不静默成功）', async () => {
  const result = await waitForConfirmation(db, 'out_不存在', { timeoutMs: 100, pollMs: 20 })
  assert.equal(result.confirmed, false)
  assert.match(result.error ?? '', /找不到该动作/)
})

test('统计与列表：面板要看得到积压', () => {
  const stats = outboxStats(db)
  assert.ok(stats.pending >= 1)
  assert.ok(stats.sent >= 1)
  assert.ok(stats.failed >= 1)
  const list = listOutbound(db, 5)
  assert.ok(list.length > 0)
  assert.ok(list.every((row) => typeof row.conversation_key === 'string'))
})

test('顺序：先入队的先被认领（FIFO，保证回复不乱序）', () => {
  const a = enqueueOutbound(db, { conversationKey: 'onebot11:20', kind: 'text', payload: { n: 1 } })
  const b = enqueueOutbound(db, { conversationKey: 'onebot11:20', kind: 'text', payload: { n: 2 } })
  const claimed = claimPendingOutbound(db, { limit: 100 })
  const indexA = claimed.findIndex((r) => r.id === a)
  const indexB = claimed.findIndex((r) => r.id === b)
  assert.ok(indexA >= 0 && indexB >= 0)
  assert.ok(indexA < indexB, '同会话的消息必须按入队顺序发送（模型分段的顺序就是用户看到的顺序）')
})

