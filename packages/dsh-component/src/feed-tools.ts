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
      '把一段**外部资料**喂进记忆（你自己决定它算知识还是经历）。',
      'as=knowledge：进长期记忆（事实、资料、结论）—— 以后要靠检索才能想起来，但不会被压缩掉。',
      'as=experience：进中期记忆（发生过的事、当下的经过）—— 参与当前上下文，会被压缩/碎片化。',
      '与 `remember` 的区别：`remember` 记的是"关于对话/用户的一件事"（无来源）；',
      '这个工具记的是**一段有来源的资料**，同一个 source 再喂一次会**更新**对应段落，而不是又记一遍。',
      '写法：一段一件事、自足（将来单独看到也能懂，不要用"它/这个/刚才"这类指代）。',
      '**一次调用喂一份多段资料**时用 items（段落序号按这次调用算）——',
      '不要用同一个 source 分多次只喂一段：同源是按"第几段"对应更新的，那样后一段会覆盖前一段。',
      '喂进来的东西要删，走既有记忆管理（面板归档 / memory-archive），**没有**单独的删除工具。',
    ].join('\n'),
    parameters: {
      as: {
        type: 'string',
        required: true,
        enum: [...FEED_KINDS],
        description: 'knowledge=长期知识（事实/资料）；experience=经历（进中期记忆）。',
      },
      content: { type: 'string', description: '要喂的一段内容（与 items 二选一）。' },
      items: {
        type: 'array',
        description: '要喂的多段内容（与 content 二选一；一次调用喂完一份资料）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: '这一段的内容。' },
            summary: { type: 'string', description: '可选：这一段的摘要。' },
          },
        },
      },
      summary: { type: 'string', description: '可选：content 的摘要（不给就按首行自动截断）。' },
      source: {
        type: 'string',
        description:
          '可选：来源（文件名/批次名）。**同一个来源 = 同一份东西**，重导会更新对应段落；不给则按内容派生。',
      },
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：关键实体（人名/项目/技术名），最多 5 个。',
      },
      whole: {
        type: 'boolean',
        description:
          '可选：**整块投喂** —— 不把这段内容按空行/标题行拆成多条，它就记成**一条**。' +
          '何时用：你判断「这一整段该被当成**一件事**」（一整段对话、一整篇笔记、一份完整资料）。' +
          '默认 false = 按段落拆（每段一条）。' +
          '⚠️ 即使用它，单条仍有 **token 天花板**保护：超了会被按句子边界机械切开（那是防撑爆上下文，不是替你决定粒度）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '是否写入成功。' },
          as: { type: 'string', required: true, description: '实际写入的目标（knowledge/experience）。' },
          source: { type: 'string', required: true, description: '实际使用的来源（重导时要用同一个）。' },
          scope: { type: 'string', required: true, description: '库里的来源标记（feed:…），按它检索/归档。' },
          inserted: { type: 'integer', required: true, description: '新增段数。' },
          updated: { type: 'integer', required: true, description: '同源重导被更新的段数。' },
          duplicates: { type: 'integer', required: true, description: '判为已有记忆而跳过的段数。' },
          unchanged: { type: 'integer', required: true, description: '与库里一致、未改动的段数。' },
          archived: { type: 'integer', required: true, description: '上一版多出来、被归档的段数。' },
          tokens: { type: 'integer', required: true, description: '这次喂入内容的 token 估算。' },
          error: { type: 'string', description: '失败原因（ok=false 时）。' },
          note: { type: 'string', required: true, description: '人话补充（判重/归档/失败原因）。' },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as FeedToolOutcome
        if (!v.ok) return text(`喂食失败：${v.error ?? '未知原因'}`)
        const kind = v.as === 'knowledge' ? '长期记忆（知识）' : '中期记忆（经历）'
        return text(`已喂入 ${kind}：新增 ${String(v.inserted)} 段 / 更新 ${String(v.updated)} 段 / 判重 ${String(v.duplicates)} 段（来源 ${v.source}）。${v.note}`)
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
        note: '参数不对，没有写入任何东西。',
      })

      if (!isFeedKind(a.as)) return failure('as 必须是 knowledge 或 experience')
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
      if (items.length === 0) return failure('必须给 content 或 items（且不能是空白）')

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
        const reason = run.error ?? result?.error ?? '喂食失败'
        return { ...failure(reason), ...(result === undefined ? {} : { source: result.source, scope: result.scope }) }
      }

      // 把"发生了什么"说成人话：模型看到"判重 3 段"才会知道
      // "这段内容我已经记过了"，而不是以为没喂进去。
      const notes: string[] = []
      if (result.duplicates > 0) notes.push(`${String(result.duplicates)} 段判为已有记忆，已跳过（没有重复记）`)
      if (result.unchanged > 0) notes.push(`${String(result.unchanged)} 段与库里一致，未改动`)
      if (result.archived > 0) notes.push(`${String(result.archived)} 段是上一版多出来的，已归档（可恢复）`)
      if ((result.batches ?? 1) > 1) {
        notes.push(`分 ${String(result.batches)} 批投入（批间让出控制权，压缩/沉降有机会跟上）`)
      }
      if (notes.length === 0) notes.push('全部写入成功。')
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
