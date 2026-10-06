/**
 * TCP 数据层的守卫测试。
 *
 * 守两条**判错了就会出事**的：
 *  1. **白名单要判 `listen_port`**（对外端口），不是 `target_port` ——
 *     判错的话 `publishPort({targetPort: 8080, listenPort: 22})` 会通过
 *     （因为 8080 在白名单里），而实际**把 22 端口暴露了出去**；
 *  2. **`listen_port` 唯一** —— 两个发布用同一个对外端口时，后一个会
 *     **静默顶掉**前一个的 Caddy server，而前一个的使用者只觉得"服务挂了"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { publishPort } from '../src/ports.ts'

const WL = [{ from: 18000, to: 18099 }]

test('★ 白名单判的是**对外端口**：目标端口合法但对外端口非法 ⇒ 拒绝', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    // 目标端口 18001 在白名单里，但对外端口 22 不在（而且是特权端口）
    const result = publishPort(opened.db, {
      name: 'ssh',
      targetPort: 18001,
      listenPort: 22,
      protocol: 'tcp',
      approvedBy: 'a',
      whitelist: WL,
    })
    assert.equal(result.ok, false, '必须拒绝 —— 否则等于把 22 端口暴露出去')
    assert.match(result.reason, /对外端口不合法/)
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 0)
  } finally {
    opened.db.close()
  }
})

test('TCP 发布：两个端口都在白名单内 ⇒ 成功，且 listen_port 被记下来', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const result = publishPort(opened.db, {
      name: 'db',
      targetPort: 18001,
      listenPort: 18050,
      protocol: 'tcp',
      approvedBy: 'a',
      whitelist: WL,
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.row?.listen_port, 18050)
    assert.equal(result.row?.protocol, 'tcp')
  } finally {
    opened.db.close()
  }
})

test('★ TCP 必须给 listenPort（不给就拒，不猜）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const result = publishPort(opened.db, { name: 'db', targetPort: 18001, protocol: 'tcp', approvedBy: 'a', whitelist: WL })
    assert.equal(result.ok, false)
    assert.match(result.reason, /必须给 listenPort/)
  } finally {
    opened.db.close()
  }
})

test('★ 对外端口不能重复（否则会静默顶掉前一个）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const first = publishPort(opened.db, {
      name: 'db1', targetPort: 18001, listenPort: 18050, protocol: 'tcp', approvedBy: 'a', whitelist: WL,
    })
    assert.equal(first.ok, true)

    const second = publishPort(opened.db, {
      name: 'db2', targetPort: 18002, listenPort: 18050, protocol: 'tcp', approvedBy: 'a', whitelist: WL,
    })
    assert.equal(second.ok, false, '同一个对外端口必须被拒')
    assert.match(second.reason, /已被「db1」占用/)
    // 错误信息要解释**为什么**不能共用 —— 否则用户会以为这是个可以放宽的限制
    assert.match(second.reason, /没有路径分流/)
  } finally {
    opened.db.close()
  }
})

test('★ 数据库层的唯一索引是真正的保证（应用层检查有竞态）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db
      .prepare(
        `INSERT INTO published_ports (id, name, target_port, listen_port, protocol, ttl_seconds, expires_at, approved_by, note, created_at)
         VALUES ('pp_1', 'a', 18001, 18050, 'tcp', NULL, NULL, 'x', NULL, '2026-10-06T00:00:00.000Z')`,
      )
      .run()

    // 绕过应用层检查直接插 —— 唯一索引必须挡住
    assert.throws(
      () =>
        opened.db
          .prepare(
            `INSERT INTO published_ports (id, name, target_port, listen_port, protocol, ttl_seconds, expires_at, approved_by, note, created_at)
             VALUES ('pp_2', 'b', 18002, 18050, 'tcp', NULL, NULL, 'x', NULL, '2026-10-06T00:00:00.000Z')`,
          )
          .run(),
      /UNIQUE|constraint/i,
      '唯一索引必须挡住重复的对外端口',
    )
  } finally {
    opened.db.close()
  }
})

test('HTTP 发布：listen_port 为 NULL，多条可以并存（共用对外端口）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    for (const name of ['web1', 'web2', 'web3']) {
      const r = publishPort(opened.db, { name, targetPort: 18001, approvedBy: 'a', whitelist: WL })
      assert.equal(r.ok, true, r.reason)
      assert.equal(r.row?.listen_port, null, 'HTTP 发布不该有对外端口')
    }
    // 部分唯一索引只对有值的行生效 ⇒ 三条 NULL 并存
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS v FROM published_ports').get() as { v: number }).v, 3)
  } finally {
    opened.db.close()
  }
})

test('★ HTTP 发布不接受 listenPort（对外端口由 Caddy 的监听决定）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const result = publishPort(opened.db, { name: 'web', targetPort: 18001, listenPort: 18050, approvedBy: 'a', whitelist: WL })
    assert.equal(result.ok, false)
    // 允许传的话，会让人以为"我能选 HTTP 用哪个端口"，而实际不能
    assert.match(result.reason, /不接受 listenPort/)
  } finally {
    opened.db.close()
  }
})
