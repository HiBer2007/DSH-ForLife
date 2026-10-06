/**
 * 唤醒请求队列的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **认领超时可回收** —— 插件处理到一半崩掉时，那一行必须能被重新认领。
 *    读了就删（或永久 claimed）的话，那次唤醒**静默丢失** ——
 *    而"模型该做的事没做"是最难发现的一种失败。
 * 2. **认领有上限** —— 防一次吃太多把内存打满。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import {
  CLAIM_TIMEOUT_MS,
  claimWakeRequests,
  completeWakeRequest,
  countPendingWakeRequests,
  enqueueWakeRequest,
  listWakeRequests,
} from '../src/wake-requests.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 造一个 db + 入队一条。 */
function setup(): {
  db: ReturnType<typeof openDatabase>['db']
  enqueue: (over?: Partial<{ triggerId: string; sessionId: string; text: string; now: Date }>) => string
  close: () => void
} {
  const opened = openDatabase({ file: ':memory:' })
  return {
    db: opened.db,
    enqueue: (over = {}) =>
      enqueueWakeRequest(opened.db, {
        triggerId: over.triggerId ?? 'wt_1',
        sessionId: over.sessionId ?? 'onebot11:123',
        text: over.text ?? '该醒醒了',
        sourceKind: 'wake-timer',
        summary: '测试',
        now: over.now ?? AT,
      }),
    close: () => opened.db.close(),
  }
}

test('★ 入队 ⇒ pending，且字段完整（提示词与 sourceKind 都要在）', () => {
  const s = setup()
  try {
    const id = s.enqueue()
    const rows = listWakeRequests(s.db)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, id)
    assert.equal(rows[0]?.status, 'pending')
    assert.equal(rows[0]?.session_id, 'onebot11:123')
    assert.equal(rows[0]?.text, '该醒醒了')
    // **sourceKind 绝不能是 user** —— 那等于伪造人类授权
    assert.equal(rows[0]?.source_kind, 'wake-timer')
    assert.notEqual(rows[0]?.source_kind, 'user')
    assert.equal(countPendingWakeRequests(s.db), 1)
  } finally {
    s.close()
  }
})

test('认领 ⇒ claimed，且记下认领者（排障要知道是谁拿走的）', () => {
  const s = setup()
  try {
    s.enqueue()
    const claimed = claimWakeRequests(s.db, 'plugin-pid-123', 5, AT)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.status, 'claimed')
    assert.equal(claimed[0]?.claimed_by, 'plugin-pid-123')
    // 已认领的不该被再次认领
    assert.equal(claimWakeRequests(s.db, 'other', 5, AT).length, 0)
  } finally {
    s.close()
  }
})

test('★ 认领超时 ⇒ **可回收**（插件崩了那行不能永久卡住）', () => {
  const s = setup()
  try {
    s.enqueue()
    claimWakeRequests(s.db, 'crashed-plugin', 5, AT)

    // 还没超时 ⇒ 拿不到
    const early = claimWakeRequests(s.db, 'new-plugin', 5, new Date(AT.getTime() + CLAIM_TIMEOUT_MS - 1000))
    assert.equal(early.length, 0, '没超时不该被抢走')

    // 超时了 ⇒ 拿得到，而且认领者换成新的
    const late = claimWakeRequests(s.db, 'new-plugin', 5, new Date(AT.getTime() + CLAIM_TIMEOUT_MS + 1000))
    assert.equal(late.length, 1, '超时后应当能被重新认领')
    assert.equal(late[0]?.claimed_by, 'new-plugin')
  } finally {
    s.close()
  }
})

test('★ 认领有上限（防一次吃太多把内存打满）', () => {
  const s = setup()
  try {
    for (let i = 0; i < 10; i += 1) s.enqueue({ triggerId: `wt_${String(i)}` })
    assert.equal(claimWakeRequests(s.db, 'p', 3, AT).length, 3, 'limit=3 就只该拿 3 条')
    assert.equal(claimWakeRequests(s.db, 'p', 3, AT).length, 3)
    assert.equal(claimWakeRequests(s.db, 'p', 3, AT).length, 3)
    assert.equal(claimWakeRequests(s.db, 'p', 3, AT).length, 1, '剩下 1 条')
    assert.equal(claimWakeRequests(s.db, 'p', 3, AT).length, 0)
  } finally {
    s.close()
  }
})

test('完成 ⇒ done，且结果落库；不再算 pending', () => {
  const s = setup()
  try {
    const id = s.enqueue()
    claimWakeRequests(s.db, 'p', 5, AT)
    completeWakeRequest(s.db, id, '模型回了用户', AT)
    const row = listWakeRequests(s.db)[0]
    assert.equal(row?.status, 'done')
    assert.equal(row?.result, '模型回了用户')
    assert.equal(countPendingWakeRequests(s.db), 0)
  } finally {
    s.close()
  }
})

test('完成后再认领 ⇒ 拿不到（done 是终态）', () => {
  const s = setup()
  try {
    const id = s.enqueue()
    claimWakeRequests(s.db, 'p', 5, AT)
    completeWakeRequest(s.db, id, 'ok', AT)
    assert.equal(claimWakeRequests(s.db, 'p', 5, new Date(AT.getTime() + 10 * CLAIM_TIMEOUT_MS)).length, 0)
  } finally {
    s.close()
  }
})

test('先进先出（按 created_at 排序）', () => {
  const s = setup()
  try {
    s.enqueue({ triggerId: 'first', now: new Date(AT.getTime() - 2000) })
    s.enqueue({ triggerId: 'second', now: AT })
    const claimed = claimWakeRequests(s.db, 'p', 5, AT)
    assert.equal(claimed[0]?.trigger_id, 'first')
    assert.equal(claimed[1]?.trigger_id, 'second')
  } finally {
    s.close()
  }
})

test('★ 入队的 text 是**组装好的提示词**（插件侧不该再拼）', () => {
  const s = setup()
  try {
    // 真实用法：gateway 侧已经用 buildWakePrompt 组装好，这里整段存下来
    const prompt = '## 触发\n定时到了\n\n## 你当时要自己做的事\n提醒吃药'
    s.enqueue({ text: prompt })
    const row = listWakeRequests(s.db)[0]
    assert.equal(row?.text, prompt, '提示词必须原样存下来（换行也不能丢）')
    assert.match(String(row?.text), /\n/, '换行要保留')
  } finally {
    s.close()
  }
})
