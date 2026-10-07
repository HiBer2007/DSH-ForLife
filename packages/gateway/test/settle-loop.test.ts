/**
 * 沉降循环的守卫测试。
 *
 * ## 最值得守的四条
 *
 * 1. **没配根路径 ⇒ 不启动**（而不是跑一个什么都不做的循环）——
 *    与 `wake-system-monitor` 的"没配挂载点就不起循环"一致。
 * 2. **异常不杀死循环** —— 定时器里抛异常会**静默杀死整个循环**，
 *    沉降从此失效而没人知道。
 * 3. **一轮跑完再排下一轮**（不是固定间隔硬塞）——
 *    否则轮次会堆积，与唤醒引擎那个"每秒重放"是同一类 bug。
 * 4. **汇报结果** —— 否则"沉降没生效"和"没有东西可沉"看起来一模一样。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { settleLoopConfigFromEnv, startSettleLoop } from '../src/settle-loop.ts'

const ENV = {
  FORLIFE_ROOT_HOT: 'D:\\hot',
  FORLIFE_ROOT_WARM: 'D:\\warm',
  FORLIFE_ROOT_COLD: 'D:\\cold',
  // **把阈值放宽**：测试只造 1 条碎片，而默认最小条数是 100（**防小库抖动**）——
  // 不放宽的话维护会被正确地跳过，而测试想验的是"维护跑起来之后的行为"。
  FORLIFE_FRAGMENT_MIN_COUNT: '1',
}

/** 造一个 db + 一条该沉降的 blob。 */
function setup(): ReturnType<typeof openDatabase> {
  const opened = openDatabase({ file: ':memory:' })
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString()
  opened.db
    .prepare(
      `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
       VALUES ('m1', ?, 'image', 'image/png', 20000, 'D:\\hot\\m1.png', 'hot', ?)`,
    )
    .run('a'.repeat(64), old)
  return opened
}

test('★ 没配 FORLIFE_ROOT_HOT ⇒ 不启动，且说清原因', () => {
  const cfg = settleLoopConfigFromEnv({})
  assert.equal(cfg.enabled, false)
  assert.match(String(cfg.disabledReason), /FORLIFE_ROOT_HOT/)
})

test('配了 ⇒ 启用，默认 30 分钟一轮（低频运维动作，跑太勤只白扫表）', () => {
  const cfg = settleLoopConfigFromEnv(ENV)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.intervalMs, 30 * 60_000)
  assert.equal(cfg.limit, 50)
})

test('★ 间隔太短（< 10 秒）会被忽略，回落到默认 —— 防手滑写个 1ms', () => {
  assert.equal(settleLoopConfigFromEnv({ ...ENV, FORLIFE_SETTLE_INTERVAL_MS: '5' }).intervalMs, 30 * 60_000)
  assert.equal(settleLoopConfigFromEnv({ ...ENV, FORLIFE_SETTLE_INTERVAL_MS: '60000' }).intervalMs, 60_000)
})

test('★ 没配时不启动定时器（不能悄悄跑一个空循环）', () => {
  let scheduled = 0
  const loop = startSettleLoop({
    db: openDatabase({ file: ':memory:' }).db,
    env: {},
    moveFile: async () => ({ ok: true, reason: 'ok' }),
    log: () => {},
    setIntervalImpl: () => {
      scheduled += 1
      return { unref: () => {} }
    },
    setTimeoutImpl: () => {
      scheduled += 1
      return { unref: () => {} }
    },
  })
  assert.equal(scheduled, 0, '没配根路径时不该排任何定时器')
  assert.equal(loop.config.enabled, false)
  loop.stop()
})

test('★ tick 会真的沉降一条，并汇报条数', async () => {
  const opened = setup()
  try {
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      log: () => {},
      setTimeoutImpl: () => ({ unref: () => {} }),
    })
    const r = await loop.tick()
    assert.equal(r.moved, 1)
    assert.equal(r.failed, 0)
    const row = opened.db.prepare("SELECT storage_tier FROM media_assets WHERE id = 'm1'").get()
    assert.notEqual(row?.storage_tier, 'hot', '应当被搬离 hot')
    loop.stop()
  } finally {
    opened.db.close()
  }
})

test('★ 失败时汇报原因（否则"沉降没生效"和"没有东西可沉"看起来一样）', async () => {
  const opened = setup()
  try {
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: false, reason: '磁盘满了' }),
      log: () => {},
      setTimeoutImpl: () => ({ unref: () => {} }),
    })
    const r = await loop.tick()
    assert.equal(r.failed, 1)
    assert.equal(r.failures.length, 1)
    assert.match(r.failures[0] ?? '', /磁盘满了/)
    loop.stop()
  } finally {
    opened.db.close()
  }
})

test('★ 一轮抛异常不杀死循环（定时器里抛异常会静默杀死它）', async () => {
  const opened = setup()
  try {
    let ticks = 0
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => {
        ticks += 1
        throw new Error('磁盘炸了')
      },
      log: () => {},
      setTimeoutImpl: () => ({ unref: () => {} }),
    })
    // 第一次：moveFile 抛 ⇒ settleBlobs 接住 ⇒ 记成 failed（不冒泡）
    const r1 = await loop.tick()
    assert.equal(r1.failed, 1, '抛异常应当被记成 failed，而不是冒出去')
    // 再跑一次：循环还活着
    const r2 = await loop.tick()
    assert.equal(r2.failed, 1, '第二轮仍能跑 —— 异常没杀死它')
    assert.equal(ticks, 2)
    loop.stop()
  } finally {
    opened.db.close()
  }
})

test('stop 之后不再排下一轮', async () => {
  const opened = setup()
  try {
    let scheduled = 0
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      log: () => {},
      setTimeoutImpl: () => {
        scheduled += 1
        return { unref: () => {} }
      },
    })
    assert.equal(scheduled, 1, '启动时排一轮')
    loop.stop()
    await loop.tick()
    assert.equal(scheduled, 1, 'stop 之后不该再排')
  } finally {
    opened.db.close()
  }
})

test('★ 用 setTimeout 而不是 setInterval（一轮跑完再排下一轮，防堆积）', () => {
  const opened = setup()
  try {
    let intervalCalls = 0
    let timeoutCalls = 0
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      log: () => {},
      setIntervalImpl: () => {
        intervalCalls += 1
        return { unref: () => {} }
      },
      setTimeoutImpl: () => {
        timeoutCalls += 1
        return { unref: () => {} }
      },
    })
    assert.equal(intervalCalls, 0, '**不该用 setInterval** —— 沉降可能跑很久，固定间隔会让轮次堆积')
    assert.equal(timeoutCalls, 1)
    loop.stop()
  } finally {
    opened.db.close()
  }
})

test('★ 循环也做碎片维护（交付物 4 的"定时"那一半）', async () => {
  const opened = setup()
  try {
    // 造一条**归宿已丢**的碎片 —— 它必须被"拒删"，而不是被删掉
    opened.db
      .prepare(
        `INSERT INTO mid_memory_entries
           (id, entry_type, summary, entities, token_count, window_offset, status, fragmented_into, compaction_epoch, source_short_ids, created_at, storage_tier, revision)
         VALUES ('frag1', 'semantic', '碎片', '[]', 100, 0, 'fragmented', 'L-gone', 1, '[]', ?, 'hot', 1)`,
      )
      .run(new Date(Date.now() - 999 * 86_400_000).toISOString())

    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      log: () => {},
      setTimeoutImpl: () => ({ unref: () => {} }),
    })
    const r = await loop.tick()
    assert.ok(r.fragments !== undefined, 'tick 结果里要有碎片那一项')
    assert.equal(r.fragments?.orphans, 1, '归宿已丢的要被报出来')
    assert.equal(r.fragments?.evicted, 0, '**归宿已丢的绝不能被删**')
    // 那条还在
    const still = opened.db.prepare("SELECT COUNT(*) AS n FROM mid_memory_entries WHERE id = 'frag1'").get()
    assert.equal(still?.n, 1, '它是唯一副本，必须留着')
    loop.stop()
  } finally {
    opened.db.close()
  }
})

test('★ 碎片维护失败**不影响沉降**（两件事互相独立）', async () => {
  const opened = setup()
  try {
    // 把 FTS 表删掉 ⇒ mergeFragmentIndex 会失败
    opened.db.exec('DROP TABLE mid_memory_fts')
    const loop = startSettleLoop({
      db: opened.db,
      env: ENV,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      log: () => {},
      setTimeoutImpl: () => ({ unref: () => {} }),
    })
    const r = await loop.tick()
    assert.equal(r.moved, 1, '**沉降必须照常完成** —— 碎片维护坏了不该带走它')
    // mergeFragmentIndex **自己接住异常**（返回 ok:false）⇒ 碎片那项仍然有值。
    // 那比"整项消失"更好：能看到"合并失败了"，而不是什么都没有。
    assert.equal(r.fragments?.merged, false, '合并失败要如实报 false')
    assert.ok(r.fragments !== undefined, '碎片那项不该消失 —— 消失就看不出"合并失败了"')
    loop.stop()
  } finally {
    opened.db.close()
  }
})
