/**
 * 保真度基线的加载与访问层。
 *
 * 规则（EXECUTION_PLAN §2.6）：代码里的默认值**只能**从 `plan-baseline.json` 派生；
 * 任何有意偏离必须登记在 `deviations.ts`，否则 `test/fidelity.test.ts` 失败。
 *
 * @module @forlife/contracts/baseline
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 一条基线参数：值 + 出处。 */
export interface BaselineParam {
  /** 基线值（标量或对象）。 */
  readonly v: unknown
  /** 出处（文档 + 章节）。 */
  readonly src: string
  /** 未定值时的状态标记。 */
  readonly status?: 'tbd'
}

/** 一个时机：必须实现的触发点。 */
export interface BaselineTiming {
  readonly id: string
  readonly what: string
  readonly src: string
  readonly landing: string
}

/** 基线文件整体形状。 */
export interface Baseline {
  readonly meta: {
    readonly baselineVersion: string
    readonly documents: readonly string[]
    readonly rule: string
    readonly extractedAt: string
  }
  readonly params: Readonly<Record<string, BaselineParam>>
  readonly timings: readonly BaselineTiming[]
}

const BASELINE_URL = new URL('../plan-baseline.json', import.meta.url)

let cached: Baseline | undefined

/** 读取并解析基线（只读一次，进程内缓存）。 */
export function loadBaseline(): Baseline {
  if (cached !== undefined) return cached
  const raw = readFileSync(fileURLToPath(BASELINE_URL), 'utf8')
  cached = JSON.parse(raw) as Baseline
  return cached
}

/** 按点分键取一条参数的基线值；不存在则抛错（拼错键要立刻暴露）。 */
export function baselineValue(key: string): unknown {
  const param = loadBaseline().params[key]
  if (param === undefined) throw new Error(`plan-baseline 缺少参数：${key}`)
  return param.v
}

/** 按点分键取一条参数的完整记录（含出处）。 */
export function baselineParam(key: string): BaselineParam {
  const param = loadBaseline().params[key]
  if (param === undefined) throw new Error(`plan-baseline 缺少参数：${key}`)
  return param
}

/** 全部参数键（有序）。 */
export function baselineKeys(): readonly string[] {
  return Object.keys(loadBaseline().params).sort()
}

/** 全部时机。 */
export function baselineTimings(): readonly BaselineTiming[] {
  return loadBaseline().timings
}

/**
 * 参数的来源类别：
 *  - `doc`：**来自设计文档**（`PLAN.MD` / `模型路由.MD`）⇒ 必须一比一，改它要走偏离登记；
 *  - `design`：**我们自己的设计参数**（`EXECUTION_PLAN`）⇒ 可自由调优，但仍必须集中在这里。
 *
 * 判定方式刻意做成"看 src 前缀"，这样新增参数时**不需要额外维护一个字段**，
 * 也避免了"忘了标 origin 导致校验静默失效"。
 */
export function baselineOrigin(key: string): 'doc' | 'design' {
  const { src } = baselineParam(key)
  return /^(PLAN\.MD|模型路由\.MD)/.test(src) ? 'doc' : 'design'
}

/** 全部来自设计文档的参数键（这些受"一比一"约束）。 */
export function docOriginKeys(): readonly string[] {
  return baselineKeys().filter((key) => baselineOrigin(key) === 'doc')
}
