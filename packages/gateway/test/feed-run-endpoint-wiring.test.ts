/**
 * 「开始投喂」入口的**接线守卫** —— `FIX_PLAN.md` §23 那个洞的收口证据。
 *
 * ## 为什么这条守卫特别重要
 *
 * §23 的审计发现：`startFeedRun()` **零生产调用方** ⇒ 整套投喂闭环
 * （八块模块、40 条测试）**在生产里是死的** —— `turn/start` 上读到
 * `undefined`，于是不排产、不写批次指针、不收窄工具。
 *
 * 而补它的第一个提交（`de80a91`）**又造了一个没人调的入口**
 * （`startFeedRunFromFiles` 当时也是零调用方）—— 我在那个提交里如实写了这件事。
 *
 * ⇒ **这个文件存在的唯一目的，就是钉住"现在真的有生产调用方了"。**
 * 它必须读源码：单测全绿只能证明"函数对"，证明不了"有人在调它"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读源码并**去掉注释**（注释里引用的写法不许把守卫骗过去）。 */
function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const API = code('../src/admin/api.ts')

test('★★★ §23 收口：`startFeedRunFromFiles` **真的有生产调用方**了', () => {
  assert.match(
    API,
    /startFeedRunFromFiles\(db, \{/,
    '★ 必须被 `api.ts`（生产路径）真的调用 —— 否则它和它要修的 `startFeedRun` 是同一种病：' +
      '"写了、测了、没人调"，而那**表现完全等同于"这个功能没启用"**',
  )
})

test('★★★ 端点必须排在 `/feed` **之前**', () => {
  const iNew = API.indexOf("route === '/feed-run'")
  const iOld = API.indexOf("route === '/feed' && method === 'POST'")
  assert.ok(iNew > 0, '找不到 /feed-run 分支')
  assert.ok(iOld > 0, '找不到 /feed 分支')
  assert.ok(
    iNew < iOld,
    '★ 必须排在 `/feed` 之前 —— 两个理由：① TS 会在 `/feed` 分支里把 `route` 收窄，' +
      '之后再比 `\'/feed-run\'` 会被判成"不可能相等"（TS2367）；' +
      '② 路由是顺序匹配的，排在后面可能被前一条抢先命中',
  )
})

test('★★ 枚举素材用 `listFeedFiles`，**不是**自己 readdirSync', () => {
  assert.match(API, /listFeedFiles\(dir\)/, '要用那个已经懂"哪些扩展名算文本、哪些目录要跳过"的函数')
  assert.ok(
    !/readdirSync|readdir\(/.test(API),
    '★ 不许自己在端点里列目录 —— 那会把二进制文件也列进投喂清单（`feed-ingest.ts` 存在的理由）',
  )
})

test('★★ 回包里带上"已经喂到哪"（断点续传的可见形式）', () => {
  assert.match(API, /readFeedCursor\(db, source\)/, '要读游标')
  assert.match(API, /fedThrough: cursor\?\.fedThrough \?\? 0/, '★ 面板要显示"已投喂 N/M 段" —— 否则断点续传对用户是不可见的')
})

test('★ 空目录 / 空来源 / 空目录名都要**明确拒绝**（不许开一次零段的运行）', () => {
  assert.match(API, /source 不能为空/, 'source 是三条线（运行/游标/会话）的关联键，不能空')
  assert.match(API, /dir 不能为空/, 'dir 不能空')
  assert.match(API, /没有可分段的文本素材/, '★ 空目录必须拒绝 —— 开了的话钩子会以为在投喂，**收窄她的工具却没有任何东西可喂**')
})

test('★ 危险动作走 `checkStateChange` + 审计（与 `/feed` 同等把关）', () => {
  const branch = API.slice(API.indexOf("route === '/feed-run'"), API.indexOf("route === '/feed' && method === 'POST'"))
  assert.match(branch, /checkStateChange\(req\)/, '要过那道闸（CSRF/来源检查）')
  assert.match(branch, /requireSession\(req, res, path\)/, '要鉴权')
  assert.match(branch, /audit\(db, \{/, '★ 要落审计 —— 它会收窄她的工具，属于有后果的动作')
  assert.ok(!/action: 'feed-run'/.test(branch), '不许往 `AuditAction` 里塞新值（会牵动审计界面与它的测试）')
})
