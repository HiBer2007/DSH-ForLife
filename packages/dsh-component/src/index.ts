/**
 * legacy cordis 入口（宿主没有 dsh-std 时的降级路径）。
 *
 * DSH 的 Cordis 插件形态：具名导出 `name` / `inject` / `apply`（对象形式），
 * `apply(ctx, config)` 是唯一入口（见 EXECUTION_PLAN §3 D10/D12 的调研结论）。
 *
 * 阶段 0 只做诊断输出；**刻意不导出 `Config`**：因为还没有引入 schemastery，
 * 而宿主设置页要求 `Config` 是 schemastery 且至少含一个 `.volatile()` 字段才显示。
 * 阶段 1 会补上（届时设置页自动出现"存储路径 / 时区 / 阈值"表单）。
 *
 * @module forlife-memory
 */
import { contractsSummary } from './diagnostics.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'forlife-memory'

/** 需要的宿主服务：阶段 0 一个都不要（只做诊断），阶段 1 起加 tools/systemPrompt/compaction。 */
export const inject: string[] = []

/** 阶段 0 的配置形状（暂无 schemastery，先用普通对象描述，仅供日志展示）。 */
export interface ForlifeConfig {
  /** 是否打印详细诊断。 */
  readonly verbose?: boolean
}

/**
 * 插件入口。
 *
 * @param ctx - 宿主 Cordis 上下文（阶段 0 不使用其服务）。
 * @param config - 插件配置。
 */
export function apply(ctx: unknown, config: ForlifeConfig = {}): void {
  const summary = contractsSummary()
  console.log('[forlife] legacy cordis 入口已加载')
  console.log(
    `[forlife] 契约基线 v${summary.baselineVersion}｜参数 ${summary.paramCount}（doc ${summary.docCount} / design ${summary.designCount}）｜` +
      `时机 ${summary.timingCount}｜未定值 ${summary.pendingCount}｜数值偏离 ${summary.deviationCount}｜规则偏离 ${summary.ruleDeviationCount}`,
  )
  if (config.verbose === true) {
    console.log(`[forlife] 宿主上下文可用性：ctx=${ctx === undefined ? 'undefined' : typeof ctx}`)
    console.log(`[forlife] 基线文档：${summary.documents.join('、')}`)
  }
  console.log('[forlife] 阶段 0：仅诊断，未注册任何工具（避免污染模型可用面）')
}
