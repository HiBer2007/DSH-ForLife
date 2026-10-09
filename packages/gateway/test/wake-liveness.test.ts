/**
 * ★ QQ「离线」判据的守卫（`wake-liveness.ts`）—— 唤醒条件 `bot_offline` 的生产者。
 *
 * ## 这一条守的是什么（真实事故，不是理论风险）
 *
 * `research/napcat_issues.json:531`：**反向 WS 一直 ESTABLISHED，而 QQ 侧 35 小时没有任何事件**。
 * 那种形态下连接层显示"在线"，于是模型以为自己一切正常 —— 判据写错（或者干脆没写）
 * 的代价就是**永远发现不了它**。
 *
 * 所以这里逐条钉死判据：
 *  - **心跳是唯一与"有没有人说话"无关的证据**：心跳断了/`online=false` 才算离线；
 *  - **没有心跳时如实报"判不了"**，不许拿"这段时间没人说话"当离线（安静时段那是正常的）；
 *  - **WS 断**要单独标出来，且**不由本模块上报**（那条路径已经有上报者，重复报会把模型叫醒两次）；
 *  - **边沿**：离线期间连续 tick 只能判定一次 —— 否则 `wake_events` 会被刷屏、
 *    概率与全局预算也会被同一件事吃掉。
 *
 * @module forlife-gateway/test/wake-liveness
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '@forlife/store'

import { createLivenessMonitor, isSilentOffline, lastQqActivityAt, startLivenessWatch, NO_HEARTBEAT_REASON } from '../src/wake-liveness.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'

const opened: { close: () => void }[] = []
after(() => {
  for (const handle of opened) handle.close()
})

/** 全新的内存库。 */
function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

const T0 = new Date('2026-10-09T03:00:00.000Z')
const at = (secondsLater: number): Date => new Date(T0.getTime() + secondsLater * 1000)

/** 造一个判据（固定时钟，便于时间旅行）。 */
function monitorAt(now: Date = T0) {
  let current = now
  const monitor = createLivenessMonitor({ now: () => current, log: () => {} })
  return { monitor, travel: (to: Date) => { current = to } }
}

// ── 判据本身 ────────────────────────────────────────────────────────────────

test('★ 一次心跳都没收到 ⇒ 如实报「判不了」，而不是把"安静"当离线', () => {
  const { monitor } = monitorAt()
  const verdict = monitor.check(T0)
  assert.equal(verdict.state, 'unknown')
  assert.equal(verdict.evidence, 'no-heartbeat')
  assert.match(verdict.reason, /判不了/)
  assert.match(verdict.reason, /heartbeat/)
  // 这条理由必须**照着常量走**（它同时出现在日志与 system 触发的 detail 里）
  assert.equal(verdict.reason, NO_HEARTBEAT_REASON)
  // 关键：**不能**说成离线（那会让模型在每个安静的夜晚被叫醒一次）
  assert.equal(isSilentOffline(verdict), false)
})

test('心跳正常 ⇒ alive（带"距上次多少秒 / 阈值多少秒"）', () => {
  const { monitor } = monitorAt()
  const verdict = monitor.observeHeartbeat({ online: true, good: true, intervalMs: 30_000, at: T0 })
  assert.equal(verdict.state, 'alive')
  assert.equal(verdict.evidence, 'heartbeat-online')
  assert.match(verdict.reason, /心跳正常/)
  assert.equal(verdict.staleAfterMs, 90_000)
})

test('★ 心跳断了 ⇒ 离线（"WS 通、QQ 死"的唯一可判形态）', () => {
  const { monitor } = monitorAt()
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  // 阈值 = 3 × 30s = 90s：刚好 90s 还不算（> 才算），91s 算
  assert.equal(monitor.check(at(90)).state, 'alive')
  const verdict = monitor.check(at(91))
  assert.equal(verdict.state, 'offline')
  assert.equal(verdict.evidence, 'heartbeat-stale')
  assert.equal(verdict.sinceHeartbeatMs, 91_000)
  assert.match(verdict.reason, /心跳已停 91 秒/)
  assert.match(verdict.reason, /QQ 侧已经不发事件了/)
  assert.equal(isSilentOffline(verdict), true, '这一条必须由本模块上报')
})

test('★ 阈值下限 90 秒：心跳间隔被配小（10s）也不会 30 秒就判离线', () => {
  const { monitor } = monitorAt()
  monitor.observeHeartbeat({ online: true, intervalMs: 10_000, at: T0 })
  // 3 × 10s = 30s < 90s 下限 ⇒ 用 90s
  assert.equal(monitor.check(at(80)).state, 'alive')
  assert.equal(monitor.check(at(91)).state, 'offline')
})

test('心跳自带 online=false ⇒ 确诊离线（NapCat 自己说的）', () => {
  const { monitor } = monitorAt()
  const verdict = monitor.observeHeartbeat({ online: false, at: T0 })
  assert.equal(verdict.state, 'offline')
  assert.equal(verdict.evidence, 'heartbeat-online')
  assert.match(verdict.reason, /status\.online = false/)
  assert.equal(isSilentOffline(verdict), true)
})

test('bot_offline 通知 ⇒ 立刻离线；之后任何一条 online 心跳清掉旧结论', () => {
  const { monitor } = monitorAt()
  const notice = monitor.observeBotOffline('QQ 已离线', T0)
  assert.equal(notice.state, 'offline')
  assert.equal(notice.evidence, 'bot-offline-notice')
  assert.match(notice.reason, /NapCat 上报 bot_offline/)

  // 通知是**历史事件**，不能被当成永久状态：新心跳说在线 ⇒ 恢复
  const back = monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: at(5) })
  assert.equal(back.state, 'alive')
})

test('★ WS 断了 ⇒ 标成 ws-down 且**不由本模块上报**（否则同一件事叫醒两次）', () => {
  const { monitor } = monitorAt()
  monitor.observeTransport(false, 'ECONNRESET')
  const verdict = monitor.check(T0)
  assert.equal(verdict.state, 'offline')
  assert.equal(verdict.evidence, 'ws-down')
  assert.equal(isSilentOffline(verdict), false, 'qq.disconnected 那条路径已经在报了')
})

test('心跳能到达 ⇒ 隐含"WS 是通的"（它是从那条连接上来的）', () => {
  const { monitor } = monitorAt()
  monitor.observeTransport(false, '断过')
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  assert.equal(monitor.check(at(10)).state, 'alive')
})

// ── 诊断：最后一次"听到 QQ 说话" ────────────────────────────────────────────

test('lastQqActivityAt：消息与"非消息事件"两个来源都要看，取最新的那个', () => {
  const db = freshDb()
  assert.equal(lastQqActivityAt(db), undefined, '空库要说"没有"（不是编一个时间）')

  db.prepare(
    `INSERT INTO qq_inbox (id, conversation_key, platform_msg_id, sender_id, sender_name, is_group, is_self,
                           mentioned_me, mentioned_all, is_poke, media_kind, text, payload, at, received_at,
                           processed, merged_into, attempt, error)
     VALUES ('m1', 'onebot11:1', 'm1', '9', '她', 0, 0, 0, 0, 0, NULL, 'hi', '{}', ?, ?, 0, NULL, 0, NULL)`,
  ).run('2026-10-09T03:00:10.000Z', '2026-10-09T03:00:10.000Z')
  assert.equal(lastQqActivityAt(db), '2026-10-09T03:00:10.000Z')

  // 非消息事件（撤回/入群/好友申请…）走 effects，且**只有 qq_event:* 算**
  db.prepare(
    `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
     VALUES ('e1', 'qq_event:message_recalled', 'system', NULL, '{}', 1, 0, '2026-10-09T03:05:00.000Z')`,
  ).run()
  assert.equal(lastQqActivityAt(db), '2026-10-09T03:05:00.000Z', '非消息事件也要算"听到 QQ 说话了"')

  // 管理动作也写 effects —— 但它不是"QQ 活着"的证据，不能算进来
  db.prepare(
    `INSERT INTO effects (id, kind, actor, subject, detail, affects_model, reported, created_at)
     VALUES ('e2', 'admin_action', 'admin', NULL, '{}', 1, 0, '2026-10-09T04:00:00.000Z')`,
  ).run()
  assert.equal(lastQqActivityAt(db), '2026-10-09T03:05:00.000Z')
})

// ── 定时循环：过矩阵 + 边沿 ────────────────────────────────────────────────

/** 造一个循环（不起真定时器）。 */
function watchOn(db: DatabaseSync) {
  seedWakeRules(db)
  const reports: { state: string; detail: string }[] = []
  const logs: string[] = []
  let current = T0
  const { monitor, travel } = monitorAt(T0)
  const watch = startLivenessWatch({
    db,
    monitor,
    now: () => current,
    log: (message) => logs.push(message),
    report: (state, detail) => reports.push({ state, detail }),
    setIntervalImpl: () => ({ unref: () => {} }),
    clearIntervalImpl: () => {},
  })
  return {
    watch,
    reports,
    /** 只数"离线"那一类上报（`alive` 是恢复消息，混在一起数会看不懂）。 */
    silent: () => reports.filter((r) => r.state === 'silent'),
    logs,
    monitor,
    travel: (to: Date) => {
      current = to
      travel(to)
    },
    travelOnly: travel,
  }
}

const countBotOfflineEvents = (db: DatabaseSync): number =>
  (db.prepare("SELECT count(*) AS n FROM wake_events WHERE condition = 'bot_offline'").get() as { n: number }).n

test('★ 边沿：离线期间连续 tick 只判定一次（否则 wake_events 刷屏 + 吃掉预算）', () => {
  const db = freshDb()
  const { watch, reports, silent, monitor } = watchOn(db)

  watch.tick(T0) // 没有心跳 ⇒ unknown（不上报）
  watch.tick(T0)
  assert.equal(countBotOfflineEvents(db), 0, '判不了的时候不该有任何判定留痕')
  assert.equal(watch.reported(), 'unknown')

  // 来了心跳（在线）⇒ alive
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  assert.equal(watch.tick(T0).state, 'alive')
  assert.equal(watch.reported(), 'alive')

  // 心跳断掉 ⇒ 第一次 tick 判定 + 上报
  assert.equal(watch.tick(at(200)).state, 'offline')
  assert.equal(countBotOfflineEvents(db), 1)
  assert.equal(silent().length, 1)
  assert.equal(reports.at(-1)?.state, 'silent')
  assert.match(String(reports.at(-1)?.detail), /心跳已停/)

  // 之后每次 tick 都还是离线 —— 但**不能再判定、不能再上报**
  watch.tick(at(260))
  watch.tick(at(320))
  assert.equal(countBotOfflineEvents(db), 1, '同一次离线只能留一行痕')
  assert.equal(silent().length, 1, '同一次离线只能上报一次')
})

test('★ 心跳恢复 ⇒ 上报 alive（不报恢复的话模型会一直以为它是坏的）', () => {
  const db = freshDb()
  const { watch, reports, silent, monitor, travelOnly } = watchOn(db)
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  watch.tick(at(200))
  assert.equal(silent().length, 1)

  travelOnly(at(200))
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: at(200) })
  assert.equal(watch.tick(at(201)).state, 'alive')
  assert.equal(silent().length, 1, '恢复不该再多一条"离线"上报')
  assert.equal(reports.at(-1)?.state, 'alive')
  // 恢复**不过唤醒矩阵**：它是好消息，没有任何理由拦它
  assert.equal(countBotOfflineEvents(db), 1, '恢复不该再写一行判定留痕')
})

test('★ 过唤醒矩阵：把面板上的 bot_offline 关掉 ⇒ 检测到也不上报，且留痕写明原因', () => {
  const db = freshDb()
  const { watch, silent, logs, monitor } = watchOn(db)
  setWakeRule(db, '*', 'bot_offline', { enabled: false }, 'admin')

  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  watch.tick(T0)
  watch.tick(at(200))
  assert.equal(silent().length, 0, '矩阵不放行就不许上报')
  assert.equal(countBotOfflineEvents(db), 1, '但**必须留痕**：面板要能回答"为什么这次没叫它"')
  const row = db.prepare("SELECT decision, reason FROM wake_events WHERE condition = 'bot_offline'").get() as {
    decision: string
    reason: string
  }
  assert.equal(row.decision, 'skip')
  assert.equal(row.reason, 'disabled')
  assert.ok(logs.some((line) => line.includes('唤醒矩阵不放行')), '日志要说清是矩阵拦下的')
})

test('★ 概率也是真的：bot_offline 概率 0 ⇒ 与关掉同效（面板上那个数字真的生效）', () => {
  const db = freshDb()
  const { watch, silent, monitor } = watchOn(db)
  setWakeRule(db, '*', 'bot_offline', { probability: 0 }, 'admin')
  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  watch.tick(T0)
  watch.tick(at(200))
  assert.equal(silent().length, 0)
  const row = db.prepare("SELECT decision FROM wake_events WHERE condition = 'bot_offline'").get() as { decision: string }
  assert.equal(row.decision, 'skip')
})

test('判不了的时候**不写判定留痕**，但日志里要说清"为什么检测不到假活"', () => {
  const db = freshDb()
  const { watch, logs } = watchOn(db)
  watch.tick(T0)
  assert.equal(countBotOfflineEvents(db), 0)
  assert.ok(
    logs.some((line) => line.includes('判不了') && line.includes('heartbeat')),
    `日志里必须给出"缺心跳"这个原因（现在的日志：${logs.join('｜')}）`,
  )
})

test('lastQqActivityAt 的说明会进离线详情（"已经 N 分钟没收到任何 QQ 事件"）', () => {
  const db = freshDb()
  const { watch, reports, silent, monitor } = watchOn(db)
  db.prepare(
    `INSERT INTO qq_inbox (id, conversation_key, platform_msg_id, sender_id, sender_name, is_group, is_self,
                           mentioned_me, mentioned_all, is_poke, media_kind, text, payload, at, received_at,
                           processed, merged_into, attempt, error)
     VALUES ('m1', 'onebot11:1', 'm1', '9', '她', 0, 0, 0, 0, 0, NULL, 'hi', '{}', ?, ?, 0, NULL, 0, NULL)`,
  ).run(T0.toISOString(), T0.toISOString())

  monitor.observeHeartbeat({ online: true, intervalMs: 30_000, at: T0 })
  watch.tick(T0)
  watch.tick(at(200))
  assert.equal(silent().length, 1)
  assert.match(String(reports.at(-1)?.detail), /已经 3 分钟没有任何 QQ 事件/)
})
