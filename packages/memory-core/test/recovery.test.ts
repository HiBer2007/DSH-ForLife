/**
 * 崩溃恢复测试 —— PLAN 承诺"崩溃时表可重建窗口"，这里把它变成可执行断言。
 *
 * 场景设计（不 mock，用真库）：
 *  1. 正常写入若干条 → 记住窗口文本；
 *  2. 模拟崩溃：**丢弃一切内存状态**，只保留磁盘上的库文件；
 *  3. 重新打开库并重新渲染 → 必须与崩溃前的窗口**逐字节相同**；
 *  4. 追加/碎片化会改变渲染修订号（缓存失效的依据），而只读操作不会。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { appendMidEntry, currentRevision, fragmentMidEntry, listRenderableMidEntries, openDatabase } from '@forlife/store'
import { renderMidMemory } from '../src/render.ts'

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

test('崩溃恢复：只靠磁盘上的表，窗口可以被逐字节重建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-recover-'))
  const file = join(dir, 'forlife.sqlite')
  try {
    // ① 第一阶段：正常写入
    const session1 = openDatabase({ file })
    appendMidEntry(session1.db, { id: 'M1', summary: '用户偏好 Rust 写系统工具', tokenCount: 12, sourceScope: 'private:10001' })
    appendMidEntry(session1.db, { id: 'M2', summary: 'DSH 采用追加式稳定前缀', tokenCount: 10 })
    appendMidEntry(session1.db, { id: 'M3', summary: 'QQ 侧默认只回 @ 和拍一拍', tokenCount: 11 })
    fragmentMidEntry(session1.db, 'M2', 'long#4821', 'DSH 追加式稳定前缀与缓存断点', 22)
    const before = renderMidMemory(listRenderableMidEntries(session1.db))
    const revisionBefore = currentRevision(session1.db)
    // 模拟崩溃：不调用 close()，直接丢弃引用（WAL 已落盘，等价于进程被杀）
    assert.ok(before.text.includes('[F1→]'))

    // ② 第二阶段：重新打开（新进程视角）
    const session2 = openDatabase({ file })
    const after = renderMidMemory(listRenderableMidEntries(session2.db))
    assert.equal(after.sha256, before.sha256, '崩溃后重建的窗口必须与崩溃前逐字节一致')
    assert.equal(after.text, before.text)
    assert.equal(currentRevision(session2.db), revisionBefore, '修订号也必须持久，不能依赖内存')
    session2.close()
  } finally {
    await cleanup(dir)
  }
})

test('渲染修订号：只有写操作会推进它，纯渲染不会', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-revision-'))
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    const r0 = currentRevision(db)
    appendMidEntry(db, { id: 'M1', summary: '条目一', tokenCount: 5 })
    const r1 = currentRevision(db)
    assert.equal(r1, r0 + 1, '追加必须推进修订号（否则渲染缓存不会失效）')

    // 反复渲染不应改变任何状态 —— 这是"渲染是纯函数"的持久层侧证明
    for (let i = 0; i < 5; i++) renderMidMemory(listRenderableMidEntries(db))
    assert.equal(currentRevision(db), r1, '纯渲染不得推进修订号')

    fragmentMidEntry(db, 'M1', 'long#1', '提示', 8)
    assert.equal(currentRevision(db), r1 + 1, '碎片化必须推进修订号')
    close()
  } finally {
    await cleanup(dir)
  }
})

test('表是权威：手工改动表内容，窗口随之改变（不存在第二份真源）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-authority-'))
  const file = join(dir, 'forlife.sqlite')
  try {
    const { db, close } = openDatabase({ file })
    appendMidEntry(db, { id: 'M1', summary: '原始摘要', tokenCount: 5 })
    const before = renderMidMemory(listRenderableMidEntries(db))
    assert.ok(before.text.includes('原始摘要'))

    // 直接改表（模拟人工修正/后台编辑），不做任何"同步窗口"的动作
    db.prepare('UPDATE mid_memory_entries SET summary = ? WHERE id = ?').run('修正后的摘要', 'M1')
    const after = renderMidMemory(listRenderableMidEntries(db))
    assert.ok(after.text.includes('修正后的摘要'), '窗口必须是表的投影')
    assert.notEqual(after.sha256, before.sha256)
    close()
  } finally {
    await cleanup(dir)
  }
})
