/**
 * ★★★ **系统提示词基线的语言守卫**（`FIX_PLAN.md` §76.5③ / §78.14）。
 *
 * 用户裁定（2026-10-11）：「所有的工具、**系统提示词**需要修改为英文，以支持所有模型」。
 *
 * ## 这条守卫守四件事（每一件都能独立坏掉）
 *
 * 1. ★★ **文案里不许再有中文**（"改英文"这件事本身，回了就红）；
 * 2. ★★★ **`{{…}}` 变量一字不许少** —— 装配靠它填值，少一个就是提示词直接坏
 *    （而"英文翻译得挺好、变量被顺手翻掉了"是这类改动最典型的翻车方式）；
 * 3. ★★ **`prompt.variables.language` 必须还是「中文」** ——
 *    指令语言改成英文**不等于**让模型改说英文：它是对中国朋友说话的 QQ 伙伴，
 *    回答语言由这个变量决定。把这里也"翻成英文"是**最危险的一种误解**，所以单独钉一条；
 * 4. ★ **工具名与结构**（`##` 小节、行内 `` `tool_name` ``）不许被翻译掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baselineValue } from '../src/baseline.ts'

/** 中日韩统一表意文字（与工具棘轮同一套判据）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 三条基线默认提示词。 */
const PROMPTS = ['prompt.p1Default', 'prompt.p2Default', 'prompt.proactivity'] as const

/** 每条提示词里应当出现的变量（**少一个都不行**）。 */
const EXPECTED_VARS: Readonly<Record<string, readonly string[]>> = {
  'prompt.p1Default': ['{{persona_role}}', '{{language}}'],
  'prompt.p2Default': [],
  'prompt.proactivity': [],
}

/** 主动性子提示词里点名的工具（★ 与实际注册的工具名一一对应，改名必须来这里改）。 */
const PROACTIVITY_TOOLS = [
  'schedule_wake',
  'register_watcher',
  'list_wakes',
  'cancel_wake',
  'wake_now',
  'qq_reply',
  'qq_react',
  'qq_typing',
  'read_pending',
  'recall_longterm',
  'now',
] as const

test('★★★ 三条基线提示词里**一处中文都不许有**（用户裁定：系统提示词改英文）', () => {
  const offenders: string[] = []
  for (const key of PROMPTS) {
    const text = baselineValue(key)
    assert.equal(typeof text, 'string', `${key} 必须是字符串`)
    const lines = String(text).split('\n')
    for (const [index, line] of lines.entries()) {
      if (CJK.test(line)) offenders.push(`${key}:${String(index + 1)}: ${line.slice(0, 70)}`)
    }
  }
  assert.deepEqual(offenders, [], '**基线提示词必须全英文**（中文会让非中文模型难以稳定遵循）')
})

test('★★★ `{{…}}` 变量一字不许少（少一个就是装配直接坏）', () => {
  for (const key of PROMPTS) {
    const text = String(baselineValue(key))
    const found = [...text.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]).sort()
    const expected = [...(EXPECTED_VARS[key] ?? [])].sort()
    assert.deepEqual(found, expected, `${key} 的变量必须恰好是 ${expected.join(' / ')}`)
  }
})

test('★★★ ★ 回答语言**仍然是中文**（指令语言改英文 ≠ 让模型改说英文）', () => {
  assert.equal(
    baselineValue('prompt.variables.language'),
    '中文',
    '★ 这个变量是"对它说话的人用的语言"，它是 QQ 里的中文伙伴 —— ' +
      '把这里也翻成 English 会让它对着中国朋友说英文。**改提示词语言时不要动它。**',
  )
  // ★ P1 里那句"用 {{language}} 回答"必须还在（否则变量留着也没人用）
  assert.match(
    String(baselineValue('prompt.p1Default')),
    /Answer in \{\{language\}\}/,
    '★ P1 必须仍然用 `{{language}}` 指定回答语言',
  )
})

test('★★ 工具名与行内代码不许被翻译掉（主动性子提示词点名 11 个工具）', () => {
  const text = String(baselineValue('prompt.proactivity'))
  const missing = PROACTIVITY_TOOLS.filter((name) => !text.includes(`\`${name}\``))
  assert.deepEqual(missing, [], '★ 主动性子提示词必须继续点名这些工具（写成行内代码）')
})

test('★ 三条提示词都还活着（不是空串、小节结构还在）', () => {
  for (const key of PROMPTS) {
    const text = String(baselineValue(key))
    assert.ok(text.length > 200, `${key} 太短了（${String(text.length)} 字符）—— 像被清空了`)
    assert.match(text, /^##/m, `${key} 必须保留 '##' 小节结构`)
  }
  assert.ok(
    String(baselineValue('prompt.proactivity')).split('\n').filter((line) => line.startsWith('### ')).length >= 4,
    '主动性那节必须有 4 个 `###` 子节（主动发消息 / 提问题 / 唤醒自己 / 拿不准的时候）',
  )
})
