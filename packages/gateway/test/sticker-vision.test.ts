/**
 * 视觉描述的守卫测试。
 *
 * 请求构造与响应解析都是纯函数，所以能离线把各种脏输入钉死 ——
 * 这两处才是实践中真正会坏的地方（坏起来是"描述为空"，不是异常）。
 *
 * 其中一个夹具是**真实响应**：拿 `.runtime/qrcode.png` 调
 * `deepseek-v4.1-flash` 得到的原文（已核实该模型接受图像输入）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildStickerVisionRequest,
  createStickerVisionDescriber,
  extractJsonObject,
  parseStickerVisionResponse,
  visionConfigFromEnv,
} from '../src/sticker-vision.ts'

/** 真实响应（2026-10-06 实测，deepseek-v4.1-flash 描述一张二维码）。 */
const REAL_RESPONSE = {
  choices: [
    {
      message: {
        content:
          '{"description":"这张图片是一个黑白二维码，由黑色和白色的方块像素组成，具有三个角上的方形定位图案，通常用于扫描获取信息。","tags":["二维码","QR码","黑白","扫描码","像素图案"]}',
      },
    },
  ],
  usage: { total_tokens: 488 },
}

test('请求构造：图片必须是 data URI（直接塞 base64 会被当成文本）', () => {
  const body = buildStickerVisionRequest({ model: 'm', imageBase64: 'AAA=', mime: 'image/png' })
  const content = (body['messages'] as { content: { type: string; image_url?: { url: string } }[] }[])[0]?.content ?? []
  const image = content.find((part) => part.type === 'image_url')
  assert.ok(image?.image_url !== undefined, '必须带 image_url 段')
  assert.match(image.image_url.url, /^data:image\/png;base64,AAA=$/)

  // MIME 带参数时要清掉（data URI 里不能有 charset）
  const withParams = buildStickerVisionRequest({ model: 'm', imageBase64: 'AAA=', mime: 'image/jpeg; charset=binary' })
  const content2 = (withParams['messages'] as { content: { type: string; image_url?: { url: string } }[] }[])[0]?.content ?? []
  assert.match(content2.find((p) => p.type === 'image_url')?.image_url?.url ?? '', /^data:image\/jpeg;base64,/)
})

test('解析：真实响应能被正确解析出描述与标签', () => {
  const parsed = parseStickerVisionResponse(REAL_RESPONSE)
  assert.match(parsed.description, /二维码/)
  assert.deepEqual(parsed.emotionTags, ['二维码', 'QR码', '黑白', '扫描码', '像素图案'])
})

test('解析：容忍代码块、前后废话、content 分段数组、纯人话', () => {
  const fenced = parseStickerVisionResponse({
    choices: [{ message: { content: '好的，这是结果：\n```json\n{"description":"一只猫","tags":["猫"]}\n```\n希望有帮助' } }],
  })
  assert.equal(fenced.description, '一只猫', '要能从代码块与废话里挖出 JSON')
  assert.deepEqual(fenced.emotionTags, ['猫'])

  const segmented = parseStickerVisionResponse({
    choices: [{ message: { content: [{ type: 'text', text: '{"description":"分段的猫","tags":"猫,可爱"}' }] } }],
  })
  assert.equal(segmented.description, '分段的猫', 'content 是分段数组也要能读')
  assert.deepEqual(segmented.emotionTags, ['猫', '可爱'], '标签是逗号串也要能读')

  const plain = parseStickerVisionResponse({ choices: [{ message: { content: '这是一只很生气的猫' } }] })
  assert.equal(plain.description, '这是一只很生气的猫', '模型只回人话时，整句当描述（有总比丢掉整次调用好）')
  assert.deepEqual(plain.emotionTags, [])

  // 各种空/坏输入都不能抛
  assert.deepEqual(parseStickerVisionResponse(undefined), { description: '', emotionTags: [] })
  assert.deepEqual(parseStickerVisionResponse({}), { description: '', emotionTags: [] })
  assert.deepEqual(parseStickerVisionResponse({ choices: [] }), { description: '', emotionTags: [] })
})

test('extractJsonObject：只取第一个完整对象，坏 JSON 不抛', () => {
  assert.deepEqual(extractJsonObject('前言 {"a":1} 后语'), { a: 1 })
  assert.equal(extractJsonObject('没有对象'), undefined)
  assert.equal(extractJsonObject('{坏掉的'), undefined)
})

test('fail-closed：没配模型时拒绝生成（不编造描述）', () => {
  assert.throws(() => createStickerVisionDescriber({ model: '', baseUrl: 'https://x', apiKey: 'k' }), /fail-closed/)
  assert.equal(visionConfigFromEnv({}), undefined, '环境变量没配 ⇒ 返回 undefined，调用方据此跳过描述')
  assert.equal(visionConfigFromEnv({ FORLIFE_VISION_MODEL: 'm' }), undefined, '只有模型没有 key ⇒ 也不算配置好')
  const configured = visionConfigFromEnv({ FORLIFE_VISION_MODEL: 'deepseek-v4.1-flash', FORLIFE_OPENCODE_GO_KEY: 'k' })
  assert.equal(configured?.model, 'deepseek-v4.1-flash')
  assert.equal(configured?.baseUrl, 'https://opencode.ai/zen/go/v1')
})

test('描述器：空描述必须抛错（空描述入库会让检索命中"什么都没说"的条目）', async () => {
  const describer = createStickerVisionDescriber({
    model: 'm',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }) }),
  })
  await assert.rejects(() => describer(new Uint8Array([1, 2, 3]), 'image/png'), /空内容/)

  // 非 2xx 要带上响应体片段（否则排障时不知道服务端说了什么）
  const failing = createStickerVisionDescriber({
    model: 'm',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  })
  await assert.rejects(() => failing(new Uint8Array([1]), 'image/png'), /HTTP 429.*rate limited/s)

  // 正常路径：请求头要带 UA 与会话 id（OpenCode Go 的要求）
  let seenHeaders: Record<string, string> = {}
  const ok = createStickerVisionDescriber({
    model: 'm',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    sessionId: 'sess-1',
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers
      return { ok: true, status: 200, text: async () => JSON.stringify(REAL_RESPONSE) }
    },
  })
  const result = await ok(new Uint8Array([1]), 'image/png')
  assert.match(result.description, /二维码/)
  assert.equal(result.tokenCount, 488, '用量要带回来（面板要显示花了多少）')
  assert.equal(seenHeaders['x-opencode-session'], 'sess-1')
  assert.match(seenHeaders['user-agent'] ?? '', /dsh-forlife/)
})
