/**
 * 便携 facet 入口（dsh-std `lifecycle.dsh/v1alpha1` 的 `FacetModule`）。
 *
 * 设计要点（EXECUTION_PLAN §1.1）：
 *  - 这是**便携形态**：宿主有 dsh-std 时走这条；没有时由 `./index.ts` 的 legacy cordis 入口兜底；
 *  - 阶段 0 的职责只有一件事：**证明组件能被发现、协商、激活，并输出诊断**；
 *  - 记忆/压缩/工具/面板等真实能力从阶段 1 开始挂。
 *
 * 依赖处理：`@dsh-std/sdk` 属于 dsh-std 生态，宿主不一定装了。
 * 因此这里用**动态导入 + 降级**：拿不到 SDK 时不崩，而是以 degraded 状态报告，
 * 这样在任何宿主上都能装、都能看见"为什么没生效"。
 *
 * @module forlife-memory/facet
 */
import { contractsSummary } from './diagnostics.ts'

/** 协商结果里的降级原因（无 SDK 时使用）。 */
interface DegradedReason {
  readonly code: 'DSH_STD_SDK_MISSING'
  readonly detail: string
}

interface FacetProjectionLike {
  state: 'active' | 'degraded'
  message?: string
  extensions?: readonly { apiVersion: string; kind: string; name: string; status: unknown }[]
}

interface ActivationContextLike {
  readonly identity?: { readonly component?: string; readonly facet?: string; readonly instanceId?: string }
  readonly scope?: { add(dispose: () => void | Promise<void>): () => void }
  readonly protocols?: {
    agreement?(reference: { apiVersion: string; kind: string }): unknown
    implement?<T>(support: { apiVersion: string; kind: string }, implementation: T): () => void
  }
}

let degraded: DegradedReason | undefined

/**
 * 激活 facet。
 *
 * 阶段 0：只做诊断与生命周期挂接，不注册任何工具（避免在未实现时污染模型可用面）。
 */
export async function activate(context: ActivationContextLike): Promise<void> {
  const summary = contractsSummary()
  const identity = context.identity
  console.log(
    `[forlife] facet 激活：component=${identity?.component ?? 'unknown'} facet=${identity?.facet ?? 'unknown'} ` +
      `instance=${identity?.instanceId ?? 'unknown'}`,
  )
  console.log(
    `[forlife] 保真度基线 v${summary.baselineVersion}：参数 ${summary.paramCount} 条（doc ${summary.docCount} / design ${summary.designCount}）、` +
      `时机 ${summary.timingCount} 条、未定值 ${summary.pendingCount} 条、数值偏离 ${summary.deviationCount} 条、规则偏离 ${summary.ruleDeviationCount} 条`,
  )

  // 探测 dsh-std SDK 是否可用（不可用则整体降级，但不阻断宿主）
  try {
    // 用变量说明符：TS 不会强解，宿主没装这个包时也不会在编译期炸
    const sdkSpecifier = '@dsh-std/sdk'
    await import(sdkSpecifier)
  } catch {
    degraded = {
      code: 'DSH_STD_SDK_MISSING',
      detail: '未找到 @dsh-std/sdk；组件以降级状态运行（legacy cordis 入口仍然可用）',
    }
    console.warn(`[forlife] ${degraded.code}: ${degraded.detail}`)
  }

  // 把清理逻辑挂到激活作用域上（dsh-std 的生命周期约定）
  context.scope?.add(() => {
    console.log('[forlife] facet 反注册完成')
  })
}

/** 供宿主查询状态（dsh-std 的 FacetProjection）。 */
export function snapshot(): FacetProjectionLike {
  if (degraded !== undefined) {
    return { state: 'degraded', message: `${degraded.code}: ${degraded.detail}`, extensions: [] }
  }
  return { state: 'active', extensions: [] }
}

/** 反注册。 */
export function deactivate(reason: string): void {
  console.log(`[forlife] facet 停用：${reason}`)
}

/** dsh-std 约定：默认导出 FacetModule。 */
const facetModule = { activate, deactivate, snapshot }
export default facetModule

