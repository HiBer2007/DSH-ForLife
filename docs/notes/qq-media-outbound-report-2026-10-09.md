# 入站媒体（图片/语音/文件）+ 出站补齐（图片/文件/撤回）+ 心跳存活 —— 交付报告（2026-10-09 第二轮）

范围：审计里**上一轮明确没做**的全部条目（P1-1 / P1-2 / P2-b / P2-c / P2-d / P3 / §10 九条），
外加另一位代理（唤醒条件）点名要的 4 条接口（心跳 / bot_offline / input_status / 消息 id 精度）。

**一句话**：`VisionBridge` 从"写好了零调用"变成**真实路径上的一环**；
入站媒体在**交给模型之前**变成文字（失败一律留**带原因的占位符**）；
出站补齐三个工具（图片/文件/撤回，**共用同一套限流**）；
心跳**第一次**真的喂给了存活判据。

---

## 1. ★ P1-1 的前置验证：`image.url` 到底能不能拿到

### 1.1 结论（先给结论）

| 问题 | 结论 |
| :--- | :--- |
| 容器可达？ | ✅ `docker exec forlife-qq-1 …` 正常；镜像 `mlikiowa/napcat-docker:latest` |
| 线上配置（实读 `onebot11_3112546448.json`） | `enableLocalFile2Url:false`、`parseMultMsg:false`、`reportSelfMessage:false`、`messagePostFormat:"array"`、WS 目标 `ws://host.docker.internal:3010/` |
| **真机观测到真实图片事件？** | ❌ **做不到** —— **QQ 账号处于登出状态**（见 1.2） |
| **源码级能否确定 url 非空？** | ✅ **能，而且审计 §六 的猜测不成立**（见 1.3） |
| ⇒ P1-1 该不该做？ | **该做**（真风险不是"空串"，而是"**URL 会过期/rkey 失效**"）。已按此设计，并留了登录后一条命令补齐真机验证的工具 |

### 1.2 为什么真机那一半做不到（**这是本轮最重要的环境事实**）

```
$ node packages/gateway/scripts/napcat-probe.mjs status
登录状态： {"isLogin":false,"isOffline":false,"loginPhase":"waiting_qrcode","coreReady":false,
          "qrcodeurl":"https://txz.qq.com/p?k=…"}
OneBot 上下文： 不可用 —— {"code":-1,"message":"OneBot 未初始化"}
```

* NapCat 停在**扫码登录页** ⇒ `getOneBotContext()` 为 null ⇒ **没有事件、没有历史消息、没有语音/文件可查**；
* 本机 `.runtime/dsh/forlife/db/forlife.sqlite` 的 `qq_inbox` **0 行**；2026-10-07 的备份库也是 **0 行**；
  docker 卷 `forlife_dsh-home` / `forlife_forlife-data` 里**没有任何 sqlite**（实测 `docker run --entrypoint sh` 挂卷列目录）；
* `host.docker.internal:3010` 现在被 **Firefox**（PID 32496，`-os-autostart`）占着 ——
  也就是说**当前这台机器上没有网关在收事件**，NapCat 一直在连一个非网关进程（它不报错，只是静默重连）。

⇒ 所以"真机跑一条图片消息"这条路本轮**物理上不存在**（需要人扫码）。
我没有假装验证过 —— 下面的结论**全部标注了证据级别**。

### 1.3 源码级验证（实读运行中容器的 `/app/napcat/napcat.mjs`，4.18.33 推定）

入站链路（逐行读出来的）：

1. `handleMsg` → `parseMessageV2(e, this.configLoader.configData.parseMultMsg)` —— **只传 2 个参数**；
2. `parseMessageV2(e, n = true, r = false, i = false)` —— 第三个参数 `r` 就是 **`disableGetUrl`**，默认 **false**；
3. `parseMessageSegments(e, n, r, i)` 把它透传给转换器；
4. `picElement` 转换器（`:73109`）原文：
   `url: i ? (e.filePath ?? "") : await this.core.apis.FileApi.getImageUrl(e)`
   ⇒ 线上走的是**第二个分支**（CDN 直链），**与 `enableLocalFile2Url` 无关**；
5. `getImageUrl(e)`（`:9505`）两条路：
   * `originImageUrl` 带 `appid` 1406/1407 + `fileid` ⇒ 拼 **rkey 下载链**（`multimedia.nt.qq.com.cn` / `gchat.qpic.cn`，**会过期**）；
   * 否则 `getImageUrlFromMd5(e.md5HexStr)` ⇒ `${Qy}/gchatpic_new/0/0-0-<MD5大写>/0`（`Qy = https://gchat.qpic.cn`）；
6. **只有 md5 与 originImageUrl 同时为空才返回空串**，且那时会打一条 debug 日志 `图片url获取失败`。

`enableLocalFile2Url` 在整份 bundle 里的引用**只有三处**（`:75818/:75834/:75850`），
全部在 **`get_file` 的 `base64` 分支**里 —— 与入站解析无关。

⇒ **审计 §5-b 的担心（"`enableLocalFile2Url:false` ⇒ url 空"）不成立**；
但 §5-c 的担心是对的：**rkey 链会过期**，所以"拿得到 url"不等于"取得到图"。

### 1.4 登录之后怎么 5 分钟补齐真机验证

```bash
node packages/gateway/scripts/napcat-probe.mjs status                      # ① 先扫码登录，再确认 isLogin=true
node packages/gateway/scripts/napcat-probe.mjs redirect ws://host.docker.internal:3099/   # ② 备份配置 + 热重载指向探针
node packages/gateway/scripts/napcat-probe.mjs media --port 3099           # ③ 一次跑完三件事
node packages/gateway/scripts/napcat-probe.mjs restore                     # ④ 还原（脚本会逐字节比对）
```

* 探针**只调只读 action**：`get_login_info` / `nc_get_packet_status` / `get_group_list` /
  `get_friend_list` / `get_group_msg_history` / `get_friend_msg_history` / `fetch_ptt_text` / `get_file`；
* `redirect` 用的是 WebUI 的 `/api/OB11Config/SetConfig` —— 实读源码确认它走
  `onOB11ConfigChanged → save() + reloadNetwork()`，**热重载、不用重启容器**（QQ 不掉线）；
* 端口默认 **3099**（不是 3010：3010 被 Firefox 占着，而 NapCat 连不上时**不报错**）。

---

## 2. 逐项交付（①–⑦）

### ① P1-1：`image.url` → `VisionBridge` —— ✅ 做了

**1) 把 `VisionBridge` 搬到 `packages/gateway/src/vision-bridge.ts`（旧路径保留再导出）**

理由（这是本轮最关键的结构判断）：图片描述真正该发生的时机是
"**入站事件刚到、还没交给模型**"，而那一步在**网关进程**里；
而依赖方向是 `dsh-component → gateway` ⇒ 网关**不可能** import DSH 组件。
它原来待在 dsh-component 的直接后果就是**全仓零调用**（只有自己的测试）。

* 构造参数从 `MemoryRuntime` 收窄成 `{ readonly db }`（结构类型 ⇒ 老调用点不用改）；
* `packages/dsh-component/src/vision-bridge.ts` 变成**再导出**（旧导入与既有测试一行不改）；
* 守卫测试断言"**只有一份实现**"（旧路径里不许出现 `class VisionBridge`）。

**2) 真实路径（位置就是它该在的位置）**

```
gateway.pumpScheduler（真正要用之前）
  ├─ resolveForwards(messages)      … 上一轮的 P0-3（合转展开）
  ├─ resolveMedia(enriched)         … ★ 本轮：图片/语音/文件
  └─ runner.handleBatch(withMedia)  … 交给轮次的**是补过内容的那一批**（守卫断言）
```

失败**绝不吞整批**：`resolveMediaBatch` 自称永不抛，`Gateway.resolveMedia` 外面**再包一层 try**
（这条链抛出去等于把用户的消息一起丢掉）。取回后的文本**同时回填 `qq_inbox.text`**
（面板、复盘、以及"没唤醒 ⇒ 进待读池"那条路读的都是它）。

**3) ★ 判断类问题（我拿的主意 + 理由）**

**(a) 什么图该看** —— 便宜的预筛，**顺序即优先级**（每一步都不花钱）：

| 序 | 判据 | 为什么 |
| :-- | :--- | :--- |
| 1 | `qq.image.enabled` 总开关 | 关掉 = 回到旧行为，但**占位符仍在** |
| 2 | URL 必须 `http(s)` | 协议端可能给**它自己容器里的本地路径**（`enableLocalFile2Url` 打开时），我们取不到，硬试只白等一次超时 |
| 3 | `sub_type === 1` 或 `summary` 含「动画表情」 | ★ **协议端免费给的**判据（比按大小猜准得多）——表情包不是内容 |
| 4 | 群里**没 @ 我**就不看 | 大群刷图是成本主要来源；私聊/临时会话的图 = 对方专门发给你 |
| 5 | 声明大小上限 / 下限 | 超大喂不进模型；过小多半是图标/二维码（**⚠️ 阈值 4096B 是猜的**，写在基线里可调） |
| 6 | 每批数量 `resolvePerBatch=2` + 总时间预算 `budgetMs=20000` | 串行下载+视觉会把这一轮拖到超时 |

**(b) 看不成的降级** —— **全部是"看得见的占位符"，一个空白都没有**：

| 情况 | 模型看到 |
| :--- | :--- |
| 预筛跳过 | `[图片（未看：群里的图，而这条没有 @ 我（大群里刷图不该花视觉调用））]` |
| 下载失败 | `[图片（没能取回：HTTP 404）]` |
| 取回来的不是图 | `[图片（取回的不是图片：sha256:…）]` |
| 没配视觉模型 | `[图片未能描述：没有可用的视觉模型（…）；附件 sha256:…]`（桥接原文） |
| 视觉调用失败 | `[图片未能描述：视觉调用失败；附件 sha256:…]` |
| 时间/数量预算用尽 | `[图片（未看：本批时间预算用完了（基线 qq.image.budgetMs））]` |

**(c) 缓存策略** —— **内容寻址**（先下载再算 `sha256:`，落盘 `<root>/inbound/<hex>`）：

* 同一张图（哪怕被转发、哪怕换了 URL）**第二次 0 次视觉调用**（`VisionBridge` 的验收项，测试钉住）；
* ★ **URL 会不会过期？会**（rkey 链）。但缓存键**不是 URL 而是内容哈希** ⇒
  **过期只影响"第一次下载"，不影响已经看过的图**；下载失败就是一条明确的失败路径。
* 顺带：图片字节**不进长期记忆**（没走 `saveMediaAsset` —— 那个会写长期记忆条目；
  桥接的 `canEnterMidMemory()` 恒 false 就是这条纪律）。

**4) 装配**：新增 `createVisionFromEnv()`（`vision-wiring.ts`），
**生产（`runtime.ts`）与开发（`gateway-plugin.ts`）两条路径共用同一份**，
环境变量沿用表情视觉那一套（`FORLIFE_VISION_MODEL` / `FORLIFE_VISION_BASE_URL` /
`FORLIFE_VISION_KEY` 或 `FORLIFE_OPENCODE_GO_KEY` / `FORLIFE_VISION_SESSION`）。
没配 ⇒ 启动日志**明说"未启用"**（`[gateway] 视觉桥接未启用…`）——"为什么她发的截图看不见"必须一行日志能回答。

### ② P1-2：`record` → `fetch_ptt_text` —— ✅ 做了（**形状与失败模式已验**）

**真机源码实测**（`FetchPttText`，`napcat.mjs:74213 / 80622`）：

| 项 | 实测结果 |
| :--- | :--- |
| 入参 | `{ message_id: Number\|String }` —— **只要消息 id**，必填（`参数message_id不能为空`） |
| 返回 | `{ text: String }`（`returnSchema` 里**必填**） |
| 失败模式（**全是明确报错**） | `消息不存在`（短 id 查不到）/ `消息不存在或已被撤回` / `消息中不包含语音`（元素不是 PTT）/ `获取语音转文字结果失败: PromiseTimer…`（转写超时）/ `获取语音转文字结果失败`（转写完但 `pttElement.text` 还是空） |
| 依赖 `record.data.url`？ | **不依赖**（它按消息 id 取元素）—— 这正是它比"下载语音喂语音模型"划算的理由（审计 §5-c：那个 url 要 packet 后端健康） |

实现：`QqTransport.fetchPttText()` + 入站 `mediaKind='record'` 时置 `hasVoice`；
`media-resolve` 里转写成功 ⇒ `[语音转写]正文`；失败 ⇒ `[语音（转写失败：原因）]`。
**额外加了一条**：协议端回**空串也算失败**（否则模型会看到 `[语音转写]` 后面什么都没有 —— 正是本项目反复栽的"静默空白"）。

### ③ P2-b：`get_file` 真调用 —— ✅ 做了（并把真实形状的坑写进了文本）

实测（`GetFile._handle`，`napcat.mjs:75796`）：

* 入参 `{ file?: String, file_id?: String }`，内部 `e.file ||= e.file_id || ""`；
* `file` 命中**内部令牌表**（`Xt.decode`，**是个有上限的 LRU** ⇒ 老消息可能已经不在表里）
  → 否则按 `modelId` → 否则按**文件名搜索**（`searchForFile`）；三条都不中 ⇒ `file not found`；
* 返回 `{ file: 协议端容器内本地路径, url: (只有图片类才是 http(s)，其它就是那个本地路径), file_size, file_name }`；
* ⚠️ **它会真的让协议端去下载**（`downloadMedia` / `downloadFileById`）。

实现：入站 `file` 段 → `getFileInfo()` → 文本变成
`[文件：报告.pdf（51KB，内容在协议端本地（我们读不到内容，只能看到名字与大小））]`；
**大文件不自动取**（`qq.file.fetchMaxBytes=1MiB`），只用名字与大小如实写一行。

### ④ P2-c：`sender.role` / `group_name` 入库 —— ✅ 做了

`onebot.ts` 现在取 `sender.role`（群消息才有）与 `group_name`；`InboundMessage` 加这两个字段；
`persistInbound` 写 `qq_sessions.title`。

**★ `title` 填什么（我的选择与理由）**：

* **群会话 ⇒ 群名**。理由：title 是"这个会话叫什么"，而群里每条消息的发送人不同 ——
  把**说话人**写进群会话标题会让它随最后说话的人来回跳（那是 bug 不是功能）；群名唯一且稳定。
* **私聊/临时 ⇒ 对方的名字**（`card` 优先、回退 `nickname`）。理由：私聊的 title 回答的是"我在跟谁说话"。
* 取不到 ⇒ `NULL`，并用 `COALESCE(excluded.title, qq_sessions.title)`
  —— **不许用 NULL 把已经攒下来的标题擦掉**（入站事件里 `group_name` 时有时无）。有测试钉住。

⚠️ 诚实说明：`senderRole` 已经归一化到入站消息上，但**提示词侧用不到**
（那要改 `turns.ts` 的 `buildTurnPrompt`，本轮**禁动**）⇒ 见 §6 遗留项。

### ⑤ P2-d：出站补齐（图片 / 文件 / 撤回）—— ✅ 做了

三个工具（名字直观、参数含义写清，方便提示词那位引用）：

| 工具 | 参数 | 入队 | 协议端动作 |
| :--- | :--- | :--- | :--- |
| `qq_send_image` | `conversation`(必填) / `file`(URL·base64·协议端本地路径) / `summary?` | `kind:'image'` | `send_*_msg` 的 `image` 段 |
| `qq_send_file` | `conversation`(必填) / `file` / `name?` | `kind:'file'` | `send_*_msg` 的 `file` 段（群聊会作为群文件上传） |
| `qq_recall` | `message_id`(必填) / `conversation?`（**只记账**） | `kind:'delete'` | `delete_msg` |

**★ 撤回：接上，不删。** 理由：
① "发错话却收不回来"是真实会发生的事故，而 QQ 侧本来就有这个能力，
我们自己把它锁死在代码里没有任何收益；② 死代码留着会让下一个读代码的人以为"这个功能已经有了"。
`conversation` 可选（与 `qq_reply` 的硬要求不同）：`qq_reply` 必填是因为**目标不可推断**；
撤回的目标是**消息 id**，它本身就唯一确定了那条消息，再强制抄一遍只会制造"参数看着对、行为按 id 走"的错觉。

**验证了 NapCat 出站真的支持 `file` 段**（不是照 OneBot 文档猜）：
`ob11ToRawConverters` 里有 `[ze.file]` 分支 ⇒ `handleOb11FileLikeMessage` → `createValidSendFileElement`。
图片/文件的 `file` 允许 **URL / base64 / 协议端本地路径**（`isLocal` 由它判），
工具描述里**推荐 URL**（本地路径是**协议端容器里**的，工具进程写的文件它看不到）。

**⚠️ 不绕过限流**：三个工具的 `sendGate()` 调用点都在 `enqueueOutbound()` **之前**，
守卫测试逐工具断言"闸门在入队之前"+"结果被用"；被拦时**队列里不多一行**（行为测试钉住）。

### ⑥ P3：`message_sent` —— 建议**开**（且已先修好开它的副作用）；**但本轮无法实测**

**决定**：**开**（保留代码路径 + 建议开启），**不删**。

**理由（源码级证据 + 我们的现状）**：

1. 门在 `napcat.mjs:81455`（原文）：
   `if (r && (!("reportSelfMessage" in s) || !s.reportSelfMessage)) continue;`（`r = isSelfMessage`）
   ⇒ 配置为 false 时**该事件一个适配器都不发给**（`i.size === 0` ⇒ 静默丢弃）；
2. 它是"**主人用手机/别的客户端发的消息**"的**唯一**来源（多端一致性的正确来源），
   删掉就等于把这条路永久锁死，而打开它只是**一行配置**；
3. ⚠️ **但直接打开有一个真实的副作用**：它会把**我们自己通过工具发的**消息也回执回来
   ⇒ 每条回复多写两行（`qq_inbox` + `effects`），而 `effects` 会进"影响报告"周期
   ⇒ **模型每轮都读到"我刚说过什么"**（它自己刚做的事），把真正要它知道的挤掉。

⇒ 所以我**先把这个副作用修好了**：`recordSelfMessage` 现在先查
`qq_outbox.platform_msg_id`（**只有我们确认发出去的那些**）——
命中就**不重复入库**（日志一行）；没命中（= 主人在别处发的）才写多端一致性记录。有端到端测试钉住两条路径。

**实测为什么没做**：`/api/OB11Config/SetConfig` 要求 `getQQLoginStatus()` 为真
（源码：`if (!pe.getQQLoginStatus()) return ne(e, "Not Login")`）——
而账号现在**登出**，改不了；就算改了，登出状态下也**收不到任何事件去观察**。
⇒ **不能强开，也不能假称测过**。

**登录后的安全步骤（可回退，无需重启容器）**：

```bash
# ① 备份配置（宿主机留一份，脚本已做一份）
docker exec forlife-qq-1 cat /app/napcat/config/onebot11_3112546448.json > onebot11_3112546448.json.backup
# ② 用 WebUI 打开开关（走 SetConfig ⇒ 热重载，不需要重启容器）
#    config.network.websocketClients[0].reportSelfMessage = true
# ③ 观察：qq_inbox 是否只多出"外部发送"的行；effects 里 self_message 的数量
# ④ 回退：把 reportSelfMessage 改回 false（或 restore 备份）
```

**判据（我认为该开成 true）**：如果 ③ 里发现**只有外部发送**进来（去重生效），就保持开启；
如果发现协议端**不返回 message_id**（去重失效、噪声无法收敛），就**关回去**并在报告里记一笔。

### ⑦ §10 的 9 条 —— 逐条判定

| # | 上一轮的"不确定" | 本轮判定 | 说明 |
| :-- | :--- | :--- | :--- |
| 1 | 没有真机验收合并转发 | ❌ **仍做不到**（且更清楚了） | QQ 账号登出 ⇒ 连"真机跑一条"的前提都没有。已交付探针脚本，登录后一条命令补齐 |
| 2 | `pending_backlog` 没进 `WAKE_CONDITIONS` | ⛔ **没做（撞禁令）** | `wake.ts` 本轮禁动（且它属于另一个改动）。行为不变，仍靠 `seedBacklogWakeRule` + 工具面手动追加 |
| 3 | `readBacklog` / `readPending` 两份"标记已读" | ⛔ **没做（同因）** | 合并要动 `wake.ts` 的 `readPending` |
| 4 | 积压通知没进 `buildTurnPrompt` | ⛔ **没做（同因）** | 要动 `turns.ts`（禁动）。现在仍是"唤醒提示 + 系统监督轮次"两条 |
| 5 | `resolveForwards` 的取回上限（3）是猜的 | ⚠️ **仍是猜的** | 无真实流量可测（见 1.2）。保持并标注 |
| 6 | `deliverPacing` 用 `max(confirmed_at)`，system 来源会占节拍 | ✅ **修了** | 新增 `NON_SENDING_OUTBOUND_KINDS = ['probe']`：**只读查询不占发送额度、也不占投递节拍**（判据是"这一行会不会在对方聊天窗口里产生东西"）。两处 SQL 都改了，守卫断言**两处**都剔除 |
| 7 | `extractCardText` 字段优先级是猜的 | ⚠️ **仍是猜的** | 同上，需要真实卡片流量才能统计 |
| 8 | `probe` 结果键留空串（垃圾行） | ✅ **修了** | `store` 新增 `deleteState()`；`clearProbeResult` 改成**真的删行**（不再写 `''`），守卫禁止回退到写空串 |
| 9 | 基线数字来自父 agent，与实测差 150 | ✅ **本轮重测** | 见 §4（1699/1694/5） |

---

## 2'. 另一位代理点名要的 4 条接口（**都在我的文件里**）

| # | 内容 | 状态 |
| :-- | :--- | :--- |
| 1 | **心跳喂存活判据** | ✅ **做了**（`onHeartbeat` 观察者 → `wake.livenessMonitor?.observeHeartbeat`），`intervalMs` **取自心跳帧的 `interval`** |
| 2 | `notice_type: bot_offline` 归一 | ✅ **做了**（新增 `onBotOffline` 观察者 + 产出 `{type:'bot_offline'}` 事件） |
| 3 | `input_status` → typing（兑现 `qq-tools` 的承诺） | 🟡 **做了一半**（见下） |
| 8 | `Number(messageId)` 安全整数断言 | ✅ **做了**（抽成 `safeMessageId()`，`deleteMessage` 与 `sendReaction` **都**用它；不安全就报错不截断） |

**关于第 1 条，两个刻意的设计决定**：

* **心跳不落库**：30 秒一条 ⇒ 落 `effects` 是 **2880 行/天**，而且会进影响报告周期。
  所以走**观察者回调**（与 `onConnectionState` 同一条路），只喂判据。
* **离线事件只在边沿产一次**：离线期间心跳仍然每 30 秒来一条，
  旧写法**每条都产一个事件**（另一种 2880 行/天）。现在 `wasOnline !== false` 才产；
  "还离线着"交给判据自己的定时 `check()`。守卫测试读源码断言这两件事。

**关于第 3 条（诚实标注"做了一半"）**：

* ✅ **做了**："对方正在输入"现在真的被记下来了（`forlife_state` 的 `qq_typing:<会话键>`，
  **自带过期时刻**，`event_type===2` 直接删键）⇒ `read_pending` 每条带 `typing: true/false`
  （`typing` **恒给**，否则"没有这个字段"和"没人在打字"分不出来）。
  为什么不用新列/新表：它是**几秒就过期**的瞬时信号，混进待办队列会让"还剩 N 条"失真。
  `qq_reply` 的描述也从"拿不到"改回"能拿到"，并**如实说明时效**（最近十几秒内有过输入事件，不是实时快照）。
* ⛔ **没做**：把它注册成 `peer_input_status` **唤醒条件的生产者** ——
  那要动 `wake.ts` 的 `WAKE_CONDITION_PRODUCERS`（禁动）或 `turns.ts` 的 `defaultConditionOf`（禁动）。
  ⇒ 缺口清单仍是 4 条（`message_recalled` / `peer_input_status` / `peer_status_change` / `self_message_sent`），
  归那位在 `wake.ts` 腾出来后补登记。
* ⚠️ **一处未验证**：`event_type` 的取值含义（1=输入中 / 2=停止）**没有真机验证**（账号登出）。
  所以除 `2` 之外都按"正在输入"处理，且 TTL 一到自动失效 —— 认错也不会变成持久错误。

---

## 3. 测试数字

### 3.1 新增（全部通过）

| 文件 | 条数 | pass/fail |
| :--- | :--- | :--- |
| `packages/gateway/test/media-resolve.test.ts` | 19（含 **4 条端到端**：图片+语音 / 群里没 @ / 群名入库 / 文件真调 `get_file`） | **19 / 0** |
| `packages/gateway/test/heartbeat-liveness.test.ts` | 11（心跳取值 / 边沿 / bot_offline / 消息 id 精度 / typing 3 条 / P3 去重 / 守卫 3 条） | **11 / 0** |
| `packages/dsh-component/test/qq-tools-media.test.ts` | 12（3 个新工具行为 + 限流共用 + 7 条守卫） | **12 / 0** |
| **合计** | **42** | **42 / 0** |

改动的既有测试（不是新增，共 3 个文件）：
* `admin-chat.test.ts` / `requests-supervisor.test.ts`：假传输层补 `fetchPttText` / `getFileInfo`（接口新增，类型要求）；
* `qq-tools-new.test.ts`：上一轮的 P0-3 守卫断言 `handleBatch(enriched…)` —— 本轮媒体解析插在中间，
  变量名变成 `withMedia` ⇒ 改成断言 `resolveMedia(enriched)` + `handleBatch(withMedia…)`（**本意不变：交给轮次的必须是补过内容的那一批**）。

### 3.2 ★ 回退验证（两次数字）

对 5 个文件注入 **6 处缺陷**：

| # | 注入 | 目的 |
| :-- | :--- | :--- |
| 1 | `handleBatch(withMedia…)` → `handleBatch(enriched…)` | 媒体解析结果**没被用** |
| 2 | `hasVoice = true` → `false` | 语音不进解析 |
| 3 | `url: data['url']` → `url: ''` | 图片引用抽不出来 |
| 4 | `const gate = sendGate()` → `const gate = undefined`（5 处） | 绕过限流 |
| 5 | `observeHeartbeat(heartbeat)` → `void heartbeat` | 心跳不喂判据 |
| 6 | `deleteState(...)` → `setState(..., '')` | probe 垃圾行回归 |

* **注入 6 处 ⇒ 41 tests / 32 pass / 9 fail**（红的覆盖全部 6 处：媒体端到端 3 条、限流 1 条、守卫 5 条）
* **还原 ⇒ 41 tests / 41 pass / 0 fail**（5 个文件的 SHA-256 前缀与注入前逐一相同）

---

## 4. 全量 `pnpm test` + `pnpm typecheck`

```
pnpm typecheck   退出码 0
pnpm test        退出码 1     （1699 tests / 1694 pass / 5 fail）
```

**5 个失败全部在 `packages/dsh-component/test/panel-render.test.ts`**
（`客户端文件必须调用 window.__ModuleLoader__.load` —— 上一轮就在的既有失败，**未修、没变多**）。

> 父 agent 给的基线是 `1631 / 1617 / 14`；我实测 **1699 / 1694 / 5**
> （总数增加 = 我的 42 + 其他代理的；**失败数 5 < 14**，且那 5 条是同一批 panel-render）。

---

## 5. 有没有跟另一个代理（`42c7daf9`，唤醒条件）撞车

**没有撞车。** 证据：

* `turns.ts`（14:15）、`wake.ts`（14:06）、`timing.ts`（10-05）、`wake-liveness.ts`（14:16）
  的最后修改时间**全部早于我开工**（我的改动从 14:36 开始）⇒ 我**一行都没动**它们
  （`git diff --numstat` 里它们的改动是对方的）；
* **唯一的共享文件**是 `packages/gateway/src/index.ts`：对方 14:40 追加了 `feed-refresh` 导出，
  我 15:01 在**文件末尾追加**我这一节的导出 ⇒ 两拨导出**都在**（已 grep 验证 177/178 行与 229+ 行）；
* `packages/store/src/index.ts` 我只加了一行 `deleteState,`（追加在字母序位置）；
  `plan-baseline.json` 只**追加**键（当前 194 个，其中 12 个是我的），**没有重排、没有改写任何现有键**；
* **没有碰**：`.runtime/**`（只读了一个 sqlite 与备份库）、`deploy/**`、`packages/memory-core/**`、
  `packages/admin-ui/**`、`turns/timing/wake*.ts`。

---

## 6. 仍没做 / 做不了的（**明确列出，不含糊**）

1. **真机验收（P1-1 的图片 url、P1-2 的语音转写、P2-b 的文件信息、P3 的 `message_sent`）** ——
   前提是 **QQ 账号登录**（现在是 `waiting_qrcode`）。工具已交付：
   `packages/gateway/scripts/napcat-probe.mjs`（`status` / `redirect` / `media` / `restore`，含备份与还原校验）。
2. **`pending_backlog` 进 `WAKE_CONDITIONS`**（§10.2）—— `wake.ts` 禁动。
3. **`readBacklog` 与 `readPending` 合并**（§10.3）—— 同上。
4. **积压通知进 `buildTurnPrompt`**（§10.4）—— `turns.ts` 禁动。
5. **`peer_input_status` 注册成唤醒条件生产者**（对方点名的第 3 条的剩下半截）——
   要动 `wake.ts` / `turns.ts`，禁动；**typing 状态本身已经能用了**。
6. **`sender.role` 进提示词**（P2-c 的另一半）—— 数据已入库（`InboundMessage.senderRole` +
   `qq_sessions.title`），但要让模型"看到"某人是群主得改 `turns.ts`。
7. **`index.ts` 的 `NO_HEARTBEAT_REASON` 文案过期** —— `wake-liveness.ts` 里那句话仍写着
   "onebot.ts 目前丢弃 meta_event"（**本轮已经不丢了**）。那是对方的文件，我没动 ⇒ 请他们顺手改。
8. **`qq_get_file` 工具**（让模型按需取文件内容）—— 本轮只做了"入站自动取信息"；
   文件内容本身**读不到**（它在协议端容器里），要真读需要共享卷（`deploy/**`，禁动）。
9. **`resolveForwards` 的 3 条上限、`extractCardText` 的字段优先级** —— 仍是猜的（无真实流量）。
10. **`group_upload` / `input_status` 等通知仍会各写一行 `effects`** ——
    这是上一轮 P1-4 的行为（审计轨迹），本轮没改；如果将来发现量太大，可以照心跳那条思路
    （瞬时信号不落库）处理。

---

## 附：本轮新增/改动的文件

**新增（源码）**：
`gateway/src/vision-bridge.ts`（从 dsh-component 搬来，**唯一实现**）、
`gateway/src/vision-describer.ts`（HTTP 视觉端点 + 附件读取 + 魔数嗅探）、
`gateway/src/vision-wiring.ts`（两条装配路径共用）、
`gateway/src/media-resolve.ts`（预筛 / 下载 / 缓存 / 降级 / 预算）、
`gateway/src/typing-state.ts`（瞬时状态，自带过期）、
`gateway/scripts/napcat-probe.mjs`（真机探针）。

**新增（测试）**：`gateway/test/media-resolve.test.ts`、`gateway/test/heartbeat-liveness.test.ts`、
`dsh-component/test/qq-tools-media.test.ts`。

**改动**：`gateway.ts`（`resolveMedia` + P3 去重 + title + typing 消费）、
`onebot.ts`（图片/文件/语音引用 + `role`/`group_name` + `fetchPttText`/`getFileInfo` +
心跳观察者 + `bot_offline` + `safeMessageId`）、`transport.ts`（新类型与方法）、
`runtime.ts`（视觉装配 + 心跳/掉线喂判据）、`limits.ts`（只读查询不占额度与节拍）、
`probe.ts`（真删键）、`index.ts`（导出）、`stickers` 无改动；
`dsh-component/src/qq-tools.ts`（三个新工具 + `typing`）、`gateway-plugin.ts`（视觉装配）、
`vision-bridge.ts`（改为再导出）；`store/src/repository.ts` + `index.ts`（`deleteState`）；
`contracts/plan-baseline.json`（**只追加 12 个键**）。
