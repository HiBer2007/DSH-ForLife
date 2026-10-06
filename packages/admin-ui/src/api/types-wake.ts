/**
 * 「唤醒」接口返回类型 —— `GET /api/admin/wake` 的契约。
 *
 * 逐字段镜像 `packages/gateway/src/admin/queries-qq.ts` 里唤醒相关的接口
 * （`WakeOverview` / `WakeRuleItem` / `WakeGroup` / `WakeGroupRule` / `WakeEventItem` / `WakeStats`）。
 *
 * 为什么不塞进 `types.ts`：那一份放的是"多个页面共用的小类型"，这一份是单页专属且字段较多。
 * 分开之后，"哪个类型属于哪一页、改接口时该对照哪个文件"一眼可见。
 *
 * 两条从网关注释里搬过来的**契约**（不是实现细节，前端必须照着处理）：
 *  - **可空列表现为"整个键缺席"**（`readonly x?: T`），不是 `null`、也不是空串 ——
 *    例如一条没有静默期的规则根本没有 `quietUntil` 这个键，前端据此显示"—"；
 *  - 判定结果的真实列名就是 **`decision`**（`wake` | `skip`）：`wake_events` 表里
 *    没有 `verdict` 这一列，前端写错名字会拿到 `undefined` 而不是报错。
 */

/** 唤醒规则（`wake_rules` 一行；主键是 `(scope, condition)`）。 */
export interface WakeRuleItem {
  /** `'*'`（全局默认）或 `private:ID` / `group:ID`（只对那一个会话生效的覆盖）。 */
  readonly scope: string
  /** 条件名是**开放集合**（如 `private_message`、`group_message_any`、`bot_offline`），不要按固定清单匹配。 */
  readonly condition: string
  readonly enabled: boolean
  /** 触发概率，**0-100 的整数**（不是 0-1 的比例，展示时要除以 100）。 */
  readonly probability: number
  /** 两次主动说话之间的最小间隔（毫秒）。 */
  readonly minIntervalMs: number
  /** 每日上限；**0 = 不限**。 */
  readonly dailyLimit: number
  /** 静默期截止时间；没有静默期时整个键缺席。 */
  readonly quietUntil?: string
}

/** 分组后的一条条件（同一个 `condition` 在多个 scope 下的合并结果）。 */
export interface WakeGroupRule {
  readonly condition: string
  readonly enabled: boolean
  /** 取的是基准行（scope = `'*'`）的值；没有基准行时退回第一条覆盖行的值。 */
  readonly probability: number
  /** 该条件出现过的**所有** scope（含 `'*'`），顺序即服务端扫描顺序。 */
  readonly scopes: readonly string[]
}

/** 一个会话类型分组。 */
export interface WakeGroup {
  /** `私聊` / `临时会话` / `群聊` / `不分会话类型`；服务端固定返回四个，空组的 `rules` 是空数组。 */
  readonly group: string
  readonly rules: readonly WakeGroupRule[]
}

/** 一次唤醒判定（`wake_events` 一行）。 */
export interface WakeEventItem {
  readonly id: string
  readonly at: string
  readonly scope: string
  readonly condition: string
  /** 真实列名 `decision`：`wake` = 这次会主动说话，`skip` = 这次不说（**不是出错**）。 */
  readonly decision: 'wake' | 'skip'
  /**
   * 判定原因。库里是开放集合，已知取值：
   * `matched` | `disabled` | `probability` | `quiet_hours` | `rate_limit` | `budget`。
   * 前端只翻译认识的几个，其余原样显示（硬编码清单漏一个就会把新原因显示成空白）。
   */
  readonly reason: string
  /** 判定发生在哪个会话；旧的/全局判定没有这个键。 */
  readonly conversationKey?: string
}

/** 唤醒规则计数（**全库口径**，不随 `scope` 过滤参数变化）。 */
export interface WakeStats {
  readonly total: number
  readonly enabled: number
  /** scope 不是 `'*'` 的行数 —— 即"被某个具体会话单独覆盖过"的规则条数。 */
  readonly overridden: number
}

/** 「唤醒」面板的全部数据。 */
export interface WakeOverview {
  readonly rules: readonly WakeRuleItem[]
  /** 规则矩阵按会话类型分组后的视图（含空组）。 */
  readonly groups: readonly WakeGroup[]
  readonly events: readonly WakeEventItem[]
  readonly stats: WakeStats
}
