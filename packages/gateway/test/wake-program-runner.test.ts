/**
 * 监视程序运行层的守卫测试。
 *
 * ## 最值得守的两条
 *
 * 1. **脚本变更 ⇒ 停用并要求重新登记**（PLAN 明确要求）——
 *    登记时认可的是**那一版**；改过之后行为可能完全不同。
 * 2. **被超时杀掉的程序不算正常退出** —— 否则 probe 契约的超时会走
 *    "正常结束 ⇒ 停"那条路，于是**卡死的程序被当成跑完了**，永远不会被重启。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { createProgramRunner, type SpawnResult } from '../src/wake-program-runner.ts'
import { DEFAULT_LIMITS, type ProgramLimits } from '../src/wake-supervisor.ts'

const SCRIPT = 'console.log("hi")\n'

/** 造工作区 + db + 一条程序记录。 */
function setup(options: { spawn?: SpawnResult | (() => SpawnResult); limits?: ProgramLimits; script?: string } = {}): {
  root: string
  db: ReturnType<typeof openDatabase>['db']
  id: string
  run: ReturnType<typeof createProgramRunner>
  writes: string[]
  close: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'forlife-prog-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const script = options.script ?? SCRIPT
  writeFileSync(join(root, 'watch.mjs'), script, 'utf8')
  const sha = createHash('sha256').update(script).digest('hex')

  const opened = openDatabase({ file: ':memory:' })
  const id = 'wp_1'
  opened.db
    .prepare(
      `INSERT INTO wake_programs (id, name, contract, path, sha256, enabled, status, restart_count, created_at, updated_at)
       VALUES (?, 'w1', 'watcher', 'watch.mjs', ?, 1, 'stopped', 0, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`,
    )
    .run(id, sha)

  const writes: string[] = []
  const run = createProgramRunner({
    db: opened.db,
    workspaceRoot: root,
    limits: options.limits ?? DEFAULT_LIMITS,
    log: () => {},
    spawn: async () => {
      const r = typeof options.spawn === 'function' ? options.spawn() : (options.spawn ?? { exitCode: 0, durationMs: 10, outputBytes: 10, tail: 'ok' })
      writes.push(`exit=${String(r.exitCode)}`)
      return r
    },
  })

  return {
    root,
    db: opened.db,
    id,
    run,
    writes,
    close: () => {
      opened.db.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

/** 读程序状态。 */
const statusOf = (db: ReturnType<typeof openDatabase>['db'], id: string): { status: string; restart_count: number; last_error: string | null } =>
  db.prepare('SELECT status, restart_count, last_error FROM wake_programs WHERE id = ?').get(id) as never

test('★ 脚本变更 ⇒ **停用并要求重新登记**（PLAN 明确要求）', async () => {
  const s = setup()
  try {
    // 改脚本（不重新登记）
    writeFileSync(join(s.root, 'watch.mjs'), 'console.log("改过了")\n', 'utf8')

    const outcome = await s.run.runOnce(s.id)
    assert.equal(outcome.action, 'disable')
    assert.match(outcome.reason, /需重新登记/)
    assert.equal(s.writes.length, 0, '**不该跑**一个没人审过的新版本')

    const st = statusOf(s.db, s.id)
    assert.equal(st.status, 'disabled')
    assert.match(st.last_error ?? '', /已变更/)
  } finally {
    s.close()
  }
})

test('脚本没变 ⇒ 正常跑', async () => {
  const s = setup()
  try {
    const outcome = await s.run.runOnce(s.id)
    assert.equal(outcome.action, 'restart', 'watcher 正常退出也算异常 ⇒ 重启')
    assert.equal(s.writes.length, 1)
    assert.equal(statusOf(s.db, s.id).status, 'failed')
  } finally {
    s.close()
  }
})

test('★ probe 正常退出 ⇒ 停（不重启）', async () => {
  const s = setup({ spawn: { exitCode: 0, durationMs: 5, outputBytes: 5, tail: '' } })
  try {
    s.db.prepare("UPDATE wake_programs SET contract = 'probe' WHERE id = ?").run(s.id)
    const outcome = await s.run.runOnce(s.id)
    assert.equal(outcome.action, 'stop')
    assert.match(outcome.reason, /跑一次就退/)
    assert.equal(statusOf(s.db, s.id).status, 'stopped')
  } finally {
    s.close()
  }
})

test('★ 被超时杀掉**不算正常退出**（否则卡死的 probe 会被当成跑完了）', async () => {
  // **刻意不触发限额**（durationMs 很小）—— 否则限额检查会先接住，
  // timedOut 这个标志就没被单独验证（我第一次就写错了，回退验证没变红才发现）
  const s = setup({ spawn: { exitCode: 0, durationMs: 5, outputBytes: 5, tail: '', timedOut: true } })
  try {
    s.db.prepare("UPDATE wake_programs SET contract = 'probe' WHERE id = ?").run(s.id)
    const outcome = await s.run.runOnce(s.id)
    // exitCode 是 0，但 timedOut ⇒ 不该走"正常结束 ⇒ 停"那条路
    assert.equal(outcome.action, 'restart', '超时必须走重启')
    assert.doesNotMatch(outcome.reason, /跑一次就退/)
  } finally {
    s.close()
  }
})

test('★ 超过重启上限 ⇒ 自动停用（验收②明确要求）', async () => {
  const s = setup({ spawn: { exitCode: 1, durationMs: 5, outputBytes: 5, tail: 'boom' }, limits: { ...DEFAULT_LIMITS, maxRestarts: 2 } })
  try {
    const a = await s.run.runOnce(s.id)
    assert.equal(a.action, 'restart')
    const b = await s.run.runOnce(s.id)
    assert.equal(b.action, 'restart')
    const c = await s.run.runOnce(s.id)
    assert.equal(c.action, 'disable', '第 3 次必须停用')
    assert.match(c.reason, /超过上限 2/)

    const st = statusOf(s.db, s.id)
    assert.equal(st.status, 'disabled')
    assert.equal(st.restart_count, 2, '停用时不再累加')
  } finally {
    s.close()
  }
})

test('★ kill 开关 ⇒ 停（不重启），且优先级最高', async () => {
  const s = setup({ spawn: { exitCode: 1, durationMs: 5, outputBytes: 5, tail: '' } })
  try {
    const outcome = await s.run.runOnce(s.id, { killed: true })
    assert.equal(outcome.action, 'stop')
    assert.match(outcome.reason, /kill/)
  } finally {
    s.close()
  }
})

test('★ 路径越出工作区 ⇒ 停用（能跑的文件必须限制在工作区内）', async () => {
  const s = setup()
  try {
    s.db.prepare("UPDATE wake_programs SET path = '../../evil.mjs' WHERE id = ?").run(s.id)
    const outcome = await s.run.runOnce(s.id)
    assert.equal(outcome.action, 'disable')
    assert.match(outcome.reason, /路径不合法/)
    assert.equal(s.writes.length, 0, '**不该跑**工作区外的脚本')
  } finally {
    s.close()
  }
})

test('脚本读不到（文件被删）⇒ 记 failed 且不跑', async () => {
  const s = setup()
  try {
    rmSync(join(s.root, 'watch.mjs'))
    const outcome = await s.run.runOnce(s.id)
    assert.equal(outcome.action, 'stop')
    assert.match(outcome.reason, /读不到脚本/)
    assert.equal(s.writes.length, 0)
    assert.equal(statusOf(s.db, s.id).status, 'failed')
  } finally {
    s.close()
  }
})

test('spawn 抛异常 ⇒ 当成失败处理（不往外抛）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'forlife-prog2-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'w.mjs'), SCRIPT, 'utf8')
  const sha = createHash('sha256').update(SCRIPT).digest('hex')
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db
      .prepare(
        `INSERT INTO wake_programs (id, name, contract, path, sha256, enabled, status, restart_count, created_at, updated_at)
         VALUES ('wp_1', 'w', 'service', 'w.mjs', ?, 1, 'stopped', 0, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`,
      )
      .run(sha)
    const run = createProgramRunner({
      db: opened.db,
      workspaceRoot: root,
      spawn: async () => {
        throw new Error('spawn 炸了')
      },
    })
    const outcome = await run.runOnce('wp_1')
    assert.equal(outcome.action, 'restart', '异常按失败处理 ⇒ 重启')
  } finally {
    opened.db.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('tick：一个程序出问题不拖垮整轮', async () => {
  const s = setup()
  try {
    // 再插一条路径非法的
    s.db
      .prepare(
        `INSERT INTO wake_programs (id, name, contract, path, sha256, enabled, status, restart_count, created_at, updated_at)
         VALUES ('wp_2', 'w2', 'service', '../bad', 'x', 1, 'stopped', 0, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`,
      )
      .run()
    const results = await s.run.tick()
    assert.equal(results.length, 2, '两条都要处理')
  } finally {
    s.close()
  }
})

test('停用的程序不参与 tick', async () => {
  const s = setup()
  try {
    s.db.prepare('UPDATE wake_programs SET enabled = 0 WHERE id = ?').run(s.id)
    assert.equal((await s.run.tick()).length, 0)
  } finally {
    s.close()
  }
})
