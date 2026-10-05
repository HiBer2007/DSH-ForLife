/**
 * 多会话调度的测试 —— 直接对着验收标准写。
 *
 * 验收原话：「一个话痨群刷 50 条时，其它会话仍在 SLO 内被响应」。
 * 所以最关键的一条测试就是：让一个群刷 50 条，同时在私聊里放一条，
 * 断言**私聊不会被排在 50 条之后**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONDITION_PRIORITY, TurnScheduler } from '../src/scheduler.ts'

/** 可控时钟。 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => void (current += ms) }
}

test('优先级：明确信号 > 私聊 > 群聊闲聊', () => {
  assert.ok(CONDITION_PRIORITY.group_mention > CONDITION_PRIORITY.private_message, '@我 比私聊更该先理')
  assert.ok(CONDITION_PRIORITY.private_message > CONDITION_PRIORITY.group_message_any, '私聊比群聊闲聊更该先理')
  assert.ok(CONDITION_PRIORITY.group_mention_all >= CONDITION_PRIORITY.group_message_any, '@全体 至少不比闲聊低')
})

test('验收：话痨群刷 50 条时，私聊不会被饿死', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now, perConversationCooldownMs: 3000 })
  const chatter = 'onebot11:group-chatty'
  const quiet = 'onebot11:10001'

  // 话痨群刷 50 条（同会话 ⇒ 合并成一项）
  for (let i = 0; i < 50; i++) scheduler.enqueue({ conversationKey: chatter, condition: 'group_message_any' })
  assert.equal(scheduler.size(), 1, '同会话必须合并：50 条只占一个排队位')

  // 私聊来一条
  scheduler.enqueue({ conversationKey: quiet, condition: 'private_message' })
  assert.equal(scheduler.size(), 2)

  // 第一次调度：应当先服务私聊（优先级 80 > 20）
  const first = scheduler.next()
  assert.equal(first?.conversationKey, quiet, '私聊必须排在那 50 条前面')
  scheduler.complete(quiet)

  // 第二次：话痨群
  const second = scheduler.next()
  assert.equal(second?.conversationKey, chatter)
  scheduler.complete(chatter)

  // 关键：话痨群马上再刷 50 条，此时它被冷却挡住；另一个**还没被服务过**的会话应当立刻拿到机会。
  // （注意不能再用上面那个私聊：它刚被服务过，自己也在冷却里 —— 这正是冷却在正常工作。）
  const fresh = 'onebot11:10002'
  for (let i = 0; i < 50; i++) scheduler.enqueue({ conversationKey: chatter, condition: 'group_message_any' })
  scheduler.enqueue({ conversationKey: fresh, condition: 'private_message' })
  c.advance(100) // 才过 100ms，远不到 3 秒冷却
  const third = scheduler.next()
  assert.equal(third?.conversationKey, fresh, '冷却期内话痨群被挡住，其它会话不受影响')
})

test('合并：同一会话的多批消息只占一个排队位，且保留最高优先级', () => {
  const scheduler = new TurnScheduler()
  scheduler.enqueue({ conversationKey: 'k1', condition: 'group_message_any' })
  scheduler.enqueue({ conversationKey: 'k1', condition: 'group_message_any' })
  scheduler.enqueue({ conversationKey: 'k1', condition: 'group_mention' }) // 后来被 @ 了
  assert.equal(scheduler.size(), 1)
  const item = scheduler.next()
  assert.equal(item?.messageCount, 3, '三次入队合并成一项，消息数累计')
  assert.equal(item?.condition, 'group_mention', '合并时取更高的优先级（后来被 @ 就该按 @ 处理）')
})

test('冷却：同会话两次轮次之间强制间隔（防话痨的直接闸门）', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now, perConversationCooldownMs: 3000 })
  scheduler.enqueue({ conversationKey: 'k', condition: 'group_mention' })
  assert.ok(scheduler.next() !== undefined)
  scheduler.complete('k')

  // 冷却中：即便又入队，也拿不到
  scheduler.enqueue({ conversationKey: 'k', condition: 'group_mention' })
  assert.equal(scheduler.next(), undefined, '冷却期内不该被服务')
  const snapshot = scheduler.snapshot()
  assert.ok((snapshot.cooling[0]?.readyInMs ?? 0) > 0, '快照要能看到还要等多久')

  c.advance(3001)
  assert.ok(scheduler.next() !== undefined, '冷却结束即可服务')
})

test('配额：每会话每窗口最多 N 轮（话痨群只能占到自己那一份）', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now, perConversationCooldownMs: 0, perConversationMaxTurns: 3, perConversationWindowMs: 60_000 })
  let served = 0
  for (let i = 0; i < 10; i++) {
    scheduler.enqueue({ conversationKey: 'chatty', condition: 'group_message_any' })
    if (scheduler.next() !== undefined) {
      scheduler.complete('chatty')
      served += 1
    }
    c.advance(10)
  }
  assert.equal(served, 3, '窗口内最多 3 轮（再多也得等下一个窗口）')
  assert.equal(scheduler.next(), undefined, '配额用尽后拿不到')

  c.advance(60_001)
  scheduler.enqueue({ conversationKey: 'chatty', condition: 'group_message_any' })
  assert.ok(scheduler.next() !== undefined, '窗口过期后配额重置')
})

test('老化：等得久了，低优先级也会被提上来（不会无限期排不上）', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now, perConversationCooldownMs: 0, agingMsPerPoint: 1000 })
  // 低优先级但先到
  scheduler.enqueue({ conversationKey: 'old-low', condition: 'group_message_any' })
  c.advance(120_000) // 等 2 分钟 ⇒ 老化 +120 分，远超优先级差距
  // 高优先级但刚到
  scheduler.enqueue({ conversationKey: 'new-high', condition: 'group_mention' })

  const next = scheduler.next()
  assert.equal(next?.conversationKey, 'old-low', '等待足够久之后必须能被服务（否则低优先级会话会被永久饿死）')
  assert.ok((next?.score ?? 0) > CONDITION_PRIORITY.group_mention, '老化分应当把它抬到高优先级之上')
})

test('老化不越权：刚到的 @我 仍然先于刚到的闲聊', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now, perConversationCooldownMs: 0 })
  scheduler.enqueue({ conversationKey: 'chat', condition: 'group_message_any' })
  scheduler.enqueue({ conversationKey: 'mention', condition: 'group_mention' })
  c.advance(10) // 几乎同时
  assert.equal(scheduler.next()?.conversationKey, 'mention')
})

test('快照：排队项带等待时长与分数（面板要能看到"谁在等、等了多久"）', () => {
  const c = clock()
  const scheduler = new TurnScheduler({ now: c.now })
  scheduler.enqueue({ conversationKey: 'a', condition: 'private_message' })
  scheduler.enqueue({ conversationKey: 'a', condition: 'private_message' })
  c.advance(5000)
  scheduler.enqueue({ conversationKey: 'b', condition: 'group_message_any' })

  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.queued.length, 2)
  const a = snapshot.queued.find((q) => q.conversationKey === 'a')
  const b = snapshot.queued.find((q) => q.conversationKey === 'b')
  assert.equal(a?.waitedMs, 5000, '等了 5 秒')
  assert.equal(a?.messageCount, 2)
  assert.equal(b?.waitedMs, 0)
  assert.ok((a?.score ?? 0) > (b?.score ?? 0), '等得久的分数更高')
})

test('服务完成后从队列移除，不会重复处理', () => {
  const scheduler = new TurnScheduler({ perConversationCooldownMs: 0 })
  scheduler.enqueue({ conversationKey: 'k', condition: 'private_message' })
  assert.equal(scheduler.next()?.conversationKey, 'k')
  scheduler.complete('k')
  assert.equal(scheduler.has('k'), false)
  assert.equal(scheduler.next(), undefined)
})

