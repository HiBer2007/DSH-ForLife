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
 * ## ★ 连接状态为什么用**单独一个量**判边沿
 *
 * 端到端台子抓到的第二个真 bug：如果用两个事件名各判一次边沿
 * （`qq.disconnected` / `qq.reconnected`），那么 `qq.disconnected` 那一侧
 * **永远看不到"恢复"** —— 它记住的状态一直是 `down`，
 * 于是**第二次断线被当成"没变化"**。
 *
 * 后果很严重：**断线 → 恢复 → 再断线，第二次永远不会唤醒模型。**
 *
 * 正确做法（`observeConnection`）：边沿检测盯**连接状态这一个量**，
 * 事件名从**状态转移**派生。这样：
 *  - 断线期间观察 50 次 ⇒ 只发 1 次；
 *  - 恢复 ⇒ 发一次；
 *  - **再次断线 ⇒ 再发一次**（那是新故障）。
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
  readonly observe: (name: string, key: string, state: string, detail?: string) => SystemObserveOutcome
  /**
   * 观察**连接状态**（QQ 掉线/恢复）。
   *
   * 与 `observe` 的区别：边沿检测盯**一个**状态量，事件名从状态转移派生。
   * 用 `observe` 传两个事件名的话，`qq.disconnected` 那一侧永远看不到"恢复"，
   * **第二次断线不会被唤醒**。
   */
  readonly observeConnection: (connected: boolean, detail?: string) => SystemObserveOutcome
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

  /**
   * 把一次**已经判定过边沿**的事件派发到匹配的触发器。
   *
   * 与 `observe` 分开：`observe` 负责"判边沿"，这个负责"派发"。
   * 连接观察需要在**一个**状态量上判边沿、再派发到**两个**事件名 ——
   * 所以这两件事必须能拆开。
   */
  const fireEvent = (
    name: string,
    _key: string,
    state: string,
    _detail: string | undefined,
    verdictReason: string,
  ): SystemObserveOutcome => {
    const matched = listWakeTriggers(db).filter((row) => row.kind === 'system' && eventOfSpec(row.spec) === name)
    if (matched.length === 0) {
      // 说清"事件到了但没有触发器接" —— 用户否则会以为是自己设错了
      return {
        changed: true,
        reason: `${verdictReason}；但没有匹配「${name}」的 system 触发器（事件已记录，未唤醒）`,
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

    log(`${describeSystemEvent(name, state)}　匹配 ${String(matched.length)} 条，标记 ${String(triggered.length)} 条`)

    return {
      changed: true,
      reason: `${verdictReason}；匹配 ${String(matched.length)} 条，标记 ${String(triggered.length)} 条`,
      triggered,
      skipped,
    }
  }

  /** **连接状态**（单独一个量，不是按事件名分键）。 */
  let connectionState: string | undefined

  const observeConnection = (connected: boolean, detail?: string): SystemObserveOutcome => {
    const state = connected ? 'up' : 'down'
    const previous = connectionState
    if (previous === state) {
      // **这就是防重复唤醒的那一句**：断线期间观察 50 次只发 1 次
      return { changed: false, reason: `连接状态未变化（仍是 ${state}），去重`, triggered: [], skipped: [] }
    }
    connectionState = state
    const reason = previous === undefined ? `首次观察到连接状态 ${state}` : `连接状态变化 ${previous} → ${state}`
    // 事件名从**状态转移**派生 —— 而不是把两个名字各判一次边沿
    return fireEvent(connected ? 'qq.reconnected' : 'qq.disconnected', 'onebot11', state, detail, reason)
  }

  const observe = (name: string, key: string, state: string, detail?: string): SystemObserveOutcome => {
    const verdict = gate.observe(name, key, state)
    if (!verdict.emit) {
      // **不静默**：把"为什么没动作"如实带回去（名字不认识 / 状态没变）
      return { changed: verdict.changed, reason: verdict.reason, triggered: [], skipped: [] }
    }
    // 边沿已经判过 ⇒ 直接派发（与 observeConnection 共用同一条派发路径）
    return fireEvent(name, key, state, detail, verdict.reason)
  }

  return { observe, observeConnection, gate }
}

/** 造一份系统事件触发的 payload（引擎派发时会用；导出便于测试与一致性）。 */
export function systemTriggerPayload(name: string, key: string, state: string, at: Date, detail?: string): Record<string, unknown> {
  return buildSystemPayload({ name, key, state, at, ...(detail === undefined ? {} : { detail }) })
}
