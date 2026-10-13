/**
 * 压缩事务与崩溃一致性测试（EXECUTION_PLAN 阶段 2 交付物 6 与验收③）。
 *
 * 故障注入手法：**真的在压缩中途"断电"** —— 写入运行记录并做了一部分表改动之后，
 * 不调用任何收尾函数，直接丢弃进程内状态（等价于被 kill -9），
 * 然后开新连接走"启动恢复"路径，断言回到上一个完整状态。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import {
  appendMidEntry,
  beginCompactionRun,
  bumpEpoch,
  commitCompactionRun,
  currentEpoch,
  currentRevision,
  fragmentMidEntry,
  getCompactionRun,
  insertLongEntry,
  listRenderableMidEntries,
  openDatabase,
  pendingCompactionRuns,
  recoverPendingCompactions,
} from '../src/index.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-runs-'))

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

test('L3 是跨压缩累积的：推进 epoch 后旧条目仍然渲染（阶段 1 的语义错误回归）', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: '压缩前写入的条目', tokenCount: 10 })
    const before = listRenderableMidEntries(db)
    assert.equal(before.length, 1)

    // 一次压缩：推进 epoch，再追加新条目（PLAN §4.2 Step 4）
    const epoch = bumpEpoch(db)
    assert.equal(epoch, 1)
    appendMidEntry(db, { id: 'M2', summary: '压缩后写入的条目', tokenCount: 10 })

    const after = listRenderableMidEntries(db)
    assert.deepEqual(
      after.map((r) => r.id),
      ['M1', 'M2'],
      'L3 必须累积：旧 epoch 的条目在压缩后仍要渲染（否则第一次压缩就把记忆清空了）',
    )
    assert.equal(getEpochOf(after, 'M1'), 0)
    assert.equal(getEpochOf(after, 'M2'), 1)
    close()
  } finally {
    await cleanup(dir)
  }
})

/** 取某条目的 epoch（测试辅助）。 */
function getEpochOf(rows: readonly { id: string; compaction_epoch: number }[], id: string): number | undefined {
  return rows.find((r) => r.id === id)?.compaction_epoch
}

test('压缩事务：begin → commit 留下完整记录', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    const run = beginCompactionRun(db, {
      id: 'run_1',
      compactionId: 'cmp_abc',
      sessionId: 'sess_1',
      epochFrom: 0,
      plan: { pushedIds: ['mid_a'], fragmentedIds: ['M1'] },
    })
    assert.equal(run.phase, 'started')
    assert.equal(pendingCompactionRuns(db).length, 1)

    commitCompactionRun(db, 'run_1', { epochTo: 1, detail: { pushed: 1 } })
    assert.equal(getCompactionRun(db, 'run_1')?.phase, 'committed')
    assert.equal(pendingCompactionRuns(db).length, 0, '提交后不该再有未完成事务')
    close()
  } finally {
    await cleanup(dir)
  }
})

test('故障注入：压缩中途被杀 ⇒ 重启后回滚到上一个完整状态，无半写条目', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    // ── 第一阶段：正常状态（epoch 0 有一条记忆，另有一条将成为碎片）
    const first = openDatabase({ file })
    appendMidEntry(first.db, { id: 'M1', summary: '要被碎片化的旧条目', tokenCount: 30 })
    appendMidEntry(first.db, { id: 'M2', summary: '会留下来的条目', tokenCount: 20 })
    const epochBefore = currentEpoch(first.db)
    const revisionBefore = currentRevision(first.db)
    first.close()

    // ── 第二阶段：开始压缩，做了一半就被"kill"
    const victim = openDatabase({ file })
    beginCompactionRun(victim.db, {
      id: 'run_crash',
      sessionId: 'sess_1',
      epochFrom: epochBefore,
      plan: { pushedIds: ['mid_new_1', 'mid_new_2'], fragmentedIds: ['M1'], longIds: ['long_1'] },
    })
    // ① 推进 epoch
    bumpEpoch(victim.db)
    // ② 写了一条新条目（第二条还没写）
    appendMidEntry(victim.db, { id: 'mid_new_1', summary: '压缩产出的第一条', tokenCount: 12 })
    // ③ 碎片化做了一半：长期条目写了，中期条目还没改
    insertLongEntry(victim.db, { id: 'long_1', content: '被碎片化的全文', summary: '旧条目摘要', sourceMidIds: ['M1'] })
    // ← 此处"断电"：不 commit、不 close、不做任何收尾
    const afterCrash = listRenderableMidEntries(victim.db)
    assert.equal(afterCrash.length, 3, '崩溃瞬间确实处于半写状态（新条目已进来）')

    // ── 第三阶段：新进程启动 ⇒ 走恢复路径
    const reborn = openDatabase({ file, log: () => {} })
    const results = recoverPendingCompactions(reborn.db)
    assert.equal(results.length, 1, '应发现并回滚 1 个未完成事务')
    assert.equal(results[0]?.deletedMidEntries, 1, '删掉本次新写的 1 条')
    assert.equal(results[0]?.deletedLongEntries, 1, '删掉本次新写的长期条目')
    assert.equal(results[0]?.epochRestoredTo, epochBefore, 'epoch 必须退回')

    assert.equal(currentEpoch(reborn.db), epochBefore, 'epoch 回到上一个完整状态')
    const recovered = listRenderableMidEntries(reborn.db)
    assert.deepEqual(
      recovered.map((r) => r.id),
      ['M1', 'M2'],
      '半写条目必须消失，且原有条目完好',
    )
    assert.equal(recovered.every((r) => r.status === 'active'), true, '碎片化到一半的要恢复成 active')
    assert.equal(getCompactionRun(reborn.db, 'run_crash')?.phase, 'aborted')
    assert.ok(currentRevision(reborn.db) > revisionBefore, '回滚也要推进修订号（窗口内容变了）')
    reborn.close()
  } finally {
    await cleanup(dir)
  }
})

test('故障注入：回滚是幂等的（重复恢复不会二次破坏）', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: '原有条目', tokenCount: 10 })
    beginCompactionRun(db, { id: 'run_x', epochFrom: 0, plan: { pushedIds: ['mid_z'], fragmentedIds: ['M1'] } })
    bumpEpoch(db)
    appendMidEntry(db, { id: 'mid_z', summary: '新条目', tokenCount: 5 })
    fragmentMidEntry(db, 'M1', 'long_z', '提示', 8)

    const first = recoverPendingCompactions(db)
    assert.equal(first.length, 1)
    const snapshot = listRenderableMidEntries(db).map((r) => `${r.id}:${r.status}`)
    assert.deepEqual(snapshot, ['M1:active', 'mid_z:missing'].slice(0, 1), '回滚后只剩原有条目且为 active')

    // 再跑一次：已无 started 事务 ⇒ 不做任何事
    assert.equal(recoverPendingCompactions(db).length, 0)
    assert.deepEqual(
      listRenderableMidEntries(db).map((r) => `${r.id}:${r.status}`),
      snapshot,
    )
    close()
  } finally {
    await cleanup(dir)
  }
})

test('故障注入：崩溃后又"部分回滚"再崩，第二次仍能收敛', async () => {
  const dir = tempDir()
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: '原有', tokenCount: 10 })
    beginCompactionRun(db, { id: 'run_y', epochFrom: 0, plan: { pushedIds: ['mid_q1', 'mid_q2'], fragmentedIds: [] } })
    bumpEpoch(db)
    appendMidEntry(db, { id: 'mid_q1', summary: '新一', tokenCount: 5 })
    appendMidEntry(db, { id: 'mid_q2', summary: '新二', tokenCount: 5 })

    // 手工模拟"回滚到一半又被杀"：只删掉了 q1
    db.prepare('DELETE FROM mid_memory_entries WHERE id = ?').run('mid_q1')
    const second = recoverPendingCompactions(db)
    assert.equal(second.length, 1, '残留的 started 事务仍要处理')
    assert.equal(second[0]?.deletedMidEntries, 1, '第二次只删剩下的 q2')
    assert.deepEqual(
      listRenderableMidEntries(db).map((r) => r.id),
      ['M1'],
      '最终收敛到只有原有条目',
    )
    assert.equal(currentEpoch(db), 0)
    close()
  } finally {
    await cleanup(dir)
  }
})
