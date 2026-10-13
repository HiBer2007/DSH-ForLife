/**
 * 「运行总览」实时刷新的**接线守卫**（读源码断言）。
 *
 * ## 为什么必须有这一层
 *
 * 缺陷的形态**不是"没有定时器"**：`OverviewView.vue` 里原来手写着一个 15 秒的
 * `setInterval`，它一直在跑、控制台也不报错 —— 但里面只调了 `state.refresh()`
 * （`/overview`），而页面上最大的一块「运行图表」来自**另一个接口** `/series`，
 * 它**从打开页面起再也没刷过**。界面上看就是"总览不实时刷新"，
 * 而**所有单测全绿**（没有一条测试问过"那个定时器到底刷了哪些数据源"）。
 *
 * ⇒ 这里读源码钉住三件事：
 *  ① 总览的**两块**数据都挂着 `pollMs`；
 *  ② 总览**不许再手写定时器**（手写那次就漏了 `/series`）；
 *  ③ `useAsyncData` 里 `Poller` **真的被 `start()` 了**（写个类不接上 = 完全不轮询），
 *    且可见性监听与卸载清理都在。
 *
 * ⚠️ **先去掉注释再断言**：本项目栽过"锚点匹配到注释里 ⇒ 结论正好相反"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读源码并**去掉注释行**（判接线时只看真代码，这是本项目的教训）。 */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/**
 * 某个接口调用里带了 `pollMs` 吗？
 *
 * 判据：路径字面量之后 400 字符内出现 `pollMs:` —— 400 是同一次调用的合理范围
 * （选项对象就写在参数位置上）。这样写而不是解析 AST，是因为我们要判的正是
 * **"这个接口的取数有没有挂上节奏"**，而不是"文件里出现过 pollMs"。
 */
function polls(source: string, path: string): boolean {
  const at = source.indexOf(`'${path}'`)
  if (at < 0) return false
  return /pollMs\s*:/.test(source.slice(at, at + 400))
}

const OVERVIEW = code('src/views/OverviewView.vue')
const USE_ASYNC = code('src/composables/useAsyncData.ts')
const POLLER = code('src/poll-schedule.ts')

test('★★★ 接线守卫：总览的**两块**数据都挂着轮询（图表曾经一次都不刷）', () => {
  assert.ok(polls(OVERVIEW, '/overview'), '指标卡（/overview）没挂 pollMs')
  assert.ok(
    polls(OVERVIEW, '/series'),
    '**运行图表（/series）没挂 pollMs** —— 这正是"总览不实时刷新"的原始形态：' +
      '定时器只刷了 /overview，图表从打开页面起就是一张静止的照片',
  )
})

test('★★ 总览不许再手写定时器（手写过的那次就漏了 /series）', () => {
  assert.ok(
    !OVERVIEW.includes('setInterval'),
    '定时器统一交给 useAsyncData 的 pollMs；页面里手写 setInterval 会再次只刷一半数据源',
  )
  assert.ok(
    !OVERVIEW.includes('visibilitychange'),
    '可见性判断也统一在 useAsyncData 里（每个页面各写一遍必然写歪）',
  )
})

test('★★★ 接线守卫：useAsyncData **真的把 Poller 接上了**（不是只写了个类）', () => {
  assert.match(USE_ASYNC, /new Poller\(/, 'useAsyncData 要 new Poller')
  assert.match(USE_ASYNC, /poller\.start\(\)/, '**必须真的 start**（只 new 不 start = 完全不轮询）')
  assert.match(USE_ASYNC, /poller\.pause\(\)/, '切到后台要暂停（省电省流量）')
  assert.match(USE_ASYNC, /poller\.resume\(\)/, '切回前台要立刻补一次')
  assert.match(
    USE_ASYNC,
    /document\.visibilityState === 'visible'/,
    '不可见时不许发请求（这是 pause 之外的第二道闸）',
  )
  assert.match(USE_ASYNC, /addEventListener\('visibilitychange'/, '要听可见性变化')
  assert.match(USE_ASYNC, /removeEventListener\('visibilitychange'/, '卸载要摘掉监听')
  assert.match(USE_ASYNC, /poller\.stop\(\)/, '卸载要停掉定时器（否则切页几次就攒下一堆定时器在打接口）')
})

test('★ 轮询策略是纯的（能在 node:test 里直接跑，不依赖浏览器）', () => {
  // 纯 = 不 import vue、不读 document。这样它才测得动（`poll-schedule.test.ts` 本身就是证据）。
  assert.ok(!/from 'vue'/.test(POLLER), 'poll-schedule.ts 不许依赖 vue')
  assert.ok(!POLLER.includes('document.'), 'poll-schedule.ts 不许直接读 document（可见性由调用方决定）')
})

test('★★ 同一问题的其它状态页也挂上了（同一套机制，不许各写各的定时器）', () => {
  const pages: readonly (readonly [string, string])[] = [
    ['src/views/ConversationsView.vue', '/conversations'],
    ['src/views/NapcatView.vue', '/napcat'],
    ['src/views/PortsView.vue', '/ports'],
    ['src/views/RoutingView.vue', '/routing'],
  ]
  for (const [file, path] of pages) {
    assert.ok(polls(code(file), path), `${file} 的 ${path} 没挂 pollMs（这一页会永远停在"打开那一刻"）`)
  }
})
