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

import {
  endpointModelsJson,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_KEY_ENV,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER,
  planOpenCodeGoRoutes,
  type ReasoningEffort,
  usableModels,
} from '@forlife/contracts'
import { listModelRoutes, upsertEndpoint, upsertModelRoute } from '@forlife/store'

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
  const tiers: readonly { role: string; effort: ReasoningEffort; note: string }[] = [
    { role: 'L1', effort: 'low', note: '闲聊与简单问答（内置播种）' },
    { role: 'L2', effort: 'high', note: '一般任务（内置播种）' },
    { role: 'L3', effort: 'max', note: '复杂任务：架构/长链推理（内置播种）' },
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
    role: 'minimum',
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
    reason: `空表 ⇒ 播种 ${String(tiers.length + 1)} 行（L1/L2/L3/minimum → ${input.provider}/${input.model}）；视觉与嵌入需要你指定带 image 能力/给出维度的模型，所以刻意不猜`,
  }
}

/**
 * 播种 OpenCode Go 接入点（**新方式**，见 `@forlife/contracts/opencode-go`）。
 *
 * ## 为什么与 `seedDefaultRoutes` 分开
 *
 * 那个函数回答的是"宿主用哪个模型，我们就跟着用哪个"；这个回答的是
 * "**我们自带一个可用的外部推理入口**"。两者的触发条件不同（前者总该跑，后者要先有 key），
 * 混在一起会让"没配 key 却被播种了一堆用不了的模型"这种事发生。
 *
 * ## 两条硬规矩
 *
 * 1. **只补空表**：已有任何路由配置就完全不动（与 `seedDefaultRoutes` 同一原则）。
 *    用户手工调过的档位映射比我们的默认值更权威。
 * 2. **不可用的模型不进库**：免费模型一旦过期复核期，`planOpenCodeGoRoutes` 就不会给出它，
 *    所以库里也不会留下一条"看起来能用、其实随时会计费"的候选。
 *
 * @param db - 数据库。
 * @param input - 复核时间与密钥引用名。
 * @returns 结果（含"为什么没播种"）。
 */
export function seedOpenCodeGoRoutes(
  db: DatabaseSync,
  input: { readonly now?: Date; readonly apiKeyRef?: string; readonly replace?: boolean } = {},
): SeedRoutesResult & { readonly endpointId?: string; readonly replaced?: number } {
  const now = input.now ?? new Date()
  const existing = listModelRoutes(db)
  let replaced = 0

  if (existing.length > 0) {
    if (input.replace !== true) {
      return { seeded: false, count: 0, reason: `已有 ${String(existing.length)} 行路由配置，不覆盖（播种只补空表）` }
    }
    // **显式**切换供应商时才替换，而且只删我们自己播的种（`updated_by = 'system'`）。
    // 手工在面板里配的行（updated_by = 'admin'）一律保留 —— 那才是人的意图。
    const removed = db.prepare("DELETE FROM model_routes WHERE updated_by = 'system'").run()
    replaced = Number(removed.changes)
    const kept = listModelRoutes(db).length
    if (kept > 0) {
      return {
        seeded: false,
        count: 0,
        replaced,
        reason: `已清掉 ${String(replaced)} 行系统播种，但仍有 ${String(kept)} 行手工配置 ⇒ 不播种（避免与人的配置打架）`,
      }
    }
  }

  const plan = planOpenCodeGoRoutes(now)
  if (plan.length === 0) {
    return { seeded: false, count: 0, replaced, reason: '没有任何可用模型（免费模型可能已过复核期），不播种' }
  }

  for (const row of plan) {
    upsertModelRoute(db, {
      role: row.role,
      rank: row.rank,
      provider: OPENCODE_GO_PROVIDER,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      note: row.note,
      updatedBy: 'system',
    })
  }

  // 端点也要登记：面板的"推理端点"表读的是这张表，
  // 只在路由表里写模型、不登记端点的话，那一页会显示"0 个端点"却有用不完的候选 —— 自相矛盾。
  const endpointId = upsertEndpoint(db, {
    id: 'ep-opencode-go',
    type: 'cloud-api',
    mode: 'remote-api',
    backend: 'cpu', // 云端托管，backend 对我们无意义；表要求非空，如实填 cpu
    baseUrl: OPENCODE_GO_BASE_URL,
    // **只存引用名**：密钥本身在环境变量/密钥库里，绝不进库
    apiKeyRef: input.apiKeyRef ?? OPENCODE_GO_KEY_ENV,
    models: endpointModelsJson(now).map((model) => ({ ...model })),
    limits: { note: '月度额度按模型计（Go 计划），详见 OpenCode Console' },
    enabled: true,
  })

  const freeSkipped = OPENCODE_GO_MODELS.filter((model) => model.free !== undefined).length - usableModels(now).filter((m) => m.free !== undefined).length
  return {
    seeded: true,
    count: plan.length,
    endpointId,
    replaced,
    reason:
      `播种 ${String(plan.length)} 行（L1/L2/L3/minimum 的降级链）+ 登记端点 ${endpointId}` +
      (replaced > 0 ? `；替换掉 ${String(replaced)} 行旧的系统播种` : '') +
      (freeSkipped > 0 ? `；${String(freeSkipped)} 个免费模型因超出复核期被排除` : ''),
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
    case 'minimum':
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

/**
 * 把 **DeepSeek 官方**追加到 L2/L3/scorer 的降级链**末尾**（用户 2026-10-08 要求）。
 *
 * ## 为什么单独一个函数，而不是塞进 `planOpenCodeGoRoutes`
 *
 * 那个计划回答的是「**OpenCode Go 那个接入点**提供哪些模型」——
 * 往里塞 `deepseek-official` 会让**名字与内容不符**。
 *
 * 而且两个 provider 的**信任模型不同**：
 *   - `opencode-go`：自带的外部入口，**要先有 key**
 *   - `deepseek-official`：**DSH 内置**（`config.ts` 里就是默认值），有 `DEEPSEEK_API_KEY` 就能用
 *
 * ## 为什么是「追加」不是「替换」
 *
 * 用户原话：「L2、3、4 **没有加入**对于 DS 官方的 API 路由。**补充**」——
 * 要的是**多一个候选**。⇒ `rank` 接着该档位现有最大值往上排，**一定排在最后**。
 *
 * ## 幂等
 *
 * 已有 `deepseek-official` 行时直接返回，不重复插。
 *
 * @param db - 数据库。
 * @param input.apiKeyRef - 凭据**引用名**（默认 `DEEPSEEK_API_KEY`）。
 *   环境里没有它 ⇒ **不播种**（播了也是死候选，只会在路由时白撞一次）。
 */
export function seedDeepSeekFallback(
  db: DatabaseSync,
  input: { readonly apiKeyRef?: string } = {},
): { readonly seeded: boolean; readonly count: number; readonly reason: string } {
  const apiKeyRef = input.apiKeyRef ?? 'DEEPSEEK_API_KEY'
  if ((process.env[apiKeyRef] ?? '') === '') {
    return { seeded: false, count: 0, reason: `没有设 ${apiKeyRef} ⇒ 不播种死候选` }
  }

  const existing = listModelRoutes(db)
  if (existing.some((row) => row.provider === DEEPSEEK_OFFICIAL_PROVIDER)) {
    return { seeded: false, count: 0, reason: `已有 ${DEEPSEEK_OFFICIAL_PROVIDER} 的行，不重复追加（幂等）` }
  }

  let count = 0
  for (const spec of DEEPSEEK_FALLBACK_ROLES) {
    const sameRole = existing.filter((row) => row.role === spec.role)
    const nextRank = sameRole.reduce((max, row) => Math.max(max, row.rank), -1) + 1
    upsertModelRoute(db, {
      role: spec.role,
      rank: nextRank,
      provider: DEEPSEEK_OFFICIAL_PROVIDER,
      model: DEEPSEEK_OFFICIAL_MODEL,
      reasoningEffort: spec.effort,
      note: spec.note,
      updatedBy: 'system',
    })
    count += 1
  }

  return {
    seeded: true,
    count,
    reason: `追加 ${String(count)} 行 ${DEEPSEEK_OFFICIAL_PROVIDER}/${DEEPSEEK_OFFICIAL_MODEL} 到 L2/L3/scorer 末尾`,
  }
}

/** DSH 内置 provider 的 id（与 `config.ts` 的默认值一致）。 */
const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'

/** 它默认用的模型（与内置播种落库的值一致）。 */
const DEEPSEEK_OFFICIAL_MODEL = 'deepseek-flash'

/**
 * 要补的档位 —— **用户点名 L2/L3/scorer**。
 *
 * **L1 刻意不加**：L1 的场景是「闲聊与简单问答：**快且强**」，
 * 而跨 provider 的兜底在延迟上更差 ⇒ 加了反而拖慢最常见的那条路径。
 */
const DEEPSEEK_FALLBACK_ROLES: readonly { readonly role: string; readonly effort: string; readonly note: string }[] = [
  { role: 'L2', effort: 'high', note: '兜底：DS 官方（跨 provider，opencode-go 抖动时顶上）' },
  { role: 'L3', effort: 'max', note: '兜底：DS 官方（跨 provider，长链推理的第二个来源）' },
  { role: 'minimum', effort: 'low', note: '兜底：DS 官方（评分器的高频小请求）' },
]
