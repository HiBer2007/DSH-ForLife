# FIX_PLAN —— 相对 PLAN.MD 的偏离清单与修复设计

> 立此文件的理由：`PLAN.MD` 是**规格**，本文件是**账本**。
> 规格不改，账本记录"现在的实现偏离了规格哪里、为什么、怎么修"。
>
> 判据（本仓纪律）：**容器 healthy / 单测全绿 / `vue-tsc` 0 / 启动日志正常，都可能是假象。**
> 每一条结论都带 `文件:行号`，**可以自己核**。不许凭叙述下结论 ——
> 这份账本的由来就是同一件事被翻案了两次（见 §6）。

---

## 0. 这次为什么要立账

用户 2026-10-09 的话：

> 「90天沉降只是触发条件之一，他们是**或关系**来的，你要注意整个原始的 PLAN.MD 的条件
> 绝大多数都是**或**，是**任意满足一个即可**，设计上就是为了避免现在这样的问题的。**彻查，大改**」

结论：**不是零散 bug，是"多条件或"这一条设计原则在实现里被压成了"单条件与"。**
下面 D1 是它的直接后果，D2 是它掩盖着的第二个洞，D3 说明这两件事必须一起修。

---

## 1. D1 —— 沉降：三条件或只实现了一个，而且被当成前置过滤器（★ 致命）

### 规格

`PLAN.MD:119`（§4.1）：

```
| **中期→长期**（沉降） | 中期旧条目 | 长期记忆 + 碎片索引 | 中期占比、访问频率、定时 |
```

**三个条件是「或」** —— 任意满足一个即可。

### 实现

`packages/dsh-component/src/runtime.ts`：

```
1566:  const olderThanDays = options.olderThanDays ?? defaultFor('tiering.settleAfterDays')
1568:  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString()
1570:  const candidates = this.listEntries({ status: ['active'] })
1571:    .filter((e) => (e.last_accessed_at ?? e.created_at) < cutoff)   ← ★ 只有这一条
1572:    .slice(0, limit)
1582:  if (candidates.length === 0) return { …, notes: ['没有满足沉降条件的活跃条目'] }
```

| 条件 | 状态 |
|---|---|
| **定时**（久未访问） | ✅ 唯一实现 |
| **中期占比** | ❌ **从未实现** |
| **访问频率** | ⚠️ 排序隐含"最久未访问"，但被 1571 挡在前面，连求值机会都没有 |

**"中期占比"根本没写的证据**：`fragment.activeBudgetRatioMin` / `Max`
（`plan-baseline.json:65-72`，`v = 0.8 / 0.85`，`src = PLAN.MD §5.3（active 80–85%）`）
在全仓 `*.ts` 里**只有三处**：声明（baseline）、注释（`contracts/src/deviations.ts:204`）、
一个测试清单（`contracts/test/param-consumption.test.ts:65-66`）。
**没有任何生产消费点。**

### 后果

投喂进来的 11,114 条 `created_at` 全是今天 ⇒ `candidates = []`
⇒ 每一轮 `settle()` 直接返回"没有满足沉降条件的活跃条目"
⇒ **`long_memory_entries` 恒为 0。**

⚠️ **更正（我先前的说法是错的）**：`settle()` **确实写长期记忆** ——
`runtime.ts:1598` 就在它里面调 `insertLongEntry`，`:1606` `fragmentMidEntry`
把中期条目换成 `[F→]` 指针碎片。它只是**永远拿不到候选**。

### 修复设计

```
// PLAN.MD:119 —— 「中期占比、访问频率、定时」★三者或★
const stats  = this.stats()          // 已有：activeTokens / fragmentTokens / fragmentCount
const byTimer     = allActive.filter(e => (e.last_accessed_at ?? e.created_at) < cutoff)
const byRatio     = stats.activeTokens / activeBudget >= defaultFor('fragment.activeBudgetRatioMin')
                      ? allActive    // ★ 占比驱动 ⇒ 不受年龄限制
                      : []
const byFrequency = /* 从未被访问 / 访问次数最低的一批 */
// 三者取并集，按"最久未访问"排序，再交给 planFragmentation 决定能做多少
```

- ★ `notes` **必须写明是哪一条触发的**（否则又是新的沉默 —— D6 刚栽过）
- `planFragmentation`（`memory-core/src/compaction.ts:377`）**保持不动**：
  它的职责是"在给定候选里决定能做多少"，**不负责"要不要做"**（入参注释原文：
  `@param candidates - 候选条目（通常是"最久未访问"的一批）`）

### ⚠️ 卡点：分母 `activeBudget` 在代码里不存在

`PLAN.MD:257`（§5.3）：`**独立预算**：中期记忆区 = active 条目（80-85%）+ 碎片索引（15-20%）。`
⇒ 分母 = **「中期记忆区的预算」**。但基线里**没有任何键**叫这个。

| 候选分母 | 值 | 问题 |
|---|---|---|
| (a) `memory.midWindow.maxTokens` | 100,000 | 这是**注入窗口**预算（"这次往上下文放多少"），不是"中期区总共允许多大"。`deviations.ts:201` 明确警告过这两件事"别混为一谈" |
| (b) 由 `contextWindow` 推导 | 1,000,000 | `PLAN.MD` §1.2 说中期是"上下文窗口中的稳定前缀"，但**取多少 PLAN 没写** |

**两条路的后果完全不同：**
- 取 (a) ⇒ mid 占 1550% ⇒ 触发，并**一直沉到 mid ≈ 80k** ⇒ **几乎把 1.55M 全搬进长期**
- 取 (b) 若 500k ⇒ 沉到 400k 停 ⇒ 中期留 400k，其中只有 100k 能渲染，
  **剩下 300k 仍落在 D2 那个黑洞里**

**这是设计决定，不是技术选择。必须用户拍板（见 §4）。**

### 安全边界（已确认，可放心）

无论选哪个都**不会一轮搬空**：`fragment.maxCount = 50`（每轮最多新增 50 条碎片）、
`fragment.maxAreaRatio = 0.2`（碎片占比上限）、再加 `settle()` 的 `limit`
（`tiering.settleBatchSize`，启动日志显示 200）。
按 50 条/轮 × 30 分钟/轮估算，11,114 条搬完约 **4–5 天** —— 单调、可观察、可中止。

---

## 2. D2 —— 记忆黑洞：窗口外的中期条目**取不回来**（★ 致命）

`selectMidWindow()` 没选进上下文的那部分：全表 **1555k** → 窗口内 **99.9k** → **丢弃 1455k（94%）**。
窗口预算 = `memory.midWindow.maxTokens = 100000`。

它们**还在库里**（`status='active'`，token 还占着），**不是被删**。
但**没有任何工具能取回它们的正文**。

### 代码自己的原话

`runtime.ts:580-588`：

> ## ⚠️ 刻意**不**承诺一条不存在的回填路径
> 用户给的措辞示例是"可用 X 回填全文"。本仓**现在没有**这个 X：
> - `recall_full` 取的是**溢出工具结果**的全文（spill），**不是中期条目**；
> - `recover(id)` 只处理**长期**冷层条目，且返回的是字数与状态，**不含正文**；
> - `recall_longterm` 自己就是这里失败的那条路（长期库零命中）。
> ⇒ 真要给一条回填路径，得先有"**按 id 取中期条目正文**"的工具（见交付报告里的待定项）。

`runtime.ts:597-601` 对模型说的原话：

> 中期记忆里有 N 条相关，但它们**都已滑出当前上下文窗口**：
> **摘要与正文都不在你眼前，本次检索也取不回来。**

### 为什么"搜到了"≠"取得到"

`runtime.ts:542` 确实调了 `searchMidFts`，但**下一行是**：

```ts
return this.recallResult([], maxPerTurn, maxPerCycle, maxResults, this.midFallbackNote(mid))
//                       ↑ 空数组 —— 命中的条目从来没有被当内容返回
```

那个 `searchMidFts` **只用来数个数**，然后生成一句 note。

### 后果

模型对这 94% **彻底失忆**。唯一的安慰是 `midFallbackNote` 会如实说
"取不回来、别当成你记得"（不撒谎，但也没用）。

### 修复设计

加一个 **`recall_mid`** 工具：按 id（或按 query）返回**中期条目的正文**，
并**标明是否在窗口内**。`getMidEntry` 已经存在（`feed.test.ts:26` 有 import）。
同时让 `midFallbackNote` **带上 id** —— 否则模型知道"有几条"却不知道"是哪几条"，工具也没法调。

---

## 3. D3 —— D1 与 D2 是耦合的：**只修 D1 会制造新的永久黑洞**

`runtime.ts:537-546`：

```ts
const entries = searchLongFts(this.db, query, maxResults)
for (const entry of entries) touchLongEntry(this.db, entry.id)

// 长期库还空时，退一步查中期记忆（避免"刚开始用什么都搜不到"的挫败感）
if (entries.length === 0) {          // ← ★ 只在这一种情况下才搜中期
  const mid = searchMidFts(this.db, query, maxResults)
  ...
}
```

现在 `long = 0` ⇒ 这个兜底**恒触发**（虽然返回内容为空，至少 note 会告诉模型实情）。
**一旦沉降开始工作、长期库有内容** ⇒ 任何在长期库里命中 ≥1 条的查询**再也不会走这个兜底**
⇒ 那些还没搬完的中期条目**连"我知道有这么几条但取不回来"都听不到了**。

⇒ **D1 与 D2 必须同时修，不能先修一个。**

---

## 4. D4 —— 人格默认值是"示例值泄漏"

```
plan-baseline.json:712-715   "prompt.variables.personaName": { "v": "团子",
                               "src": "EXECUTION_PLAN §2.8（可编辑提示词的变量白名单）" }
config.ts:114                persona_name: defaultFor<string>('prompt.variables.personaName')
prompt.ts:169                **必须插值**：可编辑提示词里的 {{persona_name}} 要靠宿主替换
```

⇒ **系统提示词里确实写着「你是团子」**（模型那句 "I'm 团子 per system prompt" 是准确的，
不是它编的）。线上 `prompt_revisions` 表里搜不到「团子」，是因为表里存的是**模板**
（含 `{{persona_name}}` 占位符），值在**渲染时**才插进去。

**它看起来是"示例值泄漏"**：同一个「团子」还出现在
`store/src/prompt-text.ts:47` 的 `sample: '团子'` —— 一个**示例**。
一个**变量白名单**里的值，被 `defaultFor()` 当成**真实配置**读进了生产系统提示词。

| 键 | 现值 | 记忆里的真实情况 |
|---|---|---|
| `prompt.variables.personaName` | 团子 | 「呆肥鱼」 |
| `prompt.variables.ownerName` | 主人 | 「小猫」/ 海波_HiBer |
| `prompt.variables.personaRole` | 一个住在 QQ 里、会记得住事的伙伴 | 中性，可留 |
| `prompt.variables.language` | 中文 | 没问题 |

**修复设计**：改基线默认值（+ 线上同步）——
**改成什么名字需要用户给（见 §5）**。
另建议加一条守卫：防止"白名单示例值"再被当成生产配置。

---

## 5. D5 —— 喂食机制替模型做了它该做的决定

**现状（用户判定为不合理）**：投喂时系统把文档切成 ~7KB 段
（`.runtime/chat-feed-v2/` 283 段），每段由 `feedInput` **直接切碎成记忆条目**写进 mid
⇒ 模型**没有机会**做「条目化、总结化、印象化」，只是被动接收碎片。

**用户要的**：

> 「我们应该是把**大段大段的文本、数据、资料直接原始的喂给 AI**。
> 我之前说的裁切**不是按句子来的**，而是按照**一个 10k 到 50k token 等级的片段**来的，
> 目的是**防止一次性撑爆上下文**。」

⇒ 裁切**只为防撑爆上下文**，**不是替模型做摘要**。
模型自己决定存什么、怎么存（调 `remember` / `push_mid_memory`）。

**影响面**：`gateway/src/feed.ts` / `feed-chunk.ts` / `feed-batch.ts`、
`feed.*` 基线键（`chunkMaxTokens` 之类要重新定档到 10k–50k）、
`forlife:feed-mode` 提示段（"半梦半醒、接受前世记忆"那套要配合）。
**这是一次入口级重构，不是调参。**

---

## 6. D6 —— 沉降循环曾经完全沉默（**已修并上线 `69331de`**）

原 `runtime.ts:2041` 只在 `fragmented > 0 || archived > 0` 时才 `log(...)`
⇒ `settle()` 给的 `notes`（"没有满足沉降条件的活跃条目"）**被丢掉**
⇒「跑了但没候选」与「循环根本没挂上」在日志里**长得一样**。

**已改成每一轮都留痕**（含 0 那轮，并带上原因原话）。
2 条回归守卫；回退验证 **23/2 红 → 25/0 绿**；全量 **1710/1710/0**；`tsc` 0。

**这一条的价值**：它让 D1 从"看不出来"变成"日志里明摆着"。
下一个 30 分钟轮次就该出现：

```
[forlife] 沉降一轮：没有要动的（碎片化 0 / 淘汰 0）｜没有满足沉降条件的活跃条目
```

**—— 这一行就是 D1 的直接证据，也是修好之后应该消失的那一行。**

---

## 7. 我在这一条链上翻过的案（留档，防止再犯）

| 轮次 | 我说过 | 真相 |
|---|---|---|
| 1 | "没有任何工具能读窗口外的中期条目" | ✅ **对** |
| 2 | "`settle()` 只做碎片化/淘汰，**不写长期记忆**" | ❌ 错 —— `runtime.ts:1598` 就在里面写 |
| 3 | "把 §6.3 的 90 天当成 §4.1 的沉降门槛" | ❌ 错 —— 那是**长期→冷层**；§4.1 是三条件或 |
| 4 | "中期能检索到，只是长期库空时才走兜底" | ❌ 错 —— `recallResult([], …)` 返回空数组 |
| 5 | 以代码原话为准：**取不回来** | ✅ 对 |

**共同错因**：看到一个"像是消费点"的东西（`searchMidFts` / `insertLongEntry` / `90天`）
就下结论，**没有把上下游读全**。两次都是"读了一半"。

---

## 8. 需要用户拍板（其余工作都被它们挡着）

### 决定 A：沉降分母 `activeBudget`

- **① `memory.midWindow.maxTokens`（100k）** —— 语义最干净（中期只留一个窗口的量，其余全沉长期），
  但要接受"中期渲染预算 = 中期总量预算"这个合并
- **② `contextWindow × N%`** —— 你给 N。中期保留更多，但超出窗口的部分**依然落在 D2 的黑洞里**
- **③ 新增独立键**（如 `memory.midBudgetTokens`）—— 最贴近 `deviations.ts:201` 那句
  "别混为一谈"，但要新定一个数
- **④ 你直接给个数**

### 决定 B：人格名字

`prompt.variables.personaName`（现 `团子`）→ **？**
`prompt.variables.ownerName`（现 `主人`）→ **？**

---

## 9. 执行顺序（依赖已理清）

| # | 事项 | 依赖 | 风险 |
|---|---|---|---|
| **P0-a** | D2 的 `recall_mid` 工具 + `midFallbackNote` 带 id | 无（**不依赖决定 A**） | 低（纯新增读取路径） |
| **P0-b** | D1 沉降三条件或 | **决定 A** | **高**（`fragmentMidEntry` 不可逆） |
| **P0-c** | D3 解耦：中期检索不再只在长期为零时走 | P0-a | 中（改 `recall` 语义） |
| **P1-a** | D4 人格默认值 | **决定 B** | 低 |
| **P1-b** | D5 喂食机制重构（10k–50k 原始片段） | 无 | 高（入口级重构） |
| **P2-a** | 面板四块：活跃 / 中期 / 长期碎片 / 长期 | 无 | 低（纯前端 + 只读接口） |
| **P2-b** | 额度路由往 `deepseek-official` 倾 | 无 | 低 |
| **P3** | 彻底清空记忆 → 重新检查更新 → 重新导入 | **P0 与 P1-b 之后** | 中 |

**P0-a 可以先做** —— 它是唯一不依赖任何决定、又能立刻缩小黑洞的一步。

---

## 10. 四层口径（面板 P2-a 要用）

| 层 | 判据 | 现在 |
|---|---|---|
| **活跃** | `mid_memory_entries WHERE status='active'` | 11,114 条 |
| **长期碎片** | `mid_memory_entries WHERE status='fragmented'`（指向长期记忆的指针，`fragment_hint` + `fragmented_into`） | 0 条 |
| **中期** | 上面两者之和 = **中期记忆区**（`PLAN.MD:257`） | 11,114 条 / 1,555,127 token |
| **长期** | `long_memory_entries` | **0 条** |

⚠️ 「中期」**不是**「活跃」的同义词 —— 碎片也是中期区的一部分。
`PLAN.MD:257` 把中期区规定为 active 80–85% + 碎片 15–20%，
这正是 `fragment.activeBudgetRatioMin/Max`（0.8/0.85）与 `fragment.maxAreaRatio`（0.2）
**互补**的原因。

「窗口丢弃」= `selectMidWindow()` 没选进上下文的那部分（全表 1555k − 窗口 99.9k = 1455k）。
**不是沉降，也不是删除** —— 但按 D2，现在**取不回来**。

---

## 11. 硬约束（违反即失败）

- **不准重启 QQ 容器**（重启一次就得重新登录一次）。
  `up -d` 必须**点名服务 + `--no-deps`**，并 `docker inspect` **比对容器 ID** 前后一致
- 可移植：只用仓库内 `DSH_HOME`，**绝不碰宿主 `~/.dsh`**
- 密钥只存引用名；真值只落 `.runtime/` 或 VM `deploy/.env`（都 gitignored）
- 每个修复要有**回退验证**（注入 ⇒ 红，还原 ⇒ 绿，**给出两次数字**）
- 每个新接线配**接线守卫测试**（读源码、**去注释后**、**语句位置**、**断言结果被用**）
- 改 `.vue` 必须 `vue-tsc`（用 `packages/admin-ui/node_modules/.bin/` 那份）
- 提交前跑全量 `pnpm test`，**不与其他重活并发**
  （并发会造出几百条假红：失败项耗时全是 `0.02ms` 量级就是环境问题）
- 重建必须带 `-f deploy/docker-compose.dev.yml`
- **绝不删用户的文件**
- ★ 会写/删记忆的改动，**分母与阈值没读清之前不许猜**
- ★ PowerShell here-string 是 CRLF、`Get-Content -Raw` 是 LF ⇒ 锚点不匹配先归一化

---

## 12. 环境事实

- VM `192.168.1.121` / user `hiber2007` / key `.runtime/pve_deploy_key`
- 四容器 `forlife-{dsh,gateway,caddy,qq}-1`；`/data/dsh` 是 Docker 卷 `dsh-home`
  （宿主上看不到，要进容器）
- 库 `/data/dsh/forlife/db/forlife.sqlite`：
  **mid 11,114 / 1,555,127 token；long 0；spill 0；compaction_runs 0；epoch 0**；
  `prompt_revisions` 2 条；`wake_*` / `status_state` / `effects` 全空
- profile 在卷里 `/data/dsh/profiles/{forlife-headless,forlife-qq,forlife-web,headless}`
  ⇒ **改完立刻生效、不用重建镜像**（二分与试验成本极低）
- 段包 `.runtime/chat-feed-v2/`（283 段）+ 刷新闸门 `SOURCE.json` + `refresh.mjs`
- **QQ 处于掉线状态**
- `opencode-go` 额度 **9%**、另一个 **3%**、**DS 主账户还有额度**
- 已落档：`docs/notes/audit-2026-10-09-round2.md`（瀑布根因 + 8 条嫌疑定性）
