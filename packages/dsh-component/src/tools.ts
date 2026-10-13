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

import { countPendingMaintenanceRequests, enqueueMaintenanceRequest } from '@forlife/store'
import { PERSONA_NAME_MAX_CHARS } from './runtime.ts'
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
  return `${content.slice(0, COLD_CONTENT_MAX_CHARS)}... (body is ${String(content.length)} chars; truncated to the first ${String(COLD_CONTENT_MAX_CHARS)})`
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
  const queries = asked.length === 0 ? '' : ` | searched this turn: ${asked.map((q) => `"${q}"`).join(', ')}`
  return `[budget] ${budget.hint ?? ''}${queries}`
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
      'Write one thing worth remembering long-term into mid-term memory.',
      'Use it for: stable preferences the user expresses, identity facts, long-standing agreements,',
      'conclusions you judge you will need again.',
      'Do NOT use it for: tool-call logs, things you just said, anything readable straight from the',
      'context, one-off transient state.',
      'One thing per call, written as a self-contained sentence (it must make sense when seen alone',
      'later - avoid "he/this/just now" style references).',
    ].join('\n'),
    parameters: {
      summary: { type: 'string', required: true, description: 'One-sentence summary; self-contained, no references.' },
      content: { type: 'string', description: 'Optional: the exact detail worth keeping.' },
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: key entities (people / projects / technologies), at most 5.',
      },
      scope: {
        type: 'string',
        description: 'Optional: source tag. **Usually leave this out** - it defaults to the current conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the write succeeded.' },
          id: { type: 'string', required: true, description: 'Entry id.' },
          windowOffset: { type: 'integer', description: 'Its position in the mid-term memory area.' },
          tokenCount: { type: 'integer', description: 'Estimated tokens this entry occupies.' },
          midTokens: { type: 'integer', description: 'Total mid-term memory tokens after the write.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { id: string; tokenCount: number; midTokens: number }
        return text(
          `Remembered (${v.id}, about ${String(v.tokenCount)} tokens; mid-term memory is now about ${String(v.midTokens)} tokens)`,
        )
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
      'Push several memories into the mid-term memory area at once (the primitive behind compaction).',
      'Difference from remember: this writes many entries in one call (e.g. the output of compacting a',
      'conversation) and returns the new render revision.',
      'Entries are written the same way as remember: one thing each, self-contained, no references.',
    ].join('\n'),
    parameters: {
      entries: {
        type: 'array',
        required: true,
          description: 'The array of entries to write.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
                summary: { type: 'string', required: true, description: 'One-sentence summary.' },
                content: { type: 'string', description: 'The exact detail.' },
                entities: { type: 'array', items: { type: 'string' }, description: 'Key entities.' },
          },
        },
      },
          scope: { type: 'string', description: 'Optional: source-scope tag.' },
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
          revision: {
            type: 'integer',
            required: true,
            description: 'Render revision after the write (the window has changed with it).',
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { added: { id: string }[]; revision: number }
        return text(`Wrote ${String(v.added.length)} mid-term entries (revision ${String(v.revision)})`)
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
    // ★ PLAN §7.3 的**行为约束**就长在这里：5 条使用原则 + 3 条反面示例必须逐条覆盖
    //   （审计 §7.3 曾判"部分一致"：只覆盖了 2.5 条，且第 4 条**语义相反** ——
    //   旧文案写"可以换关键词"，PLAN 写的是"先判断信息是否真的存在，而不是立即换词重试"）。
    //   取舍：这份描述位于**稳定前缀**（L1 工具定义），每多一句都进每次请求的上下文，
    //   所以只写 PLAN 要求的条目 + 机器/模型绕不过去的运维事实（冷层、recover），
    //   不复述 PLAN 原文、不加例子、不加解释性从句。改动本身会造成一次缓存未命中（低频、可接受）。
    description: [
      'Search long-term memory for things from the past. The result carries a **budget statement**',
      '(how many are left this cycle, the reset policy, what you already searched this turn).',
      'How to use it:',
      '- Search only when the short-term context and the current mid-term memory genuinely lack the fact.',
      '- Do not re-search the same topic to "confirm" or "top up" (duplicates are rejected: duplicate_query).',
      '- What comes back is candidate fragments, not a final answer - do not over-associate them.',
      '- If one search returns nothing, first judge whether the fact exists at all, then decide whether to',
      '  reword; do not reword and retry immediately.',
      '- The per-turn budget is limited and is reported on every result; when it is exhausted the search is',
      '  refused - if you truly must search more, use request_recall_extension(reason).',
      'Anti-patterns (do not do these):',
      '- Running 3-4 similar searches in a row "to make sure nothing was missed".',
      '- Doing a pile of speculative searches around a vague fragment you found.',
      '- Forcing unrelated results into the current task.',
      'Cold tier: storage_tier=hdd means the entry has been settled and its body is fetched from the cold',
      'tier on demand (may be a little slower) and returned with the result; a note saying it "could not be',
      'fetched" means the cold-tier read failed - it does NOT mean the thing was never recorded.',
      'To bring an entry back to the hot tier use recover(id) (one at a time).',
    ].join('\n'),
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search keyword or phrase (CJK matches adjacent phrases character by character).',
      },
      limit: { type: 'integer', description: 'How many results you want (capped by a hard limit of 5).' },
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
                createdAt: { type: 'string', description: 'UTC timestamp' },
                content: {
                  type: 'string',
                  description:
                    '**Body of a cold-tier (hdd) entry**: the original text fetched back from the archive on demand. When it cannot be fetched this field is absent and the note explains why.',
                },
              },
            },
          },
          // ★ PLAN §7.1 的预算声明（形状逐字段对齐，数字由 runtime 算好，工具层不自己拼）
          budget: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description:
            'The PLAN §7.1 budget statement. used/limit/remaining are **per-cycle** figures (reset_at says when it resets).',
            properties: {
                          used: { type: 'integer', required: true, description: 'Searches used this cycle.' },
                          limit: {
              type: 'integer',
              required: true,
              description: 'This cycle\'s limit (recall.maxPerCycle), **including** any extension already granted.',
                          },
                          remaining: { type: 'integer', required: true, description: 'Searches left this cycle.' },
              reset_at: {
                type: 'string',
                required: true,
                description: 'Reset policy (read from the baseline key recall.resetPolicy; currently on_compaction).',
              },
              queries_this_turn: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: 'Search terms already used this turn (bounded) - do not re-search near-identical topics.',
              },
              hint: { type: 'string', required: true, description: 'How many are left / which tool to call when they run out.' },
              per_turn: {
                type: 'object',
                required: true,
                additionalProperties: false,
                description:
            '**Per-turn** budget (there are two gates: per turn + per cycle - you need to know both).',
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
                description:
            'State of the escape hatch (how much was granted this cycle, the per-request maximum, the cooldown in turns).',
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
          note: {
            type: 'string',
            description: 'Explanation when there were no hits, a budget limit was hit, or the cold tier could not be read.',
          },
          // ★ PLAN §7.4 的 `duplicate_query` 必须是一个**码**，不能只是一句人话
          //   （只写进 note 的话，模型与将来的面板/统计都只能去正则匹配自然语言）。
          refusal: {
            type: 'object',
            additionalProperties: false,
            description:
            'Machine-readable reason code when refused (PLAN §7.4\'s duplicate_query lands here). Absent on a normal/approved result.',
            properties: {
              code: {
                type: 'string',
                required: true,
                description:
            'duplicate_query (repeat search) / turn_exhausted (per-turn budget used up) / cycle_exhausted (per-cycle budget used up).',
              },
              hint: { type: 'string', required: true, description: 'What to do about it (the actionable sentence).' },
              matchedQuery: {
            type: 'string',
            description: 'Which already-used query it collided with (only present for duplicate_query).',
          },
              similarity: {
            type: 'number',
            description: 'Approximate similarity 0..1 (only for duplicate_query; **not** semantic similarity).',
          },
              threshold: {
            type: 'number',
            description: 'The decision threshold (read from the baseline key recall.duplicateSimilarity).',
          },
            },
          },
          // ★ PLAN §7.4 的「同轮连续 N 次以上检索时强制附加提示」：
          //   提示同时写进 note（模型一定看得到），这里再给一份结构化的 —— 面板/统计不必去正则匹配中文。
          associationWarn: {
            type: 'object',
            additionalProperties: false,
            description:
              'Associative-depth warning (appears once same-turn searches reach the baseline key recall.associativeDepthWarn; the same sentence is also in the note).',
            properties: {
              depth: { type: 'integer', required: true, description: 'Which search this is this turn (including this one).' },
              warnAt: {
              type: 'integer',
              required: true,
              description: 'The trigger threshold (read from the baseline key recall.associativeDepthWarn).',
                          },
                          hint: { type: 'string', required: true, description: 'The warning text itself.' },
            },
          },
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
            ? (v.note ?? 'No hits in long-term memory.')
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
        budget: result.declaration,
        // 旧字段保留（兼容）：平铺是历史形状，见文件头的"兼容性说明"
        usedThisTurn: result.budget.usedThisTurn,
        remainingThisTurn: result.budget.remainingThisTurn,
        remainingThisCycle: result.budget.remainingThisCycle,
        ...(result.note === undefined ? {} : { note: result.note }),
        // ★ PLAN §7.4 的拒绝码（`duplicate_query` / 两道额度闸门）**原样透传**；
        //   说明同时也进了 note，所以 render 出来模型一定看得到（不依赖它读结构化字段）。
        ...(result.refusal === undefined ? {} : { refusal: result.refusal }),
        // ★ PLAN §7.4 的联想深度提示：**原样透传**（提示原文已在 note 里 ⇒ 一定会渲染）
        ...(result.associationWarn === undefined ? {} : { associationWarn: result.associationWarn }),
      }
    },
  })

  const recallFull = defineSpillingTool({
    name: 'recall_full',
    description: [
      'Fetch the full text of a large result that was truncated earlier (only its first few lines were',
      'kept in the context).',
      'Use it when you need exact content (a full log, a full list, the original error) instead of guessing',
      'at the truncated part from memory.',
    ].join('\n'),
    parameters: {
      id: { type: 'string', required: true, description: 'The spill id given when it was truncated.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean', required: true },
          content: { type: 'string', description: 'The full content (only present when found=true).' },
          toolName: { type: 'string' },
          bytes: { type: 'integer' },
          lines: { type: 'integer' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { found: boolean; content?: string; toolName?: string; lines?: number }
        if (!v.found) return text('No such spill record (the id may have expired or been cleaned up).')
        return text(
          `Fetched the full result of ${v.toolName ?? 'the tool'} (${String(v.lines ?? 0)} lines):\n${v.content ?? ''}`,
        )
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

  /**
   * ★★ `recall_mid` —— **中期记忆的回填路径**（`FIX_PLAN.md` D2 / P0-a）。
   *
   * ## 为什么必须有它
   *
   * 中期记忆区只有预算内的一段会进上下文（`memory.midWindow.maxTokens`）。
   * 线上实测：**全表 1,555,127 token，窗口内只有 99.9k —— 94% 落在窗口外。**
   *
   * 而窗口外的条目**摘要与正文都不在模型眼前，且当时没有任何工具能取回来**：
   *  - `recall_full` 取的是**溢出工具结果**（spill），不是中期条目；
   *  - `recover(id)` 只处理**长期**冷层条目，且不含正文；
   *  - `recall_longterm` 自己的中期兜底 `return this.recallResult([], …)`
   *    —— **返回空数组**，命中的条目从来没被当内容返回（它只用来数个数、生成一句 note）。
   *
   * `runtime.ts:580-588` 的注释里，代码自己承认了这件事：
   * 「真要给一条回填路径，得先有『按 id 取中期条目正文』的工具」。
   * **这个工具就是它。**
   */
  const recallMid = defineSpillingTool({
    name: 'recall_mid',
    description: [
      'Fetch the body of a **mid-term memory entry** by id - the past that has slid out of the context',
      'window and is no longer in front of you.',
      'When to use it: `recall_longterm` tells you "there are N related entries in mid-term memory, but',
      'they have all slid out of the current context window and this search cannot fetch them back", and one',
      'of those N may be exactly what you need. This is the only way to get them back.',
      '⚠️ One entry per call. What you fetch takes up context budget again - fetch on demand, do not batch-',
      'fetch just "to see what is there".',
      '⚠️ The `inWindow` field tells you whether it was already in front of you (if true, you do not need it).',
    ].join('\n'),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Mid-term entry id (given by the recall hint or shown in the panel).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean', required: true },
          content: { type: 'string', description: 'The entry body (only present when found=true).' },
          summary: { type: 'string' },
          status: {
            type: 'string',
            description: 'active, or fragmented (already settled - its body now lives in long-term memory).',
          },
          inWindow: { type: 'boolean', description: 'true = it was already in the current context; no need to fetch.' },
          tokens: { type: 'integer' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as {
          found: boolean
          content?: string
          summary?: string
          status?: string
          inWindow?: boolean
          tokens?: number
        }
        if (!v.found) return text('No such mid-term memory (wrong id, or it was archived/cleaned up).')
        const head =
          `Fetched one mid-term memory (${String(v.tokens ?? 0)} tokens, status=${v.status ?? '?'}` +
          `${v.inWindow === true ? ', ⚠️ it was already in your context' : ''}):\n`
        return text(`${head}${v.summary === undefined ? '' : `[summary] ${v.summary}\n`}${v.content ?? ''}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { id: string }
      // 走 `runtime.listEntries()` 而不是新引一个 store 函数：
      // `tools.ts` 至今**只依赖 `MemoryRuntime` 这一个数据入口**（见文件头的 import），
      // 保持这条边界比省一次全表扫描重要 —— 这个工具是罕见的显式调用，不是热路径。
      const row = runtime.listEntries().find((entry) => entry.id === a.id)
      if (row === undefined) return { ok: true, found: false }
      return {
        ok: true,
        found: true,
        content: row.content ?? row.summary,
        summary: row.summary,
        status: row.status,
        inWindow: runtime.midWindow().entries.some((entry) => entry.id === row.id),
        tokens: row.token_count,
      }
    },
  })

  const requestCompaction = defineSpillingTool({
    name: 'request_compaction',
    description: [
      'Request compaction of this conversation (distil the short-term trace into mid-term memory and keep',
      'the current state as a one-line summary).',
      'The system decides using the PLAN §4.4 thresholds and cooldown: too thin (not enough content) or too',
      'frequent will be refused, and it tells you how far off you are.',
      'A good moment to ask: you have finished several turns of real work, and the intermediate state of the',
      'current task no longer needs all its detail kept.',
      'Do not ask repeatedly just to "clear the context" - when refused, the required/current figures ARE the',
      'criterion; build up to them and come back.',
    ].join('\n'),
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why compact (goes into the compaction log and the audit trail).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean', required: true },
          reason: { type: 'string', description: 'Refusal reason code: too_thin / too_frequent.' },
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
          hint: { type: 'string', description: 'How far off you are / why it cannot happen now.' },
          waiver: { type: 'string', description: 'Which waiver applied: token_threshold / context_pressure.' },
          queued: { type: 'boolean', description: 'Whether it is queued for the next compaction decision.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { approved: boolean; reason?: string; hint?: string; waiver?: string }
        if (v.approved) {
          return text(
          `Compaction approved${v.waiver === undefined ? '' : ` (waiver: ${v.waiver})`}, queued - it runs at the next compaction decision.`,
        )
        }
        return text(`Compaction refused (${v.reason ?? 'unknown'}): ${v.hint ?? ''}`)
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
      'When the recall budget genuinely is not enough and you absolutely must search, request a **temporary**',
      'extension of the search budget.',
      'The reason must be specific (what you need to search, why it is unavoidable) - too-short requests are',
      'refused; a refusal tells you how many turns of cooldown remain.',
      'It is cooldown-limited (several turns must pass between approvals) and grants a fixed number at most;',
      'the granted amount is reported truthfully on the next recall result.',
      'This is not the normal channel for "I want to search a few more times": first judge whether the fact',
      'really exists, and do not use it to "make sure nothing was missed".',
    ].join('\n'),
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why the extension is necessary (be specific: what to search, why the current information is insufficient).',
      },
      additional: {
        type: 'integer',
        description:
          'How many to request; omitted = the maximum. Exceeding the per-request maximum is refused explicitly (never silently clamped).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          granted: { type: 'boolean', required: true, description: 'Whether it was approved.' },
          reason: {
            type: 'string',
            description: 'Refusal reason code: reason_too_short / bad_amount / beyond_max / too_frequent.',
          },
          hint: {
            type: 'string',
            required: true,
            description: 'The budget change after approval, or the exact refusal reason and how many turns remain.',
          },
          additional: { type: 'integer', required: true, description: 'How many were actually granted (0 when refused).' },
          perTurnLimit: { type: 'integer', required: true, description: 'The per-turn budget in effect after the decision.' },
          perCycleLimit: { type: 'integer', required: true, description: 'The per-cycle budget in effect after the decision.' },
          cooldownTurns: { type: 'integer', required: true, description: 'Cooldown between two approvals (in turns).' },
          cooldownRemainingTurns: {
            type: 'integer',
            description: 'How many turns before you may ask again (only present when refused for cooldown).',
          },
          grantedThisCycle: { type: 'integer', required: true, description: 'Total extension granted this cycle.' },
          maxPerRequest: { type: 'integer', required: true, description: 'The per-request maximum.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { granted: boolean; additional: number; reason?: string; hint: string; perCycleLimit: number }
        if (v.granted) {
          return text(
          `Granted ${String(v.additional)} extra searches (this cycle\'s limit is now ${String(v.perCycleLimit)}). ${v.hint}`,
        )
        }
        return text(`Extension refused (${v.reason ?? 'unknown'}): ${v.hint}`)
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
      'Promote one long-term memory that has **settled into the cold tier** (storage_tier=hdd) back to the',
      'hot tier (its body returns to the database, so later reads no longer go through the archive).',
      'When to use it: you are confident a particular old memory will be used repeatedly from now on, and',
      'right now every read of its body goes to the cold tier (slow).',
      'One at a time (batch promotion would wipe out the point of settling in one go). An entry already in the',
      'hot tier says "no promotion needed" - it does **not** pretend to succeed.',
      'If the cold-tier archive cannot be read, it reports failure explicitly - that is NOT "this memory does',
      'not exist"; do not change your answer because of it.',
    ].join('\n'),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Long-term memory entry id (the id from a recall_longterm result).',
      },
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
            description:
            'recovered (promoted) / not_found / already_hot (was already hot) / archive_unreadable (cold tier unreadable).',
          },
          note: { type: 'string', required: true, description: 'What happened and why.' },
          tier: { type: 'string', description: 'The tier after promotion (or the original tier).' },
          source: {
            type: 'string',
            description: 'Where the body was read from: archive (genuinely promoted from cold) / db / none.',
          },
          latencyMs: { type: 'integer', description: 'Read latency in ms (cold-tier latency must be visible).' },
          contentChars: { type: 'integer', description: 'Length of the backfilled body (characters).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; id: string; status: string; note: string; contentChars?: number; latencyMs?: number }
        if (!v.ok) return text(`Did not promote ${v.id} (${v.status}): ${v.note}`)
        return text(
          `Promoted ${v.id} back to the hot tier (body ${String(v.contentChars ?? 0)} chars, ` +
            `cold-tier read ${String(v.latencyMs ?? 0)}ms). ${v.note}`,
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

  /**
   * ★★ 2026-10-11（用户裁定「**B 的设计可以**」，见 `FIX_PLAN.md` §58 / §68）：
   * **人格名字由模型自己决定，初始为空。**
   *
   * ## 用户原话
   * 「人格名字不是多次声明应当**由记忆决定**而不由提示词决定吗？
   *   如果确实需要由提示词决定，也应该是一个**工具**，**初始为空**，可以**由模型修改**啊。」
   *
   * ## 它写在哪、什么时候生效
   * ★ 写进 `forlife_state`（`PERSONA_NAME_STATE_KEY`），
   *   由 `runtime.promptVariables()` 在**每轮装配系统提示词时**读回。
   * ★ 所以下一次装配就生效 —— 但它**在稳定前缀里**（`persona_name` 是 `dynamic: false`），
   *   改一次会换来**一次缓存未命中**。★ 这决定了描述里那句"**别频繁改**"。
   *
   * ## ★ 为什么描述里要写"这不是必须的"
   * ★ 用户的设计是「**由记忆决定**」—— 名字是**自己长出来的**，不是开局就填的字段。
   * ⇒ ★ 描述必须说清"**没有名字也完全可以**"，否则模型会以为这是必填项、
   *   开局随便安一个（那正是"由提示词决定"的老毛病换个地方复发）。
   */
  const setPersonaName = defineSpillingTool({
    name: 'set_persona_name',
    description: [
      'Decide / change **your own name**.',
      '★ **This is not required**: having no name is completely fine. A name should **grow out of** how you',
      'and the other person are together, not be pinned on casually just to fill a field. If you have not',
      'thought it through, **do not call this yet**.',
      'What you are called is **your business**, but each change invalidates the prompt cache once (the name',
      'lives in the stable prefix) => **do not change it often**.',
      'An empty string = **clear it** (back to "no name yet").',
    ].join('\n'),
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: `Your name (at most ${String(PERSONA_NAME_MAX_CHARS)} characters, no line breaks). An empty string clears it.`,
      },
      reason: {
        type: 'string',
        description: 'Optional: why you decided on this now (for your own future reference).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the write succeeded.' },
          name: { type: 'string', required: true, description: 'The name after writing; an empty string means it was cleared.' },
          error: { type: 'string', description: 'Failure reason (too long / contains a line break / contains a variable marker).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; name?: string; error?: string }
        if (!v.ok) return text(`**Not changed**: ${v.error ?? 'unknown reason'}`)
        return text(
          v.name === '' || v.name === undefined
            ? 'Name cleared - for now you have no name.'
            : `From now on your name is "${v.name}".`,
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { name: string }
      runtime.recordToolCall()
      try {
        const written = runtime.setPersonaName(a.name)
        return { ok: true, name: written }
      } catch (error) {
        return { ok: false, name: '', error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  /**
   * ★★ 2026-10-11（用户裁定，`FIX_PLAN.md` §69）：**沉降循环的间隔**。
   *
   * ## 用户原话
   * 「沉降循环不用 30 分钟一轮这么频繁，可以**可调**，**最低为惰性**
   *  （即**被动模式，不主动通过计时器来触发**）同样由**模型和外部共同决定**，
   *   且在**工具的说明中提示 AI 越低越好（遗忘慢、省钱）**，**默认为惰性**」
   *
   * ## ★★ 描述里那句"越低越好"是**用户点名要的**
   * ★ 它是这条工具存在的意义：模型天然倾向于"多做点事"，而沉降是**低频运维**动作 ——
   * ★ **跑得越勤，忘得越快**（条目被推去长期记忆、从眼前消失），**也越费钱**（每轮都要扫表与读写）。
   * ★ 所以描述必须把**代价**讲清楚，而不是只说"你可以调"。
   *
   * ## 惰性（0）意味着什么
   * ★ 循环**仍然存在**（`tick()` 仍可手动跑），只是**不排计时器**。
   * ★ 也就是说：**没有任何东西会自动沉降** —— 那正是"遗忘最慢"的档。
   */
  const setSettleInterval = defineSpillingTool({
    name: 'set_settle_interval',
    description: [
      'Set how often **memory settling** (mid-term -> long-term) runs automatically.',
      '',
      '★★ **LOWER IS BETTER.** The more often it runs, the **faster you forget** (entries get pushed',
      'into long-term memory and disappear from your view) and the **more it costs** (every round',
      'scans and writes). The default is **passive** (`0`) - the cheapest, least-forgetful setting.',
      '',
      '★★ **If you feel "the mid-term area is too crowded / retrieval is getting slow":**',
      '★ **do NOT reach for this tool first.** Use **`settle_mid_now`** to settle once, right now.',
      '★ **Both do exactly the same work** - `settle_mid_now` and this timer call the very same',
      'settle routine; the ONLY difference is who pulls the trigger (you vs. a clock).',
      '★ So the manual one is strictly better for a one-off squeeze: it costs nothing while idle,',
      'and it does not change your forgetting rate behind your back.',
      '★ Only set a timer here if the crowding is **chronic** and you want it handled unattended.',
      '',
      'Value: `0` = **passive** (never runs on its own; only you or ops trigger it);',
      'otherwise an interval in milliseconds. Reference: once a day = `86400000`,',
      'once an hour = `3600000`. **Below 30 minutes (`1800000`) is not recommended** - that is just',
      'scanning the table for nothing.',
      '★ Ops can override you with the env var `FORLIFE_SETTLE_INTERVAL_MS`.',
    ].join('\n'),
    parameters: {
      intervalMs: {
        type: 'integer',
        required: true,
        description: 'Interval in ms; 0 = passive (never runs automatically). ★ Bigger = cheaper, forgets slower.',
      },
      reason: { type: 'string', description: 'Optional: why you are changing this (for your own future reference).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the write succeeded.' },
          intervalMs: { type: 'integer', required: true, description: 'The interval after writing (0 = passive).' },
          error: { type: 'string', description: 'Failure reason (negative / invalid value).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; intervalMs?: number; error?: string }
        if (!v.ok) return text(`**Not changed**: ${v.error ?? 'unknown reason'}`)
        if (v.intervalMs === 0) {
          return text('Settling is now **passive**: it will not run on its own (cheapest, forgets slowest).')
        }
        const ms = v.intervalMs ?? 0
        const human =
          ms >= 3_600_000
            ? `${String(Math.round(ms / 3_600_000))} hour(s)`
            : `${String(Math.round(ms / 60_000))} minute(s)`
        return text(`Settling interval set to once every **${human}**.`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { intervalMs: number }
      runtime.recordToolCall()
      try {
        return { ok: true, intervalMs: runtime.setSettleInterval(Number(a.intervalMs)) }
      } catch (error) {
        return { ok: false, intervalMs: 0, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ★ `recallMid` 紧跟在 `recallFull` 之后：两个都是"把当时看不见的东西捞回来"的回填路径，
  //   放在一起读的人一眼能看到它们是**一对**（一个捞工具结果，一个捞中期记忆）。
  /**
   * ★★ 2026-10-11（用户裁定）：**手动触发一次中期沉降**。
   *
   * ## 用户原话
   * 「明确感到"中期区太挤、检索变慢" 应该提醒模型此情况下**优先使用手动触发中期压缩的工具**，
   *   而不是**首选启动自动触发机制**。提醒模型**二者的工作原理完全一致**。」
   *
   * ## ★ 为什么这个工具是必要的（它是本次补上的缺口）
   * ★ 在它存在之前，模型**只有** `set_settle_interval`（开定时器）这一条路 ——
   *   ★ 想压一次就得**永久改变自己的遗忘速率**，而那是个副作用远大于收益的动作。
   * ★ 现在：**一次性需求用一次性手段**。
   *
   * ## ★★ "二者的工作原理完全一致" 是真的（不是安慰话）
   * ★ 它与定时器**调用同一个** `runtime.settle()`：
   *   定时器的 `tick()` 就是 `target.settle(...)`（见 `startSettleTimer`），
   *   本工具的 `execute` 也是 `runtime.settle(...)` ⇒ ★ **同一条代码路径、同一套判据**。
   * ★ 唯一的区别是**谁扣扳机**（模型 vs 时钟）。
   */
  const settleMidNow = defineSpillingTool({
    name: 'settle_mid_now',
    description: [
      'Settle the mid-term area **once, right now** (mid-term -> long-term memory).',
      '',
      '★ Use this when you **actually feel the squeeze**: the mid-term area is crowded,',
      'recall is getting slow, or `recall_mid` keeps missing things you know you stored.',
      '★ This is the **preferred** way to relieve that - **prefer it over turning on the auto timer**',
      '(`set_settle_interval`), because a one-off squeeze deserves a one-off fix: this costs nothing',
      'while idle and does **not** change your forgetting rate behind your back.',
      '',
      '★★ **This and the auto timer do EXACTLY the same work** - same routine, same rules,',
      'same order. The only difference is who pulls the trigger.',
      '★ So there is no "stronger" or "gentler" mode to pick between; pick based on whether the',
      'need is **one-off** (use this) or **chronic** (set a timer).',
      '',
      'It may settle nothing (nothing qualifies yet) - the result says why, in plain words.',
    ].join('\n'),
    parameters: {
      reason: { type: 'string', description: 'Optional: why you are settling now (for your own future reference).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the settle ran (it may still settle 0 items).' },
          fragmented: { type: 'integer', required: true, description: 'How many mid-term entries became fragments.' },
          archived: { type: 'integer', required: true, description: 'How many fragments were archived.' },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Plain-words notes - including why nothing was settled, when that is the case.',
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; fragmented?: number; archived?: number; notes?: string[] }
        if (!v.ok) return text('**Could not settle** (see notes).')
        const did = (v.fragmented ?? 0) + (v.archived ?? 0)
        const detail = (v.notes ?? []).join('; ')
        return text(
          did === 0
            ? `Settled nothing this time. ${detail}`
            : `Settled: ${String(v.fragmented ?? 0)} entr(ies) -> fragments, ${String(v.archived ?? 0)} archived. ${detail}`,
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { reason?: string }
      runtime.recordToolCall()
      try {
        const result = runtime.settle()
        return { ok: true, fragmented: result.fragmented, archived: result.archived, notes: [...result.notes] }
      } catch (error) {
        return {
          ok: false,
          fragmented: 0,
          archived: 0,
          notes: [error instanceof Error ? error.message : String(error)],
        }
      }
    },
  })
  /**
   * ★★ 2026-10-11（用户裁定，`FIX_PLAN.md` §72 / §74）：**请求跑一轮维护**。
   *
   * ## 用户原话
   * 「所有的沉降**都有手动触发途径，都有工具触发途径**」
   * （PLAN `src-01.md:342`「按需触发**沉降/碎片维护/复盘**任务」·
   *   `src-08.md:346`「碎片索引合并与淘汰（**定时 + 手动**）」）。
   *
   * ## ★ 为什么是"请求"而不是"直接跑"
   * ★ 维护循环**只该有一个 owner**：`settle-loop.ts` 的模块头写明了
   *   ① **冷层根路径（`FORLIFE_ROOT_COLD`）只有那个进程解析得到**；
   *   ② HDD 沉降是**全局运维**，而插件可能被多个 profile 各起一份
   *   ⇒ ★ 让每个 profile 都去搬文件 = **互相踩**。
   * ★ 所以本工具**写一条请求**，由 owner 认领并执行 ——
   *   ★ 与 `wake_requests` 同一套"**数据库即通道**"。
   *
   * ## ★★ 认领之后跑的是**同一条 `tick()`**
   * ★ 这是"手动与自动同一引擎"的凭据 ⇒ ★ 本工具**不会**产生"另一套参数"。
   */
  const requestMaintenance = defineSpillingTool({
    name: 'request_maintenance',
    description: [
      'Ask the maintenance owner to run a maintenance round over your memory storage.',
      '',
      '★ Use this when you want the **storage side** tidied up: the mid-term/long-term area is',
      'crowded, recall is getting slow, or you suspect the memory index has drifted.',
      '',
      'Kinds:',
      '- `fragments` - only merge and evict the **fragment index** (PLAN names this one explicitly).',
      '  Fast, touches no files, and is the right pick for "the index feels bloated".',
      '- `full` - also move blob files between storage tiers and settle long-term memory to cold',
      '  storage. Slower, and it touches files, so prefer `fragments` unless you really need this.',
      '',
      '★★ **This does not run immediately** - it writes a request that the maintenance owner picks',
      'up (the owner is a single process by design: the cold-tier paths only exist there, and',
      'letting every profile move files would have them trip over each other).',
      '★★ **When it does run, it runs exactly the same routine as the automatic timer** - same code,',
      'same rules, same order. There is no separate "manual mode" with different behaviour.',
      '',
      '★ This is a request, not a command: if the owner is not running, nothing happens - the',
      'request stays queued and is picked up when it comes back.',
    ].join('\n'),
    parameters: {
      kind: {
        type: 'string',
        required: true,
        description: "Either 'fragments' (index only, fast, no file moves) or 'full' (also moves files).",
      },
      reason: { type: 'string', description: 'Optional: why you are asking (for your own future reference).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the request was recorded.' },
          id: { type: 'string', required: true, description: 'The request id.' },
          kind: { type: 'string', required: true, description: 'The kind that was recorded.' },
          pending: { type: 'integer', description: 'How many requests are now waiting (including this one).' },
          error: { type: 'string', description: 'Failure reason.' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; kind?: string; pending?: number; error?: string }
        if (!v.ok) return text(`**Could not record the request**: ${v.error ?? 'unknown reason'}`)
        return text(
          `Maintenance requested (\`${v.kind ?? '?'}\`). ` +
            `${String(v.pending ?? 0)} request(s) now waiting for the owner to pick up.`,
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as { kind: string; reason?: string }
      runtime.recordToolCall()
      try {
        const kind = a.kind === 'fragments' ? 'fragments' : 'full'
        const id = enqueueMaintenanceRequest(runtime.db, {
          kind,
          requestedBy: 'tool:request_maintenance',
          reason: a.reason,
        })
        return { ok: true, id, kind, pending: countPendingMaintenanceRequests(runtime.db) }
      } catch (error) {
        return { ok: false, id: '', kind: a.kind, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  return [remember, pushMidMemory, recallLongterm, recallFull, recallMid, requestCompaction, requestRecallExtension, recover, setPersonaName, setSettleInterval, settleMidNow, requestMaintenance]
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
  // ★ `recall_mid`：中期记忆的回填路径（`FIX_PLAN.md` D2 / P0-a）。
  //   漏在这里 ⇒ `tool-spill-wiring.test.ts` 那条"走接缝的定义数 = 注册的工具数"立刻变红。
  'recall_mid',
  'request_compaction',
  'request_recall_extension',
  'recover',
  // ★ 2026-10-11：人格名字（用户裁定「B 的设计可以」，见 `setPersonaName` 的说明）。
  //   漏在这里 ⇒ `tool-spill-wiring.test.ts` 那条"走接缝的定义数 = 注册的工具数"立刻变红。
  'set_persona_name',
  // ★ 2026-10-11：沉降间隔（用户裁定「可调、最低惰性、默认惰性」，见 `setSettleInterval` 的说明）。
  'set_settle_interval',
  // ★ 2026-10-11：手动触发一次中期沉降（用户裁定「**优先手动触发**，而不是首选启动自动机制」，
  //   见 `settleMidNow` 的说明）。★ 漏在这里 ⇒ `tool-spill-wiring.test.ts` 那条
  //   "走接缝的定义数 = 注册的工具数"立刻变红。
  'settle_mid_now',
  // ★ 2026-10-11：请求跑一轮维护（用户裁定「所有的沉降都有工具触发途径」）。
  'request_maintenance',
] as const



