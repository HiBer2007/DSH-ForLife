/**
 * 投喂轮次接线的守卫（用户 2026-10-10：「以单个轮次为界」）。
 *
 * ## 为什么要有它
 *
 * `feed-turn-hook.ts` 自己 6/6 全绿，**但"它有没有被挂上"是另一件事**。
 * 本仓栽过这个跟头：`beginTurn()` / `observeShortTokens()` 曾经**只被测试调用**，
 * 生产链路里没有任何地方调它们 —— `index.ts:1055` 那段注释逐字记着后果
 * （"函数写好了、测试全绿、线上根本没跑"）。
 *
 * ## ★ 这个文件里最要紧的一条断言
 *
 * `turn/end` 的分支里，**投喂收尾必须排在 `tokens === undefined` 那条 early return 之前**。
 * 放在它之后的话："拿不到 token 读数"就会连带让**工具掩码永远留着** ——
 * 那是"**她的正常对话从此发不出 QQ 消息、而且没人会发现**"。
 * 这条顺序**单测测不出来**（两条分支各自都是对的），只能读源码钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读源码并**去掉注释** —— 否则注释里引用的写法会把守卫骗过去（本仓栽过）。 */
function code(relative: string): string {
  const raw = readFileSync(new URL(relative, import.meta.url), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const INDEX = code('../src/index.ts')
const FEED_TOOLS = code('../src/feed-tools.ts')
const RUNTIME = code('../src/runtime.ts')

test('★★ 轮次钩子真的建了、真的挂在 `session/event` 上', () => {
  assert.match(
    INDEX,
    /createFeedTurnHook\(\{[\s\S]{0,200}?db: runtime\.db/,
    '钩子要用 runtime.db 建（投喂的游标/运行登记都在同一个库里）',
  )
  assert.match(INDEX, /feedTurn\.onTurnStart\(\)/, '`turn/start` 上必须调它')
  assert.match(INDEX, /feedTurn\.onTurnEnd\(/, '`turn/end` 上必须调它')
})

test('★★★ `turn/end` 里投喂收尾必须排在 early return **之前**', () => {
  const at = INDEX.indexOf("type === 'turn/end'")
  assert.ok(at > 0, '找不到 turn/end 分支')
  const endBlock = INDEX.slice(at, at + 2000)
  const feedAt = endBlock.indexOf('feedTurn.onTurnEnd(')
  const earlyReturnAt = endBlock.indexOf('tokens === undefined')
  assert.ok(feedAt > 0, 'turn/end 分支里必须调 feedTurn.onTurnEnd')
  assert.ok(earlyReturnAt > 0, '找不到那条 early return（说明它被改了，这条守卫要跟着改）')
  assert.ok(
    feedAt < earlyReturnAt,
    '★ 投喂收尾必须排在 `tokens === undefined` 那条 early return **之前** —— ' +
      '排在之后的话，"拿不到 token 读数"就会连带让**工具掩码永远留着**，' +
      '而那是"她的正常对话从此发不出 QQ 消息、且没人会发现"',
  )
})

test('★★ 喂入段数：只由**成功写入**的地方加，且轮末是**取走**（清零）', () => {
  // ① feed_memory 成功之后才加
  const okAt = FEED_TOOLS.indexOf('firstFeedResult(run)')
  assert.ok(okAt > 0, '找不到 feed_memory 的结果判定')
  assert.match(
    FEED_TOOLS.slice(okAt),
    /runtime\.noteFeedSegment\(1\)/,
    '★ 段数必须由 `feed_memory` **成功写入**的地方加 —— ' +
      '按"该喂几段"推会让只喂了一半的轮次也把游标推满 ⇒ **漏喂 = 丢记忆**',
  )

  // ② 轮末用的是 consume（取走），不是读
  assert.match(
    INDEX,
    /runtime\.consumeFedSegments\(\)/,
    '★ 轮末必须**取走**（清零）—— 两条路径各读一次会让游标**跳段**',
  )
  assert.match(RUNTIME, /consumeFedSegments\(\): number \{/, 'runtime 要真的实现它')
  assert.match(
    RUNTIME,
    /feedSegmentsThisTurn = 0/,
    '每轮开始要归零（`beginTurn()` 里）—— 不归零会让上一轮的段数累到这一轮',
  )
})

test('★ 钩子拿不到 `ctx.tools` 时**不收窄**，但也不假装成功了', () => {
  assert.match(
    INDEX,
    /tools: ctx\.get\('tools'\) as ToolRestrictHost \| undefined/,
    'tools 要从 ctx 取；取不到就 undefined（钩子内部会如实记一行，不假装"限制住了"）',
  )
})
