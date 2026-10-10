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

test('★★★ `apply` 分支**仍然写着"尚未实现"** —— 别把 observe 当成 apply', () => {
  // 这一步刻意只做 observe：判档算出来只打日志，**不改模型**。
  // 若哪天有人把 apply 分支的警告删了却没真的实现 apply，那才是"谎报接线"。
  assert.match(
    ROUTER,
    /apply 模式：initialRoute\(\) 接线\*\*尚未实现\*\*/,
    '★ `apply` 还没实现 —— 这条警告必须留着（判档可见 ≠ 模型被换了）',
  )
})

test('★ 判档只在前几步打（与 `👀` 观察日志同一个节流，免得刷屏）', () => {
  assert.match(
    ROUTER,
    /input\.getCatalog !== undefined && preStepCount <= 5/,
    '★ 判档日志要跟着 `preStepCount` 节流，否则每一步一条会淹没日志',
  )
})
