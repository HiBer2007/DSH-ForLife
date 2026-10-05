/**
 * 路由表的播种（首次启动时把档位映射落进 `model_routes`）。
 *
 * ## 为什么必须播种
 *
 * `model_routes` 是"档位 → 具体模型"的**唯一真源**：路由决策判出 L1/L2/L3 之后，
 * 真正用哪个 provider/model 完全取决于这张表。表是空的就等于：
 *  - 降级链没有候选可降（provider 挂了只能整轮失败）；
 *  - 子代理分不到模型；
 *  - 面板上七个角色全是"还没配置"，用户不知道该从哪儿开始。
 *
 * 而"用户第一次打开就有东西可用"和"提示词有内置默认值"是同一类问题，
 * 所以这里也用同样的做法：**只在不覆盖任何已有配置的前提下**补默认值。
 *
 * ## 默认值从哪来
 *
 * 宿主 profile 里的 `agent-default-model` 决定了这个机器人实际用哪个模型
 * （本项目 `forlife-web` 里是 `deepseek-official` / `deepseek-flash`）。
 * 我们读不到别的插件的配置，所以把这两个值做成**我们自己的配置项**（可被 profile 覆盖），
 * 并在文档里写明"应当与宿主 `agent-default-model` 保持一致"。
 *
 * 三档都指向同一个模型的理由：**档位只影响 reasoningEffort**，不影响选哪个模型 ——
 * 只有一个模型可用时，这是唯一合理的行为；用户想要"强模型答复杂问题"时，
 * 在面板里给 L3 加一行更强的模型即可（候选链是有序的）。
 *
 * @module forlife-memory/route-seed
 */
import type { DatabaseSync } from 'node:sqlite'

import { listModelRoutes, upsertModelRoute } from '@forlife/store'

/** 播种输入。 */
export interface SeedRoutesInput {
  readonly provider: string
  readonly model: string
  /** 是否给 L3 用更高的推理强度（默认是）。 */
  readonly effortByTier?: boolean
}

/** 播种结果。 */
export interface SeedRoutesResult {
  readonly seeded: boolean
  readonly count: number
  readonly reason: string
}

/**
 * 首次启动播种档位映射（**已有配置就不动**）。
 *
 * @param db - 数据库。
 * @param input - provider/model。
 * @returns 结果（含"为什么没播种"，便于排障）。
 */
export function seedDefaultRoutes(db: DatabaseSync, input: SeedRoutesInput): SeedRoutesResult {
  const existing = listModelRoutes(db)
  if (existing.length > 0) {
    return { seeded: false, count: 0, reason: `已有 ${String(existing.length)} 行路由配置，不覆盖（播种只补空表）` }
  }
  if (input.provider.trim() === '' || input.model.trim() === '') {
    return { seeded: false, count: 0, reason: '配置里没给 provider/model，跳过播种（留空让用户在面板里填）' }
  }

  // 档位只决定推理强度：低档不想太久、高档多想一会儿
  const tiers: readonly { role: string; effort: 'low' | 'medium' | 'high'; note: string }[] = [
    { role: 'L1', effort: 'low', note: '闲聊与简单问答（内置播种）' },
    { role: 'L2', effort: 'medium', note: '一般任务（内置播种）' },
    { role: 'L3', effort: 'high', note: '复杂任务：架构/长链推理（内置播种）' },
  ]
  for (const tier of tiers) {
    upsertModelRoute(db, {
      role: tier.role,
      rank: 0,
      provider: input.provider,
      model: input.model,
      reasoningEffort: (input.effortByTier ?? true) ? tier.effort : null,
      note: tier.note,
      updatedBy: 'system',
    })
  }
  // 评分器默认复用同一个模型：0.5B 专用评分模型是"有则更好"，
  // 但有太多环境装不下它（§2.13.4 就是为纯 CPU 写的），所以先给一个能用的。
  upsertModelRoute(db, {
    role: 'scorer',
    rank: 0,
    provider: input.provider,
    model: input.model,
    reasoningEffort: 'low',
    note: '复杂度评分器（内置播种：默认复用主模型；装了 0.5B 评分模型后请在面板里改）',
    updatedBy: 'system',
  })
  return {
    seeded: true,
    count: tiers.length + 1,
    reason: `空表 ⇒ 播种 ${String(tiers.length + 1)} 行（L1/L2/L3/scorer → ${input.provider}/${input.model}）；视觉与嵌入需要你指定带 image 能力/给出维度的模型，所以刻意不猜`,
  }
}

/**
 * 判断某个角色的缺失是否**会立刻造成问题**。
 *
 * 面板上不该对七个角色一律喊"还没配置"：视觉/嵌入在没接视觉模型或向量库之前
 * 本来就不需要，把它们标成警告只会让人忽略真正的警告。
 *
 * @param role - 角色。
 * @returns 严重程度与说明。
 */
export function roleGapSeverity(role: string): { readonly level: 'required' | 'optional'; readonly hint: string } {
  switch (role) {
    case 'L1':
    case 'L2':
    case 'L3':
      return { level: 'required', hint: '主对话按档位用它 —— 没有候选就只能一路用宿主的默认模型，降级链也不会生效' }
    case 'scorer':
      return { level: 'required', hint: '复杂度评分器用它 —— 没有候选就永远走启发式兜底（守卫 + 启发式仍可用）' }
    case 'vision':
      return { level: 'optional', hint: '只有要"看图"时才需要，且**必须声明 image 能力**（否则保存会被拒）' }
    case 'embedding':
      return { level: 'optional', hint: '只有要用向量召回时才需要，且**必须给出维度**（否则没法建向量表）' }
    case 'subagent':
      return { level: 'optional', hint: '委派子代理时才需要；建议与主模型**异构**（同模型拿不到独立视角）' }
    default:
      return { level: 'optional', hint: '需要时再配' }
  }
}
