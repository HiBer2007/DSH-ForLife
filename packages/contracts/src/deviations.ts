/**
 * 偏离登记处（**唯一**允许偏离设计文档的地方）。
 *
 * 分两类：
 *  - `DEVIATIONS`：**数值/配置**偏离（针对 `doc` 来源的基线参数）。目前为**空**，说明
 *    PLAN.MD / 模型路由.MD 里的每个可调项都按原值实现；
 *  - `RULE_DEVIATIONS`：**规则级**偏离（文档里的行为约定，没有对应的数值参数）。
 *
 * `test/fidelity.test.ts` 会校验：
 *   ① `DEVIATIONS` 的键必须存在、必须属于 `doc` 来源、值必须真的与基线不同；
 *   ② 未被登记的 `doc` 参数，生效值必须**严格等于**基线值；
 *   ③ `RULE_DEVIATIONS` 必须写清"文档怎么说 / 我们怎么做 / 为什么 / 谁批的"。
 *
 * ⚠️ **上面这三条拦不住的一类问题**（2026-10-06 核对实测）：`fidelity.test.ts` 断的是
 * `defaultFor(key) === baselineValue(key)`，也就是**JSON 对自己** —— 它证明不了"这个参数
 * 真的被代码消费了"，也看不见"部署里真正生效的值"（例：`compaction.autoTriggerRatio`
 * 基线 0.5，而代码从不设置 `thresholdRatio`、四个 profile 也不设，于是生效值是宿主
 * `dsh-compaction-basic` 的常量 **0.8** —— fidelity 全绿，bug 照旧）。
 * 守这两件事的是另外两条接线守卫：
 *   - `packages/contracts/test/param-consumption.test.ts`（关键 `doc` 参数必须在**代码**里有消费点）；
 *   - `packages/dsh-component/test/compaction-threshold.test.ts`（真机装配后断言**生效阈值**）。
 *
 * @module @forlife/contracts/deviations
 */

/** 一条数值偏离。 */
export interface Deviation {
  /** 基线参数键（必须是 doc 来源）。 */
  readonly key: string
  /** 我们实际采用的值。 */
  readonly value: unknown
  /** 为什么要偏离。 */
  readonly reason: string
  /** 依据（文档章节 / 实测数据 / 用户决定）。 */
  readonly approvedBy: string
}

/** 一条规则级偏离：文档写了一条规则，我们有受控的例外。 */
export interface RuleDeviation {
  /** 文档里的规则（引用到章节）。 */
  readonly rule: string
  /** 我们实际的做法。 */
  readonly behavior: string
  /** 为什么必须有这个例外。 */
  readonly reason: string
  /** 谁批准的。 */
  readonly approvedBy: string
}

/**
 * 数值偏离：目前**没有**。
 *
 * 这本身是一个可断言的结论 —— "PLAN.MD 与 模型路由.MD 里的每个可调项都按原值实现"。
 *
 * 关于阶段的预评分软预算：它**不是**数值偏离。文档里唯一的评分时间预算
 * （`router.scorer.timeoutMs` = 50ms 硬超时）**一分未改**；软预算是我们**新增**的
 * 另一条路径上的参数（design 来源，`router.preScore.softBudgetMs`）。
 * 把它登记成数值偏离会误导 —— 它会让人以为"文档的 50ms 被改成了 800ms"，
 * 而事实是两条路径并存。所以它进 `RULE_DEVIATIONS`（规则级例外）。
 */
export const DEVIATIONS: readonly Deviation[] = []

/**
 * 规则级偏离：允许受控例外，但必须显式登记。
 */
export const RULE_DEVIATIONS: readonly RuleDeviation[] = [
  {
    rule: '模型路由.MD §5.3 / §8.5：评分在同步路径上、50ms 未返回就降级到启发式',
    behavior:
      '**两条路径并存**：① 同步兜底路径仍是文档原值 **50ms 硬超时 → 启发式**（一分未改）；' +
      '② **新增**预评分路径，在防抖窗口（2–3 s）内把评分跑完（`router.preScore.softBudgetMs` = 800ms，' +
      'design 来源参数）。超软预算的结果仍可用，但会标 `slowPreScore` 以便发现"窗口没盖住它"。',
    reason:
      '纯 CPU 环境下 0.5B Q4 有相当概率逼近或超过 50ms；若只有同步路径，"评分由 L1 模型主导"这条' +
      '核心决策等于被废掉（几乎永远落到启发式兜底）。文档 §8.5 自己给了 T14（防抖期间预评分），' +
      '所以这不是违背文档，而是启用文档已经给出的手段。',
    approvedBy: 'EXECUTION_PLAN §2.13.4（明写"必须登记"）',
  },
  {
    rule: 'PLAN.MD §8.6 / §9.2：同一逻辑轮次内模型固定，路由决策在轮次开始时做一次',
    behavior:
      '主动切换仍然禁止（§2.18.2 用"理由 + 冷却 + 预算 + 提示词明示切换贵于委派"卡住）；' +
      '仅当 provider 无额度/失败导致轮次无法完成时，允许**被动**降级到下一个模型（routing.failover），' +
      '并沿用同一风格段、对齐 temperature/maxTokens，全部落 routing_log。',
    reason:
      '"轮次内不换模型"的目的是避免语气与推理风格断裂；而 provider 不可用是硬约束，' +
      '不降级就等于整轮失败，对用户更糟。被动降级的断裂风险由"同一风格段 + 参数对齐"控制。',
    approvedBy: 'EXECUTION_PLAN §2.18.1（用户明确要求：provider 没额度/失败时按指定顺序自动切换）',
  },
  {
    rule:
      'PLAN.MD §4.2 Step 2 / §10.4：压缩请求是**独立调用** ——「不复用主对话缓存」「压缩独立调用，不污染主对话缓存」；' +
      '请求块顺序为 [稳定 system + tools] → [当前中期记忆渲染全文] → [中期记忆条目化版本] → [完整短期记忆轨迹] → [压缩指令 + 输出格式]。',
    behavior:
      '**块顺序被改写 + 有意复用主对话前缀**（两件事同源，故合并登记）：' +
      '`buildCompactionInstruction()`（`dsh-component/src/compaction-engine.ts:143`）把「L3 渲染全文 + 条目化清单 + 触发原因 + 指令」' +
      '**合并成尾部一条 user 消息**：`INSTRUCTION_TAIL` 与 L3 渲染全文都在这一块里；' +
      '`summarize()`（`:427-435`）则把 `SummarizationInput.messages`（宿主给的"派生 system 头 + 被遮蔽区域"，按表面顺序）**原样重放**当前缀。' +
      '⇒ 压缩请求的前缀与主对话**逐字节对齐**、命中同一份暖前缀缓存；它**不是** PLAN 意义上的独立调用。' +
      '（信息没丢：五段内容都在，只是排布从"五段"变成"前缀 + 尾部指令块"。）',
    reason:
      '摘代码注释里的理由 —— `compaction-engine.ts:11-16`：「`SummarizationInput.messages` 已经是"派生的 system 头 + 被遮蔽区域，按表面顺序"，' +
      '所以**原样重放**它、把我们的压缩指令**追加为最后一条 user 消息**，前缀就与主对话逐字节对齐 ⇒ 供应商的暖前缀缓存能命中，只有尾部指令是新的输入。」' +
      '又 `:132-137`：「这两块按 PLAN §4.2 属于压缩请求的输入；我们把它们并入尾部指令块而**不是**插到轨迹之前 —— 因为插到前面会在那一点打断前缀，让暖缓存失效。' +
      '这是刻意的取舍：§4.2 的块顺序 vs 交付物 2 明确要求的"复用对话自身前缀以免多打掉 KV cache"，**后者优先**。」' +
      '代价如实写明：① §10.4 的"不污染主对话缓存"做不到（压缩那次调用与主对话共享同一份缓存条目）；' +
      '② 因为必须复用主对话前缀，压缩不能换一套 system/tools/块顺序。',
    approvedBy:
      '交付物 2（"复用对话自身前缀"是硬要求，由它压过 §4.2 的块顺序）；2026-10-06 1:1 保真度核对据代码注释补登（审计 docs/audit/PLAN_FIDELITY_AUDIT.md §7.4 指出该偏离此前未登记）。',
  },
  {
    rule:
      'PLAN.MD §9.2 场景映射（+ §4.2 Step 2 括注）：**压缩事件 → L3 + 高推理强度**（"可用强模型 + 高推理强度"）。',
    behavior:
      '压缩请求**不设置 reasoning effort**：`summarize()` 的 `streamOptions`（`dsh-component/src/compaction-engine.ts:439-447`）只有 ' +
      '`provider / model / messages / toolHistory / maxTokens / sessionId / purpose / tools / signal`；' +
      '`resolveProvider()` / `resolveModel()`（`:498-513`）缺省跟随 `agent.options.provider/model`，即**当前轮主对话的模型**（四个 profile 也都没设 `summarizationProvider/Model`，已核）。' +
      '⇒ 实际是"当前轮模型 + 当前轮推理强度"：既不是 L3 档，也不是高推理强度。' +
      '路由器里已有的 L3 规则也接不上：`router/src/guards.ts:98` 的 `isCompressionTask → L3` **没有任何生产调用方传这个标志**；' +
      '`router/src/subagents.ts:39` 的 `ROLE_TIER.compaction = L3` 只被 `assignSubagent` 使用，而后者生产零调用。',
    reason:
      '**与上一条同源**：跟随当前轮 provider/model 正是"复用主对话前缀缓存"的前提 —— 一旦为压缩换模型/换供应商，那份前缀缓存必然失效，' +
      '压缩会把主对话的 KV cache 打掉一次（恰是交付物 2 要避免的）。此外 `ctx.llm.stream()` 这条路径上**当前没有传 `reasoningEffort` 的接线**，' +
      '要按 §9.2 实现必须同时改路由（选 L3 模型）与请求参数 —— 属于"会影响缓存性能"的改动，' +
      '而本轮核对的口径是**登记而不改**（改了会动缓存行为，不是纯保真度修复）。',
    approvedBy:
      '2026-10-06 1:1 保真度核对：用户明确"**不要擅自改**（这是有意的设计取舍，改了会影响缓存性能）"，只登记。',
  },
]

/** 按 key 建索引，便于测试与 defaults 应用。 */
export function deviationMap(): ReadonlyMap<string, Deviation> {
  const map = new Map<string, Deviation>()
  for (const d of DEVIATIONS) {
    if (map.has(d.key)) throw new Error(`deviations 中存在重复键：${d.key}`)
    map.set(d.key, d)
  }
  return map
}
