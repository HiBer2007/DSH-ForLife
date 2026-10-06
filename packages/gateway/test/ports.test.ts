/**
 * 端口出口的守卫测试 —— 对着 PLAN 阶段 7 的验收写：
 * 「**非白名单端口被拒绝并留下审计记录**」与「**TTL 到期自动回收**」。
 *
 * 最值得守的两条：
 *  1. 白名单必须**只在唯一入口**判定（散在各处的话，漏一处就是一个能把任意端口
 *     暴露到公网的洞，而且它不报错）；
 *  2. 过期判定**不能只靠定时任务**（漏跑一次 = 一条永不过期的公开路由，
 *     而这恰恰是最危险的状态：没人记得它还在）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { checkPortAllowed, checkRouteName, listActivePorts, listExpiredPorts, publishPort, removePort, setCaddyRouteId } from '../src/ports.ts'

test('★ 白名单：段内通过、段外拒绝、特权端口拒绝', () => {
  assert.equal(checkPortAllowed(8080).ok, true)
  assert.equal(checkPortAllowed(8000).ok, true, '边界含端点')
  assert.equal(checkPortAllowed(8099).ok, true)

  const outside = checkPortAllowed(9000)
  assert.equal(outside.ok, false)
  // 拒绝理由要**具体**：说清允许哪些段，否则调用方只能猜
  assert.match(outside.reason, /8000–8099/)
  assert.match(outside.reason, /不在白名单/)

  assert.equal(checkPortAllowed(80).ok, false, '特权端口必须拒（即使白名单被配错）')
  assert.match(checkPortAllowed(80).reason, /特权端口/)

  assert.equal(checkPortAllowed(0).ok, false)
  assert.equal(checkPortAllowed(70000).ok, false)
  assert.equal(checkPortAllowed(8080.5).ok, false, '非整数要拒')
})

test('★ 路由名：会被拼进 URL，必须严格', () => {
  assert.equal(checkRouteName('my-app').ok, true)
  assert.equal(checkRouteName('a1').ok, true)

  // 这些如果放行，会拼出奇怪的路径或与面板自己的路径打架
  for (const bad of ['', ' ', 'My-App', '-lead', 'a_b', 'a.b', 'a/b', 'x'.repeat(32)]) {
    assert.equal(checkRouteName(bad).ok, false, `应拒绝：${JSON.stringify(bad)}`)
  }
  for (const reserved of ['admin', 'api', 'svc', 'health']) {
    assert.equal(checkRouteName(reserved).ok, false, `保留名应拒绝：${reserved}`)
  }
})

test('发布：合法输入入库；非白名单端口被拒且**不留下记录**', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const good = publishPort(opened.db, { name: 'web', targetPort: 8080, approvedBy: 'admin:abcd1234' })
    assert.equal(good.ok, true)
    assert.equal(good.row?.protocol, 'http', '默认协议是 http')
    assert.equal(good.row?.approved_by, 'admin:abcd1234', '审批人必须记下来')

    const bad = publishPort(opened.db, { name: 'evil', targetPort: 9000, approvedBy: 'admin:abcd1234' })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /不在白名单/)

    // **关键**：被拒的不能留下记录 —— 否则界面上会出现一条"看起来发布了"但实际不通的条目
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 1)
  } finally {
    opened.db.close()
  }
})

test('发布：重名被拒（换一个，或先取消原来那条）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    publishPort(opened.db, { name: 'web', targetPort: 8080, approvedBy: 'a' })
    const dup = publishPort(opened.db, { name: 'web', targetPort: 8081, approvedBy: 'a' })
    assert.equal(dup.ok, false)
    assert.match(dup.reason, /已被占用/)
  } finally {
    opened.db.close()
  }
})

test('TTL：给出过期时间；非法 TTL 被拒', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const at = new Date('2026-10-06T00:00:00.000Z')
    const withTtl = publishPort(opened.db, { name: 'tmp', targetPort: 8080, ttlSeconds: 600, approvedBy: 'a', now: at })
    assert.equal(withTtl.ok, true)
    assert.equal(withTtl.row?.expires_at, '2026-10-06T00:10:00.000Z', '过期时间要算对')

    const noTtl = publishPort(opened.db, { name: 'perm', targetPort: 8081, approvedBy: 'a', now: at })
    assert.equal(noTtl.row?.expires_at, null, '不给 TTL 表示不过期')

    assert.equal(publishPort(opened.db, { name: 'bad', targetPort: 8082, ttlSeconds: 0, approvedBy: 'a' }).ok, false)
    assert.equal(publishPort(opened.db, { name: 'bad', targetPort: 8082, ttlSeconds: -1, approvedBy: 'a' }).ok, false)
  } finally {
    opened.db.close()
  }
})

test('★ 过期判定不依赖定时任务：读取时就算一遍', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const at = new Date('2026-10-06T00:00:00.000Z')
    publishPort(opened.db, { name: 'short', targetPort: 8080, ttlSeconds: 60, approvedBy: 'a', now: at })
    publishPort(opened.db, { name: 'long', targetPort: 8081, ttlSeconds: 3600, approvedBy: 'a', now: at })

    // 过期前：两条都有效
    const before = listActivePorts(opened.db, new Date('2026-10-06T00:00:30.000Z'))
    assert.equal(before.length, 2)

    // 过期后：只剩长的那条 —— **即使回收任务一次都没跑过**
    const after = listActivePorts(opened.db, new Date('2026-10-06T00:02:00.000Z'))
    assert.deepEqual(after.map((r) => r.name), ['long'], '过期的必须从"有效"里消失，不能等定时任务')

    // 回收任务该捡到哪条
    const expired = listExpiredPorts(opened.db, new Date('2026-10-06T00:02:00.000Z'))
    assert.deepEqual(expired.map((r) => r.name), ['short'])
  } finally {
    opened.db.close()
  }
})

test('删除：返回被删的那条（调用方要拿 caddy_route_id 去删路由）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const created = publishPort(opened.db, { name: 'web', targetPort: 8080, approvedBy: 'a' })
    assert.ok(created.row !== undefined)
    setCaddyRouteId(opened.db, created.row.id, 'forlife-svc-web')

    const removed = removePort(opened.db, created.row.id)
    assert.equal(removed?.name, 'web')
    // **必须带回路由 id** —— 否则删了记录却留下一条公开路由（最糟的状态：没人知道它还在）
    assert.equal(removed?.caddy_route_id, 'forlife-svc-web')

    assert.equal(removePort(opened.db, created.row.id), undefined, '再删返回 undefined')
  } finally {
    opened.db.close()
  }
})
