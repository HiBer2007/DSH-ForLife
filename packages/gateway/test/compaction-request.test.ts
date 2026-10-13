/**
 * ★★ 面板"手动排队一次压缩"的守卫（`FIX_PLAN.md` §78.49，用户裁定"走二"）。
 *
 * ## 为什么这条最需要守卫
 *
 * 这个功能是**跨进程**的：管理接口在 **gateway** 进程写状态键，引擎在 **dsh** 进程读它
 * （`ForlifeCompactionEngine.compactIfNeeded` → `runtime.takePendingCompactionRequest()`）。
 * ★ 两边**键名写错一个字母不会有任何报错** —— 用户点了按钮，"什么都没发生"，而且**没人知道为什么**。
 *
 * ⇒ 所以这里钉三件事：
 * 1. ★★ 两边用的是**同一个键名**（源码级对读，不是"我记得是"）；
 * 2. 路由**真的**写了那个键、落了审计、并且**在响应里说清"这是排队不是立即执行"**；
 * 3. 路由走了既有的两道闸（`checkStateChange` 防跨站 + `requireSession` 要登录）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 读一个源码文件，**去掉注释行**（★ 注释里提到键名不算"用了它"）。 */
function codeOf(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

test('★★★ 跨进程键名一致：管理接口写的键 = 引擎读的键', async () => {
  const { PENDING_COMPACTION_KEY } = await import('../src/admin/api.ts')
  assert.equal(PENDING_COMPACTION_KEY, 'acct_pending_compaction', '★ 键名是本功能的跨进程契约')
  const engine = codeOf('../../dsh-component/src/runtime.ts')
  assert.match(
    engine,
    new RegExp(`getState\\('${PENDING_COMPACTION_KEY}'\\)`),
    '★ 引擎必须从**同一个键**读（`takePendingCompactionRequest` 用 getState 读它）',
  )
  assert.match(engine, /requestCompaction\(/, '引擎侧仍要有入队方法（模型的 request_compaction 走它）')
})

test('★★ 路由真的写了那个键、落了审计（防"接口在、什么也没做"）', () => {
  const api = codeOf('../src/admin/api.ts')
  assert.match(api, /'\/maintenance\/compact' && method === 'POST'/, '路由要在')
  assert.match(api, /INSERT INTO forlife_state \(key, value\) VALUES \(\?, \?\)/, '★ 要真的写状态键')
  assert.match(api, /\.run\(PENDING_COMPACTION_KEY, payload\)/, '★ 写的是那个键（不是别的字面量）')
  assert.match(api, /action: 'maintenance\.compact'/, '★ 要落审计（写操作必须留痕）')
  assert.match(api, /checkStateChange\(req\)/, '★ 要走防跨站那道闸')
  assert.match(api, /requireSession\(req, res, path\)/, '★ 要登录才能触发')
})

test('★★ 响应必须说清"这是排队，不是立即执行"（最容易骗人的地方）', () => {
  const api = codeOf('../src/admin/api.ts')
  assert.match(api, /queued: true/, '要明确回一个"已排队"')
  assert.match(api, /不是立即执行/, '★ 必须写清它不会马上跑（触发器在宿主那边，要有会话在动）')
  assert.match(api, /replacedPending/, '★ 要告诉调用方"之前那条待执行的被覆盖了没有"')
})
