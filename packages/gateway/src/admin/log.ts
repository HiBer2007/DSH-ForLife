/**
 * 结构化日志的**模块 logger 工厂**。
 *
 * ## 为什么是工厂，而不是把 `log(level, module, message)` 塞进 127 个调用点
 *
 * 实测：仅 `gateway/src` 就有 **127 处 `log(...)`**。让每一处都改成
 * `log(level, module, message)` 意味着 127 次机械改动 **+ 127 次"这算 NOTE 还是 INFO"的判断**
 * —— 那是把"猜级别"从运行时搬到了改代码时，一样会各填各的。
 *
 * ⇒ 改成：**每个文件改两行**（换 import + 起一个模块 logger），
 * 调用点**文本几乎不动**：
 *
 * ```ts
 * const log = createLogger('wake-liveness')   // ← 模块在这里，一次
 * log.info(`QQ 存活状态恢复：${verdict.reason}`)
 * log.warn('...')  log.note('...')  log.fault('...')
 * ```
 *
 * ## ★ 旧签名仍然能用
 *
 * `log('一句话')` 依然合法 —— 它按 `info` 处理。**这让 127 处可以分批迁移**，
 * 而不是"不改完就编译不过"。未迁移的地方不会退化成"没有级别"，只是级别不够准。
 * ⚠️ 但**不许**因此长期不迁移：`log('...')` 一律当 `info`，
 * 而真正的 `fault`/`crash` 若写成裸字符串，面板就永远筛不出来。
 *
 * ## 谁负责脱敏
 *
 * **不是这里。** 脱敏在日志的**唯一汇聚点**（`server.ts` 的 `log`）做 ——
 * 那里是"写入侧"，两条出口都能覆盖。在这里再做一遍会给人"已经安全了"的错觉，
 * 而真正的泄露早就发生了（`log-buffer.ts` 里那条判断就是这么写的）。
 *
 * @module @forlife/gateway/admin/log
 */
import { type LogLevel } from './log-levels.ts'

/** 一条**结构化**日志。 */
export interface LogRecord {
  readonly level: LogLevel
  /** 模块名（`wake-liveness` / `onebot` / `settle-loop` …）。面板按它筛。 */
  readonly module: string
  readonly text: string
  /** ISO 时间戳。 */
  readonly at: string
}

/** 落点：拿到一条结构化日志，决定它去哪（内存缓冲 / 落盘 / stdout）。 */
export type LogSink = (record: LogRecord) => void

/** 一个模块的 logger。 */
export interface Logger {
  /**
   * 旧签名（**兼容**）：等价于 `info`。
   *
   * 保留它是为了让 127 处能分批迁移；但新写的、以及"其实是判断/故障"的地方，
   * 请显式用下面那七个方法。
   */
  (message: string): void
  debug(message: string): void
  info(message: string): void
  /** 值得留痕的**判断**（"没唤醒，因为预算不够"）—— 不是警告，见 `log-levels.ts` 的表。 */
  note(message: string): void
  warn(message: string): void
  error(message: string): void
  /** **一个子系统坏了**（进程还活着，但一部分功能不可用）。 */
  fault(message: string): void
  /** **进程级失败**（正在崩溃/即将退出）。 */
  crash(message: string): void
  readonly module: string
}

/**
 * 已安装的落点。**是集合（扇出），不是单个**。
 *
 * ## ★ 为什么改成扇出（2026-10-10，被测试逼出来的）
 *
 * 第一版是"只允许一个落点"，理由写的是"多个落点意味着日志去哪要看安装顺序"。
 * **那个理由不成立，而且它制造了一个更坏的故障**：
 *
 * 本仓的测试用 `--experimental-test-isolation=none` **共用一个进程** ⇒
 * 一个测试里 `createAdminServer()` 装上落点之后，**另一个测试装的落点被顶掉**
 * （或者反过来）。实测就是这么红的：模块 logger 的测试收不到自己的记录。
 *
 * ⇒ 真正的性质是"**日志不许丢**"，而不是"落点只许有一个"。
 *   扇出的语义是确定的（**所有活着的落点都收到**，与安装顺序无关），
 *   而"后装的顶掉先装的"会**悄悄让一个落点再也收不到东西**。
 */
const sinks = new Set<LogSink>()

/**
 * 安装落点。返回**卸载函数**（只摘掉自己那一个）。
 *
 * 需要扇出（内存缓冲 + 落盘 + stdout）时，各装一个即可 —— 不必在一个落点里手写扇出。
 */
export function installLogSink(next: LogSink): () => void {
  sinks.add(next)
  return () => {
    sinks.delete(next)
  }
}

/** 当前落点（测试用；也是"有没有装"的唯一判据）。扇出时返回**第一个**。 */
export function currentLogSink(): LogSink | undefined {
  return sinks.values().next().value
}

/** 当前落点个数（排障用：**泄漏的落点会在这里显形**）。 */
export function logSinkCount(): number {
  return sinks.size
}

/**
 * 建一个模块 logger。
 *
 * ★ **没装落点时的兜底是写 stdout，不是丢弃。**
 *   日志系统的失败必须朝"多说话"的方向倒 —— 悄悄丢掉比刷屏严重得多。
 *   （这条不是理论：本仓的「沉降循环完全沉默」就是"有话说却不说"造成的，
 *     整整一天没人知道它在空转。）
 */
export function createLogger(module: string): Logger {
  const emit = (level: LogLevel, message: string): void => {
    const record: LogRecord = { level, module, text: message, at: new Date().toISOString() }
    if (sinks.size === 0) {
      // 兜底：没有落点也要留下痕迹。走 stderr —— stdout 可能被当成协议通道。
      process.stderr.write(`[${level}] [${module}] ${message}\n`)
      return
    }
    for (const sink of sinks) {
      try {
        sink(record)
      } catch (error: unknown) {
        // ★ 落点抛错**不许**反向杀死调用方，也**不许**影响别的落点：
        //   一次日志写失败不该让业务崩掉，更不该让另一个落点也收不到。
        process.stderr.write(`[forlife] 日志落点抛错（已忽略）：${String(error)}\n`)
      }
    }
  }

  const logger = ((message: string): void => {
    emit('info', message)
  }) as Logger & { module: string }

  // 用 `Object.assign` 一个个挂上去，而不是定义一个对象再 cast：
  // 这样"少挂了一个方法"会在类型层面立刻报出来。
  Object.assign(
    logger,
    {
      debug: (message: string) => {
        emit('debug', message)
      },
      info: (message: string) => {
        emit('info', message)
      },
      note: (message: string) => {
        emit('note', message)
      },
      warn: (message: string) => {
        emit('warn', message)
      },
      error: (message: string) => {
        emit('error', message)
      },
      fault: (message: string) => {
        emit('fault', message)
      },
      crash: (message: string) => {
        emit('crash', message)
      },
    },
    { module },
  )

  return logger
}
