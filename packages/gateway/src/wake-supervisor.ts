/**
 * 监视程序监督器的**策略部分**（PLAN 阶段 8 交付物 3）。
 *
 * 进程的生老病死由 supervisor 那一层做（spawn/kill），而**"什么时候该重启、
 * 什么时候该放弃"是纯逻辑** —— 把它抽出来单独测，因为 bug 都藏在这里：
 * 退避算错会让崩溃的程序被疯狂重启（把机器打满），
 * 而限额判错会让一个吃内存的程序一直跑下去。
 *
 * ## 三种契约的区别（决定了"退出"意味着什么）
 *
 * | 契约 | 它是什么 | 退出了意味着 |
 * |---|---|---|
 * | `probe` | **跑一次就退**的检查（如"文件在不在"） | 正常结束 —— **不该重启** |
 * | `watcher` | 常驻，**输出一行 = 触发一次** | 异常 —— 该重启 |
 * | `service` | 常驻服务，**活着就是在工作** | 异常 —— 该重启 |
 *
 * 把 `probe` 也当成"该重启"是最容易犯的错：那样每次检查都会重启一遍，
 * 而 probe 本来就是**跑完就退**的 —— 表现为"监视程序日志里全是重启记录"。
 *
 * ## 退避为什么必须有上限
 *
 * 一个启动就崩的程序（比如依赖没装）会以极快速度重启。
 * 没有上限的话它会一直重试，把 CPU 和日志打满；有上限（+ 次数上限）之后
 * 它会被**自动停用并告警** —— 那才是用户能看见、能处理的状态。
 *
 * @module @forlife/gateway/wake-supervisor
 */

/** 契约类型。 */
export type ProgramContract = 'probe' | 'watcher' | 'service'

/** 程序状态。 */
export type ProgramStatus = 'stopped' | 'running' | 'failed' | 'disabled'

/** 资源限额。 */
export interface ProgramLimits {
  /** 单次运行最长时长（毫秒）；0 = 不限。 */
  readonly maxRuntimeMs: number
  /** 输出上限（字节）；超过就截断并视为超限。0 = 不限。 */
  readonly maxOutputBytes: number
  /** 最大连续重启次数；超过就自动停用。0 = 不限（不建议）。 */
  readonly maxRestarts: number
  /** 退避基数（毫秒）。 */
  readonly backoffBaseMs: number
  /** 退避上限（毫秒）。 */
  readonly backoffMaxMs: number
}

/** 默认限额。 */
export const DEFAULT_LIMITS: ProgramLimits = {
  // 10 分钟：够跑一次慢检查，又不至于让一个卡死的程序占着不放
  maxRuntimeMs: 600_000,
  // 64 KiB：够输出很多行触发，又不至于把内存吃光
  maxOutputBytes: 64 * 1024,
  // 5 次：连续崩 5 次基本可以确定是代码/依赖问题，再重启也没用
  maxRestarts: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 5 * 60_000,
}

/**
 * 算下一次重启前要等多久（指数退避 + 上限）。
 *
 * @param attempt - 第几次重启（**从 1 开始**）。
 */
export function computeBackoff(attempt: number, limits: ProgramLimits = DEFAULT_LIMITS): number {
  if (attempt <= 0) return 0
  const raw = limits.backoffBaseMs * 2 ** (attempt - 1)
  // 用 Math.min 夹住上限：不夹的话 attempt 到 20 时会是 1000 * 2^19 ≈ 6 天，
  // 而"等 6 天再重启"实际上等于永不重启 —— 那不是退避，是静默放弃。
  return Math.min(raw, limits.backoffMaxMs)
}

/** 一次运行的观察结果。 */
export interface RunObservation {
  /** 是否正常退出（退出码 0）。 */
  readonly exitOk: boolean
  /** 跑了多久（毫秒）。 */
  readonly durationMs: number
  /** 输出了多少字节。 */
  readonly outputBytes: number
}

/** 限额判定结果。 */
export interface LimitVerdict {
  readonly exceeded: boolean
  readonly reason: string
}

/** 判一次运行有没有超限。 */
export function checkLimits(observed: RunObservation, limits: ProgramLimits = DEFAULT_LIMITS): LimitVerdict {
  // 超时与超输出都算"超限"，但它们的原因要分开 ——
  // "跑太久"与"输出太多"要采取的措施完全不同（前者优化逻辑，后者加过滤）
  if (limits.maxRuntimeMs > 0 && observed.durationMs > limits.maxRuntimeMs) {
    return { exceeded: true, reason: `运行超时（${String(Math.round(observed.durationMs / 1000))} 秒 > ${String(Math.round(limits.maxRuntimeMs / 1000))} 秒）` }
  }
  if (limits.maxOutputBytes > 0 && observed.outputBytes > limits.maxOutputBytes) {
    return { exceeded: true, reason: `输出超限（${String(observed.outputBytes)} 字节 > ${String(limits.maxOutputBytes)}）` }
  }
  return { exceeded: false, reason: '在限额内' }
}

/** 一次"退出后该怎么办"的判定输入。 */
export interface ExitDecisionInput {
  readonly contract: ProgramContract
  readonly observation: RunObservation
  /** 已经连续重启过几次。 */
  readonly restartCount: number
  readonly limits: ProgramLimits
  /** 用户按了 kill 开关。 */
  readonly killed: boolean
}

/** 判定结果。 */
export interface ExitDecision {
  readonly action: 'stop' | 'restart' | 'disable'
  readonly reason: string
  /** `restart` 时，要等多久。 */
  readonly waitMs: number
}

/**
 * 判"程序退出后该怎么办"。
 *
 * **顺序有讲究**：先看 kill 开关（用户意图优先），再看契约
 * （probe 正常退出本来就该停），最后才看限额与重启次数。
 */
export function decideAfterExit(input: ExitDecisionInput): ExitDecision {
  // ① 用户按了 kill —— 最高优先级，不再重启
  if (input.killed) {
    return { action: 'stop', reason: '用户已停止（kill 开关）', waitMs: 0 }
  }

  const verdict = checkLimits(input.observation, input.limits)
  if (verdict.exceeded) {
    // 超限视为"这次运行失败"，走下面的重启逻辑（但原因要带上）
    return decideRestart(input, verdict.reason)
  }

  if (input.observation.exitOk) {
    // ② 正常退出：
    //    - probe **本来就该退** ⇒ 停（不该重启）
    //    - watcher / service 正常退出是**异常**（它们本该常驻）⇒ 重启
    if (input.contract === 'probe') {
      return { action: 'stop', reason: 'probe 正常结束（它本来就是跑一次就退）', waitMs: 0 }
    }
    return decideRestart(input, `${input.contract} 不该自己退出（正常退出码）`)
  }

  return decideRestart(input, `异常退出（退出码非 0）`)
}

/** 重启 or 停用的公共逻辑。 */
function decideRestart(input: ExitDecisionInput, cause: string): ExitDecision {
  const attempt = input.restartCount + 1
  if (input.limits.maxRestarts > 0 && attempt > input.limits.maxRestarts) {
    // **自动停用并告警** —— 这是验收明确要求的
    return {
      action: 'disable',
      reason: `${cause}；已连续重启 ${String(input.restartCount)} 次，超过上限 ${String(input.limits.maxRestarts)} ⇒ 自动停用`,
      waitMs: 0,
    }
  }
  const waitMs = computeBackoff(attempt, input.limits)
  return { action: 'restart', reason: `${cause}；第 ${String(attempt)} 次重启，等 ${String(Math.round(waitMs / 1000))} 秒`, waitMs }
}

/** 脚本变更检查的结果。 */
export interface ScriptCheck {
  readonly changed: boolean
  readonly reason: string
}

/**
 * 检查脚本有没有被改过。
 *
 * PLAN 明确要求「**脚本变更需重新登记**」。为什么不能自动接受变更：
 *  - 登记时用户（或模型）看过并认可的是**那一版**；
 *  - 改过之后行为可能完全不同（一个"检查文件是否存在"的脚本被改成"删除文件"），
 *    而监督器**无从判断**。
 *
 * 所以变更后**停用并要求重新登记** —— 而不是继续跑一个没人审过的新版本。
 */
export function checkScriptUnchanged(registeredSha256: string, actualSha256: string): ScriptCheck {
  if (registeredSha256.trim() === '') {
    // 空指纹说明登记时就没记 —— 那是登记流程的问题，不能当"没变"
    return { changed: true, reason: '登记时没有记录脚本指纹，无法确认它没被改过 ⇒ 需重新登记' }
  }
  if (registeredSha256 !== actualSha256) {
    return { changed: true, reason: `脚本已变更（登记 ${registeredSha256.slice(0, 12)}… → 实际 ${actualSha256.slice(0, 12)}…）⇒ 需重新登记` }
  }
  return { changed: false, reason: '脚本未变更' }
}

/** 状态转移是否合法（防止把 disabled 直接跑起来之类）。 */
export function canTransition(from: ProgramStatus, to: ProgramStatus): boolean {
  if (from === to) return true
  // disabled 只能由**用户显式启用**回到 stopped —— 自动重启不许碰它，
  // 否则"自动停用"会被下一次重启悄悄推翻，而用户永远看不到它停过
  if (from === 'disabled') return false
  return true
}
