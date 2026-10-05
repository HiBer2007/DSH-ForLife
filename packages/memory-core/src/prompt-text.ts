/**
 * 提示词文本的**纯逻辑**：规范化、哈希、变量校验、试渲染、token 估算。
 *
 * ## 为什么"规范化"是缓存能否生效的前提
 *
 * 前缀缓存比对的是**字节**。同一个提示词如果因为换行符差异（`\r\n` vs `\n`）、
 * 行尾空格、末尾空行数量不同而算出不同的哈希，就会出现最坏的情况：
 * 内容一模一样但我们自己认为"变了"，于是每轮都判一次缓存未命中。
 * 所以：**先规范化，再哈希**，而且哈希的是规范化结果。
 *
 * ## 变量白名单为什么必须有
 *
 * DSH 的 `renderPrompt` 对**未定义变量会抛错**（这是好事：静默留空更危险）。
 * 但我们的提示词是**用户可编辑**的 —— 用户敲错一个变量名就会让整个提示词装配失败。
 * 所以在保存前就校验：未知变量、以及"动态变量"（时间/日期这类每轮都变的）
 * 一律拒绝，并把原因说清楚。
 *
 * 动态变量进前缀 = 每轮都换前缀 = 缓存全废。这就是"位置契约"的核心一条。
 *
 * @module @forlife/memory-core/prompt-text
 */
import { createHash } from 'node:crypto'

/** 变量定义。 */
export interface PromptVariableSpec {
  /** 变量名（与 DSH 规则一致：`^[a-z][a-z0-9_]*$`）。 */
  readonly name: string
  /**
   * 是否是**动态**的（每轮可能变）。
   *
   * 动态变量**禁止**出现在稳定前缀里 —— 那等于每轮换前缀，缓存全废。
   * 它们只能用在 P3（每轮动态内容，走消息而不是 section）。
   */
  readonly dynamic: boolean
  readonly description: string
  /** 试渲染时用的示例值（让"预览"能真的画出拼装结果）。 */
  readonly sample: string
}

/**
 * 变量白名单。
 *
 * 前五项是稳定变量（改名/换称呼才会变），后四项是动态变量（每轮都可能变，
 * 仅允许用在尾部注入里）。这个划分不是审美问题：它直接决定缓存能不能命中。
 */
export const PROMPT_VARIABLES: readonly PromptVariableSpec[] = [
  { name: 'persona_name', dynamic: false, description: '它的名字', sample: '团子' },
  { name: 'owner_name', dynamic: false, description: '主人的称呼', sample: '主人' },
  { name: 'language', dynamic: false, description: '回答语言', sample: '中文' },
  { name: 'persona_role', dynamic: false, description: '身份一句话', sample: '一个住在 QQ 里的伙伴' },
  { name: 'style_notes', dynamic: false, description: '风格补充（由后台维护）', sample: '少用感叹号，不说套话' },
  { name: 'now', dynamic: true, description: '当前时间（**禁止进前缀**）', sample: '2026-10-05T12:00:00Z' },
  { name: 'today', dynamic: true, description: '今天的日期（**禁止进前缀**）', sample: '2026-10-05' },
  { name: 'conversation', dynamic: true, description: '当前会话键（**禁止进前缀**）', sample: 'onebot11:88888' },
  { name: 'unread_summary', dynamic: true, description: '未读摘要（**禁止进前缀**）', sample: '老王：明天的会议改到十点' },
]

/** 按名字取变量定义。 */
export function promptVariable(name: string): PromptVariableSpec | undefined {
  return PROMPT_VARIABLES.find((v) => v.name === name)
}

/** 变量名的合法形式（与 DSH 的 `VARIABLE_NAME` 一致）。 */
export const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/**
 * 规范化提示词文本。
 *
 * 规则（全部是为了"内容相同 ⇒ 字节相同"）：
 * 1. 统一换行为 `\n`（Windows 上编辑过的文件会带 `\r`）；
 * 2. 去掉每行行尾空格与制表符；
 * 3. 去掉开头与结尾的空行；
 * 4. 结尾恰好一个换行。
 *
 * @param text - 原始文本。
 * @returns 规范化文本。
 */
export function normalizePromptText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n')
  const trimmedLines = unified.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  const body = trimmedLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  return body === '' ? '' : `${body}\n`
}

/** 规范化文本的 SHA-256（**哈希的是规范化结果**）。 */
export function hashPromptText(text: string): string {
  return createHash('sha256').update(normalizePromptText(text), 'utf8').digest('hex')
}

/** 校验结果。 */
export interface PromptValidation {
  readonly ok: boolean
  /** 致命问题（保存必须被拒）。 */
  readonly errors: readonly string[]
  /** 提醒（可保存，但要在界面上说）。 */
  readonly warnings: readonly string[]
  /** 文本里用到的变量。 */
  readonly variables: readonly string[]
}

/**
 * 校验提示词文本（保存前必须过这一关）。
 *
 * @param text - 文本。
 * @param options - 允许使用的变量范围：`'prefix'`（禁止动态变量，默认）或 `'tail'`（都允许）。
 * @returns 校验结果。
 */
export function validatePromptText(text: string, options: { readonly scope?: 'prefix' | 'tail' } = {}): PromptValidation {
  const where = options.scope ?? 'prefix'
  const errors: string[] = []
  const warnings: string[] = []
  const normalized = normalizePromptText(text)

  if (normalized === '') {
    errors.push('提示词不能为空（空提示词等于把人设交给默认值，容易出意外）')
    return { ok: false, errors, warnings, variables: [] }
  }

  // 扫描 {{var}}：只认成对的，落单的 {{ 当作普通文字（与 DSH 的语义一致）
  const variables: string[] = []
  const pattern = /\{\{([^{}]*)\}\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(normalized)) !== null) {
    const raw = match[1] ?? ''
    const name = raw.trim()
    if (!VARIABLE_NAME.test(name)) {
      errors.push(`变量名不合法：{{${raw}}}（必须以小写字母开头，只含小写字母、数字与下划线）`)
      continue
    }
    const spec = promptVariable(name)
    if (spec === undefined) {
      errors.push(`未知变量：{{${name}}}（可用变量见白名单；写错会导致整个提示词装配失败）`)
      continue
    }
    if (where === 'prefix' && spec.dynamic) {
      errors.push(
        `动态变量 {{${name}}} 不能用在稳定前缀里：它每轮都变，会让前缀每轮都失效（缓存全废）。` +
          '这类内容应放在每轮动态注入（P3）里。',
      )
      continue
    }
    if (!variables.includes(name)) variables.push(name)
  }

  // 落单的 {{ 提示一下（多半是手滑）
  const lone = normalized.replace(/\{\{[^{}]*\}\}/g, '').includes('{{')
  if (lone) warnings.push('文本里有落单的 `{{` —— 会被当作普通文字输出，确认不是手滑。')

  if (normalized.length > 8000) warnings.push(`提示词较长（${String(normalized.length)} 字符），它会占用每一轮的前缀预算。`)

  return { ok: errors.length === 0, errors, warnings, variables }
}

/** 试渲染结果。 */
export interface PromptRenderResult {
  readonly ok: boolean
  readonly text: string
  readonly errors: readonly string[]
  /** 用到的变量及其取值（界面要展示"最终拼装结果"）。 */
  readonly substitutions: readonly { readonly name: string; readonly value: string }[]
}

/**
 * 试渲染：把变量替换成给定值（或示例值），得到"最终拼装结果"。
 *
 * 与 DSH 的 `renderPrompt` 保持同样的严格程度：**未定义的值视为错误**，
 * 因为静默留空会让用户以为提示词生效了，实际少了半句。
 *
 * @param text - 文本。
 * @param values - 变量取值（缺省用白名单里的示例值）。
 * @returns 渲染结果。
 */
export function renderPromptPreview(text: string, values: Record<string, string> = {}): PromptRenderResult {
  const normalized = normalizePromptText(text)
  const errors: string[] = []
  const substitutions: { name: string; value: string }[] = []

  const rendered = normalized.replace(/\{\{([^{}]*)\}\}/g, (_full, raw: string) => {
    const name = raw.trim()
    const spec = promptVariable(name)
    const provided = values[name]
    if (spec === undefined) {
      errors.push(`未知变量：{{${name}}}`)
      return `{{${name}}}`
    }
    const value = provided ?? spec.sample
    if (value === undefined || value === '') {
      errors.push(`变量 {{${name}}} 没有取值（试渲染需要一个示例值）`)
      return `{{${name}}}`
    }
    substitutions.push({ name, value })
    return value
  })

  return { ok: errors.length === 0, text: rendered, errors, substitutions }
}

/**
 * 粗略 token 估算（CJK 按字、其余按 4 字符 1 token；与记忆侧同一套口径）。
 *
 * 注意先去掉规范化加上的**尾换行** —— 那是我们自己的记账产物，不是内容。
 * 留着它会凭空多算一个 token，而"试渲染 token 数与真实请求误差 ≤2%"是验收项。
 *
 * @param text - 文本。
 * @returns 估算 token 数。
 */
export function estimatePromptTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of normalizePromptText(text).replace(/\n$/, '')) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 两份文本的逐行 diff（后台要给人看改了什么）。 */
export interface PromptDiffLine {
  readonly kind: 'same' | 'added' | 'removed'
  readonly text: string
}

/**
 * 逐行 diff（简单 LCS，够用且可解释）。
 *
 * 没上复杂的 diff 算法是有意的：提示词通常几十行，
 * 一个能看懂的 LCS 比一个"聪明但说不清"的算法更有价值。
 *
 * @param before - 旧文本。
 * @param after - 新文本。
 * @returns diff 行序列。
 */
export function diffPromptLines(before: string, after: string): readonly PromptDiffLine[] {
  // 空文本要切成**空数组**而不是 ['']：后者会让"从无到有"显示成"删了一行空行再加一行"
  const lines = (text: string): string[] => {
    const body = normalizePromptText(text).replace(/\n$/, '')
    return body === '' ? [] : body.split('\n')
  }
  const a = lines(before)
  const b = lines(after)
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i]
      const next = table[i + 1]
      if (row === undefined || next === undefined) continue
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: PromptDiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' })
      i += 1
      j += 1
      continue
    }
    const down = table[i + 1]?.[j] ?? 0
    const right = table[i]?.[j + 1] ?? 0
    if (down >= right) {
      out.push({ kind: 'removed', text: a[i] ?? '' })
      i += 1
    } else {
      out.push({ kind: 'added', text: b[j] ?? '' })
      j += 1
    }
  }
  while (i < a.length) {
    out.push({ kind: 'removed', text: a[i] ?? '' })
    i += 1
  }
  while (j < b.length) {
    out.push({ kind: 'added', text: b[j] ?? '' })
    j += 1
  }
  return out
}

