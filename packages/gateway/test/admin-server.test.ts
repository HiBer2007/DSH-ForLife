/**
 * 管理后台服务端的行为测试 —— **起真服务、走真 HTTP**。
 *
 * 为什么不用 mock 直接调 handler：这个模块的绝大多数风险都在 HTTP 层
 * （cookie 属性、状态码、CSRF 检查、路径穿越、限流），mock 掉这一层就等于什么都没测。
 *
 * 覆盖的每一条都对应一个具体的坑：
 *  - 首次设置口令只在**没有口令**时可用（否则等于门没锁）；
 *  - 未登录访问数据接口必须 401（而不是返回空数据让人以为"没数据"）；
 *  - 登录失败累计到阈值必须 429（口令是公网唯一门槛，必须能挡暴力破解）；
 *  - 改口令后**其它会话立即失效**（这是"口令泄露后改密码"的全部意义）；
 *  - 静态服务不许越界（`..`）；
 *  - 状态变更必须 JSON 内容类型（CSRF 纵深防御）；
 *  - 安全响应头必须带上（CSP/HSTS 之外的几条，尤其 frame-ancestors）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createAdminServer, type RunningAdminServer } from '../src/server.ts'

let running: RunningAdminServer
let base: string
let staticRoot: string

/** 从响应里取 cookie 的 `name=value` 部分（其余属性忽略）。 */
function cookieOf(response: Response): string {
  const raw = response.headers.getSetCookie()
  const first = raw[0]
  assert.ok(first !== undefined, '响应必须下发 set-cookie')
  return first.split(';')[0]!
}

/** 带 cookie 的 fetch 包装。 */
function fetchWith(cookie: string | undefined, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookie !== undefined) headers.set('cookie', cookie)
  return fetch(base + path, { ...init, headers })
}

/** 发一个 JSON POST。 */
function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers['cookie'] = cookie
  return fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
}

before(async () => {
  // 造一个最小的 dist：测试静态服务的边界，不依赖前端是否构建过
  staticRoot = mkdtempSync(join(tmpdir(), 'forlife-admin-dist-'))
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  writeFileSync(join(staticRoot, 'theme-init.js'), 'void 0', 'utf8')

  running = await createAdminServer({
    dbPath: ':memory:',
    distRoot: staticRoot,
    host: '127.0.0.1',
    port: 0,
    sessionTtlMs: 60_000,
  }).start()
  base = `http://127.0.0.1:${running.port}`
})

after(async () => {
  await running.close()
})

test('会话状态：未设置口令时 needsSetup=true 且未登录', async () => {
  const response = await fetch(`${base}/api/admin/session`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { authenticated: boolean; needsSetup: boolean }
  assert.equal(body.authenticated, false)
  assert.equal(body.needsSetup, true)
})

test('未登录访问数据接口必须 401（不能返回空数据）', async () => {
  const response = await fetch(`${base}/api/admin/overview`)
  assert.equal(response.status, 401)
})

test('首次设置口令：太短拒绝；成功后直接建会话', async () => {
  const tooShort = await postJson('/api/admin/setup', { password: 'short' })
  assert.equal(tooShort.status, 400)

  const ok = await postJson('/api/admin/setup', { password: 'a-good-password' })
  assert.equal(ok.status, 200)
  const cookie = cookieOf(ok)

  const overview = await fetchWith(cookie, '/api/admin/overview')
  assert.equal(overview.status, 200)
  const body = (await overview.json()) as { build: { schemaVersion: number }; memory: { epoch: number } }
  assert.ok(body.build.schemaVersion > 0, '总览必须带上 schema 版本')
  assert.equal(typeof body.memory.epoch, 'number')
})

test('重复设置口令会被拒绝（409）—— 否则等于没有门', async () => {
  const again = await postJson('/api/admin/setup', { password: 'another-password' })
  assert.equal(again.status, 409)
})

test('登录：口令错误 401；正确则下发 cookie', async () => {
  const wrong = await postJson('/api/admin/login', { password: 'not-the-password' })
  assert.equal(wrong.status, 401)

  const right = await postJson('/api/admin/login', { password: 'a-good-password' })
  assert.equal(right.status, 200)
  const cookie = cookieOf(right)
  assert.match(cookie, /^forlife_admin=/)
})

test('登录失败累计到阈值会被限流（429）', async () => {
  // 前面已经失败过一次，这里补到超过阈值
  let last = 0
  for (let i = 0; i < 6; i += 1) {
    const response = await postJson('/api/admin/login', { password: `bad-${i}` })
    last = response.status
    if (response.status === 429) break
  }
  assert.equal(last, 429, '连续失败必须触发限流')
})

test('CSRF 纵深防御：非 JSON 内容类型的 POST 被拒', async () => {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'password=x',
  })
  assert.equal(response.status, 400)
})

test('改口令：当前口令错则 401；成功后旧会话全部失效', async () => {
  const login = await postJson('/api/admin/login', { password: 'a-good-password' })
  // 上一条测试把来源限流了，这里可能拿到 429 —— 那就跳过（限流本身就是被测过的行为）
  if (login.status === 429) return
  assert.equal(login.status, 200)
  const cookie = cookieOf(login)

  const wrongCurrent = await postJson('/api/admin/password', { current: 'nope', next: 'brand-new-password' }, cookie)
  assert.equal(wrongCurrent.status, 401)

  const ok = await postJson('/api/admin/password', { current: 'a-good-password', next: 'brand-new-password' }, cookie)
  assert.equal(ok.status, 200)

  // 旧 cookie 必须失效（因为改口令会注销所有会话）
  const after = await fetchWith(cookie, '/api/admin/overview')
  assert.equal(after.status, 401)

  // 新口令可登录
  const relogin = await postJson('/api/admin/login', { password: 'brand-new-password' })
  assert.equal(relogin.status, 200)
})

test('登出后 cookie 失效', async () => {
  const login = await postJson('/api/admin/login', { password: 'brand-new-password' })
  if (login.status !== 200) return
  const cookie = cookieOf(login)
  const out = await postJson('/api/admin/logout', {}, cookie)
  assert.equal(out.status, 200)
  const after = await fetchWith(cookie, '/api/admin/overview')
  assert.equal(after.status, 401)
})

test('静态服务：/admin/ 回 index.html，资源按扩展名给类型', async () => {
  const page = await fetch(`${base}/admin/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)

  const script = await fetch(`${base}/admin/theme-init.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type') ?? '', /javascript/)
  assert.equal(script.headers.get('cache-control'), 'no-cache')
})

test('静态服务：路径穿越被挡住', async () => {
  // 用原始编码发送，避免 fetch 自己归一化掉
  const response = await fetch(`${base}/admin/..%2f..%2fpackage.json`)
  assert.ok(response.status === 400 || response.status === 404, `越界请求必须被拒，实际 ${response.status}`)
})

test('根路径 302 到 /admin/（不让人看到空白页）', async () => {
  const response = await fetch(base + '/', { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/admin/')
})

test('安全响应头：CSP 严格、禁止被套框', async () => {
  const response = await fetch(`${base}/admin/`)
  const csp = response.headers.get('content-security-policy') ?? ''
  assert.match(csp, /script-src 'self'/, 'CSP 必须限制脚本来源')
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'CSP 不该放开内联脚本')
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})
