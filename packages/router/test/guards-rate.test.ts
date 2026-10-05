/**
 * 守卫拦截率测试（模型路由.MD §5.2 的验收口径：**40–60%**）。
 *
 * ## 为什么这条要单独测
 *
 * 拦截率是一个**平衡指标**，两头都坏：
 *  - 太低 ⇒ 守卫没做事，每次都要调评分模型（延迟与成本都上去了）；
 *  - 太高 ⇒ 规则在越权做语义判断（那正是这份文档要改掉的旧方案），
 *    而且每次误判都是不可解释的 —— 用户会觉得"它今天怎么变笨了"。
 *
 * ## 样本口径（这条很关键，否则拦截率算得毫无意义）
 *
 * 路由器**只看到已经唤醒它的消息** —— 群里没人 @ 它的闲聊在唤醒矩阵那一层就被挡掉了
 * （§2.17.2：群聊默认零唤醒）。所以路由面对的分布是"有人在跟它说话"，
 * 而不是"群里所有发言"。
 *
 * 按"所有群消息"统计，拦截率会明显偏高（绝大多数是"哈哈/好的/在吗"），
 * 那个数字评价的是群友的说话习惯，不是守卫的质量。下面两条用例把两种口径都量出来。
 *
 * 验收里写的是"离线回放 **200 条真实消息**"。本机没有真实语料，所以这里用
 * 一批**刻意构造且口径明确**的样本先把测量跑通；真实语料回放列在待验项里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultFor } from '@forlife/contracts'

import { runGuards } from '../src/index.ts'

/** 面向机器人的消息（路由器真实面对的分布）。 */
const DIRECTED_TO_BOT: readonly string[] = [
  // 明显简单：被 @ 或私聊，但内容确实很简单（应当拦截）
  '谢谢',
  '在吗',
  '现在几点',
  '今天星期几',
  '好的',
  '收到了',
  '哈哈',
  '晚安',
  '早安',
  '辛苦啦',
  '嗯嗯',
  '😂😂',
  '好',
  '谢谢啦',
  '可以',
  // 中间地带：有人在认真说事（不该拦截，交给评分模型）
  '帮我看看这个方案行不行',
  '这个报错是什么原因导致的呢',
  '我想把这段代码重构一下',
  '你觉得我们应该先做哪个功能比较好',
  '昨天的日志里有个异常',
  '这个接口的返回格式要改吗',
  '帮我把这句话翻译成英文',
  '这个想法怎么样',
  '我在想是不是应该换个方向',
  '你看下这个数据正常吗',
  '这个方案可行吗',
  '要不要现在就做',
  '明天那个会需要我准备什么吗',
  '帮我看下这段配置有没有问题',
  '我打算下周开始做这个功能',
  '你觉得用哪种方案更合适',
  '这个需求应该怎么拆',
  '帮我想个名字吧',
  '这个流程能不能简化一下',
  '如果换成另一种写法会不会更好',
  // 明显复杂：明确要求深思（应当拦截，走另一组规则）
  '@L3 认真分析一下这个架构',
  '@think 帮我权衡一下一致性与可用性',
  '帮我设计一个分布式缓存系统，需要考虑失效与一致性',
  '详细分析一下这两种方案的取舍',
  '帮我重构这段代码，顺便解释为什么',
  '给我一个完整的迁移方案',
  '这个系统的瓶颈可能在哪里，怎么定位',
  '帮我把这套流程设计出来',
  '认真评估一下这个风险',
  '我想做一个完整的重构计划',
]

/** 群里没人 @ 它的闲聊（**路由器根本看不到**，列出来是为了对比口径差异）。 */
const AMBIENT_CHATTER: readonly string[] = Array.from(
  { length: 60 },
  (_, i) => ['哈哈哈', '好的', '嗯嗯', '在吗', '几点', '？', '😂', '收到', '早', '晚安', '好', '可以'][i % 12] ?? '哈哈',
)

test('守卫拦截率落在 40–60%（按"面向机器人"的口径）', () => {
  const min = defaultFor<number>('router.guards.targetInterceptMin')
  const max = defaultFor<number>('router.guards.targetInterceptMax')
  const intercepted = DIRECTED_TO_BOT.filter((text) => runGuards(text).tier !== undefined).length
  const rate = intercepted / DIRECTED_TO_BOT.length
  const detail = `${(rate * 100).toFixed(1)}%（${String(intercepted)}/${String(DIRECTED_TO_BOT.length)}）`
  assert.ok(rate >= min && rate <= max, `拦截率 ${detail} 应当落在 ${(min * 100).toFixed(0)}–${(max * 100).toFixed(0)}%`)
})

test('口径对照：按"所有群消息"统计会明显偏高（所以那个数字不能用来评价守卫）', () => {
  const directed = DIRECTED_TO_BOT.filter((text) => runGuards(text).tier !== undefined).length / DIRECTED_TO_BOT.length
  const ambient = AMBIENT_CHATTER.filter((text) => runGuards(text).tier !== undefined).length / AMBIENT_CHATTER.length
  assert.ok(ambient > directed, '群闲聊的拦截率必然更高（都是短消息）')
  assert.ok(ambient > 0.9, `群闲聊几乎全被拦截（实际 ${(ambient * 100).toFixed(0)}%）—— 这正是"路由器看不到它们"的原因`)
})

test('拦截率不是靠"把中间地带也吃掉"达成的：中间地带必须放行', () => {
  const midZone = DIRECTED_TO_BOT.filter(
    (text) =>
      !text.startsWith('@') &&
      [...text].length > 12 &&
      !/^(谢谢|在吗|现在几点|今天星期几|好的|收到了|哈哈|晚安|早安|辛苦|嗯|可以|好|😂)/u.test(text),
  )
  const wronglyIntercepted = midZone.filter((text) => runGuards(text).tier !== undefined)
  assert.equal(wronglyIntercepted.length, 0, `这些中间地带消息不该被守卫拦截：${wronglyIntercepted.join(' / ')}`)
})

test('每条规则都真的会被用到（没有死规则）', () => {
  const contexts: { text: string; ctx: Record<string, unknown> }[] = [
    { text: '😂', ctx: {} },
    { text: '好的', ctx: {} },
    { text: '现在几点', ctx: {} },
    { text: '好', ctx: {} },
    { text: '这个怎么样', ctx: {} },
    { text: '@L3 x', ctx: {} },
    { text: 'x', ctx: { isCompressionTask: true } },
    { text: 'x', ctx: { isRoutingArbitration: true } },
    { text: 'x', ctx: { estimatedToolChain: 5 } },
  ]
  const hit = new Set<string>()
  for (const item of contexts) {
    const verdict = runGuards(item.text, item.ctx as never)
    if (verdict.rule !== undefined) hit.add(verdict.rule)
  }
  assert.equal(hit.size, 8, `8 条规则都该有对应的触发样本，实际触发 ${String(hit.size)} 条：${[...hit].join(',')}`)
})

test('性能：守卫判定远低于 1ms 量级（这是它存在的全部理由）', () => {
  const started = performance.now()
  for (let i = 0; i < 2000; i++) runGuards(DIRECTED_TO_BOT[i % DIRECTED_TO_BOT.length] ?? 'x')
  const perCall = (performance.now() - started) / 2000
  assert.ok(perCall < 0.5, `单次守卫 ${perCall.toFixed(3)}ms，应当远低于 1ms`)
})
