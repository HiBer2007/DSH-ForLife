#!/usr/bin/env node
/**
 * **宿主侧日志采集端**（`FIX_PLAN.md` §57 待办②）—— 把容器的 stdout 送进统一日志库。
 *
 * ## 它解决的那件事（§57 的活证据）
 *
 * `qq`（NapCat）与 gateway **不共享任何卷** ⇒ 它的 stdout 在我们的日志库里一条都没有。
 * 2026-10-11 真发生过：gateway 重建时 NapCat 反向 WS **连败 3 次**（每 3 秒重试）、
 * 第 4 次接上 —— ★ 那 3 次失败在网关日志、面板、库里**全看不见**。
 *
 * ## 为什么在**宿主**跑（而不是容器里）
 *
 * - ★ 读 `docker logs` 不需要给任何容器加权限；
 * - ★★ **不用重建任何容器** —— 重建 `qq` 要重新扫码登录，那是用户红线；
 * - ★ 改归一规则不用重建镜像（规则在 `log-collect-lib.mjs` 里）。
 *
 * ## 用法（在 VM 宿主上）
 *
 * ```
 * # 先看一眼要发什么（不发）
 * node /opt/forlife/scripts/log-collector.mjs --dry-run
 * # 真发一次（游标推进）
 * sudo FORLIFE_LOG_INGEST_TOKEN=$(cat /opt/forlife/deploy/.log-ingest-token) \
 *   node /opt/forlife/scripts/log-collector.mjs
 * ```
 *
 * ★ **令牌从文件读**，不从命令行参数读 —— 命令行会进 `ps` 与 shell 历史。
 *
 * @module scripts/log-collector
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { CONTAINER_MODULES, lineTimestamp, normalizeLine, parseCursor, selectWindow, stripTimestamp, toBatches } from './log-collect-lib.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const URL_BASE = value('--url', process.env['FORLIFE_LOG_INGEST_URL'] ?? 'http://127.0.0.1:8081')
const STATE = value('--state', process.env['FORLIFE_LOG_CURSOR'] ?? '/opt/forlife/deploy/.log-collector-cursor.json')
const DRY = flag('--dry-run')
/** 首次运行（没有游标）时往前读多久。★ 别默认读全部 —— NapCat 的 stdout 有一万多行。 */
const FALLBACK_MINUTES = Number(value('--fallback-minutes', '30'))
/** 每个容器一次最多发多少条（超了会在下一次运行继续，游标只推进到已发出的位置）。 */
const MAX_PER_RUN = Number(value('--max-per-run', '2000'))
/** ★ docker logs --tail 取多少行（时间过滤在 JS 里做，见 dockerLogs）。 */
const TAIL_LINES = Number(value('--tail-lines', '5000'))

function token() {
  const fromEnv = process.env['FORLIFE_LOG_INGEST_TOKEN']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const file = value('--token-file', '/opt/forlife/deploy/.log-ingest-token')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

const TOKEN = token()
if (TOKEN === '' && !DRY) {
  console.error('✖ 没有令牌：设 FORLIFE_LOG_INGEST_TOKEN，或用 --token-file 指一个文件（--dry-run 不需要）。')
  process.exit(2)
}

/** 读一个容器的日志（宿主侧，`sudo docker logs`）。 */
function dockerLogs(container, since) {
  // ★★ 2026-10-13（真机踩到）：**不能用 `--since` 当唯一的过滤手段**。
  //
  //   现象：`docker logs --since <任意时间> forlife-caddy-1` **永远返回 0 行**，
  //   而 `--tail 3` 明明看得到刚刚的 502 记录（同一容器、同一驱动 `json-file`；
  //   对照组 `forlife-qq-1` 用**同一个 `--since`** 能返回 65 行）。
  //   ⇒ 结果就是"面板上**一条 Caddy 日志都没有**" —— 用户报的正是这个。
  //
  //   ⇒ 改成：**`--tail` 取最近 N 行，时间过滤在 JS 里做**（我们本来就逐行解析时间戳）。
  //     ★ 与 docker `--since` 的实现细节解耦；代价是 N 行之外更早的不采，
  //       而定时器每 5 分钟一轮 ⇒ 5000 行足够覆盖（真机一轮最多几十行）。
  void since
  // ★★★ 2026-10-13（真机踩到，**这就是"面板上一条 Caddy 日志都没有"的根因**）：
  //
  //   **Caddy 把日志写在 stderr 上**，而 `docker logs` 会把容器的 stderr 转到
  //   **它自己的 stderr** ⇒ 只读 stdout 的调用方**一行都拿不到**。
  //   证据（同一条命令，只差一个重定向）：
  //     `sudo docker logs --tail 5000 forlife-caddy-1 2>/dev/null | wc -l`  ⇒ **0**
  //     `sudo docker logs --tail 2 forlife-caddy-1 2>&1 >/dev/null | head`  ⇒ **有内容**（那些 502 JSON）
  //   ⇒ 而 NapCat / DSH 写 stdout ⇒ 它们一直采得到（所以问题只出在 Caddy 身上）。
  //
  //   ★ 修法：在 shell 里把 **stderr 并进 stdout**（`2>&1`），再统一按行解析。
  //   ⚠️ 代价：两条流的**交错顺序**在合并时可能轻微抖动 —— 对 Caddy（全在 stderr）
  //      无影响；对"两路都写"的容器，行序以管道写入顺序为准（可接受）。
  const argv = ['sh', '-c', `docker logs --timestamps --tail ${String(TAIL_LINES)} ${container} 2>&1`]
  return execFileSync('sudo', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

const cursor = (() => {
  try {
    return parseCursor(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
})()

const now = new Date()
const fallbackSince = new Date(now.getTime() - FALLBACK_MINUTES * 60_000).toISOString()
const summary = []

for (const [container, module] of Object.entries(CONTAINER_MODULES)) {
  const since = cursor[container] ?? fallbackSince
  let raw
  try {
    raw = dockerLogs(container, since)
  } catch (error) {
    // ★ 一个容器读不到不该让整轮失败（其余容器照采）
    summary.push({ container, module, error: String(error).slice(0, 160) })
    continue
  }

  const entries = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const stamp = lineTimestamp(line)
    // ★ 时间过滤在这里做（不用 docker logs --since，见 dockerLogs 的说明）：
    //   ★ 有游标时只采**严格更新**的行；没有游标（首次）就全采（--tail 已经限制了量）。
    const cursorAt = cursor[container]
    if (cursorAt !== undefined && stamp !== undefined && stamp <= cursorAt) continue
    const record = normalizeLine(module, stripTimestamp(line), now)
    if (record !== undefined) entries.push({ record, stamp })
  }

  // ★★ 取**最旧的** max 条，游标只推进到"真正发出去的最后一条"（见 `selectWindow` 的注释：
  //    第一版发最新 + 游标推到读到的最后一行 ⇒ 被丢掉的那些**永远不会再被采到**）。
  const selected = selectWindow(entries, MAX_PER_RUN)
  const batches = toBatches(selected.window, 200)
  let accepted = 0
  const rejected = []

  for (const batch of batches) {
    if (DRY) {
      accepted += batch.length
      continue
    }
    try {
      const response = await fetch(`${URL_BASE}/api/admin/log-ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forlife-log-token': TOKEN },
        body: JSON.stringify({ records: batch }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        summary.push({ container, module, error: `HTTP ${String(response.status)} ${JSON.stringify(body).slice(0, 160)}` })
        break
      }
      accepted += Number(body.accepted ?? 0)
      if (Array.isArray(body.rejected)) rejected.push(...body.rejected)    } catch (error) {
      summary.push({ container, module, error: `投递失败：${String(error).slice(0, 160)}` })
      break
    }
  }

  // ★ 游标只推进到"已经成功发出去"的位置：失败时下次会重读这一段（宁可重发，不可漏）
  const failed = summary.some((row) => row.container === container)
  if (!DRY && !failed && selected.cursor !== undefined) cursor[container] = selected.cursor

  summary.push({
    container,
    module,
    since,
    lines: raw.split('\n').filter((l) => l.trim() !== '').length,
    records: selected.window.length,
    remaining: selected.remaining,
    accepted,
    rejected: rejected.length,
    // ★ 被拒的**原因**也要带出来（只说个数字，运维还得自己去翻容器日志）
    rejectReasons: rejected.slice(0, 3).map((r) => r.reason),
    cursor: cursor[container],
  })
}

if (!DRY) {
  try {
    writeFileSync(STATE, `${JSON.stringify(cursor, null, 2)}\n`)
  } catch (error) {
    console.error(`⚠️ 游标写不进去（下次会重读这一段）：${String(error)}`)
  }
}

console.log(`采集端（${hostname()}）${DRY ? '【dry-run】' : ''}→ ${URL_BASE}`)
for (const row of summary) {
  if (row.error !== undefined) {
    console.log(`  ✖ ${row.container.padEnd(24)} ${row.error}`)
    continue
  }
  console.log(
    `  ${row.container.padEnd(24)} ${String(row.lines).padStart(6)} 行 ⇒ 发 ${String(row.records).padStart(5)} 条` +
      `（接受 ${String(row.accepted)}、被拒 ${String(row.rejected)}）游标 ${String(row.cursor ?? '-')}` +
      // ★ 还剩多少要说出来：一次最多发 MAX_PER_RUN 条，剩下的**下次继续**（不是丢掉）
      (row.remaining > 0 ? `　★ 还剩 ${String(row.remaining)} 条没发（下次运行继续）` : '') +
      (row.rejected > 0 ? `　被拒原因：${row.rejectReasons.join(' / ')}` : ''),
  )
}
const total = summary.reduce((sum, row) => sum + (row.accepted ?? 0), 0)
console.log(`合计接受 ${String(total)} 条${DRY ? '（dry-run：没有真发，也没有推进游标）' : ''}`)
