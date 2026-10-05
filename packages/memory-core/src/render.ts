/**
 * 中期记忆区的**渲染纯函数**。
 *
 * 这是 PLAN 的核心承诺所在（§2.2 / §2.3 / §10.2）：
 * **表是权威，窗口是渲染；渲染是纯函数，不产生副作用。**
 *
 * 三条由本模块负责保证的性质：
 *  1. **纯**：给定同样的行与同样的选项（含显式传入的 `now`），输出**逐字节相同**；
 *  2. **确定**：只依赖传入的行数组，不读时钟、不读环境、不读全局状态；
 *  3. **可校验**：渲染的同时报告违反约束的地方（hint 超长、碎片超量…），
 *     但**不擅自截断** —— 截断是写入方的责任，渲染方只如实反映"现在是什么"。
 *
 * 渲染形态照 PLAN §2.2：
 * ```
 * === 中期记忆 ===
 * [M1] 用户偏好 Rust 写系统工具...
 * [M2] DSH 采用追加式稳定前缀...
 * [F1→] QQ bot 防抖与消息队列（recall_longterm 可取回）
 * ```
 *
 * @module @forlife/memory-core/render
 */
import { createHash } from 'node:crypto'
import type { MidEntryRow } from '@forlife/store'
import { defaultFor } from '@forlife/contracts'
import { estimateTokens } from './tokens.ts'

/** 渲染选项。 */
export interface RenderOptions {
  /** 标题行；默认 `=== 中期记忆 ===`。 */
  readonly header?: string
  /** 是否渲染相对年龄（§2.15 P3）；开启时 **必须** 传 `now` 以保证纯函数。 */
  readonly relativeAges?: boolean
  /** 相对年龄用的基准时刻；纯函数的必要条件（不传则取不到"现在"）。 */
  readonly now?: Date
  /** 载入语句里的提示文案（默认"recall_longterm 可取回"）。 */
  readonly fragmentHintSuffix?: string
  /** token 估算器（默认内置启发式；宿主有 tokenMeter 时可注入）。 */
  readonly countTokens?: (text: string) => number
  /** 空记忆区的占位文案。 */
  readonly emptyText?: string
}

/** 渲染结果。 */
export interface RenderedView {
  /** 渲染出的文本（逐字节确定）。 */
  readonly text: string
  /** 文本的 sha256（做字节稳定性测试与缓存键用）。 */
  readonly sha256: string
  /** token 估算。 */
  readonly tokenEstimate: number
  readonly activeCount: number
  readonly fragmentCount: number
  /** 违反约束的地方（渲染方只报告，不擅自改数据）。 */
  readonly violations: readonly string[]
}

/** 默认标题。 */
export const DEFAULT_HEADER = '=== 中期记忆 ==='

/**
 * 渲染中期记忆区。
 *
 * @param entries - 参与渲染的条目（调用方已按 `compaction_epoch` 与 `status` 过滤、按 `window_offset` 排序）。
 * @param options - 渲染选项。
 * @returns 渲染结果（文本 + 摘要信息）。
 */
export function renderMidMemory(entries: readonly MidEntryRow[], options: RenderOptions = {}): RenderedView {
  const count = options.countTokens ?? estimateTokens
  const header = options.header ?? DEFAULT_HEADER
  const suffix = options.fragmentHintSuffix ?? 'recall_longterm 可取回'
  const violations: string[] = []

  // 极值来自基线：渲染方只做"报告"，所以这里读的是文档里的上限
  const maxHintTokens = defaultFor<number>('fragment.maxHintTokens')
  const maxEntities = defaultFor<number>('fragment.maxEntities')
  const maxFragments = defaultFor<number>('fragment.maxCount')
  const maxAreaRatio = defaultFor<number>('fragment.maxAreaRatio')

  if (options.relativeAges === true && options.now === undefined) {
    // 没有基准时刻就无法做出纯函数输出 —— 宁可报错，也不要偷偷读系统时钟
    throw new Error('renderMidMemory：开启 relativeAges 时必须显式传入 now（否则渲染不再是纯函数）')
  }

  const lines: string[] = []
  let activeIndex = 0
  let fragmentIndex = 0
  let activeTokens = 0
  let fragmentTokens = 0

  for (const entry of entries) {
    const entities = parseEntities(entry.entities)
    if (entities.length > maxEntities) {
      violations.push(`${entry.id}: entities 数量 ${entities.length} 超过上限 ${maxEntities}`)
    }

    const age = options.relativeAges === true && options.now !== undefined ? formatAge(entry.created_at, options.now) : undefined
    const ageText = age === undefined ? '' : `（${age}）`

    if (entry.entry_type === 'fragment') {
      fragmentIndex += 1
      const hint = entry.fragment_hint ?? entry.summary
      const hintTokens = count(hint)
      if (hintTokens > maxHintTokens) {
        violations.push(`${entry.id}: 碎片 hint ${hintTokens} token 超过上限 ${maxHintTokens}`)
      }
      fragmentTokens += entry.token_count
      lines.push(`[F${fragmentIndex}→] ${hint}（${suffix}）${ageText}`)
    } else {
      activeIndex += 1
      activeTokens += entry.token_count
      lines.push(`[M${activeIndex}] ${entry.summary}${ageText}`)
    }
  }

  if (fragmentIndex > maxFragments) {
    violations.push(`碎片总数 ${fragmentIndex} 超过上限 ${maxFragments}`)
  }
  const totalTokens = activeTokens + fragmentTokens
  if (totalTokens > 0) {
    const ratio = fragmentTokens / totalTokens
    if (ratio > maxAreaRatio) {
      violations.push(`碎片区占比 ${(ratio * 100).toFixed(1)}% 超过上限 ${(maxAreaRatio * 100).toFixed(0)}%`)
    }
  }

  const text = entries.length === 0 ? (options.emptyText ?? '') : [header, ...lines].join('\n')
  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    tokenEstimate: count(text),
    activeCount: activeIndex,
    fragmentCount: fragmentIndex,
    violations,
  }
}

/** 宽松解析 entities（表里是 JSON 文本；坏数据不应让渲染崩掉）。 */
function parseEntities(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 相对年龄（供 §2.15 P3 用）：只输出人类可读的粗粒度，不输出精确差值以免抖动。 */
export function formatAge(createdAt: string, now: Date): string {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return '时间未知'
  const diffMs = now.getTime() - created
  if (diffMs < 0) return '刚刚'
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}
