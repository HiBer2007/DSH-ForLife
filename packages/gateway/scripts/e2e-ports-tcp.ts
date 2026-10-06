/**
 * TCP 出口的**真机验收**（PLAN 阶段 7 验收标准第 2 条）。
 *
 * 需要一个**含 layer4 模块**的 Caddy 在跑（`.runtime/caddy-l4-build/caddy.exe`，
 * 由 `xcaddy build --with github.com/mholt/caddy-l4` 产出）。
 *
 * ## 四条检查
 *  1. 发布 TCP → **连得上**，且数据真的到了后端；
 *  2. 取消 → **立即连不上**（TCP 没有 404，只能看连接是否被拒）；
 *  3. 对外端口非法 → 被拒，且 Caddy 里**没留下 layer4 server**；
 *  4. TTL 到期回收 → `GET /config/` 里 `forlife-l4-*` **一个不剩**。
 *
 * ## 与 HTTP 验收的一个关键差别
 *
 * HTTP 取消后能看 `404`；**TCP 取消后只能看"连不上"** ——
 * 所以这里断言的是 `ECONNREFUSED` 之类的连接错误，
 * 而不是某个状态码。**"连不上"就是 TCP 的 404。**
 */
import { createServer, connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '@forlife/store'

import { createCaddyClient } from '../src/caddy.ts'
import { createPortService } from '../src/port-service.ts'

const ADMIN = process.env['CADDY_ADMIN'] ?? 'http://localhost:13019'
const WHITELIST = [{ from: 18000, to: 18099 }]
const TARGET_PORT = 18001
const LISTEN_PORT = 18060

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `　${detail}`}`)
}

/** 连一下对外端口，发一句话，看回什么。 */
function probe(port, payload = 'ping'): Promise<{ ok: boolean; reply: string }> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let reply = ''
    const done = (ok) => {
      socket.destroy()
      resolve({ ok, reply })
    }
    socket.setTimeout(2500)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8')
      // 后端是 echo：收到回显就够了
      if (reply.includes(`echo:${payload}`)) done(true)
    })
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
    socket.on('close', () => done(reply.includes(`echo:${payload}`)))
  })
}

// ── 后端：一个 echo 服务（模拟"工作区里的 TCP 服务"）────────────────
const backend = createServer((socket) => {
  socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`))
})
await new Promise((resolve) => backend.listen(TARGET_PORT, '127.0.0.1', resolve))
console.log(`  后端 echo 服务已起在 :${String(TARGET_PORT)}`)

const dir = mkdtempSync(join(tmpdir(), 'forlife-tcp-e2e-'))
const opened = openDatabase({ file: join(dir, 'tcp.sqlite') })
const caddy = createCaddyClient({ adminUrl: ADMIN })
const service = createPortService({
  db: opened.db,
  caddy,
  host: '127.0.0.1',
  whitelist: WHITELIST,
  log: () => {},
})

/**
 * 看 Caddy 里现存的 forlife layer4 server。
 *
 * **走客户端，不用裸 fetch** —— 裸 fetch 不发 `Origin` 头，会被 Caddy 的来源保护
 * 挡成 403，于是返回空数组：断言"没有残留"会**假通过**、断言"出现了"会**假失败**。
 * 验收脚本必须用被测的那条通道，否则测的不是真实路径。
 */
async function layer4Servers(): Promise<readonly string[]> {
  const cfg = await caddy.getConfig()
  if (!cfg.ok) {
    // 读不到就**明确失败**，不要返回空数组让断言假通过
    throw new Error(`读不到 Caddy 配置，无法判断 layer4 状态：${cfg.reason}`)
  }
  const servers = (cfg.config as { apps?: { layer4?: { servers?: Record<string, unknown> } } })?.apps?.layer4?.servers ?? {}
  return Object.keys(servers).filter((k) => k.startsWith('forlife-l4-'))
}

try {
  // ── 检查 1：发布 → 连得上且数据到了 ────────────────────────────────
  console.log('\n【检查 1】发布 TCP → 连得上且数据真的到了后端')
  const published = await service.publish({
    name: 'tcp-echo',
    targetPort: TARGET_PORT,
    listenPort: LISTEN_PORT,
    protocol: 'tcp',
    ttlSeconds: 4,
    approvedBy: 'e2e-test',
  })
  check('发布成功', published.ok, published.reason)

  if (published.ok) {
    await new Promise((r) => setTimeout(r, 400))
    const p = await probe(LISTEN_PORT)
    check('经 layer4 连得上且回显正确', p.ok, p.ok ? `收到 "${p.reply.trim()}"` : '连不上或没回显')
    const servers = await layer4Servers()
    check('Caddy 里出现了 layer4 server', servers.includes(`forlife-l4-${String(LISTEN_PORT)}`), servers.join(','))
  }

  // ── 检查 3：对外端口非法 → 被拒且不留 server ───────────────────────
  console.log('\n【检查 3】对外端口非法 → 被拒，且 Caddy 里没留下东西')
  const bad = await service.publish({
    name: 'evil',
    targetPort: TARGET_PORT,
    listenPort: 22,
    protocol: 'tcp',
    approvedBy: 'e2e-test',
  })
  check('对外端口 22 被拒', !bad.ok, bad.reason)
  const afterBad = await layer4Servers()
  check('被拒的没留下 layer4 server', !afterBad.includes('forlife-l4-22'), afterBad.join(','))

  // ── 检查 2：取消 → 立即连不上（"连不上"就是 TCP 的 404）────────────
  console.log('\n【检查 2】取消 → 立即连不上')
  if (published.ok) {
    const removed = await service.unpublish(published.row.id)
    check('取消成功', removed.ok, removed.reason)
    await new Promise((r) => setTimeout(r, 400))
    const p = await probe(LISTEN_PORT)
    check('取消后连不上', !p.ok, p.ok ? `竟然还能连上："${p.reply.trim()}"` : '连接被拒（= TCP 的 404）')
    const servers = await layer4Servers()
    check('Caddy 里 layer4 server 已删', !servers.includes(`forlife-l4-${String(LISTEN_PORT)}`), servers.join(','))
  }

  // ── 检查 4：TTL 到期回收 → 无残留 ──────────────────────────────────
  console.log('\n【检查 4】TTL 到期回收 → GET /config/ 无残留')
  const shortLived = await service.publish({
    name: 'tcp-ttl',
    targetPort: TARGET_PORT,
    listenPort: 18061,
    protocol: 'tcp',
    ttlSeconds: 1,
    approvedBy: 'e2e-test',
  })
  check('带 TTL 的 TCP 发布成功', shortLived.ok, shortLived.reason)
  await new Promise((r) => setTimeout(r, 1500))
  const reclaimed = await service.reclaimExpired()
  check('被回收', reclaimed.reclaimed.includes('tcp-ttl'), JSON.stringify(reclaimed))
  const finalServers = await layer4Servers()
  check('无残留 layer4 server', finalServers.length === 0, finalServers.join(','))
} finally {
  backend.close()
  opened.db.close()
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${String(failed.length)} 条未通过`}（共 ${String(results.length)} 条）`)
process.exit(failed.length === 0 ? 0 : 1)
