/**
 * 外部触发源的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **每触发器一个令牌** —— 全局令牌意味着任何一个外部系统拿到它就能触发**所有**外部触发器，
 *    而外部触发器的用途恰恰是"让第三方系统叫我"（CI、监控、传感器），
 *    它们是**不同信任级别**的来源。
 * 2. **常量时间比较** —— `===` 会在第一个不同的字符处提前返回，比较耗时**泄露前缀信息**。
 * 3. **令牌存哈希不存明文** —— 与密码同理。
 * 4. **坏规格与错令牌要分开报** —— 否则用户会去换令牌，而真正的问题是那条记录坏了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, openDatabase } from '@forlife/store'

import {
  createExternalWakeSource,
  hashToken,
  newExternalToken,
  parseExternalSpec,
  tokenMatches,
} from '../src/wake-external-source.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 建一条 external 触发器，返回 id 与明文令牌。 */
function mkExternal(
  db: ReturnType<typeof openDatabase>['db'],
  over: { scope?: string; enabled?: boolean; title?: string; label?: string } = {},
): { id: string; token: string } {
  const { token, spec } = newExternalToken(over.label ?? 'CI 系统')
  const r = createWakeTrigger(db, {
    kind: 'external',
    scope: over.scope ?? 'onebot11:123',
    title: over.title ?? '外部触发',
    prompt: '看看',
    spec,
    createdBy: 'test',
    now: AT,
  })
  assert.equal(r.ok, true, r.reason)
  if (over.enabled === false) db.prepare('UPDATE wake_triggers SET enabled = 0 WHERE id = ?').run(r.row!.id)
  return { id: r.row!.id, token }
}

function setup(): { db: ReturnType<typeof openDatabase>['db']; source: ReturnType<typeof createExternalWakeSource>; close: () => void } {
  const opened = openDatabase({ file: ':memory:' })
  const source = createExternalWakeSource({ db: opened.db, now: () => AT })
  return { db: opened.db, source, close: () => opened.db.close() }
}

test('★ 令牌存的是**哈希**，不是明文（库被读走时明文就是可直接用的凭证）', () => {
  const { token, spec } = newExternalToken('CI')
  assert.notEqual(spec.tokenHash, token, '规格里不能是明文')
  assert.equal(spec.tokenHash, hashToken(token), '存的应当是该令牌的哈希')
  assert.equal(spec.tokenHash.length, 64)
  // 令牌本身要够长（32 字节随机 ⇒ base64url 43 字符）
  assert.ok(token.length >= 40, `令牌太短：${String(token.length)}`)
})

test('★ 常量时间比较：对与错都能判对', () => {
  const { token } = newExternalToken('x')
  const h = hashToken(token)
  assert.equal(tokenMatches(token, h), true)
  assert.equal(tokenMatches('错的', h), false)
  assert.equal(tokenMatches('', h), false)
  // 长度不同的哈希不该抛（直接 false）
  assert.equal(tokenMatches(token, 'abcd'), false)
})

test('★ 令牌只对**自己那条**有效（不同信任级别要分开）', () => {
  const s = setup()
  try {
    const a = mkExternal(s.db, { title: 'CI' })
    const b = mkExternal(s.db, { title: '传感器' })

    assert.equal(s.source.fire(a.id, a.token).ok, true, 'A 的令牌对 A 有效')
    // **关键**：A 的令牌对 B 无效 —— 全局令牌的话这里会是 true
    const cross = s.source.fire(b.id, a.token)
    assert.equal(cross.ok, false)
    assert.match(cross.reason, /令牌不正确/)

    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    assert.equal(s.source.fire(b.id, b.token).ok, true, 'B 的令牌对 B 有效')
  } finally {
    s.close()
  }
})

test('★ 坏规格与错令牌**分开报**（否则用户会去换令牌，而真问题是记录坏了）', () => {
  const s = setup()
  try {
    const r = createWakeTrigger(s.db, {
      kind: 'external', scope: 'onebot11:1', title: '坏的', prompt: 'p',
      spec: { label: '没有 tokenHash' }, createdBy: 'test', now: AT,
    })
    const out = s.source.fire(r.row!.id, '随便')
    assert.equal(out.ok, false)
    assert.match(out.reason, /规格已损坏/)
    assert.doesNotMatch(out.reason, /令牌不正确/)
  } finally {
    s.close()
  }
})

test('令牌不对 ⇒ 不标记（且不泄露期望值）', () => {
  const s = setup()
  try {
    const a = mkExternal(s.db)
    const out = s.source.fire(a.id, '错的令牌')
    assert.equal(out.ok, false)
    assert.equal(getWakeTrigger(s.db, a.id)?.next_fire_at, null, '令牌不对绝不能标记')
    // 不回显期望值
    assert.doesNotMatch(out.reason, /[A-Za-z0-9_-]{40}/)
  } finally {
    s.close()
  }
})

test('空令牌与错令牌给**同一句**话（不给爆破提供信息）', () => {
  const s = setup()
  try {
    const a = mkExternal(s.db)
    const empty = s.source.fire(a.id, '')
    const wrong = s.source.fire(a.id, 'x')
    assert.notEqual(empty.reason, wrong.reason, '空令牌有单独的原因（那是"没给"，不是"错了"）')
    assert.match(empty.reason, /没有提供令牌/)
    assert.match(wrong.reason, /令牌不正确/)
  } finally {
    s.close()
  }
})

test('★ 非 external 类型的触发器：拒绝（防止拿别的触发器当入口）', () => {
  const s = setup()
  try {
    const r = createWakeTrigger(s.db, {
      kind: 'timer', scope: 'onebot11:1', title: '定时', prompt: 'p',
      spec: { delaySeconds: 60 }, createdBy: 'test', nextFireAt: '2027-01-01T00:00:00.000Z', now: AT,
    })
    const out = s.source.fire(r.row!.id, 'x')
    assert.equal(out.ok, false)
    assert.match(out.reason, /不是 external 类型/)
  } finally {
    s.close()
  }
})

test('停用的 / scope=* 的：拒绝并说清原因', () => {
  const s = setup()
  try {
    const off = mkExternal(s.db, { enabled: false, title: '停了的' })
    const out = s.source.fire(off.id, off.token)
    assert.equal(out.ok, false)
    assert.match(out.reason, /已停用/)

    const star = mkExternal(s.db, { scope: '*', title: '没绑会话' })
    const out2 = s.source.fire(star.id, star.token)
    assert.equal(out2.ok, false)
    assert.match(out2.reason, /没有绑定会话/)
  } finally {
    s.close()
  }
})

test('成功触发 ⇒ 标记为"到点"（与其它三类同一条通道）', () => {
  const s = setup()
  try {
    const a = mkExternal(s.db)
    const out = s.source.fire(a.id, a.token)
    assert.equal(out.ok, true)
    assert.equal(getWakeTrigger(s.db, a.id)?.next_fire_at, AT.toISOString())
    assert.equal(out.triggerId, a.id)
  } finally {
    s.close()
  }
})

test('verify：只判令牌，不改状态（HTTP 层可以提前判断）', () => {
  const s = setup()
  try {
    const a = mkExternal(s.db)
    assert.equal(s.source.verify(a.id, a.token), true)
    assert.equal(s.source.verify(a.id, '错'), false)
    assert.equal(getWakeTrigger(s.db, a.id)?.next_fire_at, null, 'verify 不该改状态')
  } finally {
    s.close()
  }
})

test('parseExternalSpec：坏 JSON / 缺字段 / 哈希长度不对都返回 undefined', () => {
  assert.equal(parseExternalSpec('不是 JSON'), undefined)
  assert.equal(parseExternalSpec('{}'), undefined)
  assert.equal(parseExternalSpec('{"tokenHash":"太短"}'), undefined)
  const good = parseExternalSpec(`{"tokenHash":"${'a'.repeat(64)}","label":"x"}`)
  assert.equal(good?.label, 'x')
  // 缺 label 时给一个占位（而不是 undefined —— 面板要显示"这个令牌给谁用"）
  assert.equal(parseExternalSpec(`{"tokenHash":"${'a'.repeat(64)}"}`)?.label, '(未命名)')
})
