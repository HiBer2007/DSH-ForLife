/**
 * ★★ 面板「翻历史」的**接线守卫**（读源码断言）—— `FIX_PLAN.md` §57 待办④。
 *
 * ## 为什么要有这一层
 *
 * 服务端那条路（`?history=1` ⇒ 读落盘）有测试（`gateway/test/log-history.test.ts`），
 * 但**前端不接**这件事，行为测试证明不了 —— 本仓为此栽过 20+ 次
 * （端点写好了、面板上没人按得到）。
 *
 * ## 钉四件事
 *
 * 1. ★ 页面真的用 `history: 1` 去问，而且把**当前筛选**（模块/等级/关键词）一起带上；
 * 2. ★★ 服务端回的 `source` 必须被**分辨**：`store` = 真翻了落盘，`buffer` = 没接上、退回缓冲
 *    ⇒ ★ **不许把两者显示成一样**（§52：''没做''与''做了但没生效''要分得开）；
 * 3. ★ 历史模式要**暂停实时**（否则新旧两批混在一起，看起来像乱序）；
 * 4. ★ 要能**回到实时**（不然人被困在一批静态快照里）。
 *
 * ⚠️ 先去掉注释再断言（本仓栽过"锚点匹配到注释里 ⇒ 结论正好相反"）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读源码并去掉注释行（判接线时只看真代码）。 */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line))
    .join('\n')
}

const VIEW = 'src/views/LogsView.vue'

test('★★★ 页面真的用 `history: 1` 去问，并把当前筛选一起带上', () => {
  const body = code(VIEW)
  assert.match(body, /history: 1/, '★ 必须真的请求历史（只加个按钮不算）')
  assert.match(body, /api\.get<LogsPayload>\('\/logs', \{/, '要调 `/logs`')
  assert.match(body, /modules: module\.value/, '★ 模块筛选要带过去（否则"翻历史"翻的还是全部）')
  assert.match(body, /levels: levels\.value\.join\(','\)/, '★ 等级筛选要带过去')
  assert.match(body, /q: keyword\.value\.trim\(\)/, '★ 关键词要带过去')
})

test('★★★ 服务端的 `source` 必须被分辨：`store`（真翻落盘）vs `buffer`（没接上）', () => {
  const body = code(VIEW)
  assert.match(body, /historySource\.value = data\.source/, '★ 要记下服务端说的来源')
  assert.match(body, /historySource === 'store'/, '★ `store` 要有分支（并说"这是落盘、14 天"）')
  assert.match(
    body,
    /historySource === 'buffer'/,
    '★★ `buffer` 也要有分支 —— ★ 而且要说清"服务端没接上落盘，这次其实还是读内存"：\n' +
      '  把两者显示成一样，人就以为"历史翻过了"，而真相是"什么都没翻到"。',
  )
})

test('★★ 历史模式要**暂停实时**（否则新旧两批混在一起，看起来像乱序）', () => {
  const body = code(VIEW)
  const at = body.indexOf('async function runHistory')
  assert.ok(at >= 0, '要有 `runHistory`')
  const fn = body.slice(at, at + 1200)
  assert.match(fn, /paused\.value = true/, '★ 翻历史时要暂停实时视图')
})

test('★ 要能**回到实时**（不然人被困在一批静态快照里）', () => {
  const body = code(VIEW)
  assert.match(body, /function backToLive/, '要有 `backToLive`')
  const at = body.indexOf('function backToLive')
  const fn = body.slice(at, at + 400)
  assert.match(fn, /paused\.value = false/, '★ 回去要恢复实时')
  assert.match(body, /@click="backToLive"/, '★ 界面上要按得到')
  assert.match(body, /history: 1/, '★ 而且"再翻一次"仍走历史那条路')
})
