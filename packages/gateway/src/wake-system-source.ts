/**
 * 系统事件源：把 gateway 观察到的异常接到 `system` 触发器上
 * （PLAN 阶段 8 交付物 4 的最后一环）。
 *
 * ## 仍然是"数据库即通道"
 *
 * 事件源**不直接调引擎** —— 它把匹配的触发器的 `next_fire_at` 设成"现在"，
 * 引擎的下一次 tick（≤1 秒）就会扫到。
 * 与 `wake_now` 走同一条路：**一个机制，两处使用**。
 *
 * ## 匹配规则：按 `spec.event` 找触发器
 *
 * 一条 `system` 触发器的 spec 形如 `{ event: 'qq.disconnected' }`。
 * 事件发生时，找出所有 spec.event 匹配、且启用的触发器，把它们标成"到点"。
 *
 * ## 为什么"没有匹配的触发器"要如实回报
 *
 * 用户看到"QQ 掉线了"却**什么都没发生**时，第一个疑问是"我明明设了触发器"。
 * 如果事件源静默地什么都不做，他只能猜。所以返回值里明确写出
 * "有几个触发器匹配、标记了几个" —— 面板与日志都用它。
 *
 * ## 为什么事件要**逐条**回报而不是只回报"处理完了"
 *
 * 一次观察可能匹配多条触发器（比如一条给用户、一条只记账）。
 * 只说"处理完了"的话，排查时不知道是哪条被触发了。
 *
 * @module @forlife/gateway/wake-system-source
 */
import type { DatabaseSync } from 'node:sqlite'

import { listWakeTriggers, updateWakeTrigger } from '@forlife/store'

import { buildSystemPayload, createSystemEventGate, describeSystemEvent, type SystemEventGate } from './wake-events.ts'

/** 一次观察的处理结果。 */
export interface SystemObserveOutcome {
  /** 状态是否变化（未变化则什么都没做）。 */
  readonly changed: boolean
  /** 未变化 / 名字不认识时的原因。 */
  readonly reason: string
  /** 被标记为"到点"的触发器 id。 */
  readonly triggered: readonly string[]
  /** 匹配到但**没被标记**的（停用等），带原因。 */
  readonly skipped: readonly { readonly id: string; readonly title: string; readonly reason: string }[]
}

/** 事件源。 */
export interface SystemWakeSource {
  /** 观察一次系统状态。 */
  readonly observe: (
    name: string,
    key: string,
    state: string,
    detail?: string,
  ) => SystemObserveOutcome
  /** 底层闸门（排障用）。 */
  readonly gate: SystemEventGate
}

/** 从 spec 里读事件名。 */
export function eventOfSpec(spec: string): string | undefined {
  try {
    const parsed = JSON.parse(spec) as { event?: unknown }
    return typeof parsed['event'] === 'string' && parsed['event'] !== '' ? parsed['event'] : undefined
  } catch {
    return undefined
  }
}

/** 造一个事件源。 */
export function createSystemWakeSource(options: {
  readonly db: DatabaseSync
  readonly log?: (message: string) => void
  readonly now?: () => Date
  readonly gate?: SystemEventGate
}): SystemWakeSource {
  const { db } = options
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): Date => new Date())
  const gate = options.gate ?? createSystemEventGate()

  const observe = (name: string, key: string, state: string, detail?: string): SystemObserveOutcome => {
    const verdict = gate.observe(name, key, state)
    if (!verdict.emit) {
      // **不静默**：把"为什么没动作"如实带回去（名字不认识 / 状态没变）
      return { changed: verdict.changed, reason: verdict.reason, triggered: [], skipped: [] }
    }

    // 找匹配的 system 触发器
    const matched = listWakeTriggers(db).filter((row) => row.kind === 'system' && eventOfSpec(row.spec) === name)
    if (matched.length === 0) {
      // 说清"事件到了但没有触发器接" —— 用户否则会以为是自己设错了
      return {
        changed: true,
        reason: `${verdict.reason}；但没有匹配「${name}」的 system 触发器（事件已记录，未唤醒）`,
        triggered: [],
        skipped: [],
      }
    }

    const at = now()
    const triggered: string[] = []
    const skipped: { id: string; title: string; reason: string }[] = []

    for (const row of matched) {
      if (row.enabled !== 1) {
        skipped.push({ id: row.id, title: row.title, reason: '已停用' })
        continue
      }
      if (row.scope === '*' || row.scope.trim() === '') {
        // 没有会话可唤醒 —— 与 wake-runtime 同一条判断，这里提前拦掉，
        // 免得它在引擎里走一遍再失败（失败记录会多一条无意义的）
        skipped.push({ id: row.id, title: row.title, reason: '没有绑定会话（scope=*）' })
        continue
      }
      // **数据库即通道**：设成"现在"⇒ 下一次 tick 扫到
      updateWakeTrigger(db, row.id, { nextFireAt: at.toISOString() }, at)
      triggered.push(row.id)
    }

    // 把事件本身也写进 payload 需要的信息留在日志里（引擎派发时会重建 payload）
    log(`${describeSystemEvent(name, state)}　匹配 ${String(matched.length)} 条，标记 ${String(triggered.length)} 条`)

    return {
      changed: true,
      reason: `${verdict.reason}；匹配 ${String(matched.length)} 条，标记 ${String(triggered.length)} 条`,
      triggered,
      skipped,
    }
  }

  return { observe, gate }
}

/** 造一份系统事件触发的 payload（引擎派发时会用；导出便于测试与一致性）。 */
export function systemTriggerPayload(name: string, key: string, state: string, at: Date, detail?: string): Record<string, unknown> {
  return buildSystemPayload({ name, key, state, at, ...(detail === undefined ? {} : { detail }) })
}
