/**
 * 记忆工具（阶段 1 的四个）。
 *
 * 全部用 `defineTool` 定义，遵守宿主的三条硬规矩：
 *  1. `output` **必填**，且 `output.render` 是**纯函数**（只做投影，不产生副作用）；
 *  2. 对象节点必须显式声明 `additionalProperties`（否则 JSON Schema 会带上意外默认值）；
 *  3. `execute` 只返回**规范化 JSON 值**，不返回展示文本。
 *
 * 工具描述（`description`）是写给模型看的"说明书"，所以刻意写得像说明书：
 * 说清什么时候用、什么时候别用、边界在哪。这也是"提示词可编辑"之外唯一由代码控制的引导面。
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

/**
 * 构造四个记忆工具。
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
      '检索长期记忆里过去的事。返回结果会附带本周期剩余额度。',
      '先想清楚要什么再查；无命中不代表不存在，可以换关键词，但不要为了确认而反复检索。',
      '结果里的 storage_tier = hdd 表示该条已沉降到冷层：它的正文会**按需从冷层取回**（可能稍慢），随结果一起返回。',
      '若 note 里说某条"取不回来"，那是**冷层读取失败**，不代表这件事没记过 —— 不要据此当作"记忆里没有"。',
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
          usedThisTurn: { type: 'integer' },
          remainingThisTurn: { type: 'integer' },
          remainingThisCycle: { type: 'integer' },
          note: { type: 'string', description: '无命中、触发额度限制、或冷层取不回来时的说明。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { results: { id: string; summary?: string; content?: string }[]; note?: string; remainingThisCycle?: number }
        if (v.results.length === 0) return text(v.note ?? '长期记忆无命中。')
        const lines = v.results.map((r, i) => {
          const head = `${String(i + 1)}. [${r.id}] ${r.summary ?? ''}`
          // 冷层正文是**按需取回来的**（取不回来时 runtime 会在 note 里说清）
          return r.content === undefined ? head : `${head}\n   ↳ ${r.content}`
        })
        return text(`${lines.join('\n')}${v.note === undefined ? '' : `\n（${v.note}）`}`)
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

  return [remember, pushMidMemory, recallLongterm, recallFull, requestCompaction]
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
export const MEMORY_TOOL_NAMES = ['remember', 'push_mid_memory', 'recall_longterm', 'recall_full', 'request_compaction'] as const



