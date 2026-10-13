/**
 * `watcher` 触发器的事件源（PLAN 阶段 8 交付物 1 的第三类）。
 *
 * ## 两类监视，刻意分开
 *
 * | 类型 | 谁在盯 | 适合什么 |
 * |---|---|---|
 * | **条件轮询**（本模块） | gateway 自己定时检查 | **简单条件**：文件在不在、内容变没变、端口通不通 |
 * | **监视程序**（监督器） | 模型写的常驻脚本 | **复杂逻辑**：解析日志、调接口、多步判断 |
 *
 * 分开的理由：让模型为"文件出现了吗"写一个常驻脚本，既慢（要起进程）
 * 又容易被限额杀掉；而让 gateway 去解析日志又是不可能的（它不懂业务）。
 * **简单条件内置，复杂逻辑外挂** —— 这是唯一说得通的分工。
 *
 * ## 为什么也要边沿检测
 *
 * "文件存在"这个条件在文件存在期间**每一次轮询都为真**。
 * 不去重的话，一个文件放在那里 10 分钟会触发 600 次（1 秒一次）。
 * 所以与系统事件同一套规则：**只在状态变化时触发**。
 *
 * 但有一个**刻意的例外**：`file.changed` 比的是**内容指纹**，
 * 所以"内容又变了"本身就是一次新的变化（哪怕之前也变过）——
 * 这与 `file.exists` 的"一直为真"不同，不能混为一谈。
 *
 * @module @forlife/gateway/wake-watch-source
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { listWakeTriggers, updateWakeTrigger } from '@forlife/store'

import { resolveInWorkspace } from './workspace.ts'

/** 支持的监视条件。 */
export type WatchCondition = 'file.exists' | 'file.changed' | 'file.absent'

/** 一条监视规格。 */
export interface WatchSpec {
  readonly condition: WatchCondition
  /** 工作区内的相对路径。 */
  readonly path: string
}

/** 解析 spec。 */
export function parseWatchSpec(spec: string): WatchSpec | undefined {
  try {
    const parsed = JSON.parse(spec) as { condition?: unknown; path?: unknown }
    const condition = parsed.condition
    const path = parsed.path
    if (condition !== 'file.exists' && condition !== 'file.changed' && condition !== 'file.absent') return undefined
    if (typeof path !== 'string' || path.trim() === '') return undefined
    return { condition, path }
  } catch {
    return undefined
  }
}

/** 一次条件求值的结果。 */
export interface ConditionState {
  /** 条件当前是否成立。 */
  readonly met: boolean
  /** 用于去重的"状态指纹"（`file.changed` 用内容哈希，其余用 met）。 */
  readonly fingerprint: string
  /** 人话说明（进 payload 与日志）。 */
  readonly detail: string
}

/**
 * 求值一个条件。
 *
 * **路径一律走工作区沙箱** —— 监视脚本能读的文件范围必须与它被允许写的范围一致，
 * 否则"读"就成了绕过沙箱的口子（读 `/etc/passwd` 再唤醒模型）。
 */
export function evaluateCondition(spec: WatchSpec, workspaceRoot: string): ConditionState {
  const resolved = resolveInWorkspace(workspaceRoot, spec.path)
  if (!resolved.ok) {
    // 越界不是"条件不成立"，而是**配置有问题** —— 要能区分，否则用户
    // 只会看到"它一直没触发"，而真正的原因是路径写错了
    return { met: false, fingerprint: `invalid:${resolved.reason}`, detail: `路径不合法：${resolved.reason}` }
  }

  const exists = existsSync(resolved.absolutePath)
  if (spec.condition === 'file.absent') {
    return { met: !exists, fingerprint: String(!exists), detail: exists ? '文件仍存在' : '文件已不存在' }
  }
  if (!exists) {
    return { met: false, fingerprint: 'missing', detail: '文件不存在' }
  }

  if (spec.condition === 'file.exists') {
    return { met: true, fingerprint: 'exists', detail: '文件存在' }
  }

  // file.changed：用**内容哈希**当指纹 ——
  // 用 mtime 的话，"内容变了但 mtime 没变"（同一秒内写入、或工具保留了时间戳）
  // 会被漏掉，而"mtime 变了但内容没变"（touch 一下）会被误报。
  try {
    const bytes = readFileSync(resolved.absolutePath)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const size = statSync(resolved.absolutePath).size
    return { met: true, fingerprint: hash, detail: `内容指纹 ${hash}（${String(size)} 字节）` }
  } catch (error) {
    return { met: false, fingerprint: 'unreadable', detail: `读不到文件：${String(error).slice(0, 100)}` }
  }
}

/** 一次轮询的结果。 */
export interface WatchTickOutcome {
  readonly triggerId: string
  readonly title: string
  readonly triggered: boolean
  readonly detail: string
}

/** 监视事件源。 */
export interface WatchSource {
  /** 跑一次轮询（测试直接调它）。 */
  readonly tick: () => readonly WatchTickOutcome[]
  /** 已记录的状态指纹（排障用）。 */
  readonly fingerprints: () => ReadonlyMap<string, string>
}

/** 造一个监视事件源。 */
export function createWatchSource(options: {
  readonly db: DatabaseSync
  readonly workspaceRoot: string
  readonly log?: (message: string) => void
  readonly now?: () => Date
}): WatchSource {
  const { db, workspaceRoot } = options
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): Date => new Date())
  /** 上一次观察到的指纹（内存缓存，重启后重新观察一遍即可）。 */
  const seen = new Map<string, string>()

  const tick = (): readonly WatchTickOutcome[] => {
    const outcomes: WatchTickOutcome[] = []
    const at = now()

    for (const row of listWakeTriggers(db)) {
      if (row.kind !== 'watcher' || row.enabled !== 1) continue
      const spec = parseWatchSpec(row.spec)
      if (spec === undefined) continue

      const state = evaluateCondition(spec, workspaceRoot)
      const previous = seen.get(row.id)
      seen.set(row.id, state.fingerprint)

      // 第一次观察只**记状态**、不触发 —— 否则"文件本来就在那里"会在
      // 服务启动的瞬间触发一次，而那不是"变化"
      if (previous === undefined) {
        outcomes.push({ triggerId: row.id, title: row.title, triggered: false, detail: `首次观察：${state.detail}` })
        continue
      }
      if (previous === state.fingerprint) {
        outcomes.push({ triggerId: row.id, title: row.title, triggered: false, detail: `未变化：${state.detail}` })
        continue
      }

      // 条件成立才触发；"从成立变成不成立"只记状态（那是恢复，不是事件）
      if (!state.met) {
        outcomes.push({ triggerId: row.id, title: row.title, triggered: false, detail: `条件不再成立：${state.detail}` })
        continue
      }

      if (row.scope === '*' || row.scope.trim() === '') {
        outcomes.push({ triggerId: row.id, title: row.title, triggered: false, detail: '没有绑定会话（scope=*）' })
        continue
      }

      // **数据库即通道**：设成"现在"⇒ 引擎下一次 tick 扫到
      updateWakeTrigger(db, row.id, { nextFireAt: at.toISOString() }, at)
      log(`监视触发「${row.title}」：${state.detail}`)
      outcomes.push({ triggerId: row.id, title: row.title, triggered: true, detail: state.detail })
    }

    return outcomes
  }

  return { tick, fingerprints: () => seen }
}
