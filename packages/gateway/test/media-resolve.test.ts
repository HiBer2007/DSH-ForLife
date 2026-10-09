/**
 * ★ P1-1 / P1-2 / P2-b：入站媒体（图片 / 语音 / 文件）到底有没有变成**模型看得到的文字**。
 *
 * ## 这个文件里最重要的两条
 *
 * 1. **★ 端到端：她发一张图 ⇒ 模型在提示词里读到描述**。
 *    走真实链路（真 WS + 真 SQLite + 真网关 + 真防抖/调度/轮次），
 *    只有"QQ 那头的手机"、"模型那头的大脑"和"视觉模型"是假的。
 *    断言落在 `FakeTurnDriver.requests[0].prompt` 上 —— 那是模型真正拿到的那段文字。
 * 2. **失败必须看得见**：取不回 / 没配视觉 / 超大 / 群里没 @ 我 ——
 *    每一种都要在提示词里留下**带原因的**占位符，而不是空白。
 *    （本项目栽过："她发的健康截图"对模型 = 三个字 `[图片]`。）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { WebSocket } from 'ws'

import { openDatabase } from '@forlife/store'

import { FakeTurnDriver } from '../src/driver.ts'
import { Gateway } from '../src/gateway.ts'
import {
  createImageDownloader,
  decideLookAtImage,
  resolveMediaBatch,
  skippedImagePlaceholder,
  splicePlaceholders,
} from '../src/media-resolve.ts'
import type { BinaryFetchLike, ImageVisionPort } from '../src/media-resolve.ts'
import { OneBotTransport } from '../src/onebot.ts'
import { attachmentPathFor, createAttachmentReader, sniffImageMime, writeAttachment } from '../src/vision-describer.ts'
import type { InboundMessage } from '../src/transport.ts'
import { defaultConditionOf, defaultScopeOf, TurnRunner } from '../src/turns.ts'
import { seedWakeRules, setWakeRule } from '../src/wake.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-media-'))
const port = 37180
let db: ReturnType<typeof openDatabase>['db']
let close: () => void
let transport: OneBotTransport
let gateway: Gateway
let client: WebSocket
let driver: FakeTurnDriver

/** 假 QQ 端收到的动作。 */
const actions: { action: string; params: Record<string, unknown> }[] = []
/** 视觉端口记录：每次被要求描述哪个附件。 */
const visionCalls: string[] = []
/** 视觉端口的剧本。 */
let visionScript: (attachmentId: string) => { text: string; reused?: boolean; ok?: boolean } = (attachmentId) => ({
  text: `[图片描述]（假视觉）附件 ${attachmentId.slice(0, 20)}…`,
  ok: true,
})
/** 语音转写的剧本（按消息 id）。 */
let pttScript: Record<string, { ok: boolean; text?: string; error?: string }> = {}
/** 文件信息剧本（按 file）。 */
let fileScript: Record<string, { file?: string; url?: string; file_size?: string; file_name?: string } | undefined> = {}
/** 图片下载剧本（按 url）。 */
let imageBytes: Record<string, Uint8Array> = {}
/** 单元测试里那个内联假传输层被调过哪些取回动作。 */
const probeCalls: string[] = []

/** 一张最小的合法 PNG（1x1）—— 让魔数嗅探认得出。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/** 假下载器：按 url 给字节（不联网）。 */
const fakeFetch: BinaryFetchLike = async (url) => {
  const bytes = imageBytes[url]
  if (bytes === undefined) {
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? String(bytes.byteLength) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }
}

const vision: ImageVisionPort = {
  describe: async (attachmentId) => {
    visionCalls.push(attachmentId)
    const scripted = visionScript(attachmentId)
    return { text: scripted.text, reused: scripted.reused === true, calls: scripted.reused === true ? 0 : 1, ok: scripted.ok !== false }
  },
}

before(async () => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
  seedWakeRules(db)
  setWakeRule(db, '*', 'private_message', { enabled: true, probability: 100 }, 'admin')

  driver = new FakeTurnDriver(() => ({ segments: ['ok'], toolCalls: 0 }))
  transport = new OneBotTransport({ port, actionTimeoutMs: 2000 })
  await transport.start()

  const runner = new TurnRunner({ db, driver, scopeOf: defaultScopeOf, conditionOf: defaultConditionOf, random: () => 0, log: () => {} })
  gateway = new Gateway({
    db,
    transport,
    runner,
    debounceMs: 60,
    outboxPollMs: 60,
    log: () => {},
    imageVision: vision,
    imageStorageRoot: join(dir, 'attachments'),
    mediaFetch: fakeFetch,
  })
  gateway.start()

  client = new WebSocket(`ws://127.0.0.1:${String(port)}/`)
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  client.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
    if (typeof parsed.action !== 'string') return
    actions.push({ action: parsed.action, params: parsed.params ?? {} })
    const params = parsed.params ?? {}
    let data: unknown = { message_id: 9000 + actions.length }
    if (parsed.action === 'fetch_ptt_text') {
      const scripted = pttScript[String(params['message_id'] ?? '')]
      if (scripted === undefined) {
        client.send(JSON.stringify({ status: 'failed', retcode: 1400, message: '消息中不包含语音', echo: parsed.echo }))
        return
      }
      if (!scripted.ok) {
        client.send(JSON.stringify({ status: 'failed', retcode: 1400, message: scripted.error ?? '获取语音转文字结果失败', echo: parsed.echo }))
        return
      }
      data = { text: scripted.text ?? '' }
    } else if (parsed.action === 'get_file') {
      const scripted = fileScript[String(params['file'] ?? params['file_id'] ?? '')]
      if (scripted === undefined) {
        client.send(JSON.stringify({ status: 'failed', retcode: 1400, message: 'file not found', echo: parsed.echo }))
        return
      }
      data = scripted
    }
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: parsed.echo }))
  })
  await delay(60)
})

after(async () => {
  await gateway.stop()
  client.close()
  await transport.stop()
  close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 推一条 QQ 消息进来。 */
function pushMessage(messageId: string, message: unknown[], over: Record<string, unknown> = {}): void {
  client.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: 10001,
      self_id: 3112546448,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 10001, nickname: '小满' },
      message,
      ...over,
    }),
  )
}

/** 等某个条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
}

/** 造一条最小入站消息（单元测试用）。 */
function messageOf(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'm1',
    conversation: { platform: 'onebot11', chatId: '10001', kind: 'private' },
    senderId: '10001',
    senderName: '小满',
    text: '看这个[图片]',
    mentionedMe: true,
    mentionedAll: false,
    isPoke: false,
    isSelf: false,
    at: new Date().toISOString(),
    raw: {},
    ...over,
  }
}

// ── 一、预筛（★ "什么图该看"是判断，判断必须被测试钉住）────────────────

test('预筛：私聊里的普通图 ⇒ 看', () => {
  const decision = decideLookAtImage({
    image: { url: 'https://gchat.qpic.cn/x', subType: 0, fileSize: 200_000 },
    isGroup: false,
    mentioned: true,
    enabled: true,
    minBytes: 4096,
    maxBytes: 5_242_880,
    groupNeedsMention: true,
  })
  assert.equal(decision.look, true)
})

test('预筛：动画表情（sub_type=1）不看 —— 这是协议端免费给的判据', () => {
  const decision = decideLookAtImage({
    image: { url: 'https://gchat.qpic.cn/x', subType: 1 },
    isGroup: false,
    mentioned: true,
    enabled: true,
    minBytes: 4096,
    maxBytes: 5_242_880,
    groupNeedsMention: true,
  })
  assert.equal(decision.look, false)
  assert.match(decision.reason, /动画表情/)
})

test('预筛：群里的图且没 @ 我 ⇒ 不看（大群刷图是成本主要来源）', () => {
  const decision = decideLookAtImage({
    image: { url: 'https://gchat.qpic.cn/x' },
    isGroup: true,
    mentioned: false,
    enabled: true,
    minBytes: 4096,
    maxBytes: 5_242_880,
    groupNeedsMention: true,
  })
  assert.equal(decision.look, false)
  assert.match(decision.reason, /没有 @ 我/)
})

test('预筛：非 http(s) 地址（协议端本地路径）不看，且原因说清"我们取不到"', () => {
  const decision = decideLookAtImage({
    image: { url: '/app/napcat/cache/abc.jpg' },
    isGroup: false,
    mentioned: true,
    enabled: true,
    minBytes: 4096,
    maxBytes: 5_242_880,
    groupNeedsMention: true,
  })
  assert.equal(decision.look, false)
  assert.match(decision.reason, /本地路径/)
})

test('预筛：空 url / 关掉总开关 / 太大 / 太小 四种都拦下', () => {
  const base = { isGroup: false, mentioned: true, enabled: true, minBytes: 4096, maxBytes: 5_242_880, groupNeedsMention: true }
  assert.equal(decideLookAtImage({ ...base, image: { url: '' } }).look, false)
  assert.equal(decideLookAtImage({ ...base, enabled: false, image: { url: 'https://x/y' } }).look, false)
  assert.equal(decideLookAtImage({ ...base, image: { url: 'https://x/y', fileSize: 9_000_000 } }).look, false)
  assert.equal(decideLookAtImage({ ...base, image: { url: 'https://x/y', fileSize: 100 } }).look, false)
})

// ── 二、占位符拼接 / 魔数嗅探 / 附件目录 ─────────────────────────────

test('占位符按顺序替换，多余的保持原样（不许把内容吃错位）', () => {
  assert.equal(splicePlaceholders('a[图片]b[图片]c', '[图片]', ['1', '2']), 'a1b2c')
  assert.equal(splicePlaceholders('a[图片]b[图片]c', '[图片]', ['1']), 'a1b[图片]c')
  assert.equal(splicePlaceholders('没有占位符', '[图片]', ['1']), '没有占位符')
})

test('跳过时的占位符**带原因**（模型要知道"我们没看"，而不是以为图是空的）', () => {
  assert.match(skippedImagePlaceholder('群里的图，而这条没有 @ 我'), /未看：群里的图/)
})

test('魔数嗅探：认得出 PNG/JPEG/GIF/WebP，认不出 HTML', () => {
  assert.equal(sniffImageMime(PNG), 'image/png')
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(sniffImageMime(new TextEncoder().encode('<html>404</html>')), undefined)
})

test('附件落盘是内容寻址：同一张图写两次只有一份，且读得回来', () => {
  const root = join(dir, 'store-probe')
  const id = 'sha256:' + 'a'.repeat(64)
  const path = writeAttachment(root, id, PNG)
  assert.equal(path, attachmentPathFor(root, id))
  assert.equal(writeAttachment(root, id, PNG), path)
  const read = createAttachmentReader(root)(id)
  assert.equal(read?.mime, 'image/png')
  assert.equal(read?.bytes.byteLength, PNG.byteLength)
  assert.equal(createAttachmentReader(root)('sha256:' + 'b'.repeat(64)), undefined)
})

test('下载器：HTTP 非 2xx / 空响应 / 声明超限都要明确失败（不是静默空图）', async () => {
  const download = createImageDownloader({ fetchImpl: fakeFetch, timeoutMs: 1000, maxBytes: 10 })
  assert.equal((await download('https://missing')).ok, false)
  assert.match((await download('https://missing')).error ?? '', /404/)
  const big = createImageDownloader({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '999999' },
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
    timeoutMs: 1000,
    maxBytes: 10,
  })
  assert.match((await big('https://x')).error ?? '', /声明大小超限/)
})

// ── 三、批量解析：图片 / 语音 / 文件 三种降级都可见 ────────────────────

test('★★ 三种媒体的成功与失败：成功进正文，失败留**带原因**的占位符', async () => {
  const root = join(dir, 'batch')
  imageBytes = { 'https://img/ok.png': PNG }
  pttScript = { v1: { ok: true, text: '明天九点体检' }, v2: { ok: false, error: '消息中不包含语音' } }
  fileScript = { '报告.pdf': { file: '/app/napcat/cache/report.pdf', url: '/app/napcat/cache/report.pdf', file_size: '123456', file_name: '报告.pdf' } }

  const result = await resolveMediaBatch(
    [
      messageOf({ messageId: 'i1', text: '看这个[图片]', images: [{ url: 'https://img/ok.png', subType: 0, fileSize: 200_000 }] }),
      messageOf({ messageId: 'i2', text: '这张没了[图片]', images: [{ url: 'https://img/gone.png', subType: 0 }] }),
      messageOf({ messageId: 'v1', text: '[语音]', hasVoice: true }),
      messageOf({ messageId: 'v2', text: '[语音]', hasVoice: true }),
      messageOf({ messageId: 'f1', text: '发你[文件]', files: [{ fileName: '报告.pdf', fileId: 'uuid-1', fileSize: 123456 }] }),
    ],
    {
      db,
      transport: {
        fetchPttText: async (id) => {
          probeCalls.push(`fetch_ptt_text:${id}`)
          return pttScript[id] ?? { ok: false, error: '没有剧本' }
        },
        getFileInfo: async (input) => {
          probeCalls.push(`get_file:${input.file ?? input.fileId ?? ''}`)
          return fileScript[input.file ?? ''] ?? undefined
        },
      },
      vision,
      storageRoot: root,
      fetchImpl: fakeFetch,
      overrides: { budgetMs: 60_000 },
    },
  )

  const texts = result.messages.map((m) => m.text)
  // ① 图片：真的走了视觉端口，描述进了正文
  assert.match(texts[0] ?? '', /\[图片描述\]（假视觉）/)
  assert.equal(visionCalls.length, 1)
  assert.match(visionCalls[0] ?? '', /^sha256:[0-9a-f]{64}$/)
  // ② 图片取不回：**看得见的失败**
  assert.match(texts[1] ?? '', /\[图片（没能取回：HTTP 404）\]/)
  // ③ 语音转写成功 / 失败
  assert.match(texts[2] ?? '', /\[语音转写\]明天九点体检/)
  assert.match(texts[3] ?? '', /\[语音（转写失败：消息中不包含语音）\]/)
  // ④ 文件：真调了 get_file，并**如实**说明内容在协议端本地
  assert.match(texts[4] ?? '', /\[文件：报告\.pdf（121KB，内容在协议端本地/)
  // 取回动作**真的被调用过**（而不是只算了个统计）
  assert.ok(probeCalls.includes('fetch_ptt_text:v1'), `语音转写没被调用：${probeCalls.join('、')}`)
  assert.ok(probeCalls.includes('get_file:报告.pdf'), `get_file 没被调用：${probeCalls.join('、')}`)
  // ⑤ 统计对得上
  assert.equal(result.stats.imagesLooked, 1)
  assert.equal(result.stats.imagesFailed, 1)
  assert.equal(result.stats.voiceTranscribed, 1)
  assert.equal(result.stats.voiceFailed, 1)
  assert.equal(result.stats.filesFetched, 1)
})

test('图片缓存复用：同一张图第二次不新调视觉（端口报 reused）', async () => {
  const root = join(dir, 'reuse')
  imageBytes = { 'https://img/same.png': PNG }
  visionScript = (attachmentId) => ({ text: `[图片描述]缓存复用 ${attachmentId.slice(0, 14)}…`, reused: true })
  const before = visionCalls.length
  const result = await resolveMediaBatch([messageOf({ text: '[图片]', images: [{ url: 'https://img/same.png' }] })], {
    db,
    transport: { fetchPttText: async () => ({ ok: false }), getFileInfo: async () => undefined },
    vision,
    storageRoot: root,
    fetchImpl: fakeFetch,
  })
  assert.equal(visionCalls.length, before + 1, '端口仍会被问一次（缓存判定在桥接里），但标记为 reused')
  assert.match(result.messages[0]?.text ?? '', /缓存复用/)
  assert.equal(result.stats.imagesReused, 1)
  assert.equal(result.stats.imagesLooked, 0)
  visionScript = (attachmentId) => ({ text: `[图片描述]（假视觉）附件 ${attachmentId.slice(0, 20)}…`, ok: true })
})

test('预算：一批里超过 qq.image.resolvePerBatch 的图保留**带原因**的占位符', async () => {
  const root = join(dir, 'budget')
  imageBytes = { 'https://img/a.png': PNG, 'https://img/b.png': PNG, 'https://img/c.png': PNG }
  const result = await resolveMediaBatch(
    [
      messageOf({
        text: '[图片][图片][图片]',
        images: [{ url: 'https://img/a.png' }, { url: 'https://img/b.png' }, { url: 'https://img/c.png' }],
      }),
    ],
    {
      db,
      transport: { fetchPttText: async () => ({ ok: false }), getFileInfo: async () => undefined },
      vision,
      storageRoot: root,
      fetchImpl: fakeFetch,
      overrides: { perBatch: 2 },
    },
  )
  const text = result.messages[0]?.text ?? ''
  assert.equal(result.stats.imagesLooked + result.stats.imagesReused, 2)
  assert.match(text, /数量用完了/)
})

test('没有视觉端口时：仍然给出**看得见的**占位符（而不是留空）', async () => {
  const root = join(dir, 'novision')
  imageBytes = { 'https://img/ok.png': PNG }
  const result = await resolveMediaBatch([messageOf({ text: '[图片]', images: [{ url: 'https://img/ok.png' }] })], {
    db,
    transport: { fetchPttText: async () => ({ ok: false }), getFileInfo: async () => undefined },
    storageRoot: root,
    fetchImpl: fakeFetch,
  })
  assert.match(result.messages[0]?.text ?? '', /图片未能描述：没有可用的视觉模型/)
})

test('大文件不主动 get_file（协议端会真的去下载），但名字与大小如实写上', async () => {
  const root = join(dir, 'bigfile')
  fileScript = {}
  const result = await resolveMediaBatch(
    [messageOf({ text: '[文件]', files: [{ fileName: '大包.zip', fileSize: 900 * 1024 * 1024 }] })],
    {
      db,
      transport: { fetchPttText: async () => ({ ok: false }), getFileInfo: async () => undefined },
      storageRoot: root,
      fetchImpl: fakeFetch,
      overrides: { fileMaxBytes: 1024 },
    },
  )
  assert.match(result.messages[0]?.text ?? '', /\[文件：大包\.zip（900\.0MB，太大不自动取/)
  assert.equal(result.stats.filesFetched, 0)
})

// ── 四、★★ 端到端：真链路 ⇒ 模型在提示词里读到描述 ───────────────────────

test('★★ 端到端：她发「图片 + 语音」⇒ 模型在提示词里读到图片描述与语音转写', async () => {
  imageBytes['https://cdn.test/health.png'] = PNG
  pttScript['e2e-1'] = { ok: true, text: '帮我看下这个体检报告' }
  const beforeRequests = driver.requests.length
  pushMessage('e2e-1', [
    { type: 'text', data: { text: '你看下这个' } },
    { type: 'image', data: { url: 'https://cdn.test/health.png', sub_type: 0, file_size: '20480' } },
    { type: 'record', data: { file: 'x.silk', url: '' } },
  ])
  await waitFor(() => driver.requests.length > beforeRequests)
  const prompt = driver.requests[beforeRequests]?.prompt ?? ''
  assert.match(prompt, /图片描述/, '★ 图片描述必须真的进提示词')
  assert.match(prompt, /\[语音转写\]帮我看下这个体检报告/, '★ 语音转写必须真的进提示词')
  // 库里的那一行也要被回填（面板 / 待读池读的是它）
  const row = db.prepare('SELECT text FROM qq_inbox WHERE id = ?').get('e2e-1') as { text: string } | undefined
  assert.match(row?.text ?? '', /图片描述/)
  assert.match(row?.text ?? '', /语音转写/)
})

test('★★ 端到端：群里的图**没 @ 我** ⇒ 不调视觉，但提示词里留下"未看"的原因', async () => {
  const beforeRequests = driver.requests.length
  const beforeCalls = visionCalls.length
  pushMessage(
    'e2e-2',
    [{ type: 'image', data: { url: 'https://cdn.test/group.png', sub_type: 0 } }],
    { message_type: 'group', group_id: 88888, group_name: '测试群', sender: { user_id: 10002, nickname: '路人', card: '', role: 'member' } },
  )
  await waitFor(() => driver.requests.length > beforeRequests)
  const prompt = driver.requests[beforeRequests]?.prompt ?? ''
  assert.equal(visionCalls.length, beforeCalls, '不该为"没 @ 我的群图"花钱')
  assert.match(prompt, /未看：群里的图/)
})

test('★★ 端到端：群名与群身份入库（P2-c）—— qq_sessions.title 不再是 NULL', async () => {
  const row = db.prepare('SELECT title, kind FROM qq_sessions WHERE conversation_key = ?').get('onebot11:88888') as
    | { title: string | null; kind: string }
    | undefined
  assert.equal(row?.kind, 'group')
  assert.equal(row?.title, '测试群')
})

test('★★ 端到端：收到文件 ⇒ 真的调了 get_file（P2-b），并在提示词里如实说明内容在协议端', async () => {
  fileScript['体检报告.pdf'] = {
    file: '/app/napcat/cache/abc.pdf',
    url: '/app/napcat/cache/abc.pdf',
    file_size: '52341',
    file_name: '体检报告.pdf',
  }
  const beforeRequests = driver.requests.length
  const beforeActions = actions.filter((a) => a.action === 'get_file').length
  pushMessage('e2e-3', [{ type: 'text', data: { text: '发你' } }, { type: 'file', data: { file: '体检报告.pdf', file_id: 'uuid-9', file_size: '52341' } }])
  await waitFor(() => driver.requests.length > beforeRequests)
  await waitFor(() => actions.filter((a) => a.action === 'get_file').length > beforeActions)
  const prompt = driver.requests[beforeRequests]?.prompt ?? ''
  assert.match(prompt, /\[文件：体检报告\.pdf（51KB，内容在协议端本地/)
  assert.ok(
    actions.some((a) => a.action === 'get_file' && (a.params['file'] === '体检报告.pdf' || a.params['file_id'] === 'uuid-9')),
    '必须真的发过 get_file 动作',
  )
})
