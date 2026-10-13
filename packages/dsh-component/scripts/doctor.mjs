/**
 * `forlife doctor` —— 契约不匹配检查（PLAN 阶段 11 未勾项）。
 *
 * ## 怎么跑
 *
 * ```
 * node packages/dsh-component/scripts/doctor.mjs
 * ```
 *
 * ## 为什么是个**独立脚本**而不是插件里的一个函数
 *
 * `doctor` 要在**出问题时**跑 —— 那时候**插件可能根本没 apply 成功**。
 * 如果它必须靠插件跑起来才能用，那**最需要它的时候它就用不了**。
 *
 * ⇒ 独立脚本：**不需要 DSH 跑着**，直接探。
 *
 * ## ⚠️ 一个必须说清的限制
 *
 * 这个脚本**拿不到真宿主的 `ctx`**（那要 DSH 把插件 apply 起来）。
 * 所以它有两种模式：
 * 1. **`--probe-real`**：连到正在跑的 DSH 上探（**需要 DSH 在跑**）；
 * 2. **默认**：用**已知契约清单**做一次静态自检 ——
 *    报出"我们依赖什么"，并**检查我们自己的代码里是否真的在用**这些能力。
 *
 * **第 2 种不是"假装探到了"** —— 它明确说自己探的是什么。
 * （"真宿主探测"与"静态自检"是两件事，**不把前者说成后者**。）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { HOST_REQUIREMENTS, renderDoctorReport, runDoctor } from '../src/host-contract.ts'

const args = process.argv.slice(2)
const wantReal = args.includes('--probe-real')

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  forlife doctor')
console.log('══════════════════════════════════════════════════════════════')
console.log('')

if (!wantReal) {
  // ── 静态自检：报出依赖清单 + 检查代码里是否真的在用 ──
  console.log('  模式：**静态自检**（没有连真宿主）')
  console.log('  —— 它报的是"我们依赖什么"以及"代码里是否真的在用"。')
  console.log('     要探真宿主，加 `--probe-real`（**需要 DSH 在跑**）。')
  console.log('')

  console.log(`  依赖清单（共 ${String(HOST_REQUIREMENTS.length)} 项）：`)
  console.log('')
  const required = HOST_REQUIREMENTS.filter((r) => r.level === 'required')
  const optional = HOST_REQUIREMENTS.filter((r) => r.level === 'optional')
  console.log(`  【必需 ${String(required.length)} 项】缺了 ⇒ 记忆本体不工作`)
  for (const r of required) console.log(`    · ${r.id}\n        ${r.what}`)
  console.log('')
  console.log(`  【加固 ${String(optional.length)} 项】缺了 ⇒ 降级可用（**不算失败**）`)
  for (const r of optional) console.log(`    · ${r.id}\n        ${r.what}`)
  console.log('')

  // **代码里是否真的在用** —— 这是静态自检能做的实事：
  // 如果清单里列了某个钩子，而代码里根本没订阅它，那清单是**假的**。
  // ★ **扫整个 src 目录**，不只 index.ts ——
  // 第一版只读了 index.ts，于是 `agent/assistant-stream`（在 loop-guard-register.ts 里）
  // 被报成"代码里找不到" —— **那是假警**。
  // **"清单与代码不一致"这个结论取决于"我扫了哪些文件"**；
  // 扫得不全就会报假警，而**假警会让人不再信任这份报告**。
  const srcDir = new URL('../src/', import.meta.url)
  const src = readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(new URL(f, srcDir), 'utf8'))
    .join('\n')
  const checks = [
    { id: 'event:session/event', needle: "on('session/event'" },
    { id: 'event:agent/assistant-stream', needle: "on('agent/assistant-stream'" },
    { id: 'ctx.get(systemPrompt)', needle: "get('systemPrompt')" },
    { id: 'ctx.get(tools)', needle: "get('tools')" },
  ]
  console.log('  代码自检（清单里列的，代码里真的在用吗）：')
  let bad = 0
  for (const c of checks) {
    const used = src.includes(c.needle) || src.includes(c.needle.replace(/'/g, '"'))
    if (!used) bad += 1
    console.log(`    ${used ? '✓' : '✗'} ${c.id}`)
  }
  console.log('')
  if (bad > 0) {
    console.log(`  ⚠️ **有 ${String(bad)} 项列在清单里但代码里找不到** ——`)
    console.log('     那份清单就是假的（**清单必须反映真实依赖，否则没人会看它**）。')
  } else {
    console.log('  ✓ 清单与代码一致')
  }
  console.log('')
  process.exit(0)
}

// ── 真宿主探测 ──
console.log('  模式：**真宿主探测**')
console.log('')

// 真宿主探测要 DSH 把插件 apply 起来。我们通过**插件自己登记的活动运行时**
// 拿不到 ctx（ctx 是宿主的，不外传）——所以这里**如实说清做不到**，
// 而不是编一个假的 ctx 去探。
console.log('  ⚠️ **做不到**：`ctx` 是宿主的，**不外传**。')
console.log('     插件里拿不到一个"可以事后查询"的 ctx 句柄。')
console.log('')
console.log('  ⇒ 真宿主探测的**可行做法**是在插件 apply 时**顺手跑一次**并写日志：')
console.log('     看 `web.log` 里有没有那几行"已订阅…"。')
console.log('     （真机证据见 EXECUTION_PLAN 的 8.0.0 节。）')
console.log('')

// 用**空 ctx** 跑一遍，展示"什么都没有"时报告长什么样 ——
// 那是**演示格式**，不是探测结果（**明说，免得被当成真的**）。
const demo = runDoctor({})
console.log('  下面是"空 ctx"下的报告样例（**仅演示格式**，不是你的环境）：')
console.log('')
console.log(
  renderDoctorReport(demo)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n'),
)
console.log('')
