/**
 * 监视程序的运行层（PLAN 阶段 8 交付物 3 的后半）。
 *
 * 策略部分（退避数学、限额判定、状态机）在 `wake-supervisor.ts`；
 * 这里负责**真的把程序跑起来**：校验脚本指纹 → spawn → 收输出 → 按策略决定下一步。
 *
 * ## 三件必须在 spawn 之前做的事
 *
 * 1. **脚本指纹校验** —— PLAN 要求"脚本变更需重新登记"。
 *    登记时认可的是**那一版**；改过之后行为可能完全不同
 *    （"检查文件是否存在"被改成"删除文件"），而监督器**无从判断**。
 *    所以变更后**停用并要求重新登记**，而不是继续跑一个没人审过的新版本。
 * 2. **路径走工作区沙箱** —— 与监视条件同一条纪律：能跑的文件必须限制在工作区内。
 * 3. **限额**（时长 / 输出）—— 一个卡死或刷屏的程序不能拖垮 gateway。
 *
 * ## 为什么 spawn 是注入的
 *
 * 真 spawn 的测试要么慢、要么脆（依赖平台差异）。而这里要测的是
 * **"校验 → 跑 → 按策略决定"这条编排**，不是 `child_process` 本身。
 * 注入之后，超时、超输出、非零退出、脚本变更这些分支都能稳定复现。
 *
 * @module @forlife/gateway/wake-program-runner
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '@forlife/store'

import {
  checkScriptUnchanged,
  decideAfterExit,
  DEFAULT_LIMITS,
  type ProgramContract,
  type ProgramLimits,
  type ProgramStatus,
} from './wake-supervisor.ts'
import { resolveInWorkspace } from './workspace.ts'

/** 一次 spawn 的结果（由注入的实现返回）。 */
export interface SpawnResult {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly outputBytes: number
  /** 程序输出的最后若干字节（日志用；**要截断**，不能无限存）。 */
  readonly tail: string
  /** 是否因为超时被我们杀掉。 */
  readonly timedOut?: boolean
}

/** spawn 实现（注入）。 */
export type SpawnImpl = (input: {
  readonly absolutePath: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}) => Promise<SpawnResult>

/** 一条程序记录。 */
export interface ProgramRow {
  readonly id: string
  readonly name: string
  readonly contract: string
  readonly path: string
  readonly sha256: string
  readonly enabled: number
  readonly status: string
  readonly restart_count: number
}

/** 一次运行的结果。 */
export interface RunOutcome {
  readonly action: 'stop' | 'restart' | 'disable'
  readonly reason: string
  readonly waitMs: number
  readonly exitCode: number | null
}

/** 运行器。 */
export interface ProgramRunner {
  /** 跑一次某个程序（含校验与策略）。 */
  readonly runOnce: (programId: string, options?: { readonly killed?: boolean }) => Promise<RunOutcome>
  /** 跑一轮所有启用的程序。 */
  readonly tick: () => Promise<readonly { readonly id: string; readonly outcome: RunOutcome }[]>
}

/** 造一个运行器。 */
export function createProgramRunner(options: {
  readonly db: DatabaseSync
  readonly workspaceRoot: string
  readonly spawn: SpawnImpl
  readonly limits?: ProgramLimits
  readonly log?: (message: string) => void
  readonly sha256Of?: (absolutePath: string) => string
}): ProgramRunner {
  const { db, workspaceRoot, spawn } = options
  const limits = options.limits ?? DEFAULT_LIMITS
  const log = options.log ?? ((): void => {})
  const sha256Of =
    options.sha256Of ?? ((p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex'))

  const readProgram = (id: string): ProgramRow | undefined =>
    db.prepare('SELECT * FROM wake_programs WHERE id = ?').get(id) as unknown as ProgramRow | undefined

  const setStatus = (id: string, status: ProgramStatus, extra: Record<string, unknown> = {}): void => {
    const sets = ['status = ?', 'updated_at = ?']
    const values: unknown[] = [status, nowIso()]
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`)
      values.push(v)
    }
    values.push(id)
    db.prepare(`UPDATE wake_programs SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]))
  }

  const runOnce = async (programId: string, runOptions: { readonly killed?: boolean } = {}): Promise<RunOutcome> => {
    const program = readProgram(programId)
    if (program === undefined) {
      return { action: 'stop', reason: `没有这个程序：${programId}`, waitMs: 0, exitCode: null }
    }

    // ① 路径沙箱
    const resolved = resolveInWorkspace(workspaceRoot, program.path)
    if (!resolved.ok) {
      setStatus(programId, 'disabled', { last_error: `路径不合法：${resolved.reason}` })
      return { action: 'disable', reason: `路径不合法，已停用：${resolved.reason}`, waitMs: 0, exitCode: null }
    }

    // ② 脚本指纹 —— **变更后停用并要求重新登记**
    let actualSha: string
    try {
      actualSha = sha256Of(resolved.absolutePath)
    } catch (error) {
      setStatus(programId, 'failed', { last_error: `读不到脚本：${String(error).slice(0, 160)}` })
      return { action: 'stop', reason: `读不到脚本：${String(error).slice(0, 120)}`, waitMs: 0, exitCode: null }
    }
    const scriptCheck = checkScriptUnchanged(program.sha256, actualSha)
    if (scriptCheck.changed) {
      setStatus(programId, 'disabled', { last_error: scriptCheck.reason })
      log(`程序「${program.name}」已停用：${scriptCheck.reason}`)
      return { action: 'disable', reason: scriptCheck.reason, waitMs: 0, exitCode: null }
    }

    // ③ 跑
    setStatus(programId, 'running', { last_started_at: nowIso() })
    let result: SpawnResult
    try {
      result = await spawn({
        absolutePath: resolved.absolutePath,
        cwd: workspaceRoot,
        timeoutMs: limits.maxRuntimeMs,
        maxOutputBytes: limits.maxOutputBytes,
      })
    } catch (error) {
      result = { exitCode: -1, durationMs: 0, outputBytes: 0, tail: `spawn 失败：${String(error).slice(0, 160)}` }
    }

    // ④ 按策略决定
    const decision = decideAfterExit({
      contract: program.contract as ProgramContract,
      observation: {
        // 被超时杀掉的**不算正常退出** —— 它是失败
        exitOk: result.exitCode === 0 && result.timedOut !== true,
        durationMs: result.durationMs,
        outputBytes: result.outputBytes,
      },
      restartCount: program.restart_count,
      limits,
      killed: runOptions.killed === true,
    })

    const nextRestartCount = decision.action === 'restart' ? program.restart_count + 1 : program.restart_count
    const status: ProgramStatus = decision.action === 'restart' ? 'failed' : decision.action === 'disable' ? 'disabled' : 'stopped'
    setStatus(programId, status, {
      last_exit_at: nowIso(),
      last_exit_code: result.exitCode,
      last_error: decision.action === 'stop' ? null : decision.reason,
      restart_count: nextRestartCount,
    })

    log(`程序「${program.name}」退出（code=${String(result.exitCode)}）：${decision.reason}`)
    return { action: decision.action, reason: decision.reason, waitMs: decision.waitMs, exitCode: result.exitCode }
  }

  const tick = async (): Promise<readonly { readonly id: string; readonly outcome: RunOutcome }[]> => {
    const rows = db.prepare('SELECT id FROM wake_programs WHERE enabled = 1').all() as unknown as { id: string }[]
    const results: { id: string; outcome: RunOutcome }[] = []
    for (const row of rows) {
      try {
        results.push({ id: row.id, outcome: await runOnce(row.id) })
      } catch (error) {
        // 一个程序出问题不该拖垮整轮
        log(`程序 ${row.id} 运行异常：${String(error).slice(0, 160)}`)
      }
    }
    return results
  }

  return { runOnce, tick }
}
