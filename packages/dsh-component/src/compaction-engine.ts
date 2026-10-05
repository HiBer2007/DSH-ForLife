/**
 * 结构化压缩引擎：覆写宿主 `BasicCompactionEngine` 的**唯一子类定制钩子** `summarize()`。
 *
 * ## 为什么是子类而不是重写整个引擎
 *
 * 宿主明确写着 "`summarize()` is the sole subclass customization hook"，
 * 而三个入口（`compactIfNeeded` / `compactNow` / `compactRegion`）的实现涉及
 * 会话表面、工具配对平衡、续写重试、并发锁等一大堆我们已经验证过不好惹的逻辑。
 * 子类化 = 站在它肩上，只替换"问模型要什么"这一段 —— 这也正是交付物 1、2 要求的形态。
 *
 * ## 缓存的用法（关键）
 *
 * `SummarizationInput.messages` 已经是"派生的 system 头 + 被遮蔽区域，按表面顺序"，
 * 所以**原样重放**它、把我们的压缩指令**追加为最后一条 user 消息**，
 * 前缀就与主对话逐字节对齐 ⇒ 供应商的暖前缀缓存能命中，只有尾部指令是新的输入。
 *
 * ## 副作用放在压缩事务里
 *
 * 解析出决策后，写中期条目 / 沉降碎片 / 推进 epoch 全部包在
 * `beginCompactionRun … commitCompactionRun` 之间；任何一步抛错就回滚，
 * 保证"要么都成，要么回到上一个完整状态"。
 *
 * @module forlife-memory/compaction
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage, type ContentBlock, type Message, type TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * 宿主把 `SummarizationInput` / `SummaryResult` 放在内部 `src/` 路径下（不在包根导出），
 * 所以这里用**结构化类型**描述同一份契约。好处是不依赖内部路径（那种路径随时可能变），
 * 而且类型不匹配时 TS 会在 `override` 处报错，不会被悄悄放过。
 */
interface SummarizationInput {
  readonly tools?: readonly unknown[]
  readonly messages: readonly Message[]
}

/** 见 {@link SummarizationInput} 的说明。 */
interface SummaryResult {
  readonly summary: ContentBlock[]
  readonly rawOutput: ContentBlock[]
  readonly llmStreamCall: true
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly usage?: TokenUsage
}

import {
  estimateTokens,
  makeFragmentHint,
  parseCompactionDecision,
  renderKeepInShort,
  type CompactionDecision,
} from '@forlife/memory-core'
import {
  beginCompactionRun,
  bumpEpoch,
  commitCompactionRun,
  currentEpoch,
  fragmentMidEntry,
  insertLongEntry,
  recordCompaction,
  recordEffect,
  rollbackCompactionRun,
} from '@forlife/store'

import { activeRuntimes, type MemoryRuntime } from './index.ts'
import { emitForlifeEvent } from './events.ts'

/**
 * 注册我们的消息来源类型。
 *
 * 为什么必须有：`createUserMessage` 的 `source` 是必填，而**项目铁律**是
 * 绝不发出 `source.kind === 'user'`（"所有唤醒模型的消息都不使用人类发送消息"）。
 * 所以压缩指令用自己的来源类型，可审计、可区分。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 压缩指令（系统生成，不是人类发言）。 */
    'forlife:compaction-instruction': {
      readonly kind: 'forlife:compaction-instruction'
      /** 触发这次压缩的原因，进会话日志便于审计。 */
      readonly reason?: string
    }
  }
}

/** 指令里给出的输出格式与质量约束（§4.2 + §4.3）。 */
const INSTRUCTION_TAIL = [
  '',
  '## 你的任务',
  '压缩上面这段对话轨迹，产出一个 JSON 对象。只输出这个 JSON，不要有任何其它文字或代码块标记。',
  '',
  '{',
  '  "push_to_mid": [{"content": "细节原文", "summary": "一句话摘要", "entities": ["关键词"], "importance": 0.8}],',
  '  "keep_in_short": ["压缩后仍必须记住的进行中任务状态"],',
  '  "fragment_mid": ["上面清单里可以沉到长期记忆的条目 id"],',
  '  "reasoning": "这次压缩的理由（一句话）"',
  '}',
  '',
  '质量约束（违反的条目会被系统直接丢弃，不要浪费输出）：',
  '- 每条摘要必须**可独立理解**：将来单独看到也能懂，不许出现"见上文""如上所述""刚才那个"这类指代。',
  '- 禁止把纯工具调用记录（调用了什么工具、返回了什么）写进 push_to_mid。',
  '- 禁止把你对用户可见的回复全文写进 push_to_mid。',
  '- **允许 push_to_mid 为空数组** —— 压缩不等于必须产生中期记忆。',
  '- fragment_mid 只能填上面清单里出现过的条目 id；这一步表示"这些旧事以后按需检索即可"。',
  '- keep_in_short 只放**当前未完成任务的状态**，通常很短；它是压缩后唯一的短期记忆。',
].join('\n')

/**
 * 构造压缩指令（含当前 L3 渲染全文与条目化清单）。
 *
 * 这两块按 PLAN §4.2 属于压缩请求的输入；我们把它们并入尾部指令块而**不是**插到轨迹之前 ——
 * 因为插到前面会在那一点打断前缀，让暖缓存失效。这是刻意的取舍：
 * §4.2 的块顺序 vs 交付物 2 明确要求的"复用对话自身前缀以免多打掉 KV cache"，后者优先。
 *
 * @param runtime - 记忆运行时。
 * @param reason - 触发原因（写进会话日志）。
 * @returns 指令文本。
 */
export function buildCompactionInstruction(runtime: MemoryRuntime, reason: string): string {
  const view = runtime.renderView()
  const entries = runtime.listEntries()
  const itemized = entries
    .map((e) => {
      const entities = safeParseEntities(e.entities)
      return `- ${e.id} | ${e.entry_type === 'fragment' ? '碎片' : '活跃'} | ${String(e.token_count)} token | entities: [${entities.join(', ')}] | ${e.summary}`
    })
    .join('\n')

  return [
    `## 当前中期记忆（渲染全文，与主对话里的完全一致）`,
    view.text === '' ? '（空）' : view.text,
    '',
    '## 中期记忆条目化清单（fragment_mid 只能用这里的 id）',
    itemized === '' ? '（空）' : itemized,
    '',
    `## 本次压缩的触发原因`,
    reason,
    INSTRUCTION_TAIL,
  ].join('\n')
}

/** 宽松解析 entities（表里是 JSON 文本）。 */
function safeParseEntities(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 我们运行时的最小依赖（便于单测注入替身）。 */
export interface CompactionIO {
  readonly runtime: MemoryRuntime
  readonly reason: string
}

/**
 * 把模型决策落库（PLAN §4.2 Step 4/5）。
 *
 * 顺序：先写事务（含计划）→ 推进 epoch → 追加中期条目 → 沉降碎片 → 写日志 → 提交事务。
 * 任一步失败都回滚到调用前的完整状态。
 *
 * @param io - 运行时与触发原因。
 * @param decision - 已校验的模型决策。
 * @param sessionId - 会话 id（进日志）。
 * @param compactionId - DSH 侧的压缩事务 id（对账用）。
 * @returns 落库统计。
 */
export function applyCompactionDecision(
  io: CompactionIO,
  decision: CompactionDecision,
  sessionId?: string,
  compactionId?: string,
): { readonly pushed: number; readonly fragmented: number; readonly epoch: number; readonly dropped: number } {
  const { runtime } = io
  const db = runtime.db
  const epochFrom = currentEpoch(db)

  // 计划必须**动手之前**落盘：回滚要用它
  const pushedIds = decision.push_to_mid.map((_, index) => `mid_c${String(Date.now())}_${String(index)}`)
  const fragmentedIds = decision.fragment_mid.filter((id) => runtime.listEntries().some((e) => e.id === id))
  const longIds = fragmentedIds.map((id) => `long_from_${id}`)

  const run = beginCompactionRun(db, {
    id: `run_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    compactionId: compactionId ?? null,
    sessionId: sessionId ?? null,
    epochFrom,
    plan: { pushedIds, fragmentedIds, longIds },
  })

  try {
    // ① 推进 epoch（Step 4：compaction_epoch += 1，新条目落在新 epoch）
    const epoch = bumpEpoch(db)

    // ② 追加中期条目（带 id，便于回滚）
    let pushed = 0
    for (const [index, entry] of decision.push_to_mid.entries()) {
      const id = pushedIds[index]
      if (id === undefined) continue
      runtime.append({
        id,
        summary: entry.summary,
        content: entry.content,
        entities: entry.entities,
        sourceScope: sessionId ?? null,
      })
      pushed += 1
    }

    // ③ 沉降：中期条目 → 长期记忆全文 + [F1→] 碎片（§5.3 单条限制在这里生效）
    let fragmented = 0
    const now = runtime.listEntries()
    for (const id of fragmentedIds) {
      const source = now.find((e) => e.id === id)
      if (source === undefined) continue
      const entities = safeParseEntities(source.entities)
      const { hint } = makeFragmentHint(source.summary, entities)
      const longId = `long_from_${id}`
      insertLongEntry(db, {
        id: longId,
        content: source.content ?? source.summary,
        summary: source.summary,
        entities,
        sourceMidIds: [id],
        sourceScope: source.source_scope,
      })
      fragmentMidEntry(db, id, longId, hint, estimateTokens(hint))
      fragmented += 1
    }

    // ④ 压缩日志（PLAN §4.5 字段）
    recordCompaction(db, {
      id: run.id,
      requestedBy: 'system',
      approved: true,
      shortTokensBefore: 0,
      turnsSinceLast: 0,
      timeSinceLastMs: 0,
      pushedEntries: pushedIds.slice(0, pushed),
      fragmentedEntries: fragmentedIds,
      keptInShortTokens: estimateTokens(renderKeepInShort(decision.keep_in_short)),
      modelUsed: 'see-compaction-run',
    })

    // ⑤ 第三写：影响审计（跨功能的统一审计面；阶段 3 的 admin_actions 共用这张表）
    recordEffect(db, {
      id: `eff_${run.id}`,
      kind: 'compaction',
      actor: 'system',
      subject: sessionId ?? null,
      detail: {
        runId: run.id,
        compactionId: compactionId ?? null,
        epochFrom,
        epochTo: epoch,
        pushed,
        fragmented,
        keepInShort: decision.keep_in_short.length,
        reasoning: decision.reasoning,
      },
    })

    commitCompactionRun(db, run.id, { epochTo: epoch, detail: { pushed, fragmented, dropped: 0 } })
    // 记账基线重置：下一次裁决的"距上次压缩"从这里重新起算
    runtime.resetCompactionAccounting()
    return { pushed, fragmented, epoch, dropped: 0 }
  } catch (error) {
    // 回滚：删掉本次新写的、恢复碎片、epoch 退回
    rollbackCompactionRun(db, run)
    throw error
  }
}

/** 引擎可选注入（测试可替换）。 */
export interface EngineHooks {
  /** 取运行时（默认从活动登记表取第一个）。 */
  readonly resolveRuntime?: () => MemoryRuntime | undefined
  /** 压缩原因（默认由宿主触发类型推导）。 */
  readonly reason?: string
}

/** 当前测试/运行时注入的钩子。 */
let hooks: EngineHooks = {}

/**
 * 设置引擎钩子（测试与调试用）。
 *
 * @param next - 新的钩子集合。
 */
export function setCompactionEngineHooks(next: EngineHooks): void {
  hooks = next
}

/**
 * DSH-ForLife 的压缩引擎。
 *
 * profile 里禁用 `compaction-basic` 行、把本模块作为 `ctx.compaction` 的唯一实现挂载
 * （`CompactionEngine` 基类在构造函数里 `super(ctx, "compaction")`，子类自动提供该服务）。
 */
export class ForlifeCompactionEngine extends BasicCompactionEngine {
  /**
   * 构造即注册：基类在构造函数里 `super(ctx, "compaction")`，
   * 所以这个子类被挂上的那一刻，`ctx.compaction` 就是我们。
   */
  constructor(...args: ConstructorParameters<typeof BasicCompactionEngine>) {
    super(...args)
    const config = args[1]
    console.log(
      `[forlife] 压缩引擎已挂载（ctx.compaction = ForlifeCompactionEngine）｜摘要模型：` +
        `${config?.summarizationProvider ?? '(跟随路由)'}/${config?.summarizationModel ?? '(跟随路由)'}｜maxTokens=${String(config?.maxTokens ?? '默认')}`,
    )
  }
  /**
   * 覆写自动压缩入口：优先消费模型排队的压缩请求。
   *
   * 工具执行上下文里**没有 agent**（只有 callId/signal），所以 `request_compaction` 批准后
   * 只能入队；真正要改会话表面必须有 agent，而这里是唯一能拿到 agent 的地方。
   * 有排队请求时改用宿主自己的 `context-overflow` 语义强制执行 ——
   * 该语义按文档就是"绕过常规阈值与保留尾部策略，做一次有用的平衡缩减"。
   *
   * @param agent - 目标会话与路由。
   * @param trigger - 宿主给的触发原因。
   * @param signal - 取消信号。
   * @returns 压缩结果，或 null（无需压缩）。
   */
  override async compactIfNeeded(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    trigger: Parameters<BasicCompactionEngine['compactIfNeeded']>[1],
    signal: AbortSignal,
  ): ReturnType<BasicCompactionEngine['compactIfNeeded']> {
    const runtime = (hooks.resolveRuntime ?? ((): MemoryRuntime | undefined => activeRuntimes()[0]))()
    const pending = runtime?.takePendingCompactionRequest()
    if (pending !== undefined) {
      console.log(`[forlife] 执行模型请求的压缩（原因：${pending.reason}）`)
      return super.compactIfNeeded(agent, 'context-overflow', signal)
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  /**
   * 唯一覆写点：把"要一份摘要"换成"要一份结构化决策"。
   *
   * @param input - 重放的对话前缀（system 头 + 被遮蔽区域）。
   * @param agent - 目标会话与路由。
   * @param signal - 取消信号（必须转发）。
   * @returns 摘要结果（`summary` 即 keep_in_short 的渲染，由基类加检查点框架）。
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const runtime = (hooks.resolveRuntime ?? ((): MemoryRuntime | undefined => activeRuntimes()[0]))()
    if (runtime === undefined) {
      throw new Error('[forlife] 记忆运行时尚未就绪，无法执行结构化压缩')
    }

    const reason = hooks.reason ?? '系统自动压缩（上下文压力）'
    const provider = this.resolveProvider(agent)
    const model = this.resolveModel(agent)

    // ① 原样重放前缀 + 追加我们的指令（尾部是唯一的新输入 ⇒ 暖缓存可命中）
    const instruction = buildCompactionInstruction(runtime, reason)
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: instruction }],
        source: { kind: 'forlife:compaction-instruction', reason },
      }),
    ]

    // ② 一次 stream（purpose: 'compaction' 让计量与日志能区分这是辅助调用）
    const assembler = new BlockAssembler()
    const streamOptions: Record<string, unknown> = {
      provider,
      model,
      messages,
      toolHistory: agent.session.toolHistory(),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
    }
    if (input.tools !== undefined) streamOptions['tools'] = [...input.tools]
    if (signal !== undefined) streamOptions['signal'] = signal

    const llm = (this.ctx as unknown as { llm: { stream(options: unknown): AsyncIterable<unknown> } }).llm
    for await (const chunk of llm.stream(streamOptions)) assembler.push(chunk as never)
    const rawOutput = assembler.blocks()
    const text = rawOutput
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    // ③ 解析（不合规就抛错 —— 交给宿主的恢复监听与重试，绝不写半成品记忆）
    const parsed = parseCompactionDecision(text)
    if (!parsed.ok) {
      throw new Error(`[forlife] 压缩输出不合规：${parsed.error}`)
    }
    if (parsed.dropped.length > 0) {
      console.warn(`[forlife] 压缩输出中 ${String(parsed.dropped.length)} 条被质量约束丢弃：${parsed.dropped.join('；')}`)
    }

    // ④ 落库（压缩事务内）
    const stats = applyCompactionDecision(
      { runtime, reason },
      parsed.decision,
      agent.session.id,
      undefined,
    )

    // ⑤ 会话事件（旁路记录，不影响权威表）
    emitForlifeEvent(agent.session as unknown as { append(type: string, data: unknown, opts?: { ignorable?: true }): unknown }, 'forlife.compaction.committed', {
      epoch: stats.epoch,
      pushed: stats.pushed,
      fragmented: stats.fragmented,
      keepInShort: parsed.decision.keep_in_short.length,
      reasoning: parsed.decision.reasoning,
    })

    const summaryBlocks = [{ type: 'text' as const, text: renderKeepInShort(parsed.decision.keep_in_short, parsed.decision.reasoning) }]
    return {
      summary: summaryBlocks,
      rawOutput,
      llmStreamCall: true,
      provider,
      model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }

  /** 摘要用哪家供应商：显式配置 > 本轮路由 > 兜底。 */
  private resolveProvider(agent: Agent): string {
    const configured = this.config.summarizationProvider
    if (configured !== '') return configured
    const options = (agent as unknown as { options?: { provider?: string } }).options
    if (options?.provider !== undefined && options.provider !== '') return options.provider
    return 'deepseek-official'
  }

  /** 摘要用哪个模型。 */
  private resolveModel(agent: Agent): string {
    const configured = this.config.summarizationModel
    if (configured !== '') return configured
    const options = (agent as unknown as { options?: { model?: string } }).options
    if (options?.model !== undefined && options.model !== '') return options.model
    return 'deepseek-flash'
  }
}

export default ForlifeCompactionEngine




