/**
 * 视觉桥接的测试。
 *
 * 这一批守的是**用户明确要求的那条**：「OCR 是提示不是结论」。
 * 所以测试不只验"能解析三段"，更要验：
 *  - 未复核的 OCR 内容进记忆时**必须**带 `ocr-unverified` 标记；
 *  - OCR 里的金额/时间/命令/人名**必须**触发视觉复核；
 *  - 认不准的字标成「?」时要**明说不要当事实**；
 *  - 同一张图第二次 **0 次视觉调用**（验收项）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decideImageRoute,
  decideVerification,
  decideVisionCall,
  describePrompt,
  findImportantFields,
  markMemorySource,
  parseDescription,
  renderDescriptionBlock,
  verificationPrompt,
} from '../src/vision.ts'

test('分流：三态语义要分清（undefined ≠ 不支持，是"没人声明"）', () => {
  const direct = decideImageRoute(['text', 'image'])
  assert.equal(direct.route, 'direct')
  assert.match(direct.reason, /零额外调用/)

  const bridge = decideImageRoute(['text'])
  assert.equal(bridge.route, 'bridge')
  assert.match(bridge.reason, /占位文本/)

  const unknown = decideImageRoute(undefined)
  assert.equal(unknown.route, 'bridge-unverified-modality')
  assert.match(unknown.reason, /硬拒|保守/)
  assert.match(String(unknown.diagnostic), /补声明/, '未知模态必须提示运维补声明，否则每次都白花一次视觉调用')
  assert.equal(decideImageRoute([]).route, 'bridge', '空数组等价于显式纯文本')
})

test('描述提示词：三段强制 + 明确说"不要猜一个看起来合理的字"', () => {
  const prompt = describePrompt({ senderName: '老王' })
  for (const section of ['【画面内容】', '【文字】', '【不确定之处】']) {
    assert.ok(prompt.system.includes(section), `提示词必须包含 ${section}`)
  }
  assert.match(prompt.system, /不要猜一个看起来合理的字/)
  assert.match(prompt.system, /线索而不是事实/, '要告诉视觉模型：它写的文字会被当作线索')
  assert.ok(prompt.system.includes('老王'))
})

test('解析：正常三段', () => {
  const parsed = parseDescription(
    ['【画面内容】', '一张聊天截图。', '', '【文字】', '明天下午三点开会', '', '【不确定之处】', '右下角被裁掉了'].join('\n'),
  )
  assert.equal(parsed.scene, '一张聊天截图。')
  assert.equal(parsed.ocr, '明天下午三点开会')
  assert.equal(parsed.uncertain, '右下角被裁掉了')
  assert.equal(parsed.ocrHasGaps, false)
})

test('解析：模型没按格式写时也不能丢信息（退化为整段作画面内容）', () => {
  const parsed = parseDescription('图里是一只猫。')
  assert.equal(parsed.scene, '图里是一只猫。')
  assert.equal(parsed.ocr, undefined)
  assert.equal(parsed.uncertain, undefined)
  assert.equal(parsed.raw, '图里是一只猫。')
})

test('解析：容忍全角/半角括号与缺省小节', () => {
  const halfWidth = parseDescription('[画面内容]\n一只狗\n[文字(OCR)]\nHello\n[不确定]\n有点糊')
  assert.equal(halfWidth.scene, '一只狗')
  assert.equal(halfWidth.ocr, 'Hello')
  assert.equal(halfWidth.uncertain, '有点糊')

  const empty = parseDescription('【画面内容】\n一张风景照\n【文字】\n无\n【不确定之处】\n无')
  assert.equal(empty.ocr, undefined, '"无"要当成没有内容')
  assert.equal(empty.uncertain, undefined)
})

test('解析：OCR 段带「?」或"看不清"时标记 ocrHasGaps（这是不可靠的信号）', () => {
  assert.equal(parseDescription('【文字】\n金额 100?0 元').ocrHasGaps, true)
  assert.equal(parseDescription('【文字】\n签名看不清').ocrHasGaps, true)
  assert.equal(parseDescription('【文字】\n明天开会').ocrHasGaps, false)
})

test('重要字段：金额/时间/命令/人名四类都要挑出来', () => {
  const ocr = '转账 ¥1,000.50 元\n2026-10-05 14:30 周一开始\nsudo apt install nginx\n@老王 说这个可以'
  const fields = findImportantFields(ocr)
  const kinds = new Set(fields.map((field) => field.kind))
  assert.ok(kinds.has('amount'), `应当认出金额，实际：${JSON.stringify(fields)}`)
  assert.ok(kinds.has('time'))
  assert.ok(kinds.has('command'))
  assert.ok(kinds.has('name'))
  // 数值要原样保留（复核时才有可比对的目标）
  assert.ok(fields.some((field) => field.text.includes('1,000.50')))
})

test('重要字段：普通文字不会触发（避免每次都多花一次视觉调用）', () => {
  const fields = findImportantFields('今天天气不错，我们一起吃个饭吧')
  assert.deepEqual(fields, [], '没有重要字段就不该复核 —— 否则每张图都要调用两次')
})

test('复核判定：有钱/时间/命令/人名就必须复核，并**点名**那几个字段', () => {
  const decision = decideVerification('订单金额 ¥2,000，请在 2026-10-06 前付款')
  assert.equal(decision.needed, true)
  assert.ok(decision.fields.length > 0)
  assert.match(decision.reason, /认错一个字符在文本上看不出来/)

  const prompt = verificationPrompt(decision.fields)
  assert.match(prompt, /仔细核对/)
  assert.match(prompt, /看不清就明确说看不清/)
  assert.match(prompt, /不要为了让答案完整而猜/)
  assert.ok(prompt.includes('¥2,000') || prompt.includes('2,000'), '复核提示要点名具体字段')
})

test('复核判定：没有 OCR / 没有重要字段 / 被关掉时都不复核', () => {
  assert.equal(decideVerification(undefined).needed, false)
  assert.equal(decideVerification('   ').needed, false)
  assert.equal(decideVerification('一只猫在沙发上').needed, false)
  assert.equal(decideVerification('¥100', { enabled: false }).needed, false)
  assert.match(decideVerification('¥100', { enabled: false }).reason, /关闭/)
})

test('记忆标记：未复核的 OCR 内容必须带 ocr-unverified（**用户明确要求**）', () => {
  const unverified = markMemorySource({ containsOcr: true, verified: false })
  assert.equal(unverified?.source, 'ocr-unverified')
  assert.match(String(unverified?.note), /提示不是结论/)
  assert.match(String(unverified?.note), /金额\/时间\/命令\/人名/, '要说清哪些字段最危险')
  assert.match(String(unverified?.note), /不要直接当成事实/)

  const verified = markMemorySource({ containsOcr: true, verified: true })
  assert.equal(verified?.source, 'vision-verified')

  // 不含 OCR 内容就不需要标记（否则标记会退化成噪音）
  assert.equal(markMemorySource({ containsOcr: false, verified: false }), undefined)
})

test('描述块：替代框架的"图片被省略了"，并把未复核这件事写在脸上', () => {
  const block = renderDescriptionBlock({
    attachmentId: 'sha256:abc123',
    description: parseDescription('【画面内容】\n一张转账截图\n【文字】\n¥1,00?0 元\n【不确定之处】\n数字有点糊'),
  })
  assert.match(block, /\[图片描述\]/)
  assert.match(block, /一张转账截图/)
  assert.match(block, /图中文字/)
  assert.match(block, /没认准/, '带「?」时要明说不要当事实')
  assert.match(block, /ocr-unverified/)
  assert.match(block, /sha256:abc123/)
  assert.match(block, /describe_image/, '要告诉模型"需要再细看有工具可用"')

  const reused = renderDescriptionBlock({
    attachmentId: 'sha256:abc123',
    description: parseDescription('【画面内容】\n一只猫'),
    verified: true,
    reused: true,
  })
  assert.match(reused, /复用已有描述，未重复调用视觉模型/)
  assert.ok(!reused.includes('ocr-unverified'), '复核过的不该再标未复核')
})

test('视觉调用：首次要调，第二次 **0 次调用**（验收项）', () => {
  const first = decideVisionCall(undefined)
  assert.equal(first.needed, true)
  assert.equal(first.counter.reused, false)

  const second = decideVisionCall({ visionCalls: 1 })
  assert.equal(second.needed, false, '同一张图第二次必须 0 次视觉调用')
  assert.equal(second.counter.reused, true)
  assert.match(second.reason, /0 次视觉调用/)
  assert.equal(second.counter.calls, 1, '计数要如实反映历史调用次数（面板要显示成本）')
})
