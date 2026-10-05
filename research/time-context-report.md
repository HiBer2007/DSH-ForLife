# DSH 时间幻觉：根因诊断报告

> 调研对象：本机 DSH（`@deepseek-ai/dsh-* = 0.1.7-rc.2`）
> 真实包根：`R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
> 方法：只读源码 / README / bundle patch（未修改任何 DSH 文件）

---

## 一、结论先说

**这不是模型的锅，也不完全是"幻觉"。在我们这套运行路径上，模型根本没有拿到时钟上下文。**

宿主有一个专门的时钟插件 `@deepseek-ai/dsh-time-context`，但它：

1. **只出现在 `dsh-web-app` 的 bundle 里**，`dsh-base` 里完全没有；
2. **在那一行里还是 `disabled: true`**（要开 Schedule 功能才会启用）；
3. 而我们的 QQ 轮次由 `dsh --profile forlife headless` 驱动，**连 web bundle 都不加载**。

⇒ 结论：**在当前架构下，模型对"现在"的唯一信息来源是它自己的训练先验。**

---

## 二、证据

| 编号 | 事实 | 出处 |
| :--- | :--- | :--- |
| E1 | `time-context` 这一行的定义在 web bundle 内，且 `disabled: true` | `R/dsh-web-app/cordis.patch.yml:121-123` |
| E2 | 同一段落里 `dsh-schedule` 也是 `disabled: true` | `R/dsh-web-app/cordis.patch.yml:125-127` |
| E3 | `dsh-base` 的 bundle 内 grep `time-context` **零命中** | 全量 grep `*.yml` |
| E4 | 插件确实存在且可挂载：`name = "time-context"`，`Config { timeZone?, refreshIntervalMs? }`，注册一个 **prepended `agent/pre-step`** 监听器，需要时追加一条 `UserMessage` | `R/dsh-time-context/lib/types/index.d.ts:19,34-50` |
| E5 | 默认节流 **10 分钟**：`refreshIntervalMs` 默认 `600000`；`0` 表示每个合格步骤都注入 | 同上 `:39-40`；README §配置 |
| E6 | 注入文本（第一步）：`Time sampled while preparing turn <turn>, step 1: <timestamp>` / `Browser time zone for this request: …` / `Elapsed since the preceding model-visible message: <duration>` | README §模型体验 |
| E7 | 无浏览器时区时的策略是"**要求模型向用户澄清**"，而不是直接断言 | README §选择时区、§已知限制 |
| E8 | 读数是被压缩遮蔽的普通消息；压缩后可能一段时间没有新鲜读数 | README §主要流程 |
| E9 | 注入是**纯追加**，位于可复用请求前缀之后 ⇒ 不使既有 KV Cache 失效（这也是它被节流的原因：durations/token 会累积） | README §KV Cache 影响、§Token 影响 |

---

## 三、根因分析（按严重性）

### R1 · 缺钟（决定性）

见上。**未挂载 = 零信息**。这是第一位原因，且修复成本最低。

### R2 · 即便挂上，10 分钟节流也太粗

`refreshIntervalMs = 600000` 意味着同一会话两次持久注入至少隔 10 分钟。在一个"用户每几秒发一条消息"的 QQ 场景里：

- 每轮开始时的"现在"最多可能差 10 分钟；
- 模型若需要"现在几点"级别的精度，只能猜。

节流存在的理由是**成本**（E9）：每次注入都是一条会一直累积到下次压缩的消息。

### R3 · 措辞是"日志式"，不是"权威式"

`Time sampled while preparing turn <turn>, step <step>` 这种表述要求模型自己完成两步推理：把 turn/step 映射到"现在"，再判断这条读数是否还新鲜。**弱引导 = 模型倾向于忽略它、改用先验。**

### R4 · 没有"查时间"的工具

用户说的"**意识到应该去看看现在的时间**"在能力层面上不成立：即使模型想查，也没有任何工具可调。宿主工具表里没有 `now()` 一类工具。

### R5 · QQ 场景下时区策略会跑偏

无浏览器时区 ⇒ 插件降级为"要求澄清"。一个 QQ 机器人在被问"明天几点"时反问"请问您在哪个时区"，是很糟的体验。**必须用配置的 fallback 时区 + 提示词明确指令来兜住。**

### R6 · 压缩会遮蔽时间锚点

时间读数是普通消息，会被压缩遮蔽。压缩之后、下一个"合格步骤 + 间隔到期"之前，会话里可能**一条新鲜读数都没有** —— 而压缩恰恰是模型最需要重新定位"现在"的时刻。

### R7 · 我们自己的架构放大了陈旧度

- 防抖合并（2–3 s）→ 一轮里的"现在"和用户发消息时刻已经不同；
- `defer_turn` 长挂起 → 恢复时上下文里的时间锚可能是几小时前的；
- **自唤醒（§2.14）在数小时/数天后醒来** → 10 分钟级的新鲜度完全不够。

### R8 · 模型先验

即使给了时间戳，模型也常按训练数据里的日期作答 —— 除非被**明确要求"以注入的读数为准"**。

### R9 · 算术负担与跨边界错误

记忆条目只有绝对时间戳，"距今多久"要模型自己算；跨压缩边界、跨天、跨时区时错误率显著上升。

---

## 四、修复方案（对应计划 §2.15.2）

| 优先级 | 动作 | 要点 |
| :--- | :--- | :--- |
| **P0** | 在 `profiles/forlife/cordis.patch.yml` **显式挂载** `dsh-time-context` | `timeZone: Asia/Shanghai`；不能指望继承（那行是 disabled 且只在 web bundle） |
| **P0** | 系统提示词写死两条约束 | ① 未限定时区按 `Asia/Shanghai`，**不许反问用户时区**；② 禁止用训练先验/历史时间戳推断"现在" |
| **P1** | 新增 **`now()` 工具** | 返回 ISO + IANA + 人类可读 + 相对锚点 + 日期边界；描述里写明调用条件 |
| **P1** | `now()` 作为**唯一权威时间源** | 记忆渲染、唤醒提示、审计都走它，保证表述一致 |
| **P2** | **改为事件驱动注入**（替代 10 分钟节流） | 每轮首步必注入；同轮后续步仅在跨 N 分钟或跨日期边界时；**压缩后立即注入**；**唤醒/defer 恢复必注入** |
| **P2** | 严守 append-only | 时间读数**绝不进稳定前缀**，否则每轮破缓存 |
| **P3** | 记忆条目带**系统算好的相对年龄** | `[M12] (3 天前) …`，碎片同理，免除模型心算 |
| **P3** | QQ 入站消息带"发出时间 + 现在 + 差值" | 防抖合并多条时尤其重要 |
| **P3** | 唤醒提示固定带三个时间锚 | 现在 / 距上次交互 / 距上次行动 |
| **P4** | 面板「时间感知」指标 | 最新读数年龄、每轮是否有新读数、注入次数与成本 |
| **P4** | `time_drift` 遥测 | 从输出抓时间表述与真实时间比对，把幻觉量化成曲线 |
| **P4** | 时间感知回归测试集 | 10 个必须依赖时间的问题，挂/不挂两组的对比得分 |

---

## 五、附带发现（对其它设计有用）

1. **`dsh-schedule` 是现成的定时器**：web bundle 注释原文 —— "Durable Host-wide reminders. The Schedule service owns the task store and delivers each due occurrence as a **follow-up in its original Session**"。这几乎就是计划 §2.14 `timer` 类触发器的现成实现（同样默认 `disabled: true`）。**§2.14 的"复用 vs 自研"应优先考虑它。**
2. **`time-context` 与 `schedule` 是同一组功能**：注释说明 `time-context` 存在的目的就是给 Schedule 投递的提醒提供"解析未限定日期/时间所需的时间上下文"。⇒ 我们启用定时唤醒时，**这两个必须一起挂**。
3. **`time-context` 的注入形态可复用**：`{ kind:'plugin', plugin:'time-context', form:'snapshot', sections:[…] }` 这种"带来源的快照消息"是我们自己注入时间/唤醒信息时可以照抄的形态（有 invariant 校验配套）。

---

## 六、不确定性

| # | 未验证点 |
| :-- | :--- |
| U-a | `time-context` 在 **headless profile** 下能否正常工作（它依赖 `agent/pre-step` 与 session 事件，理论上可以；未实测） |
| U-b | 挂载后 `refreshIntervalMs: 0` 的真实 token 成本曲线（每步一条 vs 每轮一条的差异） |
| U-c | 我们自研"事件驱动注入"与宿主插件的节流机制**并存时**是否重复注入（需要选定一种，或让宿主插件只做兜底） |
| U-d | 模型对"日志式措辞 vs 权威式措辞"的实际敏感度（需要 A/B 实测，属 P4 的测试集范围） |
| U-e | 跨时区用户的真实需求（当前假设：单一时区 `Asia/Shanghai`） |
