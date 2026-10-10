/**
 * **插件侧的日志汇** —— 让 `dsh` 容器里的日志**能到面板上**（`FIX_PLAN.md` §26）。
 *
 * ## 为什么需要它
 *
 * 插件跑在 `dsh` 容器、七级日志库跑在 `gateway` 容器，**是两个进程**。
 * 而插件的两个日志入口都是 `console.log` ⇒
 * **记忆写入、沉降、投喂、判档、唤醒**（全在插件里发生）**在面板上一条都看不到**。
 *
 * ## 为什么是"写文件"而不是"发 HTTP"
 *
 * 两个容器**共享同一个卷**（实测：`forlife_dsh-home → /data/dsh`，
 * 在 `dsh` 里写探针、`gateway` 读得到）。
 * 而网关那边的 `logStore.read()` **本来就在读** `forlife-YYYY-MM-DD.jsonl`
 * ⇒ **不需要开端口、不需要新协议**，写进同一个文件即可。
 * （POSIX 的 `O_APPEND` 对小写入是原子的 ⇒ 两个进程同时追加是安全的。）
 *
 * ## 三条刻意的约束
 *
 * **① 格式必须与网关那边逐字段一致** —— 否则写进去也是"坏行"，被 `parseRecord` 丢掉：
 *
 * | 字段 | 要求 | 依据 |
 * | :--- | :--- | :--- |
 * | `level` | **必须是七级之一** | `log-store.ts:219` 的 `isLevelName` |
 * | `module` / `text` / `at` | **必须是字符串** | `log-store.ts:214` |
 * | 文件名 | `forlife-` + `at.toISOString().slice(0,10)` + `.jsonl` | `log-store.ts:57` |
 *
 * ★ 所以本文件的测试**不是**"写了就行"，而是**拿网关那边的读端去读回来**
 * —— 那才叫接上了。
 *
 * **② 出错只上报，绝不抛。** 日志是旁路：**它挂掉不该带走主流程**。
 * 磁盘满、目录只读、权限不对 —— 全都只走 `onError`。
 *
 * **③ 不缓存文件句柄。** 每次写入现算文件名 ⇒
 * 跨天时**自然换文件**，不需要任何"今天是不是新的一天"的判断
 * （那种判断最容易在跨零点时长轮次里出错）。
 *
 * @module @forlife/dsh-component/log-sink
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { redact, type LogLevel, type LogRecord } from '@forlife/gateway'

/** 与网关那边同一个前缀/后缀（`log-store.ts:44-45`）。 */
export const PLUGIN_LOG_PREFIX = 'forlife-'
export const PLUGIN_LOG_SUFFIX = '.jsonl'

/**
 * 一天一个文件，命名规则**与网关逐字一致**（`log-store.ts:57`）。
 *
 * ⚠️ 两边算出来必须是同一个名字 —— 否则插件写 `a`、网关读 `b`，
 * **两边都"正常"，而面板上永远是空的**（本仓最贵的那类问题）。
 */
export function pluginLogFileName(at: Date): string {
  return `${PLUGIN_LOG_PREFIX}${at.toISOString().slice(0, 10)}${PLUGIN_LOG_SUFFIX}`
}

/** 这个插件的日志走哪个模块名（面板按模块筛时用）。 */
export const PLUGIN_LOG_MODULE = 'dsh-plugin'

export interface PluginLogSinkOptions {
  /** 日志目录（应当与网关的 `resolveLogDir()` 算出来的是同一个）。 */
  readonly dir: string
  /** 取当前时间（便于测试）。 */
  readonly now?: () => Date
  /** 写失败时上报（**不要在这里抛**）。 */
  readonly onError?: (message: string) => void
}

export interface PluginLogSink {
  /** 追写一条（**任何失败都只上报，不抛**）。 */
  write(level: LogLevel, text: string, module?: string): void
  /** 这个汇指向哪个目录（排障用）。 */
  readonly dir: string
}

/**
 * 造一个插件日志汇。
 *
 * ⚠️ 目录**懒创建**（第一次写入时）而不是造汇时创建：
 * 造汇发生在插件启动路径上，而那时可能连数据卷都还没就绪；
 * 晚一点创建能让"启动时不写日志"这种常见情形**不产生副作用**。
 */
export function createPluginLogSink(options: PluginLogSinkOptions): PluginLogSink {
  const now = options.now ?? ((): Date => new Date())
  const onError = options.onError ?? ((): void => {})
  let dirReady = false

  return {
    dir: options.dir,
    write(level: LogLevel, text: string, module: string = PLUGIN_LOG_MODULE): void {
      try {
        if (!dirReady) {
          mkdirSync(options.dir, { recursive: true })
          dirReady = true
        }
        const at = now()
        // ★★ **必须脱敏**（2026-10-10 补）。网关那边的汇聚点一直有脱敏
        //   （`server.ts:176` / `:193`），而这条插件路径写的是**同一个文件**
        //   —— 不脱敏就是**在同一个文件里绕过那道保护**。
        //   而插件的日志比网关的更容易带敏感内容（记忆正文、唤醒载荷、投喂素材）。
        const record: LogRecord = { level, module, text: redact(text), at: at.toISOString() }
        // ★ 一次 `appendFileSync` = 一次 `O_APPEND` 写 ⇒ 与网关进程并发也安全
        appendFileSync(join(options.dir, pluginLogFileName(at)), `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error: unknown) {
        // ★ **绝不抛**：日志是旁路，它挂掉不该带走主流程
        onError(`插件日志写失败（已忽略）：${String(error).slice(0, 160)}`)
      }
    },
  }
}
