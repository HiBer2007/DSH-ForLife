/**
 * ★ P2-d 出站补齐（图片 / 文件 / 撤回）+ P1-1/P1-2/P2-b 的**接线守卫**。
 *
 * ## 为什么这个文件一半是"守卫"而不是"行为"
 *
 * 本项目栽过 20+ 次"写好了但零调用"（最近一次就是 `VisionBridge` 本身：
 * 能缓存能复核，全仓只被自己的测试引用）。而 P2-d 的缺口正好是同一类：
 * `kind:'image' | 'file' | 'delete'` 早就在 `OutboundKind` 里、`toOneBotSegments`
 * 也早就映射好了 —— **缺的只是入队点**。
 * ⇒ 所以这里既测"工具真的入队了"，也**读源码**断言：
 *   - 三个工具都走**同一个** `sendGate()`（不许另开一条绕过限流的路）；
 *   - `sendGate()` 在 `enqueueOutbound()` **之前**（放后面等于没拦）；
 *   - 网关主循环里媒体解析的**结果被用**（`handleBatch(withMedia…)`）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { defaultFor } from '@forlife/contracts'
import { seedBacklogWakeRule, seedWakeRules } from '@forlife/gateway'
import { openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { buildQqTools } from '../src/qq-tools.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-qqmedia-'))
let runtime: MemoryRuntime

before(() => {
  const opened = openDatabase({ file: join(dir, 'seed.sqlite') })
  seedWakeRules(opened.db)
  opened.close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir, contextWindowTokens: 8000 }), dbPath: join(dir, 'forlife.sqlite') })
  seedWakeRules(runtime.db)
  seedBacklogWakeRule(runtime.db)
  runtime.db
    .prepare(
      `INSERT INTO qq_sessions (conversation_key, platform, chat_id, thread_id, kind, title, last_message_at, last_read_at, created_at)
       VALUES ('onebot11:88888', 'onebot11', '88888', NULL, 'group', '测试群', NULL, NULL, ?)
       ON CONFLICT(conversation_key) DO NOTHING`,
    )
    .run(new Date().toISOString())
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

const TEST_CONFIRM_TIMEOUT_MS = 120

function tool(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildQqTools(defineTool as never, runtime, { confirmTimeoutMs: TEST_CONFIRM_TIMEOUT_MS }) as unknown as {
    name: string
    execute(args: unknown, exec: unknown): Promise<unknown>
  }[]
  const found = tools.find((t) => t.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

const exec = { callId: 'c1', signal: new AbortController().signal }

/** 取最近一行出站（按入队时间倒序）。 */
function lastOutbound(): { kind: string; payload: string; conversation_key: string; conversation_kind: string } | undefined {
  return runtime.db.prepare('SELECT kind, payload, conversation_key, conversation_kind FROM qq_outbox ORDER BY sent_at DESC, rowid DESC LIMIT 1').get() as
    | { kind: string; payload: string; conversation_key: string; conversation_kind: string }
    | undefined
}

function outboxCount(): number {
  return (runtime.db.prepare('SELECT count(*) AS n FROM qq_outbox').get() as { n: number }).n
}

/** 把发送额度吃满（用**真的会发东西**的 kind，免得被"只读查询不计额度"的新规则放过）。 */
function fillSendQuota(): void {
  const burstMax = defaultFor<number>('qq.send.burstMax')
  const now = new Date().toISOString()
  for (let i = 0; i < burstMax + 1; i += 1) {
    runtime.db
      .prepare(
        `INSERT INTO qq_outbox (id, conversation_key, platform_msg_id, kind, payload, sent_at, confirmed, confirmed_at, error, status, claimed_at, attempt, source, conversation_kind)
         VALUES (?, 'onebot11:88888', NULL, 'text', '{"segments":[]}', ?, 1, ?, NULL, 'sent', NULL, 0, 'model', 'group')`,
      )
      .run(`fill_${String(i)}_${String(Date.now())}`, now, now)
  }
}

/** 从源码里去掉注释 —— **注释不算接线**（本仓的铁律）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function src(relative: string): string {
  return stripComments(readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8'))
}

function gatewaySrc(relative: string): string {
  return stripComments(readFileSync(new URL(`../../gateway/src/${relative}`, import.meta.url), 'utf8'))
}

// ── 一、行为：三个工具真的入队，且 kind 正确 ─────────────────────────────

test('★★ qq_send_image：入队 kind=image 且段是 {kind:image,file}', async () => {
  const result = (await tool('qq_send_image').execute(
    { conversation: 'onebot11:88888', file: 'https://cdn.test/cat.png' },
    exec,
  )) as { ok: boolean; outboxId: string; confirmed: boolean }
  assert.equal(result.ok, true)
  const row = lastOutbound()
  assert.equal(row?.kind, 'image')
  assert.equal(row?.conversation_kind, 'group', '会话类型必须从 qq_sessions 查（猜错会把群消息发成私聊）')
  const payload = JSON.parse(row?.payload ?? '{}') as { segments?: { kind: string; file: string }[] }
  assert.deepEqual(payload.segments, [{ kind: 'image', file: 'https://cdn.test/cat.png' }])
})

test('★★ qq_send_file：入队 kind=file 且带 name', async () => {
  const result = (await tool('qq_send_file').execute(
    { conversation: 'onebot11:88888', file: 'https://cdn.test/report.pdf', name: '报告.pdf' },
    exec,
  )) as { ok: boolean }
  assert.equal(result.ok, true)
  const row = lastOutbound()
  assert.equal(row?.kind, 'file')
  const payload = JSON.parse(row?.payload ?? '{}') as { segments?: { kind: string; file: string; name?: string }[] }
  assert.deepEqual(payload.segments, [{ kind: 'file', file: 'https://cdn.test/report.pdf', name: '报告.pdf' }])
})

test('★★ qq_recall：入队 kind=delete（**死代码接上了**），不给会话也能撤（按 message_id 生效）', async () => {
  const result = (await tool('qq_recall').execute({ message_id: '1956236413' }, exec)) as { ok: boolean }
  assert.equal(result.ok, true)
  const row = lastOutbound()
  assert.equal(row?.kind, 'delete')
  assert.equal(row?.conversation_key, 'onebot11:0', '只做记账用的占位键')
  assert.equal(JSON.parse(row?.payload ?? '{}').messageId, '1956236413')
})

test('qq_recall：空 message_id 不入队（如实拒绝，而不是发一个空动作）', async () => {
  const before = outboxCount()
  const result = (await tool('qq_recall').execute({ message_id: '   ' }, exec)) as { ok: boolean; hint: string }
  assert.equal(result.ok, false)
  assert.match(result.hint, /message_id 不能为空/)
  assert.equal(outboxCount(), before)
})

// ── 二、★ 不许绕过限流：三个工具共用同一个入队前闸门 ──────────────────────

test('★★★ 限流：额度吃满后三个出站工具**都**被拦下，且队列里不多一行', async () => {
  fillSendQuota()
  const before = outboxCount()
  const image = (await tool('qq_send_image').execute({ conversation: 'onebot11:88888', file: 'https://x/y.png' }, exec)) as {
    ok: boolean
    throttled?: boolean
  }
  const file = (await tool('qq_send_file').execute({ conversation: 'onebot11:88888', file: 'https://x/y.pdf' }, exec)) as {
    ok: boolean
    throttled?: boolean
  }
  const recall = (await tool('qq_recall').execute({ message_id: '123' }, exec)) as { ok: boolean; throttled?: boolean }
  assert.equal(image.throttled, true, '发图片必须被同一套速率闸门拦住')
  assert.equal(file.throttled, true, '发文件必须被同一套速率闸门拦住')
  assert.equal(recall.throttled, true, '撤回也必须被同一套速率闸门拦住')
  assert.equal(outboxCount(), before, '★ 被拦下时**队列里不能多出任何一行**（拦在入队之前）')
})

// ── 三、接线守卫（读源码 · 去注释 · 语句位置 · 断言结果被用）──────────────

test('★★ 接线守卫：三个工具都走同一个 sendGate()，且**在 enqueueOutbound 之前**', () => {
  const body = src('qq-tools.ts')
  for (const toolName of ['qq_send_image', 'qq_send_file', 'qq_recall']) {
    const start = body.indexOf(`name: '${toolName}'`)
    assert.ok(start > 0, `${toolName} 必须在源码里`)
    // 工具的 execute 到下一个工具定义之间
    const rest = body.slice(start)
    const gateAt = rest.indexOf('sendGate()')
    const enqueueAt = rest.indexOf('enqueueOutbound(')
    assert.ok(gateAt > 0, `${toolName} 必须走 sendGate()`)
    assert.ok(enqueueAt > 0, `${toolName} 必须真的入队`)
    assert.ok(gateAt < enqueueAt, `★ ${toolName} 的闸门必须在入队**之前**（放后面等于没拦）`)
    assert.match(rest, /if \(gate !== undefined\)/, `${toolName} 必须**用**闸门的结果`)
  }
  // 三个 kind 必须都真的有入队点（审计 §6.1 数出来的三个零入队点）
  assert.match(body, /kind: 'image'/)
  assert.match(body, /kind: 'file'/)
  assert.match(body, /kind: 'delete'/)
})

test('★★ 接线守卫：媒体解析的**结果被用** —— 交给轮次的是补过内容的那一批', () => {
  const body = gatewaySrc('gateway.ts')
  // 顺序：先取回转发 → 再处理媒体 → 才 handleBatch
  const forwardAt = body.indexOf('await this.resolveForwards(messages)')
  const mediaAt = body.indexOf('await this.resolveMedia(enriched)')
  const handleAt = body.indexOf('this.options.runner.handleBatch(withMedia')
  assert.ok(forwardAt > 0 && mediaAt > 0 && handleAt > 0, '三步都必须真的存在')
  assert.ok(forwardAt < mediaAt, '合并转发先展开（合转正文里也可能有 [图片]）')
  assert.ok(mediaAt < handleAt, '★ 媒体处理必须在交给模型**之前**')
  // `resolveMediaBatch` 的返回值必须被用（`result.messages` 才是补过文本的那一批）
  assert.match(body, /const result = await resolveMediaBatch\(/)
  assert.match(body, /return result\.messages/)
  // 回填库里那一行（面板 / 待读池读的是 qq_inbox.text）
  assert.match(body, /UPDATE qq_inbox SET text = \? WHERE id = \?/)
})

test('★★ 接线守卫：网关侧真的把 images/files/hasVoice 抽出来了（抽不出就等于没接）', () => {
  const body = gatewaySrc('onebot.ts')
  assert.match(body, /images\.push\(\{/, '必须收集图片引用')
  assert.match(body, /files\.push\(\{/, '必须收集文件引用')
  assert.match(body, /hasVoice = true/, '必须标记语音')
  assert.match(body, /images\.length === 0 \? \{\} : \{ images \}/, '必须挂到入站消息上')
  assert.match(body, /callAction<\{ text\?: string \}>\('fetch_ptt_text'/, 'P1-2：必须真的调 fetch_ptt_text')
  assert.match(body, /callAction<[^>]*>\('get_file'/, 'P2-b：必须真的调 get_file')
  // 群名 / 群身份（P2-c）
  assert.match(body, /senderRecord\['role'\]/, '必须取 sender.role')
  assert.match(body, /record\['group_name'\]/, '必须取 group_name')
  const gatewayBody = gatewaySrc('gateway.ts')
  assert.match(gatewayBody, /sessionTitleOf\(message\)/, 'title 必须真的写进 qq_sessions')
  assert.match(gatewayBody, /COALESCE\(excluded\.title, qq_sessions\.title\)/, '没有标题时不许把已有标题擦成 NULL')
})

test('★★ 接线守卫：两条装配路径都造了视觉桥接（否则"本地能看图、线上看不见"）', () => {
  const runtimeBody = gatewaySrc('runtime.ts')
  assert.match(runtimeBody, /createVisionFromEnv\(\{ db: options\.db, storageRoot: attachmentRoot/, '生产路径必须装配')
  assert.match(runtimeBody, /imageVision: visionWiring\.vision/, '生产路径必须把它交给网关')
  assert.match(runtimeBody, /imageStorageRoot: attachmentRoot/, '生产路径必须给附件目录')
  const pluginBody = src('gateway-plugin.ts')
  assert.match(pluginBody, /createVisionFromEnv\(\{/, '开发路径必须装配')
  assert.match(pluginBody, /imageVision: visionWiring\.vision/, '开发路径必须把它交给网关')
})

test('★★ 接线守卫：`VisionBridge` **只有一份实现**（旧路径只是再导出）', () => {
  const shim = src('vision-bridge.ts')
  assert.match(shim, /from '@forlife\/gateway'/, '旧路径必须是从网关再导出')
  assert.ok(!/class VisionBridge/.test(shim), '★ 不许留第二份实现（两份必然漂移）')
  const moved = gatewaySrc('vision-bridge.ts')
  assert.match(moved, /export class VisionBridge/, '实现必须在网关侧')
  // 搬过去的理由：网关不能反向依赖 DSH 组件
  assert.ok(!/@forlife\/memory|dsh-component/.test(moved), '网关侧实现不许依赖 DSH 组件')
})

test('★★ 接线守卫：两个方向的限流都**不看只读查询**（审计 §10.6 那一条）', () => {
  const body = gatewaySrc('limits.ts')
  assert.match(body, /export const NON_SENDING_OUTBOUND_KINDS = \['probe'\]/, '必须显式声明"不产生平台动作"的种类')
  const uses = body.match(/kind NOT IN \(\$\{NON_SENDING_SQL\}\)/g) ?? []
  assert.equal(uses.length, 2, '发送额度计数与投递节拍**两处**都要剔除只读查询')
})

test('★★ 接线守卫：probe 结果键用完**真的删行**（审计 §10.8 的垃圾行）', () => {
  const body = gatewaySrc('probe.ts')
  assert.match(body, /deleteState\(db, probeStateKey\(outboxId\)\)/, '必须真的删')
  assert.ok(!/setState\(db, probeStateKey\(outboxId\), ''\)/.test(body), '不许再写空串留垃圾行')
})
