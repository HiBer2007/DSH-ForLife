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
 * 构造四个记忆工具。
 *
 * @param defineTool - 宿主的 `defineTool`（来自 `@deepseek-ai/dsh-tools`）。
 * @param runtime - 记忆运行时。
 * @returns 可供 `ctx.tools.register()` 的定义数组。
 */
export function buildMemoryTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  const remember = defineTool({
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
      scope: { type: 'string', description: '可选：来源范围标记，如 group:123456 或 private:10001。' },
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
      const result = runtime.append({
        summary: a.summary,
        ...(a.content === undefined ? {} : { content: a.content }),
        entities,
        sourceScope: a.scope ?? null,
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

  const pushMidMemory = defineTool({
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
      for (const entry of a.entries) {
        const result = runtime.append({
          summary: entry.summary,
          ...(entry.content === undefined ? {} : { content: entry.content }),
          entities: (entry.entities ?? []).slice(0, 5),
          sourceScope: a.scope ?? null,
        })
        added.push({ id: result.id, windowOffset: result.windowOffset, tokenCount: result.tokenCount })
        revision = result.revision
      }
      return { ok: true, added, revision }
    },
  })

  const recallLongterm = defineTool({
    name: 'recall_longterm',
    description: [
      '检索长期记忆里过去的事。返回结果会附带本周期剩余额度。',
      '先想清楚要什么再查；无命中不代表不存在，可以换关键词，但不要为了确认而反复检索。',
      '结果里的 storage_tier = hdd 表示该条已沉降到冷层，需要时可用 recover 提升回来。',
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
              },
            },
          },
          usedThisTurn: { type: 'integer' },
          remainingThisTurn: { type: 'integer' },
          remainingThisCycle: { type: 'integer' },
          note: { type: 'string', description: '无命中或触发额度限制时的说明。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { results: { id: string; summary?: string }[]; note?: string; remainingThisCycle?: number }
        if (v.results.length === 0) return text(v.note ?? '长期记忆无命中。')
        const lines = v.results.map((r, i) => `${String(i + 1)}. [${r.id}] ${r.summary ?? ''}`)
        return text(`${lines.join('\n')}${v.note === undefined ? '' : `\n（${v.note}）`}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { query: string; limit?: number }
      const result = runtime.recallLongterm(a.query, a.limit)
      return {
        ok: true,
        results: result.entries.map((entry) => ({
          id: entry.id,
          summary: entry.summary ?? '',
          entities: parseEntities(entry.entities),
          tier: entry.storage_tier ?? 'ssd',
          createdAt: entry.created_at ?? '',
        })),
        usedThisTurn: result.budget.usedThisTurn,
        remainingThisTurn: result.budget.remainingThisTurn,
        remainingThisCycle: result.budget.remainingThisCycle,
        ...(result.note === undefined ? {} : { note: result.note }),
      }
    },
  })

  const recallFull = defineTool({
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

  return [remember, pushMidMemory, recallLongterm, recallFull]
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
export const MEMORY_TOOL_NAMES = ['remember', 'push_mid_memory', 'recall_longterm', 'recall_full'] as const
