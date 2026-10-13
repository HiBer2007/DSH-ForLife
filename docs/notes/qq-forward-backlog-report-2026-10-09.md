# QQ 合并转发 + 离线积压 + 好友/群请求 —— 交付报告（2026-10-09）

范围：任务①（合并转发）、任务②（离线积压：通知/强制/取回/双向限制）、任务③（好友/群请求与列表），
外加审计 P0 全 4 条、P1 的 3 条、P2 的部分。

---

## 1. NapCat 那 4 个 action 的**实际**格式（读容器里的 `/app/napcat/napcat.mjs`，不是抄文档）

证据来源：**运行中的容器 `forlife-qq-1`**（`mlikiowa/napcat-docker:latest`，
实读时间 2026-10-09，bundle 3,112,751 字节）。下面每一条都是 grep/sed 出来的原文行为。

### 1.1 三个"发"：`send_group_forward_msg` / `send_private_forward_msg` / `send_forward_msg`

三者**共用同一个 `base_handle`**（`class q2 extends ky`，`s1e` / `o1e` / `i1e` 只差传 `la.Group` / `la.Private` / `0`）。

* **`check()` 的硬约束**（原文）：
  > 「转发消息不能和普通消息混在一起发送,转发需要保证message只有type为node的元素」
  ⇒ `messages` 数组里**只许**有 `{type:'node'}`，混一个普通段直接判非法。
* `messages` 经 `$a(t,e)` 透传，而 `$a` 的实现就是
  `typeof t == "string" ? … : Array.isArray(t) ? t : [t]` —— **它不做任何转换**，
  所以"发什么形状"完全由调用方决定（这正是必须读源码的原因）。
* **一个 node 里真正被读的字段**（从 `uploadForwardedNodesPacket` 抄下来）：
  | 字段 | 用途 | 缺省 |
  | :--- | :--- | :--- |
  | `data.content` | ★ **段数组**（正文） | —— |
  | `data.user_id` / `data.uin` | 发送者 QQ | 机器人自己 |
  | `data.nickname` / `data.name` | 发送者昵称 | 字符串 `QQ用户` |
  | `data.time` | 节点时间（**毫秒**） | `Date.now()` |
  | `data.id` | **转而引用一条已存在的消息**（给了它就不看 `content`） | —— |
  | `data.source` / `news` / `summary` / `prompt` | 卡片预览（外层转发时用） | —— |
* ⚠️ **`data.message` 根本不被读**。源码两处都是 `$a(x.type === ze.node ? x.data.content : x)`。
  写 `message` 会得到一个**空节点**，而接口照样返回成功 —— "成功但空白"这类最难查。
* **嵌套深度上限 3 层**：`if (c >= 3) { logWarn("转发消息深度超过3层，将停止解析！"); break }`。
* **返回**（`returnSchema` 原文）：
  ```
  { message_id: Number(必填), res_id?: String, forward_id?: String }
  ```
  （`res_id` 与 `forward_id` 同值，都来自 `UploadForwardMsgV2`。）

### 1.2 `get_forward_msg`

* 入参 schema：`{ message_id?: String, id?: String }`（**两个都可选**），
  实现里 `const n = e.message_id || e.id; if (!n) throw new Error("message_id is required")`。
* 返回 `{ messages?: Array }`。
* 两条路径，最终都返回 `{ messages: <forward 段的 data.content> }`：
  1. 正常路径：短 id → `getMsgHistory` → `parseMessage(msg, "array", true)` → 取 `message[0]`，
     要求它是 `forward`（`Nw(t) { return typeof t != "string" && t.type === ze.forward }`）；
  2. 回退路径 `protocolFallbackLogic`：伪造一个 `MULTIFORWARD` 元素 → `parseMessageV2` → 同样取 `data.content`。
* **`messages` 的元素形状**：`parseMultiMessageContent` 调的是
  `parseMessage(o, "array", true)`，返回的是 `arrayMsg`（`initializeMessage` 的产物）——
  也就是**完整 OneBot 消息对象**：
  `{ self_id, user_id, time, message_id, sender:{user_id,nickname,card}, raw_message, message:[段], post_type, … }`。
  **不是** `{type:'node'}`。（`get_forward_msg` 类里那个 `createTemplateNode`/`parseForward`
  在 `_handle` 里**没有被调用**，是死代码。）

### 1.3 ★★ 最关键的一条：**入站的合并转发默认只是个壳**

* `parseMultMsg` 的 schema 默认值是 **`!1`（false）**：
  `parseMultMsg: p.Boolean({ default: !1 })`。
* **线上配置实测就是 false**（`docker exec forlife-qq-1 cat /app/napcat/config/onebot11_3112546448.json`）：
  ```json
  { "parseMultMsg": false, "messagePostFormat": "array", … }
  ```
* 于是入站段是（`multiForwardMsgElement` 的原文）：
  ```js
  const a = { type: ze.forward, data: { id: n.msgId } };
  return i.parseMultMsg && (a.data.content = await this.parseMultiMessageContent(...)), a
  ```
  ⇒ **只有 `data.id`，没有 `content`**。

**⇒ 结论：不调 `get_forward_msg`，那段聊天记录的内容一个字都拿不到。**
而我们旧代码对 `forward` 段**一个分支都没有**，`text` 停在 `''`，
再被 `timing.ts` 的 `empty` 规则判噪音、`turns.ts` 整批吞掉 —— **连"空壳"都不算，是 0 条**。

### 1.4 好友/群请求与列表（任务③，同样实读）

| action | 实读到的 schema | 返回 |
| :--- | :--- | :--- |
| `set_friend_add_request` | `{ flag: String(必填), approve?: String\|Boolean, remark?: String }` | `null` |
| `set_group_add_request` | `{ flag: String(必填), approve?: Boolean\|String, reason?: String\|null(默认 " "), count?: Number(默认 100) }` | `null` |
| `get_friend_list` | `{ no_cache?: Boolean\|String }` | `[{user_id, nickname, remark, …}]` |
| `get_group_list` | `{}` | `[{group_id, group_name, member_count, max_member_count}]` |
| `get_group_member_list` | `{ group_id: String }` | `[{group_id, user_id, nickname, card, role}]` |
| `get_doubt_friends_add_request` | `{ count: Number(默认 50) }` | `[{user_id, nickname, …, reason, flag}]` |

⚠️ **两条反直觉的实测事实**（照文档猜一定会踩）：

1. **`set_friend_add_request` 的 `flag` 其实是 `buddyReqs[].reqTime`** ——
   实现是 `buddyReqs.find((i) => i.reqTime === e.flag.toString())`，
   找不到抛 `No such request`。**flag 只能从上报里拿**。
2. **`set_group_add_request` 的 schema 里根本没有 `sub_type`**（OneBot 文档说必填）。
   NapCat 用 flag 去群系统通知里找 `seq`，先找"可疑申请"再找普通申请（`findNotify`）。

**请求事件确实会上报**：`class UEe extends XU { request_type = "friend" }`、
`class ym extends XU { request_type = "group" }`，父类 `XU.post_type = REQUEST`。

---

## 2. 新增 / 改了哪些文件

### 新增（8 个源文件 + 4 个测试）
| 文件 | 做什么 |
| :--- | :--- |
| `packages/gateway/src/forward.ts` | **合并转发纯逻辑**：`buildForwardNodes`（发，产出 `content` 不产出 `message`）、`buildForwardNodesFromIds`（按 id 原样转发）、`parseForwardMessages`（收，**同时认消息对象与 node 两种形状**）、`extractForwardMessages`、`forwardPlaceholder` |
| `packages/gateway/src/backlog.ts` | **离线积压**：`backlogNotice`（只聚合计数）、`renderBacklogNotice`（**一个字的正文都没有**）、`readBacklog`（按 scope/kind/会话筛 + 标记已读）、`countUnread`、`seedBacklogWakeRule` / `listBacklogWakeRule` / `decideBacklogWake`（★ 单独那一组参数） |
| `packages/gateway/src/limits.ts` | **两个方向的限制**：`backlogReadQuota` / `consumeBacklogRead`（取）、`decideSendQuota` / `deliverPacing`（发） |
| `packages/gateway/src/requests.ts` | **好友/群请求**：`recordInboundRequest`（幂等落库）、`listPendingRequests`、`markRequestHandled`、`requestNotice` / `renderRequestNotice` |
| `packages/gateway/src/probe.ts` | **跨进程只读查询的接缝**：`PROBE_ACTIONS` 白名单、`runProbe`、`readProbeResult` / `clearProbeResult` |
| `packages/gateway/test/forward.test.ts` | 12 条（含 ★★★ 端到端证据） |
| `packages/gateway/test/backlog.test.ts` | 12 条 |
| `packages/gateway/test/requests-supervisor.test.ts` | 12 条 |
| `packages/gateway/test/inbound-segments.test.ts` | 7 条（P0-1 / P0-4 / P1-3 / P1-4 / P2-a） |
| `packages/dsh-component/test/qq-tools-new.test.ts` | 21 条（工具行为 + 接线守卫） |

### 改动
| 文件 | 改了什么 |
| :--- | :--- |
| `packages/gateway/src/transport.ts` | `QqTransport` 加 `sendForward` / `getForward` / `handleFriendRequest` / `handleGroupRequest` / `listFriends` / `listGroups` / `listGroupMembers`；`InboundMessage` 加 `forwardId` / `replyToMessageId`；`InboundEvent` 加 `subType` 与 4 类 notice 事件；`TransportStatus` 加 `qqOnline`；加 `ForwardContent` / `FriendBrief` / `GroupBrief` / `GroupMemberBrief` |
| `packages/gateway/src/onebot.ts` | 4 个 forward/请求/列表方法；入站 `forward` 段解析（占位符 + id，带 `content` 时**就地摊平**）；`reply` 段 id（P0-4）；**`else` 占位符**（P0-1）；卡片/大表情/在线文件抽取（P2-a）；4 类 notice（P1-4）；心跳存活（P1-3）；`extractCardText` |
| `packages/gateway/src/gateway.ts` | `resolveForwards`（★ P0-3，插在 `pumpScheduler` 的**真实路径**上）；`supervise()`（★ P0-2 接通报告 + 请求 + 积压）；出站 `forward`/`friend_request`/`group_request`/`probe` 分派；投递节拍 |
| `packages/gateway/src/outbox.ts` | `OutboundKind` 加 `forward` / `friend_request` / `group_request` / `probe` |
| `packages/gateway/src/index.ts` | 导出 4 个新模块 |
| `packages/dsh-component/src/qq-tools.ts` | 新工具 `qq_forward` / `qq_requests` / `qq_handle_request` / `qq_contacts`；`read_pending` 重写（筛选 + 额度 + remaining）；`qq_reply` 加速率闸门 + 修掉 `typing` 假承诺；`list_wake_rules`/`set_wake_rule` 支持积压那组 |
| `packages/dsh-component/src/gateway-plugin.ts` | **`supervisor: { enabled: true }`**（★ P0-2 的唯一开关）；`seedBacklogWakeRule`；`unreadSummaryOf` 改成**只报数量** |
| `packages/contracts/plan-baseline.json` | 追加 20 个键（**只追加，未重排/未改动任何现有键**） |
| `packages/gateway/test/admin-chat.test.ts` | 假传输层补齐 7 个新方法（类型要求） |

**未碰**（纪律）：`packages/gateway/src/wake.ts`、`turns.ts`、`timing.ts`、`memory-core/**`、`admin-ui/**`、`.runtime/**`、`deploy/**`、`feed*.ts`。

> ⚠️ 我一度往 `wake.ts` 加过 `pending_backlog` 与 `readPending` 的筛选参数，
> 收到"`wake.ts` 归别人"的约束后**已完整撤回**（`git diff --numstat` 当时验证 CLEAN）。
> 现在 `wake.ts` 的 +92 行是**别人**的改动，且里面**没有** `pending_backlog`（未撞车）。

---

## 3. 合并转发工具：名字、参数、返回

**工具名**：`qq_forward`（一个工具两个模式，因为"发"和"收"是同一件事的两面）

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `conversation` | string | 发到哪里；**发模式必填** |
| `nodes` | array | `[{name?, user_id?, text, image?}]`；与 `message_ids` **二选一** |
| `message_ids` | array | 原样转发已有消息 id（**推荐**：图片/语音/表情都能保留） |
| `read` | string | 收模式：要取回内容的合并转发 id |
| `summary` | string | 可选：卡片摘要 |

**返回**：`{ ok, mode: 'send'|'read', confirmed?, messageId?, outboxId?, text?, nodeCount?, notes?, hint? }`

**实现要点**：
* 发送走**既有出站链路**（`qq_outbox` → `Gateway.deliver` → `OneBotTransport.sendForward`），**没有另起一套**；
* 群/私聊分别用 `send_group_forward_msg` / `send_private_forward_msg`（不靠协议端猜）；
* 只产出 `type:'node'`（NapCat 的 `check()` 拒绝混合）；
* 超限（`qq.forward.maxNodes` / `maxChars`）**明确报错**，不默默砍掉。

**★ "收"还有一条更重要的路**（不经过工具）：`Gateway.resolveForwards` ——
别人转来的聊天记录**在轮到模型之前就自动展开**了，模型不需要主动调工具。

---

## 4. 离线积压

**积压在哪**：`pending_messages`（`read=0`）。`qq_inbox` 是全量流水、不是"没读的"；
**没有第三张表**。

### (a) 通知怎么呈现
* `backlogNotice()` 一次聚合查询：条数 / 涉及几个会话 / 每个来源各多少条 / 时间范围 /
  其中群多少私聊多少。**永不返回正文。**
* `renderBacklogNotice()` 产出文本，**一个字的正文都没有** —— 有测试用哨兵字符串钉住。
* 两处投递：
  1. **唤醒提示**（`gateway-plugin.ts` 的 `unreadSummaryOf`）—— 原来是"塞 5 条摘要"，
     现在**只报计数**；
  2. **系统监督轮次**（`Gateway.supervise()`）—— 独立的系统轮次。

### (b) "强制"的强度：选了第 3 种（**每轮必现 + 硬措辞 + 有额度**），不是硬阻塞
三种强度逐个说明为什么不选前两种：
1. **软提示**（"有空可以看看"）—— 不选：实测就是会被忽略，用户的原话是"强制"；
2. **硬阻塞**（积压没清空就不许调别的工具）—— **不选**：积压可能是永远处理不完的群
   （或 300 条垃圾），硬阻塞会把模型**锁死**，连有人私聊都回不了 —— 比不处理更糟；
3. ★ **选中**：通知**每一轮都出现**、写明"这是硬要求，先处理或明确说明为什么跳过"，
   同时取回**有额度**（所以它不会变成无底洞）。
   "每轮必现"就等于强制：模型无法假装没看见，要么处理、要么显式跳过 ——
   而"显式跳过"也在 `wake_events` 里留下痕迹。

⚠️ **一处如实说明**：本该同时在 `buildTurnPrompt`（每一轮的提示词）里也加一段，
但 `turns.ts` 本轮归另一个改动，按纪律没动。现在的投递是
**"唤醒提示" + "独立的系统监督轮次"**两条；等 `turns.ts` 腾出来后应补上第三处
（`buildTurnPrompt` 里加一段同样只报计数的 `pendingNotice`，约 3 行 + 一个 option）。

### (c) 取回工具
**扩展了既有的 `read_pending`**（没有新建第二个取消息工具 —— 那会变成两套机制）：
* 参数 `scope`（精确来源）/ **`kind: 'group'|'private'`**（★ 一类来源，"群消息能单独忽略"靠它）/
  `conversation`（会话键）/ `limit`；
* 返回新增 `remaining`（**同一筛选口径**的剩余未读，必须报）与 `quota`（本轮还剩多少额度）；
* 被限流时 `ok:false` + 人话原因，**且不标记已读**（不许把消息吃掉）。

### (d) ★ 两个方向的限制 —— 参数名 + 默认值
| 方向 | 基线键 | 默认 | 作用点 |
| :--- | :--- | :--- | :--- |
| **取** | `qq.backlog.readBatchMax` | **20** | 单次最多取几条 |
| **取** | `qq.backlog.readPerTurnBatches` | **3** | 单轮最多取几批 |
| **取** | `qq.backlog.readPerTurnMax` | **60** | 单轮取回总量上限 |
| **发** | `qq.send.perMinuteMax` | **20** | 每分钟最多几条（**入队前**拦，超了不写队列） |
| **发** | `qq.send.burstMax` | **5** | 突发上限（`qq.send.burstWindowMs` = **10000** ms 窗口内） |
| **发** | `qq.send.minIntervalMs` | **400** | 投递节拍（**投递侧**，认领之前判） |
| 请求 | `qq.requests.handlePerHourMax` | **10** | 处理好友/群请求的速率（同属发送类动作） |

**为什么"发"拆成两半**（刻意的分工，不是重复）：
* **入队侧**（工具层）限**速率** —— 超了**明确告诉模型"被限流了、等多久"**，
  而不是把消息默默丢掉；
* **投递侧**（网关层）限**节拍** —— ⚠️ 这一半**不能**放进入队侧：
  `qq_reply` 的设计就是"多次调用实现分段回复"，三段回复天然在同一毫秒入队，
  在入队处按最小间隔拦会把**正常的分段回复**打掉。

---

## 5. 新增的基线键（20 个，全部 `src` = EXECUTION_PLAN ⇒ `design` 来源）

只**追加**在 `wake.rules.selfMessageSent` 之后，**没有重排、没有改写任何现有键**（`params` 156 → 176）。

| 键 | 默认 | 为什么 |
| :--- | :--- | :--- |
| `wake.rules.pendingBacklog` | `{enabled:true, probability:100}` | ★ 用户要的**单独一组**：关掉它不影响在线唤醒 |
| `qq.backlog.wakeMinUnread` | 5 | 门槛：不为 1 条闲聊把模型吵醒 |
| `qq.backlog.wakeIntervalMs` | 600000 | 两次积压唤醒的最小间隔（写进 `wake_rules.min_interval_ms`） |
| `qq.backlog.noticeTopSources` | 5 | 通知里最多列几个来源 |
| `qq.backlog.readBatchMax` | 20 | 取的限制① |
| `qq.backlog.readPerTurnBatches` | 3 | 取的限制② |
| `qq.backlog.readPerTurnMax` | 60 | 取的限制③ |
| `qq.send.perMinuteMax` | 20 | 发的限制① |
| `qq.send.burstMax` | 5 | 发的限制②（防刷屏/防风控） |
| `qq.send.burstWindowMs` | 10000 | 突发窗口长度 |
| `qq.send.minIntervalMs` | 400 | 投递节拍 |
| `qq.forward.maxNodes` | 50 | 单次最多几个节点 |
| `qq.forward.maxChars` | 20000 | 单节点正文上限 |
| `qq.forward.maxDepth` | 3 | 嵌套深度（与 NapCat 实测一致） |
| `qq.forward.renderNodeMaxChars` | 800 | 解析时单条渲染上限（超了截断并如实标注） |
| `qq.forward.renderNodeMaxNodes` | 50 | 解析时最多渲染几条 |
| `qq.forward.resolvePerBatch` | 3 | 一轮最多取回几条合转（串行会拖慢轮次） |
| `qq.requests.noticeMaxItems` | 10 | 请求通知最多列几条 |
| `qq.requests.handlePerHourMax` | 10 | 处理请求的速率上限 |
| `qq.supervisor.intervalMs` | 60000 | 监督循环检查间隔 |
| `qq.contacts.listMaxItems` | 100 | 列表一次最多返回多少条 |

**每一个都被真实消费**（`defaultFor('<key>')` 出现在非测试源码里）。

---

## 6. 测试数字

| 项目 | 新增测试 | pass/fail |
| :--- | :--- | :--- |
| `packages/gateway/test/forward.test.ts` | 12 | **12 / 0** |
| `packages/gateway/test/backlog.test.ts` | 12 | **12 / 0** |
| `packages/gateway/test/requests-supervisor.test.ts` | 12 | **12 / 0** |
| `packages/gateway/test/inbound-segments.test.ts` | 7 | **7 / 0** |
| `packages/dsh-component/test/qq-tools-new.test.ts` | 21（含 7 条接线守卫） | **21 / 0** |
| **合计** | **64** | **64 / 0** |

### 接线守卫（读源码 · **去注释** · **语句位置** · **断言结果被用**）
7 条，全绿：
1. 插件里 `supervisor: { enabled: true }` 必须在 `new Gateway({…})` 里；
2. 出站消费接了 `deliverPacing`，且 `if (pacing.waitMs > 0)` **结果被用**，
   且判定在 `claimPendingOutbound` **之前**；
3. P0-3：`await transport.getForward(forwardId)` 且 `handleBatch(enriched, …)`
   —— **断言"交给轮次的是补过内容的那一批"**（用原批就等于没接）；
4. 入站 `request` 走 `recordInboundRequest`（不是塞原始 JSON）；
5. `backlogReadQuota` → `if (!quota.allowed)` → `limit: quota.granted` → `consumeBacklogRead`；
6. `read_pending` **不再**直接调 `readPending`（否则绕过额度）；
7. `wake.ts` 里**不该**出现 `pending_backlog`（纪律），但 `QQ_WAKE_CONDITIONS` 里必须有。

### 回退验证（两次数字）
**第一批（5 处注入）**：`forward.test.ts` + `backlog.test.ts` + `requests-supervisor.test.ts` + `qq-tools-new.test.ts`
* **注入 5 处缺陷 ⇒ 50 pass / 7 fail**
* **还原 ⇒ 57 pass / 0 fail**

注入的 5 处：① `resolveForwards` 不取回；② 取回了但 `handleBatch(messages)`；
③ `if (!quota.allowed)` → `if (false)`；④ `const gate = undefined`；
⑤ 积压通知多吐一行（验哨兵断言真的会红）。**7 条红覆盖全部 5 处**。

**第二批（3 处注入）**：`inbound-segments.test.ts`
* **注入 ⇒ 3 pass / 4 fail**（P0-1 占位符、P2-a 卡片 ×2、P1-3 心跳）
* **还原 ⇒ 7 pass / 0 fail**

> ⚠️ 如实记录一个过程问题：第一批 P1-3 的注入**起初没被抓住**（我的断言只验了事件、
> 没验 `status().qqOnline`），于是我**补强了断言**（`assert.equal(transport.status().qqOnline, false)`
> 与 `connected === true` 对照），重跑才变红。这正是回退验证该发现的东西。
> 另有一次运行因上一轮僵尸进程占着端口报 `EADDRINUSE` 而全红 —— 那是环境问题，已清掉并重跑。

---

## 7. 全量 `pnpm test` + `pnpm typecheck` 退出码

```
pnpm typecheck   退出码 0
pnpm test        退出码 1   （1626 tests / 1621 pass / 5 fail）
```

**5 个失败全部在 `packages/dsh-component/test/panel-render.test.ts`**（既有的那 5 个，未修）。

> 父 agent 给的基线是 `1476 / 1470 / 6`（含一个别人在修的 `wiring.test.ts`）。
> 我这次是 **1626 / 1621 / 5** —— 总数增加 150（其中我的新增 64 + 别的改动的），
> **失败数从 6 降到 5**（我中途看到的 `wake-events.test.ts`（9 vs 10）那条已经被别人修好了）。
> **⇒ 没有变多，反而少了一条。**

---

## 8. ★ "她转发一段聊天记录给机器人"时，模型**看得到内容吗**？

**能确定看得到。有端到端证据。**

证据链（`packages/gateway/test/forward.test.ts` 的
「★★★ 端到端：入站合并转发（只有 id）⇒ 网关自动取回 ⇒ **模型在提示词里看到内容**」）：

* 走**真实链路**：真 `OneBotTransport`（真 WebSocket）+ 真 SQLite + 真 `Gateway`
  （真防抖/调度/串行/队列/轮次），只有"QQ 那头的手机"和"模型那头的大脑"是假的
  （`FakeTurnDriver`）；
* "QQ 那头"回的帧**照 NapCat 实测形状**编：
  入站段是 `{type:'forward', data:{id:'fwd-alpha'}}`（**只有 id、没有 content**，
  对应线上 `parseMultMsg: false`）；`get_forward_msg` 的返回是
  `{messages:[{user_id, time, sender:{nickname}, message:[段]}]}`（**完整消息对象**，不是 node）；
* 断言落在 `FakeTurnDriver.requests[0].prompt` 上 ——
  也就是**模型真正拿到的那段文字**：
  ```js
  assert.match(request.prompt, /明天九点体检，别吃早饭/)   // ★ 转发内容真的在提示词里
  assert.match(request.prompt, /小满/)                      // 连发送者一起
  assert.ok(actions.some((a) => a.action === 'get_forward_msg' && a.params.message_id === 'fwd-alpha'))
  ```
  第二条 `get_forward_msg` 的断言很关键：它证明内容是**从协议端取回来的**，不是巧合。

另外还有两条相关的：
* **取不回时**（协议端返回空）：提示词里保留
  `[合并转发 id=…（内容未能取回，可用 qq_forward 的 read 模式按 id 重试）]`
  —— **看得见的失败**，不是空白；
* **`parseMultMsg=true` 的部署**（段里已带 `content`）：**就地摊平**，
  且断言"没有再花一次 `get_forward_msg` 往返"。

⚠️ **边界（不夸大）**：
* 我验的是**假 QQ 端 + 真网关**。**没有**用真 NapCat 发一条真合并转发跑通
  （那需要往真 QQ 号发消息，属人工验收）；
* 但"格式"这一半是**从运行中容器的 `napcat.mjs` 实读**的，不是照文档猜的；
* 每条入站最多取回 `qq.forward.resolvePerBatch`（默认 3）条合转，
  超出的保留占位符（模型可之后用工具按 id 单独取）。

---

## P0 清单（审计）—— 4 条都做了

| # | 做了什么 | 证据（测试数字） |
| :-- | :--- | :--- |
| **P0-1** | `onebot.ts` 的段循环加 `else` 分支产出 `[未解析:<type>]`。**并且不止占位符**：`json`/`xml`/`markdown` 抽标题摘要、`mface` 带名字、`onlinefile` 带文件名、`face` 有标签 | `inbound-segments.test.ts`「★★ P0-1」**通过**；回退验证第二批**注入后 4 fail 含它** |
| **P0-2** | **接通 `runReportCycle`**：`Gateway.supervise()` 用 `collectReportable` + `markReported`，**在插件里以 `supervisor: { enabled: true }` 打开**。投递走 `runner.runDirect`（独立系统轮次）。**先投递成功、再标记已报告**（投递失败不丢事件） | `requests-supervisor.test.ts`「★★★ 端到端：入站 request 事件 ⇒ 真的通知到模型」**通过**（改前它是静默丢的）；「没东西可报时不开轮次」也通过 |
| **P0-3** | 解析 `forward` 段的 `data.id` → 网关在 `pumpScheduler` 里（**真正要用之前**）调 `get_forward_msg` 取回，替换占位符，**并回填 `qq_inbox.text`**（这样"被跳过 ⇒ 进待读池"那条路看到的也是内容） | `forward.test.ts` 12/12；回退验证第一批**注入后 7 fail 含端到端那条** |
| **P0-4** | 解析 `reply` 段的 `data.id` → `InboundMessage.replyToMessageId` | `inbound-segments.test.ts`「★★ P0-4」**通过** |

> ⚠️ **P0-2 的一个诚实说明**：报告链现在通了，但 `reports.ts` 的 `describeKind`
> 对 `qq_event:*` 只是原样打 kind（我没有去美化它，因为请求那类已经有专门的
> `renderRequestNotice` 措辞）。其余事件（撤回/被踢/群文件…）会以
> `[时间] qq_event:group_upload｜system｜全局｜<原始 JSON>` 的形式出现在提示词里 ——
> **能到达，但可读性一般**。这是"先接通、后美化"的取舍。

### 三条"文档承诺 ≠ 代码事实"（在我文件里的）
1. **`qq_reply` 描述里的 `typing: true` 已删掉**，改成如实说明
   "目前拿不到对方是否在打字（协议端会上报，但适配器还没解析）"。
   —— ⚠️ 但我在 P1-4 里**把 `input_status` 解析出来了**，所以现在可以再接一步：
   把 typing 状态落到 `pending_messages` 或工具返回里。**这一步没做**（见第 9 节）。
2. **"必须先 `read_pending`"仍然只是描述、没有代码强制** —— 与用户"强制"的要求不同，
   我按第 4(b) 节选的强度落地（通知 + 硬措辞），**没有**在 `qq_reply` 里加硬阻塞。
3. **`research/ncapcat-capability-gaps.md:11` 的"已用 21 个 action"确实失真** ——
   我做完之后 `get_forward_msg` / `set_friend_add_request` / `set_group_add_request` /
   `get_friend_list` / `get_group_list` / `get_group_member_list` 这 6 个**真用上了**；
   文档本身**没改**（不归我，父 agent 说另有人管）。

---

## 任务③ 单独一节

### 1–5 各做了什么
| # | 内容 | 状态 |
| :-- | :--- | :--- |
| 1 | 接受/拒绝好友邀请 `set_friend_add_request` | ✅ 工具 `qq_handle_request(kind:'friend')` |
| 2 | 接受/拒绝群邀请 `set_group_add_request` | ✅ 同上 `kind:'group'` |
| 3 | 查看好友列表 `get_friend_list` | ✅ `qq_contacts(kind:'friends')` |
| 4 | 查看群列表 `get_group_list` | ✅ `qq_contacts(kind:'groups')` |
| 5 | 群成员列表 `get_group_member_list` | ✅ `qq_contacts(kind:'members', group_id)` |

三个工具都通过 **probe 接缝**（`kind='probe'` 的出站行 + `forlife_state` 回传结果）跨进程
拿到数据，**没有另起一套发送链路**；`PROBE_ACTIONS` 是**白名单**，测过"危险动作借不了这条路"
（用 `send_packet` 试，被 `failOutbound` 拒绝）。

### NapCat 实际支持哪些
**全部 5 个都在**（`ActionName` 枚举 + 各自的 action 类 + schema 都在 `napcat.mjs` 里，
见第 1.4 节）。另外发现两个"查待处理请求"的 action：`get_doubt_friends_add_request`、
`get_group_system_msg`（**我没用** —— 我们从事件里落库更可靠，见下）。

### (a) 入站请求事件会不会**静默丢**？—— **会，而且比"没收到"更隐蔽**
三段链路都是通的，只差最后一厘米：
1. NapCat **确实上报** `request` 事件（`UEe`/`ym` 两个类）；
2. 我们的 `OneBotTransport.normalizeEvent` **确实收到并归一化**了；
3. `Gateway.onEvent` 对非消息事件只做 `recordNonMessageEvent(event)` → 往 `effects` 写一行 → **return**。
   **不入队、不唤醒、不通知**；
4. 而"把未报告的 `effects` 交给模型"的链（`reports.ts` 的 `runReportCycle`）
   **在生产里零调用**（只有 `reports.test.ts` 调它）。

⇒ **净效果：别人加你，你永远不会知道**（除非人工去翻 `effects` 表）。

**现在修好了**：`recordInboundRequest` 结构化落库（`flag` 可查、幂等） + P0-2 接通报告 +
`supervise()` 把它渲染成 `renderRequestNotice` 送给模型。端到端测试证明**到得了**。

### (b) 谁决定接受/拒绝 → **给模型工具，它自己判断**；默认策略 = **不自动接受**
* `qq_handle_request` 存在、模型可调；
* 工具描述里**写清风险**（"同意好友 = 对方从此能直接给你发消息、也会看到你的动态与在线状态"、
  "陌生人、附言像广告的默认应该拒绝"、"拿不准就先不处理 —— 留着比乱加好"）；
* **没有任何自动接受路径**：不处理就一直是"待处理"，下次监督轮次还会（按事件）提醒一次；
* 处理**必须留痕**（`kind='qq_request_handled'` 的 effects 行，记 approve/reason/actor）。

### (c) "待处理请求"的查询能力 → **有**，`qq_requests`
与 (a) 的通知配套（通知是按事件触发，`qq_requests` 是随时可查的状态视图）。
返回里**必须带 `flag`** —— 那是处理时唯一能用的凭据（NapCat 里它是 `reqTime` / 通知 `seq`，
除了上报没有任何其它来源）。

### ⚠️ 与任务② (d) 的一致性
"接受请求"确实也是**发送类动作**（会触发 QQ 侧动作），所以**纳入了限流**：
用**独立的** `qq.requests.handlePerHourMax`（默认 10）。
为什么不共用发消息的额度：处理请求与发消息是两件事，
拿发消息的额度挡它会导致"好友申请积压时连话都不能回"。

---

## 9. P1 / P2 / P3 —— 做了哪些、**没做哪些**（不含糊）

### P1
| # | 内容 | 状态 |
| :-- | :--- | :--- |
| P1-1 | `image.url` → `VisionBridge` | ❌ **没做**。理由见下 |
| P1-2 | `record`（语音）→ `fetch_ptt_text` | ❌ **没做** |
| P1-3 | `heartbeat.status` + `bot_offline` 存活判据 | ✅ **做了**（`onebot.ts`）：心跳 `status.online === false` ⇒ 产出 `bot_offline` 事件；`TransportStatus` 新增 `qqOnline`，与 `connected` **分开**（实测事故形态正是 `connected:true` + 离线）。测试见 `inbound-segments.test.ts`，回退验证第二批含它 |
| P1-4 | notice 补 `input_status`/`group_ban`/`group_upload`/`group_msg_emoji_like` | ✅ **做了**（`transport.ts` 加 4 类 `InboundEvent` + `onebot.ts` 4 个分支）。`group_upload` 连 `fileId` 一起留下（P2-b 要用） |

**P1-1 为什么没做**：它不是我"加几行"能做完的 —— 需要（i）在插件里**实例化** `VisionBridge`
并把它的能力注入工具层/入站路径、（ii）决定"什么图该看"（每条都调视觉模型会把成本打爆）、
（iii）图片缓存与失败降级。这是一个独立的设计题，硬塞进本轮风险大于收益。
**建议单独派一个改动**，并明确"按什么条件触发视觉"。

**P1-2 没做的理由**：`fetch_ptt_text` 属**只读查询**，加进 `PROBE_ACTIONS` 白名单即可（约 10 行），
但我没有验证过它的返回形状与失败模式；本轮宁可**明确不做**，也不塞一个没验过的 action。

### P2
| # | 内容 | 状态 |
| :-- | :--- | :--- |
| P2-a | 真解析 `mface`/`json`/`xml`/`markdown`/`onlinefile` | ✅ **做了**（`extractCardText` + 4 个分支；只抽标题/摘要/正文并截断，不倒整段 JSON） |
| P2-b | `file_id` → `get_file` | ⚠️ **一半**：`fileId`/`fileName`/`fileSize` 已经落进事件（可用），但**没有真的去调 `get_file`**（同样属"没验过返回形状"） |
| P2-c | `sender.role` / `group_name` 入库（`qq_sessions.title` 现在是 NULL） | ❌ **没做** |
| P2-d | 出站补齐：`image`/`file`/`delete` 零入队点 | ❌ **没做** |

**P2-d 的说明**：我**没有删死代码**（`deleteMessage` 仍在，只是没有工具入口），
也没有新增 `qq_send_image` / `qq_send_file` / `qq_recall` 三个工具 —— 本轮预算用在了
①②③ + P0 上。**这是明确的缺口**：我们目前**发不出图片、发不出文件、撤回不了消息**。
建议下一轮补三个工具（都走既有 outbox，`kind` 已经支持 `image`/`file`/`delete`，
所以**基础设施是现成的**，只是没有入队点）。

### P3
| # | 内容 | 状态 |
| :-- | :--- | :--- |
| P3 | `message_sent` 二选一 | ⚠️ **没删也没开**。现状：`normalizeEvent` 支持它，但线上 `onebot11_<uin>.json` 里 `reportSelfMessage: false` ⇒ 它**收不到**，所以那条路是死的。**没删**的理由：它是一条**配置**就能打开的能力（多端一致性的正确来源），删掉反而丢了一条现成路径。**如实记在这里**。 |

---

## 10. 不确定 / 已知取舍（不假装）

1. **没有用真 NapCat 真发一条合并转发做人工验收** —— 证据是"假 QQ 端（照实测形状）+ 真网关"。
   格式那一半是从运行容器实读的。
2. **`pending_backlog` 没进 `wake.ts` 的 `WAKE_CONDITIONS`**（那个文件本轮归别人）。
   行为上完全一致（用同一张 `wake_rules` 表 + 完整 `decideWake` 判定 + `wake_events` 留痕），
   差别只有两点：
   * `listWakeRules()` 不会自动列出它 → 我在 `list_wake_rules` 工具里**手动追加**了它；
   * `setWakeRule` 内部对未知条件有一套硬编码兜底 → 我在 `set_wake_rule` 里**先播种再改**
     （有测试钉住"最小间隔不被覆盖成 0"）。
   **等 `wake.ts` 腾出来后应该**：把 `pending_backlog` 加进 `WAKE_CONDITIONS`、
   删掉 `backlog.ts` 里的 `seedBacklogWakeRule`/`listBacklogWakeRule`、
   把 `QQ_WAKE_CONDITIONS` 退回成 `[...WAKE_CONDITIONS]`。
3. **`readBacklog` 与 `wake.ts` 的 `readPending` 是两份"标记已读"实现** ——
   明知故犯（不能动别人的文件）。`backlog.test.ts` 里有测试钉住两者的可观测行为一致。
   腾出来之后应并回一处。
4. **积压通知没有出现在"回复别人"那一轮的提示词里**（只能通过唤醒提示 + 系统监督轮次），
   原因同 2。补法：`turns.ts` 的 `buildTurnPrompt` 加一个 `pendingNotice?: string` option。
5. **`resolveForwards` 的取回次数上限**（`qq.forward.resolvePerBatch` = 3）是猜的值：
   我没实测过 N 条合转串行取回要多久。真机上如果发现拖慢轮次，应往下调。
6. **`deliverPacing` 用 `qq_outbox.confirmed_at` 的最大值**当作"上一条真正发出去的时间"。
   如果 `system` 来源的动作（如状态同步）也走这张表，节拍会被它们占用 —— 未实测。
7. **`extractCardText` 的字段优先级**（title > desc > summary > text > content）是按
   "哪种更像给人看的"猜的，没对真实卡片做过统计。
8. **`probe` 的结果放在 `forlife_state`**，键用完即清。如果工具进程在"写入后、读取前"崩了，
   会留一个空键（`''`），`readProbeResult` 把它当"还没写"处理 —— 不会出错，但会留垃圾行。
9. **本报告里的"基线 1476/6"来自父 agent**；我实际跑的是 1626/5 ——
   两者差 150 条测试（我的 64 + 其它改动的），失败数**少了 1**。
