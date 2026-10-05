/**
 * 提示词文本的纯逻辑测试。
 *
 * 守三件事，每一件都直接决定"前缀缓存能不能命中"：
 *  ① 规范化：内容相同 ⇒ 字节相同 ⇒ 哈希相同（否则我们每轮都会误判缓存未命中）；
 *  ② 变量白名单：写错变量名会让**整个提示词装配失败**（DSH 对未定义变量抛错），
 *     所以必须在保存前拦住；
 *  ③ 动态变量禁进前缀：时间/会话这类每轮都变的值写进前缀 = 缓存全废。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  diffPromptLines,
  estimatePromptTokens,
  hashPromptText,
  normalizePromptText,
  PROMPT_VARIABLES,
  renderPromptPreview,
  validatePromptText,
} from '../src/prompt-text.ts'

test('规范化：换行符、行尾空格、首尾空行都不影响哈希（缓存命中的前提）', () => {
  const canonical = '第一行\n第二行\n'
  for (const variant of [
    '第一行\n第二行',
    '第一行\n第二行\n',
    '第一行\n第二行\n\n\n',
    '第一行   \n第二行\t\n',
    '\n\n第一行\n第二行\n',
    '第一行\r\n第二行\r\n',
    '第一行\r第二行\r',
  ]) {
    assert.equal(normalizePromptText(variant), canonical, `规范化失败：${JSON.stringify(variant)}`)
    assert.equal(hashPromptText(variant), hashPromptText(canonical), `哈希应一致：${JSON.stringify(variant)}`)
  }
})

test('规范化：内部空行与缩进**保留**（那是作者的排版意图，不是噪音）', () => {
  const text = '标题\n\n  · 缩进项\n  · 第二项\n'
  assert.equal(normalizePromptText(text), text, '内部空行与行首空格必须原样保留')
})

test('规范化：空文本与纯空白都归一为空串', () => {
  assert.equal(normalizePromptText(''), '')
  assert.equal(normalizePromptText('   \n\t\n'), '')
  assert.equal(normalizePromptText('\r\n'), '')
})

test('校验：合法提示词通过，并列出用到的变量', () => {
  const result = validatePromptText('你是{{persona_name}}，{{owner_name}}的伙伴。\n用{{language}}回答。')
  assert.equal(result.ok, true)
  assert.deepEqual(result.variables, ['persona_name', 'owner_name', 'language'])
  assert.equal(result.errors.length, 0)
})

test('校验：未知变量被拒（写错会让整个提示词装配失败，必须保存前拦住）', () => {
  const result = validatePromptText('你是{{persona_nam}}。')
  assert.equal(result.ok, false)
  assert.match(result.errors[0] ?? '', /未知变量：\{\{persona_nam\}\}/)
  assert.match(result.errors[0] ?? '', /可用变量见白名单/)
})

test('校验：动态变量禁止进稳定前缀（否则每轮换前缀、缓存全废）', () => {
  for (const name of ['now', 'today', 'conversation', 'unread_summary']) {
    const prefix = validatePromptText(`当前情况：{{${name}}}`)
    assert.equal(prefix.ok, false, `${name} 不该被允许进前缀`)
    assert.match(prefix.errors.join(' '), /动态变量/)
    assert.match(prefix.errors.join(' '), /缓存全废/)

    // 尾部注入里允许（那里每轮本来就变）
    const tail = validatePromptText(`当前情况：{{${name}}}`, { scope: 'tail' })
    assert.equal(tail.ok, true, `${name} 在尾部注入里应当允许`)
  }
})

test('校验：变量名不合规、落单的括号、过长文本的处理', () => {
  const bad = validatePromptText('你是{{Persona}}。') // 大写开头
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0] ?? '', /变量名不合法/)

  const lone = validatePromptText('这里有个 {{ 没闭合')
  assert.equal(lone.ok, true, '落单括号只是文字，不该拦住保存')
  assert.match(lone.warnings.join(' '), /落单/)

  const long = validatePromptText('x'.repeat(8001))
  assert.equal(long.ok, true)
  assert.match(long.warnings.join(' '), /提示词较长/)
})

test('校验：空提示词被拒（空等于把行为交给默认值，容易出意外）', () => {
  const result = validatePromptText('   \n  ')
  assert.equal(result.ok, false)
  assert.match(result.errors[0] ?? '', /不能为空/)
})

test('试渲染：用示例值画出最终拼装结果，并记录替换明细', () => {
  const result = renderPromptPreview('你是{{persona_name}}，{{owner_name}}的伙伴。')
  assert.equal(result.ok, true)
  // 返回的是**规范化后**的文本（含一个尾换行）—— 那正是实际会被使用的那一份，如实呈现\n  assert.equal(result.text, '你是团子，主人的伙伴。\n')
  assert.deepEqual(result.substitutions, [
    { name: 'persona_name', value: '团子' },
    { name: 'owner_name', value: '主人' },
  ])
})

test('试渲染：可以覆盖取值（后台预览要用真实值）', () => {
  const result = renderPromptPreview('你是{{persona_name}}。', { persona_name: '小满' })
  assert.equal(result.text, '你是小满。\n')
})

test('试渲染：未知变量报错且原样保留（让用户看得见哪里错了）', () => {
  const result = renderPromptPreview('你是{{nobody}}。')
  assert.equal(result.ok, false)
  assert.match(result.errors[0] ?? '', /未知变量/)
  assert.equal(result.text, '你是{{nobody}}。\n', '出错时不该悄悄吞掉内容')
})

test('token 估算：CJK 按字、其余按 4 字符 1 token', () => {
  assert.equal(estimatePromptTokens('你好世界'), 4)
  assert.equal(estimatePromptTokens('abcdefgh'), 2)
  assert.equal(estimatePromptTokens('你好abcd'), 3) // 2 字 + 4/4
  assert.equal(estimatePromptTokens(''), 0)
})

test('diff：新增、删除、未变三种行都能标出来', () => {
  const diff = diffPromptLines('相同行\n旧的一行\n共同尾部\n', '相同行\n新的一行\n共同尾部\n')
  assert.deepEqual(
    diff.map((d) => `${d.kind}:${d.text}`),
    ['same:相同行', 'removed:旧的一行', 'added:新的一行', 'same:共同尾部'],
  )
})

test('diff：纯新增与纯删除', () => {
  assert.deepEqual(diffPromptLines('A\n', 'A\nB\n').map((d) => d.kind), ['same', 'added'])
  assert.deepEqual(diffPromptLines('A\nB\n', 'A\n').map((d) => d.kind), ['same', 'removed'])
  assert.deepEqual(diffPromptLines('', 'A\n').map((d) => d.kind), ['added'], '空 → 有内容：只该有新增')
})

test('变量白名单本身自洽：名字合法、稳定与动态划分明确、示例值齐全', () => {
  const names = new Set<string>()
  for (const variable of PROMPT_VARIABLES) {
    assert.match(variable.name, /^[a-z][a-z0-9_]*$/, `${variable.name} 名字不合法`)
    assert.equal(names.has(variable.name), false, `${variable.name} 重复定义`)
    names.add(variable.name)
    assert.ok(variable.sample !== '', `${variable.name} 缺示例值（试渲染要用）`)
    assert.ok(variable.description.length > 0)
  }
  // 稳定与动态都必须有：只有一类说明划分没意义
  assert.ok(PROMPT_VARIABLES.some((v) => !v.dynamic), '必须有稳定变量')
  assert.ok(PROMPT_VARIABLES.some((v) => v.dynamic), '必须有动态变量（它们只允许用在尾部）')
})

