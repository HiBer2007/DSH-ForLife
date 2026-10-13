/**
 * ★★ 结构性缺口检测（`FIX_PLAN.md` §78.41 的教训）。
 *
 * 真事：中期记忆区 **10,914 条**的 `entities` **全是 `[]`**，而 `PLAN.MD` §5.3 有三条规则依赖它
 * ⇒ ★ **规则是死的，却没有任何告警**（靠人肉查库才发现，那时已经过了一万多条）。
 *
 * ## 这一组测试钉住四条
 *
 * 1. ★★ **整列为空 ⇒ 报**（这正是那次没报出来的情形）；
 * 2. ★ **部分为空 ⇒ 不报**（有些条目就是没有关键词，那不是结构性问题）；
 * 3. ★ **行数太少 ⇒ 不报**（刚部署的空库不该刷告警）；
 * 4. ★ **表/列不存在 ⇒ 不报错**（老库与测试替身要能跑）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { describeStructuralGaps, findStructuralGaps, type StructuralCheck } from '../src/admin/structural-gaps.ts'

/** 造一个只有 `entities` 列的临时表（够本模块用）。 */
function seeded(values: readonly (string | null)[]): ReturnType<typeof openDatabase>['db'] {
  const opened = openDatabase({ file: ':memory:' })
  opened.db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, entities TEXT)')
  const insert = opened.db.prepare('INSERT INTO probe (entities) VALUES (?)')
  for (const value of values) insert.run(value)
  return opened.db
}

const CHECK: StructuralCheck = { table: 'probe', column: 'entities', what: '关键词', spec: 'PLAN §5.3', minRows: 3 }

test('★★★ 整列为空 ⇒ 报（那次就是没报出来）', () => {
  const db = seeded(['[]', null, '[]', '  ', '[]'])
  const gaps = findStructuralGaps(db, [CHECK])
  assert.equal(gaps.length, 1, '整列为空必须报')
  assert.equal(gaps[0]?.rows, 5)
  assert.equal(gaps[0]?.empty, 5)
  const text = describeStructuralGaps(gaps)
  assert.ok(text !== undefined)
  assert.match(text, /probe\.entities/, '要说清是哪张表哪一列')
  assert.match(text, /5 行全部为空/, '要把**规模**写出来（一万多条 vs 几条，严重程度完全不同）')
  assert.match(text, /PLAN §5\.3/, '★ 要指回依赖它的规格条款')
  assert.ok(!text.includes('**'), '★ 面板/日志不渲染 Markdown，不许出现星号')
})

test('★★ 部分为空 ⇒ **不报**（有些条目就是没有关键词，那不是结构性问题）', () => {
  const db = seeded(['["a"]', '[]', '["b"]', '[]'])
  assert.deepEqual(findStructuralGaps(db, [CHECK]), [])
})

test('★ 行数太少 ⇒ 不报（刚部署的空库不该刷告警）', () => {
  const db = seeded(['[]', '[]'])
  assert.deepEqual(findStructuralGaps(db, [{ ...CHECK, minRows: 3 }]), [], '2 行 < 门槛 3 ⇒ 不报')
  assert.equal(findStructuralGaps(db, [{ ...CHECK, minRows: 2 }]).length, 1, '门槛降到 2 就该报')
})

test('★ 表/列不存在 ⇒ 不报错（老库与测试替身要能跑）', () => {
  const opened = openDatabase({ file: ':memory:' })
  assert.deepEqual(
    findStructuralGaps(opened.db, [{ table: 'no_such_table', column: 'entities', what: 'x', spec: 'y' }]),
    [],
    '★ 表不存在不是"缺口"，也不许抛',
  )
  assert.deepEqual(findStructuralGaps(opened.db, [{ ...CHECK, table: 'probe' }]), [], '列不存在同理')
})

test('★ 没有缺口 ⇒ `describeStructuralGaps` 给 `undefined`（调用方据此决定不喊）', () => {
  assert.equal(describeStructuralGaps([]), undefined)
})

test('★★ 默认检查项里包含 `mid_memory_entries.entities`（那次踩到的那个字段）', async () => {
  const { STRUCTURAL_CHECKS } = await import('../src/admin/structural-gaps.ts')
  const hit = STRUCTURAL_CHECKS.find((c) => c.table === 'mid_memory_entries' && c.column === 'entities')
  assert.ok(hit !== undefined, '★ 踩过的字段必须在默认清单里，否则下次还会靠人肉查库')
  assert.match(hit.spec, /§5\.3/, '要指回规格')
})

test('★★★ 生产接线：`server.ts` 启动时真的扫一遍并喊（否则又是"库写好了、生产零调用"）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(source, /findStructuralGaps\(db\)/, '★ 要真的扫库')
  assert.match(source, /describeStructuralGaps\(findStructuralGaps\(db\)\)/, '★ 要拼成人能读的文本')
  assert.match(source, /createLogger\('data-gaps'\)/, '★ 模块名固定 ⇒ 面板按模块筛得到')
  assert.match(source, /gapLogger\.warn\?\.\(gapText\)/, '★ 有缺口才喊（没缺口不喊）')
})

test('★★★ 沉默链路：上游有量、留痕为空 ⇒ 报（压缩从没跑过就是这么发现的）', async () => {
  const { findSilentPipelines, describeSilentPipelines } = await import('../src/admin/structural-gaps.ts')
  const { openDatabase } = await import('@forlife/store')
  const opened = openDatabase({ file: ':memory:' })
  // ★ 用**自己的探针表**（真 schema 里已经有 compaction_log / mid_memory_entries，CREATE TABLE 会撞）
  opened.db.exec('CREATE TABLE probe_log (id TEXT)')
  opened.db.exec('CREATE TABLE probe_mid (id TEXT)')
  const insert = opened.db.prepare('INSERT INTO probe_mid (id) VALUES (?)')
  for (let i = 0; i < 1500; i += 1) insert.run(`mid_${String(i)}`)
  const checks = [
    { table: 'probe_log', peerTable: 'probe_mid', minPeerRows: 1000, what: '压缩留痕', spec: 'PLAN §5.3-3' },
  ]
  const found = findSilentPipelines(opened.db, checks)
  assert.equal(found.length, 1, '★ 上游 1500 行、留痕 0 行 ⇒ 必须报')
  assert.equal(found[0]?.peerRows, 1500, '要把上游规模写出来')
  const text = describeSilentPipelines(found)
  assert.ok(text !== undefined)
  assert.match(text, /probe_log 一行都没有/)
  assert.match(text, /1500 行/, '★ 规模必须出现（脱敏也不许吃掉它 —— 见 redact 的单位豁免表）')
  assert.match(text, /PLAN §5\.3-3/, '要指回规格')
  assert.ok(!text.includes('**'), '★ 不许 Markdown')
  // ★ 上游量不够 ⇒ 不报（刚部署的库不该刷）
  const few = openDatabase({ file: ':memory:' })
  few.db.exec('CREATE TABLE probe_log (id TEXT)')
  few.db.exec('CREATE TABLE probe_mid (id TEXT)')
  assert.deepEqual(findSilentPipelines(few.db, checks), [], '上游 0 行 ⇒ 不算沉默')
  // ★ 留痕有量 ⇒ 不报
  opened.db.exec("INSERT INTO probe_log (id) VALUES ('c1')")
  assert.deepEqual(findSilentPipelines(opened.db, checks), [], '跑过一次就不该再喊')
})

test('★★ 生产接线：`server.ts` 两条检测都真的调了（防"库写好、生产零调用"）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.match(source, /findSilentPipelines\(db\)/)
  assert.match(source, /describeSilentPipelines\(findSilentPipelines\(db\)\)/)
  assert.match(source, /gapLogger\.warn\?\.\(silentText\)/)
})

test('★★★ 空列要写清"后果"（★ 光说"这列为空"不够 —— 规则可能已经变形）', async () => {
  const { describeStructuralGaps, findStructuralGaps, STRUCTURAL_CHECKS } = await import('../src/admin/structural-gaps.ts')
  const { openDatabase } = await import('@forlife/store')
  const opened = openDatabase({ file: ':memory:' })
  opened.db.exec('CREATE TABLE probe2 (id INTEGER PRIMARY KEY, flag TEXT)')
  const insert = opened.db.prepare('INSERT INTO probe2 (flag) VALUES (?)')
  for (let i = 0; i < 120; i += 1) insert.run(null)
  const text = describeStructuralGaps(
    findStructuralGaps(opened.db, [
      { table: 'probe2', column: 'flag', what: '某标志', spec: 'PLAN §X', consequence: '规则实际按另一个字段生效' },
    ]),
  )
  assert.ok(text !== undefined)
  assert.match(text, /后果：规则实际按另一个字段生效/, '★ 后果必须出现在告警里')
  // ★ 没写后果的项也要能正常输出（不许出现 "undefined"）
  const plain = describeStructuralGaps(
    findStructuralGaps(opened.db, [{ table: 'probe2', column: 'flag', what: '某标志', spec: 'PLAN §X' }]),
  )
  assert.ok(plain !== undefined)
  assert.ok(!plain.includes('undefined'), '★ 没写后果时不许打印 undefined')
  // ★★ 四条新检测（都是 2026-10-13 真踩到的）必须在默认清单里，且都写了后果
  for (const key of [
    ['mid_memory_entries', 'last_accessed_at'],
    ['long_memory_entries', 'last_accessed_at'],
    ['long_memory_entries', 'embedding_id'],
    ['mid_memory_entries', 'source_short_ids'],
  ] as const) {
    const hit = STRUCTURAL_CHECKS.find((c) => c.table === key[0] && c.column === key[1])
    assert.ok(hit !== undefined, `★ ${key[0]}.${key[1]} 必须在默认清单里`)
    assert.ok((hit.consequence ?? '').length > 10, `★ ${key[0]}.${key[1]} 必须写清后果（否则看日志的人不知道坏了什么）`)
  }
})