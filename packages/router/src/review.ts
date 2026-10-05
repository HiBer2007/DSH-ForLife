/**
 * 不确定案例的定期复盘（模型路由.MD §6.2 + §十 阶段四"调优"）。
 *
 * ## 为什么不实时调用 L3
 *
 * 文档说得很明确：「**不实时调用 L3 —— 那会破坏"极致快速"的目标**」。
 * 所以低置信度的案例只**落库**，等定期（T15，默认 24 小时）批量复盘。
 *
 * ## 复盘要产出可执行的东西，不是一份报告
 *
 * 复盘的价值在于"改了之后下次不一样"。所以这里的产出是三类**具体动作**：
 *  - `guard-candidate`：某类文本反复出现且判不准 ⇒ 值得加一条守卫规则（或删一条）；
 *  - `threshold`：低置信度集中在某个档位边界 ⇒ 调阈值；
 *  - `prompt`：同一类语义反复判错 ⇒ 改评分提示词里的档位定义。
 *
 * 这是纯逻辑（输入案例，输出建议），所以能在没有模型的情况下被测。
 *
 * @module @forlife/router/review
 */
import { defaultFor } from '@forlife/contracts'

/** 一条待复盘案例。 */
export interface ReviewCase {
  readonly id: string
  readonly textExcerpt: string
  readonly tier: string
  readonly confidence: number
  readonly backend?: string | null
  readonly at?: string
}

/** 调优建议的类型。 */
export type SuggestionKind = 'guard-candidate' | 'threshold' | 'prompt'

/** 一条调优建议。 */
export interface TuningSuggestion {
  readonly kind: SuggestionKind
  /** 一句话结论（人看得懂）。 */
  readonly summary: string
  /** 支撑数据（几例、什么特征）。 */
  readonly evidence: string
  /** 建议的具体动作。 */
  readonly action: string
  /** 置信度：样本太少时明确说"证据不足"。 */
  readonly confidence: 'low' | 'medium' | 'high'
}

/** 文本特征（用于聚类；刻意简单 —— 复盘是离线任务，不需要多聪明）。 */
function featureOf(text: string): string {
  const t = text.trim()
  if ([...t].length <= 10) return '极短消息'
  if (/[?？]$/.test(t)) return '问句'
  if (/```|function |const |def |import /.test(t)) return '含代码'
  if (/设计|架构|方案|为什么|分析|权衡|重构/.test(t)) return '规划类'
  if (/帮|请|麻烦/.test(t)) return '请求类'
  return '其他'
}

/**
 * 复盘一批案例，产出调优建议。
 *
 * @param cases - 待复盘案例。
 * @param options - 阈值（样本量下限等）。
 * @returns 建议列表（可能为空 —— 没有值得改的就该说"没有"）。
 */
export function reviewCases(
  cases: readonly ReviewCase[],
  options: { readonly minSamples?: number } = {},
): readonly TuningSuggestion[] {
  const minSamples = options.minSamples ?? 5
  const suggestions: TuningSuggestion[] = []

  // ① 按特征聚类：出现得多、且置信度普遍低 ⇒ 值得考虑加/改守卫规则
  const byFeature = new Map<string, ReviewCase[]>()
  for (const item of cases) {
    const key = featureOf(item.textExcerpt)
    const list = byFeature.get(key) ?? []
    list.push(item)
    byFeature.set(key, list)
  }

  for (const [feature, group] of byFeature) {
    if (group.length < minSamples) continue
    const avgConfidence = group.reduce((sum, item) => sum + item.confidence, 0) / group.length
    const tierCounts = new Map<string, number>()
    for (const item of group) tierCounts.set(item.tier, (tierCounts.get(item.tier) ?? 0) + 1)
    const dominant = [...tierCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    const dominantShare = dominant === undefined ? 0 : dominant[1] / group.length

    // 判得散（没有一个档位占明显多数）⇒ 这类文本对守卫来说是"该放行"还是"该拦"说不清
    if (dominantShare < 0.7) {
      suggestions.push({
        kind: 'guard-candidate',
        summary: `「${feature}」这一类判得很散（最高档位只占 ${(dominantShare * 100).toFixed(0)}%），且平均置信度只有 ${avgConfidence.toFixed(2)}`,
        evidence: `${String(group.length)} 例；档位分布 ${[...tierCounts.entries()].map(([tier, n]) => `${tier}×${String(n)}`).join('、')}`,
        action:
          '要么为这一类加一条明确的守卫规则（如果人一眼能判），要么在评分提示词里把这一类单独举例说明。' +
          '**不要**只调阈值 —— 判得散说明提示词没讲清，不是阈值问题。',
        confidence: group.length >= minSamples * 3 ? 'medium' : 'low',
      })
    } else if (avgConfidence < defaultFor<number>('router.uncertain.minConfidence')) {
      // 判得一致但都不自信 ⇒ 阈值/提示词问题
      suggestions.push({
        kind: 'threshold',
        summary: `「${feature}」这类一致判为 ${dominant?.[0] ?? '?'}，但平均置信度只有 ${avgConfidence.toFixed(2)}`,
        evidence: `${String(group.length)} 例，其中 ${(dominantShare * 100).toFixed(0)}% 都判成 ${dominant?.[0] ?? '?'}`,
        action:
          '如果这个判断本身是对的，说明评分模型对这一类**系统性不自信**：在评分提示词里为这一类补一个例子' +
          '（比调阈值更有效，调阈值会连带影响其他类）。',
        confidence: 'medium',
      })
    }
  }

  // ② 后端差异：降级路径判出来的结果系统性不同 ⇒ 兜底权重该调
  const byBackend = new Map<string, ReviewCase[]>()
  for (const item of cases) {
    const key = item.backend ?? '未知'
    const list = byBackend.get(key) ?? []
    list.push(item)
    byBackend.set(key, list)
  }
  const heuristicCases = byBackend.get('heuristic')
  if (heuristicCases !== undefined && heuristicCases.length >= minSamples) {
    const share = heuristicCases.length / cases.length
    if (share > 0.3) {
      suggestions.push({
        kind: 'prompt',
        summary: `有 ${(share * 100).toFixed(0)}% 的案例走了启发式兜底（说明评分后端经常不可用）`,
        evidence: `${String(heuristicCases.length)}/${String(cases.length)} 例走了兜底`,
        action:
          '先查评分后端为什么这么频繁不可用（超时？未配置？显存不足？）。' +
          '在这之前**不要**忙着调启发式权重 —— 那是在给一个不该常走的路径做优化。',
        confidence: 'high',
      })
    }
  }

  return suggestions
}

/**
 * 复盘结论的一句话总结（日志/面板用）。
 *
 * @param suggestions - 建议。
 * @param caseCount - 案例数。
 * @returns 总结。
 */
export function summarizeReview(suggestions: readonly TuningSuggestion[], caseCount: number): string {
  if (caseCount === 0) return '没有待复盘的不确定案例 —— 路由决策目前都挺自信。'
  if (suggestions.length === 0) {
    return `复盘了 ${String(caseCount)} 条案例，**没有发现需要调整的地方**（低置信度是分散的个别现象，不是系统性问题）。`
  }
  const byKind = new Map<SuggestionKind, number>()
  for (const item of suggestions) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1)
  const parts = [...byKind.entries()].map(([kind, n]) => `${kind}×${String(n)}`)
  return `复盘了 ${String(caseCount)} 条案例，产出 ${String(suggestions.length)} 条建议（${parts.join('、')}）。`
}
