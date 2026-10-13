/**
 * 「维护」页的**接线守卫**（读源码断言）—— `FIX_PLAN.md` §76.5④。
 *
 * ## 为什么必须有这一层
 *
 * 后端那两个端点（`GET /api/admin/maintenance` · `POST /api/admin/maintenance/run`）
 * §74 就做完了、**还有一整套守卫**（`gateway/test/maintenance-manual-trigger-wiring.test.ts`）。
 * 而前端**一处都没接** —— 于是"手动那条腿"对人来说**不存在**，
 * 而所有后端测试**照样全绿**（它们问的是"端点调的是不是 `tick()`"，
 * 没有一条问过"有没有人能按到它"）。
 *
 * ★ 这正是本仓栽过 20+ 次的同一个形状：**库/端点写好了，生产路径零调用。**
 *
 * ## 钉四件事
 *
 * ① 页面真的调那两个端点；
 * ② 路由**与侧栏**都登记了（只有路由 = 只能手敲 URL；只有侧栏 = 点了 404）；
 * ③ ★★★ **"跑一轮"必须不带 `only`**（不带 = 三样都跑 = 自动那条完全相同的 `tick()`），
 *    只有"只跑碎片维护"才发 `{ only: 'fragments' }` ——
 *    这是 `ComingSoonView` 那句承诺「走与自动路径完全相同的引擎」在前端的落点；
 * ④ ★ **没有句柄时不许画出能点的按钮**（"没做"与"做了但没生效"要分得开）。
 *
 * ⚠️ **先去掉注释再断言**：本项目栽过"锚点匹配到注释里 ⇒ 结论正好相反"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读源码并**去掉注释行与行尾注释**（判接线时只看真代码）。 */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line))
    .join('\n')
}

const VIEW = 'src/views/MaintenanceView.vue'
const ROUTER = 'src/router.ts'

test('★★ 页面真的调了那两个端点（`GET /maintenance` + `POST /maintenance/run`）', () => {
  const body = code(VIEW)
  assert.match(
    body,
    /api\.get<MaintenanceStatus>\('\/maintenance'\)/,
    '★ 必须读状态端点 —— 否则这一页不知道自己能不能跑',
  )
  assert.match(
    body,
    /api\.post<MaintenanceRunResponse>\('\/maintenance\/run'/,
    '★★ 必须调**写**端点 —— 只读状态是"看得到、按不动"',
  )
})

test('★★★ "跑一轮"不许带 `only`（不带 = 三样都跑 = 与自动那条同一个 tick()）', () => {
  const body = code(VIEW)
  // ★ 语句位置：`fragments` 那个分支才发 only，另一个分支必须是空对象
  assert.match(
    body,
    /const body = scope === 'fragments' \? \{ only: 'fragments' \} : \{\}/,
    '★★★ 只有"只跑碎片维护"才发 `{ only: \'fragments\' }`；"跑一轮"必须发 `{}`。\n' +
      '  ★ 反过来的话，面板上那个"跑一轮"就不再是自动那条腿的同一条路径了 ——\n' +
      '  而那正是 `ComingSoonView` 对用户承诺过的东西（PLAN §2.14.14 说的\n' +
      '  "面板点了压缩，实际参数与自动不一样"就是这个形状）。',
  )
})

test('★★ 路由**与侧栏**都登记了（只有路由 = 只能手敲 URL）', () => {
  const body = code(ROUTER)
  assert.match(
    body,
    /\{ path: '\/maintenance', name: 'maintenance', component: \(\) => import\('\.\/views\/MaintenanceView\.vue'\)/,
    '★ 路由表里要有它',
  )
  assert.match(body, /\{ path: '\/maintenance', title: '维护'/, '★ 侧栏（导航项）里也要有它 —— 否则人找不到这一页')
})

test('★★ 没有句柄时**不画能点的按钮**（"没做"与"做了但没生效"要分得开）', () => {
  const body = code(VIEW)
  assert.match(body, /v-if="!available"/, '★ 要有"跑不了"的分支')
  const unavailableAt = body.indexOf('v-if="!available"')
  const elseAt = body.indexOf('<template v-else>', unavailableAt)
  const firstButtonAt = body.indexOf("run('all')")
  assert.ok(unavailableAt >= 0 && elseAt > unavailableAt, '★ "跑不了"分支之后必须紧跟着 `v-else`')
  assert.ok(
    firstButtonAt > elseAt,
    '★★ 两个按钮都必须在 `v-else` 里。★ 画在外面的话，没有句柄时人会按到一个\n' +
      '  只会回 409 的按钮 —— 那正是 §52 说的"没做与做了但被挡住看起来一样"。',
  )
})

test('★★ 结果要**如实摆出来**（数字 + 失败原因），不能只说"完成"', () => {
  const body = code(VIEW)
  for (const key of ['moved', 'skipped', 'failed']) {
    assert.match(body, new RegExp(`lastRun\\.result\\.${key}`), `★ 要把 ${key} 显示出来`)
  }
  assert.match(body, /lastRun\.result\.failures/, '★ 失败原因要列出来（只报数字等于让人去翻日志）')
  assert.match(body, /lastRun\.result\.longTerm/, '★ 长期沉降那一段要分开显示（它的失败含义与 blob 不同）')
  assert.match(body, /window\.confirm/, '★ 它会真的搬文件：要确认一次')
})
