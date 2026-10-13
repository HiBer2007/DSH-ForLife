# PLAN.MD 1:1 保真度审计（部署测试前）

> **这份报告是「代码 vs `PLAN.MD`」的 1:1 保真度审计**（2026-10-07）。
>
> **规格源只有 `PLAN.MD`**（619 行，13 章 + 核心设计原则 + 风险边界）。`EXECUTION_PLAN.md` 是**被核对对象**，不作依据 —— 报告里多处引用它，正是为了指出「**勾选 ≠ 已实现**」。
>
> **核对方式**：完整读 `PLAN.MD` 一次 → 按章节逐条对 → 每条给四段式（**PLAN 要求 / 代码在哪 / 是否一致 / 证据**）。
> 参数默认值的权威来源是 `packages/contracts/plan-baseline.json`（141 项，`doc` 来源 47 项）+ `packages/contracts/src/deviations.ts`（`DEVIATIONS` 为空；`RULE_DEVIATIONS` 仅 2 条，都是模型路由）。
>
> ⚠️ **一个必须说清的限制**：审计者**没有执行 `node --test`**（避免产生写入），所以本报告里所有测试名**只证明「用例存在」，不证明「通过」**。另：审计者未安装 `dsh-headless` 源码，凡涉及宿主侧行为的条目一律归入「无法判定」。

---

## 0. 核对方法（可复现）

本报告的全部结论都可由下列步骤重跑：

### 0.1 参数默认值：机械核对（最高产出的一步）

1. 读 `packages/contracts/plan-baseline.json` 的 `params`（141 项），按 `src` 前缀判定来源：
   `^(PLAN\.MD|模型路由\.MD)` ⇒ `doc` 来源（受"一比一"约束，共 47 项）；其余 ⇒ `design`（我们自己新增，见 `packages/contracts/src/baseline.ts:86-89`）。
2. 用脚本遍历每个键，在 `packages/**/*.ts`（**排除 `node_modules/`、`dist/`、`test/`**）里搜两种形态：
   - **点分键字面量**（例：`'compaction.minTokens'`，即 `defaultFor('…')` 的常见写法）；
   - **键末段**（例：`autoTriggerRatio`，覆盖前缀批量取值 `defaultsWithPrefix('compaction.')` 的写法）。
3. 两个形态都搜不到的键 ⇒ **零引用**。本次结果（`doc` 来源）：`compaction.autoTriggerRatio`、`fragment.activeBudgetRatioMin`、`fragment.activeBudgetRatioMax`、`recall.duplicateSimilarity`、`recall.resetPolicy`、`recall.extensionMax`、`recall.extensionCooldownTurns`、`recall.associativeDepthWarn`，以及 `router.*` 若干。
4. ⚠️ **不要忘了基线是 JSON 而不是 TS**：`packages/contracts/src/baseline.ts:42` 指向 `../plan-baseline.json`。只搜 `packages/contracts/src/*.ts` 会得到"PLAN 的数字没实现"这种**假 bug**。

### 0.2 接线核对：全仓检索调用点

对每个"应该有调用方"的函数/钩子，做**全仓**检索（`*.ts`、`*.mjs`、`*.js`、`*.json`、`*.yml`、`*.md`），范围含 `packages/`、`scripts/`、`tests/`、`profiles/`、`deploy/`、`.runtime/`，并**显式排除** `node_modules/`、`dist/`、`research/_sources/`。
判定规则：
- 命中只有 **定义处 + 导出 + `*.test.ts`** ⇒ 判「**找不到对应实现（生产零调用）**」；
- 命中还有 `EXECUTION_PLAN.md` / `*.md` ⇒ 单独记为「**执行记录声称有**」，作为反证而非证据。

### 0.3 "找不到"的确认纪律：≥3 组不同关键词

报「找不到对应实现」前，**必须换 ≥3 组不同关键词**再确认一次，并把搜过的关键词写进报告（见 ❓ 清单，每条都附了关键词组）。
关键词组的构造方式：① 精确标识符 ② 语义近义词（中/英） ③ 相关表名/列名 ④ 反向证据词（例：找"截断层"时搜 `truncat|前 N 行|head`）。

### 0.4 宿主事实的核对

凡涉及 DSH 宿主行为的条目（工具段 order、上游 section 表、压缩默认阈值），读 `node_modules/@deepseek-ai/**` 的 `lib/*.js` 与 `lib/types/*.d.ts` 原文确认，不靠推测。例：
- `node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:115-142`（section order 表）；
- `node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:15`（`DEFAULT_THRESHOLD_RATIO = .8`）。

### 0.5 未做（因此不能断言）的事

- **未执行测试**：所有测试名只是"用例存在"的证据；
- **未连真机/真模型**：凡"实际生效的 effort / 缓存命中率 / 冷层延迟"一律归入 ⚠️；
- **未改任何既有文件**（本文件是本次审计唯一的写入）。

---

## 1. 总表

| 章节 | 核对条数 | 一致 | 部分一致 | 不一致 | 找不到实现 | 无法判定 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 一、系统定位与总体架构 | 10 | 3 | 3 | 2 | 0 | 2 |
| 二、中期记忆系统 | 10 | 5 | 2 | 3 | 0 | 0 |
| 三、短期记忆系统 | 8 | 2 | 1 | 0 | 1 | 4 |
| 四、压缩协议 | 19 | 9 | 5 | 3 | 2 | 0 |
| 五、碎片索引机制 | 13 | 5 | 4 | 1 | 3 | 0 |
| 六、长期记忆系统 | 11 | 3 | 2 | 1 | 5 | 0 |
| 七、Recall 预算系统 | 14 | 3 | 2 | 4 | 5 | 0 |
| 八、QQ Bot 集成 | 19 | 4 | 4 | 1 | 6 | 4 |
| 九、模型分级路由 | 15 | 3 | 6 | 2 | 4 | 0 |
| 十、缓存优化策略 | 14 | 3 | 4 | 1 | 2 | 4 |
| 十一、硬件配置 | 2 | 0 | 1 | 0 | 0 | 1 |
| 十二、参数配置汇总 | 15 | 13 | 2 | 0 | 0 | 0 |
| 十三、实施路径 | 19 | 6 | 10 | 1 | 1 | 1 |
| 十四、核心设计原则 | 8 | 2 | 4 | 0 | 1 | 1 |
| 十五、风险与边界 | 9 | 1 | 6 | 1 | 1 | 0 |
| **合计** | **186** | **62** | **56** | **21** | **31** | **17** |

口径：
- **部分一致**＝机制在，但与 PLAN 细节/语义有差；
- **不一致**＝与 PLAN 明确冲突，且**未在 `deviations.ts` 登记**；
- **找不到实现**＝全仓 ≥3 组关键词确认无实现（或函数写好了但生产零调用）；
- **无法判定**＝由宿主 DSH 提供 / PLAN 内部矛盾 / 需真机。

---

## 2. 逐章四段式

### 2.1 一、系统定位与总体架构（10 条）

| 规格点 | 判定 | PLAN 要求 / 代码在哪 / 证据 |
| :--- | :--- | :--- |
| 1.1 DSH=管理后台、QQ=对话窗口；模型自主管理记忆 / 缓存友好 / 可控遗忘 / 可扩展 / 冷数据沉降 | **一致** | PLAN §1.1。代码：面板 `packages/dsh-component/src/api.ts` + `packages/admin-ui/`；网关 `packages/gateway/`；分层 `packages/store/src/storage-tiers.ts`。证据：`dsh-component/test/panel-render.test.ts`、`gateway/test/gateway.test.ts` |
| 1.2 短期记忆的角色/位置/追加式 | **无法判定** | PLAN §1.2 表。本仓库不维护会话轨迹（宿主负责），只保证"不提前裁剪"（见 §3.1） |
| 1.2 中期记忆「变动频率**极低，仅压缩时追加**」/ 稳定前缀 | **部分一致** | PLAN §1.2 表。代码：`packages/dsh-component/src/runtime.ts:179-202` `append()`，调用点 `tools.ts:83`（`remember`）、`tools.ts:157`（`push_mid_memory`）、`compaction-engine.ts:228`（压缩）⇒ 模型可随时追加。**PLAN 内部张力**：§2.3 自己写"每轮工作结束后追加"。证据：`dsh-component/test/harness.test.ts` ›「A1 调 push_mid_memory 后，下一轮 system prompt 里出现该条目」 |
| 1.2 长期记忆「语义条目**向量库** + 原始日志 HDD 归档」 | **不一致** | PLAN §1.2 + §6.2 + §6.4。代码：`long_memory_entries.embedding_id` 列在（`packages/store/src/migrations.ts:68`），但 `insertLongEntry` 的 `embeddingId` 形参（`repository.ts:321/341`）在**两个调用点都没传**（`compaction-engine.ts:247`、`runtime.ts:892`）⇒ 恒 NULL；`qdrant` 全仓 0 命中，`LanceDB` 只在注释/测试字面量里；检索只有 FTS5（`repository.ts:393` `searchLongFts`）。证据：`store/test/store.test.ts:123-129` 只断言 `embedding_id` **列存在** |
| 1.3 L0→L5 顺序（L1 工具定义在 L2/L3 **之前**） | **不一致** | PLAN §1.3 + §10.1 表。代码：`prompt.ts:33/37/55/56` `P1_ORDER=100, P2_ORDER=110, L2_ORDER=120, L3_ORDER=130`；宿主 `node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:115-142` `HARNESS_IDENTITY=-1000 / DEPLOYMENT_PERSONA_PREFIX=0 / PLAN_POLICY=500 / TOOL_BASH=1000 … MCP_SERVERS=3100`；`renderPrompt()` 把**同一有序 section 列表**拼成一个系统提示 ⇒ 实际顺序 `0 → 100 → 110 → 120 → 130 → 500 → 1000–3100 → …`，**工具段在 L2/L3 之后**。`EXECUTION_PLAN.md:328` 的示意图与它自己 `:351`（"工具段 1000–3100"）互相矛盾。证据：`scripts/lint-prompt-positions.ts`（只查"前缀段无动态内容 + order 不撞车"，**不查与宿主工具段的相对顺序**）、`tests/prompt-contract.test.ts` |
| 1.3 缓存断点位于 **L3/L4 边界** | **一致** | PLAN §1.3 + §10.3。代码：L3 是最后一个"我方注册段"（order 130），L4/L5 走 messages。`prompt.ts:9-15` 明确"四段都落在 … 与 `PLAN_POLICY(500)` 之间…在所有工具段（1000–3100）之前，并且都在缓存断点之前"。证据：`dsh-component/test/wiring.test.ts:126-137`（四段 order）、`tests/prompt-contract.test.ts`（含三条"故意违规必须被抓住"的自测） |
| 1.3 压缩周期内 L0–L4 全程只追加，缓存持续命中 | **部分一致** | PLAN §1.3。代码：`runtime.ts:160-172` `renderView()` 按 `(epoch, revision)` 缓存，无写操作时**逐字节稳定** ✅；但 `remember`/`push_mid_memory` 每次调用都 `bumpRevision` ⇒ L3 **不是"仅压缩时变化"**。证据：`memory-core/test/render.test.ts` ›「渲染纯度：同一份输入渲染 N 次，sha256 逐字节相同」；`dsh-component/test/harness.test.ts:152` `assert.equal(new Set(hashes).size, 1, …)` |
| 1.3 压缩时「L3 尾部追加、L4 替换」，缓存未命中一次 | **部分一致** | PLAN §1.3。L4 替换由宿主 `BasicCompactionEngine` 完成 ✅（`compaction-engine.ts:458` 返回 `keep_in_short` 作为 summary）；L3"尾部追加"**不成立**（见 §2.2 的 `window_offset` 缺陷）。证据：`compaction-engine.test.ts` |
| 1.3 L4 短期记忆区 / L5 当前触发 | **无法判定** | PLAN §1.3。由 DSH 宿主提供（会话 messages + 当前输入）；本仓库无实现，`host-contract.ts` 也无该契约。L5 的"位置正确"另见 §10.1 |

### 2.2 二、中期记忆系统（10 条）

**2.2.1 §2.1 权威表结构（逐字段）**
- **PLAN 要求**：`mid_memory_entries` 15 列 —— `id TEXT PRIMARY KEY / entry_type TEXT / content TEXT / summary TEXT / entities TEXT / token_count INTEGER / window_offset INTEGER / status TEXT / fragmented_into TEXT / fragment_hint TEXT / compaction_epoch INTEGER / source_short_ids TEXT / created_at TIMESTAMP / last_accessed_at TIMESTAMP / storage_tier TEXT`。
- **代码在哪**：`packages/store/src/migrations.ts:36-56`（迁移 0001）。
- **是否一致**：**字段名 100% 一致**；**类型不一致**：`created_at` / `last_accessed_at` 由 `TIMESTAMP` 改为 `TEXT`（列 49/50）；**约束不一致**：PLAN 未加约束的列代码普遍加了 `NOT NULL` / `DEFAULT` —— `entry_type NOT NULL`、`summary NOT NULL`、`entities NOT NULL DEFAULT '[]'`、`token_count NOT NULL DEFAULT 0`、`window_offset NOT NULL`、`status NOT NULL`、`compaction_epoch NOT NULL DEFAULT 0`、`source_short_ids NOT NULL DEFAULT '[]'`、`storage_tier NOT NULL DEFAULT 'ssd'`（共 9 列，其中 4 列带 DEFAULT）。额外 2 列 `revision` / `source_scope` 在 SQL 注释里标了 `[design]` 并写明出处（规范）。
- **证据**：`packages/store/test/store.test.ts:101` › `test('表结构：PLAN.MD 的字段一个都不少')`（逐个断言 15 列，并另外断言 `revision` / `source_scope` 存在）。

**2.2.2 §2.2 渲染视图 SQL**
- **PLAN 要求**：`compaction_epoch = current AND status IN ('active','fragmented') ORDER BY window_offset`；"**表是权威，窗口是渲染缓存**。渲染是纯函数，不产生副作用。"
- **代码在哪**：`packages/store/src/repository.ts:221-229` `listRenderableMidEntries()` —— `WHERE status IN ('active','fragmented') ORDER BY window_offset ASC`，**完全不按 epoch 过滤**；`repository.ts:210-219` 的注释与 `store/test/compaction-runs.test.ts:44` 把"不按 epoch 过滤"当作**修正后的正确语义**。
- **是否一致**：**不一致（对 §2.2 字面）**；但代码的理由与 §4.2 Step4 / §1.2 的"L3 跨压缩累积"一致 ⇒ 属 **PLAN 内部张力**，需规格方裁定。本报告按任务书"以 PLAN 为唯一规格"判为不一致·未登记。
- **证据**：`store/test/compaction-runs.test.ts` › `test('L3 是跨压缩累积的：推进 epoch 后旧条目仍然渲染（阶段 1 的语义错误回归）')`；**反证**：`store/test/store.test.ts:165` 的用例名仍写 `test('渲染视图：只取当前 epoch 的 active+fragmented，按 window_offset 排序')`，但用例体**从不推进 epoch** ⇒ 用例名与实现已脱节，它证明不了 epoch 过滤。

**2.2.3 §2.2 渲染形态与纯函数性**
- **PLAN 要求**：`=== 中期记忆 ===` / `[M1] …` / `[F1→] …（recall_longterm 可取回）`；渲染是纯函数。
- **代码在哪**：`packages/memory-core/src/render.ts:59` `DEFAULT_HEADER='=== 中期记忆 ==='`；`:108` `[F${fragmentIndex}→] ${hint}（${suffix}）`；`:112` `[M${activeIndex}] ${summary}`；`:80-83` 开启相对年龄时**必须显式传 `now`**，否则抛错（防偷偷读时钟）。
- **是否一致**：**一致**。
- **证据**：`memory-core/test/render.test.ts` › `test('渲染：形态与 PLAN §2.2 一致（M 顺序编号 + F 指针）')`、`test('渲染纯度：同一份输入渲染 N 次，sha256 逐字节相同')`、`test('渲染纯度：显式 now 下相对年龄也逐字节稳定；不传 now 直接报错')`、`test('渲染：空记忆区输出空文本（不产生只有标题的空壳，避免污染前缀）')`。

**2.2.4 §2.3 追加协议三步 + "追加到 L3 尾部"**
- **PLAN 要求**：① 生成 `id`、写入 `content`/`token_count`/`window_offset`；② **追加到上下文窗口 L3 尾部**；③ 提交表行（`status='active'`）。"渲染与写入在同一函数边界内完成，表优先写入，窗口用返回值渲染。崩溃时表可重建窗口。"
- **代码在哪**：`packages/store/src/repository.ts:165-203` `appendMidEntry()`（`BEGIN IMMEDIATE` → 算 offset → INSERT（`status='active'`）→ 重建 FTS → 同事务 `bumpRevision` → `COMMIT`）。
- **是否一致**：**部分一致**。三步协议与事务边界 ✅；**"L3 尾部"❌** —— offset 计数器**按 epoch 分桶**（`repository.ts:169`：`SELECT coalesce(max(window_offset), -1) + 1 AS next FROM mid_memory_entries WHERE compaction_epoch = ?`），而渲染只 `ORDER BY window_offset ASC`（`:226`，**无 epoch 兜底排序**）⇒ 每次压缩 `bumpEpoch()` 后新条目 offset 从 0 重新开始，与旧 epoch 条目**并列（tie）**，SQL 对 tie 的顺序未定义 ⇒ "渲染到 L3 尾部"**不被保证**。
- **证据**：`store/test/store.test.ts` › `test('append 协议：写表与递增修订号在同一事务内')`（只验证**单 epoch 内**偏移 0→1）；`store/test/compaction-runs.test.ts:44-63` 断言 `['M1','M2']` —— 二者 offset 分别是 0(epoch 0) 与 0(epoch 1) 的**并列关系**，该断言能过靠 rowid 顺序的巧合；`memory-core/test/recovery.test.ts` › `test('崩溃恢复：只靠磁盘上的表，窗口可以被逐字节重建')`、`test('表是权威：手工改动表内容，窗口随之改变（不存在第二份真源）')`。

### 2.3 三、短期记忆系统（8 条）

| 规格点 | 判定 | 说明与证据 |
| :--- | :--- | :--- |
| §3.1 完整工具调用请求与返回（不提前裁剪） | **一致** | 本仓库**不裁剪**会话轨迹（L4 由宿主维护）；PLAN §3.1 的原则"短期属性来自生命周期，不来自内容裁剪"未被违反 |
| §3.1 完整 `qq_reply` 记录（含多次分段回复） | **一致** | 每次调用各写一条 `qq_outbox`（`migrations.ts:313-326`）。证据：`dsh-component/test/qq-tools.test.ts` › `test('qq_reply：引用与 @ 被拼成正确的消息段顺序')` |
| §3.1 子代理的完整输出 | **无法判定** | 由宿主 `@deepseek-ai/dsh-subagent` 提供 |
| §3.1 模型推理片段（reasoning content） | **无法判定** | 宿主消息结构 |
| §3.1 当前任务状态与未完成事项 | **部分一致** | 只由压缩产出的 `keep_in_short` 承担（`compaction.ts:310-315`），没有独立的"任务状态"结构 |
| §3.2 子代理有独立短期记忆，只把结论返回主模型 | **无法判定** | 宿主子代理机制；本仓库只定义角色→档位映射（`router/src/subagents.ts`），且未接线 |
| **§3.2 大工具结果：写入时保留前 N 行 + 摘要，完整结果存日志，模型可 `recall_full(tool_call_id)` 取回** | **找不到对应实现** | 存储侧齐备：迁移 0002 `spill_entries`（`migrations.ts:143-156`）、`repository.ts:486-519` `insertSpill`（`headLines` 默认 20，`head`+`content`+`byte_size`+`line_count`）、`runtime.ts:257-275` `recallFull()`、`tools.ts:235-276` `recall_full(id)`。**但 `runtime.spill()`（`runtime.ts:265`）生产零调用** ⇒ `spill_entries` 永远为空 ⇒ `recall_full` 永远 `found:false`。搜过：① `spill\|Spill`（34 处逐条）② `\.spill\(\|insertSpill\|getSpill\|headLines` ③ `截断\|truncat\|前 N 行`（含 `.runtime/`）。证据：`dsh-component/src/api.ts:336` 的面板接口 `/api/forlife/spills` 与 `runtime.ts:327` `listSpill()` 只能列出**永远为空**的表 |
| §3.3 短期记忆是追加式的，压缩时被整体替换为 `keep_in_short` | **一致** | `memory-core/src/compaction.ts:310-315` `renderKeepInShort()`；`compaction-engine.ts:458` 把它作为 `summary` 交给宿主替换。证据：`memory-core/test/compaction.test.ts` › `test('renderKeepInShort：空列表也要给出明确文本（替换节点不能是空的）')` |

### 2.4 四、压缩协议（19 条）

**4.1 §4.1 两类压缩解耦 / 可合并执行**
- **PLAN 要求**：短期→中期（提炼，触发=短期 token 阈值、轮次、模型请求）/ 中期→长期（沉降，触发=中期占比、访问频率、定时）；"两者可独立触发，也可合并执行（共享一次模型调用）"。
- **代码在哪**：提炼 = `packages/dsh-component/src/compaction-engine.ts`；沉降 = `runtime.ts:855-918` `settle()`（不调模型）+ 压缩内的 `fragment_mid` 路径（`compaction-engine.ts:238-257`）。
- **是否一致**：**部分一致**。"可合并"✅；但沉降的**中期占比/访问频率/定时**三种触发全部落空 —— `runtime.settle()` **生产零调用**（全仓仅 `dsh-component/test/acceptance-phase2.test.ts:261/285`）；`gateway/src/settle-loop.ts` 只搬 **media blob** + 碎片维护，**不碰中期条目**。
- **证据**：`acceptance-phase2.test.ts` › `test('验收④：沉降后中期条目变 [F1→] 碎片且 recall_longterm 能取回全文')`（测试能过，但生产无触发路径）。

**4.2 §4.2 Step1 — 系统自动触发（token 占比 ≥ 50% 或定时）**
- **PLAN 要求**：§4.2 Step1 + §12.1「系统自动触发阈值 50%」。
- **代码在哪**：基线键 `compaction.autoTriggerRatio = 0.5`（`plan-baseline.json:45-48`）**在源码里零引用**；自动压缩完全由宿主驱动 —— `ForlifeCompactionEngine.compactIfNeeded()`（`compaction-engine.ts:364-376`）只做"有排队请求就改走 `context-overflow` 语义"；阈值来自宿主 `BasicCompactionEngine`，其默认 `node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:15` `DEFAULT_THRESHOLD_RATIO = .8`；四个 profile（`profiles/forlife*/cordis.patch.yml`）插入 `forlife-compaction` **均无 config**，全仓 `thresholdRatio` **0 命中**。
- **是否一致**：**不一致**（生效阈值 0.8，PLAN 是 0.5；且 0.5 这个参数没有任何消费者）。未登记。
- **证据**：`grep -n thresholdRatio`（全仓 0）；`profiles/forlife/cordis.patch.yml:40-45`、`profiles/forlife-headless/cordis.patch.yml:11-16`、`profiles/forlife-qq/cordis.patch.yml:14-19`、`profiles/forlife-web/cordis.patch.yml:28-33`。

**4.3 §4.2 Step1 — 模型请求（受约束）**
- **PLAN 要求**：模型通过 `request_compaction(reason)` 请求，受 §4.4 约束。
- **代码在哪**：`tools.ts:278-353` `request_compaction` → `runtime.evaluateCompactionRequest()`（`runtime.ts:412-417`）→ 批准则 `runtime.requestCompaction()` 入队（`runtime.ts:389-391`，写 `forlife_state.acct_pending_compaction`）→ 引擎在 `compactIfNeeded` 消费（`compaction-engine.ts:369-374`）。
- **是否一致**：**部分一致**（链路完整，但**生产路径恒被拒**，见 4.5）。
- **证据**：`dsh-component/test/acceptance-phase2.test.ts` › `test('工具清单：request_compaction 已注册')`、`test('验收②：内容太薄时 request_compaction 被拒，反馈字段与 PLAN §4.4 逐字段一致')`、`test('验收②：冷却期内 request_compaction 被拒…')`。

**4.4 §4.2 Step2 — 构造压缩请求（块顺序 + "独立调用、不复用主对话缓存"）**
- **PLAN 要求**：`[稳定 system + tools] → [当前中期记忆渲染全文] → [中期记忆条目化版本] → [完整短期记忆轨迹] → [压缩指令 + 输出格式]`；且"**独立调用（不复用主对话缓存**，可用强模型 + 高推理强度）"（§10.4 同）。
- **代码在哪**：`compaction-engine.ts:142-163` `buildCompactionInstruction()` 把「L3 渲染全文 + 条目化清单 + 触发原因 + 指令」**拼成一段文本**，在 `summarize()` 里**追加为最后一条 user 消息**（`:400-408`），而 `input.messages`（被遮蔽区域）**原样重放**。模块头 `:11-16` 与 `:131-140` 明写这是刻意取舍："把我们的压缩指令追加为最后一条 user 消息，前缀就与主对话逐字节对齐 ⇒ 供应商的暖前缀缓存能命中"、"§4.2 的块顺序 vs 交付物 2 明确要求的'复用对话自身前缀以免多打掉 KV cache'，后者优先"。
- **是否一致**：**不一致 ×2，均未登记**（① 块顺序被改写；② 与 PLAN §4.2「不复用主对话缓存」、§10.4「压缩独立调用，不污染主对话缓存」**方向相反**）。
- **证据**：`compaction-engine.test.ts` › `test('引擎 summarize：一次 stream、消息=前缀+指令、返回 keep_in_short 作为摘要')`；同文件 `:274` `assert.equal(messages[0], prefix[0], '第一条消息必须是原样的前缀（引用相同 ⇒ 字节相同）')`。

**4.5 ★ §4.4 约束系统在生产中不可达（本次审计最重的发现）**
- **PLAN 要求**：§4.4「约束由系统执行，模型通过 `request_compaction(reason)` 请求」；最小内容阈值三维：短期 token ≥2000 / 自上次压缩轮次 ≥3 / 自上次压缩工具调用 ≥5。
- **代码在哪**：`memory-core/src/compaction.ts:88-141` `decideCompaction()` 读 `stats.shortTokens` / `stats.turnsSinceLast`；二者来自 `runtime.ts:358-379` `compactionStats()` → `forlife_state` 的 `acct_short_tokens` / `acct_turns_since_compaction`。写这两个键的 `observeShortTokens()`（`runtime.ts:348-350`）与 `beginTurn()`（`runtime.ts:337-340`）**只被测试调用**。
- **是否一致**：**不一致 / 找不到对应实现（接线）**。后果：生产里 `shortTokens = 0`、`turnsSinceLast = 0` ⇒ `tokenOk = false` 且 `pressure = false`（0/128000）⇒ **一律返回 `approved:false, reason:'too_thin'`**。即 §13 阶段二第 8 项"模型自主压缩请求 + 约束系统"在真实运行中不可用。
- **证据**：`dsh-component/test/acceptance-phase2.test.ts:80-82/105-106/126-127/141/159-160/188-195/322-323`、`test/harness.test.ts:149`、`test/compaction-engine.test.ts:372` —— **全部是测试调用**；`EXECUTION_PLAN.md` 对 `beginTurn` / `observeShortTokens` 的出现次数为 **0**（连执行记录都没提过这两个函数）。
- 搜过：① `beginTurn|observeShortTokens|resetCompactionAccounting` ② `acct_short_tokens|acct_turns_since_compaction|acct_toolcalls_since_compaction` ③ 全仓 `*.ts/*.mjs/*.js/*.json/*.yml/*.md`（含 `.runtime/`、`scripts/`、`profiles/`）。

**4.6 §4.2 Step2「可用强模型 + 高推理强度」/ §9.2 压缩事件 → L3 + 高推理强度**
- **PLAN 要求**：§4.2 Step2 括注 + §9.2 表「**压缩事件**｜**L3 + 高推理强度**｜高价值、低频」。
- **代码在哪**：`compaction-engine.ts:412-420` 的 `streamOptions = { provider, model, messages, toolHistory, maxTokens, sessionId, purpose:'compaction' }` —— **没有 `reasoningEffort`**；`resolveProvider/resolveModel`（`:471-486`）缺省回落 **`agent.options.provider/model`（本轮主对话模型）**，不查 `model_routes` 的 L3；profile 未设 `summarization*`。`router/src/guards.ts:95-99` 有 `isCompressionTask → 'L3'` 规则，但全仓无生产调用方传 `isCompressionTask`；`router/src/subagents.ts:47` `ROLE_TIER.compaction='L3'` 但 `assignSubagent` 生产零调用。
- **是否一致**：**找不到对应实现**。
- **证据**：`compaction-engine.test.ts` 断言 `purpose/sessionId/maxTokens/tools`，**无任何 effort/档位断言**；`EXECUTION_PLAN.md:2064` 自认「`reasoningEffort` / 强模型摘要｜⏳ 当前跟随即有配置…要等阶段 5」。
- 搜过：① `summarizationProvider|summarizationModel|summarization`（+ `profiles/*.yml`）② `isCompressionTask` ③ `ROLE_TIER|assignSubagent` ④ `reasoningEffort|reasoning_effort` 全仓 94 处逐条看。

**4.7 §4.2 Step3 — 模型输出结构化决策（四字段）**
- **PLAN 要求**：`{push_to_mid:[{content,summary,entities,importance}], keep_in_short:[…], fragment_mid:[…], reasoning:"…"}`。
- **代码在哪**：`memory-core/src/compaction.ts:181-186` `CompactionDecision`；解析 `:207-280` `parseCompactionDecision()`；容错 `:283-307` `extractJsonObject()`。
- **是否一致**：**一致**。
- **证据**：`compaction.test.ts` › `test('解析：标准输出被正确解析')`、`test('解析：容忍 ```json 代码块与前后说明文字')`、`test('extractJsonObject：带花括号的字符串不会骗过括号计数')`。

**4.8 §4.2 Step4 — 系统执行（顺序）**
- **PLAN 要求**：`push_to_mid` 追加到中期表 → `compaction_epoch += 1` → 渲染到 L3 尾部 → `keep_in_short` 替换 L4 → `fragment_mid` 转碎片 → 写 `compaction_log`。
- **代码在哪**：`compaction-engine.ts:219-273` 的实际顺序是 **① `bumpEpoch` ② append ③ fragment ④ recordCompaction**（注释解释：新条目要落在新 epoch）。
- **是否一致**：**部分一致**（与 PLAN 的 ①② 顺序对调；功能语义合理，但非 1:1）。未登记。
- **证据**：`compaction-engine.test.ts` › `test('落库：fragment_mid 把中期条目变 [F1→] 碎片，全文进长期记忆且可 recall_full')`（同文件 118-148 区段）。

**4.9 §4.2 Step4 — `compaction_log` 取值质量**
- **PLAN 要求**：§4.5 `requested_by TEXT -- model / system`、`model_used TEXT`、`approved BOOLEAN`、`reason_if_rejected TEXT`。
- **代码在哪**：`compaction-engine.ts:262-273` `recordCompaction({ requestedBy: 'system', modelUsed: 'see-compaction-run', … })`；写入层 `repository.ts:427-448`。
- **是否一致**：**不一致**。① `requested_by` **恒为 `'system'`**（模型请求时也不写 `'model'`）；② `model_used` 是**字面占位串**，而真实模型就在同一函数的 `provider/model` 变量里，却没传进去；③ **被拒的请求完全不落库**（`tools.ts:333-342` 只返回不记录）⇒ `approved=0` 与 `reason_if_rejected` 两列**永远为空**。
- **证据**：`gateway/test/admin-queries-memory.test.ts` › `test('压缩日志：approved 三态、拒绝理由与模型名只在有值时出现、按 timestamp DESC')`（面板能显示三态，但库里只会有 `approved=1`）。

**4.10 §4.2 Step5 — 替换与预热（"发起一次空请求预热缓存"）**
- **PLAN 要求**：§4.2 Step5「新窗口生效，**发起一次空请求预热缓存**」。
- **代码在哪**：无预热调用。`compaction_log.cache_warmed`（`migrations.ts:99-100`，注释自称"EXECUTION_PLAN §4.2 Step5"）由 `recordCompaction` 按 `input.cacheWarmed === true ? 1 : 0` 写入，而唯一调用点**不传该字段** ⇒ 恒 0，且全仓无第二个写入点。
- **是否一致**：**找不到对应实现**。
- **证据**：`repository.ts:427-448`；`gateway/src/admin/queries-memory.ts` 会把 `cacheWarmed`（恒 false）显示到面板。
- 搜过：① `cache_warmed|cacheWarmed` ② `warm|预热|prewarm|primeCache|空请求`（全仓 `*.ts/*.mjs/*.js`）③ 该文件全文通读。

**4.11 §4.3 压缩输出质量约束（四条）**
- **PLAN 要求**：压缩指令中明确 —— ① 每条中期记忆必须**可独立理解**，不能"见上文"；② 禁止 push 纯工具调用记录；③ 禁止 push 用户可见的回复全文；④ **允许 push 空列表**（"压缩不等于必须产生中期记忆"）。
- **代码在哪**：`compaction-engine.ts:122-128` `INSTRUCTION_TAIL` 四条逐句写明；另有**代码级**兜底 `BACK_REFERENCE` / `TOOL_RECORD` 正则（`compaction.ts:194-196`），命中即 `dropped`（`:240-247`），行为 `empty` 也丢弃（`:235-238`）。
- **是否一致**：**一致（且有加强：PLAN 只要求"指令中明确"，代码额外做了机器校验）**。
- **证据**：`compaction.test.ts` › `test('质量约束 §4.3：丢弃含指代、纯工具记录、空条目')`、`test('解析：允许 push 空列表（PLAN §4.3：压缩不等于必须产生中期记忆）')`、`test('质量约束 §4.3：entities 超量被截断到 5 个（并告警）')`。
- 备注：③"禁止回复全文"只有指令、无代码校验 —— 与 PLAN 措辞一致，不计为不一致。

**4.12 §4.4 阈值/豁免/冷却期数值 + 拒绝反馈**
- **PLAN 要求**：最小 token ≥2000 / 轮次 ≥3 / 工具调用 ≥5；豁免 `token ≥ 6000` 绕过轮次约束；冷却期 轮次 ≥5 / 真实时间 ≥60s / token 增量 ≥1500；豁免**短期占比 ≥75% 时强制绕过冷却期**；拒绝反馈 JSON `{approved:false, reason:"too_thin", current:{tokens,turns,tool_calls}, required:{…}, hint:"…"}`。
- **代码在哪**：`memory-core/src/compaction.ts:65-76` `defaultCompactionThresholds()`（全部经 `defaultFor('compaction.*')` 取基线）；裁决 `:88-141`；拒绝反馈 `:106-117` + `tools.ts:335-341`；hint 文案 `:144-155`。
- **是否一致**：**阈值/数值/反馈字段一致**；**但豁免范围超出 PLAN** —— `pressure`（占比 ≥75%）不只绕过冷却期，还**同时绕过了"最小内容阈值"**（`:106-117`：`if (!tokenOk || !turnsOk || !toolsOk) { if (!pressure) return too_thin }`），而 PLAN §4.4 只授权"强制绕过**冷却期**"。
- **证据**：`compaction.test.ts` › `test('阈值：默认值必须等于 PLAN §4.4 原文')`、`test('裁决：豁免 —— token ≥ 6000 时绕过"最小轮次"约束')`、`test('裁决：占比告急时即便"太薄"也放行（宁可压薄也不能爆上下文）')`（这条测试恰好把"超出 PLAN"的行为固化成了断言）、`test('裁决：从未压缩过时冷却期不适用（否则第一次压缩永远被卡住）')`（PLAN 未规定的补充豁免）。

**4.13 §4.5 压缩日志表结构**
- **PLAN 要求**：`compaction_log` 12 列（id / requested_by / approved / reason_if_rejected / short_tokens_before / turns_since_last / time_since_last / pushed_entries / fragmented_entries / kept_in_short_tokens / model_used / timestamp）。
- **代码在哪**：`migrations.ts:86-101`。
- **是否一致**：**一致**（12 列全在）；`approved` 为 `INTEGER` 而非 `BOOLEAN`（类型差异）；额外 1 列 `cache_warmed` 已标 `[design]`。
- **证据**：`store/test/store.test.ts:131-139`（逐个断言 12 列）。

### 2.5 五、碎片索引机制（13 条）

**5.1 §5.1 沉降=替换为指针（不是删除）**
- **PLAN 要求**：中期记忆沉降到长期记忆时"**不是删除，而是替换为指针**"。
- **代码在哪**：`repository.ts:252-277` `fragmentMidEntry()` → `status='fragmented', entry_type='fragment', content=NULL, fragmented_into=<longId>, fragment_hint=<hint>`；并发 FTS 重建。
- **是否一致**：**一致**。
- **证据**：`store/test/store.test.ts:179` `assert.equal(rows[1]?.content, null, '碎片化后原文必须从表里移走（位置迁移，不是删除）')`、`:178` `assert.equal(rows[1]?.entry_type, 'fragment')`。

**5.2 §5.2 碎片字段设计（逐字段）**
- **PLAN 要求**：`{fragment_id:"frag_001", long_memory_id:"long#4821", hint:"…", entities:[…], created_at:"2026-10-01", reason:"settled"}`；hint 一句话 **50-80 token**；entities **最多 5 个，支持粗匹配**；**不含全文、不含向量**。
- **代码在哪**：没有独立碎片结构 —— 碎片就是 `mid_memory_entries` 里 `entry_type='fragment'` 的行；标识符是**原中期条目 id**（如 `mid_xxx`）；指向长期记忆用 `fragmented_into`（单值 TEXT）；hint 存 `fragment_hint`；entities/created_at 复用原列。
- **是否一致**：**部分一致 + 找不到**：
  - `fragment_id` / `reason` 两字段：**找不到**（全仓 `fragment_id` 0 命中、`"settled"` 0 命中）；
  - `long_memory_id` → `fragmented_into` 单值 ⇒ §5.3 第 3 层要求的 `long_memory_ids` **数组**形态无载体（全仓 `long_memory_ids` 0 命中）；
  - `hint 50-80 token`：代码只强制**上限 80**（`compaction.ts:351-367` `makeFragmentHint`），**没有 50 的下限**（§12.2 也只规定上限）；
  - entities ≤5 ✅（`:357` `.slice(0, maxEntities)`）；不含全文 ✅；不含向量 ✅（向量本就不存在）。
- **证据**：`memory-core/test/compaction.test.ts` › `test('碎片 §5.3：单条限制 —— hint ≤ 80 token，entities ≤ 5')`、`test('碎片 §5.3：单条限制 —— hint 超长按 token 预算裁剪')`（`:224`、`:228`）。
- 搜过：① `fragment_id|frag_` ② `long_memory_ids|long_memory_id` ③ `"settled"|reason.*settled` ④ `50-80|hint`。

**5.3 §5.3 第 1 层｜单条限制（hint ≤80 / entities ≤5）**
- **是否一致**：**一致**。写入侧还会**硬抛**（`runtime.ts:205-213`：hint 超上限时 `throw`）。证据：`memory-core/test/compaction.test.ts` 同上。

**5.4 §5.3 第 2 层｜总量限制（≤15-20%，或绝对上限 50 条）**
- **代码在哪**：`compaction.ts:382-397` `planFragmentation()`（两个上限**都**拦）；渲染侧只**报告**不截断（`render.ts:116-125`）。
- **是否一致**：**一致**。
- **证据**：`compaction.test.ts` › `test('碎片 §5.3：总量限制 —— 占比越过上限即停止新增，并转为淘汰候选')`、`test('碎片 §5.3：绝对上限 50 条')`；`render.test.ts` › `test('渲染：碎片区占比超限被报告（上限 20%）')`。

**5.5 §5.3 第 3 层｜合并规则（entities 重叠 → 合并为更粗粒度 hint，`long_memory_ids` 变数组）**
- **代码在哪**：`compaction.ts:429-448` `findMergeGroups()` **只算出分组**；`runtime.ts:883` 拿到 `plan.mergeGroups` 后**从不使用**（`runtime.ts:885-918` 只用 `plan.toFragment` / `plan.toArchive` / `plan.notes`）；网关侧 `fragment-maintenance.ts:157-165` 的 `mergeFragmentIndex()` 只是对 FTS5 跑 `optimize`（模块头 `:19-25` 明写"**不动数据**…它只影响查询性能与索引体积"）。
- **是否一致**：**找不到对应实现**。
- **证据**：`memory-core/test/compaction.test.ts` › `test('碎片 §5.3：合并规则 —— entities 重叠的碎片成组')`（只断言 `plan.mergeGroups` 形状，**没有任何"合并结果落库"的断言**）。
- 搜过：① `mergeGroups|findMergeGroups` ② `mergeFragmentIndex|合并` ③ `更粗|泛化|coarser`。

**5.6 §5.3 第 4 层｜淘汰规则（最久未访问**且 hint 已泛化** → 标 `archived`，从渲染移除，**表保留、可恢复**）**
- **代码在哪**：`runtime.ts:904-912`（标 `archived`，但触发条件只有 `stats.fragmentCount >= defaultFor('fragment.maxCount')` 即 50 条；**没有"hint 已泛化"的判定** —— `compaction.ts:450-456` 注释直言"具体泛化判断由上层做"，而上层没做）；渲染移除 ✅（`listRenderableMidEntries` 只取 `active`/`fragmented`）；**"表保留"在网关侧被违反** —— `gateway/src/settle-loop.ts:171-174` + `store/src/fragment-maintenance.ts:174-211` `evictFragments()` 对 `status='fragmented'` 的行执行 **`DELETE FROM mid_memory_entries`**（保留期默认 30 天、一次最多 200 条，"只淘汰 `fragmented`、归宿必须还在"两条红线做得很好，但语义与 PLAN 不同）；**"可恢复"没有入口** —— 网关只有 `long_memory_entries` 的归档/恢复（`gateway/src/admin/memory-write.ts:69-81`、`admin/api.ts:1173`），**没有任何 API/工具能把 mid 的 `archived` 改回 `active`**。
- **是否一致**：**部分一致 + 一处未登记的不一致（DELETE vs 软删）**。
- **证据**：`store/test/fragment-maintenance.test.ts`、`store/test/fragment-threshold.test.ts`（› `test('★ 占比 20% 且 ≥100 条才动手')` 等）、`gateway/test/settle-loop.test.ts`。

**5.7 §5.3「独立预算：中期记忆区 = active（80-85%）+ 碎片索引（15-20%）」**
- **代码在哪**：碎片侧上限有实现（`fragment.maxAreaRatio=0.2`）；active 侧 `fragment.activeBudgetRatioMin/Max`（0.8/0.85，`plan-baseline.json:65-72`）在**生产源码里零引用**。
- **是否一致**：**部分一致**（不存在"独立预算"的分配/裁剪逻辑，只有碎片上限被硬拦）。

**5.8 §5.4 模型使用方式（看到 `[F1→]` → 调 `recall_longterm("…", hint=frag_001)` → 返回 long#4821 全文）**
- **代码在哪**：`tools.ts:170-233` 的 `recall_longterm` 参数**只有 `query` 与 `limit`，没有 `hint`**；渲染出的碎片标签是 `[F1→]`（`render.ts:108`），而 `F${fragmentIndex}` 是**渲染时的序号**（每次渲染都可能变），**不是 id**。
- **是否一致**：**不一致**（§5.4 的"碎片提供方向 + hint 参数"闭环缺一环）。未登记。
- **证据**：`tools.ts:177-180`（参数 schema）；`render.ts:86-108`（`fragmentIndex` 计数）。

### 2.6 六、长期记忆系统（11 条）

**6.1 §6.1 表结构**
- **PLAN 要求**：10 列（id / content / summary / entities / embedding_id / source_mid_ids / storage_tier / status / created_at / last_accessed_at）。
- **代码在哪**：`migrations.ts:63-80`。
- **是否一致**：字段名全在（`store/test/store.test.ts:122-129`）✅；`created_at`/`last_accessed_at` 类型 `TIMESTAMP→TEXT`（**不一致**）；额外 3 列 `access_count` / `source_scope` / `archive_path` 均标 `[design]`（✅）；`embedding_id` **恒 NULL**（**找不到**，见 §1.2）。

**6.2 §6.2 存储分层（热 SSD+内存 / 温 SSD / 冷 HDD）**
- **PLAN 要求**：热=最近访问的**向量与摘要**；温=全部**向量索引**+摘要；冷=**全文**+历史向量归档。
- **代码在哪**：`packages/store/src/storage-tiers.ts:32-81`（三层 `hot/warm/cold`，根路径来自 `FORLIFE_ROOT_HOT/WARM/COLD`，缺配依次回退并如实报告 `fellBack`）；`settle.ts` 搬的是 **media blob 文件**。
- **是否一致**：**部分一致**（三层机制在、回退与"不撒谎"的纪律很好；但分层对象是媒体 blob，不是 PLAN 的向量/摘要层；且 `long_memory_entries.storage_tier` 除初始 `'ssd'` 外无人写入）。
- **证据**：`store/test/storage-tiers.test.ts`、`store/test/tier-modes.test.ts` › `test('★★ 一处**故意的不一致**：SSD 模式下落库的 tier 必须夹到 warm')`。

**6.3 §6.3 触发①「中期→长期沉降时」**
- **是否一致**：**一致**（压缩内 `fragment_mid` 路径：`compaction-engine.ts:238-257`）。
- **证据**：`compaction-engine.test.ts` › `test('落库：fragment_mid 把中期条目变 [F1→] 碎片，全文进长期记忆且可 recall_full')`。

**6.4 §6.3 触发②「定时任务扫描 `last_accessed_at > 90 天` 的**长期**条目」+ 操作（全文/向量迁 HDD 归档、表内 `content` 置空、`storage_tier='hdd'`）**
- **代码在哪**：两个函数都写好了 —— `repository.ts:365-376` `listSettleCandidates(db, olderThanDays, limit)`（`WHERE storage_tier='ssd' AND coalesce(last_accessed_at, created_at) < cutoff`）、`repository.ts:379-383` `markLongSettled(id, archivePath)`（`SET storage_tier='hdd', content=NULL, archive_path=?`）—— **但全仓零调用**（只有 `store/src/index.ts:62/65` 的导出）。没有定时任务、没有工具、没有管理 API 调用它们。
- ⚠️ **注意区分**：`runtime.settle()`（`runtime.ts:855-918`）确实读了 `tiering.settleAfterDays = 90`，但它扫的是**中期条目**、产出的是**碎片**（那是 §4.1 的第二类压缩），**不是** §6.3 的"长期条目 → HDD"。
- **是否一致**：**找不到对应实现**。
- 搜过：① `listSettleCandidates|markLongSettled|markLongRecovered` ② `hdd|storage_tier`（94 处逐条）③ `settleAfterDays|90 天|归档任务|archiveLong` ④ 全仓（含 `scripts/`、`.runtime/`）⑤ `gateway/src/settle-loop.ts` 全文通读。

**6.5 §6.3 回读「`recall_longterm` 命中 HDD 条目时按需加载」**
- **代码在哪**：`packages/store/src/cold-load.ts:60-127` `loadLongEntry()` 写得很完整（`archive_path` 有值就从归档读、读不到**明确报错不回落**、延迟按 tier 落 `cold_load_stats`、并用 `source:'archive'|'db'` 如实标注）—— **但全仓零调用**（除 `store/src/index.ts:321` 的导出与 `.runtime/export-coldload.mjs` 那个"只加了个 export"的一次性脚本）。`runtime.ts:234` `recallLongterm()` 只调 `searchLongFts()`，**没有任何冷层加载分支** ⇒ 模型拿到的永远只有 `summary`，正文（无论在 HDD 还是库内）都取不到。
- **是否一致**：**找不到对应实现**。
- 搜过：① `loadLongEntry|loadStats|recordLoad` ② `cold-load|coldLoad|冷数据|按需加载` ③ `recallLongterm|searchLongFts|content` ④ 全仓。

**6.6 §6.3 可逆「`recover(id)` 可将 HDD 条目提升回 SSD」**
- **代码在哪**：`store/src/archive.ts:209-256` `recoverEntry()` **只查 `media_assets`**（blob），不碰 `long_memory_entries`；long 侧的 `markLongRecovered()`（`repository.ts:386-390`）**零调用**；`dsh-component/src/tools.ts` 与全部工具注册点**没有名为 `recover` 的工具**（但 L2 提示词与 `recall_longterm` 描述**都让模型去用它**：`config.ts:72`、`tools.ts:175`）。
- **是否一致**：**部分一致 + 不一致**（blob 侧可逆 ✅ 且接了管理 API `gateway/src/admin/api.ts:747`；**长期记忆侧不可逆、且提示词指向一个不存在的工具**）。未登记。
- **证据**：`store/test/archive.test.ts` › `test('★ 已在 cold ⇒ 不动（反向提升是 recover() 的事）')`、`test('recover：校验不过就保留源')`；全量工具清单（33 个，`grep "name: '"` in `dsh-component/src`）里无 `recover`。

**6.7 §6.4 向量存储选型（LanceDB / Qdrant 嵌入式）**
- **是否一致**：**找不到对应实现**。
- 搜过：① `LanceDB|lancedb`（6 处，全是注释/测试字面量）② `qdrant|Qdrant`（0）③ `vector|embedding|embedding_id|embeddingId`（35 处，都是"模型能力声明 / 端点校验 / 评分器部署"）④ `packages/store/package.json`（只依赖 `@forlife/contracts`，无向量依赖）。
- **证据**：`gateway/src/sticker-search.ts:6` 的注释还在说"PLAN 阶段六写的是'复用 LanceDB 做向量索引'…"，但**表情检索也没建向量**。

### 2.7 七、Recall 预算系统（14 条）

**7.1 §7.1 预算声明格式**
- **PLAN 要求**：每次工具返回附带 `{"results":[…],"budget":{"used":2,"limit":5,"remaining":3,"reset_at":"on_compaction","queries_this_turn":[…],"hint":"你还有 3 次检索额度，将在下次压缩后重置。避免重复检索相近主题。"}}`。
- **代码在哪**：`runtime.ts:73-88` 定义了 `RecallBudget { maxPerTurn, maxPerCycle, maxResults, usedThisTurn, usedThisCycle, remainingThisTurn, remainingThisCycle }`，但**工具层把它拍平了** —— `tools.ts:183-206` 的 `output.schema` 是 `{ ok, results, usedThisTurn, remainingThisTurn, remainingThisCycle, note }`。
- **是否一致**：**不一致**。无 `budget` 对象；字段名全不同；**缺 `limit` / `reset_at` / `queries_this_turn` / `hint`**；也没有任何"查询历史"结构（`queries_this_turn` 全仓 0 命中）。`EXECUTION_PLAN.md:375` 声称"预算信息**随每次工具返回**（PLAN §7.1 的 JSON 形状）"。
- **证据**：`tools.ts:215-232`（execute 的返回形状）。

**7.2 §7.2 预算耗尽**
- **PLAN 要求**：`results: []` + `budget.used/limit/remaining` + hint 指向 `request_recall_extension(reason)`。
- **代码在哪**：`runtime.ts:224-230` 返回 `entries: []` + `note: '本轮 recall 次数已达上限（2）。如确有必要，可说明理由后申请追加额度（**阶段 4 开放**）。'`
- **是否一致**：**部分一致 / 不一致**（`results: []` ✅；提示语指向一个**不存在的工具**且自称"阶段 4 开放"，PLAN 要求的是"可调用 `request_recall_extension(reason)`"）。未登记。
- **证据**：`tools.ts:210`（空结果时 render 输出 `note`）。

**7.3 §7.3 工具描述中的行为约束（5 条使用原则 + 3 条反面示例）**
- **PLAN 要求**：5 条原则 + 3 条反面示例（"为'确保无遗漏'连续检索 3-4 次相似查询 / 检索到模糊片段后大量推测性检索 / 把不相关结果强行关联到当前任务"）。
- **代码在哪**：`tools.ts:172-176` 的 `recall_longterm` 描述只有 3 句；补位文案在 `runtime.ts:248-252`（无命中 note）。
- **是否一致**：**部分一致**。逐条对：
  - PLAN(1)"仅当短期与中期记忆确实缺少所需信息时才调用" → ❌ 未写；
  - PLAN(2)"不要为'确认'或'补充'而反复检索同一主题" → ✅（"不要为了确认而反复检索"）；
  - PLAN(3)"每次返回的是候选片段，不是最终答案。不要过度联想串联" → ❌ 未写；
  - PLAN(4)"一次检索无结果时，先判断信息是否真的存在，而不是立即换词重试" → ⚠️ **语义相反**（描述里写的是"**可以换关键词**"），只在 `runtime.ts:251` 的无命中 note 里被补回："先判断这条信息是否真的可能存在，再决定是否换关键词"；
  - PLAN(5)"每轮有有限额度，额度信息在每次返回中告知" → ✅；
  - 3 条反面示例 → **找不到**。
- **证据**：`tools.ts:170-233`；`runtime.ts:248-252`。

**7.4 §7.4 硬约束 ①「硬性次数上限，超过直接拒绝」**
- **代码在哪**：`runtime.ts:224` 只闸 `maxPerTurn`；`maxPerCycle`（=5）虽被读入（`:222`）**只用于显示，不做闸门**；且计数器永不重置（见 7.9）。
- **是否一致**：**部分一致**（生产后果：进程内累计 2 次后 `recall_longterm` **永久失效**）。

**7.5 §7.4 硬约束 ②「重复查询检测：与上轮语义相似度 > 0.9 时拒绝并返回 `duplicate_query`」**
- **是否一致**：**找不到对应实现**。基线键 `recall.duplicateSimilarity=0.9`（`plan-baseline.json:101-104`）**零引用**；全仓 `duplicate_query` **0 命中**；唯一的 `similarity()` 在 `store/src/loop-guard.ts:63`，是死循环检测用的字符级相似度，与 recall 无关。
- 搜过：① `duplicate_query` ② `duplicateSimilarity|相似度|similarity` ③ `cosine|余弦|embedding 相似`。

**7.6 §7.4 硬约束 ③「联想深度限制：同轮连续 3 次以上检索时强制附加提示」**
- **是否一致**：**找不到对应实现**。`recall.associativeDepthWarn=3`（`plan-baseline.json:117-120`）**零引用**；且 `maxPerTurn=2 < 3` ⇒ **这条规则在当前参数下不可能被触发**（PLAN 内部张力）。
- 搜过：① `associativeDepthWarn|associativeDepth` ② `联想|深度|连续 3 次` ③ `recallThisTurn|note`。

**7.7 §7.4 硬约束 ④「单次返回结果数上限硬编码（默认 3，最多 5）」**
- **代码在哪**：`runtime.ts:217-220` `Math.min(limit ?? config.recallMaxResults, defaultFor('recall.maxResultsHardCap'))`；`config.ts:97-100`。
- **是否一致**：**一致**。
- **证据**：`dsh-component/test/harness.test.ts:270` `assert.equal(resolved.recallMaxResults, 3, 'recall.maxResults 基线值必须生效')`。

**7.8 §7.5 逃生通道 `request_recall_extension(reason, additional=2)`**
- **是否一致**：**找不到对应实现**。工具注册表**全量**（33 个工具名）里没有它；`recall.extensionMax` / `recall.extensionCooldownTurns` 两个基线键**零引用**；`runtime.ts:228` 的提示语把"申请追加额度"标为"阶段 4 开放"，而阶段 4 已交付。
- 搜过：① `request_recall_extension|recall_extension` ② `extensionMax|extensionCooldown|extension` ③ `追加额度|逃生|extend|额外额度` ④ 全量工具名清单 ⑤ `EXECUTION_PLAN.md`（`:375`、`:933` **两处声称有**）。

**7.9 §7.6 参数汇总（7 个默认值）+ `reset_policy` 的落点**
- **PLAN 值 vs `plan-baseline.json`**：`max_recall_per_cycle 5` ✅ / `max_recall_per_turn 2` ✅ / `max_results_per_recall 3` ✅ / `duplicate_similarity_threshold 0.9` ✅ / `reset_policy on_compaction` ✅ / `extension_max 2` ✅ / `extension_cooldown 3 轮` ✅ —— **7 个值全部一比一**。
- **但**：其中 **4 个零引用**（`duplicateSimilarity` / `resetPolicy` / `extensionMax` / `extensionCooldownTurns`）。
- **`reset_policy=on_compaction` 的落点未接线**：`runtime.ts:921-926` `resetCycle()` 实现正确（`recallThisTurn = 0; recallThisCycle = 0`），但**全仓零调用**（连测试都没有）；「每轮重置」的 `beginTurn()`（`:337-340`）也是死代码 ⇒ 两个计数器**从进程启动起只增不减**。
- **是否一致**：**值一致 / 行为找不到对应实现**。

### 2.8 八、QQ Bot 集成（19 条）

**8.1 §8.1 工具集（工具名逐个对）**

| PLAN §8.1 | 代码 | 判定 |
| :--- | :--- | :--- |
| `qq_reply(text, reply_to?)` | `qq_reply(conversation*, text*, reply_to?, at?)`（`qq-tools.ts:102-107`） | **部分一致**（多**必填** `conversation`、多可选 `at`；代码注释解释为"一个窗口多会话，猜错目标是灾难"） |
| `qq_react(emoji, msg_id?)` | `qq_react(conversation*, message_id*, emoji*)`（`:179-183`） | **部分一致**（`msg_id`→`message_id`，由可选变**必填**，另加 `conversation`） |
| `qq_typing(on/off)` | `qq_typing(conversation*, on:boolean*)`（`:221-224`） | **部分一致**（`on/off` 实现为布尔 `on`，语义等价；另加 `conversation`） |

- **三个工具名都逐个对上 ✅**（"模型照名字调"的关键项没有出问题）。
- 额外 30 个工具（`read_pending` / `set_status` / `clear_system_status` / `list_wake_rules` / `set_wake_rule` / `qq_mention_all` / `qq_group_notice` / `qq_send_sticker` / `sticker_search` / `sticker_import` / `schedule_wake` / `register_watcher` / `list_wakes` / `cancel_wake` / `wake_now` / `list_ports` / `publish_port` / `unpublish_port` / `now` / `get_clock` / `set_clock` / `list_clocks` / `switch_model` / `revert_model` / `router_status` …）来自 `EXECUTION_PLAN`，不算违背 PLAN。
- **证据**：`dsh-component/test/qq-tools.test.ts` › `test('qq_reply：必须有 conversation，且动作进队列等网关发送')`、`test('qq_typing：群聊如实返回不支持（不假装成功）')`、`test('qq_reply：会话键格式不对时明确报错（不猜目标）')`。

**8.2 §8.2 轮次生命周期（逐步骤）**

| PLAN 步骤 | 代码 | 判定 |
| :--- | :--- | :--- |
| QQ 消息到达 | `gateway.ts:163-188` `onEvent`；`:375-416` `persistInbound`（**先落库再处理**） | **一致**。证据：`gateway/test/onebot-loop.test.ts` ›「整条链：模拟 NapCat → 入库 → 轮次 → 出站 → 确认」 |
| 防抖窗口（3s） | `gateway.ts:107` `debounceMs ?? 3000`；`timing.ts:71-88`（同会话新消息重置计时） | **一致**。证据：`gateway/test/timing.test.ts` ›「同会话连发 5 条合并为一轮（PLAN §8.2/§8.4）」›「静默期恰好 3 秒时结算（边界）」 |
| 合并入队 | `gateway.ts:191-205`（移交 `ready` 而非丢弃 + `scheduler.enqueue`）；`scheduler.ts:122-145` | **一致**。证据：`onebot-loop.test.ts:197-198`（`merged_into=/^turn_/`）、`scheduler.test.ts` ›「合并：同一会话的多批消息只占一个排队位」 |
| 后端组装上下文（L0–L5） | 网关只造**当前触发**的文本：`turns.ts:88-147` 经 `driver.ts:106-118` 走 stdin；L0–L3 由我方提示段（`prompt.ts:89-162` + `index.ts:344-360`）；**L4 无系统侧实现** —— `qq_turns.session_id` 生产零写入，headless 每次 spawn 只传 `['--profile', p, '--json']`（`driver.test.ts:106` 断言） | **部分一致**（"后端组装 L0–L5"被拆到两个进程/两个包；跨轮连续性见 ⚠️） |
| 模型调用工具（含多次 `qq_reply`） | `qq-tools.ts:85-174`（每次调用一条 outbox） | **一致** |
| 模型停止工具调用 → 轮次结束 | `driver.ts:169-172`（子进程 close）+ `turns.ts:462-477`（`done`/`failed`） | **一致** |
| **提交工作记忆** | **无系统侧动作**：`runtime.append()` 的调用点只有 `tools.ts:83/157`（模型主动调 `remember`/`push_mid_memory`）与 `compaction-engine.ts:228`；`finishTurn` 只 `UPDATE qq_turns`。`工作记忆\|working_memory\|workingMemory\|work_memory` 全仓零命中 | **不一致 / 找不到对应实现** |
| 短期记忆追加 | 职责在宿主 L4（`EXECUTION_PLAN.md:355`）；`gateway/test/*` 无任何记忆表断言 | **找不到（本仓库无实现）** |

- **附加（不算缺失，但改变"队列层"的语义）**：PLAN 的 8 个环节**顺序未被违反**，但中间插入了 3 步 —— 调度器（优先级/老化/冷却/配额，`scheduler.ts:93-254`）、噪音过滤（`turns.ts:260-290`）、唤醒判定 `decideWake`（`turns.ts:298-306`）。

**8.3 §8.3 异步与挂起**
- `defer_turn(reason, expected_duration)`：代码 `qq-tools.ts:260-302`，参数名 `expected_duration_ms`（**部分一致**）；把 `qq_turns` 置 `deferred` + 写 `defer_reason/defer_until`；`turns.ts:463-471` 在 deferred 时直接 return（不提交）。证据：`qq-tools.test.ts` › `test('defer_turn：把当前 running 轮次标记为挂起（§8.3）')`、`gateway/test/turns.test.ts` › `test('端到端：模型要求挂起 ⇒ 轮次标记 deferred（§8.3 不提交、不追加记忆）')`。
- **「工作记忆增加 `pending_async_tasks` 字段」→ 找不到对应实现**。搜过 ① `pending_async_tasks` ② `pendingAsync|asyncTasks` ③ `async_task|pending_async` ④ `挂起|deferred`（+ 全仓 `*.ts/*.json`）；**唯一命中是 `PLAN.MD:414` 自己**。
- **「等任务完成后恢复」→ 找不到对应实现**：全仓 `defer_until` 只有**写**（`qq-tools.ts:298`、`turns.ts:468`）与测试断言，**没有任何读取方**（无调度器、无轮询、无启动钩子）；`qq_turns` 里残留的 `running` 也没有清理/reaper。搜过 ① `defer_until|deferUntil` ② `resume|恢复轮次|requeue|replay|挂起恢复` ③ `deferred`（103 处逐条）。
- **「不提交」形式一致但语义落空**：本来就没有任何提交动作可跳过；宿主侧本该用的 `deferContext` / `concludeTurn` **从未被调用**（只在 `EXECUTION_PLAN` / `research` 里出现）。

**8.4 §8.4 消息队列**

| PLAN | 代码 | 判定 |
| :--- | :--- | :--- |
| 队列：SQLite 表 + 轮询（或内存队列 + 持久化） | `qq_inbox`（`migrations.ts:266-289`，含 `processed`/`merged_into`/`attempt`/`error`）+ `qq_outbox`（`:313-326`）+ `gateway.ts:97/124-127` `setInterval(…, 250ms)`；队列本体是内存 `buffered`/`ready` | **一致** |
| 防抖 2–3s、同会话新消息重置计时 | `timing.ts:71-88`；profile 显式 `debounceMs: 3000`（`profiles/forlife-qq/cordis.patch.yml:31`） | **一致** |
| 会话键 `(platform, chat_id, thread_id?)` | 格式/解析支持三段（`transport.ts:17-43`；表 `migrations.ts:251-261`）；**但生产里 `thread_id` 恒为 NULL** —— `gateway.ts:404-407` 写死 `NULL`，OneBot 传输层从不设置 threadId（`gateway/src/onebot.ts:241-244/257-260/318-321`） | **部分一致**（第三段是死的）。证据：`gateway/test/onebot.test.ts:72-76` |
| 并发：同会话串行（`asyncio.Lock`）、跨会话并行 | `timing.ts:125-152` `KeyedMutex` + `gateway.ts:222-230`（`void` 不 await） | **一致**。证据：`gateway/test/timing.test.ts` ›「同 key 顺序执行、跨 key 并行」；`turns.test.ts:264-282` `assert.deepEqual(order, ['start:A','end:A','start:B','end:B'], '同会话必须严格串行（否则回复会交叉错乱）')` |
| **崩溃恢复：队列与处理状态持久化，重启恢复未完成轮次** | 持久化 ✅（`persistInbound` 先落库、`processed=0`）+ 出站自愈 `reclaimStaleOutbound(30_000)`（`gateway.ts:253`）；**入站侧无任何启动重放/续跑**（`pumpScheduler` 只服务内存 `ready`/`buffered`），`running` 轮次无清理；唯一相关入口是把 `processed` 置 1 的人工按钮（`gateway/src/admin/api.ts:456`，**方向相反**） | **部分一致**（持久化在、恢复不在） |

**8.5 §8.5 噪音过滤**
- **PLAN 要求**："在**队列层**做轻量过滤（规则或小模型），把纯闲聊挡在 DSH 之外。**不值得回复的消息，也不值得进记忆系统。**"
- **代码在哪**：`timing.ts:195-244` `DEFAULT_NOISE_RULES` 三条（`empty` / `pure-emoji` / `too-short-in-group`（群内 ≤2 字，且排除 @我/拍一拍/带媒体））+ `explicit-signal` 豁免（@我/拍一拍/@全体）+ 说话人白名单；调用点 `turns.ts:260-290`（整批都是噪音则 `return { woken:false, reason:'noise' }`，**仍标记 `processed`** 以免面板"待处理"只增不减）。
- **是否一致**：**部分一致**。语义达成 ✅（"不值得回复的也不值得进记忆系统"）；**但位置**在防抖 + 调度**之后**、模型之前，严格说不是 PLAN 的"队列层"。另：**生产装配里没传 `noise.allowedSenders`**（`gateway/src/runtime.ts:244-252`）⇒ 白名单形同未启用。
- **证据**：`gateway/src/runtime.ts:56`（"关掉噪音过滤（默认开）"）、`turns.ts:171-174`。

**8.6 §8.6 轮次内不换模型 + 路由决策在轮次开始时做一次（另含 `deviations.ts` 登记核实）**
- **PLAN 要求**："同一逻辑轮次内模型固定，避免语气和推理风格断裂。路由决策在轮次开始时做一次。"
- **代码在哪**：`router/src/routes.ts:152-158` `lockTierForTurn` / `:170-186` `assertTierForTurn` **生产零调用**（只有 `router/test/routes.test.ts:94-123`）；`Router` / `runGuards` / `heuristicScore` / `startPreScore` / `routeBatch` 调用点**全在 `router/test/*`**；`model_routes` 只被面板/状态工具读取展示（`dsh-component/src/api.ts:170`、`gateway/src/admin/queries-model.ts:514`）；`routing_log` 的写入方只有模型主动切换（`router-tools.ts:209/223`）；**无 `agent/request` / `agent/request-error` 订阅**（生产只订阅 `session/event`（`index.ts:437`）与 `agent/assistant-stream`（`loop-guard-register.ts:88`））。
- **是否一致**：**找不到对应实现**；且 §8.6 在真机上**只是"因为别无选择"而成立**（模型由 profile 固定：`profiles/forlife-qq/cordis.patch.yml:122-126` 的 `dsh-agent-default-model`）。
- **`deviations.ts` 登记内容双向不符（重点）**：
  1. 第 2 条说"**允许被动降级**"—— `router/src/failover.ts:114-221` 状态机 + `router-hooks.ts:59-146` 接线层齐备，但 `FailoverRuntime` / `buildFailoverRuntime` **生产调用点为零**（只有自身模块 + `test/failover-wiring.test.ts`）、**无人消费 `FailoverDecision.next`**、登记里承诺的"沿用同一风格段 + 对齐 temperature/maxTokens"**零实现**（`maxTokens|temperature|风格段` 在 router/runtime 侧零命中）⇒ provider 失败只会整轮 `failed`（`turns.ts:336-343`）。
  2. 同一条说"**主动切换仍然禁止**" —— **不成立**：`switch_model` 是**已注册的活工具**（`index.ts:377-382`、`router-tools.ts:54-91/185-240`），约束是"理由 ≥4 字 + 冷却 120s（`router.switch.cooldownMs`）+ 预算 6 次/小时（`router.switch.perHour`）"，且 `router-tools.test.ts:107-121` 断言它**真的生效并留痕**。
  3. 但**主动切换目前也没有实际效果**：`tierOverride` 只被 `router-tools.ts:110/155/192` 与 `api.ts:237`（面板展示）读取，没有任何请求路径消费它。
- **补充**：`qq_turns.model` 列**从未被生产代码写入**（`migrations.ts:299`）⇒ 即使将来做了轮次路由，也没有"这一轮用了哪个模型"的落库证据可审计。

### 2.9 九、模型分级路由（15 条）

**★ 全局事实：整条 `@forlife/router` 决策流水线在生产代码里没有被调用过。**
`new Router(` 生产 0 命中（14 处全在 `router/test/router.test.ts`）；`runGuards(` / `heuristicScore(` / `startPreScore(` / `routeBatch(` / `HttpTierScorer(` 在 `packages/router/src` 之外零调用；`assignSubagent` / `assignAll`、`lockTierForTurn` / `assertTierForTurn`、`FailoverRuntime` 生产零调用。`listModelRoutes` 的生产用途只有：面板展示（`api.ts:170`）、`router_status`（`router-tools.ts:162`）、播种去重（`route-seed.ts:65/133/144`）、网关面板查询 —— **没有任何一处把 `model_routes` 的 provider/model 应用到真实 LLM 请求**。真正接线到宿主的只有：`seedDefaultRoutes`（`index.ts:351`）、`buildRouterTools`（`index.ts:379`）、`compaction-engine.ts`。

| 规格点 | 判定 | 说明与证据 |
| :--- | :--- | :--- |
| §9.1 档位名 **L1 轻 / L2 中 / L3 强** | **一致** | 代码：`router/src/guards.ts:23` `type Tier='L1'\|'L2'\|'L3'`；`routes.ts:38` `ROUTE_ROLES`；`migrations.ts:702` 注释。中文"轻/中/强"只存在于 PLAN/注释，属描述性标签。证据：`router/test/routes.test.ts` › `test('角色清单：三档 + 视觉/嵌入/评分器/子代理')`；`dsh-component/test/admin-api.test.ts` › `test('路由页：七个角色都在…')`。⚠️ 命名歧义（非不一致）：L2/L3 在本仓库**同时**表示记忆层级（`config.ts:26/88`、`prompt.ts:56`） |
| §9.1 典型任务语义 | **部分一致** | 语义基本对应；不一致点：PLAN 的"L3=任务规划/复杂调试"判定权被交给语义评分模型，守卫只承认 4 类强信号；`scorer.ts:83` 的 L3 描述里**没有"压缩决策"**（压缩由 `guards.ts:97` 单独承担，且未接线） |
| §9.1 模型选择（L1 小模型 **7B-14B** / L2 中等 / L3 前沿） | **不一致** | `route-seed.ts:73-78` 三档**同一 provider/model**（只改 effort）；部署默认 `opencode-go/deepseek-v4.1-flash`（`profiles/*/cordis.patch.yml:122-126`）；`contracts/src/opencode-go.ts:225-234` 里 L1 首选也是同一模型；全仓 **无任何 "7B-14B" 约束/默认/校验**（7B 只出现在**评分器本地部署**候选表 `endpoints.ts:282-293`）。证据：`dsh-component/test/route-seed.test.ts` › `test('播种：空表时补 L1/L2/L3/scorer —— 档位只决定推理强度')` |
| §9.2「收到用户消息，决定如何回应 → L2」 | **找不到对应实现** | 只有两处显示/日志兜底：`router-tools.ts:159` `tier: override?.tier ?? 'L2'`、`router-hooks.ts:116` `tier: input.tier ?? 'L2'`；`GuardContext`（`guards.ts:26-33`）无场景字段。搜过：① `'L2'`（全仓 90 处逐条）② `tierOverride\|setTierOverride` ③ `agent/pre-step\|agent/request` |
| §9.2「`qq_reply` 生成回复 → 同轮次」 | **部分一致** | 语义正确且有测试（`routes.ts:152-158` + `:170-186`）；**但没有任何轮次循环调用它**。证据：`router/test/routes.test.ts` › `test('轮次内锁定：同一轮里不允许换档位（§8.6 轮次内不换模型）')`、`test('每轮重断言：只锁不重断言会变成粘性…')` |
| §9.2「**压缩事件 → L3 + 高推理强度**」 | **找不到对应实现** | 三处"像但都不是"：① `guards.ts:95-99` `isCompressionTask→'L3'` 规则在，**全仓无生产代码传 `isCompressionTask`**；② `subagents.ts:47` `compaction:'L3'` 但 `assignSubagent` 未接线；③ 真实落点 `compaction-engine.ts:412-420` **无 effort、不查 L3**（详见 §4.6） |
| §9.2「简单确认、表情回应 → L1 或规则」 | **一致** | 走"规则"支：`guards.ts:110-124`（emoji-only / simple-ack / simple-query → L1）+ `:125-135`。证据：`router/test/router.test.ts` › `test('守卫：明显场景被拦截，中间地带放行')`（😂😂/好的/现在几点/嗯嗯/在吗 → L1） |
| §9.2「后台检索、归档 → L1」 | **一致（映射层面）** | `subagents.ts:39-50` `ROLE_TIER.retrieval/archival='L1'`，用途说明 `:53-61`。附注：`assignSubagent` 未接线；长期记忆沉降/归档在本项目是**纯代码作业、不经模型**。证据：`router/test/subagents.test.ts` › `test('档位分配：搬运型用便宜模型，思考型用强模型…')` |
| §9.3 第一阶段：基于规则的静态路由（按 DSH agent 角色和任务类型映射） | **部分一致** | 机制齐备（`subagents.ts:39-61` 角色→档位；`routes.ts:38/112-131` 角色→有序模型表；`guards.ts:89-136` 任务类型→档位，上限 `router.guards.maxRules=10`，`:155-159` 超限报错不静默截断）；但 (a) 角色维度是**子代理角色**而非 DSH agent 角色；(b) 未接线到轮次开始 |
| §9.3 第二阶段：启发式复杂度评分（长度、关键词、是否含代码） | **部分一致** | 三要素齐（+工具链）：`heuristic.ts:86-112` `+0.25 规划关键词` / `+0.20 代码块` / `+0.15*min(len/2000,1)` / `+0.20 工具链>3`，阈值 `<0.35→L1`、`<0.70→L2`；权重/阈值全取基线（`plan-baseline.json:177-200`）。**但定位相反**：PLAN 放第二阶段，代码把它降为**第三层兜底**（`pipeline.ts:200-216`；`heuristic.ts:1-11` 注释"启发式不再作为主路径，只是**降级保护**"）。证据：`router/test/router.test.ts` › `test('启发式：公式逐项对应设计文档，且可解释')` |
| §9.3 第三阶段（可选）：轻量本地分类器 Qwen2.5-0.5B | **部分一致** | 元素齐备（`scorer.ts:74-98` 提示词 + `:155-195` `HttpTierScorer`，`local-container`/`external-endpoint`，`temperature:0`，可选 `guided_json`；基线 `router.minimum.model="Qwen2.5-0.5B-Instruct"` / 4bit / 常驻 / 50ms / maxTokens 20）。**但定位相反**：代码做成**第二层主力**，PLAN 的"可选"**没有开关/基线参数**（`pipeline.ts:152-154` 未配置即降级）。证据：`router/test/router.test.ts` › `test('同步路径的超时必须严格是文档原值…')` |
| §9.3 跨阶段：整条策略在运行期生效 | **找不到对应实现** | 轮次开始时无任何"守卫→评分→兜底"决策；`switch_model` 的 `tierOverride` 只被面板与 `router_status` 读取。搜过：① `new Router(` ② `from '@forlife/router'`（生产 5 处，全是常量/端点探测/视觉/回退链/切换裁决）③ `runGuards(\|selectRoute\|ROLE_TIER\|assignSubagent` ④ `lockTierForTurn\|TurnRouteState\|assertTierForTurn` ⑤ `buildFailoverRuntime\|FailoverRuntime` ⑥ `agent/request\|installModelSelection\|LlmCallConfig` ⑦ `listModelRoutes` |
| §9.4 推理强度取值 **off / low / medium / high / max（五个值）** | **不一致** | 项目自有类型是 `contracts/src/opencode-go.ts:53` `'none'\|'low'\|'high'\|'max'`（四值；相邻注释明写"**没有 medium** —— 它在 DeepSeek 与 GLM 上都不合法"）；UI `RoutingView.vue:649-658` 同为 `(不指定)/none/low/high/max`；`migrations.ts:706` 注释却是 `-- low \| medium \| high`（**三处三方不一致**）；写入 API **不校验**（`dsh-component/src/api.ts:271`、`gateway/src/admin/api.ts:1240`）；唯一真校验在 `router/src/subagents.ts:141-150`（按宿主声明的合法集合，取不到就不传）。宿主真机值域旁证：`profiles/*/cordis.patch.yml:82-117`（`off/low/high/max`、`low/high/max`）、`docs/notes/dsh-provider-config.md`（§档位取值）（真机报错 + "DSH 没有 `none`，项目的 none = DSH 的 off"） |
| §9.4 语义："在选定模型上根据任务难度**动态**调整" | **部分一致** | 只有静态"档位→强度"表（`route-seed.ts:74-78`、`routes.ts:122-124`）；`escalate/deescalate`（`pipeline.ts:52-61`）变的是档位不是强度；**唯一把强度带进请求的是 `subagents.ts:159-165`（未接线）** ⇒ `model_routes.reasoning_effort` 只入库/展示，真机生效值来自宿主 profile 的 `reasoningEffort: high` |
| §9.5 可参考的 DSH 插件（4 个 + `dsh-model-memory`） | **找不到（引用）** | 全仓搜 5 个插件名只命中 `PLAN.MD:463-470` 与 `EXECUTION_PLAN.md:745`；`research/` 零命中。PLAN 用词是"可参考"，不引用不算违约，但**也无评估结论留档**。自研对应物：`router/src/failover.ts`（≈dsh-llm-auto，未接线）、`router/src/subagents.ts`（≈subagent-default-model，未接线）、`router/src/routes.ts`+`decideSwitch`（≈router-core） |

**⚠️ 关于 §9.3 顺序的裁定请求**：仓库根目录另有一份 `模型路由.MD`（357 行），其 §一 L7 明写"**现修订为：由低等级模型（L1）直接完成评分与档位判断…规则与启发式退居为守卫与兜底**"。而 `plan-baseline.json` 把相关 `router.*` 参数标为 `doc` 来源（`src="模型路由.MD §X"`）⇒ `fidelity.test.ts` 事实上把 `模型路由.MD` 当成与 PLAN 同级的规格。**若承认它**，§9.3 顺序那条应降级为"按修订文档实现"；**但 §9.4 值域那条仍然成立**（该文档通篇未定义 effort 值域，已逐行确认）。

### 2.10 十、缓存优化策略（14 条）

**§10.1 分层提示架构 L0–L5**

| PLAN 层（内容｜可变性｜缓存策略） | 代码落点 | 判定 |
| :--- | :--- | :--- |
| L0 System（人格、安全规则、输出格式｜**不可变**｜永久） | 宿主 `DEPLOYMENT_PERSONA_PREFIX(0)` + 我方 `P1(100)`（**用户可编辑**）+ `P2(110)`（回答风格） | **部分一致**（P2 是 PLAN 表里没有的一层；P1 可编辑与"不可变"冲突 —— 这是 §2.8"提示词必须可编辑"与 §10.1 的 PLAN 内部张力） |
| L1 Tools（工具定义｜极少更新｜长期） | 宿主 `TOOL_*(1000–3100)` section | **一致**（但顺序在 L2/L3 之后，见 §1.3） |
| L2 Long-term Index（长期记忆手册｜极少更新｜长期） | `forlife:l2-index`，order 120；`config.ts:66-73` `DEFAULT_L2_INDEX_TEXT` | **一致** |
| L3 Mid Memory（中期条目+碎片｜**仅压缩时追加**｜长期） | `forlife:l3-mid`，order 130，`runtime.renderView().text` | **部分一致**（每次 `remember`/写入都推进 revision） |
| L4 Short Memory（完整轨迹｜每轮追加｜周期内） | 宿主会话 messages | **无法判定** |
| L5 User Input（当前触发｜动态｜不缓存） | 网关尾部注入（`turns.ts:139-145`，时间读数**明确放尾部**） | **一致（位置正确）** |

- 额外工具（做得最扎实的一处）：`scripts/lint-prompt-positions.ts` + `tests/prompt-contract.test.ts` 把"前缀段不得含动态内容 + order 不撞车"变成机器契约，并含**两条"故意违规必须被抓住"的自测**。

**§10.2 字节级稳定前缀（三条）**

| PLAN 要求 | 判定 | 说明与证据 |
| :--- | :--- | :--- |
| 工具定义确定性序列化：key 排序、空白规范化 | **部分一致** | 本仓库无自有序列化/规范化实现，也无断言（`grep canonical\|确定性序列化\|byteEqual` 在 `packages/` **0 命中**）；实际依赖宿主 `orderTools`（`dsh-system-prompt/lib/index.js`）+ JS 对象字面量顺序。`EXECUTION_PLAN.md:3156` 声称"断言 `assemble().tools` 顺序与内容稳定"，**该断言不存在** |
| 会话历史只追加：一旦写入字节表示永不变 | **无法判定** | 宿主行为 |
| 压缩后字节不变：**`keep_verbatim`** 条目复用原始字节；merge 结果一经生成即冻结 | **找不到对应实现** | 全仓 `keep_verbatim\|keepVerbatim` **0 命中**（实现里没有这个概念；压缩只产出 `keep_in_short` 文本数组）。搜过：① `keep_verbatim\|keepVerbatim` ② `keep_in_short` ③ `字节\|冻结\|复用原始`。**反证（正面）**：渲染函数的字节稳定性被钉死了 —— `memory-core/test/render.test.ts`、`dsh-component/test/harness.test.ts:152` `assert.equal(new Set(hashes).size, 1, …)`、`test('A3 崩溃后重启：新进程渲染出的系统提示词与崩溃前逐字节一致')` |

**§10.3 缓存断点设在 L3/L4 边界** → **一致**（作为位置契约；证据同 §1.3）。

**§10.4 压缩时的缓存成本（四条）**

| PLAN 要求 | 判定 | 说明 |
| :--- | :--- | :--- |
| 压缩独立调用，不污染主对话缓存 | **不一致** | 代码**刻意复用主对话前缀**（`compaction-engine.ts:11-16/400-408`；未登记） |
| 压缩冷却期约束（见 4.4） | **部分一致** | 参数在，但"轮次"维度因死代码不可达；占比豁免会整体绕过冷却期 |
| 压缩后主动预热缓存 | **找不到对应实现** | 见 §4.10 |
| 目标：压缩周期内全程命中，未命中频率约每 5-8 轮一次 | **无法判定** | 需真机观测；度量基建在（见 §13.19） |

### 2.11 十一、硬件配置（2 条）
- 「CPU 4 核+ / 内存 16GB+ / SSD 256GB+ / HDD 1TB+ / GPU 非必需」→ **无法判定**（PLAN 是采购建议，代码不可验证）。
- 「存储必须 NVMe SSD（慢速磁盘会导致不稳定）；HDD 专用于冷数据沉降」→ **部分一致**：分层根路径是环境变量（`FORLIFE_ROOT_HOT/WARM/COLD`，`storage-tiers.ts:51-81`），而 `deploy/docker-compose.yml:64-67` **没有把 HDD 挂成冷层根**（只有 `forlife-data` / `dsh-home` 两个卷，`FORLIFE_ROOT_*` 未出现）⇒ 冷层是否落在 HDD 完全取决于部署方（真机需核）。

### 2.12 十二、参数配置汇总（15 条 · 逐个对）

**§12.1 压缩约束（9 项）—— 值与 PLAN 逐字相等**

| PLAN 参数 | PLAN 值 | 基线键 | JSON 值 | 值 | 是否被消费 |
| :--- | ---: | :--- | ---: | :--- | :--- |
| 最小 token 数 | 2000 | `compaction.minTokens` | 2000 | ✅ | ✅ `compaction.ts:67` |
| 最小轮次数 | 3 | `compaction.minTurns` | 3 | ✅ | ✅（**输入恒 0**，见 §4.5） |
| 最小工具调用次数 | 5 | `compaction.minToolCalls` | 5 | ✅ | ✅（`recordToolCall()` 真的在被调） |
| 豁免 token 阈值 | 6000 | `compaction.waiveMinTurnsAboveTokens` | 6000 | ✅ | ✅ |
| 冷却期轮次数 | 5 | `compaction.cooldownTurns` | 5 | ✅ | ✅（**输入恒 0**） |
| 冷却期时间 | 60s | `compaction.cooldownMs` | 60000 | ✅ | ✅ |
| 冷却期 token 增量 | 1500 | `compaction.cooldownTokenDelta` | 1500 | ✅ | ✅ |
| 紧急绕过阈值（占比） | 75% | `compaction.emergencyBypassRatio` | 0.75 | ✅ | ✅（且**额外**绕过了"太薄"判定） |
| 系统自动触发阈值 | 50% | `compaction.autoTriggerRatio` | 0.5 | ✅ | ❌ **零引用**（生效 0.8） |

**§12.2 碎片索引（5 项）**

| PLAN 参数 | PLAN 值 | 基线键 | JSON 值 | 值 | 是否被消费 |
| :--- | ---: | :--- | ---: | :--- | :--- |
| 单条 hint 上限 | 80 token | `fragment.maxHintTokens` | 80 | ✅ | ✅（`makeFragmentHint` / `render` / `runtime.fragment`） |
| entities 上限 | 5 | `fragment.maxEntities` | 5 | ✅ | ✅ |
| 碎片区占比上限 | 20% | `fragment.maxAreaRatio` | 0.2 | ✅ | ✅ |
| 碎片总数上限 | 50 | `fragment.maxCount` | 50 | ✅ | ✅ |
| 沉降访问间隔 | 90 天 | `tiering.settleAfterDays` | 90 | ✅ | ⚠️ 只被 `runtime.settle()` 用，而它**生产零调用**（且它扫中期条目，不是 PLAN 说的长期条目） |

- 另有 §5.3 的 `fragment.activeBudgetRatioMin/Max`（0.8/0.85）两个 `doc` 参数**零引用**。

**§12.3 Recall 预算** → 见 §7.9（7 值全对；4 个零引用；`reset` 落点未接线）。

**判定**：**值保真度 15/15 一致（全项目最干净的一块）；接线保真度有问题** —— §12 范围内 **6 个参数零引用/无生效路径**（`autoTriggerRatio`、`activeBudgetRatioMin`、`activeBudgetRatioMax`、`duplicateSimilarity`、`resetPolicy`、`extensionMax`、`extensionCooldownTurns`、`associativeDepthWarn` 中落在 §12 的 6 个）。

### 2.13 十三、实施路径（19 项）

| # | 交付物 | 判定 | 依据 |
| ---: | :--- | :--- | :--- |
| 1 | SQLite 表结构（mid/long/compaction_log） | **一致** | 迁移 0001；`store/test/store.test.ts:101` |
| 2 | 中期记忆追加与渲染逻辑 | **一致** | `appendMidEntry` + `renderMidMemory` |
| 3 | 短期记忆追加逻辑 | **无法判定** | 宿主会话日志 |
| 4 | `remember` / `recall_longterm` / `push_mid_memory` | **一致** | `tools.ts:46/101/171`；`MEMORY_TOOL_NAMES`（`:370`） |
| 5 | 短期→中期压缩（系统自动触发） | **部分一致** | 阈值 0.8（宿主），非 0.5 |
| 6 | 中期→长期沉降 + 碎片索引 | **部分一致** | 压缩内 `fragment_mid` ✅；自动沉降 ❌ |
| 7 | 压缩日志与审计 | **部分一致** | 表齐 + `compaction_runs` 事务 + `effects` 三写 ✅；`requested_by`/`model_used` 恒定、被拒不落库 ❌ |
| 8 | 模型自主压缩请求 + 约束系统 | **部分一致** | 工具与裁决都在，**生产恒被拒** |
| 9 | 消息队列 + 防抖 | **一致** | `timing.ts` + `gateway.ts` |
| 10 | `qq_reply` / `qq_react` / `qq_typing` | **一致（签名扩展）** | `qq-tools.ts:86/177/216` |
| 11 | 轮次生命周期与挂起恢复 | **部分一致** | 挂起 ✅、恢复 ❌ |
| 12 | 分层提示架构 + 缓存断点 | **部分一致** | 断点 ✅、层序 ❌ |
| 13 | 确定性序列化 | **部分一致** | 依赖宿主；无自有实现/断言 |
| 14 | 模型分级路由（静态规则起步） | **部分一致** | 骨架齐、**未接线** |
| 15 | Recall 预算系统 + 行为约束 | **不一致** | 格式 / 重复检测 / 联想提示 / 逃生通道 4 项缺 |
| 16 | HDD 归档目录与 **Parquet** 导出 | **部分一致** | 目录/API ✅（`FORLIFE_ARCHIVE_DIR` + `/archive`），格式改 **NDJSON + manifest**（`archive.ts:6-21` 自认偏离，**未登记**） |
| 17 | `recover` / `recall_full` 回读 | **找不到** | `recover` 工具不存在；`recall_full` 无生产者；long 侧 recover 未接线 |
| 18 | 碎片索引合并与淘汰 | **部分一致** | 淘汰有两条路径（`archived` ✅ / **`DELETE`** ❌）；"合并"退化为 FTS `optimize` |
| 19 | 缓存命中率监控 | **一致** | 迁移 0010 `cache_metrics` + `dsh-component/src/cache-collector.ts` + `memory-core/src/cache-metrics.ts`。证据：`memory-core/test/cache-metrics.test.ts`（15 条用例，含`test('口径：提示词总 token = 未命中 + 命中 + 写入（三者互不重叠）')`、`test('结论：不可解释的未命中优先报警（它意味着前缀在无故漂移）')`） |

### 2.14 十四、核心设计原则（8 条）

| # | 原则 | 判定 | 说明 |
| ---: | :--- | :--- | :--- |
| 1 | 表是权威，窗口是渲染 | **一致** | `memory-core/test/recovery.test.ts` 三条用例钉死（重建 / 修订号只被写操作推进 / 手工改表窗口随之变） |
| 2 | 追加优先，压缩是事件 | **部分一致** | L3 每次写入都变；跨 epoch `window_offset` 串位 |
| 3 | 遗忘是位置迁移，不是消失 | **部分一致** | 压缩路径 ✅；网关维护循环 **`DELETE`** ❌ |
| 4 | 约束由系统执行，模型只表达意愿 | **一致** | `request_compaction` + 裁决器 + 结构化拒绝反馈 |
| 5 | 完整保留执行轨迹，通过生命周期控制体积 | **部分一致** | 截断层缺失（§3.2） |
| 6 | 冷热分层，HDD 只承载冷数据 | **部分一致** | long 侧未接线；分层对象是 blob |
| 7 | 轮次级路由，轮次内不换模型 | **找不到对应实现** | 路由未接线（§8.6/§9） |
| 8 | 缓存未命中是固定成本，频率可控即可 | **无法判定** | 需真机；"冷却期轮次维度不可达"是明确风险 |

### 2.15 十五、风险与边界（9 条）

| PLAN 风险 | PLAN 缓解 | 判定 | 说明 |
| :--- | :--- | :--- | :--- |
| 双写不一致（表 vs 窗口） | 同一事务边界内完成，渲染为纯函数 | **一致** | `appendMidEntry` 用 `BEGIN IMMEDIATE`；渲染纯函数 |
| 压缩中途崩溃 | 启动时按 epoch 校验，回滚到上一个完整 epoch | **部分一致** | 机制齐（`compaction_runs` + `rollbackCompactionRun` + `recoverPendingCompactions`），**但启动时无人调用**（见 ❓ 第 23 条）。证据：`store/test/compaction-runs.test.ts` › `test('故障注入：压缩中途被杀 ⇒ 重启后回滚到上一个完整状态，无半写条目')` |
| 模型误判归档重要记忆 | 软删除 + `recover` + 压缩日志审计 | **部分一致** | 软删 ✅、审计 ✅、`recover` ❌ |
| 碎片索引膨胀 | 四层长度限制 + 合并淘汰 | **部分一致** | 层 1/2 ✅、层 3 ❌、层 4 ⚠️ |
| Recall 滥用 | 预算 + 硬约束 + 碎片预提示 + 逃生通道 | **不一致** | 4 项中 3 项缺失/失效 |
| 压缩过密 | 冷却期 + 系统批准制 + 紧急豁免 | **部分一致** | 轮次维度不可达；实际频率由宿主 0.8 决定 |
| 中期记忆碎片化 | 压缩质量约束 + 允许 push 空列表 | **一致** | `compaction.ts:194-196/240-247` + `INSTRUCTION_TAIL` |
| 子代理输出膨胀 | 子代理独立短期记忆，只返回结论 | **无法判定** | 宿主 `dsh-subagent` |
| 大工具结果膨胀 | 截断 + 摘要，完整结果日志可回读 | **找不到对应实现** | 截断层缺失 |

---

## 3. ❌ 不一致清单（24 条）

> 全部指「PLAN 说什么 / 代码做什么 / 差在哪」，且**均未在 `deviations.ts` 登记**。

1. **§2.2 渲染过滤**：PLAN `compaction_epoch = current AND status IN ('active','fragmented')`；代码不按 epoch 过滤（`repository.ts:221-229`）。差：旧 epoch 条目仍渲染（代码自认为是修正，PLAN 字面相反 ⇒ PLAN 内部张力）。
2. **§2.3 / §4.2 Step4「追加到 L3 尾部」**：`window_offset` **按 epoch 分桶**（`repository.ts:169`），渲染只 `ORDER BY window_offset ASC`（`:226`，无 epoch 兜底）⇒ 压缩后新条目与旧条目**并列**，"尾部"无保证。
3. **§2.1 / §6.1 / §4.5 列类型与约束**：`TIMESTAMP → TEXT`；9 列加 `NOT NULL`（4 列带 DEFAULT）；`approved BOOLEAN → INTEGER`。
4. **§4.2 Step1 自动触发阈值**：PLAN 50%；`compaction.autoTriggerRatio` **零引用**，生效值来自宿主 `dsh-compaction-basic` 的 `DEFAULT_THRESHOLD_RATIO=0.8`（四个 profile 均未覆盖）。
5. **§4.2 Step2「独立调用，不复用主对话缓存」+ §10.4「压缩独立调用，不污染主对话缓存」**：代码**刻意复用主对话前缀**（`compaction-engine.ts:11-16/400-408`），模块头自认这是取舍。
6. **§4.2 Step2 请求块顺序**：PLAN 五段顺序；代码把「L3 渲染全文 + 条目化清单 + 原因 + 指令」**合并进尾部一条 user 消息**（`compaction-engine.ts:142-163`）。
7. **§4.2 Step4 执行顺序**：PLAN 先 push 后 `epoch += 1`；代码先 `bumpEpoch` 后 push（`compaction-engine.ts:220-236`）。
8. **§4.4 豁免范围**：PLAN「占比 ≥75% ⇒ 绕过**冷却期**」；代码同时绕过**最小内容阈值**（`compaction.ts:106-117`），并有测试固化该行为。
9. **§4.5 日志取值**：`requested_by` 恒 `'system'`、`model_used` 恒字面量 `'see-compaction-run'`、**被拒请求完全不落库**（`approved=0` / `reason_if_rejected` 永远为空）。
10. **§5.2 碎片字段**：无 `fragment_id`；无 `reason`；`long_memory_id` 为单值 `fragmented_into`（§5.3 要的 `long_memory_ids` 数组无载体）；hint 只有上限 80、无 50 下限。
11. **§5.4 闭环**：`recall_longterm` **无 `hint` 参数**；渲染出的 `[F1→]` 是序号而非 id。
12. **§5.3 第 4 层「表保留、可恢复」**：网关维护循环对碎片执行 **`DELETE`**（`fragment-maintenance.ts:207`）；mid 的 `archived` **无恢复入口**。
13. **§6.3 / §13.16 归档格式**：PLAN「Parquet」；代码 **NDJSON + manifest**（`archive.ts`，代码自认偏离但未登记）。
14. **§7.1 预算声明格式**：PLAN 的 `budget{used, limit, remaining, reset_at, queries_this_turn, hint}`；代码拍平成 `usedThisTurn / remainingThisTurn / remainingThisCycle / note`，**无 `budget` 对象、无 `reset_at`、无 `queries_this_turn`、无 `hint`**。
15. **§7.2 耗尽提示**：PLAN 指向 `request_recall_extension(reason)`；代码写"阶段 4 开放"（该工具从未实现）。
16. **§8.1 工具签名**：`qq_reply` 多必填 `conversation`（+可选 `at`）；`qq_react` 的 `msg_id → message_id` 且由可选变必填；`qq_typing` 的 `on/off → on`；三者均多必填 `conversation`。
17. **§8.2「提交工作记忆」**：无系统侧实现（中期表只由工具/压缩写入；"每轮收尾追加"（T1）在 `finishTurn` 里不存在）。
18. **§8.4 会话键 `thread_id`**：格式支持但生产**恒 NULL**（`gateway.ts:404-407` 写死 NULL）。
19. **§8.5 噪音过滤位置**：不在"队列层"（在防抖+调度之后）；`noise.allowedSenders` 生产未启用。
20. **§8.6 与 `deviations.ts` 登记不符（双向）**：登记的"被动降级"**完全没接上宿主**；登记的"主动切换仍然禁止"**不成立**（`switch_model` 是活工具且测试断言生效）。
21. **§9.1 模型选择**：PLAN「L1 小模型 7B-14B / L2 中等 / L3 前沿」；代码三档**同一模型**（默认 `opencode-go/deepseek-v4.1-flash`），只改 effort。
22. **§9.4 推理强度值域**：PLAN 五值 `off/low/medium/high/max`；代码 `'none'|'low'|'high'|'max'`（四值，首值异名、无 `medium`）；`migrations.ts:706` 注释第三种写法 `low|medium|high`。
23. **§10.2 `keep_verbatim`**：PLAN 要求复用原始字节；代码**没有这个概念**（0 命中）。
24. **提示词指向不存在的工具**：`config.ts:72`（**位于 L2 稳定前缀**！）与 `tools.ts:175` 都让模型"用 `recover` 提升回热层"，而 `recover` **不是已注册工具**（33 个工具名里没有）。

---

## 4. ❓ 找不到对应实现清单（23 条）

> 每条附**搜过的关键词组**（均 ≥3 组）与反证尝试。

1. **§3.2 大工具结果截断层**（`spill` 的写入方）。搜过：① `spill|Spill`（34 处逐条）② `\.spill\(|insertSpill|getSpill|headLines` ③ `截断|truncat|前 N 行`（含 `.runtime/`）。反证：表/工具/面板接口都在，**只缺生产者**。
2. **§4.2 Step5 压缩后空请求预热缓存**。搜过：① `cache_warmed|cacheWarmed` ② `warm|预热|prewarm|primeCache|空请求` ③ `compaction-engine.ts` 全文。反证：`cache_warmed` 列存在但唯一写入点不传值 ⇒ 恒 0。
3. **§4.2 Step2「强模型 + 高推理强度」/ §9.2 压缩 → L3 + 高推理**。搜过：① `summarizationProvider|summarizationModel`（+ `profiles/*.yml`）② `isCompressionTask` ③ `ROLE_TIER|assignSubagent` ④ `reasoningEffort|reasoning_effort`（全仓 94 处逐条）。
4. **§4.4 记账输入 `beginTurn` / `observeShortTokens`**。搜过：① 两个函数名 ② `acct_short_tokens|acct_turns_since_compaction|acct_toolcalls_since_compaction` ③ 全仓 `*.ts/*.mjs/*.js/*.json/*.yml/*.md`。反证：只在测试里被调；`EXECUTION_PLAN.md` **0 命中**。
5. **§4.1 中期→长期自动沉降（中期占比/访问频率/定时触发）**。搜过：① `runtime.settle|\.settle\(` ② `settleAfterDays|settleBatchSize` ③ `gateway/src/settle-loop.ts` 全文（只搬 blob）。
6. **§5.2 `fragment_id` / `reason`**。搜过：① `fragment_id|frag_` ② `"settled"` ③ `long_memory_ids` ④ `碎片`。
7. **§5.3 第 3 层「合并为更粗 hint + `long_memory_ids` 数组」**。搜过：① `mergeGroups|findMergeGroups` ② `mergeFragmentIndex|合并` ③ `更粗|泛化|coarser`。反证：`findMergeGroups` 的返回值**无消费者**；`mergeFragmentIndex` 只是 FTS `optimize`。
8. **§6.1 / §6.4 向量索引（`embedding_id` 落地 + LanceDB/Qdrant）**。搜过：① `LanceDB|lancedb` ② `qdrant|Qdrant` ③ `vector|embedding|embedding_id|embeddingId` ④ `packages/store/package.json` 依赖。
9. **§6.3 长期条目 → HDD 沉降（定时扫 90 天；`content` 置空、`storage_tier='hdd'`）**。搜过：① `listSettleCandidates|markLongSettled|markLongRecovered` ② `hdd|storage_tier`（94 处逐条）③ `settleAfterDays|归档任务|archiveLong` ④ 全仓含 `.runtime/` ⑤ `settle-loop.ts` 全文。
10. **§6.3 `recall_longterm` 命中 HDD 条目按需加载**。搜过：① `loadLongEntry|loadStats|recordLoad` ② `cold-load|冷数据|按需加载` ③ `recallLongterm|searchLongFts|content` ④ 全仓。反证：`.runtime/export-coldload.mjs` 证明它只被"加了个 export"。
11. **§6.3 `recover` 工具（长期记忆侧可逆）**。搜过：① `'recover'|recover\(|name: 'recover` ② `markLongRecovered|recoverEntry` ③ **全量工具名清单**（33 个）。
12. **§7.4 重复查询检测（>0.9 → `duplicate_query`）**。搜过：① `duplicate_query` ② `duplicateSimilarity|相似度|similarity` ③ `cosine|余弦`。
13. **§7.4 联想深度提示（同轮 ≥3 次）**。搜过：① `associativeDepthWarn|associativeDepth` ② `联想|深度` ③ `recallThisTurn|note`。
14. **§7.5 / §7.6 逃生通道 `request_recall_extension`**。搜过：① `request_recall_extension|recall_extension` ② `extensionMax|extensionCooldownTurns` ③ `追加额度|逃生|extend` ④ 全量工具名 ⑤ `EXECUTION_PLAN.md`（**它声称有**）。
15. **§7.6 `reset_policy=on_compaction` 的落点**。搜过：① `resetCycle` ② `resetPolicy|reset_at` ③ `recallThisTurn|recallThisCycle|on_compaction` ④ 全仓。反证：`resetCycle()` 实现正确但**零调用**（连测试都没有）。
16. **§8.2 提交工作记忆 / 短期记忆追加的系统侧实现**。搜过：① `runtime.append(|appendMidEntry(`（全部调用点）② `finishTurn|轮次收尾|提交工作记忆` ③ `工作记忆|working_memory|workingMemory|work_memory|workMemory` ④ `session_id|turn_id`（`qq_turns.session_id` 无写入方）。
17. **§8.3 `pending_async_tasks`**。搜过：① `pending_async_tasks` ② `pendingAsync|asyncTasks` ③ `async_task|pending_async` ④ `挂起`（唯一命中 `PLAN.MD:414`）。
18. **§8.3 挂起后「恢复」**。搜过：① `defer_until|deferUntil` ② `resume|恢复轮次|requeue|replay|挂起恢复` ③ `deferred`（103 处逐条）。反证：只有写、无读；`running` 无 reaper。
19. **§8.4 崩溃后重启恢复未完成轮次 / 入站重放**。搜过：① `processed = 0|WHERE processed` ② `status = 'running'|reaper|重启恢复|recoverInbox` ③ `重启|启动时|未完成|重新入队`，并与出站侧 `reclaimStaleOutbound` 对照。
20. **§8.6 / §9.3 轮次开始的路由决策（运行期接线）**。搜过：① `new Router(` ② `from '@forlife/router'`（生产 5 处）③ `runGuards(|lockTierForTurn(|assertTierForTurn(|assignSubagent(` ④ `FailoverRuntime|buildFailoverRuntime` ⑤ `agent/request|agent/request-error|agent/pre-step` ⑥ `installRouterHooks|registerRouterHooks`（0）。
21. **§9.5 四个 DSH 插件的引用/评估结论**。搜过：① 四个插件名 + `member-model` ② `dsh-model-memory` ③ `research/` 目录内单搜。
22. **§10.2 `keep_verbatim` 字节复用**。搜过：① `keep_verbatim|keepVerbatim` ② `keep_in_short` ③ `冻结|复用原始字节`。
23. **§15 启动时按 epoch 校验回滚**。搜过：① `recoverPendingCompactions`（全仓含 `scripts/`、`.runtime/`、`tests/`）② `openDatabase|apply(` 全文 ③ 面板/文档旁证（`gateway/src/admin/queries-memory.ts:344` 还在说"启动回滚还没跑"）。反证：`EXECUTION_PLAN.md:2036` **声称**"启动时 `recoverPendingCompactions()` 扫出残留的 `started` 按计划回滚"。

---

## 5. ⚠️ 无法判定清单（11 条）

1. **L4 短期记忆 / L5 当前触发**（§1.3/§10.1）：由 DSH 宿主提供；`reasoning content 保留`、`子代理独立短期记忆`、`会话历史字节不变`、`工具定义 canonical 序列化`同属此类。
2. **跨轮 L4 是否连续追加**：取决于 `dsh --profile forlife-headless --json`（不传 sessionId）是否复用同一会话；本机无 `dsh-headless` 源码，仓库侧只能证明"未传 sessionId、`qq_turns.session_id` 从未写入"。
3. **真实部署是否真跑模型**：`gateway/src/server.ts:315` 非 `headless` 即 `fake`，`scripts/start-admin.ps1:95` 默认 `fake`，而 forlife-qq profile 配的是 `headless` ⇒ 属配置差异。
4. **§10.4「未命中频率约每 5-8 轮一次」**：需真机 `cache_metrics` 观测（基建在，见 §13.19）。
5. **§11 硬件**：代码不可验证；`deploy/docker-compose.yml` 未把 HDD 固定成冷层根（`FORLIFE_ROOT_*` 未出现），需真机核对。
6. **`模型路由.MD` 是否是规格**：它不在任务指定规格内，却是 `plan-baseline.json` 里 `router.*` 的 `src` 来源、也是代码注释的权威出处。**若承认它**，§9.3 顺序那条应降级为"按修订文档实现"；**但 §9.4 值域那条仍成立**（该文档通篇未定义 effort 值域，已逐行确认）。
7. **§2.2 vs §4.2 的 epoch 语义**：PLAN 内部矛盾（§2.2 要"只渲染当前 epoch"，§4.2 Step4/§1.2 要"L3 跨压缩累积"）。代码选了后者。**需规格方裁定**。
8. **`medium` 的真实命运**（§9.4）：写入 API 不校验、测试里 `'medium'` 能入库；真实 provider 是"报错"还是"静默忽略"本仓库无法判定。
9. **§8.4 防抖是否被强制夹在 2–3 s**：代码无区间校验，只取决于配置（forlife-qq=3000，合规）。
10. **§8.5 是否还需要"小模型"路径**：PLAN 写"规则**或**小模型"，二选一，已选规则。
11. **测试是否真的通过**：审计者**未执行 `node --test`**（避免产生写入）；所有测试名只证明"用例存在"。`docs/incidents/2026-10-06-empty-wake-storm.md`（§结果） 还记录过本机跑不了测试的历史。

---

## 6. 结论与优先修复建议

PLAN.MD 的**数值与表面结构**复现得很好：§12 的 15 个默认值逐字相等、三张权威表字段名一个不缺、三个 QQ 工具名都对、渲染形态与缓存断点位置有机器守卫（`scripts/lint-prompt-positions.ts` + `tests/prompt-contract.test.ts` 的三条自测）。

但**行为与接线**缺口很大，且缺口集中在"模型自主"这条主线上：压缩的自动阈值实际是宿主的 **0.8**（不是 0.5）；压缩请求的约束输入是**死代码**（生产恒被拒）；Recall 预算 **4/7 项参数无消费者**且计数器**永不重置**（用两次即失效）；中期→长期沉降、HDD 归档、冷层回读、启动回滚、大结果截断层、整条模型分级路由都是**"函数写好了但没人调用"**；`deviations.ts` 登记的两条规则级偏离描述的是**既没实现、前提也不成立**的状态，而真实的偏离（Parquet→NDJSON、压缩复用主对话前缀）**一条都没登记**。

**部署测试前建议优先修 4 条**：
1. **`beginTurn` / `observeShortTokens` 接线**（否则 §4.4 全废、`request_compaction` 恒被拒）；
2. **`resetCycle` 接线**（否则 `recall_longterm` 用两次后永久失效）；
3. **`recoverPendingCompactions` 挂到 `apply()` 启动路径**（否则崩溃后残留半写条目 —— 面板文案已在提示这件事）；
4. **`request_recall_extension` + §7.1 的预算 JSON 形状**（模型的行为约束全靠它）。

**第 5 条（同样建议立刻做）**：**重写 `deviations.ts`** —— 把 `archive.ts` 的 Parquet→NDJSON、压缩的"复用主对话前缀 + 尾部指令块"这两处**真实偏离登记进去**，并把现有两条与实际不符的登记改写成现状（或先把代码接上再保留登记）。

---

## 7. ★ 这份审计暴露的元问题

> 这一节不属于"PLAN vs 代码"，但比单条不一致更重要 —— 它们解释了**为什么这么多缺口能一路通过所有检查**。

### 7.1 `contracts/test/fidelity.test.ts` 是自指的

`packages/contracts/test/fidelity.test.ts:28` 的核心断言是：

```ts
for (const key of docOriginKeys()) {
  if (deviations.has(key)) continue
  const actual = defaultFor(key)      // ← 从 plan-baseline.json 派生
  const expected = baselineValue(key) // ← 同一个 plan-baseline.json
  if (!deepEqual(actual, expected)) offenders.push(…)
}
```

即**"JSON 对自己"**。它证明不了两件事：
1. **参数有没有消费者** —— 本次机器核对出的 8 个 `PLAN.MD` 来源零引用参数（`compaction.autoTriggerRatio`、`fragment.activeBudgetRatioMin/Max`、`recall.duplicateSimilarity`、`recall.resetPolicy`、`recall.extensionMax`、`recall.extensionCooldownTurns`、`recall.associativeDepthWarn`）**全部绿灯通过**；
2. **部署里真正生效的值** —— 例如自动压缩阈值，代码从不设置 `thresholdRatio`，profile 也不设，于是生效值来自宿主常量 **0.8**，而基线里写的是 **0.5**。`fidelity` 看不见 `node_modules` 里的第三份数字。

⇒ **"fidelity 全绿"不等于"一比一"**。要真守"一比一"，至少还需要两类检查：**消费点检查**（每个 `doc` 参数必须至少有一个 `defaultFor(...)` 之外的读取路径/断言）与**生效值检查**（把宿主默认与 profile 覆盖纳入比对）。

### 7.2 `EXECUTION_PLAN.md` 多处"声称有"而实际不存在

| EXECUTION_PLAN 的声称 | 实际 |
| :--- | :--- |
| `:375`「Recall 预算｜工具内计数器（per cycle / per turn）+ 重复查询相似度检测 + `request_recall_extension` 逃生通道｜预算信息**随每次工具返回**（PLAN §7.1 的 JSON 形状）」 | 无 `budget` 对象、无重复检测、无逃生通道 |
| `:933` 工具表列出 `request_recall_extension(reason, additional=2)` | 33 个已注册工具里没有它 |
| `:2036`「启动时 `recoverPendingCompactions()` 扫出残留的 `started` 按计划回滚」 | 该函数全仓零调用（含 `scripts/`、`.runtime/`） |
| `:2025`「✅ **中期→长期沉降 + 碎片索引**：`runtime.settle()`（不调模型的维护任务，可按 90 天或占比触发）」 | `runtime.settle()` 只有测试调用 |
| `:3156`「工具定义序列化：断言 `assemble().tools` 顺序与内容稳定」 | 该断言不存在 |
| `:497` 参数表引用 `midMemory.activeBudgetRatio` | `plan-baseline.json` 里没有这个键（实际是 `fragment.activeBudgetRatioMin/Max`，且两者零引用） |
| `:2905` / `:3223` 写的是「HDD 归档导出（**Parquet**）」 | 实现是 NDJSON + manifest |

⇒ **`EXECUTION_PLAN.md` 的 ✅ 勾选不能当实现证据**；它更适合当"意图清单"，必须逐条回到代码验证。

### 7.3 测试用"想象中的接线"把缺口盖住了

最典型的一处是 `packages/dsh-component/test/compaction-engine.test.ts:371-372`：

```ts
// 让运行时有真实的短期读数（真实链路里由 observeShortTokens 在每轮后写入）
runtime.observeShortTokens(4321)
```

注释里那句"**真实链路里由 `observeShortTokens` 在每轮后写入**"是**想象**——写它的时候（以及此后）**没有任何生产代码调用这个函数**。测试因此造出了一个生产里不存在的状态，让 §4.4 的整条裁决链路"看起来可用"。

同类模式还有：
- `acceptance-phase2.test.ts` 反复调用 `runtime.beginTurn()` / `observeShortTokens()` 来"验收 §4.4"；
- `failover-wiring.test.ts` 手工 `buildFailoverRuntime(...)` 验证降级链，而生产里无人构造它；
- `router/test/*` 覆盖了守卫/评分/启发式/切换的每一条路径，但 `new Router(` 只在这一个测试文件里出现。

⇒ **验收标准写成"某个函数在测试里表现正确"是不够的**；对"接线类"交付物，断言应当落在**宿主侧的挂钩注册点**或**进程入口**上（例：`assert.ok(index.ts 的 apply() 里出现了 recoverPendingCompactions(...))` 这类接线守卫）。本项目在**位置契约**上已经这么做了（`lint-prompt-positions.ts` 会扫源码里的 `section({...})`），同一手法完全可以复制到"钩子/定时器/启动步骤"上。

### 7.4 `deviations.ts` 两个方向都错了

`packages/contracts/src/deviations.ts:2-3` 自称是"**唯一**允许偏离设计文档的地方"。实际状态：

- **登记了 2 条，但两条都与代码不符**：
  1. 「§8.6 允许 provider 故障时被动降级」——`FailoverRuntime`/`buildFailoverRuntime` 生产零调用、无人消费 `FailoverDecision.next`、无 `agent/request(-error)` 订阅、承诺的 temperature/maxTokens 对齐零实现 ⇒ **登记的是一个不存在的机制**；
  2. 同一条里「主动切换仍然禁止」——`switch_model` 是**已注册的活工具**且测试断言它生效 ⇒ **前提不成立**（现状是"受控允许主动切换"）。
- **真实的规则级偏离一条都没登记**（至少 2 处，代码注释里甚至自己写了"⚠️ 与 PLAN 的一处偏离，必须说清"）：
  1. `packages/store/src/archive.ts:6-21`：归档格式 **Parquet → NDJSON + manifest**；
  2. `packages/dsh-component/src/compaction-engine.ts:131-140`：把 §4.2 的请求块顺序改为"全部并入尾部指令"，并**刻意复用主对话前缀**（与 §4.2/§10.4 相反）。

⇒ 偏离登记表当前**既漏记真实偏离，又记录了不存在的偏离**，因此它**不能**被当作"PLAN 与实现的差异清单"来读；本审计的 ❌ 清单可视为对它的补全（并建议据此重写）。

### 7.5 一条方法论层面的教训

**"我没找到 ≠ 不存在"，但"测试里有"也 ≠ "生产里有"。** 这次审计里两类假信号都出现过：
- 假 bug：在 `packages/contracts/src/*.ts` 里搜 `tiering.settleAfterDays` 找不到 ⇒ 差点误判"90 天没实现"；真相是**基线在 JSON 里**（`packages/contracts/src/baseline.ts:42` 指向 `../plan-baseline.json`）。
- 假实现：`fidelity` 全绿 + 大量测试通过 + `EXECUTION_PLAN` 全部勾选 ⇒ 看起来"已实现"；真相是**生产零调用**。

⇒ 判定"实现了没有"的唯一可靠口径是：**在非测试源码里找到调用点**；判定"参数生效了没有"的唯一可靠口径是：**追到最终请求/最终写入**（包括 `node_modules` 里的默认值与 `profiles/*.yml` 的覆盖）。

---

*审计者：DSH-ForLife 保真度核对（只读审计，除本文件外未修改任何文件；未执行测试；建议 2026-10-07 存档）*
