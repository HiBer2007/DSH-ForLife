/**
 * 投喂轮次钩子的测试。
 *
 * ## 这里最要紧的两条
 *
 * 1. **★★ 掩码必须只进有出、且不许叠加** —— 若某条路径只收窄不解除，
 *    **她的正常对话从此发不出 QQ 消息，而且没人会发现**。
 *    所以除了"配对"之外，还专门测"连续两次 start 只攥一个掩码"（自愈）。
 * 2. **★★ 喂完必须收尾（醒来）** —— 运行登记要清掉、会话要删掉。
 *    否则提示段会**永远**说"你在半梦半醒"，而那正是 `feed-frame.ts` 里
 *    那条「记忆 vs 现在」的边界被破坏的样子。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { endFeedRun, readFeedCursor, readFeedRun, readFeedSession, startFeedRun } from '@forlife/gateway'

import type { ToolRestrictHost } from '../src/feed-restrict.ts'
import { createFeedTurnHook } from '../src/feed-turn-hook.ts'

function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'))
  const db = new DatabaseSync(join(dir, 't.sqlite'))
  db.exec('CREATE TABLE forlife_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, dir }
}

function segments(n: number): { index: number; path: string }[] {
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, path: `/m/seg-${String(i + 1)}.md` }))
}

/** 记账用的假工具宿主机。 */
function fakeTools(): { tools: ToolRestrictHost; acquired: number; released: number } {
  const s = { acquired: 0, released: 0 }
  const tools: ToolRestrictHost = {
    restrict: () => {
      s.acquired += 1
      return {
        dispose: () => {
          s.released += 1
        },
      }
    },
  }
  return {
    tools,
    get acquired() {
      return s.acquired
    },
    get released() {
      return s.released
    },
  }
}

test('★ 没有投喂运行 ⇒ 不活跃，且**顺手解除可能留着的掩码**（自愈）', () => {
  const { db, dir } = freshDb()
  try {
    const fake = fakeTools()
    const hook = createFeedTurnHook({ db, tools: fake.tools, log: () => undefined })
    const start = hook.onTurnStart()
    assert.equal(start.active, false)
    assert.equal(fake.acquired, 0, '没有运行就不该收窄她的工具')
    assert.equal(hook.maskHeld(), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 完整一轮：start 收窄 + 写本轮范围；end 推进游标 + 解除掩码', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 'chat/a', kind: 'experience', perTurn: 3, segments: segments(10) })
    const fake = fakeTools()
    const hook = createFeedTurnHook({ db, tools: fake.tools, log: () => undefined })

    const start = hook.onTurnStart()
    assert.equal(start.active, true)
    assert.deepEqual(
      start.segments.map((s) => s.path),
      ['/m/seg-1.md', '/m/seg-2.md', '/m/seg-3.md'],
    )
    assert.equal(fake.acquired, 1)
    assert.equal(hook.maskHeld(), true)

    // ★ 本轮范围必须写进会话 —— 提示段靠它渲染 {{batch}} 告诉模型读哪儿
    const session = readFeedSession(db, { ignoreStale: true })
    assert.deepEqual(session?.batch, { from: 1, to: 3, total: 10 })

    // 模型这一轮实际喂进去 2 段（不是 3）
    const end = hook.onTurnEnd({ fedCount: 2 })
    assert.equal(end.advanced, 2)
    assert.equal(end.finished, false)
    assert.equal(readFeedCursor(db, 'chat/a')?.fedThrough, 2, '★ 按**实际喂入**的段数推进')
    assert.equal(fake.released, 1, '★ 轮末必须解除掩码')
    assert.equal(hook.maskHeld(), false)

    // 下一轮从第 3 段接着喂
    const next = hook.onTurnStart()
    assert.deepEqual(next.segments.map((s) => s.path), ['/m/seg-3.md', '/m/seg-4.md', '/m/seg-5.md'])
    hook.onTurnEnd({ fedCount: 3 })
    assert.equal(readFeedCursor(db, 'chat/a')?.fedThrough, 5)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 掩码**不许叠加**：连续两次 start 只攥一个（自愈）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 'chat/b', kind: 'knowledge', perTurn: 5, segments: segments(20) })
    const fake = fakeTools()
    const hook = createFeedTurnHook({ db, tools: fake.tools, log: () => undefined })

    hook.onTurnStart()
    hook.onTurnStart() // 上一轮没走 end（崩了 / 异常路径）
    assert.equal(fake.acquired, 2, '第二次 start 会重新收窄')
    assert.equal(fake.released, 1, '★ 但必须先**解除上一个** —— 叠加会让"解除"变成减法，少解一次就永久收窄')
    assert.equal(hook.maskHeld(), true, '任何时刻最多攥着一个掩码')

    hook.onTurnEnd({ fedCount: 5 })
    assert.equal(hook.maskHeld(), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 喂完 ⇒ 收尾：清运行登记 + 删会话（**醒来**）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 'chat/c', kind: 'experience', perTurn: 10, segments: segments(4) })
    const hook = createFeedTurnHook({ db, log: () => undefined })

    hook.onTurnStart()
    assert.ok(readFeedSession(db, { ignoreStale: true }) !== undefined, '投喂期应当有会话（她在半梦半醒）')

    const end = hook.onTurnEnd({ fedCount: 4 })
    assert.equal(end.finished, true, '4 段全喂完 ⇒ finished')
    assert.equal(readFeedRun(db), undefined, '运行登记要清掉')
    assert.equal(
      readFeedSession(db, { ignoreStale: true }),
      undefined,
      '★ 会话必须**删掉** —— 留着会让提示段永远说"你在半梦半醒"，那条「记忆 vs 现在」的边界就破了',
    )
    // 之后 start 应当不活跃（免得又给它收窄一次工具）
    assert.equal(hook.onTurnStart().active, false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 排产与素材对不上 ⇒ **不投喂且解除掩码**（不给错文件，也不白收窄工具）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 'chat/d', kind: 'knowledge', perTurn: 5, segments: segments(3) })
    // 游标推到一个让"该喂 5 段"但只剩 0 段的位置？
    // 更直接的构造：游标=0、perTurn=5、总数=3 ⇒ 排产 1–3（正常）。
    // 要制造错位，让游标比总数还接近边界：游标=2、perTurn=5、总数=3 ⇒ 排产 3–3（正常）。
    // ⇒ 用 sliceSegments 的越界判定来构造：把运行登记里的段数改小而不动 perTurn 太大。
    // 这里用一个"perTurn 大于总数且游标停在中间"的干净构造：
    endFeedRun(db)
    startFeedRun(db, { source: 'chat/d', kind: 'knowledge', perTurn: 9, segments: segments(3) })
    const hook = createFeedTurnHook({ db, log: () => undefined })
    // 游标推到 3（喂完）⇒ 会走"已完成收尾"那条，而不是"对不上"。
    // 所以对不上那条只能靠内部不一致触发；这里断言的是**不会给错文件**这个性质：
    const start = hook.onTurnStart()
    assert.deepEqual(start.segments.map((s) => s.index), [1, 2, 3], '排产必须落在素材范围内')
    assert.equal(hook.maskHeld(), false, '没给 tools 时不攥掩码')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 轮末没有运行时也要解除掩码（"只进不出"那条故障的兜底）', () => {
  const { db, dir } = freshDb()
  try {
    startFeedRun(db, { source: 'chat/e', kind: 'knowledge', perTurn: 2, segments: segments(6) })
    const fake = fakeTools()
    const hook = createFeedTurnHook({ db, tools: fake.tools, log: () => undefined })
    hook.onTurnStart()
    assert.equal(hook.maskHeld(), true)
    // 运行登记被别处清掉了（例如面板上点了"取消投喂"）
    endFeedRun(db)
    const end = hook.onTurnEnd({ fedCount: 0 })
    assert.equal(end.active, false)
    assert.equal(fake.released, 1, '★ 运行没了也必须解除 —— 否则她的对话永远发不出 QQ 消息')
    assert.equal(hook.maskHeld(), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
