/**
 * 离线积压（通知 / 取回 / 单独参数组）与两个方向的限制。
 *
 * 这个文件里最该被钉死的三条：
 *  1. **通知里不许出现正文**（用哨兵字符串断言它不出现）——
 *     违反它就退化成"把积压塞进上下文"，而那正是要避免的事；
 *  2. 取回的三重上限（单次 / 单轮批数 / 单轮总量）；
 *  3. `pending_backlog` 是**单独一组**：关掉它不影响在线消息的唤醒规则。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { defaultFor } from '@forlife/contracts'
import { openDatabase } from '@forlife/store'

import {
  BACKLOG_WAKE_CONDITION,
  backlogNotice,
  countUnread,
  decideBacklogWake,
  listBacklogWakeRule,
  readBacklog,
  renderBacklogNotice,
  seedBacklogWakeRule,
} from '../src/backlog.ts'
import { backlogReadQuota, consumeBacklogRead, decideSendQuota, deliverPacing } from '../src/limits.ts'
import { enqueueOutbound, confirmOutbound } from '../src/outbox.ts'
import { readPending, seedWakeRules, setWakeRule, WAKE_CONDITIONS } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-backlog-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

/** ★ 哨兵：正文里绝不能出现在通知里。 */
const SENTINEL = '绝密正文哨兵-不要在通知里出现'

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
})

after(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

/** 往"没读的"池子里塞一条。 */
function addPending(id: string, scope: string, conversationKey: string, summary: string, at: string): void {
  db.prepare(
    `INSERT INTO pending_messages (id, scope, conversation_key, sender_name, summary, at, read, read_at)
     VALUES (?, ?, ?, '某人', ?, ?, 0, NULL)`,
  ).run(id, scope, conversationKey, summary, at)
}

/** 清空池子（各条测试之间互不干扰）。 */
function resetPending(): void {
  db.exec('DELETE FROM pending_messages')
}

test('★ 通知：只报数量/来源/时间范围，**一个字的正文都没有**', () => {
  resetPending()
  addPending('p1', 'group:88888', 'onebot11:88888', SENTINEL, '2026-10-09T01:00:00.000Z')
  addPending('p2', 'group:88888', 'onebot11:88888', `第二条 ${SENTINEL}`, '2026-10-09T02:00:00.000Z')
  addPending('p3', 'private:10001', 'onebot11:10001', SENTINEL, '2026-10-09T03:00:00.000Z')

  const notice = backlogNotice(db)
  assert.equal(notice.unread, 3)
  assert.equal(notice.conversations, 2)
  assert.equal(notice.groupUnread, 2)
  assert.equal(notice.privateUnread, 1)
  assert.equal(notice.oldestAt, '2026-10-09T01:00:00.000Z')
  assert.equal(notice.newestAt, '2026-10-09T03:00:00.000Z')

  const text = renderBacklogNotice(notice, { now: new Date('2026-10-09T04:00:00.000Z') })
  assert.match(text, /3 条/, '要说清有多少条')
  assert.match(text, /group:88888/, '要说清来自哪')
  assert.match(text, /小时/, '要说清积压了多久')
  // ★★ 这才是这条测试的重点
  assert.ok(!text.includes(SENTINEL), '**通知里绝对不能出现消息正文** —— 那等于把积压塞进上下文')
  assert.match(text, /read_pending/, '要告诉它怎么取回来')
  assert.match(text, /硬要求/, '措辞必须是硬要求（"强制"的强度就落在这里）')
})

test('★ 通知：没有积压时返回空串（调用方据此决定要不要加这一段）', () => {
  resetPending()
  assert.equal(renderBacklogNotice(backlogNotice(db)), '')
  assert.equal(backlogNotice(db).unread, 0)
})

test('★ 取回：按来源/类型筛，并如实报"还剩多少"', () => {
  resetPending()
  addPending('r1', 'group:88888', 'onebot11:88888', '群里第一条', '2026-10-09T01:00:00.000Z')
  addPending('r2', 'group:99999', 'onebot11:99999', '群里第二条', '2026-10-09T02:00:00.000Z')
  addPending('r3', 'private:10001', 'onebot11:10001', '私聊那条', '2026-10-09T03:00:00.000Z')

  // 只取私聊 —— 这正是"群消息可以单独忽略"的落地方式
  const priv = readBacklog(db, { kind: 'private', limit: 10 })
  assert.equal(priv.items.length, 1)
  assert.equal(priv.items[0]?.summary, '私聊那条')
  assert.equal(priv.remaining, 0, '剩余量必须按**同一个筛选口径**算（这里私聊只剩 0）')

  // 再取全部：群里那两条还在
  const rest = readBacklog(db, { limit: 10 })
  assert.equal(rest.items.length, 2)
  assert.equal(rest.remaining, 0)

  // 已读的不再出现
  assert.equal(readBacklog(db, { limit: 10 }).items.length, 0)
})

test('★ 取回：精确到来源与到会话都能筛（两者不是一回事）', () => {
  resetPending()
  addPending('s1', 'group:88888', 'onebot11:88888', 'A', '2026-10-09T01:00:00.000Z')
  addPending('s2', 'group:99999', 'onebot11:99999', 'B', '2026-10-09T02:00:00.000Z')
  assert.equal(countUnread(db, { scope: 'group:88888' }), 1)
  assert.equal(countUnread(db, { conversationKey: 'onebot11:99999' }), 1)
  assert.equal(countUnread(db, { kind: 'group' }), 2)
  assert.equal(countUnread(db), 2)
  resetPending()
})

test('★ 取回额度：单次上限压下来，并如实说明', () => {
  resetPending()
  const perBatch = defaultFor<number>('qq.backlog.readBatchMax')
  const quota = backlogReadQuota(db, { requested: perBatch * 10 })
  assert.equal(quota.allowed, true)
  assert.equal(quota.granted, perBatch, '单次不许超过 qq.backlog.readBatchMax')
  assert.match(quota.reason, new RegExp(String(perBatch)))
  resetPending()
})

test('★★ 取回额度：单轮批数与单轮总量都会拦，且拦的时候说清为什么', () => {
  resetPending()
  const batchesMax = defaultFor<number>('qq.backlog.readPerTurnBatches')
  const batchMax = defaultFor<number>('qq.backlog.readBatchMax')
  // 本轮没有 running 轮次 ⇒ turnId 为 ''，计数在同一"轮"里累计
  for (let i = 0; i < batchesMax; i++) {
    assert.equal(backlogReadQuota(db).allowed, true, `第 ${String(i + 1)} 批应该放行`)
    consumeBacklogRead(db, batchMax)
  }
  const blocked = backlogReadQuota(db)
  assert.equal(blocked.allowed, false, '超过单轮批数必须拦下')
  assert.equal(blocked.granted, 0)
  assert.match(blocked.reason, /readPerTurnBatches/, '要告诉调用方是被哪条基线挡的')

  // 换个"轮次"（插一条 running 轮次）⇒ 计数归零
  db.prepare(
    `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
     VALUES ('turn_test_1', 'onebot11:10001', 'running', ?, NULL, NULL, NULL, '[]', 0, 0, 0, NULL, NULL, NULL)`,
  ).run(new Date().toISOString())
  assert.equal(backlogReadQuota(db).allowed, true, '换了一轮就该重新有额度（计数是"本轮"的口径）')
  assert.equal(backlogReadQuota(db).batchesUsed, 0)
  db.exec("DELETE FROM qq_turns WHERE id = 'turn_test_1'")
  resetPending()
})

test('★ 发消息限制：突发窗口与每分钟上限都会拦，理由是人话', () => {
  const now = new Date('2026-10-09T10:00:00.000Z')
  const burstMax = defaultFor<number>('qq.send.burstMax')
  const perMinuteMax = defaultFor<number>('qq.send.perMinuteMax')
  assert.equal(decideSendQuota(db, { now }).allowed, true, '一条都没有时当然放行')

  // 塞满突发窗口
  for (let i = 0; i < burstMax; i++) {
    const id = enqueueOutbound(db, { conversationKey: 'onebot11:10001', conversationKind: 'private', kind: 'text', payload: {} })
    db.prepare('UPDATE qq_outbox SET sent_at = ? WHERE id = ?').run(now.toISOString(), id)
  }
  const burst = decideSendQuota(db, { now })
  assert.equal(burst.allowed, false)
  assert.match(burst.reason, /突发上限/)
  assert.ok(burst.retryAfterMs > 0, '要告诉模型等多久')

  // 过了突发窗口但没到一分钟：还能发（每分钟上限还没到）
  const later = new Date(now.getTime() + defaultFor<number>('qq.send.burstWindowMs') + 1000)
  assert.equal(decideSendQuota(db, { now: later }).allowed, true)

  // 只测"每分钟上限"：先把队列清空，再把 perMinuteMax 条全部放在
  // **突发窗口之外、一分钟之内** ⇒ 这样能拦下它的只可能是每分钟上限。
  db.exec('DELETE FROM qq_outbox')
  const outsideBurst = new Date(later.getTime() - defaultFor<number>('qq.send.burstWindowMs') - 1000)
  for (let i = 0; i < perMinuteMax; i++) {
    const id = enqueueOutbound(db, { conversationKey: 'onebot11:10001', conversationKind: 'private', kind: 'text', payload: {} })
    db.prepare('UPDATE qq_outbox SET sent_at = ? WHERE id = ?').run(outsideBurst.toISOString(), id)
  }
  const perMinute = decideSendQuota(db, { now: later })
  assert.equal(perMinute.allowed, false)
  assert.match(perMinute.reason, /一分钟/, '这时该由"每分钟上限"接管（突发窗口里没有那么多条）')
  assert.equal(perMinute.burstCount, 0, '前提：突发窗口里确实是空的')
  db.exec('DELETE FROM qq_outbox')
})

test('★ 投递节拍：两条真正发出去的之间要隔开（与入队侧的闸门不是一回事）', () => {
  db.exec('DELETE FROM qq_outbox')
  const minInterval = defaultFor<number>('qq.send.minIntervalMs')
  assert.equal(deliverPacing(db).waitMs, 0, '没发过东西时不必等')

  const id = enqueueOutbound(db, { conversationKey: 'onebot11:10001', conversationKind: 'private', kind: 'text', payload: {} })
  const at = new Date('2026-10-09T10:00:00.000Z')
  confirmOutbound(db, id, '9001')
  db.prepare('UPDATE qq_outbox SET confirmed_at = ? WHERE id = ?').run(at.toISOString(), id)

  const immediate = deliverPacing(db, { now: new Date(at.getTime() + 50) })
  assert.ok(immediate.waitMs > 0, '刚发完不许马上发下一条')
  assert.equal(immediate.minIntervalMs, minInterval)
  assert.equal(deliverPacing(db, { now: new Date(at.getTime() + minInterval + 1) }).waitMs, 0)
  db.exec('DELETE FROM qq_outbox')
})

// ── ★ 单独一组参数 ──────────────────────────────────────────────────────────

test('★★ 单独一组：`pending_backlog` 不在新消息那组里，播种后按基线生效', () => {
  // ① 它**不在** `WAKE_CONDITIONS` 里 —— 这就是"单独一组"的字面含义：
  //    关掉它不会连带关掉 private_message / group_message_any。
  assert.ok(!(WAKE_CONDITIONS as readonly string[]).includes(BACKLOG_WAKE_CONDITION), '积压唤醒必须是独立的一条')

  // ② 播种后能读到，且值来自基线
  assert.equal(seedBacklogWakeRule(db), true, '第一次要真的插进去')
  assert.equal(seedBacklogWakeRule(db), false, '播种必须幂等')
  const rule = listBacklogWakeRule(db)
  const baseline = defaultFor<{ enabled: boolean; probability: number }>('wake.rules.pendingBacklog')
  assert.equal(rule.enabled, baseline.enabled)
  assert.equal(rule.probability, baseline.probability)
  assert.equal(rule.minIntervalMs, defaultFor<number>('qq.backlog.wakeIntervalMs'), '最小间隔必须来自基线，不是硬编码兜底')
})

test('★★ 没到门槛就不为积压开口（免得为 1 条闲聊把模型吵醒）', () => {
  resetPending()
  const min = defaultFor<number>('qq.backlog.wakeMinUnread')
  addPending('t1', 'group:88888', 'onebot11:88888', '一条闲聊', '2026-10-09T01:00:00.000Z')
  if (min > 1) {
    assert.equal(decideBacklogWake(db), undefined, `只有 1 条时不该到门槛（门槛 ${String(min)}）`)
  }
  for (let i = 1; i < min; i++) {
    addPending(`t${String(i + 1)}`, 'group:88888', 'onebot11:88888', `闲聊 ${String(i)}`, '2026-10-09T01:00:00.000Z')
  }
  const decision = decideBacklogWake(db, { random: () => 0 })
  assert.ok(decision !== undefined, '到了门槛就该判')
  assert.equal(decision.verdict.condition, BACKLOG_WAKE_CONDITION)
  assert.equal(decision.verdict.decision, 'wake')
  resetPending()
})

test('★★ 积压唤醒**不会把积压抄一份进积压**（池子不许自己长大）', () => {
  resetPending()
  const min = defaultFor<number>('qq.backlog.wakeMinUnread')
  for (let i = 0; i < min; i++) addPending(`g${String(i)}`, 'group:88888', 'onebot11:88888', `第 ${String(i)} 条`, '2026-10-09T01:00:00.000Z')
  const beforeCount = countUnread(db)
  decideBacklogWake(db, { random: () => 0 })
  // 关掉规则 ⇒ 判定为 skip ⇒ 若它带了 summary，`decideWake` 会往池子里再写一条
  setWakeRule(db, '*', BACKLOG_WAKE_CONDITION as never, { enabled: false }, 'admin')
  decideBacklogWake(db, { random: () => 0 })
  assert.equal(countUnread(db), beforeCount, '无论唤醒还是跳过，都不能往待读池里再写 —— 那会让池子自己长大')
  setWakeRule(db, '*', BACKLOG_WAKE_CONDITION as never, { enabled: true }, 'admin')
  resetPending()
})

test('★★ 关掉积压唤醒**不影响**在线消息的唤醒规则（用户要的"不影响正常在线"）', () => {
  resetPending()
  const before = readPending(db, { limit: 1, markRead: false })
  void before
  setWakeRule(db, '*', BACKLOG_WAKE_CONDITION as never, { enabled: false }, 'admin')
  // 另一组照旧
  assert.equal(listBacklogWakeRule(db).enabled, false)
  const privateRule = db.prepare("SELECT probability FROM wake_rules WHERE scope = '*' AND condition = 'private_message'").get() as { probability: number }
  assert.equal(privateRule.probability, 80, '在线私聊唤醒不受积压那组影响')
  setWakeRule(db, '*', BACKLOG_WAKE_CONDITION as never, { enabled: true }, 'admin')
})
