/**
 * PLAN 阶段 7 的**真机验收**（对着四条标准逐条验）。
 *
 * 需要一个真 Caddy 在跑（admin 2019 + 服务端口 18080）。
 *
 * ## 四条验收
 *  1. 工作区内起一个 HTTP 服务 → publish → **经 Caddy 可访问**；
 *  2. unpublish 后**立即 404**；
 *  3. 非白名单端口被拒 + 留审计记录；
 *  4. TTL 到期自动回收，`GET /config/` **无残留路由**。
 *
 * ## 为什么必须真跑
 * 上一轮读文档发现 upsert 用错了端点（`PUT /id/<新id>` 创建不了对象）。
 * 那类错误**只有真跑或读文档才能发现** —— 而这个脚本就是"真跑"那一半。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '@forlife/store'

import { createCaddyClient } from '../src/caddy.ts'
import { createPortService } from '../src/port-service.ts'

const ADMIN = process.env['CADDY_ADMIN'] ?? 'http://127.0.0.1:2019'
const HOST = process.env['TEST_HOST'] ?? '127.0.0.1'
const PORT = 18080
const WHITELIST = [{ from: 18000, to: 18099 }]

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `　${detail}`}`)
}

// ── 起一个"工作区里的服务" ───────────────────────────────────────────
const backend = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`backend-ok path=${req.url ?? '/'}`)
})
await new Promise((resolve) => backend.listen(18001, '127.0.0.1', resolve))
console.log('  后端服务已起在 :18001')

const dir = mkdtempSync(join(tmpdir(), 'forlife-e2e-'))
const opened = openDatabase({ file: join(dir, 'e2e.sqlite') })
const caddy = createCaddyClient({ adminUrl: ADMIN, serverName: process.env['CADDY_SERVER'] ?? 'srv0' })
const service = createPortService({
  db: opened.db,
  caddy,
  host: HOST,
  upstreamHost: '127.0.0.1',
  whitelist: WHITELIST,
  log: () => {},
})

const url = `http://${HOST}:${PORT}/svc/e2e/`

try {
  // ── 验收 1：发布 → 经 Caddy 可访问 ─────────────────────────────────
  console.log('\n【验收 1】发布 → 经 Caddy 可访问')
  const published = await service.publish({
    name: 'e2e',
    targetPort: 18001,
    ttlSeconds: 3,
    approvedBy: 'e2e-test',
  })
  check('发布成功', published.ok, published.reason)
  if (published.ok) {
    // 给 Caddy 一点时间生效（配置是热加载的，但仍有毫秒级窗口）
    await new Promise((r) => setTimeout(r, 400))
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const body = await r.text()
      check('经 Caddy 可访问', r.status === 200 && body.includes('backend-ok'), `HTTP ${r.status} "${body.slice(0, 40)}"`)
    } catch (error) {
      check('经 Caddy 可访问', false, String(error).slice(0, 100))
    }
  }

  // ── 验收 3：非白名单端口被拒（用第二个 service 实例验证白名单）──────
  console.log('\n【验收 3】非白名单端口被拒')
  const rejected = await service.publish({ name: 'evil', targetPort: 9999, approvedBy: 'e2e-test' })
  check('非白名单被拒', !rejected.ok, rejected.reason)
  const after = await caddy.listRouteIds()
  check('被拒的没有留下路由', after.ok && !after.ids.includes('forlife-svc-evil'), after.ids.join(','))

  // ── 验收 2：unpublish → 立即 404 ───────────────────────────────────
  console.log('\n【验收 2】unpublish → 立即 404')
  if (published.ok) {
    const removed = await service.unpublish(published.row.id)
    check('取消成功', removed.ok, removed.reason)
    await new Promise((r) => setTimeout(r, 400))
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      check('取消后立即 404', r.status === 404, `HTTP ${r.status}`)
    } catch (error) {
      // 连不上也算"不可访问"，但要说明是哪种
      check('取消后立即 404', false, `连接失败：${String(error).slice(0, 80)}`)
    }
  }

  // ── 验收 4：TTL 到期回收 + 无残留 ──────────────────────────────────
  console.log('\n【验收 4】TTL 到期回收 → GET /config/ 无残留路由')
  const shortLived = await service.publish({ name: 'ttl', targetPort: 18001, ttlSeconds: 1, approvedBy: 'e2e-test' })
  check('带 TTL 的发布成功', shortLived.ok, shortLived.reason)
  await new Promise((r) => setTimeout(r, 1500))
  const reclaimed = await service.reclaimExpired()
  check('被回收', reclaimed.reclaimed.includes('ttl'), JSON.stringify(reclaimed))
  const finalIds = await caddy.listRouteIds()
  const leftovers = (finalIds.ids ?? []).filter((id) => id.startsWith('forlife-svc-'))
  check('无残留路由', leftovers.length === 0, leftovers.length === 0 ? '' : `残留：${leftovers.join(',')}`)
} finally {
  backend.close()
  opened.db.close()
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${String(failed.length)} 条未通过`}（共 ${String(results.length)} 条）`)
process.exit(failed.length === 0 ? 0 : 1)
