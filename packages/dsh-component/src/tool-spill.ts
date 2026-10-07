/**
 * **分层降噪接缝**：工具结果过大时，把全文落进溢出存储，只把 head + id 给模型（PLAN §3.2）。
 *
 * ## 为什么需要这个文件（而不是在 runtime 里顺手截一下）
 *
 * `MemoryRuntime.spill()` / `spill_entries` / `recall_full` 三样**都早就写好了**，
 * 但**没有任何一处调用 `spill()`** ⇒ 表永远是空的 ⇒ `recall_full` 永远返回 `found:false`。
 * 单元测试抓不到这件事：它们**直接调 spill 再调 recall_full**，绕过真实写入路径就永远绿。
 *
 * 所以这里提供**两个真实的接缝**（都能被"读源码的接线守卫测试"钉住）：
 *
 *  1. `withToolResultSpill()` —— 包一层宿主的 `defineTool`，给每个工具注入
 *     `finalizeContent`。这是宿主文档里"**模型可见内容的最后一公里变换**"：
 *     同步、每次结果必调（连绕过 post-execute 的失败结果也调）、返回 `undefined` 表示不改。
 *     ⇒ 我们自己注册的工具（`tools.ts` / `qq-tools.ts`）走这条；
 *  2. `registerToolResultSpill()` —— 订阅宿主的 `tools/post-execute` 瀑布。
 *     它能看到**所有**工具的结果（包括宿主的 `pwsh` / `read` / `web_fetch` / 子代理）——
 *     而"完整日志、完整列表、原始报错"恰恰来自那些工具。
 *
 * ## 三条纪律
 *
 * 1. **绝不抛异常**：`finalizeContent` 的契约是 total（宿主原话），
 *    它抛错会毁掉**整次工具调用**。这里全部包在 try/catch 里，失败记进 `toolSpillStats()`；
 * 2. **只处理纯文本**：含图片/结构化块的结果**原样放行**（截断它们等于毁掉内容）；
 * 3. **`recall_full` 自己不截断**：否则取回全文时又被截成 head —— 那就是个死循环，
 *    模型永远拿不到完整内容（见 `TOOL_RESULT_SPILL_SKIP`）。
 *
 * @module forlife-memory/tool-spill
 */
import { defaultFor } from '@forlife/contracts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { DefineToolLike } from './tools.ts'

/** 溢出存储的写入面（`MemoryRuntime.spill` 的结构类型，便于测试替身）。 */
export interface SpillSink {
  spill(input: {
    readonly toolName: string
    readonly content: string
    readonly sessionId?: string
    readonly toolCallId?: string
  }): { readonly id: string; readonly head: string; readonly bytes: number; readonly lines: number }
}

/** 提示里给模型认的标记：**已经有了就不再截**（避免二次截断把 head 越截越短）。 */
export const SPILL_NOTICE_MARK = '结果过大（已分层降噪）'

/**
 * **不截断**的工具白名单。
 *
 * `recall_full` 是"取回全文"的唯一通道：把它的结果再截一次，
 * 模型就永远看不到完整内容（而且它会看到一个新的 spill id，再取、再被截 ……）。
 */
export const TOOL_RESULT_SPILL_SKIP: readonly string[] = ['recall_full']

/** 判定结果：落 spill 了 / 原样放行（带原因，便于诊断）。 */
export type ToolResultSpillPlan =
  | {
      readonly kind: 'spill'
      readonly id: string
      readonly bytes: number
      readonly lines: number
      readonly content: ContentBlock[]
    }
  | { readonly kind: 'keep'; readonly reason: 'small' | 'non_text' | 'skipped' | 'failed' }

/** 一次判定的输入。 */
export interface ToolResultSpillInput {
  readonly runtime: SpillSink
  readonly toolName: string
  /** 模型可见的内容块（未知形状 ⇒ 保守放行）。 */
  readonly blocks: unknown
  readonly toolCallId?: string
  readonly sessionId?: string
  /** 失败上报（**不抛**：调用方的契约是 total）。 */
  readonly onError?: (message: string) => void
}

/** 模块级计数：接缝是不是真的在干活（面板/doctor/测试都看这里）。 */
const stats = { spilled: 0, kept: 0, failed: 0, lastError: undefined as string | undefined }

/** 读计数（返回快照，避免外部改内部状态）。 */
export function toolSpillStats(): {
  readonly spilled: number
  readonly kept: number
  readonly failed: number
  readonly lastError?: string
} {
  return {
    spilled: stats.spilled,
    kept: stats.kept,
    failed: stats.failed,
    ...(stats.lastError === undefined ? {} : { lastError: stats.lastError }),
  }
}

/** 测试用：清零计数（生产路径不会调它）。 */
export function resetToolSpillStats(): void {
  stats.spilled = 0
  stats.kept = 0
  stats.failed = 0
  stats.lastError = undefined
}

/** 把内容块拼成纯文本；含非文本块/空内容时返回原因（保守放行）。 */
function joinText(blocks: unknown): { readonly kind: 'text'; readonly text: string } | { readonly kind: 'other'; readonly reason: 'non_text' | 'empty' } {
  if (!Array.isArray(blocks) || blocks.length === 0) return { kind: 'other', reason: 'empty' }
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') return { kind: 'other', reason: 'non_text' }
    const typed = block as { readonly type?: unknown; readonly text?: unknown }
    if (typed.type !== 'text' || typeof typed.text !== 'string') return { kind: 'other', reason: 'non_text' }
    parts.push(typed.text)
  }
  return { kind: 'text', text: parts.join('\n') }
}

/** 按字节上限裁剪（不切出半个码点：截到完整字符为止）。 */
function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut
}

/**
 * 给模型看的替换文本：**head + id + 怎么取回全文**。
 *
 * 三件事缺一不可（缺任何一件，模型就只会"凭记忆猜被截断的部分"）：
 *  1. 头部内容（还能干活的那部分）；2. 溢出 id；3. 用 `recall_full(id)` 取回的明确指示。
 *
 * **总长度封顶在阈值内**（提示本身也占字节）：否则"一条超长单行"（base64 / 一坨 JSON）
 * 会被 head 原样带回来，截了等于没截。所以先算提示的开销，再把 head 裁到剩下的额度。
 */
export function renderSpillNotice(input: {
  readonly head: string
  readonly id: string
  readonly bytes: number
  readonly lines: number
  readonly headLines: number
  readonly maxBytes: number
}): string {
  const notice = [
    `⚠️ ${SPILL_NOTICE_MARK}：完整结果共 ${String(input.lines)} 行 / ${String(input.bytes)} 字节，`,
    `   上下文里只保留前 ${String(input.headLines)} 行。`,
    `   全文已存入溢出存储，id：${input.id}`,
    `   需要精确内容（完整日志 / 完整列表 / 原始报错）时**不要猜**：调用 recall_full，id 原样传：`,
    `   recall_full({ "id": "${input.id}" })`,
  ].join('\n')
  const headBudget = Math.max(0, input.maxBytes - Buffer.byteLength(notice, 'utf8') - 1)
  return `${clampBytes(input.head, headBudget)}\n${notice}`
}

/**
 * 判定"这个结果要不要落 spill"，要落就落。
 *
 * **不抛异常**（调用方要么在 `finalizeContent` 里、要么在瀑布监听器里，都不能炸）。
 * 失败会记进 `toolSpillStats()` 并经 `onError` 上报 —— **不静默**。
 */
export function planToolResultSpill(input: ToolResultSpillInput): ToolResultSpillPlan {
  try {
    if (TOOL_RESULT_SPILL_SKIP.includes(input.toolName)) return { kind: 'keep', reason: 'skipped' }
    const joined = joinText(input.blocks)
    if (joined.kind !== 'text') return { kind: 'keep', reason: 'non_text' }
    // 二次截断防护：内容里已经有我们的提示 ⇒ 说明它是"截断后的头"，别再截一次
    if (joined.text.includes(SPILL_NOTICE_MARK)) return { kind: 'keep', reason: 'skipped' }

    const maxBytes = defaultFor<number>('tool.spill.thresholdBytes')
    const headLines = defaultFor<number>('tool.spill.headLines')
    const bytes = Buffer.byteLength(joined.text, 'utf8')
    if (bytes <= maxBytes) {
      stats.kept += 1
      return { kind: 'keep', reason: 'small' }
    }

    const stored = input.runtime.spill({
      toolName: input.toolName,
      content: joined.text,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    })
    stats.spilled += 1
    return {
      kind: 'spill',
      id: stored.id,
      bytes: stored.bytes,
      lines: stored.lines,
      content: [
        {
          type: 'text',
          text: renderSpillNotice({
            head: stored.head,
            id: stored.id,
            bytes: stored.bytes,
            lines: stored.lines,
            headLines,
            maxBytes,
          }),
        },
      ],
    }
  } catch (error) {
    stats.failed += 1
    stats.lastError = String(error)
    input.onError?.(`工具结果落 spill 失败（已原样放行）：${String(error)}`)
    return { kind: 'keep', reason: 'failed' }
  }
}

/** 从执行对象里取 `callId` / 会话 id（鸭子类型 —— 我们只依赖结构）。 */
export function identityOf(exec: unknown): { readonly toolCallId?: string; readonly sessionId?: string } {
  const record = (exec ?? {}) as { readonly callId?: unknown; readonly agent?: unknown; readonly name?: unknown }
  const session = (record.agent as { readonly session?: unknown } | null | undefined)?.session
  const sessionId = (session as { readonly id?: unknown } | null | undefined)?.id
  return {
    ...(typeof record.callId === 'string' && record.callId !== '' ? { toolCallId: record.callId } : {}),
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  }
}

/** 从执行对象里取工具名。 */
function toolNameOf(exec: unknown): string {
  const name = ((exec ?? {}) as { readonly name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'unknown'
}

/** 从结果对象里取内容块。 */
function contentOf(result: unknown): unknown {
  return ((result ?? {}) as { readonly content?: unknown }).content
}

/** 宿主 `defineTool` 的选项（结构类型，含我们注入的 `finalizeContent`）。 */
type DefineToolOptionsLike = Parameters<DefineToolLike>[0]
type DefineToolOptionsWithFinalizer = DefineToolOptionsLike & {
  readonly finalizeContent?: (exec: unknown, result: unknown) => readonly ContentBlock[] | undefined
}

/** `withToolResultSpill` 的选项。 */
export interface ToolSpillOptions {
  /** 失败上报（不抛：`finalizeContent` 必须 total）。 */
  readonly onError?: (message: string) => void
}

/**
 * ★ **统一包装层**：把宿主的 `defineTool` 包一层，给每个工具注入 `finalizeContent`。
 *
 * 为什么选 `finalizeContent` 而不是改 `output.render`：
 *  - `render` 是**纯投影**，项目里已有一条测试断言它不产生副作用（"render 不写库"）——
 *    在 render 里落 spill 会直接违反那条纪律；
 *  - `finalizeContent` 是宿主明确提供的"模型可见内容的最后一公里"，
 *    且**连绕过 post-execute 的失败结果也会调**（错误信息同样可能巨长：那是"原始报错"的场景）。
 *
 * 用法（唯一接缝，`tools.ts` / `qq-tools.ts` 各一行）：
 * ```ts
 * const defineSpillingTool = withToolResultSpill(defineTool, runtime)
 * ```
 */
export function withToolResultSpill(defineTool: DefineToolLike, runtime: SpillSink, options: ToolSpillOptions = {}): DefineToolLike {
  const wrapped = (toolOptions: DefineToolOptionsLike): unknown => {
    const previous = (toolOptions as DefineToolOptionsWithFinalizer).finalizeContent
    const withFinalizer: DefineToolOptionsWithFinalizer = {
      ...toolOptions,
      finalizeContent: (exec: unknown, result: unknown): readonly ContentBlock[] | undefined => {
        let inherited: readonly ContentBlock[] | undefined
        if (previous !== undefined) {
          try {
            inherited = previous(exec, result)
          } catch {
            // 上一位 finalizer 自己炸了：不吞掉它的结果语义，继续走我们的判定
            inherited = undefined
          }
        }
        const identity = identityOf(exec)
        const plan = planToolResultSpill({
          runtime,
          toolName: toolNameOf(exec),
          blocks: inherited ?? contentOf(result),
          ...identity,
          ...(options.onError === undefined ? {} : { onError: options.onError }),
        })
        if (plan.kind === 'spill') return plan.content
        // 我们没截 ⇒ **必须返回上一位的结果**（返回 undefined 会把它的替换丢掉）
        return inherited
      },
    }
    return defineTool(withFinalizer)
  }
  return wrapped
}

/** `tools/post-execute` 的宿主决定形状（只声明我们读的部分）。 */
function isAcceptWithoutValue(decision: unknown): boolean {
  if (decision === null || typeof decision !== 'object') return false
  if ((decision as { readonly kind?: unknown }).kind !== 'accept') return false
  // 带 `value` 的 accept 是"整值替换"，内容由宿主重新投影 ⇒ 不能改它的 content
  return !Object.hasOwn(decision, 'value')
}

/** `registerToolResultSpill` 的选项（与 `registerLoopGuard` 同形）。 */
export interface RegisterToolResultSpillOptions {
  readonly log: (message: string) => void
  /** `⚠️` 级别（"没挂上"必须让人看见 —— 否则和"在跑"从日志上看一模一样）。 */
  readonly always: (message: string) => void
  /** 反注册器收集处（与 `index.ts` 的 `disposers` 同一个数组）。 */
  readonly disposers: (() => void)[]
}

/**
 * 订阅宿主的 `tools/post-execute` —— **覆盖所有工具**（含宿主自带的那些）。
 *
 * 两个顺序上的讲究：
 *  - `{ prepend: true }`：先跑 ⇒ 我们 `next()` 拿到的是**其他策略处理后的最终内容**，
 *    落的 spill 就是"原本要进上下文的那一份"（而不是被别的策略改之前的）；
 *  - **先 `await next()` 再替换**：瀑布里 `next()` 是"让后面的人先决定"，
 *    抢在它前面返回会把别人的 block / 值替换整个吞掉。
 *
 * @returns 是否真的挂上了（拿不到 `ctx.on` 返回 false，但**不致命**：记忆本体不受影响）。
 */
export function registerToolResultSpill(ctx: unknown, runtime: SpillSink, options: RegisterToolResultSpillOptions): boolean {
  const contextOn = ctx as {
    on?: (event: string, handler: (...args: unknown[]) => unknown, opts?: { readonly prepend?: boolean }) => (() => void) | undefined
  }
  if (typeof contextOn.on !== 'function') {
    options.always('⚠️ 宿主没有 ctx.on ⇒ **工具结果分层降噪未挂载**（recall_full 将一直取不到东西）')
    return false
  }
  try {
    const dispose = contextOn.on(
      'tools/post-execute',
      async (...args: unknown[]): Promise<unknown> => {
        const exec = args[0]
        const result = args[1]
        const next = args[2]
        if (typeof next !== 'function') return { kind: 'accept' }
        const decision: unknown = await (next as () => Promise<unknown>)()
        if (!isAcceptWithoutValue(decision)) return decision
        const identity = identityOf(exec)
        const plan = planToolResultSpill({
          runtime,
          toolName: toolNameOf(exec),
          blocks: (decision as { readonly content?: unknown }).content ?? contentOf(result),
          ...identity,
          onError: options.log,
        })
        if (plan.kind !== 'spill') return decision
        return { ...(decision as Record<string, unknown>), content: plan.content }
      },
      { prepend: true },
    )
    if (typeof dispose === 'function') options.disposers.push(dispose)
    options.log('已订阅 tools/post-execute：工具结果分层降噪（PLAN §3.2，大结果落 spill、可 recall_full 取回）')
    return true
  } catch (error) {
    options.always(`⚠️ 无法订阅 tools/post-execute（工具结果分层降噪不可用）：${String(error)}`)
    return false
  }
}
