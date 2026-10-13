// 【只读审计】扫出**含中文的非注释行**，按文件分组计数 + 列出可疑的"模型可见"。
//
// 背景（`FIX_PLAN.md` §76.5②/③、§78）：用户裁定「所有的工具、系统提示词需要修改为英文」。
//  §75 收官了 `tools.ts`；§76 翻了 `runtime.ts` 里"会进工具返回值"的那些；
//  §78 建了**工具 schema 的英文棘轮**（`packages/dsh-component/test/tool-schema-english.test.ts`）
//  并翻完了 memory / port / mention / router 四个模块。
//
//  这个脚本回答的是**下一个面**还剩什么：**含中文的非注释行**（启发式挑出"模型可见"的那些）。
//  ⚠️ 它是**启发式**，不是判据 —— 判据是那个棘轮守卫 + 逐条人读。
//  ⚠️ 运维日志（`log` / `atLevel`）**本来就该是中文**，不要照着这个脚本无脑翻。
//
// 用法：node scripts/audit-model-visible-zh.mjs [目录…]
//   缺省：packages/dsh-component/src packages/store/src
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2)
const dirs = roots.length > 0 ? roots : ['packages/dsh-component/src', 'packages/store/src']

/** 递归收集 .ts。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.ts') && statSync(full).isFile()) out.push(full)
  }
  return out
}

const CJK = /[\u4e00-\u9fff]/
/** 去注释：块注释 + 行注释（**保留字符串里的 //**，避免误伤 URL）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1')
}

const files = dirs.flatMap((d) => walk(d))
let total = 0
const perFile = []
/** 可疑：模型可能看到的（工具返回值 / 提示词片段 / 推给模型的说明）。 */
const sus = []

/** 这些模式一旦含中文，**很可能到模型眼前**。 */
const MODELISH = [
  /return\s+[`'"]/,
  /\b(notes?|hint|error|message|reason|description|text|summary|title|label|prompt)\s*:/,
  /\b(notes?|hint|error)\s*\.push\(/,
  /parts\.push\(/,
  /parts\.unshift\(/,
  /\bcontent\s*:/,
  /\bsystemPrompt\b/,
]

for (const file of files) {
  const stripped = stripComments(readFileSync(file, 'utf8'))
  const lines = stripped.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    if (!CJK.test(line)) return
    // 纯英文行里夹一个中文标点不算（保守：仍计入，但标出来）
    hits.push([i + 1, line])
  })
  if (hits.length === 0) continue
  total += hits.length
  perFile.push([file, hits.length])
  for (const [ln, line] of hits) {
    if (MODELISH.some((re) => re.test(line))) sus.push([file, ln, line.trim()])
  }
}

perFile.sort((a, b) => b[1] - a[1])
console.log('=== 含中文的非注释行：按文件 ===')
for (const [file, n] of perFile) console.log(`${String(n).padStart(4)}  ${file}`)
console.log(`\n合计 ${String(total)} 行 / ${String(perFile.length)} 个文件`)
console.log(`\n=== 可能到模型眼前的（启发式，${String(sus.length)} 条）===`)
let last = ''
for (const [file, ln, line] of sus) {
  if (file !== last) {
    console.log(`--- ${file}`)
    last = file
  }
  console.log(`  L${String(ln)}: ${line.slice(0, 120)}`)
}
