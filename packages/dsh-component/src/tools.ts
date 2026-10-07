/**
 * 记忆工具。
 *
 * 全部用 `defineTool` 定义，遵守宿主的三条硬规矩：
 *  1. `output` **必填**，且 `output.render` 是**纯函数**（只做投影，不产生副作用）；
 *  2. 对象节点必须显式声明 `additionalProperties`（否则 JSON Schema 会带上意外默认值）；
 *  3. `execute` 只返回**规范化 JSON 值**，不返回展示文本。
 *
 * 工具描述（`description`）是写给模型看的"说明书"，所以刻意写得像说明书：
 * 说清什么时候用、什么时候别用、边界在哪。这也是"提示词可编辑"之外唯一由代码控制的引导面。
 *
 * ## ⚠️ 兼容性：`recall_longterm` 为什么**同时**有平铺字段与 `budget` 对象
 *
 * PLAN §7.1 要的形状是 `{results, budget:{used,limit,remaining,reset_at,queries_this_turn,hint}}`。
 * 本工具历史上返回的是**拍平**的 `{usedThisTurn, remainingThisTurn, remainingThisCycle}`，
 * 而且这套平铺已经进了**旧会话的工具结果历史**（模型在上下文里读得到）。
 *
 * 处理方式：**以 PLAN 的形状为准，平铺字段作为兼容层保留**。
 * 理由：① 多几个整数几乎不占 token，而"换掉形状"会让旧历史里的字段突然消失，
 * 模型对新旧两轮结果的读法会冲突；② `budget` 是权威，平铺只是同源冗余
 * （两个形状都由 `runtime.budgetDeclaration()` 一处产出，不可能互相矛盾）。
 * 哪天要删平铺：先确认没有别的读者（2026-10-07 全仓检索 `usedThisTurn` 只命中本文件
 * 与 runtime 的内部结构 —— 面板读的是数据库，不读工具返回值）。
 *
 * @module forlife-memory/tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { MemoryRuntime } from './runtime.ts'
import { withToolResultSpill } from './tool-spill.ts'

/** defineTool 的运行时形态（宿主提供；这里给出结构化类型，避免硬依赖具体包版本）。 */
export interface DefineToolLike {
  (options: {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
    readonly output: {
      readonly schema: unknown
      render(args: never, value: never): ContentBlock[]
    }
    execute(args: never, exec: unknown): Promise<unknown>
  }): unknown
}

/** 文本结果的便捷构造（render 里统一用它）。 */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/**
 * 冷层正文返回给模型时的字符上限。
 *
 * 沉降过的条目正文**没有上限**（压缩时推进去的可能是整段原文），
 * 而一次 recall 最多 3~5 条 —— 不设上限的话，一条 100KB 的旧日志就能把上下文顶掉。
 * 截断必须**说出来**（否则模型会以为那就是全文）。
 */
export const COLD_CONTENT_MAX_CHARS = 1500

/** 截断冷层正文，并**如实标注**截断（不假装那是全文）。 */
function clipColdContent(content: string): string {
  if (content.length <= COLD_CONTENT_MAX_CHARS) return content
  return `${content.slice(0, COLD_CONTENT_MAX_CHARS)}…（正文共 ${String(content.length)} 字，已截断到前 ${String(COLD_CONTENT_MAX_CHARS)} 字）`
}

/** `render` 里读预算声明所需的最小子集（结构化类型，避免和 runtime 循环依赖）。 */
interface RecallBudgetLines {
  readonly hint?: string
  readonly queries_this_turn?: readonly string[]
}

/**
 * 把预算声明渲染成模型可见的一行（PLAN §7.1「每次工具返回附带」）。
 *
 * **为什么必须渲染**：模型看到的是 `output.render()` 的文本，不是 `execute` 的返回值。
 * 只把 `budget` 放进返回值里，等于模型永远读不到 `hint` 与"本轮已查过什么"——
 * 那正是 PLAN 要这两个字段的原因（避免重复检索）。
 */
function renderBudgetLine(budget: RecallBudgetLines | undefined): string {
  if (budget === undefined) return ''
  const asked = budget.queries_this_turn ?? []
  const queries = asked.length === 0 ? '' : `｜本轮已查：${asked.map((q) => `「${q}」`).join('、')}`
  return `【额度】${budget.hint ?? ''}${queries}`
}

/**
 * 构造记忆工具。
 *
 * @param defineTool - 宿主的 `defineTool`（来自 `@deepseek-ai/dsh-tools`）。
 * @param runtime - 记忆运行时。
 * @returns 可供 `ctx.tools.register()` 的定义数组。
 */
export function buildMemoryTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  // ★ PLAN §3.2 分层降噪的**接缝**：大工具结果不在上下文里塞全文，只留 head + 溢出 id，
  //   模型要完整内容时用 recall_full 取回（`./tool-spill.ts` 的模块头解释了为什么选
  //   `finalizeContent` 而不是 `output.render`：render 必须是纯投影）。
  //   阈值取自基线 `tool.spill.thresholdBytes`（不在这里硬编码数字）。
  const defineSpillingTool = withToolResultSpill(defineTool, runtime)
  const remember = defineSpillingTool({
    name: 'remember',
    description: [
      '把一件值得长期记住的事写进中期记忆。',
      '适用：用户表达的稳定偏好、身份事实、长期约定、你判断以后还会用到的结论。',
      '不适用：工具调用流水、你刚说过的话、可以从上下文直接读到的内容、一次性的临时状态。',
      '一次只记一件事，写成一句自足的话（将来单独看到也能懂，不要用"他/这个/刚才"这类指代）。',
    ].join('\n'),
    parameters: {
      summary: { type: 'string', required: true, description: '一句话摘要，自足、无指代。' },
      content: { type: 'string', description: '可选：需要保留的细节原文。' },
      entities: { type: 'array', items: { type: 'string' }, description: '可选：关键实体（人名/项目/技术名），最多 5 个。' },
      scope: { type: 'string', description: '可选：来源标记。**一般不用填** —— 不填时会自动记为当前会话。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '是否写入成功。' },
          id: { type: 'string', required: true, description: '条目 id。' },
          windowOffset: { type: 'integer', description: '在中期记忆区中的位置。' },
          tokenCount: { type: 'integer', description: '该条目占用的 token 估算。' },
          midTokens: { type: 'integer', description: '写入后中期记忆区总 token。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { id: string; tokenCount: number; midTokens: number }
        return text(`已记住（${v.id}，约 ${String(v.tokenCount)} token；中期记忆区现约 ${String(v.midTokens)} token）`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { summary: string; content?: string; entities?: string[]; scope?: string }
      const entities = (a.entities ?? []).slice(0, 5)
      runtime.recordToolCall()
      // 溯源：模型没显式给 scope 时，用"当前正在处理的 QQ 会话"——
      // 它多半不知道该填什么，而这条信息对将来回溯"这话是谁说的"很关键。
      const sourceScope = a.scope ?? runtime.currentConversationScope() ?? null
      const result = runtime.append({
        summary: a.summary,
        ...(a.content === undefined ? {} : { content: a.content }),
        entities,
        sourceScope,
      })
      const stats = runtime.stats()
      return {
        ok: true,
        id: result.id,
        windowOffset: result.windowOffset,
        tokenCount: result.tokenCount,
        midTokens: stats.activeTokens + stats.fragmentTokens,
      }
    },
  })

  const pushMidMemory = defineSpillingTool({
    name: 'push_mid_memory',
    description: [
      '批量把若干条记忆推进中期记忆区（压缩流程的原语）。',
      '与 remember 的区别：这个用于一次写入多条（例如压缩一轮对话后的产出），并返回新的渲染修订号。',
      '条目写法同 remember：一条一件事、自足、无指代。',
    ].join('\n'),
    parameters: {
      entries: {
        type: 'array',
        required: true,
        description: '要写入的条目数组。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true, description: '一句话摘要。' },
            content: { type: 'string', description: '细节原文。' },
            entities: { type: 'array', items: { type: 'string' }, description: '关键实体。' },
          },
        },
      },
      scope: { type: 'string', description: '可选：来源范围标记。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          added: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                windowOffset: { type: 'integer' },
                tokenCount: { type: 'integer' },
              },
            },
          },
          revision: { type: 'integer', required: true, description: '写入后的渲染修订号（窗口已随之变化）。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { added: { id: string }[]; revision: number }
        return text(`已写入 ${String(v.added.length)} 条中期记忆（修订号 ${String(v.revision)}）`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { entries: { summary: string; content?: string; entities?: string[] }[]; scope?: string }
      const added: { id: string; windowOffset: number; tokenCount: number }[] = []
      let revision = runtime.revision()
      const batchScope = a.scope ?? runtime.currentConversationScope() ?? null
      for (const entry of a.entries) {
        const result = runtime.append({
          summary: entry.summary,
          ...(entry.content === undefined ? {} : { content: entry.content }),
          entities: (entry.entities ?? []).slice(0, 5),
          sourceScope: batchScope,
        })
        added.push({ id: result.id, windowOffset: result.windowOffset, tokenCount: result.tokenCount })
        revision = result.revision
      }
      return { ok: true, added, revision }
    },
  })

  const recallLongterm = defineSpillingTool({
    name: 'recall_longterm',
    description: [
      '检索长期记忆里过去的事。每次返回都附带**预算声明**（本周期还剩几次、重置策略、本轮已查过什么）。',
      '先想清楚要什么再查；无命中不代表不存在，可以换关键词，但不要为了确认而反复检索。',
      '结果里的 storage_tier = hdd 表示该条已沉降到冷层：它的正文会**按需从冷层取回**（可能稍慢），随结果一起返回。',
      '若 note 里说某条"取不回来"，那是**冷层读取失败**，不代表这件事没记过 —— 不要据此当作"记忆里没有"。',
      '额度用尽时返回空结果并说明原因；确需再查可调用 request_recall_extension(reason) 申请追加额度。',
      '要让某条已沉降的条目重新变热（正文回到库内）时，用 recover(id) —— 一次一条。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词或短语（中文按字匹配相邻短语）。' },
      limit: { type: 'integer', description: '期望返回条数（受硬上限 5 约束）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                summary: { type: 'string' },
                entities: { type: 'array', items: { type: 'string' } },
                tier: { type: 'string', description: 'ssd / hdd' },
                createdAt: { type: 'string', description: 'UTC 时间戳' },
                content: {
                  type: 'string',
                  description:
                    '**冷层（hdd）条目的正文**：命中后按需从归档取回来的原文。取不回来时不会有这个字段，note 里会说明原因。',
                },
              },
            },
          },
          // ★ PLAN §7.1 的预算声明（形状逐字段对齐，数字由 runtime 算好，工具层不自己拼）
          budget: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description: 'PLAN §7.1 的预算声明。used/limit/remaining 是**本周期**的口径（reset_at 说明它何时重置）。',
            properties: {
              used: { type: 'integer', required: true, description: '本周期已用次数。' },
              limit: { type: 'integer', required: true, description: '本周期上限（recall.maxPerCycle）**含**已追加额度。' },
              remaining: { type: 'integer', required: true, description: '本周期剩余次数。' },
              reset_at: {
                type: 'string',
                required: true,
                description: '重置策略（读自基线 recall.resetPolicy，当前为 on_compaction）。',
              },
              queries_this_turn: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '本轮已经查过的检索词（有界）—— 别重复查相近主题。',
              },
              hint: { type: 'string', required: true, description: '还剩多少 / 不够时该调什么工具。' },
              per_turn: {
                type: 'object',
                required: true,
                additionalProperties: false,
                description: '**本轮**额度（闸门有两道：每轮 + 每周期，两个都要知道）。',
                properties: {
                  used: { type: 'integer', required: true },
                  limit: { type: 'integer', required: true },
                  remaining: { type: 'integer', required: true },
                },
              },
              extension: {
                type: 'object',
                required: true,
                additionalProperties: false,
                description: '逃生通道现状（本周期追加了多少、一次最多追加多少、冷却几轮）。',
                properties: {
                  grantedThisCycle: { type: 'integer', required: true },
                  maxPerRequest: { type: 'integer', required: true },
                  cooldownTurns: { type: 'integer', required: true },
                },
              },
            },
          },
          usedThisTurn: { type: 'integer' },
          remainingThisTurn: { type: 'integer' },
          remainingThisCycle: { type: 'integer' },
          note: { type: 'string', description: '无命中、触发额度限制、或冷层取不回来时的说明。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as {
          results: { id: string; summary?: string; content?: string }[]
          budget?: RecallBudgetLines
          note?: string
        }
        const body =
          v.results.length === 0
            ? (v.note ?? '长期记忆无命中。')
            : v.results
                .map((r, i) => {
                  const head = `${String(i + 1)}. [${r.id}] ${r.summary ?? ''}`
                  // 冷层正文是**按需取回来的**（取不回来时 runtime 会在 note 里说清）
                  return r.content === undefined ? head : `${head}\n   ↳ ${r.content}`
                })
                .join('\n')
        const note = v.results.length === 0 || v.note === undefined ? '' : `\n（${v.note}）`
        // ★ 预算声明**也要渲染出来**：模型看到的是 render 的内容，
        //   只把 budget 放进 execute 的返回值里，模型永远读不到 hint 与已查清单。
        const budget = renderBudgetLine(v.budget)
        return text(`${body}${note}${budget === '' ? '' : `\n${budget}`}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { query: string; limit?: number }
      // ★ **必须走 `recallLongtermOnDemand`**（不是 `recallLongterm`）——
      //
      // 沉降过的条目在 FTS 索引里**仍然命中**（`markLongSettled` 只清表里的 content），
      // 但表内正文是 NULL：只做检索的话，**命中 = 拿到一条空正文**，
      // 对模型而言与"这条记忆被删了"没有区别 ⇒ **沉降变成静默的数据丢失**。
      // 这一跳就是 §6.3 的"按需加载"。
      const result = await runtime.recallLongtermOnDemand(a.query, a.limit)
      return {
        ok: true,
        results: result.entries.map((entry) => ({
          id: entry.id,
          summary: entry.summary ?? '',
          entities: parseEntities(entry.entities),
          tier: entry.storage_tier ?? 'ssd',
          createdAt: entry.created_at ?? '',
          // 正文只给**冷层取回来的那些**：热条目的 summary 已经在上面，
          // 而冷层不一样 —— 不把它带回来，模型就永远看不到这条记忆的内容。
          ...(entry.storage_tier === 'hdd' && entry.content !== null && entry.content !== undefined
            ? { content: clipColdContent(entry.content) }
            : {}),
        })),
        // PLAN §7.1 的声明：**原样透传**运行时算好的那一份（工具层不重算数字）
        budget: result.budget, // ← 回退验证：故意传内部计数器（应为 result.declaration）
        // 旧字段保留（兼容）：平铺是历史形状，见文件头的"兼容性说明"
        usedThisTurn: result.budget.usedThisTurn,
        remainingThisTurn: result.budget.remainingThisTurn,
        remainingThisCycle: result.budget.remainingThisCycle,
        ...(result.note === undefined ? {} : { note: result.note }),
      }
    },
  })

  const recallFull = defineSpillingTool({
    name: 'recall_full',
    description: [
      '取回之前被截断的大结果全文（上下文里只留了它的前若干行）。',
      '需要精确内容（完整日志、完整列表、原始报错）时用它，而不是凭记忆猜测被截断的部分。',
    ].join('\n'),
    parameters: {
      id: { type: 'string', required: true, description: '截断时给出的溢出 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean', required: true },
          content: { type: 'string', description: '完整内容（仅在 found=true 时存在）。' },
          toolName: { type: 'string' },
          bytes: { type: 'integer' },
          lines: { type: 'integer' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { found: boolean; content?: string; toolName?: string; lines?: number }
        if (!v.found) return text('找不到该溢出记录（id 可能已过期或被清理）。')
        return text(`已取回 ${v.toolName ?? '工具'} 的完整结果（${String(v.lines ?? 0)} 行）：\n${v.content ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { id: string }
      const result = runtime.recallFull(a.id)
      if (!result.found) return { ok: true, found: false }
      return {
        ok: true,
        found: true,
        content: result.content ?? '',
        toolName: result.meta?.toolName ?? '',
        bytes: result.meta?.bytes ?? 0,
        lines: result.meta?.lines ?? 0,
      }
    },
  })

  const requestCompaction = defineSpillingTool({
    name: 'request_compaction',
    description: [
      '请求压缩这一段对话（把短期轨迹提炼成中期记忆、把当前状态留成一行摘要）。',
      '系统会用 PLAN §4.4 的阈值与冷却期裁决：太薄（内容不够）或太频繁会被拒，并告诉你还差多少。',
      '值得请求的时机：你已经完成了若干轮实质工作、但当前任务的中间状态已经不需要保留全部细节了。',
      '不要为了"清理上下文"反复请求 —— 被拒时返回的 required/current 就是判据，照着攒够再来。',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: '为什么要压缩（会进压缩日志与审计）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean', required: true },
          reason: { type: 'string', description: '被拒原因码：too_thin / too_frequent。' },
          current: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tokens: { type: 'integer' },
              turns: { type: 'integer' },
              tool_calls: { type: 'integer' },
            },
          },
          required: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tokens: { type: 'integer' },
              turns: { type: 'integer' },
              tool_calls: { type: 'integer' },
            },
          },
          hint: { type: 'string', description: '还差多少 / 为什么现在不行。' },
          waiver: { type: 'string', description: '命中的豁免：token_threshold / context_pressure。' },
          queued: { type: 'boolean', description: '是否已排队等待下一次压缩判定执行。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { approved: boolean; reason?: string; hint?: string; waiver?: string }
        if (v.approved) {
          return text(`压缩请求已批准${v.waiver === undefined ? '' : `（豁免：${v.waiver}）`}，已排队，下一次压缩判定时立即执行。`)
        }
        return text(`压缩请求被拒（${v.reason ?? '未知'}）：${v.hint ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string }
      // 先裁决、后记账：裁决依据的是**本次请求之前**的累积
      // （否则工具会把自己算进去，报出的 current.tool_calls 比用户预期多 1）
      const verdict = runtime.evaluateCompactionRequest()
      runtime.recordToolCall()
      if (!verdict.approved) {
        // 拒绝反馈：字段与 PLAN §4.4 的 JSON 逐字段一致
        return {
          approved: false,
          reason: verdict.reason ?? 'too_thin',
          current: verdict.current,
          required: verdict.required,
          hint: verdict.hint ?? '',
        }
      }
      // 批准：入队 + 记影响（铁律：影响模型的操作必须留痕）
      runtime.requestCompaction(a.reason)
      return {
        approved: true,
        queued: true,
        current: verdict.current,
        required: verdict.required,
        ...(verdict.waiver === undefined ? {} : { waiver: verdict.waiver }),
      }
    },
  })

  /**
   * **逃生通道**（PLAN §7.5）：额度用尽时申请追加。
   *
   * 它是 §7.2 那句"若确需，可调用 request_recall_extension(reason)"的落点 ——
   * 在这条工具存在之前，那句提示指的是一张**不存在的工具**，还把可用时间推给"阶段 4"
   * （而那个阶段早已交付）。模型照着调只会拿到"未知工具"，然后自己编一个替代做法。
   */
  const requestRecallExtension = defineSpillingTool({
    name: 'request_recall_extension',
    description: [
      '当 recall 额度确实不够用、而且这件事非查不可时，申请**临时**追加检索额度。',
      '理由要具体（要查什么、为什么非查不可）——太短的需求会被拒；被拒时会告诉你还差几轮冷却。',
      '受冷却限制（两次批准之间要隔若干轮），一次最多追加固定次数；追加后额度会在下一次 recall 返回里如实告知。',
      '这不是"想多查几次"的常规通道：先判断信息是否真的存在，别用它来"确保无遗漏"。',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', required: true, description: '为什么必须追加（要具体：要查什么、为什么当前信息不够）。' },
      additional: {
        type: 'integer',
        description: '本次请求追加几次；省略则按上限追加。超过单次上限会被明确拒绝（不静默夹取）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          granted: { type: 'boolean', required: true, description: '是否批准。' },
          reason: {
            type: 'string',
            description: '被拒原因码：reason_too_short / bad_amount / beyond_max / too_frequent。',
          },
          hint: { type: 'string', required: true, description: '批准后的额度变化，或被拒的具体原因与还差几轮。' },
          additional: { type: 'integer', required: true, description: '实际追加的次数（被拒为 0）。' },
          perTurnLimit: { type: 'integer', required: true, description: '裁决后生效的每轮额度。' },
          perCycleLimit: { type: 'integer', required: true, description: '裁决后生效的每周期额度。' },
          cooldownTurns: { type: 'integer', required: true, description: '两次批准之间的冷却（轮）。' },
          cooldownRemainingTurns: { type: 'integer', description: '还要等几轮才能再申请（只在因冷却被拒时出现）。' },
          grantedThisCycle: { type: 'integer', required: true, description: '本周期累计已追加的额度。' },
          maxPerRequest: { type: 'integer', required: true, description: '单次可追加的上限。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { granted: boolean; additional: number; reason?: string; hint: string; perCycleLimit: number }
        if (v.granted) {
          return text(`已追加 ${String(v.additional)} 次检索额度（本周期上限现为 ${String(v.perCycleLimit)}）。${v.hint}`)
        }
        return text(`追加额度被拒（${v.reason ?? '未知'}）：${v.hint}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason: string; additional?: number }
      runtime.recordToolCall()
      const verdict = runtime.requestRecallExtension({
        reason: a.reason,
        ...(a.additional === undefined ? {} : { additional: a.additional }),
      })
      return {
        ok: true,
        granted: verdict.granted,
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
        hint: verdict.hint,
        additional: verdict.additional,
        perTurnLimit: verdict.perTurnLimit,
        perCycleLimit: verdict.perCycleLimit,
        cooldownTurns: verdict.cooldownTurns,
        ...(verdict.cooldownRemainingTurns === undefined ? {} : { cooldownRemainingTurns: verdict.cooldownRemainingTurns }),
        grantedThisCycle: verdict.grantedThisCycle,
        maxPerRequest: verdict.maxPerRequest,
      }
    },
  })

  /**
   * **`recover`**（PLAN §6.3 的"可逆"）：把已沉降到冷层（HDD）的长期条目提升回热层。
   *
   * 在它存在之前，L2 提示词（`config.ts` 的 `DEFAULT_L2_INDEX_TEXT`，**稳定前缀**）
   * 与工具描述都让模型"用 recover 提升回热层"，而**这个名字根本不在工具表里** ——
   * 模型照着调只能拿到"未知工具"，然后自己编一个替代做法。
   */
  const recover = defineSpillingTool({
    name: 'recover',
    description: [
      '把一条**已沉降到冷层**（storage_tier=hdd）的长期记忆提升回热层（正文回到库内，之后不用再走归档）。',
      '什么时候用：你确认某条旧记忆接下来会反复用到，而它每次都要从冷层取正文（慢）。',
      '一次只提升一条（批量提升等于一次抹掉沉降的成果）。已经在热层的条目会说"不需要提升"，**不会假装成功**。',
      '如果冷层归档读不出来，会明确报失败 —— 那不是"没有这条记忆"，别据此改答案。',
    ].join('\n'),
    parameters: {
      id: { type: 'string', required: true, description: '长期记忆条目 id（recall_longterm 结果里的 id）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            description: 'recovered（提升成功）/ not_found / already_hot（本来就在热层）/ archive_unreadable（冷层读不出来）。',
          },
          note: { type: 'string', required: true, description: '发生了什么、为什么。' },
          tier: { type: 'string', description: '提升后（或原本）的层。' },
          source: { type: 'string', description: '正文从哪读回来的：archive（真的从冷层提升）/ db / none。' },
          latencyMs: { type: 'integer', description: '读取耗时（冷层延迟要看得见）。' },
          contentChars: { type: 'integer', description: '回填的正文长度（字符）。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; id: string; status: string; note: string; contentChars?: number; latencyMs?: number }
        if (!v.ok) return text(`没有提升 ${v.id}（${v.status}）：${v.note}`)
        return text(
          `已把 ${v.id} 提升回热层（正文 ${String(v.contentChars ?? 0)} 字，` +
            `冷层读取 ${String(v.latencyMs ?? 0)}ms）。${v.note}`,
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { id: string }
      runtime.recordToolCall()
      const result = await runtime.recoverLongEntry(a.id)
      return {
        ok: result.ok,
        id: result.id,
        status: result.status,
        note: result.note,
        ...(result.tier === undefined ? {} : { tier: result.tier }),
        ...(result.source === undefined ? {} : { source: result.source }),
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
        ...(result.contentChars === undefined ? {} : { contentChars: result.contentChars }),
      }
    },
  })

  return [remember, pushMidMemory, recallLongterm, recallFull, requestCompaction, requestRecallExtension, recover]
}

/** 宽松解析 entities（长期表里存的是 JSON 文本）。 */
function parseEntities(raw: string | null): readonly string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 工具名清单（测试与文档引用同一份，避免写错）。 */
export const MEMORY_TOOL_NAMES = [
  'remember',
  'push_mid_memory',
  'recall_longterm',
  'recall_full',
  'request_compaction',
  'request_recall_extension',
  'recover',
] as const



