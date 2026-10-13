/**
 * 视觉桥接接线的测试（用**假视觉模型**驱动，所以没有凭据也能验完整链路）。
 *
 * 这里守的四条，每条都对应一种"模型开始说胡话"的失败模式：
 *  ① 同图不重复调用（内容寻址缓存）；
 *  ② 重要字段要复核，未复核要标记；
 *  ③ 描述**不进中期记忆**；
 *  ④ **永不抛异常**（它跑在 pre-step 里，抛错会毁掉整轮）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { openDatabase, visionCallsFor, visionStats } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { describeSourceMark, VisionBridge, type VisionDescriber } from '../src/vision-bridge.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-vbridge-'))
let runtime: MemoryRuntime

before(() => {
  openDatabase({ file: join(dir, 'seed.sqlite') }).close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, verbose: false }), dbPath: join(dir, 'forlife.sqlite') })
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 一个记账用的假视觉模型。 */
function fakeDescriber(screen: string, options: { fail?: boolean; verify?: string } = {}): VisionDescriber & { readonly calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = []
  return {
    calls,
    async describe(input) {
      calls.push({ system: input.system, user: input.user })
      if (options.fail === true) throw new Error('视觉模型 502')
      // 复核请求的特征：system 里说"你是核对者"
      if (input.system.includes('核对者')) return options.verify ?? '「¥1,000.50」正确，位置在右上角；日期应为 2026-10-06。'
      return screen
    },
  }
}

const SCREEN = ['【画面内容】', '一张转账截图。', '', '【文字】', '转账 ¥1,000.50 元，2026-10-06 前到账', '', '【不确定之处】', '右下角被裁掉了'].join('\n')

test('首次描述：调用视觉模型、落库、生成带三段与来源标记的块', async () => {
  const describer = fakeDescriber(SCREEN)
  const bridge = new VisionBridge(runtime, { describer, provider: 'vlm', model: 'vl-7b' })
  const result = await bridge.describeImage('sha256:aaa1')

  assert.equal(result.ok, true)
  assert.equal(result.reused, false)
  assert.match(result.text, /转账截图/)
  assert.match(result.text, /¥1,000\.50/)
  assert.match(result.text, /右下角被裁掉/)
  assert.equal(describer.calls.length, 2, '一次描述 + 一次复核（因为 OCR 里有金额与日期）')
  assert.equal(visionCallsFor(runtime.db, 'sha256:aaa1'), 2)
})

test('同图第二次：**0 次视觉调用**（验收项，从日志里数出来）', async () => {
  const describer = fakeDescriber(SCREEN)
  const bridge = new VisionBridge(runtime, { describer })
  // 第一张图上面那个用例已经描述过 ⇒ 这次直接命中缓存
  const result = await bridge.describeImage('sha256:aaa1')
  assert.equal(result.reused, true)
  assert.equal(result.calls, 0)
  assert.equal(describer.calls.length, 0, '命中缓存时**一次都不能调**')
  assert.match(result.text, /复用已有描述/)
})

test('复核：重要字段触发**点名**复核（不是"再看一遍整张图"）', async () => {
  const describer = fakeDescriber(SCREEN, { verify: '「¥1,000.50」正确；日期应是 2026-10-06。' })
  const bridge = new VisionBridge(runtime, { describer })
  const result = await bridge.describeImage('sha256:bbb2')
  assert.equal(describer.calls.length, 2)
  const verifyCall = describer.calls[1]
  assert.match(String(verifyCall?.system), /核对者/)
  assert.match(String(verifyCall?.user), /¥1,000\.50|1,000\.50/, '复核请求必须点名具体字段')
  assert.match(result.text, /重要字段复核结论/)
  assert.equal(result.verified, true)
})

test('没有重要字段时不复核（避免每张图都多花一次调用）', async () => {
  const describer = fakeDescriber('【画面内容】\n一只猫躺在沙发上\n【文字】\n无\n【不确定之处】\n无')
  const bridge = new VisionBridge(runtime, { describer })
  const result = await bridge.describeImage('sha256:ccc3')
  assert.equal(describer.calls.length, 1, '没有金额/时间/命令/人名就不该复核')
  assert.equal(result.verified, false)
})

test('复核失败不算致命：描述仍可用，但**标为未复核**', async () => {
  const describer: VisionDescriber = {
    async describe(input) {
      if (input.system.includes('核对者')) throw new Error('复核通道 503')
      return SCREEN
    },
  }
  const bridge = new VisionBridge(runtime, { describer })
  const result = await bridge.describeImage('sha256:ddd4')
  assert.equal(result.ok, true, '复核失败不该让整个描述失败')
  assert.equal(result.verified, false)
  assert.match(result.text, /ocr-unverified/, '没复核过就必须带未复核标记')
})

test('视觉调用失败：**退回占位文本而不是抛异常**（抛错会毁掉整轮）', async () => {
  const describer = fakeDescriber('', { fail: true })
  const bridge = new VisionBridge(runtime, { describer })
  const result = await bridge.describeImage('sha256:eee5') // 不该 throw
  assert.equal(result.ok, false)
  assert.match(result.text, /图片未能描述/)
  assert.match(result.text, /sha256:eee5/, '占位文本要带附件 id 以便追查')
  assert.match(String(result.error), /502/)
  // 失败的调用也要记（否则"为什么没描述出来"无从查起）
  assert.equal(visionStats(runtime.db).failed, 1)
})

test('没有视觉模型：如实退回占位文本（**不假装看懂了**）', async () => {
  const bridge = new VisionBridge(runtime, {})
  const result = await bridge.describeImage('sha256:fff6')
  assert.equal(result.ok, false)
  assert.match(result.text, /没有可用的视觉模型/)
  assert.match(result.text, /未声明 image 能力/)
})

test('描述**不进中期记忆**（属短期轨迹，只有结论才可能被 push）', () => {
  const bridge = new VisionBridge(runtime, {})
  const verdict = bridge.canEnterMidMemory()
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason, /短期轨迹/)
  assert.match(verdict.reason, /图里有个杯子/, '要说清后果：噪音会把真正重要的记忆挤出去')
})

test('来源标记：未复核的 OCR 进记忆必须带 ocr-unverified', () => {
  const unverified = describeSourceMark({ containsOcr: true, verified: false })
  assert.equal(unverified?.source, 'ocr-unverified')
  assert.match(String(unverified?.note), /提示不是结论/)
  assert.equal(describeSourceMark({ containsOcr: true, verified: true })?.source, 'vision-verified')
  assert.equal(describeSourceMark({ containsOcr: false, verified: false }), undefined)
})

test('缓存里的描述被复用时，块里要写明"未重复调用视觉模型"（成本要可见）', async () => {
  const bridge = new VisionBridge(runtime, { describer: fakeDescriber(SCREEN) })
  await bridge.describeImage('sha256:ggg7')
  const second = await bridge.describeImage('sha256:ggg7')
  assert.match(second.text, /复用已有描述，未重复调用视觉模型/)
})
