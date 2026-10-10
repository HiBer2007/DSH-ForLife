/**
 * 日志**分级制度**（用户 2026-10-10 指定）。
 *
 * ## 为什么单独一个模块
 *
 * 在这之前整个仓库的"级别"是**从文本里正则猜的**（`log-buffer.ts` 的 `guessLevel`），
 * 代码注释自己写着「我们没有结构化日志，这是务实的做法」。
 * 结果是：级别人人各按自己的理解写，面板也没法按模块筛。
 *
 * ⇒ 级别必须**显式**给，而"每一级到底什么该进"必须**只在一个地方定义**——
 * 否则 127 个调用点会各填各的（那正是"猜"换了个地方发生）。
 *
 * ## 七级的语义（**这条梯子的轴是"影响范围"，不是"严重感觉"**）
 *
 * | 级别 | 轴上的位置 | 什么该进 | 默认落盘 |
 * | :--- | :--- | :--- | :--- |
 * | `debug` | 过程 | 只在排障时才有意义的过程细节（每帧进出、判定的中间值）。**量大**，默认不落盘 | ❌ |
 * | `info`  | 事实 | 正常运转的事实：「启动了」「连上了」「搬了 200 条」 | ✅ |
 * | `note`  | 判断 | 值得留痕但**不构成异常**的判断：「这条没唤醒，因为预算不够」「这段判重跳过了」。<br>为什么它不是 `info`：事后回看时，你要找的是**判断**，不是"又跑了一轮" | ✅ |
 * | `warn`  | 一次操作 | 出了点问题，但**已经处理/已降级**：重试成功、回退到兜底、忽略了一次坏数据 | ✅ |
 * | `error` | 一次操作 | **一次操作失败了**，进程仍在正常工作（一次唤醒没派发出去、一次请求 500） | ✅ |
 * | `fault` | 一个子系统 | **一个子系统坏了**：进程还活着，但它的一部分功能不可用（QQ 链路掉了、Caddy 连不上、磁盘水位告警） | ✅ |
 * | `crash` | 整个进程 | **进程级失败**：正在崩溃或即将退出（未捕获异常、致命配置错误、收到信号后的收尾） | ✅ |
 *
 * ★ **`warn` / `error` / `fault` 的分界是"范围"不是"心情"**：
 *   - 一次操作出问题，**但兜住了** ⇒ `warn`
 *   - 一次操作出问题，**没兜住** ⇒ `error`
 *   - **一大片操作**都会出问题（子系统级）⇒ `fault`
 *   判据是"**影响了几件事**"，不是"看起来多吓人"。
 *
 * ## 默认策略（用户指定）
 *
 * **默认完整存储 `info` 及以上**（`debug` 不落盘），
 * 除非环境变量**明确关掉了某些等级**（见 {@link disabledLevelsFromEnv}）。
 *
 * @module @forlife/gateway/admin/log-levels
 */

/** 七级，**从低到高**（顺序即严重度，代码里不许再写第二份顺序）。 */
export const LOG_LEVELS = ['debug', 'info', 'note', 'warn', 'error', 'fault', 'crash'] as const

/** 日志级别。 */
export type LogLevel = (typeof LOG_LEVELS)[number]

/** 级别的序（用于"≥ 某一级就落盘"这类比较）。 */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze(
  Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index])) as Record<LogLevel, number>,
)

/** 落盘的默认下限 —— 用户指定：**默认完整存储 INFO 以上**。 */
export const DEFAULT_STORE_LEVEL: LogLevel = 'info'

/** 是不是一个合法级别（用于解析环境变量 / 外部输入）。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/**
 * `a` 是否**不低于** `b`（即"该不该被 `b` 这道门槛放行"）。
 *
 * 单独抽出来是为了让"比较"只有一处实现 —— 前端筛选、落盘过滤、面板显示
 * 三处若各写一遍 `indexOf` 比较，迟早会有一处把 `<` 写成 `<=`。
 */
export function atLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[threshold]
}

/**
 * 从环境变量解析"要**关掉**哪些等级"。
 *
 * 形态：`FORLIFE_LOG_DISABLE` = 逗号分隔的级别名，例如 `debug,note`。
 *  - 空 / 未设 ⇒ 关掉空集（即全按 {@link DEFAULT_STORE_LEVEL} 那道下限走）
 *  - 认不出的名字 ⇒ **跳过并在返回值里说明**，绝不静默当成合法级别
 *    （拼错一个级别名却毫无反应，是"日志没落盘"这类最难查的故障的经典成因）
 *
 * ⚠️ 它**只管"关"**，不管"开"：`FORLIFE_LOG_LEVEL`（下限）是另一件事。
 *    两者叠加的语义见 {@link shouldStore}。
 */
export function disabledLevelsFromEnv(raw: string | undefined): {
  readonly disabled: ReadonlySet<LogLevel>
  readonly unknown: readonly string[]
} {
  const disabled = new Set<LogLevel>()
  const unknown: string[] = []
  for (const piece of (raw ?? '').split(',')) {
    const name = piece.trim().toLowerCase()
    if (name === '') continue
    if (isLogLevel(name)) disabled.add(name)
    else unknown.push(name)
  }
  return { disabled, unknown }
}

/**
 * 这一条该不该**落盘**。
 *
 * 语义（用户指定）：**默认完整存储 `info` 及以上**；`debug` 不落盘。
 * 环境变量可以 ① 抬高/降低下限（`min`）② 点名关掉某些等级（`disabled`）。
 *
 * ★ `disabled` **能盖过下限** —— 那是"明确关掉"的意思（用户原话：
 *   「除非在环境变量中关闭了某些等级」）。否则"关掉"就只是句空话。
 * ★ 但 `crash` / `fault` **永远落盘**，除非被显式 `disabled`：
 *   一个进程崩了却没留下日志，是这套系统最不该出现的失败。
 */
export function shouldStore(
  level: LogLevel,
  options: { readonly min?: LogLevel; readonly disabled?: ReadonlySet<LogLevel> } = {},
): boolean {
  if (options.disabled?.has(level) === true) return false
  return atLeast(level, options.min ?? DEFAULT_STORE_LEVEL)
}
