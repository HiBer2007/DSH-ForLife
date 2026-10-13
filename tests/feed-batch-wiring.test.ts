/**
 * ★★ 投喂子系统的**接线守卫**（读源码 + 行为两层）。
 *
 * ## 为什么必须有这一条
 *
 * 本项目的招牌缺陷模式是「**库代码写好了、单元测试全绿、生产路径零调用**」（栽过 19 次）。
 * 这次的形状更隐蔽：切分、分批、让出、会话记账**每一样都有单测**，
 * 但如果调度面忘了 `await` 让出、忘了把会话写进 `forlife_state`、
 * 或者提示段没读那段状态，那么"单测全绿而生产路径上什么都没发生"照样成立。
 *
 * 所以这里盯的不是功能，而是**四处接线**（每一处都对应一个真实故障）：
 *
 * | 接线 | 忘了会怎样 |
 * | :--- | :--- |
 * | 批间 `await` 让出 | 又变回"一口气把 N 段写进中期记忆"（2026-10-09 的死锁） |
 * | `indexOffset` + `archiveLeftovers: false` | 分批之后段落序号错位 / 每批误归档别的批 |
 * | 会话 `begin/advance/end`（end 在 `finally`） | 模型不知道自己半梦半醒；或崩溃后**永远**半梦半醒 |
 * | 提示段读 `feedModeText()` | 记账白记了：那段说明根本进不了提示词 |
 *
 * ## 判法（三条硬要求）
 *
 *  1. **去注释后判** —— 本仓注释里会写"不要这么干"，不去注释就是自己满足自己；
 *  2. **必须在语句位置** —— 光出现名字不算（`foo(` 出现在字符串/类型里都没用）；
 *  3. **断言的是调用点，不是导出** —— "导出存在"拦不住零调用。
 *
 * @module tests/feed-batch-wiring
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 去掉注释，只留真正的代码（与其它守卫同一套做法）。 */
function code(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

const SUBSYSTEM = 'packages/gateway/src/feed-batch.ts'
const INGEST = 'packages/gateway/src/feed-ingest.ts'
const SESSION = 'packages/gateway/src/feed-session.ts'
const FRAME = 'packages/gateway/src/feed-frame.ts'
const PROMPT = 'packages/dsh-component/src/prompt.ts'
const RUNTIME = 'packages/dsh-component/src/runtime.ts'

test('★★ 批间让出控制权：`await …yieldBetween(` 必须真的出现在调度里（语句位置）', () => {
  const source = code(SUBSYSTEM)
  assert.match(
    source,
    /await\s+context\.yieldBetween\(/,
    '调度里必须 `await` 一个让出（否则又变回"一口气全写进中期记忆"）',
  )
  // 让出的时长必须来自基线（不许写死 sleep 数字）
  assert.ok(source.includes("'feed.batchIntervalMs'"), '让出时长必须读 feed.batchIntervalMs')
  // 让出只发生在"还有下一批"时（否则每次都在最后白等一个间隔）
  assert.match(source, /pending = step\.value;?\s*\n?\s*await context\.yieldBetween\(/s, '让出必须紧跟在"探到还有下一批"之后')
})

test('★★ 每批都走 `feedMemory`，并且带上 `indexOffset` 与 `archiveLeftovers: false`', () => {
  const source = code(SUBSYSTEM)
  assert.match(source, /feedMemory\(db, \{/, '子系统必须每一批调一次 feedMemory（唯一写入核心）')
  assert.match(source, /indexOffset: from/, '分批必须传 indexOffset（否则第二批的第 0 段会顶掉第一批的第 0 段）')
  assert.match(source, /archiveLeftovers: false/, '分批时不许每批都扫 tail 归档（会把别的批的段判成"多出来的"）')
  // 收尾归档用的是核心导出的那个实现（不是子系统自己写一份）
  assert.match(source, /archiveFeedLeftovers\(db, \{/, '收尾必须调核心导出的 archiveFeedLeftovers')
})

test('★★ 会话记账：begin / advance / end 三处都在，且 end 在 `finally` 里', () => {
  const source = code(SUBSYSTEM)
  assert.match(source, /beginFeedSession\(db, \{/, '投喂开始要记会话（模型才知道自己在消化记忆）')
  assert.match(source, /advanceFeedSession\(db, \{/, '每批要推进会话（"一段一段浮上来"要有进度）')
  assert.match(source, /endFeedSession\(db\)/, '投喂结束要收会话（结束 = 醒来）')
  // ★ 收尾必须在 finally 里：抛异常/中止也要收，否则模型**永远**半梦半醒
  assert.match(
    source,
    /finally\s*\{[^}]*endFeedSession\(db\)/s,
    'endFeedSession 必须在 finally 里 —— 中途抛异常不收会话 = 模型永远以为自己半梦半醒',
  )
  // 会话记录落在**既有**的 forlife_state 表上（没有第二张状态表）
  const session = code(SESSION)
  assert.match(session, /INSERT INTO forlife_state/, '会话必须落在既有的 forlife_state（不许加表）')
  assert.ok(!/CREATE TABLE/i.test(session), '不许为会话建表')
  // 渲染路径只读不写：读会话的那一侧不许出现写操作
  assert.ok(!/INSERT INTO|DELETE FROM|UPDATE /i.test(code(FRAME)), '提示段的渲染路径只读不写（渲染热路径不改库）')
})

test('★★ 提示段真的读会话（否则记账白记）', () => {
  const frame = code(FRAME)
  assert.match(frame, /readFeedSession\(/, '提示段文本必须由会话记录驱动')
  assert.match(frame, /renderFeedFrame\(/, '框架措辞要经渲染函数出来（占位符替换）')
  assert.ok(frame.includes("'feed.dreamFrame'"), '措辞的真源在基线（用户要能改文案）')
  // 空闲 ⇒ **严格空串**（实测：宿主对空段整段跳过，但空白串会被原样插进提示词）
  assert.match(frame, /return ''/, '空闲时必须返回严格空串（不能用空白）')

  // dsh-component 那一侧：注册了这一段，而且文本来自运行时
  const prompt = code(PROMPT)
  assert.match(prompt, /FEED_MODE_NAME = 'forlife:feed-mode'/, '段名必须存在')
  assert.match(prompt, /FEED_MODE_ORDER = 140/, '段序必须是 140（L3 之后、工具段之前）')
  assert.match(prompt, /text: \(\) => runtime\.feedModeText\(\)/, '这一段必须读运行时（读库）—— 忘了就是"记账零消费"')
  assert.match(prompt, /order: FEED_MODE_ORDER/, '注册时必须用那个段序常量')
  // ⚠️ 必须 interpolate: false：文案里有我们自己的 {{...}} 占位符，
  // 宿主的插值器对未知变量是**抛错**（那会让整段提示词装不出来）
  const feedSection = /registerFeedModeSection[\s\S]*?interpolate: false/.test(prompt)
  assert.ok(feedSection, 'feed-mode 段必须 interpolate: false（我们自己的占位符不能让宿主去插值）')
  // 运行时那一侧：方法真的调了 gateway 的实现
  assert.match(code(RUNTIME), /feedModeText\(\): string \{\s*return renderFeedModeText\(this\.db\)/, '运行时方法必须把库交给 gateway 的实现')
})

test('★ 边界：投喂只写记忆，**不许**伪造"用户刚说了什么"', () => {
  // 用户口径里的第二条红线。机械判据：投喂这条链上不许出现"往对话/消息流里写"的原语。
  const forbidden = ['postHumanMessage(', 'enqueueOutbound(', 'insertMessage(', 'appendMessage(', 'insertTurn(']
  for (const rel of [SUBSYSTEM, FRAME, INGEST, SESSION]) {
    const source = code(rel)
    for (const primitive of forbidden) {
      assert.ok(
        !source.includes(primitive),
        `${rel} 里出现了 ${primitive} —— 投喂只写记忆（source_scope=feed:…），` +
          '往对话消息流里塞内容会污染她对"现在"的判断（用户明确禁止）',
      )
    }
  }
  // 正面的：框架措辞里必须**否定**"这是刚发生的事"（边界要写出来，不能靠她猜）
  const frame = readFileSync(join(REPO_ROOT, FRAME), 'utf8')
  assert.match(frame, /不许在投喂内容里伪造/, '两条红线要写在注释里（改这段代码的人先读这两条）')
})

test('★ 输入侧：文件是**流式**读的（"任意大"不能先读成一个字符串）', () => {
  const source = code(INGEST)
  assert.match(source, /createReadStream\(/, '文件必须走流式读取（V8 单字符串上限约 512M 字符）')
  assert.match(source, /Symbol\.asyncIterator|for await/, '流式要能被异步迭代消费')
  assert.ok(!/readFileSync\(/.test(source), '输入侧不许 readFileSync（那会把整份文件读成一个字符串）')
  // 二进制/附件决策：含 NUL 就跳过并说明原因
  assert.match(source, /NUL 字节/, '二进制必须被明确拦下（不许静默当记忆喂）')
})
