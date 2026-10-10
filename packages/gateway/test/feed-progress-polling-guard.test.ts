/**
 * 面板**轮询投喂进度**的接线守卫。
 *
 * ## 为什么需要它（这是上一轮我自己标出来的缺口）
 *
 * `.vue` 这一侧此前**只靠 `vue-tsc`** —— 而它管的是**类型**，
 * **不管"有没有在轮询"**。⇒ 谁把 `startPolling()` 删了，**不会有测试变红**，
 * 而症状是"面板上那个'已投喂'永远不动"，看起来像**投喂卡住了**。
 *
 * ⇒ 补上源码守卫（本仓那条纪律：**每个新接线配接线守卫**，
 *   而 `.vue` 也是代码，不该因为是模板文件就免掉）。
 *
 * ## 这里钉的四条，每条都对应一个真实故障
 *
 * | 断言 | 少了它会怎样 |
 * | :--- | :--- |
 * | 开始成功后调 `startPolling()` | 数字停在"开始那一刻"，用户**以为卡住了** |
 * | 喂完调 `stopPolling()` | 定时器一直问（她不会再开始，纯浪费） |
 * | `onBeforeUnmount(stopPolling)` | 切走之后定时器还在跑 —— **内存与请求双漏** |
 * | 进页面先问一次 | 别处开始的投喂**在这一页看不见**（页面显示"什么都没有"而真相是"正在跑"） |
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 读 `.vue` 的**脚本部分**并去掉注释。
 *
 * 只取 `<script setup>` 到 `</script>` 之间：模板里也有 `startPolling` 之类的字样吗？
 * 没有 —— 但**去掉模板能保证"断言命中的是逻辑，不是标记"**，
 * 而且模板里的同名文本不该让守卫通过。
 */
function feedViewScript(): string {
  const raw = readFileSync(new URL('../../admin-ui/src/views/FeedView.vue', import.meta.url), 'utf8')
  const start = raw.indexOf('<script')
  const end = raw.indexOf('</script>')
  assert.ok(start >= 0 && end > start, '找不到 <script> 段 —— FeedView.vue 的形状变了，这条守卫要跟着改')
  return raw
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const SCRIPT = feedViewScript()

test('★★★ 开始投喂成功之后**真的开了轮询**（否则数字停在"开始那一刻"）', () => {
  // 成功分支里必须有 startPolling()
  const startRunAt = SCRIPT.indexOf('async function startRun(')
  assert.ok(startRunAt > 0, '找不到 startRun —— 形状变了')
  const body = SCRIPT.slice(startRunAt, SCRIPT.indexOf('</script>'))
  assert.match(
    body,
    /startPolling\(\)/,
    '★ 成功之后必须开轮询 —— 不开的话面板上那个"已投喂"永远不动，而用户会**以为投喂卡住了**',
  )
  assert.match(body, /void refreshProgress\(\)/, '开的同时立刻问一次（别等 3 秒）')
})

test('★★★ 进页面先问一次（别处开始的投喂也要能看见）', () => {
  assert.match(
    SCRIPT,
    /onMounted\(\(\) => \{[\s\S]{0,200}?refreshProgress\(\)/,
    '★ 进页面先问一次 —— 否则"别处正在投喂"在这一页显示成"什么都没有"，**而真相是正在跑**',
  )
  assert.match(SCRIPT, /onBeforeUnmount\(stopPolling\)/, '★ 离开页面必须停 —— 不停的话切走之后定时器还在跑（**内存与请求双漏**）')
})

test('★★ 喂完要停（没必要一直问 —— 她不会自己再开始）', () => {
  assert.match(
    SCRIPT,
    /next\.active !== true \|\| next\.done === true\) stopPolling\(\)/,
    '★ 没有在投喂 / 已喂完 ⇒ 停轮询',
  )
})

test('★★ 间隔是个**有名字的常量**（别把 3000 散在代码里）', () => {
  assert.match(SCRIPT, /const POLL_MS = \d+/, '间隔要有名字，且能一眼看出是多长')
  assert.match(SCRIPT, /setInterval\(\(\) => void refreshProgress\(\), POLL_MS\)/, '用的是那个常量')
})

test('★ 读数失败**不许**打扰用户，也不许把轮询打死', () => {
  const at = SCRIPT.indexOf('async function refreshProgress(')
  assert.ok(at > 0, '找不到 refreshProgress')
  const body = SCRIPT.slice(at, at + 600)
  assert.match(body, /catch \{/, '要自己接住读数失败')
  assert.ok(
    !/catch[\s\S]{0,120}stopPolling\(\)/.test(body),
    '★ 读数失败**不许**停轮询 —— 一次网络抖动就让进度永远不动，那比不显示更糟',
  )
})
