/**
 * 系统监视循环：磁盘水位 → `system` 触发（PLAN 阶段 8 交付物 4 的调用点之一）。
 *
 * ## 为什么磁盘要**持续看**而不是只在写入失败时上报
 *
 * 写入失败时才发现盘满，**已经晚了** —— 那一次写入已经丢了，
 * 而且模型可能正在压缩记忆（压缩失败会丢数据）。
 * 持续看水位能在"快满"时就叫醒模型，让它自己清理。
 *
 * ## 阈值为什么不能只看"满没满"
 *
 * 用 `>= 1.0` 的话永远来不及（真满了就没法写）。所以按**比例**判，
 * 默认 90%。这个值可配 —— 小盘（几 GB）和大盘（几 TB）留同样比例的余量
 * 意义完全不同，而只有用户知道自己需要多少。
 *
 * ## 为什么用**边沿**而不是"每次超阈值都报"
 *
 * 盘满了之后**每一次检查都会超阈值**。每次都报的话，
 * 一分钟一次就是 1440 次唤醒/天 —— 而那期间水位并没有变化。
 * 事件源的边沿检测已经处理了这件事（同一 key 同一状态只发一次），
 * 这里只需要**如实把当前状态报上去**。
 *
 * @module @forlife/gateway/wake-system-monitor
 */
import { statfsSync } from 'node:fs'

import type { SystemEventHooks } from './wake-system-hooks.ts'
import { atLevel } from './admin/log.ts'

/** 磁盘检查结果。 */
export interface DiskCheck {
  /** 已用比例（0–1）；取不到时为 undefined。 */
  readonly usedRatio: number | undefined
  /** 是否超阈值。 */
  readonly high: boolean
  /** 人话说明（进 payload 与日志）。 */
  readonly detail: string
}

/**
 * 查一个挂载点的使用率。
 *
 * **取不到不算"健康"** —— 那会让人以为一切正常。取不到时 `high` 保持 false
 * （不该因为"查不到"就去唤醒模型），但 `detail` 要说清"没查到"，
 * 面板与日志里能看出来。
 */
export function checkDisk(mountPath: string, thresholdRatio: number): DiskCheck {
  try {
    const stats = statfsSync(mountPath)
    // 有些文件系统 bavail 会是 0 或异常值 —— 用总块数兜底
    const total = stats.blocks
    const free = stats.bavail
    if (total <= 0) {
      return { usedRatio: undefined, high: false, detail: `${mountPath}：拿不到总容量（blocks=0）` }
    }
    const usedRatio = 1 - free / total
    const percent = Math.round(usedRatio * 100)
    const thresholdPercent = Math.round(thresholdRatio * 100)
    return {
      usedRatio,
      high: usedRatio >= thresholdRatio,
      detail: `${mountPath}：已用 ${String(percent)}%（阈值 ${String(thresholdPercent)}%）`,
    }
  } catch (error) {
    // 查不到 ≠ 健康：说清是"没查到"，而不是假装一切正常
    return { usedRatio: undefined, high: false, detail: `${mountPath}：查不到使用率（${String(error).slice(0, 120)}）` }
  }
}

/** 监视循环的配置。 */
export interface SystemMonitorOptions {
  readonly hooks: SystemEventHooks
  /** 要盯的挂载点（默认一个）。 */
  readonly mounts?: readonly string[]
  /** 阈值比例（默认 0.9）。 */
  readonly thresholdRatio?: number
  readonly intervalMs?: number
  readonly log?: (message: string) => void
  /** 便于测试注入。 */
  readonly checkDiskImpl?: (mountPath: string, thresholdRatio: number) => DiskCheck
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
}

/** 监视循环。 */
export interface SystemMonitor {
  /** 跑一次检查（测试直接调它）。 */
  readonly tick: () => readonly DiskCheck[]
  readonly stop: () => void
}

/** 启动系统监视循环。 */
export function startSystemMonitor(options: SystemMonitorOptions): SystemMonitor {
  const mounts = options.mounts ?? []
  const threshold = options.thresholdRatio ?? 0.9
  const intervalMs = Math.max(30_000, options.intervalMs ?? 5 * 60_000)
  const log = options.log ?? ((): void => {})
  const check = options.checkDiskImpl ?? checkDisk
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))

  const tick = (): readonly DiskCheck[] => {
    const results: DiskCheck[] = []
    for (const mount of mounts) {
      const result = check(mount, threshold)
      results.push(result)
      // **如实上报当前状态** —— 去重是事件源的事（边沿检测），
      // 这里每次都报，让事件源决定要不要发
      try {
        options.hooks.diskHigh(mount, result.high, result.detail)
      } catch (error) {
        log(`磁盘水位上报失败（已忽略）：${String(error).slice(0, 160)}`)
      }
    }
    return results
  }

  if (mounts.length === 0) {
    // 没配挂载点 ⇒ **不启动循环**（而不是空转）。与端口出口同一纪律。
    log('系统监视未启用：没有配置要盯的挂载点')
    return { tick, stop: () => {} }
  }

  const handle = setIntervalFn(() => {
    try {
      for (const r of tick()) {
        if (r.high) log(`磁盘水位告警：${r.detail}`)
      }
    } catch (error) {
      // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环
      atLevel(log, 'fault')(`系统监视 tick 异常：${String(error).slice(0, 200)}`)
    }
  }, intervalMs)
  handle.unref?.()
  log(`系统监视已启用：盯 ${mounts.join('、')}，阈值 ${String(Math.round(threshold * 100))}%，tick ${String(intervalMs)}ms`)

  return { tick, stop: () => clearIntervalFn(handle) }
}

/** 从环境变量读监视配置。 */
export function monitorConfigFromEnv(env: Record<string, string | undefined>): {
  readonly mounts: readonly string[]
  readonly thresholdRatio: number
  readonly intervalMs: number
} {
  const raw = env['FORLIFE_DISK_MOUNTS']
  const mounts = raw === undefined || raw.trim() === '' ? [] : raw.split(',').map((m) => m.trim()).filter((m) => m !== '')
  const ratio = Number(env['FORLIFE_DISK_THRESHOLD'] ?? '0.9')
  const interval = Number(env['FORLIFE_DISK_CHECK_MS'] ?? '300000')
  return {
    mounts,
    thresholdRatio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.9,
    intervalMs: Number.isFinite(interval) && interval >= 30_000 ? interval : 300_000,
  }
}
