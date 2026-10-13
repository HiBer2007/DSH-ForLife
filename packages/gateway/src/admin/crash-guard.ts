/**
 * **进程级失败的守卫** —— 让 `crash` 那一级真的会有内容（用户 2026-10-10 指定七级时，
 * 这一级此前**永远是空的**）。
 *
 * ## 为什么要有它（这不是"加个保险"，是一个实测到的缺口）
 *
 * 2026-10-10 全仓搜 `uncaughtException` / `unhandledRejection`：
 * **`packages/` 下一个都没有**（只有测试文件里用过 `process.on('exit')`）。
 *
 * ⇒ 后果有两条，第二条更严重：
 *  1. 我按用户要求定义的 `crash` 级别**永远发不出来** —— 面板上那一档恒为 0，
 *     而"恒为 0"会被读成"没崩过"，**那是最危险的误读**。
 *  2. 崩溃时**一行日志都没有**。Node 默认会把堆栈打到 stderr，但那不进我们的
 *     缓冲与落盘 ⇒ 面板上看不到、事后也翻不到。
 *
 * ## ★★ 两条不许违反的纪律
 *
 * **① 记完必须死，绝不吞掉。**
 *   `uncaughtException` 一旦装了处理器，Node 的默认行为（打印 + 退出）**就被关掉了**。
 *   所以"只记不退"会让进程**带着未知状态继续跑** —— 那比直接崩危险得多
 *   （它可能继续写记忆、继续发消息，而内部状态已经坏了）。
 *
 * **② 崩溃那一条必须真的落盘。**
 *   这依赖 `log-store.ts` 的写是**同步**的 —— 异步写会让最后几条留在缓冲区里，
 *   而**最后几条恰恰是崩溃现场**。这条纪律在那边是当"日志量不高"的取舍写的，
 *   到这里变成了"崩溃现场还在不在"的分界。
 *
 * ## 为什么从 `main()` 装，而不是从 `createAdminServer().start()`
 *
 * `start()` 会被测试反复调用 ⇒ 处理器会**叠一堆**（每次崩溃打 N 条，
 * 而且第一个处理器退出之后后面的可能来不及跑）。而且测试里触发一次未处理的拒绝
 * 会把整个测试进程带走。**入口装一次**才对。
 *
 * @module @forlife/gateway/admin/crash-guard
 */
import { createLogger } from './log.ts'

/** 装过就不再装（幂等）。 */
let installed = false

/** 排障用：当前装没装。 */
export function crashGuardInstalled(): boolean {
  return installed
}

/** 建一个崩溃处理器（**纯函数式**：不碰 `process`，便于直接测）。 */
export interface CrashHandlerDeps {
  readonly log: { readonly crash: (message: string) => void }
  /** 记完之后干什么。**必须真的结束进程**（缺省实现见 {@link installCrashGuard}）。 */
  readonly onFatal: (code: number) => void
}

/**
 * 造一个"记完就死"的处理器。
 *
 * ★ 为什么把它单独导出：本仓测试用 `--experimental-test-isolation=none`，
 *   而 **`node:test` 自己就装了 `uncaughtException` 监听器** ——
 *   在测试里 `process.emit('uncaughtException', …)` 会**被判成测试失败**
 *   （实测：探针错误直接出现在失败输出里）。
 *   ⇒ 处理器做成可直接调用的函数，测试调它；"有没有挂到 `process.on` 上"
 *     由**接线守卫**（读源码）钉住。
 */
export function makeCrashHandler(
  deps: CrashHandlerDeps,
): (reason: unknown, kind: 'uncaughtException' | 'unhandledRejection') => void {
  return (reason, kind) => {
    // 兜底：连记日志都失败也必须死（见模块头纪律 ①）
    try {
      deps.log.crash(kind === 'uncaughtException' ? describeUncaught(reason) : describeRejection(reason))
    } catch {
      // 故意吞掉：下面照样退出
    }
    deps.onFatal(1)
  }
}

/**
 * 装上进程级守卫。**幂等** —— 重复调用只生效一次。
 *
 * @param onFatal - 记完之后干什么（缺省 `process.exit(1)`）。
 *   测试要验证"记了没有"时可以传一个不真退出的实现。
 * @returns 装上了返回 `true`；已经装过返回 `false`（调用方可据此不重复报日志）。
 */
export function installCrashGuard(onFatal: (code: number) => void = (code) => process.exit(code)): boolean {
  if (installed) return false
  installed = true
  const handler = makeCrashHandler({ log: createLogger('crash-guard'), onFatal })

  process.on('uncaughtException', (error: unknown) => {
    handler(error, 'uncaughtException')
  })
  process.on('unhandledRejection', (reason: unknown) => {
    handler(reason, 'unhandledRejection')
  })

  return true
}

/** 未捕获异常那一句话（**带堆栈** —— 那是崩溃现场，不许丢）。 */
function describeUncaught(error: unknown): string {
  return (
    '未捕获异常 —— 进程即将退出。这是**进程级失败**（整个进程要没了），' +
    `不是某一次操作出错：\n${describe(error)}`
  )
}

/** 未处理的拒绝那一句话。 */
function describeRejection(reason: unknown): string {
  return (
    '未处理的 Promise 拒绝 —— 进程即将退出（Node 15 起这是**致命**的，' +
    `不是警告）：\n${describe(reason)}`
  )
}

/** 把一个 unknown 摊成"带堆栈的一行"（堆栈是崩溃现场，**不许丢**）。 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' && error.stack !== '' ? error.stack : error.message
    return `${error.name}: ${stack}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
