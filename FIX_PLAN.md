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

**影响面（★ 2026-10-09 更正：原来这里点名的文件是错的）**：

⚠️ **先说清楚谁不是元凶**：`gateway/src/feed-chunk.ts` **不是**那个"按句子切碎"的分块器。
它的模块头自己写着（`:14` / `:27` / `:30`）：

> ⇒ 所以必须有**单条天花板**：超过就机械切开，**与"用户喂了多少"无关**
> **只有超限才切。这不是"另一套分块器"，是把"单条不许无界"这条上界补上**

它是一个**安全上限**（`feed.chunkMaxTokens`，基线值 2000），只在单条超限时兜底。
把"283 段"算到它头上，就会改错地方。

**真正的三段链路**：

| 环节 | 在哪 | 现在做什么 | 要改成什么 |
|---|---|---|---|
| ① **离线分段** | `.runtime/chat-segv2-tool/generate.py`（**不在仓库里**，是运行时工具） | 把聊天导出按**对话/句子**切成 ~7KB 的段（283 段） | 按 **10k–50k token** 粗切，**保持原文**、不做语义加工 |
| ② **喂食入口** | `gateway/src/feed.ts` 的 `feedInput` | 把每段内容**直接切碎成记忆条目**写进 mid | **把原文作为一轮输入交给模型**，由模型自己调 `remember` / `push_mid_memory` |
| ③ **单条上限** | `gateway/src/feed-chunk.ts` + `feed.chunkMaxTokens=2000` | 单条超限机械切开（安全网，**保留**） | 上限要重新定档 —— 既然片段本身就是 10k–50k，2000 这条会**把每个片段再切碎**，与"原文交给模型"直接冲突 |

**★★ 2026-10-09 实测更正：真正的碎片化在 ② 的解析粒度上，不在 ③**

**实测条目分布**（线上库，11,114 条 / 1,555,127 token）：

```
均值 140 · 中位 106 · p90 295 · max 1477
```

**`max = 1477 < feed.chunkMaxTokens = 2000` ⇒ 这条上限一次都没触发过，它不是元凶。**
（我先前量出"283 段里 282 段超 2000"就下了结论 —— 那是**段**的大小，不是**条目**的大小。
段被解析完之后的条目只有 140 token。**量错了对象。**）

**真正的碎片化是 `feed.ts` 按"聊天消息"逐条写记忆**：

```
source_scope = feed:chat/seg2-006  →  77 条，均值 87 token
source_scope = feed:chat/seg2-002  →  64 条，均值 89 token

[feed_ad51b03b3b_1]  84 token = 说明性的两行
[feed_ad51b03b3b_2] 758 token = **一条消息**（`[2] 助手（2026-09-25 22:21）：〔THINK〕…`）
```

⇒ **一个 7,000 字符的段 → 50~77 条记忆，一条 = 一条消息。**
这就是用户那句"喂食机制直接把文档拆解碎片然后拆到记忆条目里面"的字面实现；
也解释了为什么模型"没有按照条目化/总结化/印象化来存储" ——
**它从来没见过一段完整的话，只见到了被拆散的单条消息。**

**⇒ P1-b 的靶心是 ②，而且已经精确到行：`feed.ts` 的"朴素段落切分"**

```
feed.ts:283  export function splitIntoFeedChunks(text)   ← ★ 元凶
feed.ts:291    for (const line of text.split(/\r?\n/))    ← 按行扫，空行/标题行断开
feed.ts:471  // ① 段落切分（朴素段落切；段落级的复杂分块属于记忆系统本身）
feed.ts:695  const appended = appendMidEntry(db, { … })   ← 每个"段落"写一条记忆
```

模块头 `:42-43` 自己写着：

> **分块**：段落级只做最朴素的"**空行或标题行断开**"（`splitIntoFeedChunks`）——
> 这就是人写 Markdown 时的自然段落边界。**复杂分块不在这里**

**为什么它在投喂路径上变成碎片机**：我们的段是「**一行一条消息**
（`[58] 助手（2026-10-04 20:45）：`）＋ 空行分隔」的形态，
于是**每条消息都符合"一个段落"的定义** ⇒ 每条消息各写一条记忆。
7,000 字符 ÷ 每条消息 ≈ **50~77 条** —— 与实测（77 / 64 / 60 条）逐一对上。

**改法（待落地）**：在投喂路径上**不再用 `splitIntoFeedChunks` 替模型分段**，
改为把**整块原文**作为一轮输入交给模型，由模型自己决定条目化/总结化/印象化
（调 `remember` / `push_mid_memory`）。`splitIntoFeedChunks` 本身可以保留给
其它入口 —— 它的注释说得很清楚："段落级的复杂分块**属于记忆系统本身**"，
而"记忆系统"就是模型。**现在这一步被代码替模型做了。**
③（`chunkMaxTokens`）**不用动** —— 设计是对的（防畸形输入），实测也证明它安静待着、没参与。
①（离线分段 7k → 10k–50k）仍要改，但属**次要**：段已经够大，问题是段进去之后被拆碎了。

<details><summary>更正前的推理（保留作记录，已被上面的实测推翻）</summary>

**（已被推翻）所以 P1-b 的关键判断点是 ③**：`feed.chunkMaxTokens = 2000` 这条安全网，
在"10k–50k 原始片段"的新设计下**必须先重新定档**，否则模型拿到的仍是碎片
（这正是用户看到的现象：模型"并没有按照条目化/总结化/印象化来存储"，
因为**它从来没见过完整的段落**）。

</details>

**另外要动**：`forlife:feed-mode` 提示段（"半梦半醒、接受前世记忆"那套措辞要配合新流程）。
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


---

## 13. ★★ 决策 C（2026-10-09 新出现）—— 喂食写入路径取哪一形态

P1-b 的靶心锁定到 `feed.ts:283 splitIntoFeedChunks` 之后，暴露出一个**必须由用户拍板**的岔路。
两条路都能满足"不再按消息拆碎"，但**代价完全不同**：

| | **C-① 整块直写**（改动小） | **C-② 交给模型**（改动大，但符合原意） |
|---|---|---|
| 做法 | 投喂路径上**不再调用** `splitIntoFeedChunks`，一个段 = **一条**记忆条目（原文原样入库） | 投喂时把整块原文作为**一轮输入**交给模型，由模型自己调 `remember` / `push_mid_memory` |
| 条目数 | 283 段 → **283 条**（现在是 11,114 条） | 由**模型**决定，未知（可能远少于 283，也可能更多） |
| 谁做"条目化/总结化/印象化" | **没人做** —— 原文整块躺着（比碎片好，但仍不是记忆） | **模型做** —— 这正是用户原话要的 |
| 顺带要改 | `feed.chunkMaxTokens`（2000）**必须同时重定档**，否则 `feed.ts:480-490` 会把整段再切回碎片 | 同样要重定档 |
| 风险 | 低（一处判断 + 一个基线值）；但**11k 条既有碎片不会自动变好** | 中高（入口级重构 + 模型行为不可完全预测） |
| 可回退性 | 高（改回一次调用） | 中 |

**用户的原始诉求对应 C-②**：

> 我们应该是把**大段大段的文本、数据、资料直接原始的喂给 AI**
> ……模型并没有按照**条目化、总结化、印象化**来存储记忆

⇒ **"原始地喂给 AI"是手段，"由 AI 条目化"才是目的。** C-① 只做到了前半句。

**我倾向 C-②**，但它是入口级重构、且会改变"记忆里最终长什么样"，
而 P3（清空重导）要在这个决定**之后**才做 —— 否则重导一次就白导一次。

**⚠️ 因此 P3 在决策 C 落地前不得开始。**


---

## 14. 状态快照（2026-10-09 收尾）

⚠️ **§9 那张表是"原始排序"，它的状态列已经过时。以本节为准。**

### 已完成 + 已上线（真机验证过）

| 项 | 提交 | 判据 |
|---|---|---|
| D6 沉降循环不再沉默 | `69331de` | 每轮留痕（含 0 那轮）且带原因原话；回退验证 23/2 红 → 25/0 绿 |
| P0-a `recall_mid` 回填路径 | `fb05f99` | 真机启动日志里的 43 个工具中含 `recall_mid`；回退验证 12/1 红 → 13/0 绿 |
| P0-c 中期层检索解耦 | `012cd71` | 双向回退验证（堵回 `===0` ⇒ 3/1 红；两处 id 都丢 ⇒ 3/1 红；还原 4/0 绿） |
| P2-a 面板四块口径 | `5c6247f` | `vue-tsc` 0；双向回退验证；全量 1719/1719/0 |

### 半途 / 已回退 —— **需要一次重建才能对齐**

**P2-b（L1 换到 `deepseek-official`）**：

- 真机上**验证成功了**：`current=deepseek-official/deepseek-flash:high`（探针那一行亲口确认）
- 但 `compaction-threshold.test.ts` 抓到副作用：压缩触发点 = `contextWindow × 0.6`，
  而那 **1M 上下文是 `deepseek-v4.1-flash` 的事实** ⇒ 换模型后"600k"不再成立
- 而 `MODEL_CONTEXT_WINDOWS` 登记表里**没有** `deepseek-flash`，且该表规则是
  「**查不到就别填**」⇒ **先把仓库改回去了**（全量恢复绿）
- ⚠️ **当前不一致**：仓库 profile = `opencode-go/deepseek-v4.1-flash`；
  **线上容器 = `deepseek-official/deepseek-flash`**（上一轮重建进镜像的）
- **解冻条件**：拿到 `deepseek-flash` 的上下文窗口真值（或用户说"回退"）⇒ 一次重建对齐

### 三个决定（都不是我能替你定的）

| | 决定 | 要什么 | 卡住谁 |
|---|---|---|---|
| **A** | 沉降分母 `activeBudget` | 一个数（①100k／②`contextWindow×N%`／③新增键／④直接给） | **P0-b**（整份计划的核心） |
| **B** | 人格名字 | 两个词：`personaName`（现团子）→？　`ownerName`（现主人）→？ | P1-a |
| **C** | 喂食写入路径（见 §13） | 选 C-① 整块直写／C-② 交给模型 | **P1-b，且 P3 必须排在它后面** |

### 还没动的

- **P0-b**（沉降三条件或）—— 靶心与分母的缺口都已查明，只差**决定 A**
- **P1-a**（人格默认值）—— 只差**决定 B**
- **P1-b**（喂食重构）—— 靶心已精确到行（`feed.ts:283/291/471/695`），只差**决定 C**
- **P3**（清空 → 重导）—— ★ **在决定 C 落地前不得开始**，否则白导一次

### 给接手的人（含未来的我）

1. **先量，再断言。** 本次会话我四次"读了一半就下结论"，第四次是**量数据**抓住的
   （我量了"段"的大小却断言"条目"的成因；换成量条目，均值 140 vs 预期 1750，立刻对不上）。
   这个顺序对"我该量什么"这个问题免疫 —— **比"多读一点"更可靠**。
2. **CRLF 咬过三次。** 凡 Windows 上生成、要进容器或要按行锚定的文本，
   改完先**断言改动真的发生了**（出现次数 1/1），不满足就中止，别继续往下跑。
3. **判据要可观察。** 例：改默认模型后必须看
   `[forlife] LLM 探针：… current=<provider>/<model>` 那一行**真的变了**，
   而不是看配置文件写对了。
4. **改了会写/删记忆的路径，分母与阈值没读清之前不许猜。**


---

## 15. D7 —— 面板「DSH 后端状态 = 未配置」（用户问过，此前只活在对话里，没有归宿）

### 用户原话

> 此外大盘显示 **DSH 后端状态为未配置！？**

### 根因：**它在如实回答，不是 bug**

`gateway/src/dsh-status.ts:64-78`：

```ts
export function dshUrlFromEnv(env) {
  const explicit = env['FORLIFE_DSH_URL']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  // 唤醒桥的地址里就含 DSH 的 host:port —— 从它推导，省一个配置项
  const bridge = env['FORLIFE_WAKE_BRIDGE_URL']
  ...
  return undefined            // ← 两个都没有 ⇒ undefined
}
```

而线上**两个变量在 `dsh` 与 `gateway` 容器里都没有**（实测 `printenv` 结果为空）
⇒ `reachable: undefined` ⇒ 面板按设计显示"未配置"（`dsh-status.ts:22-26` 特意区分
`undefined`（没配）与 `false`（配了连不上），理由是"合成一个 false 的话，
用户会去查一个根本没配的东西"—— **那正是现在该做的：去配它**）。

### ★ 但它还连带一个**功能缺口**，不只是显示问题

`FORLIFE_WAKE_BRIDGE_SECRET` 同样没配 ⇒ 启动日志里有：

> `⚠️ 未配置 FORLIFE_WAKE_BRIDGE_SECRET：唤醒桥端点未挂载`

⇒ **gateway → DSH 的那条 HTTP 唤醒路径根本没挂上**，唤醒只能走库里的
`wake_requests` 队列（由 DSH 侧的 poller 取）。**这不是显示问题，是少了一条路。**

### 修法（判据都是可观察的）

1. 在 `deploy/docker-compose*.yml` 里给 `dsh` / `gateway` 两个服务补上
   `FORLIFE_DSH_URL`、`FORLIFE_WAKE_BRIDGE_URL`、`FORLIFE_WAKE_BRIDGE_SECRET`
   （具体值要从 DSH web 的监听端口与容器名推出来，**先读再填，别猜**）
2. **判据 A**：重启后 `docker logs forlife-dsh-1` 里**不再**出现"唤醒桥端点未挂载"
3. **判据 B**：面板「DSH 后端」卡从"未配置"变成**可达**（或至少从 `undefined` 变成
   明确的 `true`/`false` —— 后者也说明探针真的在探了）
4. 全程**点名服务 + `--no-deps`**，并 `docker inspect` 比对 QQ 容器 ID

### 状态

**未开工。** 它不依赖决策 A/B/C，但需要先把"DSH web 到底监听在哪"读清楚
（`forlife-web` 这个 profile 名就暗示它是个 web 服务，但端口与路径我没读过）——
按这个仓库的纪律，**没读清之前不许填**。


### ★★ §15 补充（2026-10-09）：端口读到了，结论比"去配个变量"复杂

实测 `dsh` 容器内的监听：

```
tcp  0  0  127.0.0.1:3080  0.0.0.0:*  LISTEN  1/node     ← DSH web，**仅回环**
tcp  0  0  127.0.0.11:46361 0.0.0.0:*  LISTEN  -          ← docker 内嵌 DNS
```

而 `forlife-caddy-1` 的 Caddyfile 里有一条**标注为"别改"的硬规则**：

> 3. **DSH 自己的 Web UI 不在这里暴露**：它的 `/api` 有 Host/Origin 信任栅栏、
>    cookie 是 host-only + SameSite=Strict，**官方明确不支持非本机域名反代** ⇒ 留 loopback / 隧道。

⇒ **`FORLIFE_DSH_URL` 在当前拓扑下不是"忘了配"，而是"配了也连不上"。**

`127.0.0.1:3080` 是 **dsh 容器自己的回环**；`gateway` 是**另一个容器**，
它访问 `127.0.0.1` 打的是它自己。⇒ 除非让 DSH 绑到容器网络接口，
否则 gateway 永远探不到 DSH 的 web 后端 —— **面板那张卡在当前架构下注定显示"未配置"**。

### 而且这里还藏着一个**设计假设值得怀疑**

`dsh-status.ts:67-77` 从 `FORLIFE_WAKE_BRIDGE_URL` **推导** DSH 的 host:port：

```ts
const bridge = env['FORLIFE_WAKE_BRIDGE_URL']
// 唤醒桥的地址里就含 DSH 的 host:port —— 从它推导，省一个配置项
```

这个"省一个配置项"的前提是：**唤醒桥与 DSH 的 web UI 在同一个 host:port 上**。
但按 Caddy 那条规则，DSH 的 web UI 是**故意只留 loopback**的；而唤醒桥应该是
**我们自己的插件**在 dsh 进程里挂的端点（启动日志那条
"未配置 `FORLIFE_WAKE_BRIDGE_SECRET`：唤醒桥端点未挂载"说的就是它）。
**两者未必同端口** —— 那样这个推导就会推出一个错的地址。

⚠️ **这一条我没有证实**（没读过唤醒桥的挂载代码），所以只作为**待查项**记在这里，
不当结论用。

### 三个选项（等用户拍板，或先查证再定）

| | 做法 | 代价 / 风险 |
|---|---|---|
| **A** | 让 DSH 绑到容器网卡（`0.0.0.0:3080`）+ `FORLIFE_DSH_URL=http://dsh:3080` | 把 DSH web UI 暴露给整个 docker 网络；且 Caddy 那条规则说官方**不支持**这种用法 ⇒ **不建议** |
| **B** | 只挂**我们自己的唤醒桥端点**（插件在 dsh 内监听一个端口，gateway 走容器网络访问），`FORLIFE_DSH_URL` 单独填 | 最贴合"唤醒桥"的原意；需要先读清挂载代码与端口分配 ⇒ **倾向这条** |
| **C** | 承认探不到，把面板文案从"未配置"改成**如实说明**（"DSH web 仅容器内回环，本架构无法探测"） | 最小改动；但用户从此失去"DSH 挂了能一眼看出"这个**设计初衷**（`dsh-status.ts` 模块头写的就是这个理由） |

**⇒ 在做 A/B/C 之前，先查证一件事**：唤醒桥端点到底挂在哪、与 DSH web 是否同端口。
这决定了 `dsh-status.ts` 那个"推导"是不是一个**错的假设** —— 如果是，
那它不只是"未配置"，而是**会推导出一个连不上的地址**（更糟：`reachable:false` 会让你去查一个不存在的问题）。


### ★★ §15 二次补充：我上一条的怀疑**被证伪**，但真问题因此更清楚了

**证据一**（`packages/gateway/test/dsh-status.test.ts:41`）：

```ts
assert.equal(dshUrlFromEnv({ FORLIFE_WAKE_BRIDGE_URL: 'http://127.0.0.1:3080/forlife/wake' }),
             'http://127.0.0.1:3080')
```

**证据二**（`packages/dsh-component/src/index.ts` 的三条失败分支）：

```
:243  ⚠️ 宿主没有 ctx.inject：唤醒桥端点未挂载（无法延迟获取 webServer）
:267  ⚠️ 未找到 webServer 服务：唤醒桥端点未挂载（gateway 无法唤醒模型）
:282  ⚠️ 缺少服务 …：唤醒桥端点未挂载（挂上去也只会让 gateway 收到一堆 500）
```

⇒ **唤醒桥就挂在 DSH 自己的 webServer 上，路径 `/forlife/wake`，端口正是实测的 3080。**
我先前怀疑"唤醒桥与 DSH web 未必同端口" —— **证伪了**。
`dsh-status.ts:67-77` 那个"从 bridge URL 推 host:port"的假设**是按设计成立的**，不是错的。

### 但真问题因此**更严重**，不是更轻

链条现在是完整的：

1. 唤醒桥 = DSH webServer 上的一条路由 ⇒ **监听在 dsh 容器内的 `127.0.0.1:3080`**
2. `gateway` 是**另一个容器**
3. ⇒ gateway 调 `http://127.0.0.1:3080/forlife/wake` 打的是**它自己的回环**

⇒ **不只是面板那张卡显示不出来 —— 整条 gateway → DSH 的 HTTP 唤醒链路在当前拓扑下都够不着。**
这不是"忘了配变量"，是**两个容器之间没有那条回环**。

### 那代码里为什么处处写 `127.0.0.1:3080`？

因为**设计意图很可能是"gateway 与 dsh 共享网络命名空间"**（sidecar）：
那样 `127.0.0.1:3080` 正好可达，DSH 的 web UI 又**保持只留回环**
（满足 Caddy 那条"官方不支持非本机反代"的硬规则），
而面板由 Caddy 反代到 **gateway 自己的端口**。

⚠️ **这是推断，我没有验证过 compose 里两个服务的 network 配置。**
但它给出一个**可验证的假设**：

> **假设**：给 gateway 加 `network_mode: "service:dsh"`（或等价的共享 netns），
> 那三个变量就能用 `127.0.0.1:3080` 正常工作。

**判据（可观察）**：
- 日志里不再出现"未配置 `FORLIFE_WAKE_BRIDGE_SECRET`：唤醒桥端点未挂载"
- 面板「DSH 后端」卡从"未配置"变成**可达**
- 且 Caddy 那条硬规则**不被违反**（DSH web UI 仍只在回环）

**风险**：改网络拓扑会影响 gateway 与 caddy 之间既有的连通方式
（gateway 的 8081 是 Caddy 反代的目标）—— **改之前必须先把"caddy 怎么找到 gateway"读清楚**，
否则会把面板一起弄断。**所以这条仍然是"先读清再动"。**


### ★★ §15 三次补充：「共享 netns」假设**被推翻**，真相比它简单得多

实测（`docker inspect` 的 `NetworkSettings.Networks`）：

```
forlife-dsh-1        forlife_edge + forlife_internal
forlife-gateway-1    forlife_edge + forlife_internal     ← ★ 与 dsh 同在两个网络
forlife-caddy-1      forlife_edge
forlife-qq-1         forlife_edge + forlife_internal
```

```
gateway 监听：0.0.0.0:8081 ／ 0.0.0.0:3010
caddy.ts:306   upstreamHost = input.upstreamHost ?? '127.0.0.1'   ← 默认可覆盖
```

⇒ **dsh 与 gateway 本来就同网** ⇒ **不需要共享网络命名空间**（我上一条的假设**错了**，而
且是"往复杂处猜"—— 这已经是本次会话第 6 次）。够不着的**唯一**原因是：
**DSH 只绑了 `127.0.0.1`**，没绑容器网卡。caddy 也不是靠 `127.0.0.1` 找 gateway 的
（它靠传入的 `upstreamHost` 覆盖默认值）。

### 所以 D7 的修法收敛成一条，而且不碰网络拓扑

1. 让 **DSH 绑到容器网卡**（`0.0.0.0:3080`，是 DSH 自己的启动参数/配置 —— **要先读它的 CLI**）
2. `dsh` 与 `gateway` **两个**服务都补上：
   - `FORLIFE_DSH_URL=http://dsh:3080`
   - `FORLIFE_WAKE_BRIDGE_URL=http://dsh:3080/forlife/wake`
   - `FORLIFE_WAKE_BRIDGE_SECRET=<一个共享密钥>`（真值只进 VM 的 `deploy/.env`）
3. **判据**：日志里"唤醒桥端点未挂载"消失 + 面板「DSH 后端」卡从"未配置"变成**可达**
4. 全程点名服务 + `--no-deps` + 比对 QQ 容器 ID

**不违反 Caddy 那条硬规则**：那条规则反对的是**用公网域名反代 DSH 的 web UI**
（它的 `/api` 有 Host/Origin 信任栅栏、cookie 是 host-only + SameSite=Strict）。
绑到 docker 内网**不发布端口、也不加任何公网路由** ⇒ 仍然只有容器之间能到。

### ⚠️ 但有一个**真实的暴露面扩大**，必须写明

`edge` 网络里还有 **caddy**，`internal` 与 `edge` 里还有 **qq**。
把 DSH 的 web UI 绑到容器网卡之后，**这些容器就都能访问 DSH 的 admin API**了
（现在只有它自己）。QQ 容器是被外部输入驱动的那一个 ——
**它一旦被拿下，就能直接调 DSH 的管理接口**。

⇒ 所以这一步在**安全上是净负**，换来的是"面板能看见 DSH 状态 + HTTP 唤醒链路可用"。
**这个取舍该由用户拍板**，不该我替他定。

### 备选（不想扩大暴露面的话）

- **D-1**：只开唤醒桥需要的那个**路径/端口**（若 DSH 支持把某条路由绑到独立端口）——
  需要先读 DSH 的 CLI 能力
- **D-2**：接受现状，把面板文案改成如实说明（见上文选项 C）——
  代价是放弃"DSH 挂了能一眼看出"这个设计初衷
- **D-3**：给 DSH 的 web UI 加一层**只认 gateway 的鉴权**（若有）—— 同样要先读 DSH 能力


---

## 16. ★ 真机验证记录（2026-10-09 10:41Z）—— D6 生效 + D1 在**生产里**被看见

容器 `forlife-dsh-1` 跑满第一个 30 分钟沉降轮次后，日志里出现了：

```
[forlife] 沉降循环已启动：每 30 分钟一轮（中期→长期，每轮最多 200 条）
[forlife] 沉降一轮：没有要动的（碎片化 0 / 淘汰 0）｜没有满足沉降条件的活跃条目
```

对照库：`long = 0`、`fragmented = 0`（沉降没有任何产出）。

### 这一行同时证明了两件事

**① D6 的修复真的在生产生效。**
修复前，那个 `if (fragmented > 0 || archived > 0)` 会把这一行**整条吞掉** ——
日志里只会剩"已启动"，读者**分不出**"循环没挂上"和"挂了但没候选"。
现在它每一轮都说话，**并且把 `settle()` 给的原因原话带出来了**。

**② D1 的机制在真机上被直接看见，不再是我的推理。**
`｜没有满足沉降条件的活跃条目` —— 循环**确实在跑**，**确实找到了零个候选**。
而原因就是 §1 查明的那个：唯一实现的"定时"条件（`runtime.ts:1571` 的
`created_at < cutoff`）把所有今天写入的条目全滤掉了。

### ★ 判据

**这一行就是 P0-b 做完之后应该消失的那一行** ——
它会变成 `沉降一轮：碎片化 N 条、淘汰 M 条｜…`（且带上是"占比"还是"定时"触发的）。

⚠️ 前提仍然是**决定 A**（分母）：`fragment.activeBudgetRatioMin/Max` 那套要拿谁当分母。
分母没定，`byRatio` 就写不出来，这一行也不会变。


### ★★ §15 四次补充：D7 的未知量拿到了（DSH 的 CLI 开关）—— **可以动手了**

用户已授权打通（决定 D）。gating fact 已读到，不是猜的：

```
Usage: dsh --profile web [options]
  --host <host>                  bind host
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence
                                 accepts (host or host:port; repeatable)
```

而线上容器的命令是（`docker inspect` 读出来的）：

```
dsh --profile forlife-web --no-open
```

**没有 `--host`** ⇒ 默认绑回环 ⇒ **这就是 gateway 够不着的根因**，与之前实测的
`127.0.0.1:3080 LISTEN` 完全吻合。

### 改动（三处，都很小）

1. **`deploy/docker-compose.yml` 的 dsh 命令**：加 `--host 0.0.0.0`
   （端口 3080 不变；**不给它加 `ports:` 映射** ⇒ 仍然只在 docker 网络内可达，
   不对外发布）
2. **`--trusted-host`**：`/api` 有一道 **browser-trust fence**（按 Host/Origin 校验）。
   gateway 用 `http://dsh:3080` 调用时，Host 是 `dsh:3080` ⇒ **大概率需要
   `--trusted-host dsh:3080`**。
   ⚠️ 这条**没有验证过**（没读过 fence 的实现）⇒ 实测时若报 403/拒答，就是它。
   原则：**只加必需的那一个 authority，不要图省事加一堆**（加得越多，栅栏越松）。
3. **`dsh` 与 `gateway` 两个服务**都补：
   - `FORLIFE_DSH_URL=http://dsh:3080`
   - `FORLIFE_WAKE_BRIDGE_URL=http://dsh:3080/forlife/wake`
   - `FORLIFE_WAKE_BRIDGE_SECRET=<共享密钥>`
     ⇒ **真值只进 VM 的 `deploy/.env`**（仓库只留变量名，符合既有纪律）

### 判据（都可观察）

- **判据 A**：`docker logs forlife-dsh-1` 里**不再出现**"未配置 `FORLIFE_WAKE_BRIDGE_SECRET`：
  唤醒桥端点未挂载"
- **判据 B**：面板「DSH 后端」卡从"未配置"（`reachable: undefined`）变成**可达**
  —— 这是 `dsh-status.ts` 那个探针**第一次真的在探**
- **判据 C**：`forlife-qq-1` 的容器 ID 前后一致（**全程点名服务 + `--no-deps`**）

### 关于用户对安全面的判断

用户明确表示：caddy 与 qq 容器、尤其 QQ **没有外部执行安全隐患**，可以打通。
⇒ 按用户判断执行，不再重复讨论这一点。
（`--host 0.0.0.0` 且**不发布端口** ⇒ 仍然只有 docker 网络内可达；
若日后想收紧，可加一条只放 dsh+gateway 的专用网络 —— 记为可选加固，**不在本次范围**。）


### ★★★ §15 五次补充：**A 被 DSH 硬禁止**，D7 的结论到此确定

#### 实测：`--host 0.0.0.0` 会让 DSH 起不来

按四次补充的三处改动执行后，`forlife-dsh-1` 进入 `Restarting` 循环，日志反复打：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network;
       use 127.0.0.1 instead
```

⇒ **DSH 的作者明确认定它的 `/api` 一旦被网络上任何东西碰到就等于交出 RCE，
所以在代码里硬禁了。** 这不是"风险"，是一堵墙。

**已回滚**：VM 的 `deploy/docker-compose.yml` 用备份还原（`残留 --host 次数: 0`），
`docker inspect` 确认命令回到 `exec dsh --profile forlife-web --no-open`；
dsh `Up (healthy)`；**QQ 容器 ID 前后一致**。仓库**完全没动**（改动只落在 VM 上）。
`/opt/forlife/deploy/.env` 里我生成的那行密钥**现在是惰性的**（compose 已不引用它），
留着给 D7-B 用。

#### 而且：**我们的插件本身就挂在 DSH 的 webServer 上**

回滚后的启动日志里有：

```
[forlife] 已注册面板接口 /api/forlife/{state,entries,compaction,spills,health}
```

⇒ 面板接口与唤醒桥**同源** —— 都走 `ctx.inject('webServer')`。
这也解释了 `index.ts:243/267/282` 那三条失败分支为什么都在谈 `ctx.inject` / `webServer`。

#### 所以 D7 只剩两条路

| | 做法 | 判断 |
|---|---|---|
| ~~A~~ | 绑容器网卡 | ❌ **DSH 硬禁止**（RCE），此路不通 |
| **B** | 让我们**自己的插件在 dsh 容器里另开一个监听端口**挂唤醒桥（不依赖 DSH 的 webServer） | 这是**代码改动**（`dsh-component` 里自建 http server），不是配置改动。可行，但要写代码 + 守卫测试 |
| **C** | 承认探不到，把面板那张卡的文案改成**如实说明**；唤醒继续走库里的 `wake_requests` 队列（现状就是这样，一直能工作） | 最小改动。代价：放弃"DSH 挂了能一眼看出"这个设计初衷 |

**⇒ D7 现在的性质变了**：它不再是"配三个变量"（十分钟的活），
而是 **B（写代码自建监听）或 C（改文案承认探不到）** 二选一。
**用户原话是"打通"，但打通的技术前提已被 DSH 自己否掉** ⇒ 需要让用户知道这个变化再定。

#### 顺带一条纪律（写给未来的我）

这次我把服务弄挂了几十秒。做对的地方是**先抓日志再回滚** ——
所以这次故障换来一条硬事实，而不是白挂一次。
**凡是"改配置让某处能对外通信"的改动，先在容器里手动试一次那条命令**，
别直接改 compose 再重建：`dsh --profile web --host 0.0.0.0 --help` 一秒就能试出来。


---

## 17. ★★ P1-b 的收敛点找到了（比先前判断的更窄，而且模型早就有 `feed_memory`）

### 唯一写库路径 = `feedMemory()`

```
feed.ts:5     后台「喂食记忆」页、模型可调的 feed_memory 工具）**都只走这一条写入路**
feed.ts:462   export function feedMemory(db, options: FeedOptions): FeedResult
feed-batch.ts:29   ## 为什么每批还是走 feedMemory()（而不是在这里写库）
gateway/src/index.ts:137  后台接口（/api/admin/feed）与模型工具（feed_memory）都走 feedInput
```

⇒ **三条入口（后台 HTTP / CLI / 模型工具 `feed_memory`）共用同一个 `feedMemory()`。**

### 而切分**就在 `feedMemory` 内部**

```
feed-batch.ts:208   核心（feedMemory）拿到 items 后做的第一件事就是 splitIntoFeedChunks()
feed.ts:471        // ① 段落切分（朴素段落切；段落级的复杂分块属于记忆系统本身）
feed.ts:477          for (const chunk of splitIntoFeedChunks(item.content)) paragraphs.push(...)
feed.ts:480        // ①b 天花板切分：只有超过 feed.chunkMaxTokens 的段落才被切开
feed.ts:695        const appended = appendMidEntry(db, { … })   ← 每个"段落"写一条
```

⇒ **P1-b 的靶心在 `feedMemory()` 里那一处 `splitIntoFeedChunks`**，不在 `feed-batch.ts`。
改那一处，三条入口一起改到 —— 这比"改 feed.ts 四处 + 三条入口"窄得多。

### ★ 而且模型**本来就有** `feed_memory`

`dsh-component/src/feed-tools.ts:2` / `:13`：

> 「手动喂食记忆资料」的**模型工具面** —— `feed_memory`
> `feed_memory`：把**一段外部资料**喂进记忆，带**来源**

`feed-tools-wiring.test.ts:3` 还记着：「模型自己决定记成**知识**还是**经历**」。

⇒ **所以 C-② 的缺口比想象中小**：模型**已经能**自己投喂、自己决定记成什么。
缺的只是两件：

1. **投喂路径现在由 gateway 子系统调 `feedMemory`，而不是让模型来调** ——
   要把"整块原文"作为一轮输入交给模型（`forlife:feed-mode` 已经存在，
   实测日志里那段写着"只在投喂期非空"）
2. **`feedMemory` 内部那次切分要能关掉**（否则模型即使拿到整块，写进去时又被切开）

### 因此 P1-b 的最小可行形状（三条）

| | 改动 | 判据 |
|---|---|---|
| ① | `feedMemory` 加一个"**不切分**"的入参（或让它按 `feed.chunkMaxTokens` 这个**天花板**判，而不是无条件按空行切） | 传一整块 ⇒ 落库**一条**（而不是 50~77 条） |
| ② | 投喂路径改成**把整块原文交给模型**（一轮输入 + `feed-mode`），
由模型自己决定调几次 `feed_memory`、记成知识还是经历 | 模型真的调了 `feed_memory`（日志/工具记账可见） |
| ③ | `feed.chunkMaxTokens`（2000）重新定档到 10k–50k 量级 | 整块不再被 ①b 那道天花板切开（实测 282/283 段超 2000） |

**⚠️ 但 ③ 单独做没有意义**（实测它今天一次都没触发过，因为条目只有 140 token）——
它只有在 ① 做出来、整块真的整块进库之后才起作用。**所以 ①→③ 必须相邻落地。**

### 仍然需要用户已给的确认

用户已明确选 **C-②**（交给模型），并补了目标语义：
**「让模型以为在回想过去的记忆」** ⇒ 那轮输入的框架是"你在回想过去"，
不是"这是份文档，请处理"。这与既有的 `forlife:feed-mode` 是同一件事，要一起对齐。


---

## 18. ★★★ 三个决定已拍板（2026-10-09）+ P0-b 首次尝试的翻车记录

### 用户裁定（**不要再问**）

| | 决定 | 值 |
|---|---|---|
| **A** | 沉降分母 `activeBudget` | **新增独立键，500k** —— 不复用 `memory.midWindow.maxTokens`（那是**注入窗口**；`deviations.ts:201` 警告过"别混为一谈"） |
| **B** | 人格 | **B-② 从提示词拿掉 persona，让记忆承担身份** —— 不再断言"你是谁" |
| **C** | 喂食 | **C-② 交给模型**（目标语义：**让模型以为在回想过去的记忆**） |
| **D** | 唤醒桥 | **D-B 写代码自建监听端口**，绕开 DSH 的 webServer |

**A 的已知代价（用户知情并接受）**：中期 active 会沉到 **≈425k（85%×500k）** 为止，
而其中只有 `midWindow.maxTokens`（100k）看得见 ⇒ **差额约 325k 落在窗口外**。
这是**被接受的取舍**，不是漏洞 —— 记录在此，免得日后被当成 bug 重查。

### P0-b 首次尝试：**翻车并已干净回滚**

**做了什么**：四处替换（①基线加 `memory.midBudgetTokens=500000`；②候选选择从
"单一时间前置过滤"改成"占比/定时二者或"；③早退原因说清是哪条没成立；④触发原因并进 notes）。

**怎么翻的**：`runtime.ts` 那三处替换我用 **PowerShell 双引号字符串**拼的，
而里面含**反引号模板字面量**与 `${...}` —— PowerShell 把 `` ` `` 当转义、把 `${}` 当变量。
结果是 TS 报 `TS1127/TS1110 Invalid character`（`runtime.ts:1672`、`:1718`）。

**回滚**：`git checkout -- packages/dsh-component/src/runtime.ts` 与 `plan-baseline.json`。
工作区 **0 处未提交改动**，`tsc` **exit 0**，`mid/long` **未被触碰**（全程只改源码、没碰库）。

**★ 教训（这是本会话第 5 次栽在反引号/CRLF 这一族上）**：
**改含模板字面量的 TS，必须用 `edit` 工具（字面文本），绝不用 PowerShell 拼字符串。**
`$newEarly`/`$newNotes` 那两个双引号串是全部错误的来源 —— 单引号 here-string 的那两处
（基线 JSON）反而没事。

### P0-b 落地时的形状（设计已定，下一轮照着写）

```ts
// PLAN.MD:119 —— 「中期占比、访问频率、定时」★三者或★
const allActive   = this.listEntries({ status: ['active'] })
const settleStats = this.stats()                       // 注意：原代码在下面还有一次 this.stats()
const midBudget   = defaultFor<number>('memory.midBudgetTokens')   // 500000
const ratioMin    = defaultFor<number>('fragment.activeBudgetRatioMin')  // 0.8
const midRatio    = midBudget > 0 ? settleStats.activeTokens / midBudget : 0
const byTimer     = allActive.filter((e) => (e.last_accessed_at ?? e.created_at) < cutoff)
const byRatio     = midRatio >= ratioMin ? allActive : []   // 占比成立 ⇒ 不受年龄限制
// 占比 ⊇ 定时 ⇒ 并集即"占比成立时取全表"；统一按最久未访问排序
// fired[] 记下是哪一条触发的，最后 notes: [`触发条件：…`, ...plan.notes]
```

⚠️ **「访问频率」仍未实现** —— 它需要一个我没读到的定义（按 `access_count`？
还是"从未被访问过"？）。按纪律**不猜**，在 notes 里如实写明"这一条尚未实现"。

**验证判据（现成）**：部署后看那一行日志 ——
`沉降一轮：没有要动的…` 应变成 `沉降一轮：碎片化 N 条、淘汰 M 条｜触发条件：中期占比 311.0% ≥ 80%（预算 500000 token）；…`
`1555127 / 500000 = 311%` ⇒ **占比条件必然触发**，所以这一行一定会变。


---

## 19. P2-b 恢复：**方案**与证据（2026-10-09）

### 为什么要恢复

`opencode-go` 月度额度**只剩 9%**，而它此前承担**主对话模型**。
DS 官方还有额度（`deepseek-official`）。当初我把它改回 opencode-go，**唯一理由**是：

> 压缩触发点 = `contextWindow × 0.6`，而那 1M 上下文是 `deepseek-v4.1-flash` 的事实
> ⇒ 换模型后 "600k" 不再成立于实际在跑的那个模型

### ★ 那个理由**已被实测推翻**

**`deepseek-flash` 的上下文窗口 = 1,000,000**（与 `deepseek-v4.1-flash` **相同**）。证据：

```
dsh-llm-deepseek/lib/index.js:42-54
  const DEFAULT_MODELS = [{
      id: "deepseek-flash",
      name: "DeepSeek-V41-Flash",
      contextWindow: DEFAULT_CONTEXT_WINDOW,     // ← 常量
  ... }, {
      id: "deepseek-v4-pro",
      contextWindow: DEFAULT_CONTEXT_WINDOW
  }];
```

同包 `README.md` 逐字：

> Omitted `models` advertises the text- and image-capable `deepseek-flash` alongside
> the text-only `deepseek-v4-pro`, **each with a 1,000,000-token context window**.
> | `defaultContextWindow` | `1,000,000` |

⇒ `1_000_000 × 0.6 = 600_000` ⇒ **"600k"对新默认模型照样成立。**

（也解释了 `dsh --dump-config` 为什么查不到它：它不在 profile 声明的 4 个模型里，
而是 **native provider 的目录默认值**。）

### ⚠️ 但**不能**往 `MODEL_CONTEXT_WINDOWS` 加一行 —— 会红

`compaction-threshold.test.ts:293-299` 的断言本体（已读到，不是推断）：

```ts
test('★★ 守卫：四个 profile 的**每个**模型都显式声明了窗口，且等于登记的真值', () => {
  for (const profile of PROFILES) {
    const source = readFileSync(`../../../profiles/${profile}/cordis.patch.yml`, ...)
    // ① 模型集合必须与登记表一致：新增模型不许"悄悄带一个没来源的窗口值"进来
    assert.deepEqual(modelIdsOf(source).slice().sort(), …)
```

而 `modelIdsOf()`（`:270-291`）**只扫 profile 的 `models:` 块**。
`deepseek-flash` 是 native provider 的模型、**不在** `models:` 里
⇒ 登记表加一行 ⇒ **集合比对失衡 ⇒ 必红**。

（这正是 §7 记的那个毛病：**看到一个"像是该填的地方"就填，没读下游**。
本轮读到断言本体才拦住。）

### 正确的四步

| # | 动作 | 说明 |
|---|---|---|
| **1** | 加一张**独立**的 `NATIVE_MODEL_CONTEXT_WINDOWS`（含 `src` 来源） | **不参与** profile 的 `models:` 集合比对 |
| **2** | 改 `600k` 守卫（`:168-198`）按"两类来源"取窗口：<br>profile 模型 → `contextWindowOf(source, id)`；native 模型 → 新表；**两边都查不到 ⇒ 红** | 这是**给守卫补一条它本来就缺的表达能力**，不是放水：原来能挡的（没登记 / 抄错值）一条没少，只是多了 native 这一路 |
| **3** | `DEFAULT_MODEL_ID` → `deepseek-flash` | `1_000_000 × 0.6 = 600_000` ⇒ 那条断言自然成立 |
| **4** | 四个 profile 改回 `deepseek-official/deepseek-flash` | 用**带前置断言**的脚本（改前 1 次 / 改后 1 次，不满足就中止不提交）—— 防 CRLF 静默失败 |

**判据**：全量绿（尤其 `compaction-threshold.test.ts`）+ 真机
`current=deepseek-official/deepseek-flash:high`；且 §15 那条"DSH web 只绑回环"
与本次无关（那次撞的是 `--host` 的硬禁，不是模型）。

### 还欠一个观察项

`849fb6e` 之后基线里「团子」**在 `v`（活值）里 0 处**、只在 `src`（说明文字）里 1 处
—— 已用**结构化解析**核实（不是字符串计数）。**地雷已拆干净。**


---

## 20. ★ 暂停点：VM 断电前的优雅关机（2026-10-09）

用户通知「即将断电，需要暂停并关闭虚拟机」。做了：

1. `docker stop -t 60` **依次优雅停止** `forlife-{dsh,gateway,caddy,qq}-1`
   （SIGTERM ⇒ 给 `forlife.sqlite` 关闭的机会，**避免断电打坏库**）
2. `sync`
3. `shutdown -h now`

**为什么必须优雅停而不是直接断电**：库刚被沉降写过（`long` 0→200、`frag` 0→200、200 条写事务），
SQLite 默认 `journal_mode` 下硬断电有损坏风险。**优雅停是保护数据的唯一手段**，
而它必然要停 QQ 容器 —— 这与"不准重启 QQ"不冲突：**关机本来就会掉登录，且这次是用户要求的**。

### ⚠️ 本地工作区留下了 4 个**未提交**文件（= 「3 加列」的 ①–⑤）

| 文件 | 内容 |
|---|---|
| `packages/store/src/migrations.ts` | 中期表 DDL 加 `access_count`；**新增迁移 `m0028`** + checksum + 注册 |
| `packages/store/src/repository.ts` | `MidEntryRow.access_count`；`touchMidEntry` 自增 |
| `packages/memory-core/test/render.test.ts` | 夹具默认值补 `access_count: 0` |
| `packages/memory-core/test/window.test.ts` | 夹具默认值补 `access_count: 0` |

**它们没被提交，也没跑完全量** —— `pnpm typecheck` + 迁移实测 + 全量的那条命令
**被"即将断电"打断**（`tool call aborted`），所以**没有任何验证结论**。
⚠️ 上一轮同样的改动曾栽两处，都已修：① SQL 模板串里不许有反引号（会终止模板串）
② `MidEntryRow` 加**必填**字段 ⇒ 三个夹具（`render.test.ts:18`、
`window.test.ts:30`、`window.test.ts:53`，后者经 `row()` 传递）必须补默认值。

**恢复后第一件事**：对这四个文件跑 `pnpm typecheck` + 迁移实测（临时库，
**不碰线上**）+ 全量；**绿了才提交**；不绿就按上面的坑逐个查。

### ⑥ 仍然缺一个业务定义

`settle()` 里「访问频率」那条要**用**这一列，但"`access_count` 低到什么算冷"是业务定义，
用户没给 ⇒ 按纪律**不猜**。①–⑤ 只做到"数据有了、在维护了、读得到了"。

### 断电前的现场（都已在磁盘上）

- 仓库：4 个文件已改（上表），其余干净；最新提交 `61eb276`
- VM：容器**已全部优雅停止**、已 `sync`、已 `shutdown`
- 线上库最后一次读到的状态：`long=200 / frag=200 / active=10914`
  —— **沉降链路是通的**（P0-b 真机验证过）


---

## 21. ★★★ P1-b 完成（2026-10-10）：投喂改成"模型驱动 + 断点续传"，闭环已打通

### 用户的四条（原话，2026-10-10）

> 「应该**我们主动限制工具调用**，只开放有关于**记忆和文件读写**的工具，
>   其他的比如 **QQ、沙箱**等都不开放**以限制其不允许干别的**」
> 「以**单个轮次为界**，每一个轮次结束就**传输下一批次**」
> 「通过限制**单个轮次时间为 30 分钟**来避免过长时间」
> 「关于半途而废……给我们的输入资料打上**哪些已经投喂哪些暂未投喂**，以支持**断点续传**」

### ★ 一个关键的形状澄清（**证据在手边，不是猜的**）

**投喂期模型是自己 `read` 素材再喂的**，四条证据：

1. `feed_memory` 的工具描述里逐字写着「**模型自己 `read` 完一坨资料再喂**」
2. 用户指定的白名单里**恰好有** `read`/`read_image`/`write`/`edit`
   —— 若素材是系统塞进上下文的，模型根本不需要 `read`
3. `feed-frame.ts` 的占位符原先只有 `source/kind/chunks/batches` —— **没有"批次内容"这个位**
4. 283 个 `seg*.md` 就在磁盘上

⇒ **系统每轮只需告诉它「下一段是哪一段」（一个指针），内容由它自己去读。**
⇒ **这也解释了为什么白名单里必须留文件读写工具：那是它取素材的手。**

### 工具收窄：`ctx.tools.restrict()`（DSH 原生）

`dsh-tools/README.zh.md:81` 逐字：对**单个 agent** 应用**允许/拒绝掩码**，
**取交集**，**`dispose` 时解除**。判据那一行在 `dsh-tools/lib/index.js`（**读产物读到的**）：

```js
if (filter.allow !== void 0 && !filter.allow.has(name) ||
    filter.deny  !== void 0 &&  filter.deny.has(name)) return false;
```

**★ 用白名单（`allow`），不用黑名单**：黑名单**必然漏** —— DSH 以后加个新工具、
我们没听说过它，它**自动被放行**。白名单的失败方向是"少给一个"（可见可修），
黑名单的失败方向是"**悄悄多给一个能发 QQ 消息的工具**"。

**⚠️ 找它花了四轮，三条错路已否**（记下来免得重走）：
`dsh-permission-presets` 是**沙箱+审批**（不是工具集）·
`dsh-tool-fs` 的白名单是**读限制**（`readLimit`/`readMaxBytes`）·
`agent/pre-step` 的 payload 是 `{agent, messages, turn, step, signal}`（**没有工具位**）。
**奏效的办法是"枚举事件名"而不是"猜关键字"。**

### 新增的八块（都可独立测试）

| 模块 | 干什么 | 测试 |
|---|---|---|
| `gateway/src/feed-cursor.ts` | 断点续传的游标（`feed_cursor:<来源>`，**不加表**） | 6 |
| `gateway/src/feed-plan.ts` | 一轮一批的排产（纯函数） | 8 |
| `gateway/src/feed-turn.ts` | **脚本驱动**的一轮执行器 | 7 |
| `gateway/src/feed-run.ts` | 投喂运行登记（★ 带**每段的可读路径**） | 6 |
| `dsh-component/src/feed-restrict.ts` | 工具白名单（10 个：记忆 6 + 文件读写 4） | 3 |
| `dsh-component/src/feed-turn-hook.ts` | **模型驱动**的轮次钩子（闭环） | 6 |
| `dsh-component/test/feed-turn-wiring.test.ts` | 接线守卫（读源码、去注释） | 4 |
| `feed-session.ts` / `feed-frame.ts` | 会话带批次指针 + `{{batch}}` 渲染 | （既有） |

### ★★ 四条"做错了不会立刻炸"的纪律（各配守卫）

1. **游标按"实际喂进去的段数"推进，不是按批次大小** —— 按批次大小会让没喂的段
   被记成已喂 ⇒ **漏喂 = 丢记忆**（不可逆）。重喂只是慢（同源同序号幂等更新）。
2. **工具掩码只进有出、且不许叠加** —— 只收窄不解除 ⇒
   **她的正常对话从此发不出 QQ 消息，而且没人会发现**。钩子把句柄攥在自己手里，
   三条路径（重入 / 运行没了 / start 时无运行）都自愈。
3. **`turn/end` 里投喂收尾必须排在 `tokens === undefined` 那条 early return 之前** ——
   排在之后，"拿不到 token 读数"这条**与投喂无关**的路径会让掩码**永远留着**。
   **单测测不出来，只能读源码钉住**（守卫 + 回退验证：注入⇒3/4 红，还原⇒4/4 绿）。
4. **段清单"一段坏就整份作废"**（与别处"坏一条跳过它自己"**故意不同**）：
   段清单是**连续**的，跳过中间一段会让后面**全部错位** ⇒ 模型被指到**错误的文件**上。

### 闭环

```
turn/start ─▶ 排产 + 写"本轮范围"进会话（提示段渲染 {{batch}}）+ 收窄工具
                  ▼
          （模型自己 read 素材 → feed_memory 带 whole:true 整块记下）
                  ▼
turn/end   ─▶ 按实际喂入段数推进游标 ─▶ 解除掩码 ─▶ 喂完收尾（清运行 + 删会话 = 醒来）
```

### ⚠️ 仍未做

- **部署**：容器跑的还是旧镜像（用户明说"部署稍后，把所有东西修完先"）
  ⇒ **P3（清空重导）现在还不能做**，它必须在**新镜像上线之后**
- 日志线：落盘+保留时间 / 面板按等级·模块筛选 / 把 `server.ts` 汇聚点接到新 sink / 127 处分批迁移
- P2-a 面板四块 · P2-b 额度路由


---

## 22. 中介层现状核对（2026-10-10）：**降级接上了，判档没接**

> 这一节是**把事实钉住**，不是计划。写它的原因：这一轮我给用户报过一句
> 「`model_routes` 那张表现在谁也读不到」—— 那种"结构性缺口"如果只留在对话里，
> 下一轮就会有人（包括我自己）重新推一遍、或者更糟：**以为它已经通了**。

### 已经接上的（有接线守卫）

| 能力 | 落在哪 | 门控 |
| :--- | :--- | :--- |
| **跨模型 failover**（失败时换 provider） | `dsh-component/src/failover-hooks.ts`，在 `index.ts` 里装上；订阅 `agent/request-error` + `agent/request` | **复用** `FORLIFE_ROUTER_MODE` |
| 候选链来源 | `listModelRoutes(runtime.db, 'L2')`（只取 `enabled`） | —— |
| 降级留痕 | `runtime.recordRoutingDecision(...)` → `routing_log` | —— |

### **没有**接上的（三处零调用方，2026-10-10 复核仍然如此）

| 符号 | 定义在 | 它是干什么的 |
| :--- | :--- | :--- |
| `new Router(...)` | `router/src/pipeline.ts:105` | 整条判档流水线（评分 → 判 L1/L2/L3 → 选模型） |
| `defaultRouteEntries(...)` | `router/src/routes.ts:112` | 从 provider/model 三元组造**默认路由表**（纯构造函数） |
| `lockTierForTurn(...)` | `router/src/routes.ts:152` | 轮次内锁档 + 每轮重新断言（**纯函数**，13 行） |

⇒ **后果（必须说清）**：

1. 「**轮次开始时按档位选模型**」这条链路不通 ⇒ **`switch_model` 这个工具当前还没有
   真正改变过任何一次请求的模型**（它只写 `tierOverride` + `routing_log`）。
2. **`model_routes` 表在判档链路上没人读** —— 目前唯一的读点是 failover 的候选链。
3. 刚接上的 failover **只在请求失败时**才动路由，**不构成轮次开始时的档位选择**。
   两件事不能混为一谈。
4. P2-b（额度往 `deepseek-official` 倾）**是靠 profile 的 `agent-default-model` 生效的**
   —— 那确实是启动模型的**真源**，所以 P2-b 本身达成；但"档位切换"整体不通。

### 接线它需要什么（**不是一轮的事**，先记下来）

- `new Router(...)` 需要：模型目录（`getCatalog`，`installModelRouter` 已经在拿）、
  评分器（`router.minimum.*` 那一族基线键 + `minimum` 角色的模型）、
  以及承载 `routing_log` 的库
- 三个**时序**要点（`deviations.ts` 与 `PLAN.MD §8.6` 都强调过）：
  ① 同一轮内不换档（`lockTierForTurn`）；
  ② 每轮**重新断言**（只锁不重断言 ⇒ 判过一次 L3 就永久粘在 L3，**成本悄悄翻倍而没人发现**）；
  ③ 评分在同步路径上 50ms 未返回就降级到启发式（**已有**预评分路径，
  见 `deviations.ts` 里那条 50ms 的登记）
- ⚠️ 而且 `FORLIFE_ROUTER_MODE` **默认 `off`** ⇒ 接上也不会立刻改变行为。
  **先接、再 `observe`、最后才 `apply`** —— 这是 `model-router.ts:742` 那条注释定的顺序

- 两处未收口：`router-hooks.ts`（**已接线**，见 §23）、`prompt.variables.personaName` 仍在白名单里


---

## 23. ★★★ "上游没人写"专项审计（2026-10-10）：两个同形的洞**都已补**（其中一个补了两次）

> **为什么做这个审计**：这一轮我抓到**自己**埋的一个雷 —— failover 接上了、8 条测试全绿，
> 但**没人去读候选链里种的是谁**，而 `route-seed.ts:162-165` 把它种成了
> `opencode-go`（用户说"额度只有 9%"那家）⇒ 一开 `apply` 就会把每一个请求
> **从 DS 官方换到快没额度的 GO 上**，方向与 P2-b 正好相反。
>
> **全绿不等于接对了。** 于是我把"我最近接的东西"逐个问一遍同一个问题：
> **「它读的数据，上游是谁写的？那个人真的会写吗？」**

### 结果

| 我接的东西 | 它读什么 | 上游谁写 | 判定 |
| :--- | :--- | :--- | :--- |
| `failover-hooks` 的候选链 | `model_routes` | `seedOpenCodeGoRoutes` / `seedDeepSeekFallback` **真的会写** | ⚠️ **已修**（断言改用宿主给的路由，不再取 `candidates()[0]`；commit `93fa2f2`） |
| `feed-turn-hook` 的**运行登记** | `forlife_state` 的 `feed_run` 键 | ★ 原来**零生产调用方** | ✅ **已补**（见下） |
| 工具掩码 | `ctx.tools` | 宿主提供 | ✅ |
| 崩溃守卫 | `process` | —— | —— |
| 日志落点 | 谁调 `createLogger` | 已迁移的文件 | 🟡 长尾未迁完（见 §21） |

### ✅ 那个洞已补（2026-10-10，两个提交 + 一条守卫）

1. `de80a91` 写了入口函数 `startFeedRunFromFiles()`（把文件清单 → 运行登记）——
   ⚠️ **但它当时也是零调用方**，我在那个提交里如实写了"这只补了一半"
2. `api.ts` 加了 `POST /api/admin/feed-run`：
   `{source, as, perTurn, dir}` → `listFeedFiles(dir)` → `startFeedRunFromFiles(...)`
   ⇒ **生产路径上真的有调用方了**
3. **接线守卫**（`test/feed-run-endpoint-wiring.test.ts`，6 条，读源码）钉住：
   真的有调用方 · 端点**必须排在 `/feed` 之前**（TS 收窄 + 顺序匹配两个理由）·
   枚举用 `listFeedFiles` 而不是自己 `readdirSync`（否则二进制文件会进清单）·
   回包里带 `fedThrough`（断点续传对用户可见）· 空目录/空来源/空目录名明确拒绝 ·
   危险动作走 `checkStateChange` + 审计

⚠️ **仍差一步（面向前端）**：面板还没有调这个端点的界面。
所以"用户能点一下开始投喂"这件事**还没通** —— 但**机制这一侧通了**
（HTTP 调它即可，`curl` 就能启动一次投喂）。
**不要因为 §23 打了勾就以为面板上能点了。**


### 📌 当时查出的形状（**历史记录，保留不改** —— 审计不该被改写成宣传材料）

> 下面这段是**审计当时**的样子（"这个洞长什么样"）。它现在**已经补上了**（见上）。
> **刻意保留原文**：审计的价值在于"当时到底查出了什么"，
> 把它改写成"已修复"会让后来的人**学不到这个形状**。

⇒ **后果**：`turn/start` 上 `readFeedRun()` **永远返回 `undefined`**
⇒ 钩子判定"这一轮不是投喂轮" ⇒ **不做排产、不写批次指针、不收窄工具**。

⇒ **§21 里那一整套投喂闭环（八块模块、40 条测试）在生产里是"死的"。**
它**不是错的**（测试证明每一块都对），而是**没有入口去启动它** ——
与 `buildFailoverRuntime` 之前的状态**一模一样**。

**（当时判断）补它需要什么**：

1. **一个"开始投喂"的入口** —— 最自然的是面板/HTTP：给 `(来源, 知识还是经历, 每轮几段)`
   + 一份**段清单（每段一个可读路径）**。段清单从哪来？看 `.runtime/chat-feed-v2/` 那 283 个
   `seg*.md`（或 `feed-ingest.ts` 的 `listFeedFiles`）。
2. 那个入口调 `startFeedRun(db, { source, kind, perTurn, segments })`
3. 于是 `turn/start` 才会开始排产、写指针、收窄工具；`turn/end` 才会推进游标
4. 配套：面板上要能看到"已投喂 N/M 段"（`listFeedCursors()` 已经有了）

⚠️ **在补上之前，不要以为投喂闭环在跑** —— 它只在我为它写的 40 条测试里跑。

### 一条可复用的判据（写给以后）

**接一个新东西时，除了"我调它了吗"，还要问"喂给它的数据，谁写？"**
两个问题都答"是"才算接上。本仓栽过的 18 次"写了没接"里，
**至少有一半是第二种**（读了没人写的东西），而它比第一种更安静 ——
第一种至少函数会报错，第二种**表现完全等同于"这个功能没启用"**。


