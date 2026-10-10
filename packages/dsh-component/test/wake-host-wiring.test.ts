/**
 * 唤醒桥**自建监听**（`FIX_PLAN.md` D7，用户裁定 **D-B**）的接线守卫。
 *
 * ## 这个文件在防什么
 *
 * DSH 的 `webServer` 只绑回环 ⇒ 同 docker 网络的 gateway 够不到它 ⇒
 * 面板那张「DSH 后端」卡永远显示"未配置/连接超时"。用户裁定 D-B：**自己起一个监听**。
 *
 * 三条断言，每一条都对应一个**会悄悄退化**的失败模式：
 *
 * 1. **两条路必须独立**（源码）：如果谁把它改成 `if (webServer) … else 自建`,
 *    那么"DSH 哪天不给 webServer 了"就会连带把**面板接口**一起弄没 ——
 *    而那与唤醒桥是两件事。**必须是并行，不是降级。**
 * 2. **不许有第二套鉴权**（源码）：鉴权在 `handleWakeRequest` 里。这里再写一份
 *    必然与那份漂移，而漂移的那一套会变成**后门**。
 * 3. **真起一个 server 打一发**（行为）：只测"函数被调用了"是不够的 ——
 *    要真的证明**绑定能用、路由能通、未知路径 404、超大 body 被挡**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { MAX_BODY_BYTES, startWakeHost } from '../src/wake-host.ts'

/** 读源码并**去掉注释** —— 否则注释里引用的旧写法会把守卫骗过去（本仓栽过）。 */
function code(relative: string): string {
  const raw = readFileSync(new URL(relative, import.meta.url), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const INDEX = code('../src/index.ts')
const WAKE_HOST = code('../src/wake-host.ts')

test('★★ 接线守卫：两条路**并行**（不是 if/else 降级）', () => {
  // ①两条路都真的挂了端点（各自调用 registerWakeEndpoint 一次）
  const mounts = INDEX.match(/registerWakeEndpoint\(/g) ?? []
  assert.ok(
    mounts.length >= 2,
    `index.ts 里应当有**两处** registerWakeEndpoint（webServer 那条 + 自建那条），实际 ${String(mounts.length)} 处 —— ` +
      '只剩一处说明有人把自建那条改成了降级分支',
  )

  // ②自建那条**不经过** webServer 判空：它的失败分支只该谈"缺服务/没端口"
  const own = INDEX.slice(INDEX.indexOf('function mountOwnWakeHost'))
  const ownBody = own.slice(0, own.indexOf('\nfunction ', 1) < 0 ? own.length : own.indexOf('\nfunction ', 1))
  assert.ok(
    !ownBody.includes("ctx.get('webServer')"),
    '自建那条**不许**依赖 webServer 是否存在 —— 它存在与否都该照常起（并行，不是降级）',
  )

  // ③两条路共用同一份宿主适配（复制粘贴会漂移）
  const hostBuilders = INDEX.match(/wakeHostOf\(ctx, log\)/g) ?? []
  assert.ok(
    hostBuilders.length >= 2,
    `wakeHostOf 必须被两条路共用（应有 ≥2 处调用），实际 ${String(hostBuilders.length)} —— ` +
      '各写一份的话，createMessage/withoutInitiator 的适配迟早漂移',
  )
})

test('★★ 接线守卫：`wake-host.ts` 里**没有第二套鉴权**', () => {
  // 反面清单：密钥比较、时间恒定比较、token 解析 —— 这些只该出现在 handleWakeRequest 那边
  for (const forbidden of ['secret', 'timingSafeEqual', 'authorization', 'Authorization']) {
    assert.ok(
      !WAKE_HOST.includes(forbidden),
      `wake-host.ts 里出现了 "${forbidden}" —— 鉴权只许在 wake-bridge-endpoint.ts 里有一份。` +
        '第二套必然漂移，而漂移的那一套会变成后门。',
    )
  }
})

test('★★ 行为：真起一个监听 —— 已注册路径通、未知路径 404、超大 body 被挡', async () => {
  // 用一个高位固定端口（本仓既有做法，见 `scripts/napcat-probe.mjs` 的说明）
  const port = 34567
  const host = startWakeHost({ port })
  try {
    let seen: { headers: Record<string, string | undefined>; body: string } | undefined
    host.register({
      kind: 'exact',
      path: '/forlife/wake',
      handler: async (req) => {
        seen = { headers: req.headers, body: req.body ?? '' }
        return { status: 200, body: { ok: true, echo: req.body ?? '' } }
      },
    })
    const base = `http://127.0.0.1:${String(port)}`

    // ① 已注册路径：通，且**请求体与头部真的传到了 handler**
    const ok = await fetch(`${base}/forlife/wake`, {
      method: 'POST',
      headers: { 'x-forlife-secret': 'test', 'content-type': 'application/json' },
      body: '{"sessionId":"s1"}',
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true, echo: '{"sessionId":"s1"}' })
    assert.equal(seen?.headers['x-forlife-secret'], 'test', '头部必须原样交给端点（鉴权就靠它）')
    assert.equal(seen?.body, '{"sessionId":"s1"}', '请求体必须原样交给端点')

    // ② 未知路径：404，且**不回一份端点清单**（那等于给探测者指路）
    const missing = await fetch(`${base}/forlife/other`, { method: 'POST' })
    assert.equal(missing.status, 404)
    const text = await missing.text()
    assert.ok(!text.includes('/forlife/wake'), `404 的响应里不许列出有哪些端点：${text}`)

    // ③ 超大 body：413（没有上限的 POST 就是内存放大器）
    const huge = await fetch(`${base}/forlife/wake`, {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_BYTES + 1024),
    })
    assert.equal(huge.status, 413, '超过上限的请求体必须被挡下，而不是照单全收')
  } finally {
    await host.close()
  }
})

test('★ 守卫：`register` 返回的注销函数真的能摘掉路由', async () => {
  const port = 34568
  const host = startWakeHost({ port })
  try {
    const dispose = host.register({ kind: 'exact', path: '/x', handler: async () => ({ status: 200, body: {} }) })
    const base = `http://127.0.0.1:${String(port)}`
    assert.equal((await fetch(`${base}/x`)).status, 200)
    dispose()
    assert.equal((await fetch(`${base}/x`)).status, 404, '注销之后必须真的打不通（否则 dispose 是装饰）')
  } finally {
    await host.close()
  }
})
