/**
 * 系统事件的**调用钩子**（PLAN 阶段 8 交付物 4 的收尾）。
 *
 * ## 为什么要有这一层
 *
 * 事件源的机制早就好了（白名单、边沿检测、派发、幂等），
 * 但**没有任何东西会去 `observe()` 那 7 类事件** —— 机制在、名字在、测试在，
 * 而**触发它们的那一行代码不存在**。
 *
 * 这一层把"那一行"变成**一个词**：调用点只需要写
 * `hooks.endpointDown(name, error)`，不用记住事件名拼写、key 该传什么、
 * 状态字符串是 `down` 还是 `false`。
 *
 * ## 为什么每个钩子都返回结果而不是 void
 *
 * 调用点经常需要知道"这次到底有没有真的触发唤醒"（比如探测循环要决定
 * 要不要打日志、要不要改变自己的行为）。返回 void 的话，
 * 调用方只能自己再猜一遍 —— 而猜错就会写出"日志说触发了、其实去重了"这种事。
 *
 * ## 为什么每个钩子都吞异常
 *
 * 它们是**观察者**，不是业务链路的一部分。一次"上报端点挂了"的失败
 * 不该让探测循环本身崩掉（那样面板会永久停在旧值上，且没人知道）。
 *
 * @module @forlife/gateway/wake-system-hooks
 */
import type { SystemObserveOutcome, SystemWakeSource } from './wake-system-source.ts'

/**
 * ## 哪些事件**接不上**（结构性原因，不是没做）
 *
 * 九类事件里有三类没有调用点，因为**上游能力还不存在**或**通道不成立**：
 *
 * | 事件 | 为什么没有调用点 |
 * |---|---|
 * | `migration.failed` | 迁移失败时**库本身不可用**，而"标记触发器到点"要写这个库 —— **通道不成立**。上报必须走带外 |
 * | `contract.mismatch` | DSH 契约检查（`forlife doctor`）属于阶段 9/10 的交付物，**还没有那个功能** |
 * | `job.failed` | gateway 侧**还没有 job 系统**（DSH 的 `ctx.jobs` 在插件进程里）|
 *
 * 钩子先做好是有意义的（上游一就位就能接），但**不能假装已经接上了**。
 */
/** 一组调用钩子。 */
export interface SystemEventHooks {
  /** 推理端点不可用 / 恢复。 */
  readonly endpointUnavailable: (endpointName: string, ok: boolean, detail?: string) => SystemObserveOutcome | undefined
  /** 磁盘水位过高 / 回落。 */
  readonly diskHigh: (mountPath: string, high: boolean, detail?: string) => SystemObserveOutcome | undefined
  /** 一次迁移失败。 */
  readonly migrationFailed: (detail: string) => SystemObserveOutcome | undefined
  /** 一次记忆压缩事务失败。 */
  readonly compactionFailed: (detail: string) => SystemObserveOutcome | undefined
  /** DSH 契约不匹配。 */
  readonly contractMismatch: (detail: string) => SystemObserveOutcome | undefined
  /** 一个后台任务失败。 */
  readonly jobFailed: (jobName: string, detail?: string) => SystemObserveOutcome | undefined
  /** 预算超限。 */
  readonly budgetExceeded: (scope: string, detail?: string) => SystemObserveOutcome | undefined
}

/**
 * 造一组钩子。
 *
 * @param source - 事件源；**未启用时传 undefined**，此时所有钩子都返回 undefined
 *   （而不是假装触发成功）。
 */
export function createSystemEventHooks(options: {
  readonly source: SystemWakeSource | undefined
  readonly log?: (message: string) => void
}): SystemEventHooks {
  const source = options.source
  const log = options.log ?? ((): void => {})

  /** 统一包一层：吞异常 + 记日志。 */
  const fire = (what: string, fn: () => SystemObserveOutcome): SystemObserveOutcome | undefined => {
    if (source === undefined) return undefined
    try {
      const outcome = fn()
      if (outcome.triggered.length > 0) log(`${what} ⇒ 已触发 ${String(outcome.triggered.length)} 条唤醒`)
      return outcome
    } catch (error) {
      // **观察者不能带崩业务链路**
      log(`${what} 的上报失败（已忽略）：${String(error).slice(0, 160)}`)
      return undefined
    }
  }

  return {
    endpointUnavailable: (endpointName, ok, detail) =>
      fire(`端点「${endpointName}」${ok ? '恢复' : '不可用'}`, () =>
        source!.observe('endpoint.unavailable', endpointName, ok ? 'up' : 'down', detail),
      ),

    diskHigh: (mountPath, high, detail) =>
      fire(`磁盘 ${mountPath} ${high ? '水位过高' : '水位回落'}`, () =>
        source!.observe('disk.high', mountPath, high ? 'high' : 'ok', detail),
      ),

    migrationFailed: (detail) => fire('迁移失败', () => source!.observe('migration.failed', '', 'failed', detail)),

    compactionFailed: (detail) => fire('压缩事务失败', () => source!.observe('compaction.failed', '', 'failed', detail)),

    contractMismatch: (detail) => fire('契约不匹配', () => source!.observe('contract.mismatch', '', 'mismatch', detail)),

    jobFailed: (jobName, detail) => fire(`任务「${jobName}」失败`, () => source!.observe('job.failed', jobName, 'failed', detail)),

    budgetExceeded: (scope, detail) => fire(`预算超限（${scope}）`, () => source!.observe('budget.exceeded', scope, 'exceeded', detail)),
  }
}
