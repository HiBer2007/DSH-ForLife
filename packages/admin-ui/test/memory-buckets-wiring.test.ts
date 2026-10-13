/**
 * ★★ P2-a 的**接线守卫**：面板「记忆条目」板块必须显示**用户指定的四块口径**
 * —— **活跃 / 中期 / 长期碎片 / 长期**（`FIX_PLAN.md` §10）。
 *
 * ## 为什么要有这个测试
 *
 * 这四个词是**用户直接给的**（原话：「记忆条目板块应当显示为 活跃/中期/长期碎片/长期」），
 * 而且里面藏着**三个容易看错的地方** —— 谁"顺手改一下"都会把它改坏：
 *
 * 1. **「中期」不是「活跃」的同义词** —— 它是 活跃 + 长期碎片
 *    （`PLAN.MD:257`：中期区 = active 80–85% + 碎片 15–20%）。
 * 2. **「长期碎片」不在长期库里** —— 它是**中期区里**指向长期记忆的碎片
 *    （`status='fragmented'`）。名字里带"长期"，位置却在中期 ⇒ 极易搞反。
 * 3. **「长期碎片」与「长期」是两张不同的表**（`mid_memory_entries` vs `long_memory_entries`）。
 *
 * ## 手法（与仓库里既有的接线守卫一致）
 *
 * 读**源码**、**去注释**、断言**语句位置**、断言**绑的是哪个字段**。
 * ★ 去注释很重要：这四个词在注释里也会出现，不去注释的话
 *   **把标签删掉、只留注释**也能让测试变绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const VIEW = join(import.meta.dirname, '..', 'src', 'views', 'MemoryView.vue')

/** 去掉 `<!-- … -->`（含多行）与行内注释，只留下真正的模板/代码。 */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

test('★★★ 面板「记忆条目」板块显示四块口径：活跃 / 中期 / 长期碎片 / 长期', () => {
  const src = stripComments(readFileSync(VIEW, 'utf8'))

  for (const label of ['活跃', '中期', '长期碎片', '长期']) {
    assert.match(
      src,
      new RegExp(`mem-bucket-label">${label}<`),
      `★ 缺了「${label}」这一块 —— 用户原话：「记忆条目板块应当显示为 活跃/中期/长期碎片/长期」`,
    )
  }
})

/**
 * 取出某个桶的**值表达式**。
 *
 * ★★ 为什么必须"定位到桶"再断言（这条是被回退验证逼出来的）：
 *
 * 我第一版把「中期」断言写成**全文搜** `counts.active + counts.fragmented` ——
 * 结果**注入"中期只显示 active"之后测试照样绿**：
 * 因为**副标题**那行本来就有 `counts.active + counts.fragmented + counts.archived`，
 * 正则**前缀匹配**上了 ❌。
 *
 * ⇒ 这正是「接线守卫」那条纪律说的：**要断言语句位置，不能只断言"全文某处出现过"**。
 */
function bucketValue(src: string, label: string): string {
  const m = src.match(
    new RegExp(`mem-bucket-label">${label}</span>[\\s\\S]{0,300}?mem-bucket-value">([\\s\\S]{0,200}?)</span>`),
  )
  assert.ok(m, `找不到「${label}」那个桶的值绑定`)
  return String(m[1])
}

test('★★ 「中期」= 活跃 + 长期碎片 —— 它不是「活跃」的同义词', () => {
  const src = stripComments(readFileSync(VIEW, 'utf8'))
  const value = bucketValue(src, '中期')
  assert.match(
    value,
    /counts\.active\s*\+\s*state\.data\.value\.counts\.fragmented/,
    '★ 「中期」**那个桶**必须是 active + fragmented 之和' +
      '（PLAN.MD:257：中期区 = active 80–85% + 碎片 15–20%）—— ' +
      `实际绑的是：${value.replace(/\s+/g, ' ').trim()}`,
  )
})

test('★ 「活跃」桶只取 active —— 不许把碎片也算进去', () => {
  const value = bucketValue(stripComments(readFileSync(VIEW, 'utf8')), '活跃')
  assert.match(value, /counts\.active/, '★ 「活跃」应当绑 counts.active')
  assert.doesNotMatch(
    value,
    /counts\.fragmented/,
    '★ 「活跃」桶里混进了 fragments —— 碎片属于中期区，不属于"活跃"',
  )
})

test('★★ 「长期碎片」取的是 fragmented（中期区里的指针），不是 long（长期库）', () => {
  const value = bucketValue(stripComments(readFileSync(VIEW, 'utf8')), '长期碎片')
  assert.match(
    value,
    /counts\.fragmented/,
    '★ 「长期碎片」必须绑 mid 表的 fragmented 计数 —— 用户定义是' +
      '「在中期记忆中关于长期记忆的碎片」，它**不在长期库里**',
  )
  assert.doesNotMatch(
    value,
    /counts\.long/,
    '★★ 「长期碎片」绑成了 counts.long —— 那是**长期库**，是另一张表',
  )
})

test('★ 「长期」桶取的是 long（long_memory_entries）', () => {
  const value = bucketValue(stripComments(readFileSync(VIEW, 'utf8')), '长期')
  assert.match(value, /counts\.long/, '★ 「长期」应当绑 counts.long')
})

test('★ 顶部那张统计卡也叫「长期碎片」—— 与四块口径用同一套词', () => {
  const src = stripComments(readFileSync(VIEW, 'utf8'))
  assert.match(src, /label="长期碎片"/, '★ 顶部卡片应叫「长期碎片」（原来叫"碎片条目"，与四块口径不一致）')
  assert.doesNotMatch(src, /label="碎片条目"/, '★ 旧的「碎片条目」叫法应当已经改掉')
})
