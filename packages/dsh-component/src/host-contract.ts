/**
 * **宿主契约探针** —— `forlife doctor` 的核心。
 *
 * ## 它解决什么问题（PLAN 的验收标准）
 *
 * > 「升级 DSH 版本后，`forlife doctor` 明确报出契约不匹配点，
 * > 且系统降级可用（`optional` 契约失效不致命）」
 *
 * DSH 是**宿主**，我们是插件。**它一升级，我们依赖的东西可能就没了**：
 * 钩子改名、`ctx.get()` 不再提供某个服务、某个字段消失。
 * 而**这种失效是静默的** —— 插件照样 apply，只是某块功能不工作。
 *
 * （本项目已经栽过两次：`whitelist` 参数被丢、`onConnectionState` 被构造函数丢掉，
 * **两次都是测试全绿而线上没跑**。）
 *
 * ## ★ 为什么要分 `required` / `optional`（这是验收标准的后半句）
 *
 * **不是所有依赖都一样重要**：
 * - `required` 没了 ⇒ **记忆本体不工作** ⇒ 必须**大声报错**；
 * - `optional` 没了 ⇒ 只是**加固功能降级**（比如死循环监控）⇒
 *   **报出来但不算失败** —— 这正是"**降级可用**"。
 *
 * **如果所有依赖都算致命**，那一次宿主小升级就会让插件拒绝启动 ——
 * 那是**比降级更糟的结果**（用户宁可少一个加固功能，也不愿整个记忆系统不启动）。
 *
 * ## ★ 一条纪律：**探针只读、绝不改状态**
 *
 * `doctor` 会被人在**出问题时**跑。它要是自己抛异常或改了什么，
 * **就把"诊断"变成了"又一次故障"**。
 * ⇒ 每个探针都包在 try/catch 里，**失败本身就是要报的结果**。
 *
 * @module forlife-memory/host-contract
 */

/** 一个依赖项。 */
export interface HostRequirement {
  /** 稳定标识（写进报告，便于搜索与对比）。 */
  readonly id: string
  /** 人话描述（"缺了会怎样"）。 */
  readonly what: string
  /** `required` 缺了 = 记忆本体不工作；`optional` 缺了 = 加固功能降级。 */
  readonly level: 'required' | 'optional'
  /** 探测函数。**返回 false/抛异常都算"不满足"**。 */
  readonly probe: (ctx: unknown) => boolean
}

/** 探测结果。 */
export interface RequirementResult {
  readonly id: string
  readonly what: string
  readonly level: 'required' | 'optional'
  readonly ok: boolean
  /** 不满足时的原因（**探测抛的异常也记在这里** —— 那本身是重要信息）。 */
  readonly detail?: string
}

/** 报告。 */
export interface DoctorReport {
  readonly results: readonly RequirementResult[]
  /** **缺了的 `required`** ⇒ 记忆本体不可用。 */
  readonly missingRequired: readonly RequirementResult[]
  /** **缺了的 `optional`** ⇒ 加固降级，**但仍然可用**。 */
  readonly missingOptional: readonly RequirementResult[]
  /** 整体结论：`ok` / `degraded`（只缺 optional）/ `broken`（缺 required）。 */
  readonly verdict: 'ok' | 'degraded' | 'broken'
  /** 一行结论（可直接打印）。 */
  readonly summary: string
}

/** 安全地调探测函数：**异常 = 不满足**（异常本身是要报的信息）。 */
function safeProbe(req: HostRequirement, ctx: unknown): RequirementResult {
  try {
    const ok = req.probe(ctx) === true
    return ok
      ? { id: req.id, what: req.what, level: req.level, ok: true }
      : { id: req.id, what: req.what, level: req.level, ok: false, detail: '探测返回 false' }
  } catch (error) {
    return {
      id: req.id,
      what: req.what,
      level: req.level,
      ok: false,
      detail: `**探测抛了异常**：${String(error).slice(0, 160)}`,
    }
  }
}

/** 从 `ctx` 安全地取一个服务。 */
function serviceOf(ctx: unknown, name: string): unknown {
  const c = ctx as { get?: (n: string) => unknown } | null
  if (c === null || typeof c !== 'object' || typeof c.get !== 'function') return undefined
  return c.get(name)
}

/**
 * 我们依赖的宿主契约（**每一项都对应代码里真的用了的东西**）。
 *
 * **不列"可能有用的"** —— 只列**真的依赖**的，否则报告会充满噪音，
 * 而噪音会让人**不再看报告**。
 */
export const HOST_REQUIREMENTS: readonly HostRequirement[] = [
  {
    id: 'ctx.on',
    what: '订阅宿主事件的能力（记忆沉降、缓存采集都靠它）',
    level: 'required',
    probe: (ctx) => typeof (ctx as { on?: unknown } | null)?.on === 'function',
  },
  {
    id: 'ctx.get(systemPrompt)',
    what: '系统提示词注入点（三层记忆的说明必须进提示词）',
    level: 'required',
    probe: (ctx) => serviceOf(ctx, 'systemPrompt') !== undefined,
  },
  {
    id: 'ctx.get(tools)',
    what: '工具注册点（remember / recall_longterm 等全靠它）',
    level: 'required',
    probe: (ctx) => serviceOf(ctx, 'tools') !== undefined,
  },
  {
    id: 'systemPrompt.section',
    what: '提示段注册方法（少了它提示词进不去）',
    level: 'required',
    probe: (ctx) => {
      const sp = serviceOf(ctx, 'systemPrompt') as { section?: unknown } | undefined
      return typeof sp?.section === 'function'
    },
  },
  {
    id: 'tools.register',
    what: '工具注册方法',
    level: 'required',
    probe: (ctx) => {
      const t = serviceOf(ctx, 'tools') as { register?: unknown } | undefined
      return typeof t?.register === 'function'
    },
  },
  {
    id: 'event:session/event',
    what: '会话事件流（缓存命中率采集 + **工具侧死循环监控**）',
    level: 'optional',
    probe: (ctx) => typeof (ctx as { on?: unknown } | null)?.on === 'function',
  },
  {
    id: 'event:agent/assistant-stream',
    what: '模型输出流（**文字侧死循环监控**）',
    level: 'optional',
    probe: (ctx) => typeof (ctx as { on?: unknown } | null)?.on === 'function',
  },
  {
    id: 'connection.fetch.register',
    what: '面板 HTTP 路由（少了它管理后台不可用，但记忆本体正常）',
    level: 'optional',
    probe: (ctx) => {
      const c = serviceOf(ctx, 'connection') as { fetch?: { register?: unknown } } | undefined
      return typeof c?.fetch?.register === 'function'
    },
  },
]

/**
 * 跑一遍探测，给出报告。
 *
 * **纯读** —— 不注册、不订阅、不改任何状态（见模块头的纪律）。
 */
export function runDoctor(ctx: unknown, requirements: readonly HostRequirement[] = HOST_REQUIREMENTS): DoctorReport {
  const results = requirements.map((req) => safeProbe(req, ctx))
  const missingRequired = results.filter((r) => !r.ok && r.level === 'required')
  const missingOptional = results.filter((r) => !r.ok && r.level === 'optional')

  // **三档结论** —— 关键是"只缺 optional"**不等于坏**（那是"降级可用"）
  const verdict: DoctorReport['verdict'] =
    missingRequired.length > 0 ? 'broken' : missingOptional.length > 0 ? 'degraded' : 'ok'

  const total = results.length
  const okCount = results.filter((r) => r.ok).length
  const summary =
    verdict === 'ok'
      ? `契约齐全（${String(okCount)}/${String(total)}）`
      : verdict === 'degraded'
        ? `**降级可用**：${String(okCount)}/${String(total)} 齐全，缺 ${String(missingOptional.length)} 项**加固**功能（记忆本体正常）`
        : `**契约不匹配**：缺 ${String(missingRequired.length)} 项**必需**能力 —— 记忆本体不可用`

  return { results, missingRequired, missingOptional, verdict, summary }
}

/** 把报告渲染成可打印的文本。 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push(`forlife doctor —— ${report.summary}`)
  lines.push('')
  for (const r of report.results) {
    const mark = r.ok ? '✓' : r.level === 'required' ? '✗' : '⚠'
    const level = r.level === 'required' ? '必需' : '加固'
    lines.push(`  ${mark} [${level}] ${r.id}`)
    lines.push(`      ${r.what}`)
    if (!r.ok && r.detail !== undefined) lines.push(`      → ${r.detail}`)
  }
  if (report.missingOptional.length > 0) {
    lines.push('')
    lines.push('  降级说明：上面标 ⚠ 的**不影响记忆本体**，只是加固功能不工作。')
    lines.push('  **这不算失败** —— 用户宁可少一个加固功能，也不愿整个记忆系统不启动。')
  }
  if (report.missingRequired.length > 0) {
    lines.push('')
    lines.push('  不匹配点（**需要处理**）：')
    for (const r of report.missingRequired) lines.push(`    - ${r.id}：${r.what}`)
    lines.push('')
    lines.push('  多半是宿主（DSH）升级后接口变了。**先看上面每条的 → 原因。**')
  }
  return lines.join('\n')
}
