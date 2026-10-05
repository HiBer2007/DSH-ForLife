/**
 * 铁律测试 —— 用户逐字要求的两条，必须被测试钉住。
 *
 * 铁律 1：后台任何影响模型的操作都要**唤醒并报告**（醒着就直接注入）。
 * 铁律 2：所有唤醒模型的消息**都不使用人类发送消息**（来源只能是 system/qq/admin）。
 *
 * 这两条一旦破了，表现是"模型以为没人动过它，其实被改过" —— 也就是幻觉。
 * 所以它们必须比功能本身更早被守住。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { listEffects, listUnreportedEffects, openDatabase, recordEffect } from '@forlife/store'

import {
  affectsModel,
  ALLOWED_SOURCES,
  assertReportSource,
  collectReportable,
  decideDelivery,
  isAwake,
  markReported,
  recordAdminAction,
  renderReport,
  runReportCycle,
} from '../src/reports.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-rules-'))
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
    } finally {
      await delay(20)
    }
  }
})

test('铁律 2：允许三种来源，禁止 user（含未登记来源）', () => {
  for (const source of ALLOWED_SOURCES) {
    assert.doesNotThrow(() => assertReportSource(source), `${source} 应当被允许`)
  }
  assert.throws(() => assertReportSource('user'), /铁律 2 被违反/)
  assert.throws(() => assertReportSource('someone-else'), /未登记的消息来源/)
})

test('铁律 1：影响判定表 —— 改记忆/提示词/工具/唤醒/状态要报，看日志不用报', () => {
  for (const action of [
    'memory.append',
    'memory.delete',
    'prompt.edit',
    'tool.disable',
    'wake.rule',
    'status.set',
    'status.clear',
    'model.switch',
    'inference.restart',
    'config.patch',
    'compaction.force',
    'sticker.add',
    'plugin.disable',
  ]) {
    assert.equal(affectsModel(action), true, `${action} 会影响模型，必须报告`)
  }
  for (const action of ['log.read', 'panel.view', 'export.download', 'queue.inspect', 'metrics.read']) {
    assert.equal(affectsModel(action), false, `${action} 不影响模型，不该打扰它`)
  }
})

test('审计：管理员操作落进 effects，且带上"是否影响模型"', () => {
  recordAdminAction(db, { action: 'prompt.edit', actor: 'admin', subject: 'style', detail: { before: 'A', after: 'B' } })
  recordAdminAction(db, { action: 'log.read', actor: 'admin', detail: { lines: 100 } })

  const rows = listEffects(db, 10, 'admin_action')
  assert.equal(rows.length, 2)
  const promptEdit = rows.find((r) => r.detail.includes('prompt.edit'))
  const logRead = rows.find((r) => r.detail.includes('log.read'))
  assert.equal(promptEdit?.affects_model, 1, '改提示词影响模型 ⇒ 要报告')
  assert.equal(logRead?.affects_model, 0, '看日志不影响模型 ⇒ 不打扰')
  assert.equal(promptEdit?.reported, 0, '刚记录时未报告')
})

test('合并窗口：窗口内不报（避免连点按钮把模型刷屏），安静后才报', () => {
  recordEffect(db, { id: 'eff_w1', kind: 'admin_action', actor: 'admin', subject: 'x', detail: { action: 'config.patch' }, affectsModel: true })
  // 基准时刻必须**贴着记录时刻**：写死一个未来时间会让窗口早就过去（那测的就不是窗口了）
  const now = new Date()

  // 刚刚发生 ⇒ 还在窗口内
  const early = collectReportable(db, { now, coalesceMs: 60_000 })
  assert.equal(early.effects.length, 0, '窗口内不该报告')

  // 61 秒后 ⇒ 该报了
  const later = collectReportable(db, { now: new Date(now.getTime() + 61_000), coalesceMs: 60_000 })
  assert.ok(later.effects.length >= 2, '安静的窗口过去后，把积攒的合并成一批')
  assert.match(later.text, /系统通知/)
  assert.match(later.text, /会影响你的操作/)
})

test('报告文本：说清"发生了什么 + 对你的影响 + 要不要做什么"', () => {
  const text = renderReport([
    { id: 'e1', kind: 'compaction', actor: 'system', subject: 'sess_1', detail: '{"pushed":2}', createdAt: '2026-10-05T12:00:00.000Z' },
    { id: 'e2', kind: 'wake_rule', actor: 'model', subject: 'group:1:group_mention', detail: '{}', createdAt: '2026-10-05T12:00:01.000Z' },
  ])
  assert.match(text, /压缩了你的记忆/, '要说人话，不是干巴巴一行日志')
  assert.match(text, /改了唤醒规则/)
  assert.match(text, /已经生效/, '必须告诉它"改动已生效"')
  assert.match(text, /以本次通知为准/, '必须给冲突时的裁决规则（这正是防幻觉的关键）')
})

test('投递决策：醒着就注入，睡着才唤醒（铁律 1 的后半句）', () => {
  db.exec("DELETE FROM qq_turns")
  const batch = { effects: [{ id: 'e', kind: 'x', actor: 'system', subject: null, detail: '{}', createdAt: '' }], text: 'x' }
  assert.equal(decideDelivery(db, batch).mode, 'wake', '没有 running 轮次 ⇒ 需要唤醒')

  db.prepare(
    `INSERT INTO qq_turns (id, conversation_key, status, started_at, ended_at, session_id, model, input_ids, tokens_in, tokens_out, tool_calls, defer_reason, defer_until, error)
     VALUES ('t1', 'onebot11:1', 'running', ?, NULL, NULL, NULL, '[]', 0, 0, 0, NULL, NULL, NULL)`,
  ).run(new Date().toISOString())
  assert.equal(isAwake(db), true)
  assert.equal(decideDelivery(db, batch).mode, 'inject', '已经醒着 ⇒ 直接注入，不重复唤醒')
})

test('报告只发一次：标记后不再出现在待报告里', () => {
  const cycle = runReportCycle(db, { now: new Date(Date.now() + 600_000), coalesceMs: 1 })
  assert.ok(cycle.batch.effects.length > 0)
  const before = listUnreportedEffects(db).length
  const marked = cycle.commit()
  assert.ok(marked > 0)
  assert.ok(listUnreportedEffects(db).length < before, '报告后不该重复出现')
  // 再跑一次：不该又冒出来
  const again = runReportCycle(db, { now: new Date(Date.now() + 1_200_000), coalesceMs: 1 })
  assert.equal(again.batch.effects.filter((e) => cycle.batch.effects.some((c) => c.id === e.id)).length, 0)
})

test('不影响模型的操作永远不会被报告（不打扰）', () => {
  recordAdminAction(db, { action: 'metrics.read', actor: 'admin', detail: {} })
  const pending = listUnreportedEffects(db)
  assert.ok(!pending.some((row) => row.detail.includes('metrics.read')), '"看一眼指标"不该吵醒模型')
})

test('直接标记：markReported 幂等', () => {
  recordEffect(db, { id: 'eff_idem', kind: 'admin_action', actor: 'admin', detail: { action: 'config.patch' }, affectsModel: true })
  const batch = { effects: [{ id: 'eff_idem', kind: 'admin_action', actor: 'admin', subject: null, detail: '{}', createdAt: '' }], text: 'x' }
  assert.equal(markReported(db, batch.effects), 1)
  assert.equal(markReported(db, batch.effects), 0, '重复标记不产生变化')
})

