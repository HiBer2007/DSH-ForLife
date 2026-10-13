/**
 * 顶栏「刷新指示器 + 最后刷新时间」的测试 —— **纯策略 + 接线守卫**。
 *
 * ## 为什么分两层
 *
 *  - **纯策略层**（`refresh-activity.ts`）：登记/注销/聚合/文案都是纯的，
 *    可以在 `node:test` 里精确断言（"晚到的响应不许把已注销的数据源复活"这种
 *    只有真跑才看得出来的事，源码守卫一点用都没有）；
 *  - **接线守卫层**：用户报的那个缺陷（**面板刷新时界面跳动**）**在纯逻辑里根本不存在** ——
 *    `v-if` 写在模板里、`display` 写在 CSS 里，运行时才变成一次 reflow。
 *    所以必须读源码，把"这个提示块永远占位"钉住。
 *
 * ## 那个跳动的根因（写在这里，免得以后有人又改回去）
 *
 * `AsyncSection.vue` 里刷新提示原来是 `<div v-if="loading" class="refreshing">`：
 * 轮询每来一次它就进/出**文档流**，把下面所有内容顶下去 `高度 + margin-bottom`
 * （约 30px），请求回来再弹回来 ⇒ "顶部闪一下、整页抖一下"。
 * 修法是**永远占位 + 只切可见性**（`visibility: hidden` 的元素照样占位），
 * **不是删掉它** —— 用户要的是"别跳"，不是"别显示"。
 *
 * @module @forlife/admin-ui/test/refresh-activity
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RefreshRegistry, formatRefreshAge } from '../src/refresh-activity.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读源码并**去掉注释**（判接线时只看真代码，这是本项目的教训）。 */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 源码原文（查 CSS / 模板属性用；这些地方本来就不该被注释干扰）。 */
function raw(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

// ════════════════════════════════════════════════════════════════════════════
// ① 纯策略：登记表
// ════════════════════════════════════════════════════════════════════════════

test('★ 登记一个数据源：初始是"没在刷新、还没成功过"', () => {
  const registry = new RefreshRegistry()
  const id = registry.register()
  assert.deepEqual(registry.activity, { refreshing: false, lastSuccessAt: undefined, sources: 1 })
  registry.unregister(id)
})

test('★★ 正在刷新：任一数据源在飞 ⇒ 整体为真；全部落地 ⇒ 假', () => {
  const registry = new RefreshRegistry()
  const a = registry.register()
  const b = registry.register()

  registry.setLoading(a, true)
  assert.equal(registry.activity.refreshing, true, '有一个在飞就该显示"刷新中"')
  registry.setLoading(a, false)
  assert.equal(registry.activity.refreshing, false)

  registry.setLoading(a, true)
  registry.setLoading(b, true)
  registry.setLoading(a, false)
  assert.equal(registry.activity.refreshing, true, '还有一个在飞，不许说"刷完了"')
  registry.setLoading(b, false)
  assert.equal(registry.activity.refreshing, false)
})

test('★★★ 最后刷新时间取 **max**（页面上"最新那块数据"的新鲜度）', () => {
  const registry = new RefreshRegistry()
  const overview = registry.register()
  const series = registry.register()

  registry.setSuccess(overview, 1_000)
  assert.equal(registry.activity.lastSuccessAt, 1_000)
  registry.setSuccess(series, 500)
  assert.equal(
    registry.activity.lastSuccessAt,
    1_000,
    '慢的那块（/series 60s）后成功，不该把整页的新鲜度拉回旧值 —— 那是 min 的语义',
  )
  registry.setSuccess(series, 2_000)
  assert.equal(registry.activity.lastSuccessAt, 2_000, '更新的那次要赢')
})

test('★★★ 注销之后：这个数据源不再贡献任何事实（页面卸载后的陈旧数字必须消失）', () => {
  const registry = new RefreshRegistry()
  const a = registry.register()
  registry.setLoading(a, true)
  registry.setSuccess(a, 5_000)
  assert.equal(registry.activity.sources, 1)

  registry.unregister(a)
  assert.deepEqual(
    registry.activity,
    { refreshing: false, lastSuccessAt: undefined, sources: 0 },
    '注销后不许再报"刷新中"或一个已经不在屏幕上的新鲜度',
  )
})

test('★★★ 注销后晚到的响应**不许**把它复活（组件卸载后响应才回来的经典泄漏）', () => {
  const registry = new RefreshRegistry()
  const a = registry.register()
  registry.unregister(a)
  // 在飞的那次请求现在才回来 —— `useAsyncData` 的 finally / 成功分支都会走到这里
  registry.setLoading(a, true)
  registry.setSuccess(a, 9_999)
  assert.deepEqual(
    registry.activity,
    { refreshing: false, lastSuccessAt: undefined, sources: 0 },
    '注销之后 setLoading/setSuccess 必须是**空操作** —— 否则切页几次就会攒下一堆幽灵数据源',
  )
})

test('★ 值没变就不通知（每秒一次的空转不该惊动界面）', () => {
  const registry = new RefreshRegistry()
  const id = registry.register()
  let calls = 0
  const unsubscribe = registry.subscribe(() => {
    calls += 1
  })
  const afterRegister = calls

  registry.setLoading(id, false) // 本来就是 false
  assert.equal(calls, afterRegister, '重复设同一个值不该通知')
  registry.setLoading(id, true)
  assert.equal(calls, afterRegister + 1)
  registry.setLoading(id, true)
  assert.equal(calls, afterRegister + 1, '第二次设 true 也不该通知')

  unsubscribe()
  registry.setLoading(id, false)
  assert.equal(calls, afterRegister + 1, '退订之后不许再被叫醒')
})

test('★ 多个订阅者都收到；退订幂等', () => {
  const registry = new RefreshRegistry()
  let a = 0
  let b = 0
  const offA = registry.subscribe(() => {
    a += 1
  })
  const offB = registry.subscribe(() => {
    b += 1
  })
  registry.register()
  assert.equal(a, 1)
  assert.equal(b, 1)
  offA()
  offA() // 幂等
  registry.register()
  assert.equal(a, 1)
  assert.equal(b, 2)
})

// ════════════════════════════════════════════════════════════════════════════
// ② 纯策略：文案（必须自己走，且不出现 NaN/undefined）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 文案：刚刚 → N 秒前 → N 分钟前 → 绝对时刻（超 1 小时）', () => {
  const now = 1_700_000_000_000
  assert.equal(formatRefreshAge(undefined, now), '—', '还没成功过要给占位符，不是 NaN')
  assert.equal(formatRefreshAge(Number.NaN, now), '—', '脏值也要给占位符')
  assert.equal(formatRefreshAge(now, now), '刚刚')
  assert.equal(formatRefreshAge(now - 4_999, now), '刚刚')
  assert.equal(formatRefreshAge(now - 5_000, now), '5 秒前')
  assert.equal(formatRefreshAge(now - 59_999, now), '59 秒前')
  assert.equal(formatRefreshAge(now - 60_000, now), '1 分钟前')
  assert.equal(formatRefreshAge(now - 3_599_999, now), '59 分钟前', '不许出现"60 分钟前"')
  // 超过 1 小时改成绝对时刻（定宽，不会把顶栏推来推去）
  assert.match(formatRefreshAge(now - 3_600_000, now), /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(
    formatRefreshAge(now - 86_400_000, now),
    new Date(now - 86_400_000).toLocaleTimeString('zh-CN', { hour12: false }),
  )
})

test('★ 文案：时钟回拨（时间戳在未来）不许显示负数秒', () => {
  const now = 1_700_000_000_000
  assert.equal(formatRefreshAge(now + 3_000, now), '刚刚')
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 接线守卫：(a) 那个"跳动"不许再回来
// ════════════════════════════════════════════════════════════════════════════

/** 取某个标签的**开标签那一行**（属性都写在同一行，找不到就 fail）。 */
function openingTag(source: string, needle: string): string {
  const at = source.indexOf(needle)
  assert.ok(at >= 0, `源码里找不到 \`${needle}\` —— 结构变了，守卫要跟着改（别静默通过）`)
  const lineStart = source.lastIndexOf('\n', at) + 1
  const lineEnd = source.indexOf('\n', at)
  return source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
}

const ASYNC_SECTION = raw('src/components/AsyncSection.vue')

test('★★★ 守卫：刷新提示**不许**再挂在 `v-if` / `v-show` 上（那个跳动的根因）', () => {
  const tag = openingTag(ASYNC_SECTION, 'class="refresh-slot"')
  for (const directive of ['v-if', 'v-show', 'v-else']) {
    assert.ok(
      !tag.includes(directive),
      `刷新提示的开标签上有 \`${directive}\`：\n  ${tag.trim()}\n` +
        '这正是用户报的"刷新时界面跳动"——元素进/出文档流会把下面所有内容顶下去。' +
        '元素必须**永远占位**，只切 `visibility`（见同文件的样式注释）。',
    )
  }
})

test('★★★ 守卫：这个提示块的高度是**写死**的，可见性才随 `loading` 变', () => {
  // 断言的是"这一条规则里同时有固定高度和 visibility: hidden"，不是"文件里出现过这两个词"
  const block = /\.refresh-slot\s*\{([^}]*)\}/.exec(ASYNC_SECTION)
  assert.ok(block !== null, 'AsyncSection.vue 里找不到 `.refresh-slot { … }` 规则')
  const body = block[1] ?? ''
  assert.match(body, /(^|\s)height:\s*\d+px/, '`.refresh-slot` 必须有**固定** height —— 高度随内容变就还是一次重排')
  assert.match(body, /visibility:\s*hidden/, '用 visibility 而不是 display/v-if：前者**照样占位**')
  assert.ok(!/display:\s*none/.test(body), '`display: none` 会撤掉占位，正是要避免的')
  assert.match(
    ASYNC_SECTION,
    /\.refresh-slot\[data-active='true'\]\s*\{[^}]*visibility:\s*visible/,
    '可见性要由 `data-active`（绑 `loading`）切换 —— 这是它与"正在刷新"之间唯一的联系',
  )
  assert.match(
    ASYNC_SECTION,
    /class="refresh-slot"\s+:data-active="loading"/,
    '`data-active` 必须绑在 `loading` 上，否则提示永远不会亮',
  )
})

test('★★ 守卫：底部那行"最后更新于…"也不许凭空多出一行（首次加载同样会跳）', () => {
  const tag = openingTag(ASYNC_SECTION, 'class="stamp muted"')
  assert.ok(
    !tag.includes('v-if'),
    `底部时间戳又挂上 v-if 了：\n  ${tag.trim()}\n` +
      '首次成功时它会凭空多出一行，页面高度跳一次。改成"永远占一行 + 切可见性"。',
  )
  const block = /\.stamp\s*\{([^}]*)\}/.exec(ASYNC_SECTION)
  assert.ok(block !== null, 'AsyncSection.vue 里找不到 `.stamp { … }` 规则')
  assert.match(block[1] ?? '', /visibility:\s*hidden/, '`.stamp` 也要用 visibility 占位')
  assert.match(block[1] ?? '', /tabular-nums/, '时间戳数字要等宽，否则每秒变宽度时文字会抖')
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 接线守卫：(b) 顶栏的指示器 + 最后刷新时间
// ════════════════════════════════════════════════════════════════════════════

const APP_VUE = code('src/App.vue')
const USE_ASYNC = code('src/composables/useAsyncData.ts')
const REFRESH_ACTIVITY = code('src/refresh-activity.ts')
const APP_VUE_RAW = raw('src/App.vue')

/** 取 `<header class="topbar"> … </header>` 整段。 */
function topbarBlock(source: string): string {
  const start = source.indexOf('<header class="topbar">')
  assert.ok(start >= 0, 'App.vue 里找不到 `<header class="topbar">` —— 顶栏结构变了？')
  const end = source.indexOf('</header>', start)
  assert.ok(end > start, '顶栏没有闭合标签')
  return source.slice(start, end)
}

test('★★★ 守卫：指示器与最后刷新时间**真的在顶栏里**（放到页面里就不叫顶栏了）', () => {
  const topbar = topbarBlock(APP_VUE_RAW)
  assert.match(topbar, /class="refresh"/, '顶栏里必须有刷新指示器那一块')
  assert.match(topbar, /class="refresh-icon"/, '指示器要有图标（"正在刷新"就靠它转起来）')
  assert.match(topbar, /class="refresh-age"/, '顶栏里必须显示最后刷新时间')
  assert.match(topbar, /:data-refreshing="activity\.refreshing"/, '"正在刷新"必须绑在聚合状态上，不能是静态的')
})

test('★★★ 守卫：顶栏的状态**来自 `useAsyncData`**，不是另起一套', () => {
  assert.match(
    APP_VUE,
    /useRefreshActivity\(\)/,
    'App.vue 必须用 `useRefreshActivity()` 取状态（登记表是 `useAsyncData` 的唯一投影）',
  )
  assert.match(APP_VUE, /formatRefreshAge\(/, '相对时间文案要走 `formatRefreshAge`（纯函数，可测）')
  // 外壳自己**不许**轮询、不许直接打接口：那会变成第二套状态
  assert.ok(!APP_VUE.includes('pollMs'), '外壳不许挂 pollMs —— 刷新节奏归页面数据源管')
  assert.ok(!/api\.get</.test(APP_VUE), '外壳不许自己打接口')

  // `useAsyncData` 侧：登记 / 注销 / 上报都要在（缺一个，顶栏就会撒谎）
  assert.match(USE_ASYNC, /refreshActivity\.register\(\)/, '数据源要在 setup 时登记')
  assert.match(USE_ASYNC, /refreshActivity\.unregister\(activityId\)/, '**卸载必须注销**：否则顶栏会报幽灵数据源')
  assert.match(
    USE_ASYNC,
    /refreshActivity\.setSuccess\(activityId,\s*updatedAt\.value\)/,
    '成功时要上报**与 `updatedAt` 同一个值**（两处各算一次 Date.now() 就会漂）',
  )
  assert.match(USE_ASYNC, /refreshActivity\.setLoading\(activityId,\s*true\)/, '开刷时要上报"刷新中"')
  assert.match(USE_ASYNC, /refreshActivity\.setLoading\(activityId,\s*false\)/, '落地后要上报"刷完了"')
})

test('★★ 守卫：聚合层是**纯的**（不 import vue），文案能被 node:test 直接跑', () => {
  assert.ok(
    !/from 'vue'/.test(REFRESH_ACTIVITY),
    'refresh-activity.ts 不许依赖 vue —— 它必须能像 poll-schedule.ts 那样被直接测',
  )
  assert.ok(
    !REFRESH_ACTIVITY.includes('document.'),
    'refresh-activity.ts 不许直接读 document（可见性由调用方决定）',
  )
})

test('★★ 守卫：时间文案每秒自己走，但宽度**不由文字长度决定**', () => {
  const block = /\.refresh-age\s*\{([^}]*)\}/.exec(APP_VUE_RAW)
  assert.ok(block !== null, 'App.vue 里找不到 `.refresh-age { … }` 规则')
  const body = block[1] ?? ''
  assert.match(body, /min-width:\s*[\d.]+em/, '必须给 `min-width`：文案每秒在变，宽度不能跟着变')
  assert.match(body, /tabular-nums/, '数字要等宽（"12 秒前" → "13 秒前" 时不该抖）')
  assert.match(
    APP_VUE,
    /useNow\(1000\)/,
    '相对时间必须自己走（每秒一次），否则"轮询死了"在界面上看不出来',
  )
})
