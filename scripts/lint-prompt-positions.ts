/**
 * 位置契约 lint（EXECUTION_PLAN 阶段 4 交付物 4）。
 *
 * ## 它防的是什么
 *
 * 稳定前缀里混进动态内容（时间、当前会话、随机数）会发生两件事：
 *  ① 每轮前缀都变 ⇒ 前缀缓存**永远不命中**；
 *  ② 而且**没人会发现** —— 功能一切正常，只是钱在烧。
 *
 * 所以这条规则必须由机器守：扫描我们所有 `systemPrompt.section({...})` 注册点，
 * 检查 order 是否在允许的区间、以及 <= PREFIX_MAX_ORDER 的段里
 * **有没有出现动态内容的迹象**。
 *
 * ## 为什么用"静态扫描 + 禁止符号表"而不是运行时断言
 *
 * 运行时断言只能在"真的跑起来"时发现问题（而本机没有模型凭据）。
 * 静态扫描在 CI 里每次提交都跑，能在**写下来那一刻**就拦住。
 *
 * 用法：node scripts/lint-prompt-positions.ts
 * 退出码 0 = 通过；1 = 有违规（CI 会失败）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 前缀段允许的最大 order。超过它就算"工具段/尾部"，动态内容是允许的。 */
const PREFIX_MAX_ORDER = 499

/**
 * 禁止出现在**前缀段文本**里的动态迹象。
 *
 * 刻意用"符号名"而不是正则匹配 `Date.now()`：符号名更稳定，
 * 而且报错时能直接告诉人"你用了 X，它每轮都变"。
 */
const DYNAMIC_MARKERS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bDate\.now\b/, why: '当前时间每轮都变' },
  { pattern: /\bnew Date\s*\(/, why: '当前时间每轮都变' },
  { pattern: /\bnowIso\s*\(/, why: '当前时间每轮都变' },
  { pattern: /\bMath\.random\b/, why: '随机数每轮都变' },
  { pattern: /\bcurrentConversationScope\b/, why: '当前会话随会话变化（多会话共用窗口时前缀会来回变）' },
  { pattern: /\bprocess\.uptime\b/, why: '运行时长每轮都变' },
  { pattern: /\btimeContext\b/, why: '时间读数必须走尾部注入' },
]

/** 已知的前缀段（名字 → 位置），由 prompt.ts 声明。 */
interface SectionDecl {
  readonly file: string
  readonly name: string
  readonly order: number | undefined
}

/** 递归找 .ts 文件（跳过 node_modules/测试/运行时目录）。 */
function findSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.runtime' || entry === 'research') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) findSources(full, out)
    else if (/\.(ts|mts)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full)
  }
  return out
}

/** 从文件里抽出 `section({...})` 调用（粗糙但足够：我们自己的代码风格稳定）。 */
function findSections(source: string, file: string): { decl: SectionDecl; body: string }[] {
  const out: { decl: SectionDecl; body: string }[] = []
  const marker = '.section({'
  let index = source.indexOf(marker)
  while (index >= 0) {
    // 用花括号配对找出这次调用的完整参数体
    let depth = 0
    let end = index + marker.length - 1
    for (let i = end; i < source.length; i++) {
      const char = source[i]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = source.slice(index, end + 1)
    const nameMatch = /name:\s*([A-Za-z0-9_]+|'[^']+')/.exec(body)
    const orderMatch = /order:\s*([A-Za-z0-9_]+|-?\d+)/.exec(body)
    out.push({
      decl: {
        file,
        name: nameMatch?.[1] ?? '(未命名)',
        order: orderMatch?.[1] !== undefined && /^-?\d+$/.test(orderMatch[1]) ? Number(orderMatch[1]) : undefined,
      },
      body,
    })
    index = source.indexOf(marker, end)
  }
  return out
}

/** 常量表：把 `export const X_ORDER = 120` 抽出来，供符号形式的 order 解析。 */
function collectOrderConstants(sources: readonly string[]): Map<string, number> {
  const constants = new Map<string, number>()
  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/export const ([A-Z0-9_]+_ORDER)\s*=\s*(-?\d+)/g)) {
      if (match[1] !== undefined && match[2] !== undefined) constants.set(match[1], Number(match[2]))
    }
  }
  return constants
}

/** 主流程。 */
function main(): number {
  const sources = findSources(join(REPO_ROOT, 'packages'))
  const constants = collectOrderConstants(sources)
  const problems: string[] = []
  const seen: SectionDecl[] = []

  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    for (const { decl, body } of findSections(source, relative(REPO_ROOT, file))) {
      const order = decl.order ?? (body.match(/order:\s*([A-Z0-9_]+_ORDER)/)?.[1] !== undefined
        ? constants.get(body.match(/order:\s*([A-Z0-9_]+_ORDER)/)?.[1] ?? '')
        : undefined)
      seen.push({ ...decl, order })

      const inPrefix = order !== undefined && order <= PREFIX_MAX_ORDER
      if (!inPrefix) continue

      for (const marker of DYNAMIC_MARKERS) {
        if (marker.pattern.test(body)) {
          problems.push(
            `${decl.file} 的段 ${decl.name}（order=${String(order)}）使用了动态内容 ` +
              `${String(marker.pattern)} —— ${marker.why}。\n` +
              '    动态内容必须走**尾部注入**（每轮消息）或 context()，不能进稳定前缀。',
          )
        }
      }
    }
  }

  // 契约：我们自己的段必须落在声明的 order 上，且不撞车
  const byOrder = new Map<number, SectionDecl[]>()
  for (const decl of seen) {
    if (decl.order === undefined) continue
    const list = byOrder.get(decl.order)
    if (list === undefined) byOrder.set(decl.order, [decl])
    else list.push(decl)
  }
  for (const [order, decls] of byOrder) {
    if (decls.length > 1) {
      problems.push(
        `order=${String(order)} 被多个段占用：${decls.map((d) => `${d.name}(${d.file})`).join(', ')} —— ` +
          '同一 order 下宿主要按名字排序，撞车会让段序变得难以预测。',
      )
    }
  }

  // 报告
  console.log(`扫描到 ${String(seen.length)} 个 section 注册点：`)
  for (const decl of [...seen].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))) {
    const zone = decl.order === undefined ? '?' : decl.order <= PREFIX_MAX_ORDER ? '前缀' : '尾部/工具'
    console.log(`  [${zone}] order=${String(decl.order ?? '?').padStart(4)} ${decl.name}  (${decl.file})`)
  }

  if (problems.length > 0) {
    console.error(`\n✗ 位置契约违规 ${String(problems.length)} 处：`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('\n✓ 位置契约检查通过：稳定前缀里没有动态内容，order 无撞车。')
  return 0
}

process.exit(main())
