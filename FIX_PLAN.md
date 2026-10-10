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


---

## 24. 部署拓扑实查（2026-10-10）：**没部署过**，以及"部署要做什么"

> 用户问：「面板没有更新，你真的部署了吗？」
> ⇒ **没有。** 用户原话是「**部署稍后，把所有东西修完先**」，本会话一直照此执行。
> 这一节把**实查到的证据**与**部署的实际形状**记下来，
> 免得下次（包括我自己）重新推一遍、或者以为"改了就会生效"。

### 证据：今天的工作**一行都不在容器里**

| 查什么 | 结果 |
| :--- | :--- |
| 容器创建时间 | `gateway` = 2026-10-09 11:13 · `dsh` = 10-09 14:30 · `caddy`/`qq` = 10-08 10:00 —— **都早于今天** |
| 镜像 | `forlife-app:local` 构建于 **2026-10-09 22:30** |
| 今天新增的代码 | `grep -rl startFeedRunFromFiles /app/packages` ⇒ **零命中** |
| 今天新增的面板文案 | `grep -rl '开始投喂（一段一段来）'` ⇒ **零命中** |

（本会话最后一个提交是 **2026-10-10 13:29**，当天共 45 个提交。）

### 部署的实际形状（查出来的，不是猜的）

- **`/opt/forlife`** —— compose 工程 `forlife`，工作目录 `/opt/forlife/deploy`
- ★ **它不是 git 仓库**（是**拷贝**，最后更新 2026-10-09 15:54）⇒ 部署**不是 `git pull`**
- ★ **`/app` 不是挂载**（挂载只有 `/data`、`/data/dsh`、`/cold`、`/run/caddy` 四个数据卷）
  ⇒ **源码烤在镜像里，必须重建镜像**；面板产物也要重新 build
- 进程是 `node packages/gateway/src/server.ts`（Node 24 strip-types 直接跑 TS）

⇒ 部署大致是：**同步仓库树 → 重建 `forlife-app` 镜像 → `up -d --no-deps` 点名重建
（★ **除了 `qq`**）→ 比对容器 ID（`qq` 那个必须不变）**。

### ★ `docker-compose.override.yml` 的实查结论：**没生效，而且是多余的**

`/opt/forlife/deploy/` 里有一个**不在仓库里**的 `docker-compose.override.yml`，
它自己的注释写着两条理由，**其中第一条现在已经不成立**：

> 「仓库的 `deploy/docker-compose.yml` **全篇没有** `FORLIFE_ROOT_*` ⇒ 冷热会落在同一个卷上」

实查：仓库的 `docker-compose.yml` **有**（`:103-107`、`:145`、`:193-197`、`:275`），
而且带着注释「★ **2026-10-07 真机部署发现**：原来一个 tier 根都没设」——
**说明后来补上了，而 override 的注释停在补之前**。

> ⚠️ **这几行号是 2026-10-10 复核过的（按仓库那份）**。
> 我第一版写的是 `:103-105` / `:135` / `:180-182` / `:249` —— 那是 **VM 上那份拷贝**的行号。
> **两份文件的对应行差了 10~30 行** ⇒ 这本身就再次证明"**VM 的部署树是旧的**"。
> （写文档时我把"在另一台机器上 grep 到的行号"当成了仓库的行号 —— 记在这里当教训：
> **引用行号前先确认是哪份文件**。）

| 文件 | `FORLIFE_ROOT_*` / `ARCHIVE` / `BACKUP` |
| :--- | :--- |
| `docker-compose.yml`（仓库） | **有**（4 处） |
| `docker-compose.dev.yml` | 无 |
| `docker-compose.override.yml` | 有（4 处，**与主文件重复**） |

⇒ **结论**：四个容器的 `com.docker.compose.project.config_files` 都只有
`docker-compose.yml` + `docker-compose.dev.yml` ⇒ **override 没被加载**；
而它的内容主文件都有 ⇒ **用硬约束那条命令部署不会丢任何东西**（冷层设置来自主文件）。
⚠️ 反过来说：**不带 `-f` 跑 `docker compose up` 会自动捡起它** —— 两处同名设置是个**陷阱**
（"我改的东西没生效"那一类）。**部署时始终显式列 `-f`。**

### ★★ 一个部署后会立刻显形的默认值

`docker-compose.yml` 里：`FORLIFE_ROUTER_MODE: ${FORLIFE_ROUTER_MODE:-observe}` ——
**容器里的默认是 `observe`，不是 `off`**（`resolveRouterMode()` 在未设时才默认 `off`）。

⇒ 部署之后：`installModelRouter` 与**新接的 `installFailoverHooks`**
都会**订阅并打日志、但不改模型**（failover 的 `👀 failover(observe)` 那一行会出现在日志里）。
**这正是"先 observe 再 apply"那条纪律要的效果** —— 它会让新接线**可见**，
而不是静默生效或静默失效。


---

## 25. ★★★ §22 的真相：`ModelSelectionRef` **是一个从来没被实现过的设计**

### 查出来的事实

`FIX_PLAN.md` §22 与 `model-router.ts` / `initial.ts` 的注释里，
"怎么把判档结果**落到请求上**"写的是这一句：

```
installModelSelection(agent.ctx, ref)  ⇒  ref.current = …
```

**全仓 grep `ModelSelectionRef` / `installModelSelection` ⇒ 7 处命中，没有一处是实现：**

| 位置 | 是什么 |
| :--- | :--- |
| `dsh-component/src/model-router.ts` `:15` `:34` | 头注释（流程图与事件表） |
| `dsh-component/src/model-router.ts` `:230` | ★ **一句日志文案**：`'apply 模式：装配 ModelSelectionRef 的逻辑**尚未实现**'` |
| `router/src/initial.ts` `:15` `:234` `:239` | 头注释 + 那段 `TODO（用户 2026-10-08 明确要求，**尚未接**）` |
| `router/src/subagents.ts` `:7` | 头注释 |

> ⚠️ **我第一版写的是"7 处命中，全部在注释里"——那是不实的**：
> `:230` 是**代码里的字符串**，不是注释。（我按"看起来像注释"下了结论，没逐条看。）
> 更正之后这一点**反而更强**：连唯一一处不在注释里的，
> **本身就是一句在喊"尚未实现"的日志**。

⇒ **没有实现，一行都没有。** 那不是"接了一半"，是**那个东西不存在**。

⇒ 所以 §22 里"轮次开始时按档位选模型**未接线**"这个说法**还不够准确**：
不是"线没接"，而是**要接的那个端子是画在图纸上的**。
**下一个照着注释去找 `installModelSelection` 的人会白找一场** —— 这正是这一节要拦住的。

### ★★ 真正的接缝其实已经有了（而且我上一轮刚接对）

宿主给的水位事件里，**`agent/request` 的 `next()` 返回的就是 `LlmCallConfig`**
（`{provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}`）——
**改它 = 改这一请求用哪个模型。** 这就是"落到请求上"的真正机制，**不需要任何 ref**。

⇒ 我上一轮修 failover 时把断言目标从 `candidates()[0]` 改成"**`next()` 给什么就是什么**"，
现在回头看**正好是对的**：它让 failover 与**上游任何改模型的层**自动兼容 ——

```
agent/request 瀑布：
  [判档层（将来）]  next() → 按档位改 {provider, model}    ← 基线
        ↓
  [failover 层]     读 next() 的结果当断言目标            ← 天然拿到基线
        ↓
                    只在**出错之后**才偏离它
```

⇒ **两层的顺序天然正确**，只要 failover 仍然"断言 `next()` 给的东西"。
（★ 反过来说：如果 failover 还在断言 `candidates()[0]`，它会把判档层的选择**覆盖掉** ——
那个 bug 若没修，将来接判档时会更难查，因为症状是"判档日志明明选了 A，实际走了 B"。）

### ⚠️ ⚠️ 但现在**不能**接 apply：接上去就会烧掉 GO 那 9%

判档的落地路径是 `initialRoute()` → `pickModel(catalog, tier)`，
而 `catalog` 来自 `buildCatalog(...)` —— **它按什么顺序给候选？**

已知：`route-seed.ts:162-165` 把 `model_routes` 的 **L1/L2/L3 rank 0 种成 `opencode-go`**。
而用户原话是「**GO 额度实际上只有百分之 9**」，P2-b 要的是**往 `deepseek-official` 倾**。

⇒ **在 P2-b 的倾斜方向定下来之前接 apply，等于把每一个 L2/L3 轮次都送去 GO。**

**这与我在 `93fa2f2` 修掉的那个 bug 是同一个陷阱、同一个方向** ——
那次是 failover 的断言，这次是判档的候选顺序。**同一个坑连着埋了两次。**

⇒ **顺序必须是**：① 先让**候选顺序**反映 P2-b 的倾斜（`deepseek-official` 在前）
→ ② 再开 `apply`（哪怕有 `observe` 兜底，也**先确认判档日志选的是 DS 而不是 GO**）
→ ③ 才谈 `lockTierForTurn`（同一轮内不换档）。

**判据（一句话）**：打开 `🎚️ 判档（observe…）` 那行日志，
如果它写的是 `opencode-go` —— **先别开 apply**。


---

## 26. ★★★ 面板上**看不到插件那一半的日志** —— 用户那条要求只兑现了一半

### 查出来的事实（2026-10-10）

`packages/dsh-component/src/index.ts`：

```ts
:596   const log = (message: string): void => { if (config.verbose) console.log(`[forlife] ${message}`) }
:599   const always = (message: string): void => console.log(`[forlife] ${message}`)
```

**两条都是 `console.log`。** 而**七级日志库（`log-store`）在 gateway 进程里** ——
插件跑在 **`dsh` 容器**、网关跑在 **`gateway` 容器**，**是两个进程**。

`grep FORLIFE_GATEWAY / gatewayUrl / logSink / shipLog` 在 `dsh-component/src` ⇒ **零命中**：
**插件没有任何通往网关的通道。**

> ⚠️ **精确一点**（复查的人会撞上）：用更宽的写法搜，会命中 **1 处** ——
> `model-router.ts:264`，那是**我写的一句注释**，提到的是**网关那边的** `installLogSink`
> （另一个包的函数，同名的巧合）。
> **它是注释、不是通道** ⇒ 结论不变。把这件事写出来，是为了让下一个人
> **不用重新推一遍"这 1 处算不算通道"**。

⇒ **结论**：面板「日志」区里能看到的**只有网关自己的日志**；
**记忆写入、沉降、投喂、判档、唤醒** —— 这些**全在插件里**发生的活动，
**在面板上一条都看不到**（只能 `docker logs forlife-dsh-1`）。

### ★ 这件事的连带后果：我在插件里做的分级迁移，**对面板是不生效的**

我在 `model-router.ts` / `feed-turn-hook.ts` / `wake-bridge-endpoint.ts` /
`wake-poller.ts` 上花了好几轮做级别迁移（`fault`/`warn`/`debug`/`note`）。

而 `atLevel(log, …)` 的语义是"注入的是 `createLogger()` 产物就设级别，
**否则退化成直接调它自己**"。这里注入的是 `console.log` 包装
⇒ **级别根本没被设上**，只是把文本原样打到 stdout。

⇒ 那些迁移**仍然有价值**（`docker logs` 里更清楚、将来汇流时直接可用），
但**不能说成"面板上现在能按级别筛插件的日志了"** —— 那是**不成立的**。
**这一条必须写下来**，否则下一个看代码的人会以为它生效了。

### ★ 修它的前提已经验证过（不是设想）

两个容器**共享同一个卷**：

| 容器 | 挂载 |
| :--- | :--- |
| `forlife-dsh-1` | `forlife_dsh-home` → `/data/dsh` |
| `forlife-gateway-1` | `forlife_dsh-home` → `/data/dsh` |

★ 而且**实测过**：在 `dsh` 容器里写 `/data/dsh/.forlife-cross-probe`，
`gateway` 容器**读得到**。（探针文件是我自己建的，已删。）

⇒ **不需要开网络端口**：插件把 JSONL 追写到**同一个 `forlife-YYYY-MM-DD.jsonl`**，
网关那边的 `logStore.read()` **本来就在读那个文件**。
（POSIX 的 `O_APPEND` 对小写入是原子的 ⇒ 两个进程同时追加是安全的。）

### ⚠️ 但**没有**现在动手，理由是具体的

1. **目录解析要对齐**：网关那边是 `resolveLogDir(env, dbPath)`；
   实测 `/data/dsh/forlife/logs/` **目前还不存在** ⇒ 先得确认它到底落在哪，
   否则插件的日志会写进一个**没人读**的目录（那就又是一次"接了但没接上"）。
2. **要处理清理的交互**：网关的 `prune()` 按**文件名日期**删。插件写的文件名必须**同构**，
   否则要么永不被删（涨满盘）、要么被误删。
3. **要定"哪一级进文件"**：用户说"**除了 debug 都存**"是**库**的策略；
   插件这边要不要把 `debug` 也写进文件（靠网关那边筛）还是**根本不写**，是个要定的取舍
   —— 不写省 IO，写了更完整。**不猜。**
4. 还有一条更省事的路要一起评估：**让网关去读 `dsh` 容器的 stdout**
   （Docker `logs` API / 共享 json-file），而不是让插件写文件。
   两条路各有代价，**选之前要先把两条都看清楚**。

### ★ 这一条与 §23/§25/`c16253b` 是**同一个形状的第四次**

- §23：`startFeedRun` 零生产调用方
- §25：`ModelSelectionRef` 从来没实现
- `c16253b`：`getCatalog` 从入口就没传
- **本次**：日志**写到了一个到不了面板的地方**

⇒ 四次的共同点**都不是"逻辑写错了"**，而是**"两个都对的东西之间没有连起来"**。
**所以"去读真实产物"这条判据要一直用到最后一步** ——
包括"我以为它在面板上"这种最像成立的假设。


---

## 27. ★★ 两次**假警报**：我把"零引用扫描"的结果读成了"功能没接"

> 这一节记的是**没发生的事**。写它的理由：如果只记"我发现了什么"，
> 下一个看到同样线索的人**还会再追一遍**这两条死路。

### 缘起：把"零调用方"从撞运气变成扫描

已经**手工**撞见四次同类问题（§23 / §25 / `c16253b` / §26）⇒ 写了个扫描：
对**全仓 223 个源文件**，逐个查 `export function` 在 `src` 里有没有非自身的引用。
结果：**25 个文件 / 37 个符号**零外部引用。

其中两条**同时命中"零引用"和一条已知的库事实**，看起来像大鱼 —— **两条都是假的**。

### ❌ 假警报一：`ForlifeCompactionEngine`「从没被交给宿主」

**我的推理**：`compaction-engine.ts:377` 定义了这个类 ⇒ 全仓搜它**只出现在测试里**
⇒ 没被挂载 ⇒ 库里 `compaction_runs: 0` 就是这么来的。

**真相**：**注册走的是 profile 的插件配置，不是代码引用** —— 我的 `grep` 结构上看不见它。
真机 `/app/profiles/forlife-qq/cordis.patch.yml`：

```yaml
- id: compaction-basic        # 禁用宿主的
- id: forlife-compaction
  name: 'forlife-memory/compaction'   # → compaction-engine.ts 的 `export default`
```

⇒ **四个 profile（`forlife` / `-qq` / `-web` / `-headless`）全都挂了它**
（复核过**仓库里那份** `profiles/*/cordis.patch.yml`：四个都 `True`）。
（`CompactionEngine` 基类构造函数里 `super(ctx, "compaction")` ⇒
**子类被实例化的那一刻就注册**了，`ctx` 是单实现服务，所以必须替换而不是并存。）

> ⚠️ 顺带一个**复核时才发现**的路径陷阱：我第一次查这个用的是
> `deploy/profiles/*/cordis.patch.yml` —— **那个路径不存在**，
> 于是 `Select-String` 什么都没找到，而**"什么都没找到"看起来很像"没配"**。
> 真实路径是**仓库根的 `profiles/`**。
> ⇒ 这与我上一节记的"**引用行号前先确认是哪份文件**"是同一类错误，
> 只是这次错的是**目录**：**"查不到"要先确认路径对不对，再当成结论。**

### ❌ 假警报二：`setCompactionEngineHooks`「生产里没人调 ⇒ 引擎找不到库」

**我的推理**：它只在 `compaction-engine.test.ts` 里被调 ⇒ `resolveRuntime` 从没设过
⇒ 引擎拿不到 runtime ⇒ 每次空转 ⇒ `compaction_runs: 0`。

**真相**：`EngineHooks.resolveRuntime` 的注释写着「**默认从活动登记表取第一个**」，
而 `setCompactionEngineHooks` 自己的注释是「**测试与调试用**」
（`compaction-engine.ts:353` / `:363`）⇒ **生产里不调它是设计如此**，有可用的默认路径。

### ★★ 这两次假警报真正说明的事

**1. "零外部引用" ≠ "没接上"。** 它只是**一个需要继续追问的线索**。
   接线的形式至少有三种，扫描只能看见第一种：
   - 代码里调（✅ 扫描看得见）
   - **配置里挂**（❌ 看不见 —— 本次就是这种：profile 的 `cordis.patch.yml`）
   - 外部入口调（❌ 看不见 —— HTTP 路由、CLI）

**2. 我两次都在"报出去之前"停下了。** 第一次我差点写下"压缩从没跑过"，
   第二次差点写下"引擎空转"。两次都是**多读了一屏源码**才发现不对。
   ⇒ §7 那条「看到一个像是消费点的地方别急着下结论」**这次挡下的是我自己写的结论**。

**3. 但扫描本身值得保留。** 37 个符号里其余那些（格式化 helper、composable、
   `crashGuardInstalled` / `runtimeCount` / `listBackups` 这类诊断或面板用的）
   **大多是真没用**。判据是：**命中之后去读上下游，再决定它是不是洞** ——
   扫描负责**把候选从 223 个文件缩到 25 个**，不负责下结论。

### 那么 `compaction_runs: 0` 到底怎么回事（**仍然没查清**）

现在能确定的是：**引擎是挂着的**、**hooks 有默认路径** ⇒ 零行**不能**用"没接线"解释。

剩下的候选（**都还没验**，列在这里而不是猜一个）：
- 会话没到触发点：`AUTO_TRIGGER_RATIO`（0.6）× 声明的 `contextWindow`
- ★ **而"声明的窗口"本身可疑**：`compaction-engine.ts:340-347` 记着四个 profile 把
  `deepseek-v4.1-flash` 声明成 `contextWindow: 1000000` ⇒ 触发点 = 600k；
  同一段注释还警告「**声明得比真实值大 ⇒ 压缩永不触发 ⇒ 上下文直接溢出**」。
  用户当时报的现象里有一条是「面板显示 **1455k** 的上下文窗口」——
  **这三个数（1M 声明 / 600k 触发点 / 1455k 面板）之间的关系还没人对过。**
- 引擎抛错被吞（要看 `dsh` 容器的 `docker logs`，不是面板）

⇒ **下一个人从这里接手，不要重新走我上面那两条死路。**


---

## 28. 部署清单（2026-10-10 实查）：**同步是安全的**，以及一条会咬人的前置条件

> 用户 2026-10-10 问过「你真的部署了吗」。答案是**没有**（原话是「部署稍后，把所有东西修完先」）。
> 这一节把**部署前必须先确认的事**查清，免得真到那一步才发现。

### ✅ 风险一：`/opt/forlife` 不是 git 仓库 ⇒ 同步会覆盖本地改动？**实测：不会**

`/opt/forlife` 是**拷贝**（无 `.git`，`git status` 报"不是 Git 仓库"），
而它的 `deploy/docker-compose.yml` **在 2026-10-09 19:13 被改过**
（旁边留了一份 `docker-compose.yml.bak-20261009-191311`）——
**这正是"同步会静默覆盖生产上的手改"那类风险。**

**实查结果**：

| 对比 | 结果 |
| :--- | :--- |
| `docker-compose.yml` vs 它的 `.bak` | **逐字节相同**（18447 字节，hash 一致）⇒ 那次"编辑"**没改内容** |
| VM 那份 vs **仓库**那份 | VM **314 行**；仓库那份**明显更长**（旧版拷贝，仓库后来加了 §26 那批环境变量等） |
| 只在 VM 里有的行 | **1 行**：`expose: ["3080"]` —— 而**仓库里也有**（重复计数造成的假差异） |

> ⚠️ **这里刻意不写仓库那份的确切行数**：我第一次写的是"364"，那是用
> `-split "\n"` 数出来的（末尾换行会多算），而 `Measure-Object -Line` 同一份文件给的是 **347**。
> **两种数法不一致 ⇒ 我不写一个自己核不准的数。**
> （这一节其余的数字都是单一口径、可复现的：字节数、hash、`FORLIFE_LOG_DIR` 的**行号**
> —— 那些我逐条复核过。）

⇒ **没有会丢的东西。同步（用仓库那份覆盖）是安全的。**

### ✅ 风险二：机密文件会不会被同步进仓库？**不会**

- `/opt/forlife/deploy/.env`：**1443 字节、权限 `600`**，只存在于 VM
- 仓库的 `.gitignore` 覆盖它 ⇒ `git status` 干净

### ⚠️ 风险三（**这条必须在部署时确认**）：`FORLIFE_LOG_DIR` 必须两个容器都设

`0fddcae` 已在**仓库**的 compose 里给 `dsh` 与 `gateway` 都设了
`FORLIFE_LOG_DIR: /data/dsh/forlife/logs`（L114 / L216）。
**同步之后它才会到 VM 上** —— 而在同步之前，插件日志与网关日志库
**算出来的是两个不同的目录**（见 §26）⇒ 面板依然看不到插件那一半。

⇒ **验证方法（部署后立刻做）**：
`docker exec forlife-dsh-1 printenv FORLIFE_LOG_DIR` 与
`docker exec forlife-gateway-1 printenv FORLIFE_LOG_DIR` **必须是同一个值**。

### ★ 部署时**不可违反**的两条（来自 §11 硬约束）

1. ★ **绝不重启 `qq` 容器**：`up -d` 必须**点名服务 + `--no-deps`**，
   并在**前后各 `docker inspect -f '{{.Id}}' forlife-qq-1`**，两个 ID **必须相同**。
   （`qq` 重启一次就要重新扫码登录一次。）
2. 重建必须带 `-f deploy/docker-compose.dev.yml`
   （容器的 `com.docker.compose.project.config_files` label 就是这么记的）。

### 部署的**实际形状**（§24 查出来的）

- **`/app` 不是挂载**（挂载只有 `/data`、`/data/dsh`、`/cold`、`/run/caddy`）
  ⇒ **源码烤在镜像里，必须重建镜像**；面板产物也要重新 build
- 进程是 `node packages/gateway/src/server.ts`（Node 24 strip-types 直接跑 TS）
- ★ **profile 不在卷里**：`/data/dsh/profiles/*` 是**符号链接**，指向镜像内的
  `/app/profiles/` ⇒ **改 profile 要重建镜像**（"改完立刻生效"那个说法**只对数据卷成立**）

### 部署后**立刻要做的三件事**

1. 比对 `qq` 容器 ID（必须没变）
2. 比对两个容器的 `FORLIFE_LOG_DIR`（必须相同）
3. 打开面板「日志」页：**能不能看到 `module=dsh-plugin` 的行**
   —— 那是 §26 那个修复的**唯一判据**（单测全绿证明不了它）


---

## 29. 「零引用扫描」逐个裁定（台账）—— **不要重追已裁定的**

> §27 记了两次**假警报**。为了不再重复，这里把扫描出来的符号**逐个记裁定**。
> 判据始终是同一句：**"零外部引用"只是线索，去看上下游再定**。
> 而且接线形式至少三种，扫描**只看得见第一种**（代码里调）：
> **配置里挂**（profile）／**外部入口**（HTTP、CLI）它都看不见。

### 已裁定：❌ 不是洞

| 符号 | 裁定 | 依据 |
| :--- | :--- | :--- |
| `ForlifeCompactionEngine`（+`export default`） | **接了**，扫描看不见 | 四个 profile 的 `cordis.patch.yml` 挂了它（配置层注册）—— 见 §27 |
| `setCompactionEngineHooks` | **设计如此** | 注释写着"测试与调试用"；`resolveRuntime` 默认从活动登记表取 —— 见 §27 |
| `saveMediaAsset` / `getMediaAsset` / `listMediaAssets` / `searchMedia` / `buildMediaMemoryText` | ★ **功能还没建，不是接线洞** | `media.ts` 的验收写的是「**`media_save` 之后** `recall_longterm("那张架构图")` 能命中」；而全仓 grep `media_save` ⇒ **只出现在注释与测试里**（**那个工具不存在**）。面板那页也是 `ComingSoonView`（`/api/admin/media ← media_assets / media_usages`）。⇒ store 侧写好了、**工具层与 UI 层还没做**，**符合预期** |
| `crashGuardInstalled` | **诊断用，确实没人调** | 不影响功能（`installCrashGuard` 是接了的那条） |
| `runDoctor` / `renderDoctorReport` | ★ **接了**（**第二次栽在"外部入口"上**） | 被 **`packages/dsh-component/scripts/doctor.mjs`** 调（`:29` import、`:111` `runDoctor({})`、`:115` `renderDoctorReport`）；`dsh-plugin.json:32` 还声明了插件命令 `forlife.doctor`。★ **而 `.dockerignore` 没排除 `scripts/`** ⇒ 镜像里有这个脚本、`node packages/dsh-component/scripts/doctor.mjs` 能跑 |

> ★★ **扫描的盲区现在有两个确证的实例了**：
> ① **配置里挂**（§27 的 `ForlifeCompactionEngine`，走 profile 的 `cordis.patch.yml`）
> ② **外部入口**（本条的 `runDoctor`，走 CLI 脚本 + 插件命令声明）
>
> 两者 `grep src/` 都**看不见**。⇒ **"零引用"只是候选**这句话不是修辞 ——
> 已经四次里有两类**结构性看不见**的接线方式。
> 判据要一直保持成：**先假设它可能接了，再去证伪**。

### ⚠️ 仍然待查（本轮查了一半）

| 符号 | 现状 | 下一步 |
| :--- | :--- | :--- |
| `listBackups`（`gateway/src/admin/storage-write.ts:73`） | **全仓只有定义处一处** ⇒ 真·零调用 | 去面板找"备份列表"那页 —— 若那页在读别的接口，这个函数就是**写好了没用**；若那页缺数据，就是洞 |
| 插件命令 `forlife.doctor` | `dsh-plugin.json:32` 声明了它 | `contributes.commands` 可能只是**声明**；要去代码里找**处理函数**在不在（不在 = 点了没反应） |
| `scripts/doctor.mjs:111` 传的是 `runDoctor({})` | **空 ctx** ⇒ 契约探针会全部报缺失 | 确认那是"演示"还是**真用法** —— 若是真用法，这个诊断工具**永远报红**，等于没有 |


---

## 30. ✅ 「监视程序」**已建起来**（2026-10-10，用户裁定「建，按我给的策略」）

> 与 §29 那些"不是洞"分开写：**这一条是真洞**，但我**没有擅自实现**，理由在末尾。

### 证据链

| # | 事实 | 位置 |
| :--- | :--- | :--- |
| ① | `wake-program-runner.ts` **完整实现并有测试**（校验脚本指纹 → spawn → 收输出 → 按策略决定） | `:88` `createProgramRunner` |
| ② | 它暴露 `tick()`：**"跑一轮所有启用的程序"** | `:84` |
| ③ | ★ **`createProgramRunner` 在 `packages/gateway/src` 里只有定义处一处** | 全仓 grep |
| ④ | 唯一的非测试调用者是 **`packages/gateway/scripts/e2e-wake.ts`**（e2e 脚本，不是生产入口） | `:42` / `:370` |
| ⑤ | `wake_programs` 表在 `gateway/src` 只被**面板读**（`queries-wakes.ts:151`）与 runner 自己碰 | |
| ⑥ | `wake-runtime.ts` 起了引擎 / 监视源 / 桥 / 系统源 / 存活监视 —— **唯独没有起 runner** | `:149` `:191` `:263` `:269` `:271` `:328` |
| ⑦ | ★★ 而且 runner 的 `spawn` 是**注入**的（`SpawnImpl`，模块头写明"为什么 spawn 是注入的"：为了可测）⇒ **生产里必须有人提供一个真实的 `SpawnImpl`** —— **那个也不存在** | `:52` |

⇒ **结论**：这个功能**状态管理那一半是全的**（表、策略、面板、测试），
**执行那一半写好了但没有入口**，而且**连真实 spawn 都还没有**。
表现会是：**面板上能看到程序、能启用，但它永远不会跑。**

### ⚠️ 为什么我**不**擅自实现（三条，都不是"懒得做"）

1. **它是"跑进程"** —— 模块头自己列了三条 spawn 前必须做的事
   （脚本指纹校验、**路径必须走工作区沙箱**、时长/输出限额）。
   在一个**已经有"绝不允许 QQ 有外部执行安全隐患"这条要求**的项目里，
   我来**新开一个执行通道**，属于**要我拍板才算数的事**。
2. **不在 `FIX_PLAN.md` §9 的执行顺序里**。§9 是 P0-a…P3，没有它。
   ⇒ 自己加一个功能进来，会让"计划是唯一权威"这句话失效。
3. **它是"功能没建完"，不是"接线漏了"** —— 与 §29 那五条不同：
   那五条是"东西都在，只是没连起来"，这一条**缺一个真实的 spawn 实现**，
   那要写代码、要做安全设计（工作区根、允许的扩展名、并发上限…）。

### 但**已经落档的部分**有价值

- `wake-supervisor.ts` 的策略（退避数学、限额、状态机）**有测试覆盖** ⇒ 写真实 spawn 时**不用重做**
- `wake_programs` 表 + 面板读路径**都在** ⇒ 只差"谁跑它"

⇒ **要接手的人**：先定"允许跑什么"（工作区根 + 扩展名白名单 + 并发/时长上限），
再写 `SpawnImpl`（`node:child_process`），最后在 `wake-runtime.ts` 里起 `tick()` 循环。
**三件事都要人拍板，所以我不动。**

### ✅ 2026-10-10 更新：**已经建好了**（用户裁定「建，按我给的策略」）

四条策略逐条落位（**两条早就有了，我没有重复实现**）：

| 策略 | 落在哪 |
| :--- | :--- |
| ① 只允许工作区根下的脚本 | `wake-program-runner.ts` 的 `resolveInWorkspace`（**spawn 之前**）—— 早有 |
| ② **扩展名白名单** | ★ 新增 `wake-spawn.ts` 的 `ALLOWED_SCRIPT_EXTENSIONS`（`.sh`/`.mjs`/`.js`/`.py`） |
| ③ 并发/时长/输出上限 | 时长/输出走 `DEFAULT_LIMITS`；并发 = `tick()` **串行** + `wake-runtime` 里的**防重叠** |
| ④ 指纹变更后停用并要求重新登记 | `checkScriptUnchanged` —— 早有 |

**新模块 `wake-spawn.ts` 是唯一碰 `child_process` 的地方** ⇒ 「允许跑什么」这条策略**只有一处要审**。
另加两条方向一致的硬化：**子进程不继承全部环境变量**（默认只给 `PATH`/`HOME`/`LANG`/`TZ`，
机密不会自动流进去）、**输出边收边截**（不是先收完再截）。

**测试是真的开进程**（用 `.mjs` 当样本 ⇒ 本地与容器里都真跑）：9 条 / 8 通过 / 1 跳过，
覆盖白名单、机密缺席、`extraEnv`、**超时真的杀**、输出截尾、非白名单**不开进程**。

⚠️ **如实写下的边界**：`stop()` 只是不再起新 tick；**已跑起来的子进程会跑到自己的超时**才被 `SIGKILL`。
要"立刻全杀掉"得给 runner 加 kill 开关 —— **那是另一件事**。


---

## 31. 小模型（`minimum` 预评分）可行性实查（2026-10-10）

> 用户 2026-10-10 裁定：**「部署小模型，把预评分接上」**。
> 这一节是**动手之前**的资源实查 —— 因为它是**新增一个运行时依赖**。

### VM 的实际条件（实查）

| 项 | 值 | 对 0.5B Q4 是否够 |
| :--- | :--- | :--- |
| CPU | **4 核** | ✅ 够（0.5B 在 CPU 上单次判档是百毫秒级） |
| 内存 | 7.8 GiB，**可用 6.4 GiB**（另有 8 GiB swap） | ✅ 够（推理常驻约 0.6–1 GiB） |
| 磁盘 | 根分区 63G / **可用 22G**（65% 已用） | ✅ 够（Q4 权重约 400 MB） |
| **GPU** | ★ **没有** —— `/dev/dri/card0` 后面是 `1234:1111`（QEMU/Bochs **虚拟 VGA**） | ⚠️ **只能走 CPU** |
| 现有本地模型 | **一个都没有**（无 `.gguf` / 无 ollama / 无 llama-server） | —— |
| 四个容器 | 全部 healthy | —— |

### 放置方式（**倾向：单独一个容器**）

`router/src/scorer.ts` 的 `HttpTierScorer` 构造参数是 `'local-container' | 'external-endpoint'`
⇒ **它本来就是按"通过 HTTP 问一个端点"设计的**。
⇒ 最干净的做法是**单独一个 `forlife-scorer` 服务**（`llama.cpp` 的 `llama-server`，CPU 后端），
网关用 `HttpTierScorer('local-container', {url})` 问它。

**为什么不塞进 gateway 容器**：那会让"网关"这个组件的启动依赖一个几百 MB 的模型，
而判档**只是旁路**（它挂了应该退回启发式，而不是让网关起不来）。

### ⚠️ 动手前要确认的两件事（**我不猜**）

1. **权重从哪来**：VM 上**没有任何模型文件**，而"下载"要占带宽与时间；
   仓库里也没有既定的来源（我要先找有没有记录的镜像/校验值）。
2. **夜间关机的影响**：这台 VM **每晚关机** ⇒ 冷启动时那个服务要能自己起来，
   而且**判档在它没起来时必须退回启发式**（`startPreScore` 那条 50ms 超时路径要真的生效）。

⇒ **这两条要用户点头（或给出权重来源）之后我才动。**
在它们定下来之前，判档继续走"守卫 → 启发式兜底" —— 那是**可以用的**，只是不如小模型准。

> ✅ 用户 2026-10-10 已裁定：**「授权我联网下」** ⇒ 权重来源这一条解决了。
> 但**先做部署**（用户裁定「现在部署」）—— 小模型排在其后。


---

## 32. ✅ **部署已执行**（2026-10-10），以及真机上踩到的**三个坑**

### 结果（逐条用真实产物核实，不是看"容器 healthy"）

| 项 | 结果 |
| :--- | :--- |
| **qq 容器 ID** | `22c73c283b3f9577a3425be6` —— ★ **部署前后一字未变**（启动时间仍是 `02:33:50`） |
| dsh / gateway | 重建为新 ID（`5fc0c4e3645c` / `4e531fb001ca`），`running` + `healthy` + **重启次数 0** |
| caddy | 未动（镜像与配置都没变） |
| **`FORLIFE_LOG_DIR`** | ★ 两边都是 `/data/dsh/forlife/logs` —— **部署的核心目的** |
| 新代码在镜像里 | 读**容器内**文件核实：`wake-spawn.ts` / `feed-run-start.ts` / `log-sink.ts` / `log-store.ts` / `admin-ui/dist/index.html` 全在 |
| 网关在服务 | `http://127.0.0.1:8081/admin/` 真的返回 HTML，`health: healthy` |
| **§26 的判据** | ★ 日志文件 `forlife-2026-10-10.jsonl` 里 **37 条 `module=dsh-plugin`**（+16 条 `gateway`）；等级 `info 49 / warn 3 / note 1` |
| **契约探针**（§29 那轮接的） | ★ **真的在跑**，日志里是：`宿主契约：**降级可用**：7/8 齐全，缺 1 项**加固**功能（记忆本体正常）` |
| 面板日志接口 | 有**会话鉴权**（`api.ts:261` 的 401）⇒ 未登录读不到是**预期的**；**数据链路**已由上面的文件内容证明 |

### ⚠️ 坑 1：`npm config set registry` **管不到 corepack**

现象：构建在 `pnpm config set` 那一步 `EAI_AGAIN registry.npmjs.org`。
Dockerfile 里**早就写了**这个坑的注释（`:32-35` 记着"corepack 下 `pnpm-12.3.4.tgz`"），
但当时的对策（`npm config set registry`）**对 corepack 无效** —— 它读 `COREPACK_NPM_REGISTRY`。
★ 加了那个变量后**进了一步**（改成 `EAI_AGAIN cdn.npmmirror.com`），**仍然失败**；
而且 corepack 在 `/`（**没有 package.json**）下会退回**它自己的最新版 `12.10.1`**，
**不是**仓库钉的 `12.3.4` ⇒ 就算下载成功也是**错的版本**。
⇒ **正解：绕开 corepack**，用 `npm i -g --allow-scripts=pnpm pnpm@12.3.4`。
⚠️ `--allow-scripts` 不能省：npm 11+ 默认拦截生命周期脚本，而 pnpm 靠 `install.js` 落平台二进制
—— **不放行时 `pnpm --version` 照样打印 12.3.4**（它念的是 package.json），**看起来是对的**。

### ⚠️ 坑 2：**新建容器拿到的是路由器 DNS，而它在并发下会丢查询**

| 解析器 | 60 并发 × 3 轮 |
| :--- | :--- |
| 宿主 / `--network=host` 容器（`127.0.0.53`，systemd-resolved） | **0 失败** |
| **默认 bridge** 容器（`192.168.1.1`，**那台路由器**） | **13 / 18 / 11 次失败**（`EAI_AGAIN`） |

⇒ 构建步骤容器**默认走 bridge** ⇒ 用路由器 DNS ⇒ 下载大文件时随机超时/解析失败。
⇒ 对策两条（**都不重启任何容器**）：构建加 **`--network=host`**；宿主给 `systemd-resolved`
**加一个冗余上游**（`119.29.29.29`，实测会应答；`223.5.5.5` 在这条链路上**不应答**）并重启该服务
—— ★ 重启后**四个容器启动时间一字未变**（`02:33:50Z`）⇒ **qq 没有被重启**。

### ⚠️ 坑 3：`pnpm install` 卡在**同一个包**上反复超时

`@esbuild/linux-x64@0.25.12`（4.19 MB）报 `operation timed out`（读响应体超时），
而**同一台宿主直连同一 URL 只要 9.3 秒**；其余几十个包全都下好了。
四个源实测这一个包：npmmirror 宿主 9.3s ✓ / npmjs ✖（**这台机器没有 IPv6 路由**，而它只回 IPv6）/
腾讯 21.6s / **Huawei 0.5s（≈8 MiB/s）**。
⇒ **pnpm 换 Huawei**，并加 `fetch-timeout 600000` + `network-concurrency 4`。
⚠️ **npm 那条路仍留 npmmirror** —— 它要装 `@deepseek-ai/dsh`（786 MB），
而 Huawei 上**这个包的元数据实测失败过一次** ⇒ 关键路径不拿它赌。

### ⚠️ 坑 4（**未收口，如实记**）：`npm i -g @deepseek-ai/dsh` 的生命周期脚本被拦

构建日志里有：
```
npm warn install-scripts   koffi@3.1.1 / node-pty / @google/genai / protobufjs 被拦
```
⇒ 那些原生模块的 `install` 脚本**没跑**。19 小时前那个镜像**也是这样**建出来的，
而 dsh 容器一直 `healthy`、模型列表与面板接口都正常注册
⇒ **当前功能上没看出问题**，但这是个**已知的未收口点**：真要依赖 `node-pty` 之类的功能时可能才发现。
（要收口就得显式 `--allow-scripts=...`，而那等于**信任这几个包**，属于要单独决定的事。）


---

## 33. ★★ **P3 被自己的闸门拦住了 —— 而且它是对的**（2026-10-10 实查）

> P3 是「彻底清空记忆 → 重新检查更新 → **重新导入**」。
> 我按纪律**先验证恢复路径再动破坏性操作** —— 结果**恢复路径是断的**。
> ⇒ **没有清空任何东西。** 这一节记下断在哪、为什么断、以及要补什么。

### 断点：投喂前的**源刷新闸门**（用户 2026-10-09 裁定的机制）

代码位置：`feed-batch.ts:471-485`
```
闸门一：**投喂前必须先刷新源**
  resolveFeedRefresh(...) → 不通过 ⇒ return failure
  runFeedRefresh(...)     → 不 ok ⇒ `投喂前的源刷新未通过：…` ⇒ **不写任何记忆**
```

刷新的实现在 `.runtime/chat-segv2-tool/refresh.mjs`（3.1 KB），它**只做一件事**：
读段包里的 **`SOURCE.json`**（`preparedAt` / `segments` / `seg1Items` / `seg2Items`），
**超过 `FEED_STALE_MINUTES`（默认 1440 = 24 小时）就拒绝喂**。

它自己的注释把理由写得很好：
> 段包是源的快照。用几天前的快照重喂是**破坏性**的：同一 `--source` 重导会按
> "更新那一份东西"处理，源里新增的内容不在快照里 ⇒ **那段新记忆永远不会进来**，
> 而且**没有任何报错** —— 看起来一切正常。

### 实查：三道都不通

| # | 事实 | 证据 |
| :--- | :--- | :--- |
| ① | ★ **`SOURCE.json` 全 `.runtime` 里都不存在** | 段包里只有 `MANIFEST.json`（**是数组**，没有 `preparedAt`）；备份目录 `chat-feed-v2-bak-396` 里也只有 `MANIFEST.json` ⇒ `refresh.mjs` 会判「**这份段包不是 feed-prepare.ps1 产出的**」 |
| ② | ★★ **`feed-prepare.ps1` 根本不存在** | `refresh.mjs:55` 让你回 Windows 跑它 —— **而它没被写出来**。`.runtime` 里只有 `fetch-deepseek-chat.ps1`（4.9 KB，拉源）与 `feed-all.sh`（4.7 KB） |
| ③ | ★ **段包已经 26 小时** | 段文件时间 `10-09 15:52`，现在 `10-10 17:55` ⇒ **超过 24 小时上限**（就算 ① 补上也会被拒） |

### ⇒ 判决：**不清空**

清空 = 毁掉**唯一的加工品**（10,914 条 mid / 1.52M token），而**恢复路径不通**。
备份（`forlife-before-p3-2026-10-10T09-51-08.sqlite`）能兜底，
但**兜底是最后手段，不是第一手段**。
⇒ **闸门存在的意义正是拦住我刚才要做的事，它生效了。**

### ★★ 自我更正：断的不是"喂入器"，只是"新鲜度证明"

我上面那句「恢复路径不通」**说粗了**。读完 `.runtime/feed-all.sh`（125 行）之后要分清：

| 组件 | 状态 |
| :--- | :--- |
| **喂入器** `feed-all.sh` | ✅ **存在且是完整的** —— 逐段 `feed-memory.ts <file> --as experience --source chat/<base> --refresh …`；**顺序 seg2（较早）→ seg1（较新）**；**稳定 `--source` ⇒ 幂等重导**（改过的段走"更新"而不是"又插一份"）；末尾还会打印库里结果 |
| **单段喂入** `scripts/feed-memory.ts` | ✅ 在镜像里（我实查过 `/app/scripts/`） |
| **刷新校验** `refresh.mjs` | ✅ 存在 |
| ★ **`SOURCE.json`（闸门要的"新鲜度证明"）** | ❌ **没有**，而且**产出它的 `feed-prepare.ps1` 不存在** |

⇒ 准确的说法是：**喂入这条路是通的，缺的是"这份快照是刚拉下来的"这个证明**。
而那个证明**必须在有登录态的一侧产生**（`refresh.mjs:6-8`），容器里做不到。

★ 顺带一个**可操作的细节**：`feed-all.sh` 期望段包在 `/tmp/feed`、`refresh.mjs` 在 `/tmp/feed-tools`
（我这次放的是 `/data/dsh/forlife/feed-v2`）⇒ 真要跑时要么按它的路径摆好，要么改脚本里的变量。

### ★★ 2026-10-10 补：那次用的**是什么刷新命令**，已从真库反查出来

`feed-refresh.ts` 的两条事实决定了怎么找：

| 事实 | 位置 |
| :--- | :--- |
| 源 key = **`sha1(刷新命令行)` 的前 10 位** | `feed-refresh.ts:144`（`feed_source:<10位>`） |
| `{kind:'default'}` 读**部署环境变量** `FORLIFE_FEED_REFRESH_COMMAND`；没配就报「**部署没配刷新命令**」 | `feed-refresh.ts:282` / `feed-batch.ts:303` |

**真机实查**：

| 查什么 | 结果 |
| :--- | :--- |
| `.env` 里 `FORLIFE_FEED_REFRESH_COMMAND` | **0 次** |
| compose 里 | **没有** |
| 两个容器 `printenv` | **都没设** |
| ★ 真库 `forlife_state` 里的投喂源记录 | `feed_source:1d53c989e2` = `{"at":"2026-10-09T08:02:13.761Z","items":283,"label":"node"}` |

⇒ **结论**：那次**不是** `{kind:'default'}`，而是**在请求里显式传了命令**。
对照 `feed-all.sh:34,38`：

```sh
TOOLS=/tmp/feed-tools
REFRESH="node $TOOLS/refresh.mjs"     # ← 与真库里 label="node" 完全吻合
…
--refresh "$REFRESH"                  # 每次投喂都显式带上
```

⇒ **它就是 `node /tmp/feed-tools/refresh.mjs`**，`items=283` 也对上了这份段包的 283 段。

★ **它当时能过，是因为 `/tmp/feed/SOURCE.json` 存在且新鲜** —— `/tmp` 是临时的，过后就没了；
而**产出它的 `feed-prepare.ps1` 又不存在**（本节开头那条）。
⇒ **判决不变，但路径现在完全清楚了。**

### ⇒ 用户要做的四步（精确到路径）

1. 更新 `.runtime/fetch-deepseek-chat.ps1` 里的凭据（cookie/token 是会话级的）
2. 跑 **`pwsh -File .runtime\feed-prepare.ps1`** ⇒ 段包带上新鲜的 `SOURCE.json`
3. 把**段包**放进容器的 `/tmp/feed`、把 **`refresh.mjs`** 放进 `/tmp/feed-tools`
   （`docker cp` 即可；`.runtime/chat-segv2-tool/refresh.mjs` 就是那个文件）
4. 在容器里跑 **`bash /tmp/feed-all.sh`**（它自己会先单独跑一次刷新校验，**不过就一段都不喂**）

★ 第 3 步的路径是 `feed-all.sh` 里写死的（`FEED=/tmp/feed`、`TOOLS=/tmp/feed-tools`）。

### ★ 顺带：面板那四块在真库上的**真实数字**（用户最初的抱怨）

按 `repository.ts:270-287` 的 `midStats()` **逐字照抄**在真库上算：

| 口径 | 值 |
| :--- | :--- |
| 活跃条目 | **10,714** |
| **长期碎片** | **200** |
| 中期条目（面板主数字 = 活跃 + 长期碎片） | **10,914** ✅ 相加吻合 |
| 活跃 token | 1,515,642 |
| 碎片 token | 8,138 |
| ★ **长期条目** | **400**（用户看到的是 **0**，现在不再是 0） |

★ 顺带纠正一个我自己的误解：**「长期碎片」不是一张表** ——
它是 `sum(CASE WHEN status='fragmented' THEN 1 ELSE 0 END)`（`repository.ts:275`），
**按状态数出来的**。中期表里只有 `active`(10714) 与 `fragmented`(200) 两种状态，**没有第三种会被漏掉**。


---

## 34. 本地评分器：**装起来了、能回答、但慢了 200–1000 倍**（2026-10-10 实机）

> 用户 2026-10-10 裁定「部署小模型，把预评分接上」+「授权我联网下」。
> 这一节是**装完之后**的实机结论 —— 与 §31 的可行性判断放在一起看。

### 已完成（都可复现）

| 项 | 结果 |
| :--- | :--- |
| 服务定义 | **上一轮会话已经写好**（`deploy/docker-compose.yml:349`，`profiles: [scorer]` ⇒ 默认不起） |
| 权重 | `models/scorer.gguf` **491,400,032 字节（468.6 MB）** |
| ★ **校验** | **sha256 实际 == 期望** = `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`，来源记入 `models/SOURCE.txt` |
| 容器 | `forlife-llama-server-1` → **Up (healthy)**，日志 `model loaded` + `listening on http://0.0.0.0:8080` |
| ★ qq | **全程未动**（`22c73c283b3f9577`，启动时间仍 `02:33:50`） |

### ✅ 它**真的能判档**

从 gateway 容器里走内网问它（`http://llama-server:8080/v1/chat/completions`）：

| 输入 | 输出 |
| :--- | :--- |
| `嗯嗯好的` | ✅ `{"tier":"L1"}` |
| 「我想重构整个路由层，涉及三个包十几个文件…」 | ✅ `{"tier":"L3","confidence":0.95}` |
| `在吗` / 「帮我看看这个函数为什么慢…」 | ❌ 复读了系统提示里的**格式示例**（`{"tier":"L1"或"L2"或"L3",...}`） |

⇒ **四例全有回答**，但对**极短**与**中等**的输入会**照抄格式说明**而不是判断。
（这与"0.5B 的指令跟随能力"一致；把示例从系统提示里去掉、或改用 few-shot，值得试。）

### ❌ ★★ 决定性问题：**延迟 7–37 秒**

| 测量 | 值 |
| :--- | :--- |
| 三次纯延迟（`max_tokens: 8`） | **8,234 / 7,202 / 7,107 ms** |
| 四例判档 | 36,697 / 8,189 / 27,159 / 18,140 ms |

**而基线的设计口径是**（`router/src/scorer.ts:8`）：

> | `local-container` | 本地 0.5B 容器（默认） | **5–30ms**，常驻、预热 |

⇒ **实测比设计慢 200–1000 倍。**

**为什么**（如实列，不猜单一原因）：
1. **无 GPU** —— `/dev/dri/card0` 背后是 QEMU 虚拟 VGA（§31 已查），**纯 CPU、4 线程**
2. `LLAMA_ARG_CTX_SIZE=4096` —— 判档不需要 4k 上下文，**prefill 被浪费**
3. 这个 VM 同时在跑四个容器 + 一次前端构建的余温
4. 系统提示较长（含格式说明），**每次都要 prefill**

### ★★ 更正：上面那四条里，**只有第 1 条沾边**，真根因在**指令集**

我做了两组实验，把"猜"换成了"量"：

**实验一：`-c 512` + 单槽（一次性容器，不动 compose）**

| 配置 | 短提示/1 token | 短提示/32 token | 长提示（629 tok）/1 token |
| :--- | :--- | :--- | :--- |
| `-c 4096` / 4 槽（生产） | **4,906 ms** | 13,390 ms（**1,030 ms/token**） | ★ **80,847 ms** |
| `-c 512` / 1 槽（实验） | **6,002 ms**（**更差**） | 14,348 ms（**1,104 ms/token**） | 无效（上下文装不下） |

⇒ **缩上下文与减槽数完全没用** ⇒ 我第 2、4 条猜测**被证伪**。

**实验二：看 vCPU 到底有什么指令集**

```
model name : QEMU Virtual CPU version 2.5+
  ✖ avx     ✖ avx2     ✖ fma     ✖ f16c        ← 全缺
  ✓ sse4_2                                       ← 只有这个
```

★★ **⇒ 真根因：这台 VM 的 vCPU 是 QEMU 默认型号（`QEMU Virtual CPU version 2.5+`），
没有 AVX / AVX2 / FMA** ⇒ llama.cpp 只能走 **SSE 标量路径** ⇒ **≈1 token/秒**
（0.5B Q4 在 4 个**现代**核上本该 30–80 tok/s）。**这解释了全部差距，而且与上下文无关。**

**旁证**：宿主 `load average 3.59`，而 `unattended-upgr` 正吃 **99.9% CPU**、`snap` 80.9%
—— 5 个容器抢 4 个核，雪上加霜。

### ⇒ 修法与它的代价（**这一步需要你点头**）

把 PVE 里这台 VM 的 **CPU 类型从默认改成 `host`**（或 `x86-64-v3` / `Skylake-Client`）
⇒ 客户机就能拿到 AVX2/FMA ⇒ **预计快 10–50 倍**（仍到不了 50 ms，但会从"完全不可用"变成"可评估"）。

⚠️ **代价：改 CPU 类型要停机重启整台 VM** ⇒
**那会重启所有容器，包括 `qq`** ⇒ 硬约束「**不准重启 QQ 容器**」直接挡住。
⇒ **所以我没有改，也不再自己往前走这一步** —— 要不要为评分器付这个代价，是你的决定。

（另：把 `unattended-upgr` 调开或限速也值一做，那是**不用重启**的。）


### ⇒ 结论与建议（**我没有把它接进请求路径**）

- 服务**留着**（`profiles: [scorer]` ⇒ 默认不起，**不影响任何现有功能**）
- ★ **不建议现在接进判档路径**：每次轮次多 7–37 秒，而 `router.minimum.timeoutMs`
  的设计前提是毫秒级 —— 接上去只会**每次都超时**，然后退回启发式，
  **白付延迟还可能打乱判档**。
- 要让它变得可用，至少得先做这三件之一（**都要单独验证**）：
  1. **缩小上下文**（`-c 512` 甚至 `256`）—— prefill 是主要成本
  2. **精简系统提示**（去掉格式示例，改 few-shot 或干脆让 `parseScoringOutput` 容错）
  3. **换成"预热 + 只有长消息才问"** 的策略（短消息直接走启发式）

⚠️ **`router.minimum.timeoutMs` 的现值我还没读**（§22 记着判档是"守卫 → 启发式兜底"）。
⇒ **在读到那个值之前，不接** —— 与本计划 §11 那条"分母与阈值没读清之前不许猜"同一个纪律。







> ⚠️ 顺带一条**观察**（不是洞）：`media_assets` 表被**沉降 / 归档 / 迁移 / 面板查询**读着，
> 而生产里**没人往它写** ⇒ 那几个子系统在真机上**零行可处理**。
> 这不是 bug（表本来就该空着，直到 `media_save` 建出来），
> 但**排查"沉降怎么什么都没搬"时要知道这一点** —— 别把它当成沉降坏了。

### 还没裁定（**别当成洞，也别忘了**）

以下这些**我还没读上下游**，因此**不下结论**：

```
store/src/media.ts 之外的其余零引用符号（共 37 个，已裁定 8 个）
  admin-ui:   formatBytes / formatTokens / formatDateTime / formatPercent
              useElementSize / useTheme / useNow / formatRefreshAge / inboundPreview
  gateway:    isRegularFile / joinWorkspace · createWatermarkChecker / watermarkConfigFromEnv
              newRestockBudget / restockSticker · redactingLogger / findSensitive
              systemTriggerPayload / canTransition / forbiddenInstructionFraming
              createProgramRunner / newExternalToken / isBadState · listBackups
  dsh-组件:   runDoctor / renderDoctorReport · resetToolSpillStats · runtimeCount
              textBlocks · runtimeFor · takeCompactionRequest
```

★ 其中**两个值得优先看**（因为它们牵涉"该有人调"的语义，而不是纯 helper）：
- `host-contract.ts` 的 **`runDoctor` / `renderDoctorReport`** —— 一套**自检**，从没跑过
- `gateway/src/admin/storage-write.ts` 的 **`listBackups`** —— 面板上的备份列表？

⇒ **接手的人从这两个开始**，其余大多是格式化 helper 或 composable（属于"库里有、没人用"的正常情形）。

---

## 35. ✅ `compaction_epoch = 0` **是对的**，不是故障（2026-10-10 实算）

> 环境的症状清单里一直挂着「`compaction_runs: 0`；epoch 0」。
> §34 已经解释了**历史上**为什么是 0（`renderView()` 把整张表渲进前缀 ⇒ `CONTEXT_WINDOW_EXCEEDED`
> ⇒ 压缩根本没机会被判定）。**但"现在"为什么还是 0，之前没人算过。**

### 判定函数（`memory-core/src/compaction.ts:88-117`，逐字）

```ts
const tokenOk    = stats.shortTokens >= t.minTokens                 // 2000
const turnWaived = stats.shortTokens >= t.waiveMinTurnsAboveTokens  // 6000
const turnsOk    = turnWaived || stats.turnsSinceLast >= t.minTurns  // 3
const toolsOk    = stats.toolCallsSinceLast >= t.minToolCalls        // 5
if (!tokenOk || !turnsOk || !toolsOk) {
  if (!pressure) return { approved: false, reason: 'too_thin', … }
}
```

### 阈值（基线 `params`，逐条读出来的）

| 键 | 值 |
| :--- | :--- |
| `compaction.minTokens` | **2000** |
| `compaction.minTurns` | **3** |
| `compaction.minToolCalls` | **5** |
| `compaction.waiveMinTurnsAboveTokens` | **6000** |
| `compaction.emergencyBypassRatio` | **0.75** |
| ★ `context.windowTokensDefault` | **128000** ← `shortRatio` 的**分母**（`:691`） |

### 真库状态（`forlife_state`，键值表）

| 键 | 值 |
| :--- | :--- |
| `acct_short_tokens` | **21844** |
| `acct_turns_since_compaction` | **14** |
| `acct_toolcalls_since_compaction` | **2** |

### ⇒ 逐条代入

| 条件 | 算式 | 结果 |
| :--- | :--- | :--- |
| `tokenOk` | `21844 ≥ 2000` | ✅ |
| `turnWaived` | `21844 ≥ 6000` | ✅ ⇒ **`turnsOk` 被豁免** ✅ |
| ★ **`toolsOk`** | `2 ≥ 5` | ❌ **不满足** |
| `pressure` | `shortRatio = 21844 / 128000 = **0.171**` vs `0.75` | ❌ 不是告急 |

⇒ **返回 `{ approved: false, reason: 'too_thin' }`。**

★★ **所以 `compaction_epoch = 0` 完全正确**：它**在等第 5 次工具调用**，而现在只有 2 次。
（冷却期那条**不适用**：`hasPreviousCompaction === false`（从未压缩过）⇒ `:120` 整个跳过，
所以唯一的解释就是 `too_thin`，**没有第二种可能**。）

### 顺带：这条也解释了**为什么"喂完就期待压缩"是不成立的**

`feed-all.sh` 的注释写着「1900k+ 字符全进去 ⇒ 中期记忆区会被填满 ⇒ **触发压缩**（阈值 50%）」。
但**投喂本身走的是 `feedMemory()`（写库），不是模型轮次** ⇒ 它**不增加 `toolCallsSinceLast`**
（那是 `acct_toolcalls_since_compaction`，只在真实轮次的工具调用里加）。
⇒ **投喂再多，压缩条件也不会因此满足** —— 压缩要的是**真实轮次里的工具调用**。

★ 这不是 bug（`minToolCalls` 是 PLAN.MD §12.1 的规格，作用是"防太薄"），
但**它意味着"清空重喂之后要靠压缩把四层流水线推起来"这个期待需要修正**：
中间必须有**真实对话轮次**。


---

## 36. ✅ **P0-a 在真机上验过了**：窗口外不再是黑洞（2026-10-10 实算）

> P0-a 是计划里最要紧的一步（D2：窗口外的中期条目**取不回来**）。
> 这一节不读测试、不读注释 —— **在真库上按同一套规则算，并验按 id 能取回正文。**

### 口径：三重照抄（不自己发明）

| 抄什么 | 从哪 |
| :--- | :--- |
| 窗口选取（排序键 + "装不下就停"） | `memory-core/src/window.ts:109-159` 的 `newerFirst` / `selectMidWindow` |
| 预算 | 基线 `memory.midWindow.maxTokens` = **100000** / `maxCount` = **2000** |
| 取回 | `dsh-component/src/tools.ts:530-539` 的 `recall_mid` 执行体 |

排序键逐字是：`compaction_epoch` ↓ → `window_offset` ↓ → `id` ↓（末位兜底，
保证同一张表两次渲染字节一致）；规则是「**从最新往回装，任一个预算不够时立即停**」
（不是跳过这条再试更旧的）。

### ★★ 算出来的数字**与用户最初的抱怨完全吻合**

| 我算的 | 当时面板上看到的 |
| :--- | :--- |
| 候选 **10,914** 条 | 「11114 个活跃记忆条目」（其中 200 已降级为碎片 ⇒ 中期总数 10,914） |
| ★ 窗口内 **645 条 / 99,949 token** | ★「窗口内 **645 条**」 |
| 窗口外 **10,269 条 / 1,423,831 token** | 「全表 1555k」 |
| ★ 窗口外占比 **94.1%（条）/ 93.4%（token）** | ★「**94%** 彻底失忆」 |

⇒ 这套照着源码算的口径**能复现出当时那组数** —— 这比"我觉得对"有力得多。

### ✅ 抽查：窗口外的条目**真的能按 id 取回正文**

在窗口外取三条，覆盖 **最新** offset 10468 / **中间** 5334 / **最旧** 200 三档：

| 抽样 | `found` | `inWindow` | 正文 |
| :--- | :--- | :--- | :--- |
| offset 10468 | `true` | `false` | ✅ 取回（226 字） |
| offset 5334 | `true` | `false` | ✅ 取回（51 字） |
| offset 200 | `true` | `false` | ✅ 取回（121 字） |

**对照组**：窗口内的一条正确地报 `inWindow=true`（"它本来就在你眼前，不需要取"）✅

⇒ **3/3 全部取回，三档都覆盖到了** ⇒ **P0-a 的实质成立：窗口外有按 id 的回填路径。**

★ 注：取回的正文是**私人对话内容**，本文件**不引用**（只看长度与"取没取到"）。

### ✅ 部署的镜像里确实有这段代码（读的是**容器内**的文件，不是仓库）

| 检查 | 结果 |
| :--- | :--- |
| `/app/packages/dsh-component/src/tools.ts` 里 `name: 'recall_mid'` 的定义 | **1 处** |
| `feed-restrict.ts` 里它在**投喂白名单**中 | **1 处** |
| `runtime.ts` 里「`recall_mid` 逐条取回」的**指路提示** | **2 处** |

⇒ 「**工具有了、提示也指路了、部署的镜像里都在**」三件一起成立，这才叫 D2 修好了 ——
只修工具不修提示的话，模型**连要不要调它都无从判断**（那条守卫测试说的就是这件事）。


---

## 37. ✅ **P0-c / D3 也验过了**：路通了（2026-10-10，读容器内文件）

> D3 是「**只修 D1 会制造新的永久黑洞**」那条耦合：
> `recall_longterm` 的中期兜底挂在 `if (entries.length === 0)` 上 ⇒
> **长期库一旦非空，这个兜底再也不走**。
> ★ 而长期库**已经从 0 变成 400 条**（P0-b 生效之后）⇒ 这条**正好是现在最要紧的**：
> 若闸门还在，那 94% 就**连"我知道有几条但取不回来"都不会说**。

### 代码自己把这件事说得比计划清楚（`runtime.ts:540-550` 原文）

> 那是一个**新手引导性质**的兜底……不是一条检索路径。代价要到长期库有内容之后才显现：
> **任何能命中长期层的查询，再也不会被告知"中期层里还有 N 条"** ⇒
> 模型连"要不要 `recall_mid`"都无从判断 —— 而 P0-a 刚加的那个工具正需要这条提示指路。
> ⇒ 两件事叠起来就是：**工具在那儿，路被堵死了。**
>
> 改成"长期层没喂饱这次额度，就也看一眼中期层"。
> 多一次 FTS 的代价，换的是"**不会再有一整层记忆静默消失**"。

### 容器内实查（读的是**部署的镜像**，不是仓库）

| 检查 | 结果 |
| :--- | :--- |
| 旧闸门（`searchMidFts` 之前紧跟 `entries.length === 0`） | **0 处** ✅ 已摘掉 |
| ★ 新闸门 `if (entries.length < maxResults) {` | **1 处** ✅ |
| `midFallbackNote` / `midAlongsideNote` | **各 2 处** ✅ 都在 |
| ★ `midAlongsideNote` 里带 id 且指向工具 | ✅ `const ids = hits.slice(0, maxIds).map((entry) => entry.id)` + 「它们不在长期层，`recall_longterm` 查不到。需要的话用 **recall_mid 逐条取回**：`${ids.join('、')}`」 |

⇒ ★ **两层都有命中时"两边都说"**（`midAlongsideNote`）—— 这是新增的，
原来只有"长期零命中"那一种情况才提中期。

### ⚠️ 一处我差点误判的地方（记下来）

我第一遍查「那句静默的谎」`但它们已在当前上下文中，无需检索` 时命中了 **1 处**，差点判成"没删干净"。
**但硬约束写着「去注释后」** —— 剔掉 `*` / `//` 行之后：**命中 0 处** ✅。
那 1 处是**文档注释在引用旧文案**（`runtime.ts:586`：「原文案（`runtime.ts:492`）是：…」），
**不是活代码**。

★ 这条与 §7 那条是同一类：**看到的命中不等于问题**，得看清它在哪一层。

### ⇒ D2 与 D3 的**合成结论**

| | 状态 |
| :--- | :--- |
| **P0-a**：按 id 取回窗口外正文的工具 | ✅ 真库抽查 3/3 取回（§36） |
| **P0-c**：让"中期层还有 N 条"**在长期层有命中时也会说** | ✅ 容器内实查（本节） |

⇒ **两者必须一起成立才有用**：只修前者 ⇒ **没有路通向它**；只修后者 ⇒ **没有工具可调**。
现在两条都在部署的镜像里 ✅ —— 那 94% 从"静默消失"变成"**会被点名、且能按 id 捞回来**"。






### 要补什么才能做 P3（按依赖顺序）

1. ~~**写 `feed-prepare.ps1`**（**缺的就是它**）~~ → ✅ **2026-10-10 已写出来**，见下。
2. **拉源要凭据**：`refresh.mjs:6-8` 写明源是 DeepSeek **网页端**导出，
   只能从"有登录态的那一侧"拉（`HWWAFSESID` / `ds_session_id` cookie）——
   **容器里没有、也不该有**。⇒ **这一步必须用户在场**（或者给一份新鲜快照）。
3. `SOURCE.json` 到位且新鲜之后，再按 P3 走：清空 → 重导。

### ✅ 已补：`.runtime/feed-prepare.ps1`（那个"让你去跑"却不存在的东西）

`refresh.mjs:55` 的报错让你回 Windows 跑它 —— **此前它不存在**（§33 开头那条）。
现在它在了，做四件事，**顺序不能换**：

| # | 做什么 | 落在哪 |
| :--- | :--- | :--- |
| ① | **拉源** —— 调 `.runtime/fetch-deepseek-chat.ps1`（**凭据只活在那个文件里，新脚本不含任何凭据**） | `.runtime/chat-import/*.json` |
| ② | **重新切分** —— 调 `chat-segv2-tool/generate.py`（`LIMIT=8000` 字/段） | `.runtime/chat-feed-v2/` + `MANIFEST.json` |
| ③ | ★ **写 `SOURCE.json`** —— `preparedAt` / `segments` / `seg1Items` / `seg2Items` | 闸门要的就是它 |
| ④ | ★ **自检用闸门自己**（`node refresh.mjs`） | 它说通过才算通过 |

**失败纪律**：任何一步不过 ⇒ **不写 `SOURCE.json` 且非 0 退出**（脚本里 **14 处** `Die`）。
理由写在脚本头：**写一个"看起来新鲜"的时间戳去骗过闸门，等于把闸门防的那件事亲手做一遍。**

★ **我自己在脚本里堵了一个后门**：`-SkipFetch`（只重切、不重拉）会产出
一份"刚 prepared"的 `SOURCE.json` ⇒ **让闸门放行一份没重新拉过的源**。
⇒ 现在它**必须与 `-AllowStaleSource` 一起用**，否则直接失败，并明确写出
"这份 SOURCE.json 只证明**我重新切过**，**不证明源是新的**"。

**验证**：`Parser::ParseFile` **语法 0 错误**；它引用的三个外部件都在；
`.gitignore:2` 的 `.runtime/` 盖住它 ⇒ **脚本按约定不进仓库**（与 `fetch-*.ps1` / `refresh.mjs` 一致）。

⇒ **剩下唯一挡着 P3 的**：**① 需要你那份网页端登录态**（cookie/token 会过期，几小时到几天）。
你把它更新一下、跑一次 `pwsh -File .runtime\feed-prepare.ps1`，
段包就会带上新鲜的 `SOURCE.json`；之后清空 + 重导就能按 P3 走。


### 顺带解开的两个旧谜

- ★ **`compaction_runs: 0` 的谜底**（`feed-batch.ts:13-18` 原文）：
  `renderView()` 曾把**整张中期记忆表**（10,794 条 / **1,504,850 token**）全量渲染进提示词
  ⇒ `CONTEXT_WINDOW_EXCEEDED` ⇒ **压缩永远不触发**（压缩看上下文占比，而上下文一开始就爆）
  ⇒ `compaction_epoch` 恒 0、`long_memory_entries` 恒 0 ⇒ **四层流水线第一层就堵死**。
- ★ **重导**大概率**不用模型**（与"71 轮 × 24k token"的担心相反）：
  `feed-batch.ts:29-34` 写明每批走 `feedMemory()`（`insertLongEntry` / `appendMidEntry` /
  检索判重 / 归档），那是**写库**，本模块只做调度。
  ⚠️ 但**这一条我还没实读到 `feedMemory` 内部**，所以先记为"大概率"、不当作结论。
