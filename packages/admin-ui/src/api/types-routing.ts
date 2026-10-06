/**
 * 「路由与端点」页面的接口契约 —— 与 gateway 端 `admin/queries-model.ts` 的 `RoutingOverview`
 * 及其子类型**逐字段对齐**（字段名、可空性、顺序都照抄；改接口时两边对着改）。
 *
 * 为什么不并进 `api/types.ts`：那份是"各页共用的小契约"，而路由这块字段多、坑也深，
 * 单独成文件才写得下下面这两条**必须原样保留**的语义：
 *
 *  1. 所有 `readonly x?: T` 都表示服务端**整个键缺席**（库里的 NULL），不是空字符串、不是 0、
 *     更不是 false。渲染时显示"—"，**不要**用 `?? 默认值` 补一个看起来像真数据的值 ——
 *     "面板上写着 cpu、其实没人说过是 cpu"比"面板上一道横杠"坏得多。
 *  2. 最典型的是 `RoutingEndpoint.healthOk`：缺席 = **从未探测过**，
 *     与 `false`（探测了、不健康）是两件事。混成一种显示，用户就会去修一个根本没坏的东西。
 */

/** 一个候选项 —— 对应 `model_routes` 的一行。 */
export interface RoutingCandidate {
  /** 同一 role 内**越小越优先**：自动降级就是按它依次往下换。 */
  readonly rank: number
  readonly provider: string
  readonly model: string
  /** `model_routes.reasoning_effort`；库里是 NULL 时**键缺席**（不是空字符串）。 */
  readonly effort?: string
  readonly enabled: boolean
  readonly note?: string
}

/** 一个角色及其有序候选。 */
export interface RoutingRole {
  readonly role: string
  /** 组内按 `rank` 升序（rank 越小越优先，这是自动降级的唯一依据）。 */
  readonly candidates: readonly RoutingCandidate[]
}

/** 端点上的一个模型（服务端只保留 id，够面板这一格显示）。 */
export interface RoutingEndpointModel {
  readonly id: string
}

/** 一个推理端点 —— 对应 `inference_endpoints` 的一行。 */
export interface RoutingEndpoint {
  readonly id: string
  readonly type: string
  readonly mode: string
  readonly backend: string
  readonly baseUrl: string
  readonly deployTarget?: string
  readonly deployHost?: string
  /** 解析失败的 JSON 列服务端给 `[]`（不是 undefined），所以这里必有值。 */
  readonly models: readonly RoutingEndpointModel[]
  /** `undefined` = **从未探测过**（不是"不健康"）。 */
  readonly healthOk?: boolean
  readonly healthCheckedAt?: string
  readonly healthLatencyMs?: number
  /** 实际生效的后端：与 `backend` 不一致就是静默回落的证据（配置写 GPU、实际跑 CPU）。 */
  readonly effectiveBackend?: string
  readonly healthNote?: string
  readonly enabled: boolean
  readonly updatedAt: string
}

/** 一条路由决策日志 —— 对应 `routing_log` 的一行。 */
export interface RoutingLogEntry {
  readonly at: string
  readonly tier: string
  /** 判定来源：guard（守卫规则）/ scorer（评分器）/ heuristic（启发式）。 */
  readonly source: string
  /** 命中的守卫规则名；没命中时键缺席。 */
  readonly rule?: string
  /** 0..1；1 表示这一步没有任何不确定性。 */
  readonly confidence: number
  readonly escalated: boolean
  readonly degraded: boolean
  readonly degradeReason?: string
  readonly latencyMs: number
  readonly provider?: string
  readonly model?: string
  readonly switched: boolean
  readonly switchReason?: string
}

/** 一条不确定案例 —— 对应 `uncertain_cases` 的一行。 */
export interface UncertainCaseOverview {
  readonly id: string
  readonly at: string
  readonly textExcerpt: string
  readonly tier: string
  readonly confidence: number
  readonly backend?: string
  /** `pending | reviewed`；前端只认识这两个，遇到别的就照原样显示。 */
  readonly status: string
  readonly suggestion?: string
}

/** 「路由与端点」板块的完整载荷（`GET /api/admin/routing`）。 */
export interface RoutingOverview {
  readonly roles: readonly RoutingRole[]
  readonly endpoints: readonly RoutingEndpoint[]
  readonly log: readonly RoutingLogEntry[]
  readonly uncertain: readonly UncertainCaseOverview[]
  readonly stats: {
    /** 表里的**全部**端点，含已停用（停用不是不存在，用户还得看得见并把它打开）。 */
    readonly endpoints: number
    /** `health_ok = 1` 的端点；从未探测的不算进来，所以它可能小于 endpoints。 */
    readonly healthy: number
    readonly degraded24h: number
    readonly total24h: number
    /** 与 `total24h` 同一窗口，面向它的百分比才有意义。 */
    readonly byTier: readonly { readonly tier: string; readonly count: number }[]
    readonly bySource: readonly { readonly source: string; readonly count: number }[]
  }
}
