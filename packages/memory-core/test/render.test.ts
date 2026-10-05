/**
 * 渲染纯度与恢复能力测试 —— 阶段 1 最该先钉住的两件事。
 *
 * **为什么先测这个**：PLAN 的第一条设计原则是"表是权威，窗口是渲染"。
 * 如果渲染不纯（读了时钟/环境/全局状态）或不可重建（依赖内存里的增量状态），
 * 那么"崩溃后按表重建窗口"就是空话，缓存断点的字节稳定性也无从谈起。
 *
 * 这两条一旦被测试钉死，后续所有功能（压缩、沉降、召回）才有可靠地基。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MidEntryRow } from '@forlife/store'
import { renderMidMemory, formatAge, DEFAULT_HEADER } from '../src/render.ts'
import { estimateTokens } from '../src/tokens.ts'

/** 造一行中期条目（只填渲染关心的字段）。 */
function row(partial: Partial<MidEntryRow> & { id: string; summary: string }): MidEntryRow {
  return {
    entry_type: 'semantic',
    content: null,
    entities: '[]',
    token_count: estimateTokens(partial.summary),
    window_offset: 0,
    status: 'active',
    fragmented_into: null,
    fragment_hint: null,
    compaction_epoch: 0,
    source_short_ids: '[]',
    created_at: '2026-10-05T00:00:00.000Z',
    last_accessed_at: null,
    storage_tier: 'ssd',
    revision: 1,
    source_scope: null,
    ...partial,
  }
}

test('渲染：形态与 PLAN §2.2 一致（M 顺序编号 + F 指针）', () => {
  const view = renderMidMemory([
    row({ id: 'a', summary: '用户偏好 Rust 写系统工具' }),
    row({ id: 'b', summary: 'DSH 采用追加式稳定前缀' }),
    row({ id: 'c', entry_type: 'fragment', summary: '碎片', fragment_hint: 'QQ bot 防抖与消息队列', fragmented_into: 'long#1' }),
    row({ id: 'd', summary: '当前正在实现碎片索引机制' }),
  ])
  assert.equal(
    view.text,
    [
      DEFAULT_HEADER,
      '[M1] 用户偏好 Rust 写系统工具',
      '[M2] DSH 采用追加式稳定前缀',
      '[F1→] QQ bot 防抖与消息队列（recall_longterm 可取回）',
      '[M3] 当前正在实现碎片索引机制',
    ].join('\n'),
  )
  assert.equal(view.activeCount, 3)
  assert.equal(view.fragmentCount, 1)
  assert.deepEqual(view.violations, [])
})

test('渲染纯度：同一份输入渲染 N 次，sha256 逐字节相同', () => {
  const entries = [
    row({ id: 'a', summary: '第一条记忆' }),
    row({ id: 'b', summary: '第二条记忆' }),
  ]
  const first = renderMidMemory(entries)
  for (let i = 0; i < 20; i++) {
    const again = renderMidMemory(entries)
    assert.equal(again.sha256, first.sha256, `第 ${i + 2} 次渲染出现了字节差异 —— 渲染不纯`)
    assert.equal(again.text, first.text)
  }
})

test('渲染纯度：显式 now 下相对年龄也逐字节稳定；不传 now 直接报错', () => {
  const entries = [row({ id: 'a', summary: '三天前的事', created_at: '2026-10-02T00:00:00.000Z' })]
  const now = new Date('2026-10-05T00:00:00.000Z')
  const a = renderMidMemory(entries, { relativeAges: true, now })
  const b = renderMidMemory(entries, { relativeAges: true, now })
  assert.equal(a.sha256, b.sha256)
  assert.match(a.text, /（3 天前）/)

  // 宁可控诉，也不偷偷读系统时钟（否则渲染不再是纯函数，缓存键就不可信）
  assert.throws(() => renderMidMemory(entries, { relativeAges: true }), /必须显式传入 now/)
})

test('渲染纯度：输入数组顺序决定输出（调用方负责排序，渲染方不猜）', () => {
  const a = row({ id: 'a', summary: 'A' })
  const b = row({ id: 'b', summary: 'B' })
  assert.notEqual(renderMidMemory([a, b]).sha256, renderMidMemory([b, a]).sha256)
})

test('渲染：空记忆区输出空文本（不产生只有标题的空壳，避免污染前缀）', () => {
  const view = renderMidMemory([])
  assert.equal(view.text, '')
  assert.equal(view.tokenEstimate, 0)
  assert.equal(view.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') // 空串的 sha256
})

test('渲染：报告约束违反但不擅自改数据（截断是写入方的责任）', () => {
  // hint 超长：80 token 上限（基线值），这里用远超的中文串
  const longHint = '防'.repeat(200)
  const view = renderMidMemory([
    row({ id: 'f1', entry_type: 'fragment', summary: '碎片', fragment_hint: longHint }),
    row({ id: 'f2', entry_type: 'fragment', summary: '碎片', fragment_hint: '短提示' }),
    row({ id: 'a', summary: '正常条目' }),
  ])
  assert.ok(
    view.violations.some((v) => v.includes('f1') && v.includes('hint')),
    `应报告 hint 超长，实际：${view.violations.join(' / ')}`,
  )
  // 关键：文本里仍包含完整 hint（渲染方没擅自截断）
  assert.ok(view.text.includes(longHint), '渲染方不应擅自截断数据')
})

test('渲染：entities 超量被报告（上限 5）', () => {
  const view = renderMidMemory([
    row({ id: 'a', summary: '条目', entities: JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']) }),
  ])
  assert.ok(view.violations.some((v) => v.includes('entities')), '应报告 entities 超量')
})

test('渲染：碎片区占比超限被报告（上限 20%）', () => {
  const view = renderMidMemory([
    row({ id: 'a', summary: '活跃条目', token_count: 10 }),
    row({ id: 'f1', entry_type: 'fragment', summary: '碎片', fragment_hint: '提示一', token_count: 40 }),
  ])
  assert.ok(
    view.violations.some((v) => v.includes('碎片区占比')),
    `应报告碎片占比超限，实际：${view.violations.join(' / ')}`,
  )
})

test('渲染：坏数据（entities 非法 JSON）不让渲染崩掉', () => {
  const view = renderMidMemory([row({ id: 'a', summary: '条目', entities: '{不是 JSON' })])
  assert.ok(view.text.includes('[M1] 条目'))
})

test('token 估算：中文按字、拉丁按 4 字符，且空串为 0', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('防抖策略'), 4)
  assert.equal(estimateTokens('LanceDB'), 2) // 7 字符 / 4 向上取整
  assert.ok(estimateTokens('中文 mixed text 混排') > 4)
})

test('相对年龄：只给粗粒度，避免每次渲染都抖动', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  assert.equal(formatAge('2026-10-05T11:59:30.000Z', now), '刚刚')
  assert.equal(formatAge('2026-10-05T11:30:00.000Z', now), '30 分钟前')
  assert.equal(formatAge('2026-10-05T06:00:00.000Z', now), '6 小时前')
  assert.equal(formatAge('2026-10-01T12:00:00.000Z', now), '4 天前')
  assert.equal(formatAge('2026-08-01T12:00:00.000Z', now), '2 个月前')
  assert.equal(formatAge('2024-10-05T12:00:00.000Z', now), '2 年前')
  assert.equal(formatAge('不是时间', now), '时间未知')
  assert.equal(formatAge('2026-10-06T12:00:00.000Z', now), '刚刚', '未来时间要钳制，不能出现负数')
})
