/**
 * `external` 触发器：让**外部系统**唤醒模型（PLAN 阶段 8 交付物 1 的第四类）。
 *
 * ## 为什么令牌是**每条触发器一个**，而不是全局一个
 *
 * 全局令牌意味着：任何一个外部系统拿到它，就能触发**所有**外部触发器。
 * 而外部触发器的用途恰恰是"让第三方系统叫我"——
 * 比如 CI 挂了叫我、监控告警叫我、家里的传感器叫我。
 * 这些都是**不同信任级别**的来源。
 *
 * 每触发器一个令牌，于是：
 *  - 泄露一个只影响那一条（撤销它即可，不用换所有人的）；
 *  - 能看出**是谁**触发的（日志里带触发器名）；
 *  - 一条被滥用时可以单独停用而不影响别人。
 *
 * ## 为什么令牌要**常量时间比较**
 *
 * 普通的 `===` 会在第一个不同的字符处提前返回，于是比较耗时**泄露了前缀信息**。
 * 攻击者可以逐字节爆破。令牌比较是少数几个"必须常量时间"的地方之一。
 *
 * ## 为什么令牌存哈希而不是明文
 *
 * 与密码同理：库被读走时，明文令牌就是**可直接使用的凭证**。
 * 存哈希的话攻击者还得爆破 —— 而我们的令牌是 32 字节随机，爆不出来。
 *
 * @module @forlife/gateway/wake-external-source
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { listWakeTriggers, updateWakeTrigger } from '@forlife/store'

/** 外部触发规格。 */
export interface ExternalSpec {
  /** 令牌的哈希（**不存明文**）。 */
  readonly tokenHash: string
  /** 给外部系统看的说明（面板上显示"这个令牌给谁用"）。 */
  readonly label: string
}

/** 生成一个新令牌（返回明文与规格；**明文只在这一刻存在**）。 */
export function newExternalToken(label: string): { readonly token: string; readonly spec: ExternalSpec } {
  const token = randomBytes(32).toString('base64url')
  return { token, spec: { tokenHash: hashToken(token), label } }
}

/** 令牌哈希。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 常量时间比较两个哈希（长度不同直接 false —— 长度本身不是秘密）。 */
export function tokenMatches(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(provided), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 解析外部触发规格。 */
export function parseExternalSpec(spec: string): ExternalSpec | undefined {
  try {
    const parsed = JSON.parse(spec) as { tokenHash?: unknown; label?: unknown }
    if (typeof parsed.tokenHash !== 'string' || parsed.tokenHash.length !== 64) return undefined
    return { tokenHash: parsed.tokenHash, label: typeof parsed.label === 'string' ? parsed.label : '(未命名)' }
  } catch {
    return undefined
  }
}

/** 一次外部触发的处理结果。 */
export interface ExternalTriggerOutcome {
  readonly ok: boolean
  readonly reason: string
  readonly triggerId?: string
}

/** 外部触发源。 */
export interface ExternalWakeSource {
  /** 用触发器 id + 令牌触发一次。 */
  readonly fire: (triggerId: string, token: string, payload?: Record<string, unknown>) => ExternalTriggerOutcome
  /** 令牌是否匹配（供 HTTP 层提前判断，避免把令牌带进业务逻辑）。 */
  readonly verify: (triggerId: string, token: string) => boolean
}

/** 造一个外部触发源。 */
export function createExternalWakeSource(options: {
  readonly db: DatabaseSync
  readonly log?: (message: string) => void
  readonly now?: () => Date
}): ExternalWakeSource {
  const { db } = options
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): Date => new Date())

  /** 取一条 external 触发器（并确认令牌）。 */
  const findVerified = (triggerId: string, token: string): { ok: true; row: ReturnType<typeof listWakeTriggers>[number] } | { ok: false; reason: string } => {
    const row = listWakeTriggers(db).find((r) => r.id === triggerId)
    if (row === undefined) return { ok: false, reason: `没有这条触发器：${triggerId}` }
    if (row.kind !== 'external') return { ok: false, reason: `触发器 ${triggerId} 不是 external 类型` }

    const spec = parseExternalSpec(row.spec)
    if (spec === undefined) {
      // 规格坏了要说清是"配置问题"，而不是"令牌不对" ——
      // 否则用户会去换令牌，而真正的问题是那条记录坏了
      return { ok: false, reason: `触发器 ${triggerId} 的外部规格已损坏（缺 tokenHash）` }
    }
    if (token.trim() === '') return { ok: false, reason: '没有提供令牌' }
    if (!tokenMatches(token, spec.tokenHash)) {
      // **不回显期望值、不区分"空"与"错"** —— 那会给爆破提供信息
      return { ok: false, reason: '令牌不正确' }
    }
    return { ok: true, row }
  }

  const verify = (triggerId: string, token: string): boolean => findVerified(triggerId, token).ok

  const fire = (triggerId: string, token: string, payload: Record<string, unknown> = {}): ExternalTriggerOutcome => {
    const found = findVerified(triggerId, token)
    if (!found.ok) return { ok: false, reason: found.reason }

    const row = found.row
    if (row.enabled !== 1) return { ok: false, reason: `触发器「${row.title}」已停用` }
    if (row.scope === '*' || row.scope.trim() === '') {
      return { ok: false, reason: `触发器「${row.title}」没有绑定会话（scope=*），无处唤醒` }
    }

    const at = now()
    // **数据库即通道**：与其它三类同一条路
    updateWakeTrigger(db, row.id, { nextFireAt: at.toISOString() }, at)
    // payload 记在日志里（HTTP 层会把 detail 一起带进来）
    const detail = Object.keys(payload).length === 0 ? '' : `　payload=${JSON.stringify(payload).slice(0, 200)}`
    log(`外部触发「${row.title}」（${parseExternalSpec(row.spec)?.label ?? '未命名'}）${detail}`)
    return { ok: true, reason: '已请求唤醒（gateway 侧下一次 tick 处理）', triggerId: row.id }
  }

  return { fire, verify }
}
