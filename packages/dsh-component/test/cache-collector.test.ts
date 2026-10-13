/**
 * 缓存采集器的测试 —— **喂宿主的真实形状**，并守卫"测试形状 = 宿主形状"。
 *
 * ## 这个文件为什么重写过
 *
 * 旧版测试喂的是**平铺形状**（`{ type, usage }`），而宿主的 `session/event` 给的是
 * **信封** `{ type, seq, time, data }`（载荷在 `data` 里）。
 * 于是测试证明了"函数能解析它**以为**的形状"，而那个形状在生产里**不存在** ——
 * `cache_metrics` 表永远是空的，测试却全绿。
 * 这正是 `docs/audit/PLAN_FIDELITY_AUDIT.md` §7.3 说的病：
 * **单元测试抓不到"接线/形状对不对"，它只抓得到"函数对自己以为的形状是否正确"。**
 *
 * ## 所以这里有两层守卫
 *
 *  ① **源码守卫**：直接读 `node_modules` 里的宿主源码，断言
 *    "信封是 `{type, seq, time, data}`"、"`usage` 在 `append()` 的第二个参数里"、
 *    "第一方消费者读 `event.data.*`" —— 宿主换形状时，**这里先红**；
 *  ② **形状守卫**：断言测试 helper 造的信封 key 与宿主源码里的 key **逐字相同**，
 *    并断言"顶层平铺的 `usage` 不再被接受"（旧 bug 的想象形状必须取不到）。
 *
 * 采集这一层最容易出的问题是**静默失效**：宿主换了事件形状，我们取不到用量，
 * 于是面板上永远是"还没有数据"，而没人知道是"没跑过"还是"取不到"。
 * 所以这里既测"能取到"，也测"取不到时不写垃圾行、且形状变化可被发现"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { summarizeCache } from '@forlife/memory-core'
import { listCacheUsage, openDatabase, recordCacheUsage } from '@forlife/store'

import { collectPrefixChanges, collectUsageFromEvent, extractUsage, isUsageEvent } from '../src/cache-collector.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-collect-'))
let db: ReturnType<typeof openDatabase>['db']
let close: () => void

before(() => {
  const opened = openDatabase({ file: join(dir, 'forlife.sqlite') })
  db = opened.db
  close = opened.close
})

after(async () => {
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

// ── 宿主源码（形状守卫读的就是它）─────────────────────────────────────────────

/** 宿主源码路径（相对本文件）。 */
const HOST = {
  /** `Session.append()` 的组装点：信封就是在这里定型的。 */
  session: '../../../node_modules/@deepseek-ai/dsh-session/lib/index.js',
  /** `SessionEventMap`：每种事件的 `data` 载荷长什么样。 */
  sessionTypes: '../../../node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts',
  /** `agent-loop`：把 `usage` 放进 `append()` 的第二个参数。 */
  loop: '../../../node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
  /** 第一方消费者：权威的"怎么读用量"。 */
  tokenMeter: '../../../node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js',
  /** 宿主自己的 stream 扫描实现（我们的 `usageFromStream()` 是它的等价物）。 */
  llmStream: '../../../node_modules/@deepseek-ai/dsh-llm/lib/types/assistant-stream.js',
} as const

/** 读宿主源码，**按行**返回（先归一换行 —— CRLF 会让含 `\n` 的匹配永远失败）。 */
function hostLines(rel: string): readonly string[] {
  return readFileSync(new URL(rel, import.meta.url), 'utf8').split(/\r?\n/)
}

/** 从 `start` 的下一行起，取到第一个"行尾是 `};`"的块（按行取，不写多行正则）。 */
function blockAfter(lines: readonly string[], start: number): readonly string[] {
  const block: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trimEnd().endsWith('};')) break
    block.push(line.trim())
  }
  return block
}

// ── 宿主真实形状 ────────────────────────────────────────────────────────────

/**
 * 宿主真实形状：`{type, seq, time, data}` —— **载荷在 `data` 里**（不是平铺在顶层）。
 * 这个 helper 的 key 由守卫测试与宿主源码逐字比对。
 */
function sessionEvent(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq: 1, time: Date.now(), data, ...extra }
}

/** 一次助手结算事件的 `data`（字段与宿主 `SessionEventMap` 一致）。 */
function assistantData(
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [] },
    stream: [],
    ...(usage === undefined ? {} : { usage }),
    ...extra,
  }
}

/** 一条 `assistant/message` 事件（真形状）。 */
function assistantEvent(
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
  envelopeExtra: Record<string, unknown> = {},
): Record<string, unknown> {
  return sessionEvent('assistant/message', assistantData(usage, extra), envelopeExtra)
}

/** 一条 `usage` chunk 的 stream 记录（宿主 `AssistantStreamRecord` 的 `chunk` 形态）。 */
function usageChunk(usage: Record<string, unknown>): Record<string, unknown> {
  return { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }
}

// ════════════════════════════════════════════════════════════════════════════
// ① 形状守卫：测试形状必须**等于**宿主形状（不是我们以为的形状）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 形状守卫：宿主信封就是 `{type, seq, time, data}`，且测试 helper 与它逐字一致', () => {
  const lines = hostLines(HOST.session)
  const start = lines.findIndex((line) => line.includes('const event = deepFreeze({'))
  assert.ok(start > 0, '找不到宿主 `Session.append()` 的组装点 —— 宿主换实现了吗？（先看这里再改实现）')

  const block = blockAfter(lines, start)
  const keys = block
    .map((line) => /^([A-Za-z]+)\s*[,:]/u.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)

  assert.deepEqual([...keys], ['type', 'seq', 'time', 'data'], '宿主信封的字段就是这四个，`data` 才是载荷')
  assert.ok(
    block.some((line) => line.startsWith('data:')),
    '`data` 必须是信封里的字段 —— 顶层平铺的 `usage` 在宿主的 `append()` 里根本无处安放',
  )

  // ★ 这一条才是"形状守卫"的核心：**测试喂的形状 == 宿主产出的形状**
  assert.deepEqual(
    Object.keys(sessionEvent('assistant/message', {})),
    [...keys],
    '测试 helper 造的信封必须与宿主源码里的字段**逐字相同**（否则测试又在证明想象形状）',
  )
})

test('★★ 形状守卫：每一次 `session.append("assistant/message")` 都把 `usage` 放在**第二个参数**里', () => {
  const lines = hostLines(HOST.loop)
  // 宿主有两个提交点：正常结算、以及被取消时的 `interrupted: true` 结算 —— 两个都要守
  const sites = lines
    .map((line, index) => (line.includes('this.session.append("assistant/message", {') ? index : -1))
    .filter((index) => index >= 0)
  assert.ok(sites.length > 0, '找不到 `agent-loop` 提交 `assistant/message` 的 `append()`')

  for (const start of sites) {
    const where = `第 ${start + 1} 行的 append()`
    const body = lines.slice(start, start + 20).join('\n')
    for (const field of ['turn,', 'step,', 'stream: live.stream']) {
      assert.ok(body.includes(field), `${where}：\`data\` 里应当有 \`${field}\`（宿主 \`SessionEventMap\` 的形状）`)
    }
    assert.match(body, /usage: live\.usage/u, `${where}：\`usage\` 必须是 \`append(type, data)\` 里 \`data\` 的字段`)

    // 顺序保证：`usage` 出现在第二个参数的对象里（在 `}, { surfaceOp ...` 之前）
    const usageAt = body.indexOf('usage: live.usage')
    const argsSplitAt = body.indexOf('}, {')
    assert.ok(argsSplitAt < 0 || usageAt < argsSplitAt, `${where}：\`usage\` 不能跑到第三个参数（surface metadata）里去`)
  }
})

test('★★ 形状守卫：第一方消费者读的就是 `event.data.usage` / `event.data.stream`', () => {
  const src = hostLines(HOST.tokenMeter).join('\n')
  assert.match(
    src,
    /event\.type === 'assistant\/message' && event\.data\.usage !== undefined/u,
    '宿主自己的 token 计量读 `event.data.usage` —— 我们曾经读 `event.usage`（顶层），那是想象出来的层级',
  )
  assert.match(
    src,
    /lastAssistantStreamChunk\(event\.data\.stream, 'usage'\)\?\.usage/u,
    '拿不到 `data.usage` 时宿主退化到 `data.stream` —— 我们的退化路径必须同口径',
  )

  // 我们的 `usageFromStream()` 是宿主这个 helper 的等价物（本地实现，避免依赖未声明的包）：
  // 倒着扫、认 `record.type === 'chunk'` 且 `record.chunk.type === 'usage'`。
  const streamLines = hostLines(HOST.llmStream)
  const helperAt = streamLines.findIndex((line) => line.includes('export function lastAssistantStreamChunk(stream, type) {'))
  assert.ok(helperAt > 0, '找不到宿主的 `lastAssistantStreamChunk()` —— 退化路径的口径要重新核实')
  const helper = streamLines.slice(helperAt, helperAt + 7).join('\n')
  assert.ok(helper.includes('stream.length - 1'), '宿主是**倒着扫**（取最后一条）—— 我们取"最后一条"必须一致')
  assert.match(helper, /record\.type === 'chunk' && record\.chunk\.type === type/u, '宿主只认 `chunk` 记录里的同名 chunk')
})

test('★ 形状守卫：`assistant/message` 的载荷有 `usage?`；`assistant/attempt` 没有（它的账只在 stream 里）', () => {
  const lines = hostLines(HOST.sessionTypes)

  const messageAt = lines.findIndex((line) => line.includes("'assistant/message': {"))
  assert.ok(messageAt > 0, '找不到 `SessionEventMap` 里的 `assistant/message`')
  assert.match(blockAfter(lines, messageAt).join('\n'), /usage\?: TokenUsage/u, '主路径：`data.usage`')

  const attemptAt = lines.findIndex((line) => line.includes("'assistant/attempt': {"))
  assert.ok(attemptAt > 0, '找不到 `SessionEventMap` 里的 `assistant/attempt`')
  const attempt = blockAfter(lines, attemptAt).join('\n')
  assert.ok(attempt.includes('stream'), '`assistant/attempt` 的账在 `stream` 里')
  assert.ok(
    !attempt.includes('usage'),
    '宿主若给 `assistant/attempt` 加了 `usage` 字段，退化顺序要跟着改 —— 这条断言就是为了先红',
  )
})

test('★ 形状守卫：顶层平铺的 `usage`（旧 bug 的想象形状）**不再被接受**', () => {
  // 修复前就是这个形状喂绿了全部测试、而生产一条都记不上。
  // 现在**故意**不兼容它：宽容地接受想象形状，正是这个 bug 能活下来的原因。
  assert.equal(
    extractUsage({ type: 'assistant/message', turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 1 } }),
    undefined,
    '顶层 `usage` 取不到（宿主的载荷在 `data` 里）',
  )
  assert.equal(
    extractUsage({ type: 'assistant/message', message: { role: 'assistant', usage: { inputTokens: 42, outputTokens: 1 } } }),
    undefined,
    '`message.usage` 也是想象形状：宿主 `AssistantMessage` 里**没有** `usage` 字段',
  )
  // 类型判定本身仍按类型走（能不能取到账由 `extractUsage` 决定）
  assert.equal(isUsageEvent({ type: 'assistant/message' }), true)
  assert.equal(isUsageEvent({ type: 'assistant/message', usage: { inputTokens: 1 } }), true)
})

// ════════════════════════════════════════════════════════════════════════════
// ② 抽取：真形状下的取数
// ════════════════════════════════════════════════════════════════════════════

test('事件判定：只认助手结算事件', () => {
  assert.equal(isUsageEvent(sessionEvent('assistant/message', assistantData({ inputTokens: 1 }))), true)
  assert.equal(isUsageEvent(sessionEvent('assistant/attempt', { turn: 1, step: 0, stream: [] })), true)
  assert.equal(isUsageEvent(sessionEvent('tool/result', {})), false)
  assert.equal(isUsageEvent(sessionEvent('message', {})), false)
  assert.equal(isUsageEvent(null), false)
  assert.equal(isUsageEvent('字符串'), false)
})

test('抽取：四类 token 都拿到，turn/step 从 `data` 里带出来', () => {
  const extracted = extractUsage(
    assistantEvent(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 50, reasoningTokens: 5 },
      { turn: 3, step: 2 },
    ),
    'sess_1',
  )
  assert.ok(extracted !== undefined)
  assert.equal(extracted.usage.inputTokens, 100)
  assert.equal(extracted.usage.cacheReadTokens, 800)
  assert.equal(extracted.usage.cacheWriteTokens, 50)
  assert.equal(extracted.usage.reasoningTokens, 5)
  assert.equal(extracted.usage.turn, 3, '`turn` 在 `data` 里（顶层没有）')
  assert.equal(extracted.usage.step, 2, '`step` 在 `data` 里（顶层没有）')
  assert.equal(extracted.sessionId, 'sess_1')
  assert.equal(typeof extracted.usage.at, 'string')
})

test('抽取：`at` 用**宿主信封的 `time`**（事件发生时刻），不是"我们处理的时刻"', () => {
  const time = Date.parse('2026-01-02T03:04:05.006Z')
  const extracted = extractUsage(assistantEvent({ inputTokens: 10, outputTokens: 1 }, {}, { time }))
  assert.equal(extracted?.usage.at, '2026-01-02T03:04:05.006Z', '归因要拿它跟压缩/编辑时间比，用处理时刻会让窗口判定偏')

  const fallback = extractUsage(assistantEvent({ inputTokens: 10, outputTokens: 1 }, {}, { time: 'nonsense' }))
  assert.ok(fallback !== undefined, '`time` 不合法也不能抛（`new Date(NaN).toISOString()` 是会抛的）')
  assert.ok(Number.isFinite(Date.parse(fallback.usage.at)), '退化到当前时刻')
})

test('抽取：缺字段按 0 处理；四个全 0 视为"适配器没报账"，不写垃圾行', () => {
  const partial = extractUsage(assistantEvent({ inputTokens: 100 }))
  assert.equal(partial?.usage.cacheReadTokens, 0, '缺的字段当 0，不要 NaN')

  assert.equal(extractUsage(assistantEvent({ inputTokens: 0, outputTokens: 0 })), undefined, '全 0 不记')
  assert.equal(extractUsage(assistantEvent({ inputTokens: 'NaN' })), undefined, '非数字也不记')
  assert.equal(extractUsage(assistantEvent(undefined)), undefined, '没有 `data.usage` 就不记')
  assert.equal(extractUsage({ type: 'assistant/message' }), undefined, '没有 `data`（不是宿主信封）就不记')
  assert.equal(extractUsage(sessionEvent('tool/result', { usage: { inputTokens: 10 } })), undefined, '不是助手结算事件就不记')
})

test('抽取：`data.usage` 优先；没有它才退化到 `data.stream` 里最后一条 `usage` chunk', () => {
  const direct = extractUsage(
    assistantEvent({ inputTokens: 7, outputTokens: 1 }, { stream: [usageChunk({ inputTokens: 999, outputTokens: 1 })] }),
  )
  assert.equal(direct?.usage.inputTokens, 7, '`data.usage` 是主路径，压过 stream')

  const fromStream = extractUsage(
    assistantEvent(undefined, {
      stream: [usageChunk({ inputTokens: 1, outputTokens: 1 }), { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [] }, usageChunk({ inputTokens: 30, outputTokens: 4, cacheReadTokens: 300 })],
    }),
  )
  assert.equal(fromStream?.usage.inputTokens, 30, '退化路径必须取**最后一条** `usage` chunk（与宿主 `lastAssistantStreamChunk` 同口径）')
  assert.equal(fromStream?.usage.cacheReadTokens, 300)

  assert.equal(extractUsage(assistantEvent(undefined, { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: 'stop' } }] })), undefined, 'stream 里没有 usage chunk 就不记')
})

test('抽取：`assistant/attempt` 的账**只在 stream 里**也能取到（重试/取消的尝试照样计费）', () => {
  const attempt = sessionEvent('assistant/attempt', {
    turn: 2,
    step: 1,
    stream: [usageChunk({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 900, cacheWriteTokens: 40 })],
  })
  const extracted = extractUsage(attempt, 'sess_retry')
  assert.equal(extracted?.usage.inputTokens, 120, '宿主原话：重试的尝试把账只留在 `assistant/attempt` 的 stream 里')
  assert.equal(extracted?.usage.cacheReadTokens, 900)
  assert.equal(extracted?.usage.turn, 2)
  assert.equal(extracted?.usage.step, 1)
})

test('抽取：绝不抛异常（垃圾形状 / 会抛的 getter / 各种非对象）', () => {
  const hostile = {
    get type(): string {
      throw new Error('形状守卫炸了')
    },
  }
  assert.equal(isUsageEvent(hostile), false, '判定也不许抛')
  assert.doesNotThrow(() => {
    extractUsage(hostile)
    extractUsage(sessionEvent('assistant/message', { usage: 'garbage' }))
    extractUsage(sessionEvent('assistant/message', { usage: null, stream: 'garbage' }))
    extractUsage(sessionEvent('assistant/message', { stream: [null, 42, { type: 'chunk', chunk: null }] }))
    extractUsage(sessionEvent('assistant/message', {}), 'sess')
    extractUsage(42)
    extractUsage(undefined)
    extractUsage(new Date())
    extractUsage([])
  }, '这个采集器跑在每一次会话事件上，任何形状都只能表现为"这条不记"')
  assert.equal(extractUsage(sessionEvent('assistant/message', { usage: 'garbage' })), undefined)
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 采集与归因（走真形状 + 真库）
// ════════════════════════════════════════════════════════════════════════════

test('采集：真形状 ⇒ 表里真的多一行，且第一次采样归因为 first-call', () => {
  const before = listCacheUsage(db).length
  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 500, outputTokens: 10, cacheWriteTokens: 500 }, { turn: 4, step: 3 }), {
    sessionId: 'sess_collect',
  })
  assert.equal(result.recorded, true, '**真形状必须记上** —— 这就是修复前永远为 false 的那一步')
  assert.equal(result.missReason, 'first-call')

  const rows = listCacheUsage(db)
  assert.equal(rows.length, before + 1, '`cache_metrics` 必须真的多一行')
  assert.equal(rows[0]?.input_tokens, 500)
  assert.equal(rows[0]?.cache_write_tokens, 500)
  assert.equal(rows[0]?.miss_reason, 'first-call')
  assert.equal(rows[0]?.session_id, 'sess_collect')
  assert.equal(rows[0]?.turn, 4, '`turn`/`step` 也要从 `data` 里落库（面板靠它定位）')
  assert.equal(rows[0]?.step, 3)
})

test('采集：命中的采样不归因', () => {
  const result = collectUsageFromEvent(db, assistantEvent({ cacheReadTokens: 1000, outputTokens: 20 }))
  assert.equal(result.recorded, true)
  assert.equal(result.missReason, null)
})

test('归因：窗口内的压缩会让未命中变成可解释', () => {
  // 造一条"刚提交的压缩事务"
  db.prepare(
    `INSERT INTO compaction_runs (id, compaction_id, session_id, phase, epoch_from, epoch_to, plan, detail, error, started_at, ended_at)
     VALUES ('run_1', 'c1', 'sess_x', 'committed', 0, 1, '{}', NULL, NULL, ?, ?)`,
  ).run(new Date(Date.now() - 30_000).toISOString(), new Date(Date.now() - 29_000).toISOString())

  const changes = collectPrefixChanges(db)
  assert.ok(changes.some((c) => c.kind === 'compaction'), '压缩事务必须被收集到')

  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 2000, outputTokens: 30 }), { windowMs: 300_000 })
  assert.equal(result.missReason, 'compaction', '压缩之后的未命中是可解释的')
})

test('归因：提示词编辑同样可解释，且取最近的一次', () => {
  db.prepare(
    `INSERT INTO prompt_revisions (id, slug, text, sha256, token_count, variables, note, created_by, created_at, active)
     VALUES ('pr_t1', 'p2-style', 'x', 'h', 1, '[]', NULL, 'admin', ?, 0)`,
  ).run(new Date(Date.now() - 5_000).toISOString())

  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 1500, outputTokens: 10 }), { windowMs: 300_000 })
  assert.equal(result.missReason, 'prompt-edit', '编辑比压缩更近 ⇒ 归到编辑')
})

test('归因：没有任何变更事件 ⇒ unexplained（前缀在无故漂移，必须可见）', () => {
  const result = collectUsageFromEvent(db, assistantEvent({ inputTokens: 3000, outputTokens: 5 }), { windowMs: 1 })
  assert.equal(result.missReason, 'unexplained', '窗口设成 1ms ⇒ 先前的事件都不算，只能是无法解释')

  const summary = summarizeCache(
    listCacheUsage(db).map((row) => ({
      at: row.at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      missReason: row.miss_reason,
    })),
  )
  assert.ok(summary.unexplainedMisses >= 1, '"无法解释的未命中"必须能被汇总看见')
})

test('归因用的变更事件只算"非内置播种"的提示词版本（否则首次调用前的那一版会替未命中背锅）', () => {
  const changes = collectPrefixChanges(db)
  const edits = changes.filter((c) => c.kind === 'prompt-edit')
  assert.equal(edits.length, 1, '只有 admin 改的那一版算，system 播种的不算')
})

test('非用量事件：原样跳过，不写库（采集器不该污染数据）', () => {
  const before = listCacheUsage(db).length
  assert.equal(collectUsageFromEvent(db, sessionEvent('tool/result', { turn: 1, step: 0 })).recorded, false)
  assert.equal(collectUsageFromEvent(db, sessionEvent('assistant/message', assistantData(undefined))).recorded, false)
  assert.equal(collectUsageFromEvent(db, undefined).recorded, false)
  assert.equal(listCacheUsage(db).length, before)
})

test('面板取数：最新的在后（便于按时间画曲线）', () => {
  recordCacheUsage(db, { inputTokens: 1, outputTokens: 1, at: new Date(Date.now() + 60_000).toISOString() })
  const rows = listCacheUsage(db, { limit: 5 })
  assert.ok((rows[rows.length - 1]?.at ?? '') >= (rows[0]?.at ?? ''), '时间必须升序')
})
