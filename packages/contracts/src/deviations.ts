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
 *   ③ `RULE_DEVIATIONS` 必须写清"文档怎么说 / 我们怎么做 / 为什么 / 谁批的"；
 *   ④ `RULE_DEVIATIONS` 的 `rule` 必须**引用到具体章节**（含 `§`）、不得逐字重复，
 *      且条数不得低于防误删下限（否则"登记表被清空"与"没有偏离"从测试上看一模一样）。
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
 * ⚠️ 但"按原值实现"**不等于**"被消费/生效"：`compaction.autoTriggerRatio` 曾经就是
 * "基线 0.5、代码零引用、部署里实际生效 0.8"（见文件头的 ⚠️）。守"被消费"与"生效值"的是
 * 另一对守卫：`test/param-consumption.test.ts` 与 `dsh-component/test/compaction-threshold.test.ts`。
 * 所以 `DEVIATIONS` 为空只说明"没有改动文档数值"，不说明这些数值真的在跑。
 *
 * 关于阶段的预评分软预算：它**不是**数值偏离。文档里唯一的评分时间预算
 * （`router.minimum.timeoutMs` = 50ms 硬超时）**一分未改**；软预算是我们**新增**的
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
    rule: 'PLAN.MD §8.6 / §9.2：同一逻辑轮次内模型固定（qq_reply 等也要求"同轮次"以保持语气一致），路由决策在轮次开始时做一次。',
    behavior:
      '**受控允许主动切换**（这是真实存在的例外）：`switch_model` / `revert_model` / `router_status` 三个工具' +
      '**已注册进生产**（`dsh-component/src/index.ts:571-633`）；`switch_model` 只能**往上**切（L2/L3）、' +
      '理由太短直接拒、受冷却与每小时预算限制（`router.switch.cooldownMs` / `router.switch.perHour`）、' +
      '每次裁决都写 `routing_log`、并可用 `revert_model` 撤销（`router-tools.ts:54-91` 与 `applySwitch()` `:185-240`）。' +
      '⚠️ **本次核对据实删掉了原登记里两处不成立的主张**：' +
      '① 「主动切换仍然禁止」—— 不成立：上面的工具是活的，且有测试断言它生效（审计 §3 第 20 条）；' +
      '② 「provider 无额度/失败时允许被动降级（routing.failover）」—— **生产未接线**：' +
      '`buildFailoverRuntime()`（`router-hooks.ts:143`）只被 `test/failover-wiring.test.ts` 调用，' +
      '没有任何生产代码订阅宿主的 `agent/request-error`，`FailoverDecision.next` 也没有消费者。' +
      '那不是「已生效的例外」而是**待接线的缺口**，留在偏离登记里会让人以为它存在（审计 §7.4 与 §4 第 20 条）。' +
      '另有一处同源的现状必须说清：`switch_model` 只写 `tierOverride` + `routing_log`，' +
      '而「轮次开始时按档位选模型」这条链路本身在生产里尚未接线（`defaultRouteEntries` / `new Router(` / ' +
      '`lockTierForTurn` 均无生产调用方）⇒ 这个例外当前还**没有真正改变过任何一次请求的模型**。',
    reason:
      '「轮次内不换模型」要防的是语气与判断标准断裂。而用户明确要求（EXECUTION_PLAN §2.18.1 / §2.18.2）：' +
      '模型遇到确实超出当前档位的问题时应当能申请换更强的档位 —— 否则它只能硬答或委派，' +
      '而「委派也解决不了」正是这种场景的典型形态。所以取舍是：**允许往上切，但把代价显式化** ——' +
      '必须给理由（理由会进日志与审计）、有冷却与每小时预算、提示词里写明「切换贵于委派」（会作废已积累的缓存）、' +
      '并且随时可撤销。代价：① 轮次中途换档确实会让同一轮里出现两种语气/判断标准；' +
      '② 换档会打掉一次前缀缓存（与 §10.4 的成本模型叠加）；③ 往下切是禁止的 —— 省成本该由档位自动判定做，不是模型能选的。',
    approvedBy:
      'EXECUTION_PLAN §2.18.1 / §2.18.2（用户明确要求：可以主动换更强的模型，但必须受控）；2026-10-06 1:1 保真度核对据代码改正原登记（审计 §3 第 20 条 + §7.4：原登记「两个方向都错了」）。',
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
  {
    rule:
      'PLAN.MD §2.2「渲染视图」要求「只渲染 compaction_epoch = current 的 active + fragmented 条目」，' +
      '而 §1.2 与 §4.2 Step 4 又要求「push_to_mid 条目追加到中期表、compaction_epoch += 1、渲染到 L3 尾部」' +
      '——即 **L3 跨压缩累积**。两处对 epoch 语义的要求正好相反（PLAN 内部矛盾，审计 §5 第 7 条也点了名）。',
    behavior:
      '代码选了「**累积**」这一支：`listRenderableMidEntries()`（`store/src/repository.ts:221-229`）只按 status 过滤、' +
      '**不按 epoch 过滤**；`runtime.listEntries()`（`dsh-component/src/runtime.ts:415-433`）默认也列全部 epoch。' +
      '`runtime.renderView()`（`runtime.ts:287-290`）走的就是前者 ⇒ 这是**生效路径**，不是死代码。' +
      '为了让「这条产生于哪次压缩」仍可溯源（`compaction_epoch` 的另一个用途），压缩事务里**先 `bumpEpoch` 再 push**' +
      '（`compaction-engine.ts:220-236`），新条目因此落在新 epoch —— 这与 §4.2 Step 4 的字面顺序（先 push 后 +=1）相反。',
    reason:
      '若按 §2.2 的字面过滤，**第一次压缩之后整个 L3 会立刻变空**（新条目还没写、旧条目全被过滤掉），' +
      '那与 §1.2 / §4.2 的「L3 跨压缩累积」直接冲突，等于每次压缩都把中期记忆清空 —— 这个坑实测踩到过，' +
      '`repository.ts:210-220` 与 `runtime.ts:415-421` 都记录了当时的推理。反过来，要让「新条目落在新 epoch」成立，' +
      '就只能先推进 epoch 再写条目。代价如实写明：① §2.2 的字面被违背，「当前窗口」退化成了「全部历史」，' +
      '按窗口算的中期预算（`fragment.activeBudgetRatioMin/Max`）算的是全量而不是当前窗口；' +
      '② `window_offset` 仍按 epoch 分桶（`repository.ts:169` 的 `max(window_offset)` 限定在当前 epoch），' +
      '压缩后新条目从 offset 0 重新开始，渲染时**排在旧条目之前**，「追加到 L3 尾部」的次序保证因此不成立' +
      '（审计 §3 第 2 条）—— ⚠️ **那不是本登记的许可范围**，而是本取舍的待修副作用' +
      '（把 `max(window_offset)` 的作用域从「当前 epoch」改为全表即可，修它不需要改本登记）。',
    approvedBy:
      '阶段 2 的修正（`repository.ts:210-220` 的注释即当时的决定记录，另有 `store/test/store.test.ts:165-179` 的渲染视图用例）；' +
      '2026-10-06/07 1:1 保真度核对（审计 §3 第 1、7 条）据代码补登 —— 规格方尚未裁定 §2.2 与 §4.2 谁优先，' +
      '本条登记的是「代码当前选了哪一支」。',
  },
  {
    rule:
      'PLAN.MD §2.1（mid_memory_entries）、§4.5（compaction_log）、§6.1（long_memory_entries）的建表 SQL：' +
      '时间列写 `TIMESTAMP`、布尔列写 `approved BOOLEAN`，且除主键外**没有 NOT NULL / DEFAULT**。',
    behavior:
      '落库时映射成 SQLite 的存储类（`store/src/migrations.ts:36-56` / `:63-84` / `:86-100`）：' +
      '`TIMESTAMP → TEXT`（ISO-8601 UTC 字符串，统一由 `nowIso()` 写入）、`BOOLEAN → INTEGER`（0/1，' +
      '`migrations.ts:89` 就写着 `-- BOOLEAN`；读取侧在 `gateway/src/admin/queries-memory.ts:318` 再转回真 boolean）；' +
      '并对「任何写入路径都必须给值」的列加了 `NOT NULL`（其中 `entities` / `token_count` / `compaction_epoch` / ' +
      '`source_short_ids` / `storage_tier` / `revision` 带 `DEFAULT`）。',
    reason:
      '① SQLite 没有原生 BOOLEAN 与时间类型（只有 NULL/INTEGER/REAL/TEXT/BLOB 五个存储类），`node:sqlite` 的参数绑定' +
      '只接受 null/number/bigint/string/Uint8Array —— `TIMESTAMP`/`BOOLEAN` 写进 DDL 也只是类型亲和性声明，' +
      '写成 TEXT/INTEGER 才能让「写进去的是什么、读出来的是什么」一目了然；' +
      '② NOT NULL 是**收紧**而不是放松：这些列若为 NULL，渲染（`renderMidMemory` 直接读 `entry.summary`）、' +
      '统计（`midStats` 的 sum）与面板都会静默出错，而在写入点直接报错能立刻暴露问题；' +
      '③ 字段名与 PLAN 逐字一致，没有新增/改名（我们自己的两个列 `revision` / `source_scope` 在 `migrations.ts:52-55` ' +
      '显式标了 `[design]` 并写了出处）。代价：① 每个读 0/1 布尔的地方都必须显式转换，漏转就会把 `1`/`0` 渲染给用户' +
      '（`admin-ui` 侧已有专门用例守这条）；② 时间列是文本，按时间排序/比较依赖写入方始终用同一种 ISO 格式' +
      '（本仓统一走 `nowIso()`，但数据库层没有约束）。',
    approvedBy:
      '阶段 0 建表时决定（`migrations.ts:1-9` 的模块头「字段与 PLAN.MD 原文一比一」+ `store/test/store.test.ts:112` 的列清单断言）；' +
      '2026-10-06 1:1 保真度核对（审计 §3 第 3 条）据 DDL 补登。',
  },
  {
    rule:
      'PLAN.MD §6.3「全文与向量迁移到 HDD 归档目录（**Parquet** + 向量索引文件）」/ §13 阶段五第 16 项' +
      '「HDD 归档目录与 **Parquet** 导出」。',
    behavior:
      '导出格式是 **NDJSON + manifest**：`archiveEntries()`（`store/src/archive.ts:80-160`）写出 `entries.ndjson`' +
      '（一行一条）与 `manifest.json`（列名与类型、行数、字节数、内容 sha256）；`readArchive()`（`:163-193`）读回时' +
      '**先校验 sha256 再解析**；`ArchiveManifest.format` 写死 `ndjson`，读的人不必猜格式。' +
      '模块头（`:4-21`）自己就标着「⚠️ 与 PLAN 的一处偏离，必须说清」。',
    reason:
      '① 仓库里没有任何 Parquet/Arrow 依赖（`packages/store/package.json` 只依赖 `@forlife/contracts`）；' +
      '② 手写 Parquet 写入器要自己实现 Thrift 紧凑协议的文件元数据与列块编码（PLAIN/RLE/字典），' +
      '**一个字段偏移写错，产出的就是「看起来像 Parquet 但读不出来」的文件** —— 而归档的用途正是「很久以后才回来读」，' +
      '那种失败要几个月后才暴露；③ 归档的价值在「数据完整 + 能读回来」而不在格式：NDJSON 任何语言都能读，' +
      'manifest 记下了列名与类型，将来要转 Parquet 时有依据（加一个 `toParquet(archiveDir)` 转换器即可，' +
      '当前实现不挡这条路）。代价：① 没有列式压缩，归档体积比 Parquet 大；' +
      '② PLAN 里「向量索引文件」那一半没有落地（向量索引本身尚未实现）；' +
      '③ 任何按 Parquet 写的运维脚本/文档都要改。',
    approvedBy:
      '`store/src/archive.ts:4-21` 的模块头（代码自认偏离并写明理由）；2026-10-06 1:1 保真度核对把它补登进本表' +
      '（审计 §3 第 13 条 + §7.4 指出它此前未登记）。',
  },
  {
    rule:
      'PLAN.MD §6.3：沉降时「全文迁移到 HDD 归档目录」，并把归档位置记下来供回读' +
      '（`recall_longterm` 命中 HDD 条目时按需加载）。',
    behavior:
      '**一条一个文件**：`settleLongEntries()`（`store/src/long-settle.ts:160-241`）把单条条目的正文写成' +
      '`<cold 根>/longterm/<安全 id>-<sha1(id) 前 8 位>.txt`（`longArchivePath()` `:139-146`），' +
      '写后**读回校验 sha256**，通过才 `markLongSettled()`（content 置空 + storage_tier=hdd + archive_path）；' +
      '**不复用** `archive.ts` 的批量 NDJSON 导出。顺序纪律：先写归档、读回校验、最后才置空' +
      '（写失败/校验不过 ⇒ 删掉半成品文件、库内正文不动、下一轮可重试）。',
    reason:
      '`loadLongEntry` 的契约（`store/src/cold-load.ts` 模块头）是「`archive_path` 指向的那个文件**就是这条的正文**」。' +
      '若把批量 NDJSON 的路径写进 `archive_path`，回读会把**整个归档文件**当成这一条的正文 —— 那比「读不出来」更糟：' +
      '它是**静默返回错误内容**（模型会把别人的记忆当成这一条）。所以批量导出（交付物 3，给人看/给将来转 Parquet）' +
      '与按条沉降（把这一条的正文搬走）必须是两件事、两套文件。代价：① 冷层目录是 N 个小文件，没有批量导出的紧凑与列式压缩；' +
      '② 每条一次「写 + 读回」，IO 次数是批量导出的两倍；③ 文件名做了安全化与 sha1 去重，' +
      '人从文件名认不出内容（要靠 `archive_path` 列或面板）。',
    approvedBy:
      '2026-10-07 接线修复时落地（`long-settle.ts` 与 `gateway/src/settle-loop.ts` 同批交付，' +
      '`store/test/long-settle.test.ts` 覆盖写失败/校验不过/重复沉降）；按 `cold-load` 的既有契约登记，不是新决定。',
  },
  {
    rule:
      'PLAN.MD §4.4：短期占比 ≥ 75%（`emergencyBypassRatio`）时**绕过冷却期**；最小内容阈值' +
      '（`minTokens` / `minTurns` / `minToolCalls`）仍然适用。',
    behavior:
      '`decideCompaction()`（`memory-core/src/compaction.ts:96-117`）在 `pressure = shortRatio >= emergencyBypassRatio` 时' +
      '**同时**跳过「太薄」判定：`if (!tokenOk || !turnsOk || !toolsOk) { if (!pressure) return too_thin … }` ——' +
      '占比告急时即便内容很薄也放行，并在 `CompactionVerdict.waiver` 里标出命中的是 `context_pressure`。' +
      '测试固化在 `memory-core/test/compaction.test.ts`（`shortTokens: 500` / `shortRatio: 0.9` 的用例直接断言 approved）。',
    reason:
      '「上下文马上要爆」与「内容还不够厚」同时成立时，**爆掉是不可逆的**（超窗会被截断或整轮失败），' +
      '而压得薄一点只是这次摘要信息少一些（以后还能再压）。豁免冷却期的理由（别让流程卡在安全阀前面）' +
      '对最小内容阈值同样成立 —— 只豁免一半等于安全阀被另一半卡住。代价：① 极端情况下会产出很薄的压缩' +
      '（`keep_in_short` 近乎空），那次压缩收益接近 0，却仍消耗一次模型调用与一次缓存未命中；' +
      '② 与 §4.4 的字面不一致，面板/日志解释「为什么这次能过」时必须指出命中的是 `context_pressure`。',
    approvedBy:
      '`memory-core/src/compaction.ts:106-117` 的注释（「占比告急时即便薄也放行：宁可压缩得薄一点，也不能让上下文爆掉」）' +
      '+ `memory-core/test/compaction.test.ts` 的固化用例；2026-10-06 1:1 保真度核对（审计 §3 第 8 条）补登。',
  },
  {
    rule:
      'PLAN.MD §5.3 第 4 层：「最久未访问且 hint 已泛化的碎片标记 `archived`，从渲染移除（**表保留，可恢复**）」；' +
      '§12 的时机 T6 同义。',
    behavior:
      '`evictFragments()`（`store/src/fragment-maintenance.ts:168-207`）对可淘汰碎片执行 **`DELETE FROM mid_memory_entries`' +
      '（真删行）**。红线（`:10-17`）：只删 `status = fragmented`、必须 `fragmented_into` 非空且**那条长期记忆还在**' +
      '（归宿没了的「孤儿碎片」必须留着），并且有保留期（默认 30 天）与单次上限（200 条）。' +
      '因此 `mid_memory_entries.status` 的 `archived` 取值在生产里**从未被写入**，也没有任何「从 archived 恢复」的入口 ——' +
      '淘汰是不可逆的。',
    reason:
      '碎片行是**指针**：正文已经在那条长期记忆里（`fragmented_into`），保留行只保留指针、不保留任何别处没有的数据；' +
      '而「永久保留」意味着 L3 索引只增不减，§5.3 第 2 层的占比上限迟早只能靠「不新增碎片」来维持（那等于废掉碎片机制）。' +
      '所以取舍是：过了保留期、且归宿确认还在，就真删。代价如实写明：① PLAN 的「表保留、可恢复」做不到 ——' +
      '删掉之后**按碎片 id 回查是不可能的**（只能拿内容去长期记忆里检索）；② `archived` 成了死枚举值，mid 侧没有恢复入口；' +
      '③ 若那条长期记忆**之后**也被删（面板手工删/回滚），碎片行已经不在，就没有第二份指针了 ——' +
      '「归宿不存在就不删」的红线覆盖不到「先删碎片、后删长期记忆」这个顺序。',
    approvedBy:
      '`store/src/fragment-maintenance.ts:1-27` 的红线说明（「淘汰：真的删行 —— 动数据，所以要过红线」）' +
      '+ `store/test/fragment-maintenance.test.ts`；2026-10-06 1:1 保真度核对（审计 §3 第 12 条）补登。' +
      '若规格方坚持「表保留」，那要改代码（改成标 archived），不是维持本登记。',
  },
  {
    rule: 'PLAN.MD §8.1 工具集：`qq_reply(text, reply_to?)` / `qq_react(emoji, msg_id?)` / `qq_typing(on/off)`。',
    behavior:
      '实际签名（`dsh-component/src/qq-tools.ts:89-262`）：三者都多一个**必填**参数 `conversation`（目标会话键，' +
      '形如 `onebot11:88888`，**没有隐式默认**）；`qq_reply` 另加可选 `at`（@ 某人列表）；`qq_react` 的 `msg_id` ' +
      '改名 `message_id` 且由可选变**必填**；`qq_typing` 的 `on/off` 变成布尔 `on`（私聊才支持，群聊如实返回 supported=false）。',
    reason:
      '① `conversation` 必填来自**用户的明确要求**（`qq-tools.ts:11-14`：「一个模型窗口同时处理多个会话，' +
      '且 `qq_reply` 必须指定目标会话」）—— 猜错目标在群里是灾难性的，所以宁可要参数也不要默认值；' +
      '② `message_id` 与 OneBot v11 的字段名一致，且「回应一条不知道 id 的消息」本身没有意义，所以必填；' +
      '③ `on/off` 在工具 schema 里用 `type: boolean` 表达最直接，避免模型传字符串 `off` 后被宿主 schema 拒。' +
      '代价：与 PLAN §8.1 的字面签名不同 —— 任何照 PLAN 写的调用示例/提示词都会缺 `conversation` / `message_id` ' +
      '而被拒；这是有意的（宁可报错，也不猜目标）。',
    approvedBy:
      '`qq-tools.ts:11-14` 的用户要求原文 + `dsh-component/test/qq-tools*.test.ts`；' +
      '2026-10-06 1:1 保真度核对（审计 §3 第 16 条）补登。',
  },
  {
    rule:
      'PLAN.MD §9.1 三档分类：L1 轻「小模型（7B-14B）」、L2 中「中等模型」、L3 强「前沿模型」——' +
      '档位之间的差别首先是**模型不同**。',
    behavior:
      '生产播种把 L1/L2/L3（以及 scorer）指向**同一个** provider/model：`seedDefaultRoutes()`' +
      '（`dsh-component/src/route-seed.ts:64-106`）与 `seedOpenCodeGoRoutes()`（`:128-198`）都按同一个 provider/model ' +
      '写满这些角色，档位之间只差 `reasoning_effort`（L1 low / L2 high / L3 max；`router/src/routes.ts:122-124` 同样）。' +
      '`model_routes` 是**有序**候选表，用户可以在面板给 L3 追加一行更强的模型。',
    reason:
      '本项目实际被授权使用的模型只有云端 flash 级（`contracts/src/opencode-go.ts` 的清单：deepseek-v4.1-flash / v4-pro / ' +
      'glm-5.3-flash / glm-5.3 + 两个限时免费），**没有部署 7B-14B 本地小模型**，也不该为了「档位齐全」去登记未授权的模型' +
      '（「能用 ≠ 允许用」是那份清单的原则）。所以档位退化成「推理强度的软分级」，模型选择交给 `model_routes` 的有序表 ——' +
      '这正落在 §9.4 的「软分级」上。代价：① §9.1 的硬分级（L3 一定比 L2 强）在单模型部署下不成立：L3 只是「想得更久」；' +
      '② L1 的简单问题也走同一个云端模型（不是本地小模型），成本按 token 计、省不下来；' +
      '③ 「换更强的模型」是运维动作（面板加行或改 profile），不是自动的 —— 自动化要等真实的多模型接入。',
    approvedBy:
      '`dsh-component/src/route-seed.ts:22-24` 的注释（「三档都指向同一个模型的理由：档位只影响 reasoningEffort……' +
      '只有一个模型可用时，这是唯一合理的行为」）+ `route-seed` / `route-seed-opencode` 测试；' +
      '2026-10-06 1:1 保真度核对（审计 §3 第 21 条）补登。',
  },
  {
    rule: 'PLAN.MD §9.4：在选定模型上按任务难度动态调整 reasoning effort，值域 `off / low / medium / high / max`。',
    behavior:
      '类型与请求参数只用四值 `none | low | high | max`（`contracts/src/opencode-go.ts:43-53` 的 `ReasoningEffort`，' +
      '注释里逐模型列了值域）；`profiles/*/cordis.patch.yml` 对每个模型**显式声明** `reasoningEfforts`' +
      '（如 `forlife-qq/cordis.patch.yml:81-117`）；档位映射用 low/high/max（`router/src/routes.ts:122-124`）；' +
      '子代理分模型时只从「该模型声明的合法集合」里取，取不到就**不传**（`router/src/subagents.ts:142-155`）。',
    reason:
      '值域来自各模型官方文档，不是猜的：`deepseek-v4.1-flash` 是 none/low/high/max，`glm-5.3-flash` 只有 low/high/max，' +
      '**没有 `medium`**；PLAN 的 `off` 在本项目接入的 provider 上对应 `none`（关闭思考）。而且这件事**不能靠实测判定**：' +
      '模型为了兼容会接受不存在的档位并静默忽略，HTTP 200 不能当作「该档位存在」的证据（踩过这个坑，' +
      '已写进 `opencode-go.ts:49-51` 的注释）。代价：① 与 §9.4 的字面值域不同（少 `medium`、首值叫 `none` 而不是 `off`），' +
      '照 PLAN 写的配置/文档要改；② 值域在写入侧**不校验**（`model_routes.reasoning_effort` 是自由文本列），' +
      '若有人塞进 `medium`，真实 provider 是报错还是静默忽略本仓库无法判定（审计 §5 第 8 条）。',
    approvedBy:
      '`contracts/src/opencode-go.ts:43-53`（「值域来自各模型官方文档，不是猜的」）+ `profiles/*/cordis.patch.yml` 的' +
      ' `reasoningEfforts` 声明 + `contracts/test/opencode-go.test.ts`；2026-10-06 1:1 保真度核对（审计 §3 第 22 条）补登。',
  },
  {
    rule:
      'PLAN.MD §10.1 分层提示架构：L0 System（人格、安全规则、输出格式）**不可变**、缓存策略「永久」；' +
      '而 EXECUTION_PLAN §2.8（用户要求，决策 D16）要求「系统提示词与回答风格提示词都可在后台编辑并热生效」，' +
      '且改动只造成**恰好一次**缓存未命中。',
    behavior:
      '代码选了「可编辑」：L0 由宿主 `DEPLOYMENT_PERSONA_PREFIX`（order 0）+ 我方 `forlife:p1-system`（order 100）' +
      '+ `forlife:p2-style`（order 110）组成（`dsh-component/src/prompt.ts:29-58`）；P1/P2 存在 `prompt_revisions` / ' +
      '`prompt_overrides` 里，后台可编辑、发布新版本、按会话覆盖，`runtime.promptText()` 以「当前 active 版本 id」为缓存键 ⇒' +
      ' 发布后下一轮即生效。P1 甚至是**播种进库**的（`store/src/migrations.ts:1064-1077` 的迁移注释：' +
      '「P1 是播种进 `prompt_revisions` 的（因为它是用户可编辑的）」）。',
    reason:
      '「人格与风格可编辑」是用户明确要求，而 §10.1 的「不可变」真正要保的是**前缀缓存稳定**。两者可以同时成立，' +
      '取舍点在于把可变性收在「发布一个新版本」这一个动作里：文本一旦发布就是逐字节确定的（同一版本 + 同一变量 ⇒ 同一 sha256），' +
      '编辑带来的恰好是**一次**缓存未命中 —— 这正是 §2.8 承诺的。阶段 4 把 order 100/110 让给 P1/P2、把 L2/L3 挪到 120/130' +
      '（`prompt.ts:40-53`），换来的正是「记忆写入不再作废人设前缀」。代价：① §10.1 表里 L0 的「永久缓存」不再字面成立' +
      '（每次发布版本会掉一次缓存）；② P2（回答风格）是 PLAN 五层表里没有的一层，L0 的实际分段与 §10.1 不同；' +
      '③ 若有人**绕过发布接口**直接改 `prompt_revisions.text`，就会每轮掉缓存 —— 这条由「面板只走发布接口」约束，' +
      '不是数据库强制的。',
    approvedBy:
      'EXECUTION_PLAN §2.8 / §2.17.6（D16，用户要求）+ `prompt.ts:40-53` 的位置论证；' +
      '2026-10-06 1:1 保真度核对（审计 §2.10 的 L0 行，审计把它记为 PLAN 内部张力）补登。',
  },
  {
    rule:
      'PLAN.MD §7.4 硬约束②「重复查询检测：与上轮**语义**相似度 > 0.9 时拒绝并返回 `duplicate_query`」' +
      '（§7.6 的 `duplicate_similarity_threshold` = 0.9 一分未改）。',
    behavior:
      '判据是**词面近似**、不是语义相似度：`querySimilarity()`（`dsh-component/src/runtime.ts`）把两条查询归一化' +
      '（NFKC / 转小写 / 去空白与标点）后取 **token 集合的 Jaccard 系数**（CJK 段取字符二元组、拉丁与数字段按词切），' +
      '`> recall.duplicateSimilarity`（0.9，**读基线**）即判重复 ⇒ 返回空结果 + `refusal.code = "duplicate_query"`' +
      '（`matchedQuery` / `similarity` / `threshold` 一并给出，同一句话也拼进 `note` ⇒ render 出来模型一定看得到）。' +
      '比对集合是 `queries_this_turn`（**本轮**已查过的查询，PLAN §7.1 自己要求回显的那份清单）；' +
      '被拒的一次**照样扣额度**、也记进该清单（否则这道闸门就是免费重试）。' +
      '能力边界如实写明：**抓得到**同一查询的表面变体（空白 / 标点 / 全半角 / 大小写 / 词序），' +
      '**抓不到**同义改写（`防抖实现` vs `防抖是怎么做的`）。',
    reason:
      '语义相似度需要向量（embedding + 余弦），而本仓**没有向量库**：`packages/store/package.json` 只依赖 ' +
      '`@forlife/contracts`，全仓没有 LanceDB / Qdrant / 任何 embedding 依赖（PLAN §6.4 的选型尚未落地，检索走 FTS5）——' +
      '审计 §2.6 的 6.4 条（"向量存储选型：找不到对应实现"）已确认这一点。文本侧可用的近似里选 token 集合 Jaccard，而**不**用现成的两个：' +
      '① `store/src/loop-guard.ts:63` 的 `similarity()` 是"公共前后缀占较短一条的比例"（为死循环检测服务），' +
      '对语序调换完全不敏感（`防抖消息队列` vs `消息队列防抖` 判 0）——两件事的判据不同，共用一个函数会同时骗过两边；' +
      '② 编辑距离对"多加一个词"过于敏感（`消息队列` vs `消息队列延迟` 会逼近 0.9，而它们是两个不同的查询）。' +
      '代价如实写明：① 阈值 0.9 是**保守**方向 —— 同义改写会漏检（少拦几次重复），换"不误杀真正不同的查询"' +
      '（误杀会让模型以为"记忆里没有这条"，与 §7.3 第 4 条要它"先判断信息是否真的存在"直接冲突）；' +
      '② 集合语义忽略词序与重复词（换个词序问同一件事判为重复 —— 这是想要的方向）；' +
      '③ 真要语义判定得等 §6.4 的向量存储落地，届时 `querySimilarity()` 是**唯一**要换的地方。',
    approvedBy:
      '2026-10-07 保真度修复：审计 `docs/audit/PLAN_FIDELITY_AUDIT.md`（§2.7 的 7.5 条 + §4「找不到对应实现」清单第 12 条）' +
      '指出该实现整体缺失、且本仓没有向量库 ⇒ 修法只能是"用近似手段（字符级 / token 集合 / n-gram）并在注释里写清为什么"；' +
      '`runtime.ts` 的 `querySimilarity()` 注释与 `dsh-component/test/recall-guardrails-wiring.test.ts`' +
      '（接线守卫 + 近似边界用例）是这条登记的落点。',
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
