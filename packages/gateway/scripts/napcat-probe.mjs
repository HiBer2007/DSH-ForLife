/**
 * NapCat 真机探针（**只读优先**）：补齐"图片 url / 语音转写 / 文件信息"三种真实形状。
 *
 * ## 为什么需要它（本轮的真实处境）
 *
 * 2026-10-09 本轮实测发现：**QQ 账号处于登出状态**
 * （WebUI `POST /api/QQLogin/CheckLoginStatus` → `isLogin:false, loginPhase:"waiting_qrcode"`），
 * 于是 NapCat 的 OneBot 上下文是空的（`/api/Debug/schemas` 回 `OneBot 未初始化`：
 * **没有真实事件、没有历史消息、没有语音/文件可查**）。
 * ⇒ 所以下列三件事**当时只能做源码级验证**，真机那一半**必须在扫码登录之后**跑这个脚本：
 *
 *  1. `image.data.url` 是否非空（P1-1 的前提）；
 *  2. `fetch_ptt_text` 的真实返回与失败模式（P1-2）；
 *  3. `get_file` 的真实返回与失败模式（P2-b）。
 *
 * ## 用法
 *
 * ```bash
 * # ① 看登录状态（没登录就先在 WebUI 上扫码）
 * node packages/gateway/scripts/napcat-probe.mjs status
 *
 * # ② 把 NapCat 的 WS 目标临时指向本探针（**会先备份配置**；NapCat 支持热重载，不用重启容器）
 * node packages/gateway/scripts/napcat-probe.mjs redirect ws://host.docker.internal:3099/
 *
 * # ③ 探针（只读 action：登录信息 / packet 状态 / 历史消息 / 语音转写 / 取文件信息）
 * node packages/gateway/scripts/napcat-probe.mjs media --port 3099
 *
 * # ④ 还原 WS 目标（**务必执行**）
 * node packages/gateway/scripts/napcat-probe.mjs restore
 * ```
 *
 * ⚠️ 默认端口 **3099**（不是 3010）：3010 常常被别的程序占着（本轮就是 Firefox），
 * 而 NapCat 连不上时**不会报错**，只会一直重连 —— 所以探针必须占一个**确定空闲**的端口。
 *
 * 环境变量：`NAPCAT_WEBUI`（默认 http://127.0.0.1:6099）、`NAPCAT_WEBUI_TOKEN`、`NAPCAT_UIN`。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { WebSocketServer } from 'ws'

const WEBUI = process.env['NAPCAT_WEBUI'] ?? 'http://127.0.0.1:6099'
const TOKEN = process.env['NAPCAT_WEBUI_TOKEN'] ?? 'b3bc4acb0f4a'
const UIN = process.env['NAPCAT_UIN'] ?? '3112546448'
const BACKUP = `onebot11_${UIN}.json.backup`
const CONFIG_IN_CONTAINER = `/app/napcat/config/onebot11_${UIN}.json`

const [command, ...rest] = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = rest.indexOf(`--${name}`)
  return index >= 0 && rest[index + 1] !== undefined ? rest[index + 1] : fallback
}

async function credential() {
  const hash = createHash('sha256').update(`${TOKEN}.napcat`).digest('hex')
  const response = await fetch(`${WEBUI}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash }),
  })
  const body = await response.json()
  const value = body?.data?.Credential ?? body?.Credential
  if (typeof value !== 'string') throw new Error(`拿不到 WebUI 凭据：${JSON.stringify(body).slice(0, 160)}`)
  return value
}

async function webui(path, init = {}) {
  const auth = await credential()
  const response = await fetch(`${WEBUI}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 200) }
  }
}

/** 读容器里的配置文件（只读）。 */
function readConfig() {
  return execFileSync('docker', ['exec', 'forlife-qq-1', 'cat', CONFIG_IN_CONTAINER], { encoding: 'utf8' })
}

async function status() {
  const login = await webui('/api/QQLogin/CheckLoginStatus', { method: 'POST', body: '{}' })
  console.log('登录状态：', JSON.stringify(login?.data ?? login))
  const schemas = await webui('/api/Debug/schemas', { method: 'GET' })
  const actions = schemas?.data ?? schemas
  console.log('OneBot 上下文：', typeof actions === 'object' && actions !== null && Object.keys(actions).length > 2 ? `可用（${String(Object.keys(actions).length)} 个 action）` : `不可用 —— ${JSON.stringify(actions).slice(0, 120)}`)
}

async function redirect(url) {
  if (typeof url !== 'string' || !url.startsWith('ws')) throw new Error('用法：redirect ws://host.docker.internal:3099/')
  const original = readConfig()
  writeFileSync(BACKUP, original)
  console.log(`原配置已备份到 ${BACKUP}`)
  const config = JSON.parse(original)
  const clients = config?.network?.websocketClients ?? []
  if (clients.length === 0) throw new Error('这份配置里没有 websocketClients —— 不要用这个脚本改')
  clients[0].url = url
  const result = await webui('/api/OB11Config/SetConfig', { method: 'POST', body: JSON.stringify({ config: JSON.stringify(config) }) })
  console.log('设置结果：', JSON.stringify(result).slice(0, 200), '（NapCat 会**热重载**网络配置，不需要重启容器）')
}

async function restore() {
  const original = readFileSync(BACKUP, 'utf8')
  const result = await webui('/api/OB11Config/SetConfig', { method: 'POST', body: JSON.stringify({ config: original }) })
  console.log('还原结果：', JSON.stringify(result).slice(0, 200))
  const now = readConfig()
  console.log(now === original ? '★ 配置与原文件逐字节一致' : '⚠️ 配置与备份不一致，请人工核对')
}

async function media() {
  const port = Number(flag('port', '3099'))
  const wss = new WebSocketServer({ port, host: '0.0.0.0' })
  console.log(`等待 NapCat 连入 ws://0.0.0.0:${String(port)} …（若超时：先跑 redirect）`)
  const socket = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('60 秒内没有连进来')), 60_000)
    wss.on('connection', (s) => {
      clearTimeout(timer)
      resolve(s)
    })
  })
  let seq = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const payload = JSON.parse(raw.toString())
    const entry = pending.get(payload.echo)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(payload.echo)
    entry.resolve({ ok: payload.status === 'ok' || payload.retcode === 0, retcode: payload.retcode, message: payload.message, data: payload.data })
  })
  const call = (action, params = {}, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      const echo = `probe-${++seq}`
      const timer = setTimeout(() => {
        pending.delete(echo)
        resolve({ ok: false, error: 'TIMEOUT' })
      }, timeoutMs)
      pending.set(echo, { resolve, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })

  console.log('\n=== ① 账号与 packet 后端 ===')
  console.log('get_login_info：', JSON.stringify((await call('get_login_info')).data))
  const packet = await call('nc_get_packet_status')
  console.log('nc_get_packet_status：', packet.ok ? JSON.stringify(packet.data).slice(0, 300) : `${String(packet.error)} ${String(packet.message ?? '')}`)

  console.log('\n=== ② 扫历史消息里的媒体段（image.url / record.url / file 字段）===')
  const groups = await call('get_group_list')
  const friends = await call('get_friend_list')
  const media = []
  for (const group of (Array.isArray(groups.data) ? groups.data : []).slice(0, 10)) {
    const history = await call('get_group_msg_history', { group_id: group.group_id, count: 30 })
    for (const message of history.data?.messages ?? []) {
      for (const segment of message.message ?? []) {
        if (['image', 'record', 'file', 'video', 'onlinefile'].includes(segment.type)) media.push({ messageId: message.message_id, segment })
      }
    }
  }
  for (const friend of (Array.isArray(friends.data) ? friends.data : []).slice(0, 10)) {
    const history = await call('get_friend_msg_history', { user_id: friend.user_id, count: 30 })
    for (const message of history.data?.messages ?? []) {
      for (const segment of message.message ?? []) {
        if (['image', 'record', 'file', 'video', 'onlinefile'].includes(segment.type)) media.push({ messageId: message.message_id, segment })
      }
    }
  }
  const byType = {}
  for (const item of media) byType[item.segment.type] = (byType[item.segment.type] ?? 0) + 1
  console.log('媒体段统计：', byType)
  for (const type of ['image', 'record', 'file', 'onlinefile']) {
    const samples = media.filter((item) => item.segment.type === type).slice(0, 2)
    for (const sample of samples) {
      const url = sample.segment.data?.url
      console.log(`\n--- ${type}（message_id=${String(sample.messageId).slice(0, 12)}…）`)
      console.log('    字段：', Object.keys(sample.segment.data ?? {}).join(','))
      console.log('    url：', typeof url === 'string' ? (url === '' ? '★ 空串（P1-1 的前提不成立）' : `${url.slice(0, 70)}…（len=${String(url.length)}）`) : `（没有这一项：${typeof url}）`)
    }
  }

  console.log('\n=== ③ fetch_ptt_text（P1-2）===')
  const voice = media.find((item) => item.segment.type === 'record')
  if (voice === undefined) console.log('历史里没有语音 —— 换一条文字消息与一个不存在的 id 验证失败模式')
  for (const [label, id] of [
    ['真语音', voice?.messageId],
    ['文字消息', media[0]?.messageId],
    ['不存在的 id', '1122334455'],
  ]) {
    if (id === undefined) continue
    const result = await call('fetch_ptt_text', { message_id: id })
    console.log(`${label}：`, JSON.stringify({ ok: result.ok, retcode: result.retcode, message: result.message, textLength: typeof result.data?.text === 'string' ? result.data.text.length : undefined }))
  }

  console.log('\n=== ④ get_file（P2-b）===')
  const file = media.find((item) => item.segment.type === 'file' || item.segment.type === 'onlinefile')
  if (file !== undefined) {
    const result = await call('get_file', { file: file.segment.data?.file ?? file.segment.data?.file_id }, 30_000)
    console.log('结果：', JSON.stringify({ ok: result.ok, retcode: result.retcode, message: result.message, keys: Object.keys(result.data ?? {}) }))
    console.log('    file（协议端本地路径）：', String(result.data?.file ?? '').slice(0, 70))
    console.log('    url：', String(result.data?.url ?? '').slice(0, 70))
  }
  const bogus = await call('get_file', { file: 'no-such-token' }, 20_000)
  console.log('瞎编的 file：', JSON.stringify({ ok: bogus.ok, retcode: bogus.retcode, message: bogus.message }))

  socket.close()
  wss.close()
}

const commands = { status, media, redirect: () => redirect(rest[0]), restore }
const handler = commands[command]
if (handler === undefined) {
  console.error('用法：node packages/gateway/scripts/napcat-probe.mjs <status|redirect <ws-url>|media|restore> [--port 3099]')
  process.exit(2)
}
await handler()
process.exit(0)
