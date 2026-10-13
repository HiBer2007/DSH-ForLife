/**
 * 核验**正在运行的服务端实际发出去的**客户端插件里含有修复。
 *
 * 为什么不能只看本地文件：客户端插件是经 DSH 打包/拼接后发出的
 * （`plugins/??a,b,c&rev=` 合并请求），本地改了不代表发出去的是新的 ——
 * 缓存、拼接顺序、插件被整体停用都可能让它不是你以为的那份。
 *
 * 用法：
 *
 *     node scripts/verify-served-client.mjs <launchToken>
 */
const BASE = 'http://127.0.0.1:3080'
const TOKEN = process.argv[2]
if (TOKEN === undefined) throw new Error('用法：node scripts/verify-served-client.mjs <launchToken>')

const mint = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
const cookie = (mint.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
if (cookie === '') throw new Error(`没换到 cookie（HTTP ${mint.status}）`)
console.log(`换 cookie：HTTP ${mint.status}，成功`)

// ① 从首页 HTML 里取**真实**的插件打包 URL（它是 `??a,b,c&rev=` 形式的合并请求）
const html = await (await fetch(`${BASE}/`, { headers: { cookie } })).text()
const match = html.match(/plugins\/\?\?[^"']*forlife-memory\/client\.js[^"']*/)
if (match === null) throw new Error('首页 HTML 里找不到 forlife-memory 的插件 URL —— 面板可能整个没被启用')
const pluginUrl = match[0].replace(/&amp;/g, '&')
console.log(`插件 URL：${pluginUrl.slice(0, 80)}…`)

const response = await fetch(`${BASE}/${pluginUrl}`, { headers: { cookie } })
const source = await response.text()
console.log(`插件源码：HTTP ${response.status}，${source.length} 字节\n`)

const CHECKS = [
  { name: '四个区块都注册了', needle: "id: 'forlife-memory'" },
  { name: 'RoutesPanel 内容分支已包装', needle: "return renderPanel(jsx, node('div', {}, children))" },
  { name: 'RoutesPanel loading 分支用 jsx', needle: "正在读取模型与路由…" },
  { name: 'renderPanel 报错带路径', needle: '结构树里的节点不像元素' },
  { name: '预览结果读 ui.preview', needle: '(ui && ui.preview) || snapshot.preview' },
  { name: '空元素不带 children（React #137 白屏）', needle: 'const VOID_TAGS = new Set(' },
]
let failed = 0
for (const check of CHECKS) {
  const ok = source.includes(check.needle)
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✖'} ${check.name}`)
}
// 否定检查：旧的"无条件写 children"必须已经不在了（它正是 #137 白屏的成因）
const unconditional = source.includes('Object.assign({}, panel.props, { children:')
console.log(`  ${unconditional ? '✖' : '✓'} 没有"无条件写 children"的旧写法`)
if (unconditional) failed += 1

// 裸描述符的 return 只允许出现在 describeRoutes 里（那是纯构造，组件负责包一层）
const bare = source.split("return node('div', {}, children)").length - 1
console.log(`  ${bare === 1 ? '✓' : '✖'} 裸描述符 return 只有 1 处（describeRoutes 内部），实际 ${bare} 处`)
if (bare !== 1) failed += 1

// ② 面板要打的接口仍然可用
for (const path of ['/api/forlife/routes', '/api/forlife/qq/wake-overview', '/api/forlife/prompts']) {
  const api = await fetch(BASE + path, { headers: { cookie } })
  const body = await api.text()
  const ok = api.status === 200
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✖'} ${path} → HTTP ${api.status}，${body.length} 字节`)
}

if (failed > 0) {
  console.error(`\n✖ ${failed} 项不通过 —— 发出去的那份还不是修好的那份`)
  process.exit(1)
}
console.log('\n✓ 服务端发出的客户端确实包含全部修复')
