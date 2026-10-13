/**
 * 「手动喂食记忆资料」的**模型工具面** —— `feed_memory`。
 *
 * ## 为什么模型自己也要有一个
 *
 * 用户的明确要求：喂食这件事"更多应该由**模型自己决定**"。
 * 人给的是入口（CLI / 面板 / HTTP），但"这段话该记成知识还是经历"这种判断，
 * 只有模型在语境里做得了 —— 所以它必须有一个可调用的工具，而不是只能等人来喂。
 *
 * ## 它写的是**真记忆**，和 `remember` 不是一回事
 *
 *  - `remember`：模型把**关于对话/用户**的一件事写进中期记忆（没有来源，不可重导）；
 *  - `feed_memory`：把**一段外部资料**喂进记忆，带**来源**，于是可以：
 *    同源重导（更新的段落自动更新）、跨来源判重（已有记忆里几乎相同的段落不重复写）。
 *
 * ## 分块/去重/删除都不在这里
 *
 * 这个文件只做"参数 → 投喂子系统（`feedInput()`）→ 把结果说成人话"。
 * 输入形态、切分（含单条天花板）、分批、批间让出、去重、归档全是
 * 记忆系统既有能力（用户原话："尤其是分块和去重这本就是属于记忆系统的一部分"），
 * 实现与理由见 `packages/gateway/src/feed.ts` / `feed-batch.ts` 的模块头。
 *
 * ## ★ 它也要**告知工作模式**（2026-10-09）
 *
 * 模型自己调这个工具时，**本轮的系统提示词早就装配完了** ——
 * 提示段里那段"你在半梦半醒 / 这些是前世的记忆"它这一轮看不到。
 * 所以工具返回里必须**同时**带上同一份措辞（`feedDigestNote()`）：
 * 那是她这一轮唯一能知道"我刚才是把过去收进记忆，不是在跟人对话"的地方。
 *
 * @module forlife-memory/feed-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { FEED_DELETE_HINT, FEED_KINDS, feedDigestNote, feedInput, firstFeedResult, isFeedKind, type FeedItem } from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 文本结果。 */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 工具名（测试与文档共用一份；注册日志里也用它）。 */
export const FEED_TOOL_NAMES = ['feed_memory'] as const

/** `feed_memory` 的执行结果（面板/日志之外，模型看到的就是这份）。 */
export interface FeedToolOutcome {
  readonly ok: boolean
  readonly as: string
  readonly source: string
  readonly scope: string
  readonly inserted: number
  readonly updated: number
  readonly duplicates: number
  readonly unchanged: number
  readonly archived: number
  readonly tokens: number
  readonly error?: string
  /** 人话补充：判重/归档/失败原因，模型据此决定下一步。 */
  readonly note: string
}

/**
 * 构造喂食工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时（提供共享数据库句柄）。
 * @returns 工具定义数组（交给 `index.ts` 的 `registerOne` 注册）。
 */
export function buildFeedTools(defineTool: DefineToolLike, runtime: MemoryRuntime): readonly unknown[] {
  const feedTool = defineTool({
    name: 'feed_memory',
    description: [
      'Feed a piece of **external material** into memory (you decide whether it counts as knowledge or experience).',
      'as=knowledge: goes into long-term memory (facts, material, conclusions) - recallable only through search later, but never compacted away.',
      'as=experience: goes into mid-term memory (what happened, how it went) - part of the current context and subject to compaction/fragmentation.',
      'Unlike `remember`, which records "one thing about the conversation or the user" (no source),',
      'this tool records **a piece of sourced material**; feeding the same source again **updates** the matching sections instead of storing them a second time.',
      'Style: one thing per section, self-contained (understandable when seen alone later; avoid "it/this/just now" references).',
      'Use items when **one call feeds a multi-section document** (section numbering is per call) -',
      'do not feed one section per call under the same source: same-source updates match by section index, so a later section would overwrite an earlier one.',
      'To delete what was fed, use the existing memory management (panel archive / memory-archive); there is **no** separate delete tool.',
    ].join('\n'),
    parameters: {
      as: {
        type: 'string',
        required: true,
        enum: [...FEED_KINDS],
        description: 'knowledge = long-term knowledge (facts/material); experience = experience (goes into mid-term memory).',
      },
      content: { type: 'string', description: 'One section of content to feed (either this or items).' },
      items: {
        type: 'array',
        description: 'Multiple sections to feed (either this or content; feed a whole document in one call).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'Content of this section.' },
            summary: { type: 'string', description: 'Optional: summary of this section.' },
          },
        },
      },
      summary: { type: 'string', description: 'Optional: summary of content (otherwise truncated from the first line).' },
      source: {
        type: 'string',
        description:
          'Optional: source (file name / batch name). **Same source = the same document**; re-importing updates the matching sections. If omitted it is derived from the content.',
      },
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: key entities (people / projects / technologies), at most 5.',
      },
      whole: {
        type: 'boolean',
        description:
          'Optional: **feed as one block** - do not split this content into several entries by blank or heading lines; it is stored as **one** entry.' +
          'When to use it: you judge that the whole passage should count as **one thing** (a whole conversation, a whole note, one complete document).' +
          'Default false = split by section (one entry per section).' +
          'Warning: even with it, a single entry still has a **token ceiling**: anything over it is cut mechanically at sentence boundaries (that keeps the context from blowing up; it does not decide granularity for you).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the write succeeded.' },
          as: { type: 'string', required: true, description: 'Where it was actually written (knowledge/experience).' },
          source: { type: 'string', required: true, description: 'The source actually used (reuse the same one when re-importing).' },
          scope: { type: 'string', required: true, description: 'The source tag in the store (feed:...); search or archive by it.' },
          inserted: { type: 'integer', required: true, description: 'Number of sections inserted.' },
          updated: { type: 'integer', required: true, description: 'Number of sections updated by a same-source re-import.' },
          duplicates: { type: 'integer', required: true, description: 'Number of sections skipped as already remembered.' },
          unchanged: { type: 'integer', required: true, description: 'Number of sections identical to the store (unchanged).' },
          archived: { type: 'integer', required: true, description: 'Number of sections archived because the previous version had more.' },
          tokens: { type: 'integer', required: true, description: 'Estimated tokens of the content fed this time.' },
          error: { type: 'string', description: 'Failure reason (when ok=false).' },
          note: { type: 'string', required: true, description: 'Plain-language note (dedup / archive / failure reason).' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as FeedToolOutcome
        if (!v.ok) return text(`feed failed: ${v.error ?? 'unknown reason'}`)
        const kind = v.as === 'knowledge' ? 'long-term memory (knowledge)' : 'mid-term memory (experience)'
        return text(`Fed into ${kind}: ${String(v.inserted)} inserted / ${String(v.updated)} updated / ${String(v.duplicates)} skipped as duplicates (source ${v.source}). ${v.note}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const a = args as {
        as?: unknown
        content?: unknown
        items?: unknown
        summary?: unknown
        source?: unknown
        entities?: unknown
        whole?: unknown
      }
      runtime.recordToolCall()

      /** 失败也要返回**完整形状**：少一个字段会让宿主按 schema 报错，模型就更看不懂了。 */
      const failure = (error: string): FeedToolOutcome => ({
        ok: false,
        as: typeof a.as === 'string' ? a.as : 'knowledge',
        source: '',
        scope: '',
        inserted: 0,
        updated: 0,
        duplicates: 0,
        unchanged: 0,
        archived: 0,
        tokens: 0,
        error,
        note: 'Bad arguments; nothing was written.',
      })

      if (!isFeedKind(a.as)) return failure('as must be knowledge or experience')
      const entities = Array.isArray(a.entities)
        ? a.entities.filter((entity): entity is string => typeof entity === 'string' && entity.trim() !== '').slice(0, 5)
        : []

      const items: FeedItem[] = []
      if (Array.isArray(a.items)) {
        for (const entry of a.items) {
          const record = (entry ?? {}) as Record<string, unknown>
          if (typeof record.content !== 'string' || record.content.trim() === '') continue
          const summary = typeof record.summary === 'string' && record.summary.trim() !== '' ? record.summary : undefined
          items.push({
            content: record.content,
            ...(summary === undefined ? {} : { summary }),
            ...(entities.length === 0 ? {} : { entities }),
          })
        }
      } else if (typeof a.content === 'string' && a.content.trim() !== '') {
        const summary = typeof a.summary === 'string' && a.summary.trim() !== '' ? a.summary : undefined
        items.push({
          content: a.content,
          ...(summary === undefined ? {} : { summary }),
          ...(entities.length === 0 ? {} : { entities }),
        })
      }
      if (items.length === 0) return failure('pass content or items (and it must not be blank)')

      const source = typeof a.source === 'string' && a.source.trim() !== '' ? a.source.trim() : undefined
      // ★ 走**投喂子系统**（切分/分批/批间让出/会话记账都在它里面）。
      // 直觉上"这里只有一段话，直接调核心就行" —— 但那正是老毛病：
      // 一段话也可能是一百万字（模型自己 `read` 完一坨资料再喂），
      // 而"调用方已经切好了"这个假设不成立（用户 2026-10-09 明确要求不许假设）。
      const run = await feedInput(runtime.db, {
        as: a.as,
        items,
        ...(source === undefined ? {} : { source }),
        // ★ 整块投喂（用户裁定 C-②）：粒度交给你（模型）决定，切分那层让开。
        //   ⚠️ 天花板照旧 —— 它只关「段落切分」，不关「防撑爆上下文」。
        ...(a.whole === true ? { whole: true } : {}),
      })
      const result = firstFeedResult(run)
      if (result === undefined || !result.ok) {
        const reason = run.error ?? result?.error ?? 'feed failed'
        return { ...failure(reason), ...(result === undefined ? {} : { source: result.source, scope: result.scope }) }
      }

      // ★ 投喂的"这一轮喂了几段"只在这里加（用户 2026-10-10：「以单个轮次为界」）。
      //
      //   为什么是 **1**：模型驱动路径里**一次调用 = 素材的一段**
      //   （一段就是一个文件；`whole: true` 让它整块记成一条）。
      //   为什么必须由**成功写入**的地方加，而不是由"该喂几段"推：
      //   按"该喂的"推会让只喂了一半的轮次也把游标推满 ⇒ **漏喂 = 丢记忆**。
      //   （游标本身仍是**提示**而非正确性机制 —— 重喂幂等，见 `feed-cursor.ts` 的头。）
      runtime.noteFeedSegment(1)

      // 把"发生了什么"说成人话：模型看到"判重 3 段"才会知道
      // "这段内容我已经记过了"，而不是以为没喂进去。
      const notes: string[] = []
      if (result.duplicates > 0) notes.push(`${String(result.duplicates)} section(s) skipped as already remembered (not stored twice)`)
      if (result.unchanged > 0) notes.push(`${String(result.unchanged)} section(s) identical to the store, unchanged`)
      if (result.archived > 0) notes.push(`${String(result.archived)} section(s) archived (the previous version had more; recoverable)`)
      if ((result.batches ?? 1) > 1) {
        notes.push(`fed in ${String(result.batches)} batches (yielding between batches so compaction/settling can keep up)`)
      }
      if (notes.length === 0) notes.push('All writes succeeded.')
      // ★ 工作模式：这一段是"你的过去"，不是"刚刚发生的事"（见模块头）
      notes.push(feedDigestNote())
      notes.push(FEED_DELETE_HINT)

      return {
        ok: true,
        as: result.as,
        source: result.source,
        scope: result.scope,
        inserted: result.inserted,
        updated: result.updated,
        duplicates: result.duplicates,
        unchanged: result.unchanged,
        archived: result.archived,
        tokens: result.tokens,
        note: notes.join('；'),
      } satisfies FeedToolOutcome
    },
  })

  return [feedTool]
}
