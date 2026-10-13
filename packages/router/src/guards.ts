/**
 * 守卫规则（模型路由.MD §5.2 第一层）。
 *
 * ## 定位
 *
 * 「守卫规则应该**极少且极准**，宁可漏过让模型判断，也不要误判。」——设计文档原话。
 * 所以这里的规则是 **≤10 条**，每条只处理"一眼就是"的场景：
 * 明显是闲聊（L1）还是明显需要深思（L3）。**中间地带一律放行**给 L1 评分模型。
 *
 * ## 为什么这条纪律很重要
 *
 * 守卫是唯一"零成本"的一层，因此很容易被塞进越来越多的规则（"这条也挺明显的…"）。
 * 但每条规则都是一次**不可解释的决策**：命中就直接定档，没有置信度、没有复盘余地。
 * 规则一多，路由质量就悄悄退化成"一堆 if"，而那正是这份文档要改掉的旧方案。
 * `router.guards.maxRules`（默认 10）在测试里被断言，就是为了让"加规则"必须是一次
 * 有意识的取舍，而不是顺手。
 *
 * @module @forlife/router/guards
 */
import { defaultFor } from '@forlife/contracts'

/** 档位。 */
export type Tier = 'L1' | 'L2' | 'L3'

/** 守卫判定上下文。 */
export interface GuardContext {
  /** 本轮是否包含压缩任务（压缩必须用强模型）。 */
  readonly isCompressionTask?: boolean
  /** 本轮是否是路由仲裁（要求模型对路由本身做判断）。 */
  readonly isRoutingArbitration?: boolean
  /** 估算的工具链长度（步数）。 */
  readonly estimatedToolChain?: number
}

/** 一条守卫规则。 */
export interface GuardRule {
  readonly name: string
  /** 命中则返回档位；不命中返回 undefined（放行）。 */
  readonly test: (text: string, context: GuardContext) => Tier | undefined
  /** 为什么需要这条规则（进日志，便于复盘时判断该不该留）。 */
  readonly rationale: string
}

/** 纯表情或纯符号（含只有 emoji + 空白）。 */
function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\p{P}]+/gu, '')
  return stripped === '' && text.trim() !== ''
}

/** 简单应答（"好的""收到""嗯嗯""哈哈"这类）。 */
function isSimpleAck(text: string): boolean {
  const ACKS = ['好的', '好', '收到', '嗯', '嗯嗯', '哦', '噢', '行', '可以', 'ok', 'OK', 'Ok', '哈哈', '谢谢', '多谢', '辛苦', '辛苦了', '早', '晚安', '在吗', '在不在']
  const bare = text.trim().replace(/[。！!？?~～\s]/g, '')
  return ACKS.includes(bare)
}

/** 简单事实性提问（时间/天气/在不在这类不需要深思的）。 */
function isSimpleQuery(text: string): boolean {
  const t = text.trim()
  if (t.length > 20) return false
  return /^(现在几点|几点了|今天(是)?(星期|周)几|今天(几号|多少号)|(今天|明天|后天)?天气(怎么样|如何|如何呢)?|你是谁|你叫什么|你在吗|在吗)\??$/.test(t)
}

/** 显式档位标记（`@L3` / `@think`）。 */
function hasExplicitMarker(text: string): Tier | undefined {
  if (/@(L3|think|深思|认真)/i.test(text)) return 'L3'
  if (/@(L1|fast|快)/i.test(text)) return 'L1'
  return undefined
}

/** 是否有代码块或大段代码。 */
function hasCode(text: string): boolean {
  return /```/.test(text) || /^\s*(?:def|class|function|import|const|let|var|public|private)\s/m.test(text)
}

/**
 * 默认守卫规则集（**恰好 10 条上限**，实际 8 条 —— 留两条余量）。
 *
 * **顺序即优先级**，这是本文件最容易出错的地方：
 *   ① 用户显式指定（`@L3`）—— 用户说了算，最硬；
 *   ② 系统上下文（压缩任务 / 路由仲裁 / 长工具链）—— 这些是**强信号**，
 *      不该被"消息很短"这类文本启发式挡掉；
 *   ③ 文本启发式（纯表情 / 简单应答 / 短消息）—— 最弱，放最后。
 *
 * 排序 bug 的实际后果：把"短消息"规则放在"压缩任务"之前时，
 * 一次短文本的压缩任务会被判成 L1（弱模型去做摘要，直接损害记忆质量）。
 * 这与阶段 4 那个"强事件必须优先于时间间隔"是同一类错误。
 */
export const DEFAULT_GUARDS: readonly GuardRule[] = [
  {
    name: 'explicit-marker',
    rationale: '用户显式指定档位时不该再猜（`@L3` 是明确要求深思）',
    test: (text) => hasExplicitMarker(text),
  },
  {
    name: 'compression-task',
    rationale: '压缩摘要质量直接影响记忆，必须用强模型',
    test: (_text, context) => (context.isCompressionTask === true ? 'L3' : undefined),
  },
  {
    name: 'routing-arbitration',
    rationale: '让模型判断路由本身时必须用强模型（弱模型的元判断不可信）',
    test: (_text, context) => (context.isRoutingArbitration === true ? 'L3' : undefined),
  },
  {
    name: 'long-tool-chain',
    rationale: '需要 4 步以上工具链的任务，规划成本远高于对话成本',
    test: (_text, context) => ((context.estimatedToolChain ?? 0) > 3 ? 'L3' : undefined),
  },
  {
    name: 'emoji-only',
    rationale: '纯表情/符号没有任何需要理解的语义',
    test: (text) => (isEmojiOnly(text) ? 'L1' : undefined),
  },
  {
    name: 'simple-ack',
    rationale: '"好的/收到/嗯"这类应答不需要任何推理',
    test: (text) => (isSimpleAck(text) ? 'L1' : undefined),
  },
  {
    name: 'simple-query',
    rationale: '时间/天气这类事实性短问句，L1 足够',
    test: (text) => (isSimpleQuery(text) ? 'L1' : undefined),
  },
  {
    name: 'short-plain',
    rationale: '很短且不含代码的消息（<10 字）几乎不需要深思',
    test: (text, context) => {
      const t = text.trim()
      if ([...t].length >= 10) return undefined
      if (hasCode(t)) return undefined
      if ((context.estimatedToolChain ?? 0) > 3) return undefined // 短消息也可能挂长工具链
      return 'L1'
    },
  },
]

/** 守卫判定结果。 */
export interface GuardVerdict {
  readonly tier?: Tier
  /** 命中的规则名（未命中则 undefined）。 */
  readonly rule?: string
  readonly rationale?: string
}

/**
 * 跑守卫规则（< 1ms）。
 *
 * @param text - 入站文本。
 * @param context - 上下文。
 * @param rules - 规则集（默认内置）。
 * @returns 判定结果；未命中时 `tier` 为 undefined（放行给评分模型）。
 */
export function runGuards(text: string, context: GuardContext = {}, rules: readonly GuardRule[] = DEFAULT_GUARDS): GuardVerdict {
  const limit = defaultFor<number>('router.guards.maxRules')
  if (rules.length > limit) {
    // 宁可报错也不静默截断：静默截断会让"我加的规则没生效"变成一个难查的谜
    throw new Error(`守卫规则有 ${String(rules.length)} 条，超过上限 ${String(limit)}（模型路由.MD §9：保持极简）`)
  }
  for (const rule of rules) {
    const tier = rule.test(text, context)
    if (tier !== undefined) return { tier, rule: rule.name, rationale: rule.rationale }
  }
  return {}
}
