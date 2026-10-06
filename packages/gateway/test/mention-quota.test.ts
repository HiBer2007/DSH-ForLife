/**
 * @全体 额度闸门的守卫测试。
 *
 * 用户指出的坑：NapCat 该接口返回值**与 group_id 不完全相关**，
 * 所以要同时看群维度与账号维度并**保守取值**。
 *
 * 最值得守的两条：
 *  1. **取最小值** —— 只看群维度会高估（群还剩 5 次、账号已 0 次 ⇒ 实际发不出去）
 *  2. **查不到就拒绝**（fail-closed）—— "查不到当无限"会让闸门在最该起作用时失效
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideMentionAll, decideWithLedger, newMentionLedger } from '../src/mention-quota.ts'

test('★ 保守取值：两个维度取最小（只看群维度会高估）', () => {
  const result = decideMentionAll({ canAtAll: true, remainGroup: 5, remainAccount: 0 })
  assert.equal(result.allowed, false, '账号维度已 0 ⇒ 必须拒绝（群维度还剩 5 也没用）')
  assert.equal(result.remaining, 0)
  assert.match(result.reason, /用尽/)

  const both = decideMentionAll({ canAtAll: true, remainGroup: 5, remainAccount: 3 })
  assert.equal(both.allowed, true)
  assert.equal(both.remaining, 3, '应取较小值 3，不是 5')
  assert.deepEqual(both.dimensions, ['group', 'account'])
})

test('can_at_all=false ⇒ 直接拒绝（QQ 侧明确否决，数字再好看也没用）', () => {
  const result = decideMentionAll({ canAtAll: false, remainGroup: 99, remainAccount: 99 })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /不允许/)
})

test('★ 两个维度都拿不到 ⇒ 拒绝（fail-closed，不能当无限）', () => {
  const result = decideMentionAll({ canAtAll: true })
  assert.equal(result.allowed, false, '查不到额度时必须拒绝')
  assert.match(result.reason, /保守拒绝/)
})

test('只拿到一个维度 ⇒ 用它，但说明只依据了单维度（不假设另一个很大）', () => {
  const onlyGroup = decideMentionAll({ canAtAll: true, remainGroup: 2 })
  assert.equal(onlyGroup.allowed, true)
  assert.equal(onlyGroup.remaining, 2)
  assert.match(onlyGroup.reason, /单维度/)
  assert.deepEqual(onlyGroup.dimensions, ['group'])

  const onlyAccount = decideMentionAll({ canAtAll: true, remainAccount: 1 })
  assert.equal(onlyAccount.remaining, 1)
  assert.deepEqual(onlyAccount.dimensions, ['account'])
})

test('拒绝时要给下一步（不能只说不行）', () => {
  const exhausted = decideMentionAll({ canAtAll: true, remainGroup: 0, remainAccount: 0 })
  assert.match(exhausted.reason, /群公告|普通消息/, '应提示可改用群公告或普通消息')
})

test('★ 本地账本只做减法：防止 NapCat 返回值滞后时连发超限', () => {
  const ledger = newMentionLedger()
  const snapshot = { canAtAll: true, remainGroup: 2, remainAccount: 2 }

  assert.equal(decideWithLedger(snapshot, ledger).allowed, true)
  ledger.sent += 1
  assert.equal(decideWithLedger(snapshot, ledger).remaining, 1, '发过一次后保守剩余应减 1')
  ledger.sent += 1
  const after = decideWithLedger(snapshot, ledger)
  assert.equal(after.allowed, false, '额度 2 已用 2 ⇒ 必须拒绝，即使接口仍返回 2')
  assert.match(after.reason, /本进程内已成功发送/)
})
