/**
 * **真实的 `SpawnImpl`** —— 把 `wake-program-runner` 的注入点填上（`FIX_PLAN.md` §30）。
 *
 * ## 为什么它是单独一个模块（而不是塞进 runner 里）
 *
 * `wake-program-runner.ts` 的模块头写着「**为什么 spawn 是注入的**」：
 * 真 spawn 的测试要么慢、要么脆，而那里要测的是"校验 → 跑 → 按策略决定"这条**编排**。
 * ⇒ 编排与"真的开一个进程"**分开**是对的：这一层是**唯一**碰 `child_process` 的地方，
 * 于是"允许跑什么"这条策略**只有一处**要审。
 *
 * ## ★★ 用户 2026-10-10 定的四条策略，逐条落在哪
 *
 * | 策略 | 落在哪 |
 * | :--- | :--- |
 * | ① **只允许工作区根下的脚本** | **不在本模块** —— `wake-program-runner.ts:123` 用 `resolveInWorkspace` 判，**在 spawn 之前** |
 * | ② **扩展名白名单** | ★ **本模块**（`ALLOWED_SCRIPT_EXTENSIONS` + `interpreterFor`） |
 * | ③ **并发/时长/输出上限** | 时长与输出由 `DEFAULT_LIMITS` 给到本模块（`timeoutMs` / `maxOutputBytes`）；**并发靠 runner 的 tick 串行** + 本模块的 `isBusy()` |
 * | ④ **脚本指纹变更后停用并要求重新登记** | **不在本模块** —— `wake-program-runner.ts:137-142` 用 `checkScriptUnchanged` 判，**同样在 spawn 之前** |
 *
 * ⇒ 本模块**不重复**做 ①④：重复实现会让"到底哪一层把关"变得说不清，
 * 而 `resolveInWorkspace` / `checkScriptUnchanged` **已经有测试**。
 *
 * ## ★ 两条刻意的硬化（超出那四条，但方向一致）
 *
 * **1. 子进程**不**继承全部环境变量**。默认只给 `PATH` / `HOME` / `LANG` / `TZ`
 * —— 否则 `FORLIFE_*`、`DEEPSEEK_API_KEY` 这些会**自动流进任何被跑起来的脚本**，
 * 而"脚本是工作区里的一个文件"这件事本身**不构成信任**。
 * （确实需要更多变量的场合用 `extraEnv` 显式加。）
 *
 * **2. 输出只留尾部**。`maxOutputBytes` 是**上限**，但一个刷屏脚本在上限之前
 * 已经能产出几十 MB —— 所以这里**边收边截**（只保留最后 N 字节），
 * 而不是"先全收下来再截"。
 *
 * @module @forlife/gateway/wake-spawn
 */
import { spawn } from 'node:child_process'
import { extname } from 'node:path'

import type { SpawnImpl, SpawnResult } from './wake-program-runner.ts'

/**
 * 允许跑的脚本扩展名（**白名单，不是黑名单**）。
 *
 * 为什么是白名单：黑名单必然漏 —— 谁在工作区里放一个 `.pl`、`.rb`、`.ps1`，
 * 黑名单不认识它，于是**自动被放行**。白名单的失败方向是"少支持一种脚本"，
 * 那是**可见且可修**的；黑名单的失败方向是"**悄悄跑了一个没人审过的解释器**"。
 *
 * ⚠️ 加一种扩展名 = **扩大执行面**，属于要人拍板的事，不要顺手加。
 */
export const ALLOWED_SCRIPT_EXTENSIONS: readonly string[] = ['.sh', '.mjs', '.js', '.py']

/** 解释器映射（白名单里的每一项都必须在这里有对应，否则等于白名单写了个寂寞）。 */
const INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  '.sh': ['/bin/sh'],
  '.mjs': ['node'],
  '.js': ['node'],
  '.py': ['python3'],
}

/**
 * 给一个脚本路径挑解释器。
 *
 * @returns 命令行前缀（`[解释器, ...参数]`），或 `undefined` 表示**这个扩展名不许跑**。
 */
export function interpreterFor(absolutePath: string): readonly string[] | undefined {
  const ext = extname(absolutePath).toLowerCase()
  if (!ALLOWED_SCRIPT_EXTENSIONS.includes(ext)) return undefined
  return INTERPRETERS[ext]
}

export interface RealSpawnOptions {
  /** 额外允许继承的环境变量名（默认只给 `PATH`/`HOME`/`LANG`/`TZ`）。 */
  readonly keepEnv?: readonly string[]
  /** 额外注入的环境变量（例如脚本要靠某个 token 时**显式**给）。 */
  readonly extraEnv?: Readonly<Record<string, string>>
}

/** 默认允许继承的环境变量（**不含任何机密**）。 */
const DEFAULT_KEEP_ENV: readonly string[] = ['PATH', 'HOME', 'LANG', 'TZ']

/**
 * 造一个真实的 spawn。
 *
 * @returns 一个 `SpawnImpl`：**它自己不会抛** —— 所有失败都变成
 *   一个 `exitCode: -1` 的 `SpawnResult`（带可读的 `tail`），
 *   于是 `decideAfterExit` 能按策略处理，而不是让异常穿透到 tick。
 */
export function createRealSpawn(options: RealSpawnOptions = {}): SpawnImpl {
  const keepEnv = options.keepEnv ?? DEFAULT_KEEP_ENV

  return async (input): Promise<SpawnResult> => {
    const command = interpreterFor(input.absolutePath)
    const started = Date.now()
    if (command === undefined) {
      // ★ 不抛：让上层按"跑失败"处理（它会记 last_error 并按策略停用/重启）
      return {
        exitCode: -1,
        durationMs: 0,
        outputBytes: 0,
        tail: `扩展名不在白名单里（${ALLOWED_SCRIPT_EXTENSIONS.join(' / ')}）：${input.absolutePath}`,
      }
    }

    const env: Record<string, string> = {}
    for (const name of keepEnv) {
      const v = process.env[name]
      if (v !== undefined) env[name] = v
    }
    Object.assign(env, options.extraEnv ?? {})

    return await new Promise<SpawnResult>((resolve) => {
      let outputBytes = 0
      let tail = ''
      let timedOut = false
      let settled = false

      const child = spawn(command[0] as string, [...command.slice(1), input.absolutePath], {
        cwd: input.cwd,
        env,
        // stdin 关掉：脚本不该等输入（等输入会一直挂到超时，白烧 10 分钟）
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      /** 边收边截：只留**最后** `maxOutputBytes` 字节。 */
      const absorb = (chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        tail += chunk.toString('utf8')
        if (tail.length > input.maxOutputBytes) tail = tail.slice(-input.maxOutputBytes)
      }
      child.stdout?.on('data', absorb)
      child.stderr?.on('data', absorb)

      const timer = setTimeout(() => {
        timedOut = true
        // SIGKILL：脚本可能忽略 SIGTERM，而"杀不掉"会让 tick 永远卡住
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经退了 */
        }
      }, input.timeoutMs)
      // 定时器不许把这个进程一起拖住（脚本还在跑时进程也该能退）
      timer.unref?.()

      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          exitCode,
          durationMs: Date.now() - started,
          outputBytes,
          tail,
          ...(timedOut ? { timedOut: true } : {}),
        })
      }

      child.on('error', (error) => {
        // 例如解释器不存在（`python3` 没装）—— **这是常见情形，必须给出可读原因**
        tail = `${tail}\nspawn 出错：${String(error).slice(0, 200)}`
        finish(-1)
      })
      child.on('close', (code) => {
        finish(code)
      })
    })
  }
}
