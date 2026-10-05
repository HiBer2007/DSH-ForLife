/**
 * 从**正在运行的真实服务端**抓一份面板 API 夹具。
 *
 * 为什么必须用真响应：面板的缺陷全都出在"组件真的渲染了服务端真的返回的东西"这一步。
 * 用手写的假快照测，测的是我以为的形状；用真响应当夹具，测的是它真收到的形状 ——
 * 而"点「预览」没反应"这个 bug 恰恰就是假快照（把 `preview` 塞进 snapshot）掩盖掉的。
 *
 * 用法（先起后台：`pwsh -File .runtime/start-web.ps1`，令牌在 `.runtime/web.log` 末尾）：
 *
 *     node scripts/capture-panel-fixtures.mjs <launchToken>
 *
 * 产物：`packages/dsh-component/test/fixtures/panel-api.json`（密钥类字段已脱敏）。
 */
import { writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3080'
const TOKEN = process.argv[2]
if (TOKEN === undefined) throw new Error('用法：node scripts/capture-panel-fixtures.mjs <launchToken>')

// ① 用启动令牌换签名 cookie（`?token=` 会 303 并下发 dsh-auth-* cookie）
const mint = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
const cookie = (mint.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
if (cookie === '') throw new Error(`没换到 cookie（HTTP ${mint.status}）—— 令牌可能已过期，重启后台会换新令牌`)
console.log(`已换到 cookie：${cookie.slice(0, 40)}…`)

// ② 面板实际会打的接口（改客户端取数路径时，这里要同步改）
const PATHS = [
  '/api/forlife/state',
  '/api/forlife/entries',
  '/api/forlife/compaction?limit=10',
  '/api/forlife/qq/state',
  '/api/forlife/qq/queue?limit=30',
  '/api/forlife/qq/turns?limit=30',
  '/api/forlife/qq/wake-rules?scope=*',
  '/api/forlife/qq/pending?limit=20',
  '/api/forlife/admin/chat?limit=50',
  '/api/forlife/time',
  '/api/forlife/qq/wake-overview',
  '/api/forlife/prompts',
  '/api/forlife/prompts/revisions?slug=p1-system&limit=20',
  '/api/forlife/prompts/revisions?slug=p2-style&limit=20',
  '/api/forlife/routes',
  // 注意：**没有** `/api/forlife/endpoints` —— 它是只注册了 POST 的登记接口，
  // GET 会 404（面板登记端点时用的正是 POST）。放在这里只会给夹具添一条误导性的 404。
]

const SECRET = /(apikey|api_key|token|secret|password|authorization)/i
/** 递归脱敏：夹具要进仓库，密钥不能跟着走。 */
function redact(value, key = '') {
  if (SECRET.test(key)) return '«redacted»'
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  }
  return value
}

const fixtures = {}
for (const path of PATHS) {
  const response = await fetch(BASE + path, { headers: { cookie } })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { notJson: text.slice(0, 200) }
  }
  fixtures[path] = { status: response.status, payload: redact(payload) }
  console.log(`${String(response.status).padEnd(4)} ${path.padEnd(48)} ${text.length} 字节`)
}

const out = new URL('../packages/dsh-component/test/fixtures/panel-api.json', import.meta.url)
writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n', 'utf8')
console.log(`\n已写入 ${out.pathname}`)
