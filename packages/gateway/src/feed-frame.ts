/**
 * 「半梦半醒 · 前世记忆」—— 投喂期的**工作模式说明**（措辞在这里，机制不在这里）。
 *
 * ## 用户的口径（2026-10-09）
 *
 * > 可以直接让模型以为自己在**半梦半醒**的状态，并**接受前世的记忆内容**。
 *
 * | 技术事实 | 叙事框架 |
 * | :--- | :--- |
 * | 系统在把历史一段段写进中期记忆 | 你在**半梦半醒** |
 * | 这些内容是"你的过去" | 你在**接收前世的记忆** |
 * | 投喂有批次、有进度 | 记忆**一段一段浮上来** |
 * | 投喂结束回到正常对话 | **醒来** |
 *
 * 为什么用这个框架：技术上投喂的内容**确实是她的过去**（她自己的记忆），
 * 所以"前世记忆"不是骗她，是准确的比喻；体验上比"正在执行记忆导入任务 #17"自然，
 * 而且**不会让她把投喂内容误当新消息**。
 *
 * ## ★★ 两条不可越的边界（改这段代码的人先读这两条）
 *
 * 1. **框架里"半梦半醒 vs 醒来"这条线 = "记忆 vs 现在"的边界**。
 *    措辞**必须**把这条边界说出来（哪些是记忆、什么时候回到现在），
 *    否则"前世记忆"会变成"我刚刚经历了这些" —— 那不是框架，那是污染。
 *    基线里的默认文案专门有一段讲这个，**不要为了简洁删掉它**。
 * 2. **不许在投喂内容里伪造"用户刚刚说了什么"**。
 *    投喂只做一件事：把外部资料写进记忆系统（`source_scope = feed:…`）。
 *    任何"往对话消息流里塞一句话"的做法都会污染她对"现在"的判断 ——
 *    所以本模块**只产出提示词文本**，不碰消息、不碰会话、不碰记忆内容。
 *    （守卫测试扫这条：这里没有会话/消息类 API 的调用点。）
 *
 * ## 措辞放哪、为什么
 *
 * 默认文案在**基线** `feed.dreamFrame`（与 `prompt.p1Default` / `prompt.p2Default` 同一做法）：
 * 用户想改口气不用改代码。这里只做**占位符替换**与"什么时候显示"的判断。
 *
 * ⚠️ 占位符用 `{{名字}}` 是**故意的**（与仓库里提示词变量的写法一致），
 * 但注册那一段时必须 `interpolate: false` —— 宿主对未定义变量是**抛错**，
 * 那会让整段提示词装不出来。这条由守卫测试钉着（读 `prompt.ts` 的注册点）。
 *
 * @module @forlife/gateway/feed-frame
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import type { FeedKind } from './feed.ts'
import { readFeedSession, type FeedSession, type FeedSessionBatch } from './feed-session.ts'

/**
 * 框架文案里认得的占位符（守卫测试用它断言"模板里没有别的占位符"）。
 *
 * 刻意**没有**"最后一批"这类占位符：提示词是在**下一轮装配时**才渲染的，
 * 而投喂的最后一批与"会话结束"之间只隔几微秒 ⇒ 那个状态**永远轮不到被渲染**
 * （留着就是死代码）。"投喂结束 = 醒来"由整段消失表达，文案里如实说明这条弧线。
 */
export const FEED_FRAME_PLACEHOLDERS: readonly string[] = ['source', 'kind', 'chunks', 'batches', 'batch']

/** 两种喂食目标在**人话**里的说法（提示词与工具返回共用同一份，避免两处口径不一致）。 */
export function feedKindLabel(kind: FeedKind): string {
  return kind === 'knowledge' ? '知识（长期记忆）' : '经历（中期记忆）'
}

/**
 * 渲染投喂期的模式说明（"半梦半醒"）。
 *
 * @param session - 当前会话（见 `readFeedSession`）。
 * @returns 提示词块（基线模板 + 占位符替换）。
 */
export function renderFeedFrame(session: FeedSession): string {
  const template = defaultFor<string>('feed.dreamFrame')
  const values: Record<string, string> = {
    source: session.source,
    kind: feedKindLabel(session.as),
    chunks: String(session.chunks),
    batches: String(session.batches),
    batch: describeFeedBatch(session.batch),
  }
  let text = template
  // 按**白名单常量**替换（而不是遍历 values 的键）：这样"文案里写了什么占位符"
  // 与"代码认哪些占位符"是同一份清单，加占位符时改一处即可（`FEED_FRAME_PLACEHOLDERS`）。
  for (const name of FEED_FRAME_PLACEHOLDERS) {
    text = text.split(`{{${name}}}`).join(values[name] ?? '')
  }
  return text.trim()
}

/**
 * 提示段用的文本：**没有在投喂就返回严格的空串**。
 *
 * ⚠️ 必须是 `''`，不能是空白串：真宿主（`@deepseek-ai/dsh-system-prompt`）对
 * `text: () => ''` 的段**整段跳过**（实测：渲染出的字节与"根本没注册这一段"完全相同），
 * 但**只含空白的串会被原样插进提示词** —— 那就白白改了稳定前缀的字节、
 * 让"不投喂时前缀逐字节不变"这条缓存承诺失效。
 *
 * @param db - 数据库连接（读 `forlife_state` 里的会话记录）。
 * @param options - `now` 便于测试注入时间（陈旧判定按它算）。
 * @returns 模式说明；空闲/陈旧/坏数据 ⇒ `''`。
 */
export function feedModeText(db: DatabaseSync, options: { readonly now?: Date } = {}): string {
  const session = readFeedSession(db, options.now === undefined ? {} : { now: options.now })
  if (session === undefined) return ''
  const text = renderFeedFrame(session)
  return text === '' ? '' : text
}

/**
 * 把会话里的**批次指针**说成人话（用户 2026-10-10：「以单个轮次为界」）。
 *
 * ## 为什么这个占位符**不能留空**
 *
 * 文案里它多半嵌在一句完整的话中（"本轮请从 {{batch}} 这一段开始"）。
 * 若渲染成空串，那句话会读成"本轮请从  这一段开始" —— **模型会看不懂该读哪一段**，
 * 而"该读哪一段"正是这个占位符存在的**唯一理由**。
 * ⇒ 没有指针时给一句**明确的说明**，而不是留空。
 *
 * @param batch - 会话里的指针（`undefined` = 这一轮没有指定范围）。
 */
export function describeFeedBatch(batch: FeedSessionBatch | undefined): string {
  if (batch === undefined) return '（本轮未指定范围：请从这一份素材尚未投喂的部分接着读）'
  return `第 ${String(batch.from)}–${String(batch.to)} 段（共 ${String(batch.total)} 段）`
}

/**
 * 投喂期给**调用者**（模型/人）看的一句话。
 *
 * 与提示段**同源不同用**：提示段是"写在系统提示词里、让她随时知道自己在什么模式"，
 * 这一句是"这次调用的结果里告诉她刚才发生了什么"。
 * 两者都要有，因为**模型自己调 `feed_memory` 时本轮提示词早就装配完了** ——
 * 只靠提示段的话，调用者这一轮看不到任何模式说明。
 */
export function feedDigestNote(): string {
  return defaultFor<string>('feed.digestNote')
}
