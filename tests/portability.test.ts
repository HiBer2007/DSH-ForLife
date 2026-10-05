/**
 * 可移植性与安全边界测试 —— 这些断言保护的是"项目定义"，不是某个函数。
 *
 * 一旦有人（包括未来的我）图方便往宿主目录写东西、把绝对路径塞进配置、
 * 或者把 QQ 协议级危险动作接进适配器，这些测试就必须红。
 *
 * 注意：检查一律**跳过注释行**。注释里出现 `~/.dsh` / `admin :2019` 是在说"不要这么干"，
 * 把它们当违规会造成误报，而误报会让人开始忽略测试 —— 那比没有测试更糟。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** 去掉注释行（# 开头，允许前置空白）。 */
const codeLines = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'))

test('可移植性：profile 配置里没有宿主绝对路径', () => {
  const files = ['profiles/forlife/cordis.patch.yml', 'profiles/forlife/cordis.yml', 'profiles/forlife/package.json']
  const offenders: string[] = []
  for (const rel of files) {
    if (!existsSync(join(REPO_ROOT, rel))) continue
    for (const line of codeLines(read(rel))) {
      if (/[A-Za-z]:[\\/]/.test(line) || /AppData[\\/]Roaming/.test(line)) offenders.push(`${rel}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `profile 配置中出现宿主绝对路径：\n${offenders.join('\n')}`)
})

test('可移植性：storageRoots 全部是相对路径', () => {
  const patch = read('profiles/forlife/cordis.patch.yml')
  const roots = extractStorageRoots(patch)
  assert.ok(roots.length >= 9, `没扫到 storageRoots（找到 ${roots.length} 条），配置结构或解析逻辑变了`)
  for (const { key, value } of roots) {
    assert.ok(value.startsWith('./'), `storageRoots.${key} = ${value} 不是相对路径（换机器就废了）`)
  }
})

test('可移植性：源码与脚本中没有向宿主主目录写入的调用', () => {
  // 允许 `homedir()` 出现在**诊断/比较**里（例如 doctor 警告"你正在用宿主默认目录"），
  // 但绝不允许它成为写操作的目标。
  const writeCalls = /(writeFileSync|appendFileSync|mkdirSync|createWriteStream|rmSync|unlinkSync)\s*\(/
  const homeLike = /homedir\(\)|%USERPROFILE%|\$HOME/
  const offenders: string[] = []
  for (const rel of walkSources(['scripts', 'packages', 'tests'])) {
    for (const [index, line] of read(rel).split(/\r?\n/).entries()) {
      if (line.trim().startsWith('#') || line.trim().startsWith('*') || line.trim().startsWith('//')) continue
      if (writeCalls.test(line) && homeLike.test(line)) offenders.push(`${rel}:${index + 1} ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `以下位置疑似向宿主主目录写入：\n${offenders.join('\n')}`)
})

test('安全边界：没有任何**实现代码**引用协议级危险动作', () => {
  // 只扫实现代码，跳过 *.test.ts：红线测试必须能**合法地枚举**这些名字来断言它们不存在，
  // 而测试文件也不进发布产物（package.json 的 files 不含 test）。守卫太宽会让人开始绕过它。
  const dangerous = ['send_packet', 'get_cookies', 'get_csrf_token', 'get_credentials', 'get_rkey', 'handle_quick_operation']
  const offenders: string[] = []
  for (const rel of walkSources(['packages', 'scripts'], { skipTests: true })) {
    for (const [index, line] of read(rel).split(/\r?\n/).entries()) {
      if (line.trim().startsWith('#') || line.trim().startsWith('*') || line.trim().startsWith('//')) continue
      for (const action of dangerous) {
        if (new RegExp(`['"\`]${action}['"\`]`).test(line)) offenders.push(`${rel}:${index + 1} → ${action}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `发现被列为安全红线的动作被引用：\n${offenders.join('\n')}`)
})

test('协议：便携清单是一份合法的 Community v0.15 manifest', () => {
  const manifest = JSON.parse(read('packages/dsh-component/dsh-plugin.json')) as Record<string, unknown>
  assert.equal(manifest.manifestVersion, '0.15', 'manifestVersion 必须是 0.15（Community v0.15）')
  assert.equal(typeof manifest.id, 'string')
  const facets = manifest.facets as { host?: { entry?: string; apiVersion?: string } } | undefined
  assert.ok(facets?.host?.entry?.startsWith('./'), 'facets.host.entry 必须是相对路径')
  assert.equal(facets?.host?.apiVersion, 'lifecycle.dsh/v1alpha1', 'facet 激活走 lifecycle FacetModule 契约')
  const permissions = manifest.permissions as { name: string; scope: string }[] | undefined
  assert.ok(Array.isArray(permissions) && permissions.length > 0, '必须声明权限（dsh-std 默认 deny）')
  assert.ok(permissions.every((p) => p.scope === 'forlife'), '权限 scope 必须限定在 forlife 命名空间')
  const compat = manifest.compat as { hosts?: string[] } | undefined
  assert.ok(Array.isArray(compat?.hosts) && compat.hosts.length > 0, '必须声明 compat.hosts（版本适配依据）')
})

test('部署：compose 与 Caddyfile 不含被禁配置', () => {
  const compose = codeLines(read('deploy/docker-compose.yml')).join('\n')
  assert.ok(compose.includes('DSH_HOME'), 'compose 必须显式设置 DSH_HOME')
  assert.ok(!/^\s*profiles:/m.test(compose), 'compose 不得使用 profiles 特性（开发机 Compose v2.13 解析不了）')

  const caddy = codeLines(read('deploy/Caddyfile')).join('\n')
  assert.ok(caddy.includes('admin unix/'), 'Admin API 必须走 unix socket（它无内置鉴权）')
  assert.ok(caddy.includes('persist_config off'), '必须关闭 persist_config，否则 autosave 会冒充真源')
  assert.ok(!/admin\s+:2019/.test(caddy), '绝不能把 Admin API 绑到 wildcard 接口')
  assert.ok(!/reverse_proxy\s+dsh:/.test(caddy), 'DSH Web UI 不得经 Caddy 暴露到公网（Host/Origin 栅栏）')
  assert.ok(!/^\s*handle\s*\{/m.test(caddy), '不得有兜底 handle：Caddy 首匹配胜出，兜底会永久遮蔽动态路由')
})

// ── 工具 ─────────────────────────────────────────────────────────────────────
/** 提取 cordis.patch.yml 中 storageRoots 下的键值（按缩进判断块结束）。 */
function extractStorageRoots(patch: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  let inside = false
  let blockIndent = -1
  for (const line of patch.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const m = /^(\s*)storageRoots:\s*$/.exec(line)
    if (m !== null) { inside = true; blockIndent = (m[1] ?? '').length; continue }
    if (!inside) continue
    if (line.trim() === '') continue
    const kv = /^(\s*)([A-Za-z][\w-]*):\s*(\S+)\s*$/.exec(line)
    if (kv === null) { inside = false; continue }
    if ((kv[1] ?? '').length <= blockIndent) { inside = false; continue }
    out.push({ key: kv[2] as string, value: kv[3] as string })
  }
  return out
}

/**
 * 遍历源码文件（跳过 node_modules / research）。
 *
 * @param roots - 起始目录。
 * @param options - `skipTests` 跳过 `*.test.ts`（红线检查用：测试要能枚举禁用名来断言其不存在）。
 */
function walkSources(roots: readonly string[], options: { readonly skipTests?: boolean } = {}): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) return
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'research' || entry.name === '.git') continue
      const child = join(rel, entry.name)
      if (entry.isDirectory()) { walk(child); continue }
      const isTest = /\.test\.(ts|mts|cts|js|mjs)$/.test(entry.name)
      if (options.skipTests === true && isTest) continue
      if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name)) out.push(relative(REPO_ROOT, join(REPO_ROOT, child)))
    }
  }
  for (const root of roots) walk(root)
  return out
}

