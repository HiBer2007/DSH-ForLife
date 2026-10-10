/**
 * 判档接线（中介层第 ① 块）的测试：**取轮次输入** + **真的算了一遍**。
 *
 * ## 为什么这两件事要一起测
 *
 * `FIX_PLAN.md` §22 记着：`new Router(...)` / `defaultRouteEntries` / `lockTierForTurn`
 * 三处**零调用方** ⇒ "轮次开始时按档位选模型"从来没发生过。
 *
 * 接它的第一步是**让它可见**（observe）：把判档结果打出来，确认它真的响、真的合理。
 * 而判档的输入是"**这一轮的输入**" —— 它要从宿主给的 `messages` 里取出来。
 *
 * ⇒ 于是有两类失败：
 * ① **取不到输入**（载荷形状猜错）⇒ 判档被跳过，而日志里只有一条 debug
 * ② **取到了错的输入**（比如拿了第一轮而不是这一轮）⇒ 判档**看起来很合理**，只是判错了
 *
 * ② 最危险：**它不会报错，只会安静地用错模型**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { extractTurnText } from '../src/model-router.ts'

test('★★★ 取**最后一条** user 输入（不是第一条 —— 这个错会安静地判错档）', () => {
  const messages = [
    { role: 'user', content: '第一轮：帮我看看这个' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '第二轮：重构整个记忆层' },
  ]
  assert.equal(
    extractTurnText(messages),
    '第二轮：重构整个记忆层',
    '★ 拿第一条会**一直按第一轮的复杂度定档**：不报错、只是从此都用错模型',
  )
})

test('★★ 三种载荷形状都认（宿主换形状时不至于静默失效）', () => {
  // ① content 是字符串
  assert.equal(extractTurnText([{ role: 'user', content: '纯字符串' }]), '纯字符串')
  // ② content 是块数组
  assert.equal(
    extractTurnText([{ role: 'user', content: [{ type: 'text', text: '块数组' }] }]),
    '块数组',
  )
  // ③ content 本身就是 {text}
  assert.equal(extractTurnText([{ role: 'user', content: { text: '对象' } }]), '对象')
  // ④ 多块拼起来
  assert.equal(
    extractTurnText([{ role: 'user', content: [{ text: '上' }, { text: '下' }] }]),
    '上\n下',
  )
})

test('★★ 取不到就返回 `undefined` —— 让调用方**跳过判档**，而不是猜一个', () => {
  assert.equal(extractTurnText(undefined), undefined)
  assert.equal(extractTurnText([]), undefined)
  assert.equal(extractTurnText('不是数组'), undefined)
  assert.equal(extractTurnText([{ role: 'assistant', content: '没有用户消息' }]), undefined)
  assert.equal(extractTurnText([{ role: 'user', content: '   ' }]), undefined, '全是空白也算取不到')
  assert.equal(extractTurnText([null, 42, { role: 'user' }]), undefined, '垃圾条目要能跳过而不是抛')
  // ★ 反面：非文本块（图片等）不该被当成判档输入
  assert.equal(
    extractTurnText([{ role: 'user', content: [{ type: 'image', data: 'xxx' }] }]),
    undefined,
    '判档看的是"这一轮要干什么" —— 图片块没有文本可判',
  )
})

// ── 接线守卫 ─────────────────────────────────────────────────────────────

/** 读源码、去注释。 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const ROUTER = source('../src/model-router.ts')

test('★★★ 判档**真的被调用了**（不是只 import 了 `initialRoute`）', () => {
  // ★ 这条正是 §23 那个教训的形状：**import 了不等于调了**。
  assert.match(
    ROUTER,
    /const decided = initialRoute\(\{ turnText, catalog \}\)/,
    '★ 要真的调用 `initialRoute(...)`，并把结果接住 —— 只 import 会让这段**看着像接了**',
  )
  assert.match(ROUTER, /const turnText = extractTurnText\(p\.messages\)/, '输入要从宿主载荷里取')
  // 反面：`decided` 必须被**用掉**（只赋不读 ⇒ 接线等于没接）
  assert.match(ROUTER, /decided\.tierSource/, '★ 结果必须被用（读它的字段）—— 只赋值不读是"接了但没接上"')
  assert.match(ROUTER, /decided\.alternatives\.length/, '备选数也要报出来（判档可见才有意义）')
})

test('★★★ `apply` **真的落地**了 —— 而且只改该改的那几个字段', () => {
  // ⚠️ 这条测试**替换掉了上一轮的一条守卫**。那条写的是：
  //   「`apply` 分支仍然写着"尚未实现" —— 别把 observe 当成 apply」。
  //   它当时的用意是**防止谎报接线**（把 observe 说成 apply）。
  //   ★ 现在 apply 真的实现了，所以那条守卫的**事实基础变了** ——
  //   但它要防的东西没变，只是换了形状：**"订阅了但没改 config"** 才是新的谎报。
  assert.match(
    ROUTER,
    /on\('agent\/request',[\s\S]{0,200}?const config = \(await next\(\)\)/,
    '★ `agent/request` 是瀑布事件 —— 必须先 `await next()`（少了它会把整轮干掉）',
  )
  assert.match(ROUTER, /if \(mode !== 'apply'\) return config/, '★ observe/off 一个字都不改')
  assert.match(ROUTER, /provider: locked\.provider/, '★ 要真的把 provider 换成判档选的')
  assert.match(ROUTER, /model: locked\.model/, '★ model 同理')
  assert.match(ROUTER, /reasoningEffort: locked\.effort/, '★ 强度也要落下去（档位的意义一半在这里）')
  // ★ 反面：**不许把整个 config 换掉** —— 那样会丢掉 temperature/maxTokens 等宿主设定
  assert.match(
    ROUTER,
    /\.\.\.\(config as Record<string, unknown>\)/,
    '★★ 要**spread 宿主原本的 config 再改三个字段**；整体替换会悄悄丢掉 temperature/maxTokens/stop',
  )
  // ★ 出错必须放行，不许因为路由的问题让这一轮跑不起来
  assert.match(
    ROUTER,
    /agent\/request 路由装配出错（已放行宿主的配置）/,
    '★ 装配失败 ⇒ 放行宿主原本的配置（宁可路由不生效，也不能让轮次跑不起来）',
  )
})

test('★★★ 判档**每一步都算**（节流只管日志）—— 只算前 5 步会让 apply 半路失灵', () => {
  // ⚠️ 这条也替换掉了上一轮的一条守卫（原来断言 `preStepCount <= 5` 包着**计算**）。
  //   当时的想法是"跟观察日志一样节流"，但那会让 **`apply` 从第 6 步起没有路由可用**
  //   —— 而**日志上看不出任何异常**（正好是本仓最贵的那类问题）。
  //   ⇒ 现在节流只包日志，计算照常。
  assert.match(ROUTER, /if \(input\.getCatalog !== undefined\) \{/, '★ 计算的条件里**不许**再带 `preStepCount`')
  assert.ok(
    !/input\.getCatalog !== undefined && preStepCount <= 5/.test(ROUTER),
    '★★★ 计算不许被步骤节流包住 —— apply 需要每一步都有路由',
  )
  // 而日志**要**保留节流（不然每一步一条会淹没日志）
  assert.match(ROUTER, /if \(preStepCount <= 5\) \{\s*atLevel\(log, 'debug'\)/, '日志仍然节流')
})
