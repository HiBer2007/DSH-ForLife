/**
 * `forlife doctor` —— 阶段 0 的验收物：一屏看清"这套东西现在能不能跑、缺什么"。
 *
 * 设计原则：
 *  - **只读**：检查流程绝不写宿主 `~/.dsh`，也绝不改动 profile；
 *  - **可移植性优先**：所有路径都相对 `DSH_HOME` / 仓库根解析，能在任意机器上给出同样结论；
 *  - **失败要说人话**：每条检查都给出"怎么修"，而不只是"失败了"。
 *
 * 用法：`node scripts/doctor.ts`（或 `pnpm doctor`）
 *
 * @module scripts/doctor
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = join(REPO_ROOT, 'profiles', 'forlife')

type Level = 'ok' | 'warn' | 'fail'
interface Check {
  readonly level: Level
  readonly title: string
  readonly detail: string
  readonly fix?: string
}

const checks: Check[] = []
const add = (c: Check): void => void checks.push(c)

// ── 1. 运行时 ────────────────────────────────────────────────────────────────
{
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 24) {
    add({ level: 'ok', title: 'Node 运行时', detail: `v${process.versions.node}（原生 TS 类型擦除 + node:sqlite 可用）` })
  } else {
    add({
      level: 'fail',
      title: 'Node 运行时',
      detail: `v${process.versions.node} 过低`,
      fix: '需要 Node ≥ 24：开发期依赖原生 TS 支持，运行期依赖 node:sqlite（FTS5）。',
    })
  }
  try {
    // node:sqlite 能力探针（阶段 1 的记忆表全靠它）
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec("create virtual table probe using fts5(x)")
    const version = (db.prepare('select sqlite_version() as v').get() as { v: string }).v
    db.close()
    add({ level: 'ok', title: 'node:sqlite', detail: `SQLite ${version}，FTS5 可用` })
  } catch (error) {
    add({
      level: 'fail',
      title: 'node:sqlite',
      detail: String(error),
      fix: '确认使用 Node 24 官方发行版（FTS5 需编译期启用）。',
    })
  }
}

// ── 2. 契约与保真度 ──────────────────────────────────────────────────────────
try {
  const contractsUrl = pathToFileURL(join(REPO_ROOT, 'packages', 'contracts', 'src', 'index.ts')).href
  const contracts = await import(contractsUrl)
  const summary = {
    params: contracts.baselineKeys().length,
    doc: contracts.docOriginKeys().length,
    timings: contracts.baselineTimings().length,
    pending: contracts.pendingBaselineKeys().length,
    deviations: contracts.DEVIATIONS.length,
    rules: contracts.RULE_DEVIATIONS.length,
  }
  add({
    level: summary.pending > 0 ? 'warn' : 'ok',
    title: '保真度基线',
    detail:
      `参数 ${summary.params}（doc ${summary.doc}）｜时机 ${summary.timings}｜数值偏离 ${summary.deviations}｜规则偏离 ${summary.rules}｜未定值 ${summary.pending}`,
    ...(summary.pending > 0 ? { fix: `${summary.pending} 条待实测标定（见 pendingBaselineKeys）` } : {}),
  })
} catch (error) {
  add({ level: 'fail', title: '保真度基线', detail: String(error), fix: '先 `pnpm install` 建立工作区链接。' })
}

// ── 3. 可移植性（核心约束：绝不碰宿主 ~/.dsh）────────────────────────────────
{
  // 只查"会被真正解析"的路径形态：盘符绝对路径、用户主目录、全局 npm 目录。
  // 文档性文字里提到 ~/.dsh 是允许的（那是在说"不要碰"），所以不查裸字符串。
  const functionalPatterns: readonly { readonly re: RegExp; readonly what: string }[] = [
    { re: /[A-Za-z]:[\\/]{1,2}[^\s"']+/, what: 'Windows 绝对路径' },
    { re: /(^|[\s"'(])\/(home|Users)\//, what: 'Unix 用户主目录' },
    { re: /AppData[\\/]{1,2}Roaming/, what: 'Windows 全局 npm/AppData 路径' },
    { re: /%USERPROFILE%|\$HOME\b/, what: '环境变量形式的主目录引用' },
  ]
  const filesToScan = ['profiles/forlife/cordis.patch.yml', 'profiles/forlife/cordis.yml', 'profiles/forlife/package.json', 'package.json']
  const offenders: string[] = []
  for (const rel of filesToScan) {
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) continue // 注释可以讲"不要碰 ~/.dsh"
      for (const { re, what } of functionalPatterns) {
        if (re.test(line)) offenders.push(`${rel} → ${what}：${trimmed.slice(0, 80)}`)
      }
    }
  }
  add(
    offenders.length === 0
      ? { level: 'ok', title: '可移植性：无宿主路径硬编码', detail: `已扫描 ${filesToScan.length} 个文件的功能性路径，未发现绝对路径/主目录引用` }
      : { level: 'fail', title: '可移植性：发现宿主路径硬编码', detail: offenders.join('；'), fix: '路径一律相对 DSH_HOME（`./…` 开头）。' },
  )

  // storageRoots 的每个路径值都必须是相对路径
  const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
    let inRoots = false
    const badRoots: string[] = []
    for (const line of lines) {
      if (/^\s*storageRoots:\s*$/.test(line)) { inRoots = true; continue }
      if (inRoots) {
        const m = /^(\s+)([A-Za-z]+):\s*(\S+)\s*$/.exec(line)
        if (m === null) { if (line.trim() !== '' && !line.startsWith(' ')) inRoots = false; continue }
        const indent = m[1] ?? ''
        const key = m[2] ?? ''
        const value = m[3] ?? ''
        if (indent.length <= 6) { inRoots = false; continue } // 回到同级键，说明 storageRoots 结束
        if (!value.startsWith('./')) badRoots.push(`${key}=${value}`)
      }
    }
    add(
      badRoots.length === 0
        ? { level: 'ok', title: '存储根均为相对路径', detail: 'storageRoots 下所有值以 `./` 开头（换机器只改 DSH_HOME）' }
        : { level: 'fail', title: '存储根存在绝对路径', detail: badRoots.join(' '), fix: '改成 `./…`，绝对路径会毁掉可移植性。' },
    )
  }

  // DSH_HOME 解析优先级：显式配置 > $DSH_HOME > ~/.dsh（dsh-home-paths 的真实语义）
  const envHome = process.env.DSH_HOME?.trim()
  const effective = envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.dsh')
  const usingHost = resolve(effective) === resolve(join(homedir(), '.dsh'))
  add({
    level: usingHost ? 'warn' : 'ok',
    title: 'DSH_HOME',
    detail: `${effective}${usingHost ? '（= 宿主默认目录，本项目的开发/部署流程不应使用它）' : '（已隔离）'}`,
    ...(usingHost
      ? { fix: '设置 DSH_HOME 指向仓库内目录，例如：$env:DSH_HOME="D:\\DSH-ForLife\\.runtime\\dsh"' }
      : {}),
  })

  const profileInHome = join(effective, 'profiles', 'forlife')
  const profileReachable = existsSync(join(profileInHome, 'package.json'))
  add({
    level: profileReachable ? 'ok' : 'warn',
    title: 'profile 可达性',
    detail: profileReachable
      ? `${profileInHome} 可解析（junction 或实体目录）`
      : `${profileInHome} 不存在`,
    ...(profileReachable
      ? {}
      : {
          fix:
            '建立 junction 让 DSH 找到仓库内的 profile（不复制文件）：\n' +
            `      New-Item -ItemType Directory -Force "${join(effective, 'profiles')}"\n` +
            `      New-Item -ItemType Junction -Path "${profileInHome}" -Target "${PROFILE_DIR}"`,
        }),
  })
}

// ── 4. 存储根可写性（相对 DSH_HOME 解析）────────────────────────────────────
{
  const envHome = process.env.DSH_HOME?.trim()
  const base = envHome !== undefined && envHome !== '' ? envHome : REPO_ROOT
  const roots = ['db', 'hot', 'warm', 'vectors', 'workspace', 'tmp', 'logs']
  const results: string[] = []
  for (const root of roots) {
    const abs = isAbsolute(root) ? root : join(base, 'forlife', root)
    try {
      if (!existsSync(abs)) {
        // 只探父目录是否可写，避免 doctor 产生副作用（dir 创建留给首次启动）
        const parent = dirname(abs)
        accessSync(existsSync(parent) ? parent : base, constants.W_OK)
        results.push(`${root}:ok`)
      } else {
        accessSync(abs, constants.W_OK)
        results.push(`${root}:ok`)
      }
    } catch {
      results.push(`${root}:不可写`)
    }
  }
  const bad = results.filter((r) => r.endsWith('不可写'))
  add({
    level: bad.length === 0 ? 'ok' : 'fail',
    title: '存储根可写性',
    detail: `基于 ${base} 解析 ${roots.length} 个根：${results.join(' ')}`,
    ...(bad.length > 0 ? { fix: '检查权限或改 storageRoots 配置（支持任意可写路径，含 NAS 挂载点）。' } : {}),
  })
}

// ── 5. 部署工具链 ────────────────────────────────────────────────────────────
{
  const probe = (cmd: string, args: string[]): string | undefined => {
    try {
      // shell: true —— Windows 上 dsh / docker 是 .cmd/.ps1 垫片，直接 execFile 起不来
      return execFileSync([cmd, ...args].join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true })
        .trim()
        .split('\n')[0]
    } catch {
      return undefined
    }
  }
  const dshVersion = probe('dsh', ['--version'])
  add(
    dshVersion === undefined
      ? { level: 'warn', title: 'DSH CLI', detail: '未在 PATH 找到 dsh', fix: '开发期需要它来做 profile 组合验证（--dump-config）。' }
      : { level: 'ok', title: 'DSH CLI', detail: dshVersion },
  )

  const composeVersion = probe('docker', ['compose', 'version'])
  if (composeVersion === undefined) {
    add({ level: 'warn', title: 'Docker Compose', detail: '未找到（本机不做容器验证也可以，部署端需要）' })
  } else {
    // 把 compose 规范压在 2.13 能解析的范围内（本机实测版本）
    const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(composeVersion)
    const minor = m === null ? 99 : Number(m[2])
    add({
      level: minor >= 17 ? 'ok' : 'warn',
      title: 'Docker Compose',
      detail: `${composeVersion}`,
      ...(minor >= 17
        ? {}
        : { fix: '版本偏旧：compose 文件里避免使用 `up --wait`、`profiles` 等较新特性（CI 会用同版本解析）。' }),
    })
  }
}

// ── 6. 仓库状态 ──────────────────────────────────────────────────────────────
{
  const gitDir = join(REPO_ROOT, '.git')
  add(
    existsSync(gitDir)
      ? { level: 'ok', title: 'Git 仓库', detail: '已初始化' }
      : { level: 'warn', title: 'Git 仓库', detail: '尚未 git init', fix: 'git init 后做首个提交，便于回滚与审计。' },
  )
  const researchSize = directorySizeMB(join(REPO_ROOT, 'research', '_sources'))
  if (researchSize > 0) {
    add({ level: 'ok', title: '调研素材', detail: `research/_sources ≈ ${researchSize.toFixed(1)} MB（已在 .gitignore 中排除，交付前可删）` })
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const icon: Record<Level, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' }
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)))

console.log('\nDSH-ForLife · forlife doctor\n' + '─'.repeat(72))
for (const c of checks) {
  console.log(`${icon[c.level]} ${pad(c.title, 34)} ${c.detail}`)
  if (c.fix !== undefined) console.log(`   ${' '.repeat(34)} ↳ ${c.fix}`)
}
const failed = checks.filter((c) => c.level === 'fail').length
const warned = checks.filter((c) => c.level === 'warn').length
console.log('─'.repeat(72))
console.log(`结论：${failed === 0 ? (warned === 0 ? '全部就绪' : `可用，但 ${warned} 项需注意`) : `${failed} 项失败`}\n`)

process.exitCode = failed === 0 ? 0 : 1

/** 目录大小（MB）；不存在返回 0。 */
function directorySizeMB(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSafe(current)) {
      const abs = join(current, entry)
      const st = statSync(abs, { throwIfNoEntry: false })
      if (st === undefined) continue
      if (st.isDirectory()) walk(abs)
      else total += st.size
    }
  }
  walk(dir)
  return total / 1024 / 1024
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

