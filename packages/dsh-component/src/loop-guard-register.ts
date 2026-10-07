/**
 * 把死循环监控**注册到宿主钩子上**（最后一步）。
 *
 * ## 用哪一套模式（照抄本项目已验证的做法）
 *
 * `index.ts` 里订阅 `session/event` 时是这么写的（L429-451）：
 * ```
 * const contextOn = ctx as unknown as { on?: (event, handler) => (() => void) | undefined }
 * const dispose = contextOn.on('session/event', (...args) => { ... })
 * if (typeof dispose === 'function') disposers.push(dispose)
 * ```
 * **本文件照抄这套** —— 不发明新写法。
 *
 * ## ★ 调用约定要**两种都兼容**（这是必须的防御）
 *
 * `agent/assistant-stream` 的类型签名是**一个 payload**：
 * ```
 * 'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent, frame })
 * ```
 * 而本项目里 `session/event` 的实测约定是**两个参数** `(session, event)`。
 *
 * ⇒ **两种都试**：先看第一个参数里有没有 `frame`，没有就按 `(agent, frame)` 解。
 * **猜错的话监控会静默失效**（拿不到 frame ⇒ 永远不判定），
 * 而那正是本项目反复踩的那类坑（"接线断了而测试全绿"）。
 *
 * ## 三条纪律（都来自本项目的教训）
 *
 * 1. **绝不抛异常** —— 监控跑在**每一次模型输出**上，
 *    它抛错会**毁掉整轮**（与 `vision-bridge` 同源的理由）；
 * 2. **拿不到钩子要明说**（`⚠️`），**不能静默** ——
 *    静默的话，"监控在跑"和"监控没挂上"从日志上看一模一样；
 * 3. **必须能反注册**（`disposers`），否则热重载会**重复挂载** ⇒
 *    一次输出被喂两遍 ⇒ **正常内容被判成重复**（那是最冤的误杀）。
 *
 * @module forlife-memory/loop-guard-register
 */
import { createLoopGuardHook } from './loop-guard-hook.ts'

/** 与 `index.ts` 里的 `ContextLike` 保持结构兼容（只声明我们会用的部分）。 */
interface RegisterableContext {
  on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined
}

export interface RegisterLoopGuardOptions {
  readonly log: (message: string) => void
  /** `⚠️` 级别（拿不到钩子这类**必须让人看见**的事）。 */
  readonly always: (message: string) => void
  /** 反注册器收集处（与 `index.ts` 的 `disposers` 同一个数组）。 */
  readonly disposers: (() => void)[]
}

/**
 * 注册。**返回是否挂上了**（测试要看）。
 *
 * 挂不上**不是致命错误** —— 死循环监控是**加固**，不是记忆本体。
 * 但**必须让人看见**（`always`）。
 */
export function registerLoopGuard(ctx: unknown, options: RegisterLoopGuardOptions): boolean {
  const contextOn = ctx as RegisterableContext
  if (typeof contextOn.on !== 'function') {
    options.always('⚠️ 宿主没有 ctx.on ⇒ **死循环监控未挂载**（记忆本体不受影响）')
    return false
  }

  const hook = createLoopGuardHook({
    log: (message) => {
      options.log(message)
    },
  })

  /** 从参数里**两种约定都试**地解出 `(agent, frame)`。 */
  const parse = (args: unknown[]): { agent: unknown; frame: unknown } | null => {
    const first = args[0]
    // 约定 A：一个 payload `{ agent, frame }`
    if (first !== null && typeof first === 'object' && 'frame' in first) {
      const p = first as { agent?: unknown; frame?: unknown }
      return { agent: p.agent, frame: p.frame }
    }
    // 约定 B：两个参数 `(agent, frame)`
    const second = args[1]
    if (second !== null && typeof second === 'object' && 'type' in (second as object)) {
      return { agent: first, frame: second }
    }
    return null
  }

  try {
    const dispose = contextOn.on('agent/assistant-stream', (...args: unknown[]) => {
      // ★ **绝不抛异常** —— 这个 handler 跑在**每一次模型输出**上
      try {
        const parsed = parse(args)
        if (parsed === null) return
        hook.onFrame(
          (parsed.agent ?? {}) as { cancel?: (c: { kind: 'hook'; reason: string }) => void },
          parsed.frame as { type?: string; chunk?: { type?: string; text?: string } },
        )
      } catch (error) {
        options.log(`死循环监控单帧处理失败（已忽略）：${String(error)}`)
      }
    })
    if (typeof dispose === 'function') options.disposers.push(dispose)
    options.log('已订阅模型输出流：死循环监控（越线时中止本轮）')
    return true
  } catch (error) {
    options.always(`⚠️ 无法订阅模型输出流（死循环监控不可用）：${String(error)}`)
    return false
  }
}
