# DSH-ForLife 执行计划

> 目标：把 `PLAN.MD`（DSH 长期记忆系统设计报告）与 `模型路由.MD`（模型分级路由设计）落成一套**可移植、可容器化、可运维**的工程实现。
>
> 本文档 = **选型结论 + 目标架构 + 分阶段执行计划 + 验收标准 + 风险登记册**。它写的是**决定**与**验收标准**，不写执行过程。
> 阅读顺序建议：§0 → §1 → §2.3（映射表）→ §2.20（中介层）→ §4（阶段表）→ §7 / §8。

### 文档约定

| 项 | 约定 |
| :--- | :--- |
| 规格源（只读） | `PLAN.MD`、`模型路由.MD`：设计论证以它们为准，本文档只写工程落点与验收 |
| 参数真源 | `packages/contracts/plan-baseline.json`（代码只通过 `defaultFor('键名')` 引用，不硬编码数字）；偏离登记在 `packages/contracts/src/deviations.ts`，两者都有测试守着 |
| 过程记录 | 一次性事故进 `docs/incidents/`，仍然成立的技术结论进 `docs/notes/`，部署操作细节进 `docs/deploy/PVE_DEPLOY.md`；本计划只保留结论与约束 |
| 口吻 | 第三人称、陈述式、现在时 |

### 当前状态（已验收事实）

| 项 | 结果 |
| :--- | :--- |
| 测试 | 1263 项，0 失败 |
| 类型检查 | typecheck 0 错误 |
| 真机部署 | 已完成：PVE 虚拟机，四容器全部起来且健康（`caddy` / `dsh` / `gateway` healthy，`qq` Up） |
| 从零到可用 | ≈ 5–6 分钟（装 Docker 2 分 05 秒；冷构建 `--no-cache` 2 分 11 秒；增量部署（缓存热）3 分 14.6 秒；造冷层（loop + ext4，稀疏）0.154 秒）。验收标准为 ≤ 30 分钟 |
| 整机重启 | 通过：冷层自动挂载、四容器自愈、数据完整 |
| 记忆功能端到端 | 通过（9/9）：写入 / 中文检索 / spill 往返 / 沉降 / 冷层回读 / recover |
| 生产工具数 | 34 |

未达成或未验证的项集中在 §8.1（待人工验证）与 §8.4（待决策）。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
| :--- | :--- |
| 兼容层与形态 | dsh-std v0.15 + dsh-ecosystem-spec, 便携组件（§1.1） |
| QQ 协议端 | NapCatQQ 主选, SnowLuma 备选（§1.2） |
| 后台与边界 | gateway `/admin/*` 唯一公网入口（§2.12） |
| 部署与存储 | VM → Compose → Caddy; `node:sqlite` (Node 24, FTS5 / `loadExtension` / WAL) + LanceDB （§2.4） |
| 保真度 | 参数与时机一比一（§12.1/§12.2/§7.6 + §4.2/§6.3/§8.2）, CI 强制（§2.6） |
| 模型与推理 | 分级路由 + 子代理模型 + 回退 `agent/request` （§2.7、§2.18）; 四来源 × 四模式（§2.13）; 无 GPU (R7 430) |
| 路由中介层 | 插在「接入提供方」与「实际调用位置」之间：模型目录 + 初始路由 + 取数层；超小模型层级统一称 `minimum`（§2.20） |
| 记忆与用户面 | 媒体库入长期记忆 (`recall_longterm`/`recall_media`, §2.9); `message_sent` 3 s （§2.17.9）; 沙箱（§2.10）; 定时器（§2.14） |
| 运行时与会话 | 时区 `systemTimezone`/`conversationTimezone`/`displayTimezone`、单窗口多会话、唤醒矩阵、`source_scope`、`model`/`system`、两条铁律（§2.16–§2.18） |
| 落点与缓存 | `ctx.compaction` / `ctx.systemPrompt.section()` / `ctx.tools.register()`; `TokenUsage.cacheReadTokens / cacheWriteTokens` （§2.3） |
| 硬约束 | 不动本机 DSH; 产物在 `D:\DSH-ForLife` 内，自建 profile |


---

## 1. 选型结论

### 1.1 兼容层：dsh-std（Community v0.15）+ dsh-ecosystem-spec

#### 它是什么

社区插件互操作元协议: `T-Auto/dsh-std` （上游 `Yan-Zero/dsh-std`）、RFC #2714、契约侧 `dsh-ecosystem-spec` (`registry/` + `protocols/` + `schemas/`); npm 的 `dsh-std` 是占位包，真身在 `@dsh-std/*`。

#### 判定依据（本机只读证据）

- `...\node_modules\@deepseek-harness-tui\dsh-tui\package.json` (`package.json`) 内嵌 7 个 `@dsh-std/{command,connection,core,manifest,messages,presentation,storage}`、`dsh-ecosystem-spec\` (`registry-0.15.json`、`permissions-0.1.json`、`contracts\*`、`schemas\*`) 与 `"imports": { "#dsh-ecosystem-spec/tui-channel": ... }`。
- `lib/types/adapter/standard/{validate,negotiate,tui-extension,protocols}.js` (`adapter/standard/*`): `new ProtocolCatalog`、`new ManifestDefinitionCatalog`、`projectManifest`、`registerCommand/registerMessages/registerPresentation/registerStorage`。
- `lib/types/dsh-adapter/plugin-host.js:356 parseManifest(source)` + `component-identity.js:66` (`COMPONENT_NOT_ADMITTED: the calling activation has no verified dsh-plugin.json Component identity`); `/plugins check <path-to-dsh-plugin.json>`。
- `registry\README.md` + `registry-0.15.json`: `"profileVersion": "tui-admission/0.15"`、`std.manifestVersion: "0.15"`、`sha256:`。

> `path:line` 以 `C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 为准; `C:\Users\...\.dsh\profiles\node_modules\@deepseek-ai\` 是断链 junction farm (`dsh-agent-loop`、`dsh-storage-json`、`dsh-client-modules`、`dsh-session-query-sqlite`、`dsh-plugin-manager` 读不到)。`@deepseek-ai/dsh-* = 0.1.7-rc.2`、`cordis = 4.0.4`、Node `v24.19.0`、dsh-tui `0.11.2`。

**结论**: 兼容层 = dsh-std v0.15 + dsh-ecosystem-spec; dsh-tui 是宿主实现, `@dsh-std/adapter-dsh` 是参考中继。

#### 使用方式（关键 API）

**a)** `dsh-plugin.json` （包根）, `manifestVersion: "0.15"` (`@dsh-std/manifest` 的 `CommunityPluginManifestV015`):

```jsonc
{ manifestVersion: "0.15", id: "forlife-memory", facets: { host: { entry: "./lib/index.js", apiVersion: "lifecycle.dsh/v1alpha1" } }, requires.contracts: [ {apiVersion:"tools.dsh/v1alpha1",kind:"Tool"}, {apiVersion:"session.dsh/v1alpha1",kind:"SessionEvent"}, {apiVersion:"ui.dsh/v1alpha1",kind:"ContributionHost"} ], permissions: [storage.local.read, storage.local.write], subscriptions: [ {apiVersion:"session.dsh/v1alpha1",kind:"SessionEvent",scope:"forlife.*"} ], compat: { hosts: ["dsh-tui >=0.11", "dsh-web >=0.1.7"] } }
```

**b)** `@dsh-std/sdk`: `defineFacet(async (ctx) => …)`; `ctx.identity`/`ctx.plan`/`ctx.scope.add(dispose)`/`ctx.protocols.implement|client|agreement`; `protocol(ctx, TOOL_KEY)` → `tools.dsh`。

**c)** 契约: `tools.dsh/v1alpha1` `Tool`/`ToolOverride` (`@dsh-std/tool`; `executionOnly` 只换执行体); `session.dsh/v1alpha1` `SessionEvent` (`@dsh-std/session`; `replay: 'required' \| 'ignorable'` + `payloadSchema`); `ui.dsh/v1alpha1` `ContributionHost`/`UiContribution` (`@dsh-std/ui`; `mode: 'host-rendered' \| 'local-module'`); `messages.dsh/v1alpha1` `MessageObserver` (`@dsh-std/messages`; `PrivacyClass`/`redactions`/`truncated`/`correlationId`); `storage.dsh/v1alpha1` `LocalStorage` (`@dsh-std/storage`); `commands.dsh/v1alpha1` `Command` (`@dsh-std/command`; `/memory stats`、`/memory settle`)。

**d)** 权限默认 deny (`storage.*`、`messages.observe.read`、`session.*.intercept`), `commands.invoke` allow; `effect ledger` (`create/bind/replace/release/cleanup-failed` + `applied/pending/failed` + `valueDigest`); `evidenceLevel`: `Declared → Parsed → Negotiated → Tested → Observed → Attested`。

**e)** `@dsh-std/connection` 的 `createMemoryConnectionPair()` = 无宿主单测台（阶段 0）。

**f)** `compat.hosts` = 宿主范围; `requires.contracts[].optional/fallback` = 降级; `overrides` (`patch | native | build`); `@dsh-std/adapter-dsh` (`name = "dsh-std-adapter"`、`ctx.dshStd`、`mountProfileComponents(profileDir)`) → `tools/session/models/commands/presentation/ui`。

> **结论**: 引擎 = portable 组件 (`dsh-plugin.json` + facet); 宿主无 dsh-std 时走 legacy cordis 入口 (`@deepseek-ai/cordis` 的 `name/inject/Config/apply`)。

### 1.2 QQ 协议客户端选型

#### 结论：**主选 NapCatQQ；SnowLuma 一等备选，接口层可一键切换**

#### 对比

- **NapCatQQ**: NTQQ + Node API, OneBot v11 (WS/HTTP, 多账号); 10,839 stars / 821 forks / 18 issues; AstrBot 背书; Limited Redistribution (**禁商用**)。
- **SnowLuma**: ptrace 注入 + OIDB (`packages/bridge/src/hook-manager.ts`、`qq-hook-client.ts`); OneBot v11 + WebUI + `@snowluma/sdk` + `@snowluma/mcp`; 1,436 stars / 89 forks / 14 issues; `chore(release): v1.14.21`; 非商业许可（非 OSI）, addon 禁逆向/禁打镜像/禁自动化部署。
- **动作**: `set_input_status`、`set_msg_emoji_like`、`send_private_msg`/`send_group_msg`、`mark_*_as_read` 均支持 (SnowLuma 另有 `set_group_reaction`)。
- **容器化（决定性）**: NapCat `mlikiowa/napcat-docker:latest` (`docker run -d -p 3000:3001 -p 6099:6099 --restart=always`, `NAPCAT_UID/GID`), 无图形环境、扫码 `http://<ip>:6099/webui`, 卷 `/app/.config/QQ`+`/app/napcat/config`+`/app/napcat/plugins`, 快速登录 `NapCatWinBootMain.exe <uin>`; SnowLuma `motricseven7/snowluma:latest` (`node:22-bookworm-slim`) 需 Xvfb+VNC+noVNC (`6081`) + `--cap-add=SYS_PTRACE --security-opt seccomp=unconfined --shm-size=1g --ulimit nofile=65536:1048576`, 卷 `/app/data`+`/app/.config`+`/app/.local/share`。
- **自愈/版本**: NapCat `reconnectInterval`/`heartInterval`, 4.18.28 起静默离线自愈, 50–100 MB 内存，钉死 QQ 9.9.26-44343 （最低 40768+）; SnowLuma `set_restart` + hook 重连，与 QQ 版本强绑定。

#### 选 NapCatQQ 的理由

1. 无头纯度高：不需虚拟显示; SnowLuma 要塞桌面 QQ + noVNC + `SYS_PTRACE`、`seccomp=unconfined`。
2. 成熟度与运维面: 2.5 年迭代、10,839 stars (7.5× star 差)、反向 WS 重连 + 静默自愈 + 托盘托管 + Compose 模板；覆盖 PLAN §8.1 全部动作。

#### 与选型无关的两条硬规矩

- **不把 QQ 客户端二进制打进分发产物** （许可均非 OSI）: 只交付 compose 与配置，引用官方镜像 (`image: mlikiowa/napcat-docker:latest`)。
- **群聊无 typing 接口**: `set_input_status` 仅 C2C → `qq_typing` 群聊降级为发表情回应。

#### 翻转条件（写死）

- NapCat 钉死的 QQ 版本持续掉线而 SnowLuma 支持该构建 → 切 SnowLuma。
- 需 bot 与 QQ 侧同一套 TS 资产 (`@snowluma/sdk` / MCP) 且允许常驻带界面 QQ → 切 SnowLuma。
- 需"完全不装官方 QQ 客户端" → 评估 LLBot 或 Lagrange.Milky （均 **UNCERTAIN**）。
- 需商业使用或公开分发 → 两家许可重新评估。

#### 集成契约（均 OneBot v11）

```
transport: reverse-ws   # gateway 自开 WS 服务端; reconnectInterval 5000 / heartInterval 30000; 备选 forward-ws
endpoint:  ws://gateway:8082/onebot   # compose 内网; auth: Bearer <access_token> 或 ?access_token=
信封: {action, params, echo}; 带 echo 的帧 = 上一条 action 的响应, 不带 echo = 事件; message 段类型 reply{data.id} / text{data.text}; 同 action 可多次 = 分段
  action: send_private_msg / send_group_msg / send_msg / set_msg_emoji_like {message_id, emoji_id, set} /
    set_input_status {user_id, event_type:1} (仅 C2C) / upload_group_file / upload_private_file /
    get_login_info / get_msg / delete_msg / mark_msg_as_read
事件: message.private / message.group; notice.notify sub_type=input_status、notice.group_msg_emoji_like; meta_event.lifecycle / meta_event.heartbeat
```

#### 退路

- 传输层: `QqTransport` + `onebot11-ws` （默认） → `onebot11-http` → `snowluma-sdk` → OneBot 12; 协议端 NapCat ⇄ SnowLuma, 终极 Lagrange.Core。
- 架构：只依赖 `QqTransport` (`connect / on(event) / sendMessage / sendReaction / setTyping / recall / getLoginInfo`); 默认反向 WS (`/onebot`), 备用 `forward-ws`, access token, compose 内网。

#### 容器内已自带能力（实测）

- **FFmpeg**：官方镜像**自带**（实测 `ffmpeg 4.4.2`）⇒ **无需安装**，不进镜像构建步骤。
- **PacketBackend（「DLC」）**：**已内置**（`native/packet/MoeHoo.linux.x64.node`），日志实测 `[PacketHandler] 加载成功` / `[FFmpeg] ✓ 使用 Native Addon 适配器` ⇒ **无需额外配置**。它就是配置文件里 `packetBackend` 字段控制的**原生 hook 模块**，NapCat **v3.6.0 起内置**（Linux/macOS amd64·arm64、Windows amd64）。
- **WebUI 反代到同源**：采用**独立域名站点块**（`napcat.{$FORLIFE_HOST}` → `reverse_proxy qq:6099`），**代理在根路径** ⇒ NapCat 的绝对路径（`/webui/assets/…`、`/api/…`）天然对得上，**NapCat 侧一行不改**；面板 iframe 指 `https://napcat.<host>/webui?token=…`（§2.12、§6.3）。

> **待验证 (U7)**: Linux 容器最小运行条件（FFmpeg 与 PacketBackend 两项已由实测关闭，见上）、镜像体积与内存量级、登录态持久化路径。

### 1.3 后台设计来源：AstrBot 调研结论

形态: Vue 3.3 + Vuetify 3.7 + Pinia + vue-router(hash) + Vite 6; FastAPI + Hypercorn; 单进程单端口 6185, 产物 `data/dist`; 镜像 `soulter/astrbot:latest`; 报告 `docs/research/astrbot-admin-panel-research.md` (320 行)。

- **采纳**: 单进程单端口 + 产物内嵌; `_conf_schema.json` 驱动表单 (`secret/options/slider`); `_special` 引用宿主对象；三层配置含会话覆盖；表单 + raw JSON 两阶段提交; SSE 日志 (`LogBroker`、`Last-Event-ID`); 失败插件单列 + 就地重载；受限 iframe + postMessage + 短时 token; 静态 JSON 注册表 + `-md5.json` 旁车；占用页 + `cleanup(target)`; `POST /knowledge-bases/{id}/retrieve` → `POST /api/forlife/recall:probe`。
- **规避**: 双轨鉴权 (`/api/*` JWT、`/api/v1/*` 跳过); `secret:true` 遮罩; JWT 入 localStorage; 巨型单文件 (79KB/80KB/160KB)。
- **空白位**: 压缩零可观测、`LongTermMemory.vue` 下线、无会话队列监控 → 三块一级页面（压缩日志/记忆条目/会话队列）。

---

## 2. 目标架构

### 2.1 组件与进程边界

- **Caddy**（VM 容器）: `:443` TLS 入口; `/admin/*`→gateway; `/svc/<name>/*`→工作区服务 (POST /load); `tcp://*:<port>`→layer4 穿透; Admin API 走 unix socket; 其余不上公网。
- **gateway 容器 forlife-gateway**（Node/TS）: OneBot 反向 WS 服务端 ← QQ 客户端；防抖/队列/会话映射/预评分 (T14)/`minimum` 超小模型 (T8 超时降级)/轮次驱动 (spawn `dsh` headless)/`/admin` (SSE)/端口发布→Caddy Admin API/job runner; 与 dsh 共享 SQLite+目录。
- **dsh 容器 profile=forlife**: `dsh-web-app` 与 forlife-memory 同进程；组件内 `ctx.compaction`/`ctx.systemPrompt` (P1/P2/L2/L3)/`ctx.tools` （记忆/QQ/表情）/`agent/pre-step` （视觉桥接）/`ctx.attachments`/`/api/forlife/*`; `dsh-std adapter` 仅宿主未内置时挂载。
- **QQ 客户端容器**（官方镜像）：登录态/协议/OneBot; 与 gateway 走 compose 内网 OneBot v11。
- **推理端点**（可外挂）: `local` (llama-server)/`remote-selfhost`/`cloud-api`/`host-native` × `resident`/`on-demand`/`remote-api`; 上层用 `InferenceEndpoint` （§2.13）。
- **卷**: db/hot/warm/cold/vectors/attachments/stickers/tmp/logs/workspace/models。
- **共享面/写入者**: 一个 SQLite (WAL) + blob/向量/附件/工作区目录（根路径各自可配）; `mid_*`/`long_*`/`compaction_*`/`prompt_*` = core, `qq_*`/`routing_*`/`sticker_*`/`jobs_*`/`published_ports` = gateway; 宿主 `ctx.storageDomain` 无 joins/迁移钩子；跨机不做。

### 2.2 一轮 QQ 消息的完整生命周期（时序）

```
1 QQ 客户端 --(OneBot WS event)--> gateway: 会话键 (platform, chat_id, thread_id?), 噪音过滤 (规则 -> 可选小模型)
2 防抖 2-3s (同会话新消息重置) + T14 预评分 (守卫 -> L1) → 入队 qq_inbox → per-key mutex 串行、跨会话并行 → 图/文件降采样
3 轮次驱动器: 预评分定档 L1/L2/L3 → provider/model/reasoningEffort（**从模型目录里挑一个可达的**，§2.20） (T10, 轮次内不变) → session (chat_key <-> dsh session_id) → spawn dsh --profile forlife headless --json --session-id <id> (env FORLIFE_TURN_TOKEN / FORLIFE_GATEWAY_URL / 附件清单)
4 dsh: ctx.attachments.saveImage -> ImageAttachmentRef; agent/pre-step 视觉桥接 (替换 image 块, 保留 MessageId); 组装 L0 → L1 tools → P1 → P2 → L2 → L3 → [缓存断点] → L4 → L5
5 工具: remember / push_mid_memory 写 mid 表 (T1); recall_longterm 预算 → FTS5 + LanceDB; request_compaction(reason); sticker_search / qq_send_sticker; publish_port / unpublish_port; qq_reply / qq_react / qq_typing → gateway HTTP (turn token); defer_turn 挂起 (T8)
6 gateway 收尾: NDJSON 映射 QQ 侧 (分段/typing/图片/文件) → 提交 session、写 qq_turns 与 routing_log、触发沉降/碎片/复盘 (T1)
```

### 2.3 PLAN.MD → 实现落点映射表（本计划的核心产出）

| PLAN.MD 概念 | 实现落点 |
| :--- | :--- |
| L0 / L1 工具定义 | 宿主既有 `SECTION_ORDERS.HARNESS_IDENTITY(-1000)` / `DEPLOYMENT_PERSONA_PREFIX(0)` / 工具段 1000–3100 |
| L4 / L5 | Session 事件日志 (`PromptAssembly`); L5 = 用户消息事件 |
| **L2 长期记忆索引** | `ctx.systemPrompt.section({ name:'forlife:l2-index', order: 100, text: provider })`, 落 `DEPLOYMENT_PERSONA_PREFIX(0)`/`PLAN_POLICY(500)` 空档 |
| **L3 中期记忆区** | `ctx.systemPrompt.section({ name:'forlife:l3-mid', order: 110, text: provider })`; `text` 每轮求值; `renderMidMemory(epoch, revision)` 纯函数，键 `(epoch, revision)` |
| **缓存断点** | 少变进 `section()`, 多变进 messages; `SystemPromptUpdate='in-history'`、`ToolUpdate='in-history' \| 'addition-only'`; `cache_control` 零命中 |
| **时间锚点** | 动态尾部 + `now()` + 相对年龄（§2.15） |
| 动态尾部 | `ctx.systemPrompt.context({name,order,text})`; `CONTEXT_ORDERS`: `SANDBOX_POLICY 110 / APPROVAL_POLICY 115 / SUBAGENT_DELEGATION 120` |
| `mid_memory_entries` | `node:sqlite` 表 + `revision` 列 (PLAN §2.1) |
| 渲染与追加 | `renderMidMemory()` → provider, 键 `(compaction_epoch, revision)`; `push_mid_memory`/`remember` 同事务 + 递增 revision |
| **短期→中期压缩** | `CompactionEngine` 挂 `ctx.compaction` (`compactIfNeeded`/`compactNow`/`compactRegion`); summary 节点 (`compactCheckpointSource`) |
| 压缩决策 | 覆写 `summarize()` (`BasicCompactionEngine` 唯一钩子) → PLAN §4.2 JSON |
| `keep_in_short` / `push_to_mid` | summary = keep + 碎片指针；写表 + `compaction_epoch += 1` |
| **`compaction_log`** | SQLite 表 + `session.dsh` 事件 (`forlife.compaction`, `replay:'ignorable'`) + effect-ledger |
| 压缩约束 | `request_compaction(reason)` → 裁决器（§4.4）; `ManualCompactionError` 的 `busy/cancelled/changed/...` |
| 碎片 `[F1→]` | `mid_memory_entries.entry_type='fragment'` + `fragment_hint` + `fragment_entities` → `[F1→] hint`; `fragment_mid` （§5.3） |
| `long_memory_entries` | SQLite 表 + `embedding_id` |
| 向量存储 | LanceDB 默认 (`@lancedb/lancedb`), `VectorIndex`; 排除 Qdrant 嵌入式, sqlite-vec 备选 |
| 混合检索 | FTS5 `bm25()` + 向量余弦; `node:sqlite` = SQLite 3.53.3 |
| **HDD 沉降** | 分层根 (`hot/warm/cold/tmp`) + `storage_tier`; 同盘 = 全 SSD (`coldEnabled=false`) |
| `recover(id)` / `recall_full(tool_call_id)` | 工具 + 后台按钮；大结果截断（§3.2） |
| **Recall 预算** | 计数器 (per cycle / per turn) + 去重 + `request_recall_extension` （§7.1） |
| QQ 工具集 | `qq_reply/qq_react/qq_typing` → gateway HTTP (turn token); `defineTool`: `output` 必填 (`execute` + `render`) |
| 轮次挂起 | `defer_turn` (`ToolRunContext.deferContext(UserMessage)` / `concludeTurn()`) |
| 队列/防抖/会话键 | 表 `qq_inbox`、`qq_sessions`、`qq_turns` + per-key mutex; 重启扫未完成轮次 |
| 噪音过滤 | 规则层（阶段 3） → 小模型（阶段 6） |
| **模型分级路由（§9）** | 轮次开始定档; `agent/request` (waterfall → `LlmCallConfig`) 覆写；压缩 L3 + `reasoningEffort:'high'`; 按 `模型路由.MD`: 守卫 → L1 评分 → 启发式（§2.7.1） |
| **接入中介层（模型目录 / 初始路由）** | `packages/router/src/catalog.ts`（目录 + 标记 + 简介 + 可达性）、`initial.ts`（定档 → 选可达模型）、`packages/dsh-component/src/llm-host.ts`（宿主 `llm` 取数）；生效写 `ModelSelectionRef.current`（§2.20） |
| 视觉/子代理/提示词/表情/沙箱 | §2.7.2 / §2.7.3 / §2.8 / §2.9 / §2.10 |
| 后台面板 | 记忆/压缩/召回/存储 → DSH Web (`main` keyed + `sidebar.panellist` / `prefix`); 队列/日志 → `/admin` |
| 缓存监控 | 按轮次记 `TokenUsage.cacheReadTokens/cacheWriteTokens` (`dsh-llm/lib/types/types.d.ts:160-172`) |
| 可回滚 | `compaction_log` + effect ledger + 软删除 + `recover` |

### 2.4 存储分层与可迁移路径设计

```yaml
storage:
  roots:
    db:          /data/forlife/db
    hot:         /data/forlife/hot
    warm:        /data/forlife/warm
    cold:        /mnt/hdd/forlife/cold
    vectors:     /data/forlife/vectors
    attachments: /data/forlife/attachments # DSH_HOME/attachments 亦可
    stickers:    /data/forlife/stickers
    workspace:   /data/forlife/workspace   # 含 triggers/
    models:      /data/forlife/models
    tmp:         /data/forlife/tmp
    logs:        /data/forlife/logs
  tiering:
    coldEnabled: true              # false ⇒ 全 SSD: cold 复用 warm 根
    settleAfterDays: 90
    settleBatchSize: 200
  limits:
    warnFreeBytes: 5GiB            # 低于此值拒绝沉降
```

- **迁移**: Preflight （可写、空间 ≥ 源 × 1.1） → `migration_lock` 表行 → blob 复制 + SHA-256 比对, `migration_journal` → 切根路径 + DB 前缀, effect ledger (`operation: 'replace'`、`valueDigest`) → `--purge-source` 留 7 天 → `forlife-admin migrate --resume`。
- **全 SSD**: `coldEnabled: false` → `storage_tier` 仍记 `cold`, 路径 = `warm` 根。

### 2.5 仓库布局（monorepo）

```
D:\DSH-ForLife\  |- PLAN.MD  |- EXECUTION_PLAN.md  |- docs\research\
|- packages\ # @forlife/contracts (类型/Schema/事件+plan-baseline.json); @forlife/store (node:sqlite/迁移/blob/
|  # FTS5/LanceDB); @forlife/memory-core; @forlife/router (守卫+L1 评分+兜底); @forlife/inference
|  # (InferenceEndpoint/自动部署); @forlife/media; dsh-component (forlife-memory: dsh-plugin.json+facet);
|  # @forlife/gateway (QQ/队列/轮次/预评分/admin); @forlife/admin-ui
|- profiles\forlife\ # 便携 profile (cordis.yml/patch); DSH_HOME 指向它, 不改宿主 ~/.dsh
|- deploy\           # docker-compose.yml (dsh/gateway/qq/caddy)、Caddyfile、pve\
'- scripts\          # dev-up / verify / migrate / archive
```

**已验证 CLI 契约** (`@deepseek-ai/dsh` 的 bin 定义):

| 命令 | 作用 |
| :--- | :--- |
| `DSH_HOME=<dir> dsh --profile forlife …` | 启动 `$DSH_HOME/profiles/forlife` (`$DSH_HOME` 优先于 `~/.dsh`) |
| `dsh --from-default-profile forlife` | 内置模板初始化 profile |
| `dsh plugin --profile forlife add <pkg \| file:…>` | 装插件 (pnpm 透传: `add`/`remove`/`why`) |
| `dsh --profile forlife --patch <file>` | 叠加 patch （可重复） |
| `dsh --profile forlife --dump-config` | 打印合成 profile 树 → CI 断言 |
| `dsh --profile forlife --dump-config-schema` | 打印 profile 与 patch 的 Schema |
| `dsh plugin --profile forlife allow-version <pkg@ver> --dsh-version <rt> --accept-risk` | 插件 × DSH 版本门禁 |

> `DSH_HOME` 指向仓库内目录, profile 与插件全在仓库里；本机与 PVE/Docker 只差 `DSH_HOME`, 宿主 `~/.dsh` 零接触。

---

### 2.6 需求保真度登记表（PLAN.MD + 模型路由.MD）

**约束**：两份设计文档逐参数、逐时机一比一实现；`packages/contracts/plan-baseline.json`（`PLAN.MD` §4.4/§5.3/§6.3/§7.6/§12、`模型路由.MD` §9 抽出）；`packages/contracts/src/plan-fidelity.ts`（默认值只从基线导入）；`tests/fidelity.spec.ts`（CI 断言默认值==文档基线；偏离登记 `contracts/plan-fidelity-deviations.json`，否则 CI 失败）。

#### A. 压缩约束（PLAN §12.1）
- `compaction.minTokens`=2000 / `compaction.minTurns`=3 / `compaction.minToolCalls`=5 / `compaction.waiveMinTurnsAboveTokens`=6000 / `compaction.cooldownTurns`=5 / `compaction.cooldownMs`=60000（60 s）/ `compaction.cooldownTokenDelta`=1500 / `compaction.emergencyBypassRatio`=0.75（75%）/ `compaction.autoTriggerRatio`=0.5（50%）—— 落点 `packages/memory-core/src/compaction.ts`

#### B. 碎片索引与沉降（PLAN §5.3 / §6.3 / §12.2）
- `fragment.maxHintTokens`=80 token / `fragment.maxEntities`=5 个 / `fragment.maxAreaRatio`=20% / `fragment.maxCount`=50 条 / `tiering.settleAfterDays`=90 天 / `midMemory.activeBudgetRatio`=active 80–85%+碎片 15–20% —— 落点 `packages/memory-core`

#### C. Recall 预算（PLAN §7.4 / §7.6）
- `recall.maxPerCycle`=5（`max_recall_per_cycle`）/ `recall.maxPerTurn`=2（`max_recall_per_turn`）/ `recall.maxResults`=3（硬上限 5；`recall.maxResultsHardCap`；`max_results_per_recall`）/ `recall.duplicateSimilarity`=0.9（`duplicate_similarity_threshold`）/ `recall.resetPolicy`=`on_compaction`（`reset_policy`）/ `recall.extensionMax`=2（`extension_max`）/ `recall.extensionCooldownTurns`=3 轮（`extension_cooldown`）/ `recall.associativeDepthWarn`=同轮 ≥3 次 —— 落点 `packages/dsh-component`

#### D. 路由与评分（模型路由.MD §5–§9）
- `router.minimum.model`=Qwen2.5-0.5B-Instruct (4-bit) / `router.minimum.resident`=是 / `router.minimum.timeoutMs`=50 ms / `router.minimum.maxTokens`=20（`max_tokens`）/ `router.confidence.low`=0.60（低于升一档）/ `router.confidence.high`=0.85（不低于采用）/ `router.guards.maxRules`=≤ 10 / `router.guards.targetIntercept`=40–60% / `router.preScore.enabled`=启用（防抖窗口内）/ `router.batch.enabled`=启用（群聊）/ `router.minimum.prefixCache`=启用（固定系统提示）/ `router.latencyBudgetMs`=< 30 ms —— 落点 `packages/router`
- **档位命名**：`minimum` = **唯一的「超小模型层级」**（原档位名 `scorer`，已废弃、不作为用途标签）；基线 6 个键已统一为 `router.minimum.*`（`plan-baseline.json`）。职责四件 —— ① 复杂度评分（已实现：`scorer.ts` 的 `TierScorer`）/ ② 路由决策（已实现：守卫 + 启发式）/ ③ QQ 工具决策（时区、数据可信度、工具返回的总结与提示信息）/ ④ 工具内**拥有低阶智能与一定自主能力**的决策源；③④ 属既有要求、此前被忽略，**尚未实现**（§2.20）。`scorer.ts` / `TierScorer` / `routing_log.source='scorer'` 是实现名（评分后端），与档位名不冲突。**只在需要的地方接 `minimum`，不是每个工具都接**。

#### D2. 模型供应与部署（模型路由.MD §3.2）
- `inference.modes.enabled[]`=四种全支持：`resident`/`on-demand`/`remote-api`/`host-native` / `inference.mode.switchPolicy`=自动+手动网页；幂等、排水、回滚 / `inference.targets[]`=`local-docker`、`remote-ssh`；`external-api` 只登记 / `inference.local.backend`=`cpu`、`cuda`、`rocm`、`vulkan`、`sycl`；自动探测+覆盖 / `router.minimum.endpoint`=本地容器；可改外挂、远程、宿主内置 / `router.minimum.resident`=是 / `inference.local.runtime`=`llama-server`（llama.cpp）/ `storage.roots.models`=可配（§2.4 迁移）/ `inference.onDemand.idleTimeoutMs`=600000（10 分钟）/ `inference.download.*`=SHA-256+断点续传+镜像源 / `inference.warmup.enabled`=启用（T16）/ `router.preScore.softBudgetMs`=≤ 800 ms；偏离见 §2.13.4 / `router.minimum.timeoutMs`=50 ms；超时降级启发式 —— 落点 `packages/inference`

#### D3. 触发与自唤醒（§2.14）
- `wake.budget.perTrigger`=6 次/小时、50 次/天 / `wake.budget.global`=30 次/小时、300 次/天 / `wake.budget.tokensPerDay`=可配；超限只记录 / `wake.quietHours`=默认关（如 23:00–08:00）/ `wake.coalesceWindowMs`=60000（60 s；同源合并）/ `wake.cascadeMaxDepth`=3 / `wake.defaultExpiryDays`=30 天 / `wake.missedPolicy`=`skip`（可 `coalesce`/`catch_up_once`）/ `wake.program.limits`=CPU 25%、内存 256 MB、单次 5 min、输出 1 MB/10k 行 / `wake.program.restartPolicy`=退避 ≤5 次/小时；超限停用 —— 落点 `packages/gateway`

#### D4. 时间感知（§2.15）
- `time.zone`=`Asia/Shanghai`（单一权威）/ `profiles/forlife/cordis.patch.yml`=显式挂载 `dsh-time-context`；宿主默认 `disabled` / `time.inject.policy`=事件驱动 / `time.inject.everyTurnStart=true`（每轮首步）/ `time.inject.midTurnIntervalMs=300000`（跨 ≥5 分钟或跨日期）/ `time.inject.afterCompaction=true`（压缩后立即）/ `time.inject.onWake=true`（唤醒/`defer_turn` 恢复；附「距上次交互」）/ `time.inject.afterIdleMs=900000`（长期空闲后首条；附差值）/ 读数位置=只进动态尾部、不进稳定前缀（位置契约 lint 覆盖）/ `time.tool.enabled=true`（`now()` 工具；唯一权威时间源）/ `time.relativeAges=true`（条目/碎片带「3 天前」）/ `time.drift.warnAfterMs=300000`（`time_drift` 遥测；阈值 ±5 分钟）—— 落点 `packages/memory-core`

#### D5. 时区 / 唤醒等级 / 路由表（§2.16–§2.18）
- `time.systemZone`=`UTC` / `time.displayZone`=跟随浏览器、回退系统 / `time.onUnknown`=按系统时区+标「未确认时区」/ `time.suggest.enabled=true` / `time.suggest.minConfidence=0.7`（≥0.7 落表，<0.7 pending）—— 落点 `packages/memory-core`
- `group_message_any`（`wake.rules.groupMessageAny`；`wake.rules.groupMessageAny.enabled=false`）=默认不唤醒；可按群 1–20% / `wake.rules.privateMessage.probability=80`（私聊）/ `wake.rules.groupMentionAll.probability=50`（@全体成员；与 `@我` 分开）/ `wake.rules.tempMessage.probability=20`（临时会话）—— 落点 `packages/gateway`
- `wake.rules.privateMessage`（`private_message`）=开、100%、min_interval 3 s / `wake.rules.groupMention`（`group_mention`）=开、100% / `wake.rules.groupPoke`（`group_poke`）=开、100% / `wake.rules.replyToMe`（`reply_to_me`）=开、100% / `wake.rules.peerInputStatus`（`peer_input_status`）=开 / `wake.rules.peerStatusChange`（`peer_status_change`）=关、需显式开 / `wake.rules.mediaReceived`（`media_received`）=开 / `wake.rules.*.probability`=独立抽样、受 `min_interval`/`daily_limit` 约束 / `wake.rules.updatedBy`=模型（`set_wake_rule`）/后台可改 / 会话默认唤醒等级=逐条件默认值 —— 落点 `packages/gateway`
- `status.systemOnWakeFailures=3`（3 次失败/90 s 无响应 → `system`）/ `status.presets.failureTemplate`=预设模板、可改（`set_status_preset`）/ `admin.report.enabled=true` / `admin.report.coalesceMs=60000`（`affects_model` 一律报告）/ `admin.humanChannel.enabled=true`（source=`forlife:admin`）/ `delivery.confirmTimeoutMs=3000` / `delivery.failThreshold=3`（3 次超时判 QQ 侧故障）—— 落点 `packages/gateway`
- `sticker.autoFetch.enabled=true` / `sticker.autoFetch.perTurnLimit=3`（每轮 ≤3 张）/ `media.fingerprint.enabled=true` / `sticker.learnOthers=true` / `sticker.sendOthers=false`（只学习不转发）/ `vision.ocr.isHintOnly=true` / `vision.ocr.requireReviewFor[]`（OCR 仅线索；重要内容强制复核）/ `media.capacity`=2000 件/5 GB；LRU —— 落点 `packages/media`+`packages/dsh-component`（视觉桥接）
- `status.systemSources.*`=QQ 侧+本地侧（模型/配置/执行/资源）/ `wake.pending.capacity`=200 条/72 h；溢出只留摘要 / `routing.roles[].routes[]`=每角色 1..N 项、按 `order` 降级 / `routing.failover.enabled`=启用；需登记 deviation / `routing.switch.cooldownTurns=5` / `routing.switch.dailyLimit=10`（需理由+冷却 5 轮+每天 ≤10 次）/ `multiplex.compactionScale`=活跃会话越多越早触发 —— 落点 `packages/gateway`

#### E. 时机清单（缺一不可）
- T1 每轮结束追加中期记忆（同事务写表+渲染）— PLAN §2.3 · `push_mid_memory`
- T2 自动触发压缩（≥50% 或定时）— PLAN §4.2 Step1 · `compactIfNeeded(trigger:'pressure')`
- T3 模型请求压缩（阈值/冷却/豁免）— PLAN §4.4 · `request_compaction`+裁决器
- T4 压缩后空请求预热缓存— PLAN §4.2 Step5 · 压缩事务收尾
- T5 中期→长期沉降/扫描 `last_accessed > 90d`— PLAN §6.3 · 沉降任务
- T6 最久未访问且 hint 已泛化 → `archived`— PLAN §5.3 · 碎片维护任务
- T7 QQ 防抖 2–3 s；新消息重置计时— PLAN §8.2/§8.4 · gateway
- T8 挂起（`defer_turn`）不提交、不追加记忆— PLAN §8.3 · gateway+`deferContext/concludeTurn`
- T9 噪音过滤在队列层— PLAN §8.5 · gateway
- T10 路由决策轮次开始做一次，轮内不换— PLAN §8.6 · gateway
- T11 Recall 预算压缩后重置；同轮 ≥3 次加提示— PLAN §7.1/§7.4 · 工具内计数器
- T12 缓存断点在 L3/L4 边界— PLAN §10.3 · 提示段 order
- T13 压缩频率目标每 5–8 轮一次— PLAN §10.4 · 冷却参数联合效果
- T14 预评分在防抖窗口内启动— 路由 §8.5 · gateway
- T15 不确定案例定期 L3 复盘 → 守卫/提示词调优— 路由 §6.2 · `uncertain_cases`
- T16 评分模型启动预热— 路由 §8.3 · gateway
- T17 中期记忆区仅压缩事件时追加/替换— PLAN §10.2/§10.4 · 渲染修订号
### 2.7 模型分级路由 · 视觉/非视觉 · 子代理多模型

#### 2.7.1 三档路由（严格按 `模型路由.MD`）

三层：守卫规则（<1 ms，≤10 条；明显 L1/显式 @L3/压缩与仲裁）→ L1 评分模型（5–30 ms；固定系统提示 KV 前缀缓存 + 极简用户消息）→ 启发式兜底（<1 ms；超时 >50 ms/不可用/低置信度；权重见路由 §5.4）；confidence <0.6 升一档；T7 防抖与 T14 预评分并发；T10 轮内锁定模型。

- `packages/router` / `TierScorer`；后端 `llama-server`（GBNF 约束解码；`Qwen2.5-0.5B-Instruct` 4-bit GGUF 常驻）/ OpenAI 兼容 API（`response_format`）/ 纯启发式（兜底，CI 默认）。
- 输出 `{"tier":"L1|L2|L3","confidence":0..1}`，`max_tokens=20`；解析失败按低置信度。
- 预评分防抖窗口内并发；群聊批处理；观测 `routing_log`、`uncertain_cases`（<0.6）→ T15 定期 L3 复盘。
- 档位→模型 `provider/model/reasoningEffort`；压缩固定 L3 + 高推理强度（PLAN §9.2）。
- **档位是语义、模型是资源**：定档与选模型分离 —— 定档走本节的守卫/预评分/启发式，选模型走中介层的模型目录与实际可达性（§2.20）；某接入点挂掉只换模型，不改对任务的判断。档位名统一 `minimum`（原 `scorer`，§2.6 D）。

#### 2.7.2 视觉与非视觉分开处理

宿主事实（依据 `research/vision-modality-report.md`；相对真包根 `R`，`path:line` 同源）：

- 三态：`undefined` 未知 → 不降级、硬拒 `UNSUPPORTED_CONTENT`；`['text']` → 占位文本（`projectImagesForTextModel`，`content.js:47-50`）；`['text','image']` 支持；未知按不支持。
- `resolveModelInfo`：`await ctx.llm.resolveModelInfo(provider, model, signal)`（`dsh-llm/lib/types/index.d.ts:360`）→ `.inputModalities.includes('image')`；`LlmModelInfo.inputModalities?: readonly ModelModality[]`、`ModelModality = 'text' \| 'image'`（`dsh-llm/lib/types/types.d.ts:211,304,314`）。
- 改写入口 `agent/pre-step`（`{prepend:true}`；`dsh-agent/lib/types/runtime-types.d.ts:327`；`ctx.on('agent/pre-step', handler, { prepend: true })`、`installModelSelection`、`dsh-agent/lib/types/model-selection.js:76-88`、`return {...decision, messages:[…]}`）；`agent/request`（`deepFreeze`）、`llm/stream` 非切换点。
- 图片 `ImageBlock`：`ImageBlock{type:'image'; attachment: ImageAttachmentRef}`、`attachmentId = "sha256:<64hex>"`；登记 `saveImage({data: Uint8Array, mediaType, name?})`（`ctx.attachments`、`AttachmentStore`）；无 from-path / from-URL。
- 附件 `<DSH_HOME>/attachments/v1`：20 MiB/图、20 张/消息、200 MiB 聚合、64e6 像素、单边 8192；png/jpeg/webp/gif；超限拒绝。
- 工具返回图片 `ToolOutputDefinition.render(args, value): ContentBlock[]` → `[{type:'text',…},{type:'image',attachment:ref}]`（`dsh-tool-fs/lib/index.js:950-963`）；一跳 `ctx.llm.stream(GenerateOptions)` + `BlockAssembler`；`purpose` 闭集（`'compaction' \| 'session-title'`）。
- `@dsh-std/tool` 的 `ToolExecutionContext.saveImage / recentImages / imageLimits` 内核侧无（`recentImages` 无）→ 直接对 `ctx.attachments` 编程（`adapter-dsh` 映射）；无现成桥接（`describeImage/ocr/vlm/multimodal` 零命中）。

分流：支持→直传；纯文本→桥接（占位文本 `[image omitted because this model accepts text only; attachment sha256:<前8位>]` 丢内容）；未知→按不支持；纯文本零视觉。

桥接：`agent/pre-step` 内 `await next()` → 硬校验视觉 route 声明 `image` → `ctx.llm.stream({ provider: visionProvider, model: visionModel, messages: [{ role:'user', content: [ {type:'image',attachment:ref}, {type:'text',text: describePrompt} ] }] })` + `BlockAssembler` → `ref.attachmentId` 缓存 → `freezeMessage({...msg, content:[{type:'text',text:'[图片描述] …'}, ...非图块]})` → 异常吞掉；命中 `media_fingerprints` 则复用（§2.9.1）；描述三段（画面 / 文字 OCR / 不确定）不进中期记忆。

QQ 入站：OneBot `image` → gateway 下载（白名单 / 大小 / 超时）→ 魔数嗅探 → 超限降采样 → `ctx.attachments.saveImage` → `agent.followup`（`agent.steer`）。`describe_image(attachment_id)`；占位文本仅 sha256 前 8 位。

#### 2.7.3 子代理与多模型混合

- `ctx.subagents.start(name, req)`（落地 `ctx.subagents.start(name, { agentOptions })`）；`req.agentOptions: AgentOptions = { provider?, model?, reasoningEffort?, maxTokens? }`（`dsh-subagent/lib/types/types.d.ts:155-162`、`dsh-agent/lib/types/runtime-types.d.ts:21-30`）；另 `persona`/`toolFilter`/`maxDepth`/`outputSchema`；门禁 `SubagentCapabilities`（`agentOptions｜persona｜toolFilter｜depthLimit｜outputSchema`），spawn/fork 全 true。
- `provider`/`model`/`reasoning_effort` 仅 `modelSelectionSettings: true` + 白名单（`dsh-tool-subagent/lib/index.js:412-425`）→ 程序化 `agentOptions`。
- preset 无模型字段（`AgentPresetDefinition = { id, name?, description?, order?, plugins[] }`、`plugins` 行；`dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`）；`register()` 无 upsert；`select()` 仅空白会话（`agent-preset/locked`）；`~/.dsh/.agent-presets/` 废弃。
- 内核无跨模型 failover：`agent/request-error` 仅 `{kind:'retry'}`（`dsh-llm-retry`）；`retryPolicy` 在 provider Config（`maxRetries=5`；`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`；退避 500→10000 ms）；重试不消耗轮次；`ctx.llm.stream()` 单次尝试。
- 规则：① 角色→模型（检索/归档/格式化 → 便宜；规划/复盘/压缩 → 强；视觉 → 视觉）；② 程序化 `agentOptions` > preset `tool-subagent.agentOptions` > 模型自选（不启用）；③ 自研 failover：`agent/request-error` 计数 → `agent/request` 换 `LlmCallConfig` → `routing_log`，幂等（`step()` 重试循环内重跑）；④ 判定 `agent/pre-step`、生效 `agent/request`；⑤ 路由改写成为 header 基线并粘住 → 每 step 重断言；⑥ `ReasoningEffortId`（`reasoningEffort`）由 adapter 声明（`resolveModelInfo()` 读 `reasoning.efforts / defaultEffort`；deepseek `off/low/high/max`；pi-ai `off/minimal/low/medium/high/xhigh/max`）；⑦ `dsh-llm-auto`/`dsh-subagent-default-model`/`dsh-team-lead`/`dsh-router-core` 阶段 5 评估（PLAN §9.5）。

### 2.8 提示词可编辑（系统提示词 + 回答风格）

| 层 | 内容 | 编辑入口 | 缓存影响 |
| :--- | :--- | :--- | :--- |
| P0 身份/安全 | 宿主 identity（`HARNESS_IDENTITY`） | 不可编辑 | 稳定 |
| P1 系统提示词 | 角色、能力边界、输出规范 | 后台编辑器 + 插件 volatile Config | 改动即未命中一次 |
| P2 回答风格 | 语气、长度、表情、分段、群聊 vs 私聊 | 后台编辑器 + 每会话覆盖（遮蔽） | 同上 |
| P3 每轮动态 | 时间、会话、待办 | 不进提示词区（`context()` / 消息） | 不污染前缀 |

机制：`section({ name, order, text: string \| ((ctx) => string), interpolate?, complete? })` 的 `text` 为函数时每次装配重算 → 改内存即生效（下一 step）；同名 section 窄作用域注册即遮蔽 → 每会话/agent 覆盖；per-agent ctx 经 `agent/created`（`Agent.ctx`）；`ctx.settings` 的 `ctx.settings.update('system-prompt', …)` 不可用（`write()` 需 volatile、`system-prompt` 无 `.volatile()`，抛 `Plugin entry "…" has no volatile fields`）→ 持久层用自有插件 Config；禁用 `complete`（`complete: true` 吃掉 `system-prompt/assemble` 改动）；`AGENTS.md` 链（`$DSH_HOME/AGENTS.md`）走 user 消息；无编辑 UI，须自研。

实现：内存 store = 生效层；volatile Config = 持久层；变更 → store → 下一 step。要求：① 保存规范化空白 + SHA-256 + 提示「将导致一次缓存未命中」；② 版本 + diff + 回滚（`prompt_revisions`）；③ P2 按会话覆盖；④ 插值白名单；⑤ 预览 token 数；⑥ 热生效不重启；⑦ 标注适用场景。

### 2.9 表情包子系统

目标：自有表情库、知语义、按语义挑选、联网检索入库。

| 组件 | 设计 |
| :--- | :--- |
| `sticker_assets` | `id / sha256 / 文件名 / 宽高 / 字节 / mime / 来源(手动\|搜索\|生成) / 来源 URL / 入库时间 / 使用次数 / 最近使用 / 状态` |
| `sticker_descriptions` | `sticker_id / 描述文本 / 情绪标签[] / 适用场景[] / 文字内容(OCR) / 是否含文字 / embedding_id / 描述模型 / 版本` |
| 检索 | 「描述+情绪标签+OCR」embedding（LanceDB）→ 语义 + 标签 + 频次加权 |
| 入库 | ① 手动上传/放置；② `sticker_search`：`sticker_search(query)` → sha256 去重 → 下载 → 视觉描述 → 入库（来源 URL 留审计）；③ 图像生成（后置） |
| 缺货补货 | 库内无结果 → 自动联网抓取 → 入库 → 发送；受白名单/大小/类型/去重约束；每轮上限 |
| 出库 | `qq_send_sticker(id \| query, reply_to?)` → 小图 `image` 段，超限 `upload_group_file` / `upload_private_file` |
| 容量/记忆 | sha256 去重 + 容量上限 + LRU；表情库是资产非记忆 |
| 安全 | 白名单域名；类型/大小校验；非法不入库；失败不计重试风暴 |

私有图片库（并入长期记忆）：`private_media(id, kind[image|file|doc], sha256, path, mime, bytes, width, height, title, description, entities, tags, embedding_id, source_scope, origin_url, status, created_at, last_used_at, use_count)`；长期记忆为 `long_memory_entries` 一条（`content`=描述+实体+用途、`attachment_ref` 指媒体）→ `recall_longterm` 检索、`recall_media(id)` 取原图。工具 `media_save(source, {title?, description?, tags?})`/`media_search(query)`/`media_send(id, target)`/`media_delete(id)`；`sticker_*` 对外、`media_*` 自留；存储 `storage.roots.attachments`（LRU，大文件下沉同 §2.4）。

#### 2.9.1 媒体指纹表：哈希优先，避免重复视觉调用

`media_fingerprints(sha256[主键], kind[sticker|image|file], ours[可发送；false = 只学习不转发], description, ocr_text, ocr_model, entities, tags, embedding_id, desc_model, desc_version, seen_count, first_seen_scope, last_seen_at, scopes[], status[active|archived])`

索引：自有+他人表情。命中 → 复用描述与标签（0 次视觉调用）；未命中 → OCR + 视觉描述 → 入库；跨群累积 `scopes`。`ours=true` 可发送，他人默认只学习。指标：节省率 = 命中/（命中+未命中）。

#### 2.9.2 OCR 是线索，不是结论

规则：不得依赖 OCR。OCR 只出线索（可能文字、置信度、可疑标记），不作唯一依据写记忆或行动；视觉模型为权威——内容重要 / 置信度低 / 与画面矛盾 / 涉及金额·时间·命令·人名 → 必须复核（`describe_image` 或直传）；本轮支持视觉时优先直接看图（§2.7.2）。

落地：① `ocr_image` 写明「OCR 可能出错，请复核」；② 未复核的 OCR 来源条目打 `source: ocr-unverified`；③ `describe_image` 定位复核与兜底；④ 回归测试「OCR 错字/漏字」样本。

### 2.10 沙箱工作区与端口出口

#### 2.10.1 沙箱：结论是「几乎零改动」

- 三档模式仅文件语义（`read-only` / `workspace-write` / `danger-full-access`）；seam 不管网络/进程/系统调用/设备/凭据（`dsh-sandbox/README.zh.md:167`、`dsh-sandbox-policy/README.zh.md:148`）。
- 网络不受限（bwrap 只 `--unshare-pid`、无 `--unshare-net`）→ 共享宿主网络，可起 dev server。
- 无「允许端口」配置面（`allowedPorts｜portRange｜netPolicy｜egress` 零命中）→ 建设发现/登记/暴露/回收。
- 沙箱根 = 会话不可变 cwd（`SessionHeader.cwd`，`dsh-session/lib/types/types.d.ts:68-69`），回退 `workspaceRoot`（`process.cwd()`）；`dsh-workspace` 对模型不可见。
- 改法：`DSH_PERMISSION_MODE=workspace-write` + cwd 指向工作区；或 `cordis.patch.yml` patch `- id: sandbox-policy`（替换整行 config）。
- `dsh-invariants` 只断言不阻断（`INVARIANT`），仅 `dsh-sdk-minimal` 挂载（`dsh-base` 省略）→ 准入控制放 `tools/execute`/`tools/pre-execute` waterfall。

结论：沙箱 = 配置 + cwd 约束 + 工具层准入；`tools/pre-execute` 挂越界与端口审批（依据 `research/caddy-sandbox-ports-report.md`，`path:line` 同源）。

#### 2.10.2 端口出口：单一真源是 gateway，不是 Caddyfile

| 项 | 结论 |
| :--- | :--- |
| 增删路由 | `POST /config/apps/http/servers/<srv>/routes` 追加；`DELETE /id/<id>` 撤销（`/id/<id>`=`@id` 直通，同 `/config/...`） |
| 优先级 | `POST` 追加末尾、首个匹配胜出 → 兜底 `handle` 遮蔽；抢优先级 `PUT .../routes/0`；body 须单对象 |
| 最致命 | `caddy reload`/`caddy adapt` = `POST /load`（整份替换）→ 抹掉 API 追加路由；禁用「Caddyfile + API 追加」 |
| 正确做法 | 真源放 gateway：合成完整 JSON → `POST /load`（原子/回滚/无停机）；`persist_config off`（防 autosave、`--resume`） |
| Admin 鉴权 | 无内置鉴权；`origins`/`enforce_origin` 不防本机 → 不 publish 2019；首选 `admin unix//run/caddy/admin.sock`（0200）、其次 `admin 127.0.0.1:2019`；禁 `admin :2019`、`admin off` |
| 约束面 | Caddy 无网段/端口段限制 → gateway 调 API 前校验 |

layer4：官方 `caddy:2`/`2-alpine`/`latest` 不含 `layer4`；自检 `docker run --rm caddy:2 caddy list-modules | grep -i layer4`；`FROM caddy:2-builder` → `xcaddy build --with github.com/mholt/caddy-l4@v0.1.2` → 覆盖 `/usr/bin/caddy`。配置：`routes` 在 server 内；handler `proxy`（非 `tcp_proxy`）；无 tcp/udp matcher（协议由 `listen` 定）；`upstreams[].dial` 字符串数组；Caddyfile 用全局块 `layer4 { … }`；仅 `PUT` 自动建缺失路径（`POST /config/apps/layer4` 需 `apps` 已存在）；`servers` 无需预建；`/config` 写入 = 完整重载。

Web GUI 反代禁令：`dsh-web-app` 的 `/api` 有 Host/Origin 栅栏（`Host` 须 loopback 或匹配 `trustedHosts`；`dsh web --host 0.0.0.0` 不支持）；cookie host-only + SameSite=Strict → 公网只暴露本项目 gateway；DSH Web UI 留 loopback/内网/VPN（§2.12）。

护栏：① 端口段白名单（gateway 硬拒）；② 目标网段白名单（缺失可反代 `127.0.0.1:2019`/`169.254.169.254` → SSRF）；③ 人工批准；④ TTL；⑤ 审计日志；⑥ 不 publish 容器端口，回收对账 `GET /config/`；⑦ `@id` 前缀隔离（`forlife-svc-*`/`forlife-l4-*`）；Admin API 仅 unix socket。

---

### 2.11 工具清单

命名规则：PLAN.MD已定义名照抄，新增用功能前缀；重名即失败。真机注册生产工具数34（见§6.4）；以下为模型全部可调用面.

记忆：`remember`/`push_mid_memory`写记忆（§13）；`recall_longterm(query, hint?)`检索/预算（§7.1）；`recall_full(tool_call_id)`取全文（§3.2）；`recover(id)`回热层（§6.3）；`request_compaction(reason)`压缩（§4.4）；`request_recall_extension(reason, additional=2)`逃生（§7.5）

QQ（§8.1）：`qq_reply(text, reply_to?)`发送；`qq_react(emoji, msg_id?)`回应；`qq_typing(on/off)`输入中/仅私聊；`qq_send_image(source, reply_to?)`发图；`qq_send_file(source, name?)`发文件；`qq_send_forward(conversation, messages)`转发；`qq_read_history(conversation, count, before?)`历史；`group_notice(group_id, {read\|send\|delete})`公告读写/不耗@全体额度/发送需放行；`at_all_remain(group_id)`查额度`{can_at_all, remain_at_all_count_for_group, remain_at_all_count_for_uin}`(`get_group_at_all_remain`);`qq_mention_all(group_id, text)`@全体/额度0或`can_at_all=false`即拒/计审计；`set_remark(target, remark)`人名映射；`person_status(user_id)`状态（`nc_get_user_status`/`peer_status_change`）；`ocr_image(image)`OCR;`check_url_safely(url)`检测；`qq_packet_status()`自检；`defer_turn(reason, expected_duration)`挂起（§8.3）

媒体库：`media_save(source, {title?, description?, tags?})`存库（§2.9）；`media_search(query)`/`recall_media(id)`/`media_send(id, target)`/`media_delete(id)`检索/取图/发出/删除

表情：`sticker_search(query, k?)`检索；`sticker_add(source)`入库；`qq_send_sticker(id \| query, reply_to?)`发送

视觉：`describe_image(attachment_id)`描述图

沙箱：`publish_port(port, {name, protocol, ttl})`发布端口；`unpublish_port(name)`/`list_ports()`撤销/查看

唤醒：`schedule_wake(spec)`定时唤醒；`register_watcher(spec, program?)`监视器；`list_wakes()`/`cancel_wake(id)`/`wake_now(reason)`查看/取消/唤醒；`set_wake_rule(scope, condition, patch)`/`list_wake_rules(scope?)`自调条件（§2.17.2）

时间：`now()`时间源（§2.15）

时区：`get_clock(scope?)`/`set_clock(scope, {timezone?, hour_cycle?, note?})`/`list_clocks()`时钟（§2.16）

会话：`read_pending(scope?, limit?, since?)`读未读（§2.17.3）

状态：`set_status(value, {custom_text?, reason?})`设状态（§2.17.6）；`set_status_preset(template)`改文案

路由：`switch_model(target, reason, scope?)`仅主代理（§2.18.2）

横切（§2.17.9）：`qq_reply`/`qq_mention_all`/`qq_send_image`/`qq_send_file`/`qq_send_sticker`/`group_notice(send)`/`media_send`均等`message_sent`回执（3 s）；确认`{ok:true, message_id, confirmed:true}`;超时提示未确认（`get_msg(message_id)`）；连续失败计`system`故障.

描述：`recall_longterm`照录§7.3;`qq_typing`群聊不生效；`sticker_search`先搜再发；`publish_port`限工作区/白名单/需批准/TTL;写记忆禁写记录与全文（§4.3）.

### 2.12 访问拓扑

约束：`dsh-web-app`的`/api`有Host/Origin栅栏（`Host`限loopback或`trustedHosts`）；cookie host-only+`SameSite=Strict`/无`Secure`;非本机域名反代不受支持.

- `https://<host>/admin/*`->gateway:公网；自有鉴权（scrypt/argon2+`Secure`+`SameSite=Lax`）；六面板：记忆/压缩/路由/表情/端口/提示词
- `https://<host>/svc/*`->服务：公网/显式发布；端口段/网段白名单/人工批准/TTL
- `tcp://<host>:<port>`->layer4:公网/显式发布；同上
- DSH Web UI(`:3080`/`127.0.0.1:3080`):仅loopback/内网/VPN隧道；宿主令牌->cookie
- OneBot/Caddy Admin:不暴露；unix socket;Admin API走`admin unix//run/caddy/admin.sock`(0200)
- QQ WebUI(`6099`):**不直接暴露**；经**独立域名站点块**`napcat.<host>`反代到同源（代理在根路径），NapCat 的绝对路径天然对得上 ⇒ 面板 iframe 无混合内容问题（§1.2、§6.3）
- 备选（U15）：gateway 前置带鉴权的 DSH Web 反代（改写 `Host` + cookie 会话）；实测不可行则永久留隧道（见 §8.4 项 5b）

面板：公网面板在gateway侧；DSH内嵌（slot/`/api/forlife/*`）仅隧道内；共用同一SQLite/API语义.

### 2.13 模型供应

#### 2.13.1 硬件前提

- GPU:AMD R7 430 挂PVE/不直通⇒VM内纯CPU;GCN 1代Oland无ROCm⇒不做GPU假设.
- 加速：无⇒本地CPU/量化；强算力走外挂/远程.
- `minimum`（超小模型层级，原「评分器」）：0.5B Q4在CPU 30-60 ms,常触发50 ms降级⇒默认外挂/远程，启发式兜底（§2.13.4）.

#### 2.13.2 来源x模式

来源：`local`本机容器（`llama-server`(llama.cpp)/Ollama/vLLM）；`remote-selfhost`外挂自建（同API）；`cloud-api`云provider(DeepSeek,DSH配置);`host-native`宿主L1/默认（`模型路由.MD`§3.2第四行）

模式（`模型路由.MD`§3.2,可切换）：`resident`常驻（`restart: unless-stopped`/预热/健康检查）；`on-demand`按需加载/空闲卸载（首请求200 ms+）；`remote-api`不本地部署（注册/探活/配额/超时）；`host-native`只读引用

切换（`resident ↔ on-demand ↔ remote-api ↔ host-native`）：自动按请求量/内存/时段；手动后台页开关；幂等/审计/排水/回滚；容忍端点短暂不可用（回退链/熔断，§2.7.3）.

加速后端：`cpu`任意/本机实际（CPU镜像AVX2/AVX512）；`cuda`NVIDIA(`:server-cuda`/`--gpus`);`rocm`AMD/不含R7 430等GCN1(`:server-rocm`/`/dev/kfd`/`/dev/dri`);`vulkan`跨厂商（`:server-vulkan`/`/dev/dri`）；`sycl`Intel(`:server-intel`/`/dev/dri`)

探测（`/dev/dri`/`nvidia-smi`/`rocm-smi`/`clinfo`/`vainfo`）给建议，无则`cpu`;UI可改；兼顾`x64`/`arm64`.抽象：`InferenceEndpoint { id, type, mode, backend, baseUrl, apiKeyRef, models[], health, limits }`.

#### 2.13.3 自动部署

`forlife models deploy <spec>`/后台一键部署同流水线：幂等/可中断/可回滚.

目标：`local-docker`compose/`docker run`;`remote-ssh`SSH远端同步骤（凭据加密/不入日志/主机白名单）；`external-api`只登记（base URL/密钥/探活/模型发现）

护栏：白名单/dry-run/显式确认/远端回滚/审计.

**已实现的库（尚未接线）**：`packages/router/src/deploy.ts`（约 20 KB）+ `download.ts`（约 7 KB）—— 三种部署目标、断点续传、SHA-256 校验；测试 `packages/router/test/deploy.test.ts`。**当前生产路径零调用** ⇒ 把这条流水线接上线（含 `minimum` 的**自动部署能力**）是本计划的待办，见 §2.20.4。

**`minimum` 选型（`模型路由.MD` 已定）**：Qwen2.5-0.5B-Instruct 4-bit / GGUF Q4 / 约 400 MB（纯 CPU 用 Q4）。

流水线（共用）:

1. Preflight:CPU/内存/架构（`x64`/`arm64`）/加速器/磁盘余量（模型根可配，§2.4）/端口.
2. 选型：按内存/后端给模型x量化x后端建议（0.5B/1.5B/7B x Q4/Q5/Q8）；装不下不部署.
3. 镜像：按后端选标签/直通参数；源可配.
4. 权重：写模型根；源/续传/SHA-256;远端落远端根.
5. 启动/健康检查：等`/health`/`/v1/models`（超时回滚）；记录实际后端（镜像可能回落CPU）.
6. 预热：典型样本跑几次（T16）.
7. 注册：写`inference_endpoints`（来源/模式/后端/`image`/text能力/上下文/`reasoning.efforts`）.
8. 回滚：失败停容器/留权重/写审计；`models remove`可只删容器或连权重删.

权重/镜像可迁移：模型根纳入§2.4;HDD冷存不适用.

#### 2.13.4 延迟预算

基线50 ms超时->启发式（`模型路由.MD`），不改:

- 同步（兜底）：50 ms硬超时->降级启发式.
- 预评分（主）：防抖窗口2-3 s内跑，隐藏延迟；软预算≤800 ms.
- 属有意偏离，须登记`plan-fidelity-deviations.json`(CPU-only+§8.5).

#### 2.13.5 选择列表

后台页:

1. 聚合：本地容器（`/v1/models`发现）/外挂自建/云provider(DSH配置，含能力位与`reasoning.efforts`)/宿主内置.
2. 每行：来源/部署目标/后端/模式/能力（text/`image`）/上下文/推理强度集合/健康/p50-p95/内存/成本.
3. 角色映射：`L1 / L2 / L3 / minimum（原评分器）/ 视觉 / 嵌入 / 子代理角色…`各选模型/强度，主/备回退链.
4. 端点运维（网页）：部署/卸载；模式切换（排水/回滚）；后端切换/直通参数；动作显示dry-run并需确认.
5. 校验：视觉须声明`image`;嵌入须给维度；`cuda`无NVIDIA设备即报错.
6. 与DSH:云provider以DSH配置为真源（只读）；UI合并展示不覆盖.
7. 试跑：显示延迟/返回内容/实际生效后端.

---

### 2.14 触发与自唤醒引擎（模型能自己盯事）

状态：已完成（阶段 8）；真机验收与未验项见 §4 阶段 8、§8.1.

#### 2.14.1 四类唤醒源
- `timer`:定时/周期/一次. 例：每日 8 点汇报
- `watcher`:自写程序/探针状态
- `system`:内部事件/异常
- `external`:外部输入
PLAN §8.3:`defer_turn` 同轮挂起恢复；本节跨轮自唤醒.

#### 2.14.2 放在哪里：gateway 内的 Trigger Engine
必须 out-of-process(gateway):① 起轮在轮次驱动器；② DSH 常未运行；③ 脚本驻沙箱.
链路：`timer`/`watcher`/`system`/`external`→`Scheduler`/`Supervisor`/`Event Bus`/`Ingress`→`Wake Dispatcher`→注入唤醒轮.

| 表 | 关键字段 |
| :--- | :--- |
| `wake_triggers` | `id / owner_scope(会话或全局) / kind(timer\|watcher\|system\|external) / spec_json / action(wake\|notify\|tool) / budget / quiet_hours / status / created_by(model\|user\|system) / created_at / expires_at / last_fired_at / fire_count` |
| `wake_programs` | `id / trigger_id / path(工作区内) / runtime(node\|python\|bash) / contract / limits(cpu/mem/time) / restart_policy / state` |
| `wake_events` | `id / trigger_id / fired_at / kind / payload / decision(fired\|coalesced\|skipped\|rejected) / turn_id / cost_tokens / error` |

#### 2.14.3 模型自写唤醒程序的契约
目录 `<workspace>/triggers/<name>/`:
- probe:退出码 0=无信号；stdout 末行 JSON `{"fire":true,"reason":"…","payload":{…}}`=触发
- watcher:逐行 JSON Lines
- service:仅需可探活（端口/健康端点）
监督/限额：沙箱内；CPU/内存/时长/输出上限；崩溃退避重启；日志留存；变更须重登记；`kill` 开关.

#### 2.14.4 唤醒语义
1.`Wake Dispatcher` 定向：默认归属会话（私聊/群/`monitor`）.
2.提示（非用户消息）：触发源/原因/payload/上次动作/预算.
3.走同一轮次管线（档位路由/预评分/上下文）.
4.可选：回消息/写记忆/调工具/再排触发器/无需行动.
5.计入 `routing_log`/`wake_events`/成本.

#### 2.14.5 防滥用与安全
- 每触发器预算：≤6/小时，≤50/天
- 全局：每小时/每天+token 上限
- 静默期：只记录，结束合并
- 去重：窗口内 coalesce 聚一条
- 级联限制：深度上限+kill switch
- 过期：`expires_at` 默认 30 天
- 幂等：同事件不重复唤醒（幂等键）
- 审计：落 `wake_events`

#### 2.14.6 停机与错过触发
`skip`（默认）/`coalesce`（合并+错过次数）/`catch_up_once`（补跑）；面板显示错过次数.

#### 2.14.7 工具与面板
工具：`schedule_wake(spec)`,`cancel_wake(id)`,`list_wakes()`,`register_watcher(spec, program?)`,`wake_now(reason)`.
面板第 7 页"触发器":列表（类型/归属/下次/健康）/监视程序/唤醒历史/预算与静默期/全局暂停.

#### 2.14.8 与 DSH 既有能力的关系
复用：`Agent.followup(message: UserMessage)`(`dsh-agent/lib/types/runtime-types.d.ts:187-192`);`await ctx.sessionController.resolveAgent(sessionId)`(`dsh-api-session-controller/lib/types/agent.d.ts:79`;失败 `session/not-found｜session/agent-busy｜session/writer-held｜gateway/internal`);`await ctx.sessions.flush(agent.session): Promise<boolean>`;`ctx.agents.withoutInitiator(op)`;`Agent.inject`;`ctx.jobs.start`+`dsh-tool-jobs/lib/index.js:263-296`(`settled`→`idle` 则 `followup`,`busy` 则 `inject`;`maxConsecutiveWakes`);domain 落盘+开机重建+`setTimeout().unref()`.
约束：① `createUserMessage` 的 `source` 必填，缺省即 `'user'` ⇒ 须 `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap {…} }` 注册 `forlife:wake`/`forlife:qq`;② 禁用 `ctx.sessionController.prompt()`(`{kind:'user'}` 硬编码);job 事件走 `ctx.jobs.events.subscribe`,非 `ctx.on`.
`dsh-schedule` 不可直接用：只投原会话/无暂停恢复/无跨会话移交/崩溃恢复弱/UI 无表单；本机未挂载（`dsh-web-app` `disabled: true`,`dsh-tui` 无该行，`~/.dsh/storages/` 无 `schedule.json`）；持久化 `<DSH_HOME>/storages/schedule.json`,cron:after/at/every/daily/weekly/5 字段. 依据 `research/wake-scheduling-report.md`.
事件源：有 `agent/status`(idle=起爆点)/`session/*`/`tools/*`/`llm/stream`/`agent/request-error`(`failure: LlmFailure`+`retryPolicy`)/`goal/changed`/`schedule/changed`/`subagent/*`/`fs/*`;无 `sandbox/*`/磁盘告警/provider 心跳/`ctx.on`/QQ 网络 ⇒ 缺口由 `agent/request-error`/`agent/error`/`tools/result`/`settled(failed)` 拼.
边界：进程内仅"唤醒桥":`ctx.webServer.register({kind:'exact', path:'/_forlife/wake', handler})` loopback+密钥（webserver 无 TLS/认证）；职责 `resolveAgent → 判 status → followup(自定义 source) → flush → 回执`+事件反推. 其余入 gateway:① 跨会话/跨用户路由表；② 条件监视器（文件/端口/进程/HTTP/日志）；③ 守护与重启；④ 自写脚本沙箱与配额（`ctx.subprocess` 不沙箱/无 `exec`/`shell`/无自动重启）；⑤ 风暴治理与幂等；⑥ QQ/契约异常源；⑦ 跨 DSH 重启的持久任务表. 原则：注入用 `followup`,时机/对象/次数由 gateway 定.
环境：`dsh-tui` host 层 `disabled: true`(`tool-jobs`/`tool-goal`/`tool-ralph`/`tool-bash`/`tool-pwsh`/`tool-subagent`),由 agent preset 接管 ⇒ 能力判断须查 preset;Windows 沙箱 `danger-full-access`;持久 shell 组（`dsh-terminal*`/`tool-bash-persistent`）关闭 ⇒ PTY 不可用.

#### 2.14.9 唤醒与自唤醒页的交互要求
1.全局默认可改：作用域 `*` 可编辑保存/留痕/审计.
2.会话子窗口（新组件，双入口）：入口"会话与队列"/"唤醒与自唤醒";形态子窗口/抽屉；内容会话键/类型（私聊/群/临时）/最近活跃/消息计数/时区/备注/AI 画像/唤醒规则/生效覆盖/最近留痕/手动配置点位.
3.右键菜单：会话项（子窗口/编辑备注/唤醒开关/复制会话键）；移动端长按同套；菜单项复用子窗口动作.
验收：双入口同源（`/conversations`→`/conversation`）；`conversation_profiles`(0020);`useContextMenu`+`ContextMenu.vue` 同套右键/长按（500ms,>10px;`ConversationPanel`,`ConversationsView.vue`/`WakeView.vue`）；`setWakeRule`+`audit`.

#### 2.14.11 后台补编辑能力 + 右键菜单
需求：后台可写，列表须右键.
`admin-ui` 15 页仅 `api.get`;网关 `/api/admin/*` 6 写接口（`setup`/`login`/`logout`/`password`/`send`/`takeover`）.
- 总览：时间范围|—|只读
- 会话与队列：备注/开关|子窗口|完成
- 接管：批量/标记|已处理|右键待补
- NapCat:登录/重启|按需|待补
- 唤醒与自唤醒：默认|启停|完成
- 记忆：编辑/删除|编辑删除|完成
- 压缩：手动触发|按需|阻塞（§2.14.14）
- 路由：增删改/effort(`none/low/high/max`)|上下移|完成
- 提示词：P1/P2/回滚|回滚|完成
- 表情库：描述/删除|编辑删除|完成
- 媒体：备注/并入记忆|同表情库|待补
- 存储：阈值/清理|按需|待补
- 日志：级别/清空|复制|完成
- 设置：改密码/开关|按需|待补
通用：写操作走 `checkStateChange`(JSON+同源 Origin)→审计；右键/长按与按钮同一函数（`openEdit`/`toggleRule`/`moveRoute`/`removeSticker`）.

##### 2.14.11.1 实施进度
写接口 16 个（首轮 14;400=守卫拒绝非 JSON,401=未登录）：`/wake-rule` `/conversation-note` `/conversation-impression` `/conversation-timezone` `/model-route` `/model-route-delete` `/model-route-move` `/sticker-description` `/sticker-delete` `/memory-entry` `/memory-archive` `/prompt-revision` `/prompt-rollback` `/logs-clear` `/backup-now` `/compaction-request`;通配 `/conversation-*` `/model-route*` `/sticker-*` `/memory-*` `/prompt-*` `/port-*`（白名单 8000–8099,9000 被拒）.
注意：① 根 `pnpm typecheck`(`tsc`) 不查 `.vue`,前端须 `pnpm -F @forlife/admin-ui typecheck`(`vue-tsc`);② 模板元素不得插 `v-if`/`v-else` 链中.

##### 2.14.11.2 收口状态
- 16 个在线（增 `backup-now`/`compaction-request`）.
- 右键覆盖 12 页；未接入：设置页（表单）/总览页（只读）.
- 待补：接管页列表右键；设置页开关.

#### 2.14.12 端点检查 = 连通 + 额度
实现 `packages/gateway/src/quota.ts`:OpenCode Go=`GET {base}/usage`→`usage.rolling/weekly/monthly`(`percent` 已用/`resetsAt`);DeepSeek 官方=`GET https://api.deepseek.com/user/balance`→`balance_infos[].total_balance`（金额）；本地=无额度概念，非不健康；抽样 `ep-opencode-go` `health_ok=1`.
四点：① `percent` 已用→剩余；② 取最低窗口；③ 偏低不拦路由，用尽才不健康；④ 形状变化报 error,查不到≠健康.
扩展：仅加 `QUOTA_PROVIDERS` 一项（id/label/matches/probe）.

#### 2.14.13 后台编辑能力的架构阻塞：插件接口与面板不同源
限制：面板（网关 8081）调 `/api/forlife/*` 全 404;插件 `registerPanelRoutes(registry, runtime)` 注册到 DSH 宿主 fetch 注册表 ⇒ 仅 DSH 加载插件时存在，网关独立运行（一个 Docker 容器） ⇒ 面板不能依赖插件接口；8080=Windows `ApplicationWebServer`.
绕行：`prompt-store`(`packages/dsh-component/src/prompt-store.ts`,287 行) 移入 `@forlife/store` 共用；依赖 `node:crypto`/`node:sqlite`/`@forlife/contracts`/`@forlife/memory-core`/`@forlife/store`;前置确认 `@forlife/memory-core` 是否依赖 `@forlife/store`（若循环 ⇒ `validatePromptText`/`normalizePromptText`/`estimatePromptTokens`/`hashPromptText` 下沉）.

#### 2.14.14 「手动触发压缩」同样被架构阻塞
§2.14.13 波及：`compaction-engine.ts`(`packages/dsh-component/src/compaction-engine.ts`,插件侧，427 行) 依赖 `@deepseek-ai/dsh-agent`,`@deepseek-ai/dsh-compaction-basic`,`@deepseek-ai/dsh-llm`,插件运行时 `activeRuntimes`/`emitForlifeEvent` ⇒ 手动触发暂不可实现，下沉不可行.
路径：① DSH 侧触发，面板写"请求压缩"记录；② 网关"整理型"压缩（仅 DB 合并/沉降，另起名）；③ 内嵌 DSH（不建议）；当前：右键已完成，落地前页面标注"触发需要 DSH 在运行".

---

### 2.15 时间感知

> `research/time-context-report.md`

#### 2.15.1 根因

1. `dsh-time-context` 仅 `dsh-web-app` bundle(`disabled: true`),`dsh-base` 无（`dsh-web-app/cordis.patch.yml:121-123`）。
2. `dsh --profile forlife headless` 不载 web bundle ⇒ 无读数。
3. `refreshIntervalMs`=`600000`(10 分钟；`lib/types/index.d.ts:36-41`)。
4. 措辞日志式：`Time sampled while preparing turn <turn>, step <step>: <timestamp>`。
5. 无 `now()`(`dsh-tools` 无时间工具)。
6. 无浏览器时区 ⇒ 插件要求向用户澄清。
7. 压缩遮蔽；`defer_turn`/自唤醒（§2.14）下 10 分钟不足（§2.2 / §2.3）。
8. 模型先验压过注入读数。
9. 仅绝对时间戳 ⇒ 跨压缩边界易错（§2.3）。

#### 2.15.2 修复方案

1. `profiles/forlife/` 挂载 `@deepseek-ai/dsh-time-context`,`timeZone: Asia/Shanghai`;`disabled: true` 行须 insert。
2. 提示词：未限定时区按 `Asia/Shanghai` 解释、不反问；禁按训练数据/历史时间戳推断；涉时间先取读数或调 `now()`。
3. `now()`:ISO（偏移+IANA）/`YYYY-MM-DD 周日 HH:MM`/相对锚点（上条用户消息，上次交互，上次唤醒）/当天与本周边界。
4. `now()` 为唯一权威时间源。
5. 注入：首步、压缩后必注入；后续步跨 N 分钟（默认 5）或跨日期边界；`defer_turn` 恢复与唤醒轮+距上次交互 Y;空闲后首条必注入。
6. append-only:只进动态尾部。
7. L3 条目与碎片带相对年龄 `[M12] (3 天前) …`。
8. L5 入站消息带发出时间+现在+差值。
9. 唤醒提示三锚：现在/距上次交互/距上次行动。
10. 面板「时间感知」：读数年龄/新读数/注入次数/token。
11. `time_drift`:输出时间表述 vs 真实时间，超阈值记录。
12. 阶段 4 回归集 10 问（现在几点/三天前说过什么/这周几次/距上次多久/跨天判断）；`time-context` 两组对比。

### 2.16 三层时区模型

- `systemTimezone`=记录（DB/审计/日志/会话/压缩/路由）；UTC。
- `conversationTimezone`:会话时区+小时制（12/24）；默认未知。
- `displayTimezone`:显示；跟浏览器，回退 `systemTimezone`。

表 conversation_clock_settings:`scope_kind`(private|group|person),`scope_id`,`timezone`(IANA),`hour_cycle`(12|24),`confidence`(0..1),`source`,`note`,`updated_at`,`updated_by`;PK(scope_kind, scope_id);`source`∈{`user_set`,`model_note`,`small_model_suggestion`,`unknown`}。

工具：`get_clock(scope?)`/`set_clock(scope, {timezone?, hour_cycle?, note?})`/`list_clocks()`。

小模型：复用 §2.7 的 `minimum` 端点（tier+时钟）；`{timezone?, hour_cycle?, confidence}`;低置信度 pending,高置信度落表标 `source: small_model_suggestion`;优先级 `user_set`>`model_note`>`small_model_suggestion`>`unknown`。

渲染：① 双写「`14:23 UTC` = `22:23 Asia/Shanghai`（24h）」；② 存储恒用系统时区；③ 相对年龄与时区无关；④ 未设会话时区不猜不反问，标"（未确认时区）";⑤ 12/24 制只影响表述。

### 2.17 多会话单窗口 + 分级唤醒

#### 2.17.1 单窗口多会话

不拆独立 DSH session:

- 消息带 `[群:XXX / 人:YYY]`。
- 回复 `qq_reply(conversation, text, reply_to?)`,conversation 必填。
- 队列按会话串行+单窗口 ⇒ 多路复用+优先级调度，须排序批处理。
- 压缩阈值随活跃会话数调整；摘要按会话分节。
- 记忆见 §2.17.5。

#### 2.17.2 唤醒条件矩阵

表 wake_rules:`scope_kind`(group|private|person|global),`scope_id`（群号/QQ 号/'*'），`condition`,`enabled`,`probability`(0..100),`min_interval`,`daily_limit`,`quiet_hours`,`note`,`updated_by`(model|admin|system),`updated_at`;PK(scope_kind, scope_id, condition)。

- `private_message` 开 80%
- `temp_message`(`message.private`+`sub_type: group`)开 20%
- `group_mention` `@我` 开 100%
- `group_mention_all`(`at`+`qq: "all"`)开 50%
- 主动 @全体关；放行需显式（`get_group_at_all_remain`+每日预算）
- `group_poke` 开 100%
- `group_message_any` 关；按群开 1–20%
- `reply_to_me` 开 100%
- `keyword` 按规则
- `peer_input_status`（私聊）开
- `peer_status_change`（轮询，见 §2.17.4）关
- `media_received` 开
- `system_event` 分类开关（§2.14）

调节：① `set_wake_rule`(`set_wake_rule(scope, condition, {enabled?, probability?, min_interval?, daily_limit?, quiet_hours?, note?})`)/`list_wake_rules(scope?)`;② 面板「唤醒规则」页同表编辑。

性质：条件互不派生；独立抽样，受 `min_interval`/`daily_limit` 约束；后台改动触发 §2.17.7 告知。

#### 2.17.3 主动阅读

- `read_pending(scope?, limit?, since?)` 拉未读（摘要+原文可选）。
- 待读池有界（按会话 N 条/M 小时），溢出只留摘要。
- 唤醒提示带原因+未读摘要+距上次交互。
- 进中期记忆须带来源会话标签。

#### 2.17.4 QQ 能力核查

- 仅私聊：`set_input_status{user_id, event_type}`(`ChatType.KCHATTYPEC2C`);`notice_type:"notify", sub_type:"input_status", status_text:"对方正在输入..."`。
- 有：`set_online_status`/`set_diy_online_status`/`set_self_longnick`/`get_status`/`get_online_clients`;`friend_poke`/`group_poke`/`send_poke`(`notice_type:"notify", sub_type:"poke"`,`target_id`);`get_friend_list`/`get_friends_with_category`/`get_unidirectional_friend_list`/`get_group_member_list`;`bot_offline`(`tag`,`message`);`friend_recall`/`group_recall`(`message_id`,`operator_id`);`request.friend`/`request.group`+`set_friend_add_request`/`set_group_add_request`;`message_sent`;`group_upload`;`group_increase`/`group_decrease`(`kick_me`,`disband`)/`group_admin`/`group_ban`/`group_card`/`notify/group_name`/`notify/title`/`title`/`essence`;`ocr_image`/`.ocr_image`（§2.9.1）；`download_file`(`thread_count`,`headers`);`fetch_custom_face`;`get_forward_msg`（否则仅 `[CQ:forward]`）；`check_url_safely`;`nc_get_packet_status`(`retcode=1400` 静默)。
- 查询：`nc_get_user_status{user_id}` 按人轮询，默认关。
- 无：群消息免打扰（NapCat 全表无；`group-admin` 仅 `mute-all`/`mute-member`=群禁言，不可冒充）⇒ 系统侧不唤醒/不推送；客户端手动设；协议级 UNCERTAIN（无证据）；好友动态（Qzone）。
- `L4`=消息+@+拍一拍立即唤醒；状态类事件轮询（默认关）；发动态不可实现。

#### 2.17.5 与记忆的关系

统一记忆，不隔离；是否入记忆由模型定（`push_mid_memory`）。要求溯源：条目与摘要带 `source_scope`;摘要按来源分节（`## 群 A`/`## 与 B 的私聊`）；跨会话引用免授权。

#### 2.17.6 在线状态语义

- `model`:模型自报（在线=值班；离开=结束；忙碌=长任务；自定义文案）。
- `system`:模型无法被唤醒或执行时置位（"暂时无法响应（原因）"），对外故障指示。

`system` 触发：① QQ 侧 `bot_offline`/登录态失效/断连/发送确认超时；② 本系统：模型起不来/配置损毁/执行错误/资源类。

分级：`warning`（记录+视情况唤醒）/`degraded`（置 `system`+唤醒）/`down`（置 `system`,唤醒失败用预设文案）；写 `system_events`。

表 qq_status:`scope_kind`,`scope_id`,`value`(online|away|busy|invisible|custom),`custom_text`,`source`,`reason`,`updated_at`,`updated_by`;PK(scope_kind, scope_id)。

- `set_status(value, {custom_text?, reason?})`;模型自设 `source: model`。
- 异常先唤醒模型自设；失败才用 `status_presets`(`set_status_preset(template)` 可改)。
- 系统状态未消除时，设置被拒。
- 阈值：连续 3 次唤醒失败/90 秒无响应 ⇒ 置位；默认文案「暂时无法响应（原因：{reason}，已重试 {n} 次）」，模型可改。
- 恢复：原因消除则清除并唤醒模型（§2.17.7）。

#### 2.17.7 两条铁律

1. 影响模型的后台操作必须唤醒并报告（已醒则注入）。`affects_model`:提示词/时钟/唤醒规则/路由模型/记忆条目/存储路径/触发器启停/端口发布撤销/表情增删/系统暂停恢复/运行模式切换。报告含谁/何时/前后/影响；渠道 `system` 注入，不算人类消息，不受静默期抑制，可合并；例外：纯读取不报，自发不回灌但落审计。
2. 唤醒消息一律系统身份；人类消息单一入口：`forlife:system`（定时器/监视器/异常/后台报告/QQ 事件通知），`forlife:qq`（带会话标签与消息时间），`forlife:admin`（唯一人类直发通道，后台「对话」页）；宿主机制绝不使用 `user`（伪造/省略即人类授权，§2.14.8）；`source` 区分 QQ/`system`/`admin`,仅 `forlife:admin` 具备人类指令地位。

#### 2.17.8 分级与红线

盘点见 `research/napcat-capability-gaps.md`(170 个动作+全部事件)。

A. P0 唤醒条件:

- `bot_offline` 开
- `message_recalled` 开
- `external_request` 开（回应动作默认禁用，见 D）
- `file_received` 开（`media_received` 细化）
- `self_message_sent` 低概率/仅记录
- `peer_status_change` 关（按人轮询）

B. 必补（详 §2.17.4）：`get_forward_msg`,`ocr_image`,`fetch_custom_face`,`download_file`,`check_url_safely`,`nc_get_packet_status`,`get_online_clients`。

C. P1 全并入：成员权限事件（详 §2.17.4），`friend_add`,`get_*_msg_history`,群公告读写（不耗 @全体额度），`set_*_remark`,`get_recent_contact`,`send_*_forward_msg`,`get_group_info*`,`get_collection_list`/`create_collection`,`get_group_shut_list`,`get_group_honor_info`,`can_send_image`/`can_send_record`,可疑好友请求。

D. 需审批（默认禁用+显式放行+审计）：`set_group_kick`,`set_group_ban`,`set_group_whole_ban`,`set_group_leave`(`is_dismiss` 可解散群),`delete_friend`,`set_qq_profile`/`set_qq_avatar`,`bot_exit`,`clean_cache`,请求拒绝类；复用 §2.10 护栏。

E. 安全红线（不实现）：`send_packet`（任意 OIDB 包），`get_cookies`/`get_csrf_token`/`get_credentials`/`get_rkey`/`get_clientkey`（凭据），`.handle_quick_operation` ⇒ `QqTransport` 不建。

#### 2.17.9 送达确认

- 提交 action(echo 关联)后等 `message_sent` 回执（target+时间窗+内容指纹）；3 s 内（窗口可配，默认 3000 ms）`{ok:true, message_id, confirmed:true}`;超时 `{ok:true, confirmed:false, hint:...}`(`get_msg(message_id)` 自查或重试/换方式)。
- 匹配 `target_id`+时间窗；多条用内容指纹；超时不阻塞；连续 N 次（默认 3）超时 ⇒ QQ 侧故障+告警；风险：反向 WS 投递待验证（U-a/U-e），不可靠则退化为短探针或对端回执。

### 2.18 路由表与模型切换

#### 2.18.1 路由表

表 model_routes:`role`（主对话/子代理：角色名/视觉/嵌入/`minimum`（原评分器）/压缩），`order`(0 起),provider,model,reasoning_effort,enabled,note;PK(role, order)。

- 允许 1 个或多个模型。
- 失败/无额度自动降级（限流/超时/鉴权失败/额度耗尽）：按 `order` 降级，落 `routing_log`。
- 轮次内不主动切换；故障降级为被动例外（硬约束），登记 deviation,对齐 temperature/maxTokens(PLAN §8.6)。

#### 2.18.2 自主中途切换

- `switch_model(target, reason, scope?)`,仅主代理。
- 代价：理由必录；N 轮冷却；切换预算（每轮/每天上限）；提示词写明切换成本>委派子代理。
- 生效：写路由表覆盖+`agent/request`;粘性基线（§2.7.3） ⇒ 每 step 重新断言。
- ★ **生效口径（每轮路由）**：写 **`ModelSelectionRef.current`** —— 宿主对该字段的定义是「**为下一个进入提示装配的 step 选择的模型**」。**不得**用 `agentDefaultModel.saveSelection()` 做每轮路由：那是**持久默认值**，每轮调用会污染配置；该方法只留给人工/后台（§2.20.3）。
- 可逆：可撤销覆盖（TTL/"直到本轮结束"）；审计落 `routing_log`（发起方/原新模型/理由/代价/效果）。

#### 2.18.3 子代理的模型

- 子代理不得自切：无 `switch_model`+运行时断言（绕过即拒）。
- 主代理可指定异构模型：`ctx.subagents.start(name, { agentOptions: { provider, model, reasoningEffort } })`（§2.7.3）。
- 经济学：切换成本>委派成本。

#### 2.18.4 模型自助工具与轮末建议

主模型需要两个**自助工具**，以及一条**轮末建议**通道（均属中介层接线范围，§2.20.4）：

1. **自助切换**：主模型自己决定换模型 —— 走既有 `switch_model` 语义（理由必录、冷却、预算），但**必须真落到 `ModelSelectionRef.current`**（不是写持久默认值）。
2. **决定子代理用哪个模型**：主模型在分派时指定异构模型（`ctx.subagents.start(name, { agentOptions })`，§2.7.3）；子代理仍**不得自切**（§2.18.3）。
3. **轮末建议下次模型**：允许主模型在结束本轮时**建议下次使用什么模型**。建议的落地形态（自动采纳 / 需满足置信度 / 仅登记待人工确认）**待定**；无论哪种形态都须写 `routing_log` 并留理由。

> 现状：`packages/router/src/initial.ts` 文件末尾已登记这三项为 TODO，**尚无生产调用点**（接线守卫待补，§5）。

---

### 2.19 手动喂食记忆

需求：支持手动向模型喂入记忆资料，四条入口 + 一个模型工具；导入时以参数选身份（`--as knowledge` / `--as experience`），全部走真实沉降路径；完整版含分块、去重、增量更新、来源追踪、删除 / 重导。分块与去重属于记忆系统自身能力，删除依附既有记忆管理，不新造召回代码。

**A. 入口**（共用核心函数 `feedMemory(db, { items, as, source, dryRun })`，`@forlife/gateway`）：

1. 文件 / 目录扫描：`node scripts/feed-memory.ts <路径>`（递归，只认 `.md` / `.txt`）→ `scripts/feed-memory.ts`
2. 命令行文本：`node scripts/feed-memory.ts --text "…"` → 同上
3. HTTP：`POST /api/forlife/feed`（DSH 面板侧）/ `POST /api/admin/feed`（主后台侧）→ `dsh-component/src/api.ts` / `gateway/src/admin/api.ts`
4. 管理后台「喂食记忆」页（粘贴 + 预览 + 结果明细）→ `admin-ui/src/views/FeedView.vue`
5. 模型工具 `feed_memory(as, content/items, summary?, source?, entities?)` → `dsh-component/src/feed-tools.ts`

守卫：`tests/feed-entries-wiring.test.ts`（入口里出现写入原语即红）。两条 HTTP 路径分挂两个进程（DSH 面板 / gateway 主后台），鉴权不同（宿主 Host/Origin 栅栏 vs 管理口令会话），而 DSH 官方 Web UI 不经 Caddy 暴露（§2.12）⇒ 后台页面够不着 `/api/forlife/*`；两条路径同一函数、同一张表，不是两条管道。

**B. 真实路径**：`knowledge` → `insertLongEntry`（长期记忆）：FTS（`segmentForFts` 中文切分）、HDD 沉降、归档 / 恢复、面板编辑；`experience` → `appendMidEntry`（中期记忆）：渲染修订号（进 L3 窗口）、压缩、碎片化与淘汰。

**C. 刻意不做**：复杂分块 → 只按空行 / 标题做最朴素段落切（`splitIntoFeedChunks`），过长段落交给既有压缩 / 碎片机制（PLAN §4.2 / §5.3）；内容指纹索引表 → 复用既有 FTS（`searchLongFts` / `searchMidFts`）取候选 + 与 recall 同一份 `textSimilarity`（阈值 `feed.dedupeSimilarity`）；新删除接口 → 面板「记忆条目」按 `feed:…` 过滤后归档，或 `POST /api/admin/memory-archive`（归档不是真删）。

**D. 来源追踪与增量更新**：来源记在既有列 `source_scope`（`feed:<来源>`），不加字段 / 表 / 迁移；条目 id 由「来源 + 段落序号」稳定派生（`feedIdFor`）⇒ 同源重导是更新而非新增；长期记忆重导变短 ⇒ 多出段落交给既有 `archiveLongMemory` 归档（可恢复）；中期记忆只追加（无 update 原语）⇒ 内容变更以新 id 追加新版本，重复喂同一版判为「已喂过」。

**E. 参数登记**：`feed.dedupeSimilarity`=0.9（与 `recall.duplicateSimilarity` 同量级、同算法）/ `feed.dedupeCandidates`=5 / `feed.probeChars`=24 / `feed.summaryMaxChars`=120 / `feed.maxItemsPerCall`=200（单次喂食段落数上限，CLI / HTTP / 工具共用）。

---

### 2.20 中介层（模型目录 · 初始路由 · 取数层）

定位：路由层不只接入自研的新版 go 接入点，也对接**宿主原有的那一大批接入点**，随后才发生模型调用。**本系统是插在「接入提供方」与「实际调用位置」之间的中介层**。

```
[ 接入提供方 ] ── listProviders() / listModels() ──▶ 模型目录（表 + 标记 + 简介 + 可达性）
                                                        │
   轮次输入 ─────────────────────────────────────────────┤
                                                        ▼
                                              初始路由（定档 → 选模型）
                                                        │
                                                 ModelSelection
                                                        ▼
[ 实际调用位置 ] ◀── 写 ModelSelectionRef.current
```

#### 2.20.1 三块组件与接线现状

| 模块 | 职责 | 测试 | 生产接线 |
| :--- | :--- | :--- | :--- |
| `packages/router/src/catalog.ts` | **模型目录**：把宿主给的 provider/model 整理成决策表；每行带**标记**（`local` / `free` / `vision` / `native` / `ours` / `account`）、**简介**、**可达性**与不可达原因 | `packages/router/test/catalog.test.ts` | 由取数层喂入 |
| `packages/router/src/initial.ts` | **初始路由**：守卫 → 预评分（接口已留、**未接**）→ 启发式定档，再从目录里挑一个**可达**模型；**选模型与定档分离** | `packages/router/test/initial.test.ts` | **尚无调用点**（§2.20.4） |
| `packages/dsh-component/src/llm-host.ts` | **取数层**：从宿主 `llm` 服务取 `listProviders()` / `listModels()` ⇒ `buildCatalog()`；单个 provider 失败不影响整表 | `packages/dsh-component/test/llm-host.test.ts` | 已接：`src/index.ts` 启动时调用，目录与标记落日志；`catalog-wiring.test.ts` 守卫 |

规则：标记是**启发式推出来的** ⇒ 规则要窄（宁可少标、不要标错 —— 标错一个 `local` 会让小模型把远程模型当本地用）；**简介只来自宿主**（`name` / `description`），没有就留空、不编。

可达性口径：取数层给的是**能立刻判断的那一种** —— 枚举不出模型 / 枚举抛异常 ⇒ 标不可达并记原因。**更深的可达性（真发一个请求）不在取数层做**（要么花钱要么慢），由独立的**心跳/探测**产出并经 `unreachable` 传入。

#### 2.20.2 输入约束（用户定）

初始路由**不吃全部上下文**：不用特别关心记忆的内容，只需要三样 ——

1. **轮次输入**（这一轮说了什么）
2. **模型表**（条目 + 标记 + 简介）
3. **各模型当前可达性**

⇒ 初始路由因此可以在轮次开始前跑完，不依赖记忆内容；记忆的召回交给后续档位与工具。

#### 2.20.3 宿主接口（从容器内 `.d.ts` 读出，非推测）

- `ctx.get('llm')` → `listProviders(): LlmProviderInfo[]`、`listModels(provider): Promise<LlmModelInfo[]>`
  - `LlmProviderInfo = { id, name }`
  - `LlmModelInfo = { provider, id, name, description?, inputModalities? }`
- `ctx.get('agentDefaultModel')` → `currentSelection(): ModelSelection`、`saveSelection(next): Promise<void>`
  - `ModelSelection = { provider, model, reasoningEffort? }`
- ★ `ModelSelectionRef`（`dsh-agent` 类型）：`{ current: ModelSelection | undefined, assembled: … }`；`current` 的定义是「**为下一个进入提示装配的 step 选择的模型**」

**⇒ 生效口径**：每轮路由写 **`ModelSelectionRef.current`**；`agentDefaultModel.saveSelection()` 写的是**持久默认值**，每轮改它会污染配置 ⇒ 只留给人工/后台（§2.18.2）。

#### 2.20.4 待接线清单

1. `initialRoute()` 接进启动/轮次路径：取数结果 → 目录 → 初始路由 → `ModelSelectionRef.current`。
2. `minimum` 预评分：部署 Qwen2.5-0.5B（§2.13.3）后，以 `renderCatalogForPrompt(catalog)` 为上下文、`turnText` 为问题，输出档位 + 置信度，作为 `preScore` 传入；未接时走启发式。
3. 模型自助工具：主模型自助切换、主模型决定子代理用哪个模型（§2.18.4 ①②）。
4. 轮末建议下次模型（§2.18.4 ③）；落地形态待定。
5. `packages/router/src/deploy.ts` + `download.ts` 接上线：`minimum` 的**自动部署能力**（§2.13.3）。

每一项新接线都配**接线守卫测试**与**回退验证**（§5）。

---

## 3. 关键技术决策与不确定性

未标注 = 已定项

- D1 记忆引擎 = 可移植 dsh-std 组件
- D2 压缩 = `ctx.compaction`（单 summary）
- D3 记忆表自持 `node:sqlite`（WAL+FTS5），非 `ctx.storageDomain`
- D4 向量后端 LanceDB（默认），`VectorIndex` 可插拔
- D4b 表情检索复用同库（描述/情绪标签/OCR）
- D5 后台混合：面板内嵌 DSH Web，QQ 运维独立
- D6 轮次驱动 spawn CLI：`dsh --profile forlife headless --json` → U2
- D7 gateway 与 core 共享 SQLite（表级单写者）
- D8 L2/L3 段位 = `order 100 / 110`
- D9 缓存断点 = 位置契约+字节稳定性测试
- D10 工具用 `defineTool`：`output` 必填、`render()`→`ContentBlock[]`
- D11 审批走 `tools/pre-execute`；无 `ctx.approval` 则 deny
- D12 设置页 = Cordis `Config` + `.volatile()`
- D13 事件入 `SessionEventMap`；信息类 `ignorable?: true`
- D14 路由按 `模型路由.MD`：守卫→L1 小模型评分（50 ms）→兜底
- D15 评分/推理统一 `InferenceEndpoint`（四来源×四模式）→ U8/U16
- D16 提示词与风格分层可编辑（版本/diff/回滚）
- D17 图片按视觉能力分流 + 结构化描述桥接
- D18 出口走 Caddy 动态配置 + layer4，白名单/审计
- D19 不假设 GPU：CPU+量化（R7 430 亮机）
- D20 预评分软预算 ≤800 ms；同步 50 ms 硬超时；deviations
- D21 运行模式可热切换（resident/on-demand/remote-api/host-native）
- D22 加速后端多态（`cpu`/`cuda`/`rocm`/`vulkan`/`sycl`）；本项目跑 `cpu`（U17）
- D23 部署双路（`local-docker`/`remote-ssh`）：dry-run/回滚
- D24 触发引擎放 gateway（进程外）
- D25 监视程序三契约（probe/watcher/service）+ 限额/可 kill
- D26 唤醒六道闸：预算/静默期/合并/级联深度/过期/幂等
- D27 挂 `dsh-time-context` + 自研注入替代 10 分钟节流
- D28 `now()` = 唯一权威时间源；禁训练先验
- D29 三层时区（system=UTC/conversation=语境/display=面板）+ 会话时钟表
- D30 多会话单窗口：会话标签/回复指路/摘要分节
- D31 唤醒条件矩阵：开关/概率/最小间隔/每日上限/静默期
- D32 路由表有序，失败/无额度按序降级
- D33 主模型可自切但代价高（冷却+预算）；子代理不得自切
- D34 统一记忆：`source_scope` 溯源 + 摘要分节
- D35 QQ 在线状态 = 工作状态通道（`model`/`system`）
- D36 铁律：`affects_model` 后台操作须唤醒报告（60 s）；禁 `user`
- D37 路由层 = **中介层**：插在「接入提供方」与「实际调用位置」之间；模型目录（标记+简介+可达性）+ 初始路由（定档与选模型分离）+ 取数层；输入只要**轮次输入 / 模型表 / 可达性**（§2.20）
- D38 `minimum` = **唯一的超小模型层级**（原 `scorer`，不作为用途标签）：复杂度评分 / 路由决策 / QQ 工具决策 / 工具内低阶智能决策源；**只在需要的地方接，不是每个工具都接**（§2.6 D）
- D39 **接线纪律**：新接线必须同时交付「读源码断言调用点」的**接线守卫测试**与**回退验证**（对治第 18 类缺陷：库写好、单测绿、生产零调用）（§5）

- U1（关闭）缓存指标 `TokenUsage.cacheReadTokens/cacheWriteTokens`
- U2 长连接驱动（D6）：阶段 3 三驱动×100 轮
- U3 嵌入来源（远端 API / 本地 ONNX）：阶段 5 决策
- U4（已解决）`ui.dsh` 承接方（slot / 独立 UI 包）
- U5 版本漂移（`compat.hosts`）：升级跑契约测试，见 `research/dsh-plugin-authoring-reference.md`
- U6 缺测试工具链（`@deepseek-ai/dsh-test*`/`./testing`）：靠 `boot()`、`createMemoryConnectionPair()`
- U7（部分关闭）NapCat 免图形（WebUI `:6099`）；SnowLuma 需 Xvfb+VNC+noVNC+`SYS_PTRACE`/`seccomp=unconfined`；阶段 3 实测
- U8 `minimum` 形态（本地/外挂/云/宿主）× 纯 CPU PVE VM：阶段 5×500
- U9（关闭）视觉：`inputModalities`/`ctx.attachments.saveImage`/`agent/pre-step`/`resolveModelInfo`；`research/vision-modality-report.md`
- U10（关闭）Caddy：`POST .../routes`/`DELETE /id/<id>`/`PUT .../routes/0`/`POST /load`；`research/caddy-sandbox-ports-report.md`
- U11（关闭）`ctx.subagents.start(name, { agentOptions })` → provider/model/reasoningEffort；`research/subagent-model-routing-report.md`
- U12 附件限额（20 MiB/20 张/64e6 像素）：阶段 6 实测
- U13 failover 须自研（仅同 provider 重试）：阶段 5 故障注入
- U14 preset `plugins[]` 寻址（`SettingsPathOp.path`）：阶段 5 实测
- U15 DSH Web UI 公网可达（cookie 绑 `Host`）：阶段 9 实测
- U16 纯 CPU `Qwen2.5-0.5B-Instruct`（Q4/Q5）延迟/内存：阶段 5
- U17 `cuda`/`rocm`/`vulkan`/`sycl` 镜像（无 GPU）：阶段 5 只验 `--dry-run`
- U18 远程 SSH 部署：阶段 5 先 `--dry-run` 再全量
- U19 既有调度/`dsh-webhook`/goal 复用度：`research/wake-scheduling-report.md` → §2.14.8
- U20 `dsh-time-context` headless 是否正常/重复注入：阶段 4 实测
- U21 `minimum` 参与工具决策（QQ 工具 / 子代理分派）与「轮末建议下次模型」的收益与误判率：阶段 5 实测

---

## 4. 分阶段执行计划

> 状态以代码与单测为准；环境结论见 §8；现状见文首。

### 阶段 0 · 可移植骨架与验证台

- 目标：不改本机 DSH，一键起、跑通空插件
- 交付物：monorepo+TS/lint；`packages/contracts`(`dsh-plugin.json`)；`profiles/forlife/`(`cordis.yml`/`cordis.patch.yml`/`dsh.profile.bundles`)；`packages/dsh-component`；`createMemoryConnectionPair()`/`boot()`；`deploy/docker-compose.yml`；`scripts/dev-up.ps1`/`dev-up.sh`/`forlife doctor`
- 依赖：无（U6）
- 验收标准：① `scripts/doctor.ts` 12 项 0 失败 ② Compose v2.13.0 通过 + `tests/portability.test.ts` 断言无 `~/.dsh` 写 ③ 无宿主协商（`packages/dsh-component/test/harness.test.ts`）④ `--dump-config` 95 条目 0 告警 ⑤ `dsh-tui`/`dsh-web` admission 组合级
- 状态：已完成

### 阶段 1 · 记忆骨架

- 目标：三张表 + 渲染 + 最小工具集 + 面板雏形
- 交付物：`packages/store`(`node:sqlite`/`busy_timeout`/`foreign_keys`；`user_version`/原子备份/只前滚；`mid_memory_entries`/`long_memory_entries`/`compaction_log`=PLAN §2.1/§4.5/§6.1+`revision`/`source_scope`/`0002_spill`)；`packages/memory-core`(`renderMidMemory()`/同事务追加)；`packages/dsh-component`(`forlife:l2-index` order 100/`forlife:l3-mid` order 110；`remember`/`push_mid_memory`/`recall_longterm`/`recall_full`；`output.schema`+`render()`；`SessionEventMap`+`ignorable: true`；`Config`+`.volatile()`)；面板（`/api/forlife/{state,entries,compaction,spills,health}`/`packages/dsh-component/client/index.js`/`forlife-memory/panel`）；`pnpm typecheck` 0 错误
- 依赖：阶段 0 + U6
- 验收标准：① `push_mid_memory` 后下一轮 prompt 出现条目（A1） ② 3 轮无写入 SHA-256 不变（A2） ③ kill -9 重启逐字节一致（A3） ④ 面板按 `epoch`/`status` 过滤（A4）、`/health` 200 ⑤ `client.test.ts` 8 项覆盖契约
- 状态：已完成；浏览器 React 未验证，见 §8
- 约束：FTS5 中文切字；FTS 独立表（`'delete'` 空串损坏）；`.volatile()` 经 `resolveConfig()`；fetch path 含 `/api`；`ctx.inject(['connection'])` 静默失效→独立行；`inject`=服务名（`dsh.client.inject`）

---

### 阶段 2 · 压缩与沉降

- 目标：两段压缩解耦；约束生效；可审计.
- 交付:
  1. `ForlifeCompactionEngine extends BasicCompactionEngine`:`summarize`/`summarize()` 覆写，余用 `CompactionEngine`(`super(ctx, "compaction")`);profile `forlife`/`forlife-headless`/`forlife-web`:`compaction-basic`>`disabled: true`/`forlife-memory/compaction`.
  2. `ctx.llm.stream()`(`purpose:'compaction'`/`tools`/`toolHistory`/`signal`);§4.2 `push_to_mid`/`keep_in_short`/`fragment_mid`/`reasoning`;`SummarizationInput.messages` 重放，指令置尾；`forlife:compaction-instruction`.
  3. `request_compaction`/`decideCompaction()`（§4.4）：拒绝 `{approved, reason, current:{tokens,turns,tool_calls}, required:{...}, hint}`(`hint` 逐字段);码 `too_frequent`/`token_threshold`/`context_pressure`;豁免 `token ≥ 6000`/≥75%;`compactIfNeeded`+`context-overflow`(`callId`/`deferContext`).
  4. `runtime.settle()`（不调模型；90 天/占比）+`fragment_mid`;`memory-core/planFragmentation`/`makeFragmentHint`(≤80 token/entities ≤5/≤50 条/≤20%).
  5. `compaction_log`（§4.5）/`forlife.compaction.committed`(`ignorable: true`)/`effects` 0004(`affects_model`/`reported`/`listUnreportedEffects()`)/`compaction_runs` 0003(`started`>`committed`/`aborted`/`recoverPendingCompactions()`).
- 依赖：阶段 1 存储层/迁移（0003/0004）.
- 验收:
  - L3 新条目/L4 单摘要（`frameSummary`>`content`/`user/message`;`content: frameSummary(summaryResult.summary)`）/未命中一次（`acceptance-phase2.test.ts`/`dsh-system-prompt`）.
  - 拒绝 == §4.4(`1200`/2/3)/两条豁免.
  - `kill -9` 回滚/幂等（`store/test/compaction-runs.test.ts`）.
  - `[F1→]` 碎片/`recall_longterm` 全文.
- 状态：已完成。限：压缩未跑（无 key;`summarizeWithLlm`）；`compactNow`/`compactRegion` 未测；强模型摘要待 5.`dsh --profile forlife-headless` 日志：`[forlife] 压缩引擎已挂载（ctx.compaction = ForlifeCompactionEngine）`;`[x]`/`[~]`/`[ ]`.

### 阶段 3 · QQ 集成

- 目标：真 QQ 进出/可观测/可恢复.
- 交付:
  1. `packages/gateway`:`QqTransport`+OneBot v11 反向 WS(`127.0.0.1`:`3080`);`qq_inbox`/`qq_sessions`/`qq_turns`/`qq_outbox`;防抖/per-key mutex.
  2. `driver.ts`:`headless --json`/长连接/`driver.kind`/`TurnDriver`.
  3. 工具 9:`qq_reply`(`qq_reply(conversation, …)`)/`qq_react`/`qq_typing`/`defer_turn`/`read_pending`/`set_wake_rule`/`list_wake_rules`/`set_status`/`clear_system_status`.
  4. `wake_rules`:`group_message_any`/`group_mention`/`group_poke`;`min_interval`/`daily_limit`.
  5. 白名单；`@我`/拍一拍/`@全体` 不判.
  6. 标签+调度/批处理；类型入库（迁移 7）；去 `private`.
  7. `admin_actions`(`effects`)+`affectsModel()`+60 秒报告；`MessageSourceMap`(`forlife:system`/`forlife:qq`/`forlife:admin`);`createForlifeMessage` 断言 `source.kind === 'user'`/`user` 非法；`admin_chat`（迁移 8）.
  8. `set_status`+`system` 故障态（`locked_by_system`）；`source_scope`(`remember`/`push_mid_memory`)只溯源不隔离.
  9. `reclaimStaleOutbound`(`sending`>30 秒)/`waitForConfirmation`(`confirmed:true`+`message_id`/3 秒 `confirmed:false`)/`send_group_msg`/`send_private_msg`.
  10. `mention-quota.ts`(`decideMentionAll`/`decideWithLedger`/`getAtAllRemain`)>`gateway.ts`(`mentionAll()`/`mentionLedger.sent += 1`/`recordEffect`);`mention_all` 拒（`can_at_all=false`）；`group_id`+账号取 min;`MENTION_TOOL_NAMES = ['qq_mention_all', 'qq_group_notice']`;`notice`>`transport.groupNotice()` 免检（`transport`）.
  11. `/admin`/`/api/forlife/qq/*`/`/api/forlife/admin/chat`(`Last-Event-ID`>9;`set_remark`>4;5 秒轮询);`deploy/docker-compose.yml`(`qq`/`get_login_info`).
- 依赖：阶段 1 存储层/阶段 2 压缩.
- 验收:
  - 崩溃自愈（`kill -9`）/跨会话并行/同会话串行/多会话不饿死（`gateway.test.ts`/`outbox.test.ts`/`scheduler.test.ts`/`timing.test.ts`）.
  - 三条件互不派生/唤醒率（私聊 80%/`@全体` 35–65/@我 100）/限流码（`wake.test.ts`/`qq-tools.test.ts`;<0.8）；`@全体` 额度闸门；来源纪律/后台报告（`admin_actions.reported`/`affects_model=1, reported=0`）/状态双源/溯源不隔离/送达确认（`glue.test.ts`/`reports.test.ts`/`admin-chat.test.ts`/`admin-api.test.ts`/`turns.test.ts`）.
  - 3 秒回复/5 条合并/3 次 `qq_reply`>3 段：部分（假端）；故障态自动清除/送达超时判故障：未接线（阶段 8）.
- 状态：进行中（联调待做）.`forlife-qq`/`doctor`/`onebot.test.ts`.

### 阶段 4 · 提示词与缓存

- 目标：提示词/风格可编辑不破前缀缓存；模型有钟.
- 交付:
  1. `forlife:p1-system`(100)/`forlife:p2-style`(110)存库；L2/L3>120/130(`prompt.ts`).
  2. `prompt_revisions`(slug 唯一 active)+SHA-256+白名单+试渲染+回滚（只改 active）+P2 会话覆盖；`/api/forlife/prompts*`;迁移 9.
  3. `scripts/lint-prompt-positions.ts`(order 区间/前缀动态 `Date.now`/`nowIso`/`timeContext`)>`doctor`/`pnpm lint:prompt`;`tests/prompt-contract.test.ts`;`assemble()`/`renderPrompt()` 哈希.
  4. `assistant/message`(`usage`)>`/api/forlife/cache`;`inputTokens`=未命中；`提示词总 token = input + cacheRead + cacheWrite`;`命中率 = cacheRead / 该总和`(`dsh-token-meter`/`usageTokens()`);`judgeCache()`.
  5. `memory-core/clock.ts`(`Intl`)/`now()`/事件注入/读数入尾（`turns.ts`）/`dsh-time-context`(30 分钟)/`time_readings`/`time_drift`(`14:23` 类，warn 以上).
  6. `systemTimezone`/`conversationTimezone`/`displayTimezone`/`conversation_clock_settings`/`get_clock`/`set_clock`/`list_clocks`;优先 `user_set > model_note > small_model_suggest`(`user_set > model_note > 小模型建议`);`clock_suggestions` 仅通道.
  7. 回归 10 题/两组对比 `scripts/time-regression.ts`.
- 依赖：阶段 1 存储层（迁移 9/12）/阶段 2 压缩.
- 验收:
  - 改 P2 次轮生效/哈希变一次+20 轮稳/回滚回旧值/会话覆盖隔离/未声明变量报错/20 轮无写入恒定（`prompt.test.ts`/`prompt-text.test.ts`）.
  - 压缩/唤醒/长空闲后读数 < 30 秒/读数不入前缀（`clock.test.ts`/`clock-wiring.test.ts`/`after-idle`）；时区+优先级+12/24 制（`sourceRank()`）；token 误差 ≤2%/未命中数 == 压缩数+编辑数/10 题对比：未验（需凭据）.
  - 路由降级/切换代价/子代理不可自切：移至阶段 5.
- 状态：进行中；`cache-metrics.test.ts`/`cache-collector.test.ts`/`time-drift.test.ts`.

### 阶段 5 · 路由、视觉与多模型

- 目标：按难度选档/降级；任意模型读图；子代理独立.
- 交付:
  1. `packages/router` 三层（§5.1）：守卫 8 条（上限 10/超出报错）；L1 三后端共用 `TierScorer`;系统提示无动态内容（§8.1）；启发式 §5.4.
  2. 供应（§2.13）：`InferenceEndpoint`+`inference_endpoints`（迁移 14）；四来源x四模式；五后端参数（cpu/cuda `--gpus all`/rocm `kfd`+`dri`/vulkan·sycl）；探测 cuda>rocm>sycl>vulkan>cpu;`planDeploy`/`--dry-run`;续传 `.part`+SHA 重下；逆序回滚.
  3. 评分：严格 JSON+50 ms 降级；`RULE_DEVIATIONS`(50 ms/800 ms);`routing_log`+`uncertain_cases`（迁移 13）；T15>阶段 8（§2.15/§2.18）.
  4. `reasoningEffort` 按档；`lockTierForTurn`/`assertTierForTurn`;`agent/request-error`>`agent/request`（幂等/一步一换）；`Debouncer`/`onWindowOpen`/`routeBatch`.
  5. 视觉（§2.7.2）：三态（`undefined ≠ 不支持`）；复核+`ocr-unverified`/`source: ocr-unverified`;`attachmentId` 缓存；`vision-bridge.ts`;`agent/pre-step` 未接.
  6. 角色档位（`assignSubagent`）；`model_routes` 降级；`switch_model`/`decideSwitch`;禁自切.
  7. **中介层接线**（§2.20）：`initialRoute()` → `ModelSelectionRef.current`；`minimum` 预评分（部署后接 `preScore`）；模型自助工具 + 轮末建议（§2.18.4）；`deploy.ts`/`download.ts` 接上线做 `minimum` 自动部署 —— 每项配**接线守卫测试**（§5）.
- 依赖：阶段 3 轮次管线/阶段 4 提示缓存.
- 验收:
  - 置信度 < 0.6 升档；拦截率 50.0% ∈ §5.2 的 40–60%(`router.test.ts`/`guards-rate.test.ts`).
  - 小模型部署四条（`deploy.test.ts`）；换外挂端点路由不变；后端参数+非法组合拦（`endpoints.test.ts`）；同轮 provider/model 恒定/子代理模型可区分.
  - 模式切换（在途不断/失败回滚/状态未知）(`mode-switch.test.ts`);OCR 复核+标记（`vision.test.ts`）；同图第二次 0 次视觉调用（`vision-cache.test.ts`/`vision_call_log`）；桥接链路（`vision-bridge.test.ts`）.
  - 降级/切换代价/禁自切：自阶段 4 移入（`failover.test.ts`/`failover-wiring.test.ts`/`router-tools.test.ts`/`subagents.test.ts`）.
  - 200 条语料回放（构造 50.0% 在带内/口径「面向机器人」）：部分；本地 p95 < 30 ms（真竞速/< 150 ms）：部分；远程部署/按需停唤醒/真模型读图/双路径对比：部分（待环境）.
  - 中介层（§2.20）：宿主某 provider 枚举失败时目录**不空表**（单点抖动不遮蔽其它接入点）；可达集合变化时**只换模型不改档**（`initial.test.ts`）；每轮路由**不写持久默认值**（守卫断言 `saveSelection` 不被每轮调用）；新接线有守卫测试 + 回退验证.
- 状态：进行中（真机待做）;中介层已实现三块、接线待做（§2.20.4）.

### 阶段 6 · 表情包与媒体发送

- 目标：表情入库/检索/发送；私有媒体入记忆；广播受额度约束.
- 交付:
  1. `sticker_assets`/`sticker_descriptions`;sha256 去重+LRU;`add()` 复用；LanceDB.
  2. 水印闸门：视觉判定；未配/失败/抛错均拒.
  3. `sticker_search`/`qq_send_sticker`/`sticker_import`/`sticker_save`/`qq_mention_all`/`qq_group_notice`;签名 `sticker_search(query)`/`qq_send_sticker(id | query, reply_to?)`;`image` 段/`upload_group_file`/`upload_private_file`.
  4. `media_assets`+`long_memory_id`;`media_save`>`recall_longterm`/`recall_media(id)`(`recall_longterm("那张架构图")`);与表情检索分离；写入/检索待接.
  5. 后台「表情库」页（`client.test.ts`）.
  6. 补货：匹配则不抓/白名单前置/每轮上限/fail-closed.
- 依赖：阶段 3 出站/阶段 5 视觉.
- 验收:
  - top-1 ≥ 8/10（词法）/重复下载不新增行/文字+表情+文件同轮（`OutboundSegment`）：部分；非法来源/超大/非法类型拒/无垃圾行；同表情 0 次视觉调用/`scopes` 累积.
  - `ours=false` 入库后复用/默认不转发；`@全体` 闸门/`group_notice` 独立.
  - 私有媒体检索：未完成.
- 状态：已完成；未决：搜索源.`max_tokens` 300/400>正文空串（HTTP 200），默认 2000;被拒图复活（`scopes`/`status`）；额度取两维 min.

### 阶段 7 · 沙箱工作区与端口出口

- 目标：边界可控；出口可 TTL 回收.
- 交付:
  1. `workspaceRoot`+宿主沙箱接线.
  2. `publish_port`/`unpublish_port`/`list_ports`+`published_ports`.
  3. Caddy 客户端：`@id`/幂等 upsert/删除/TTL.
  4. 出口 `https://<host>/svc/<name>/`/`layer4`.
  5. 白名单（18000–18099）/人工批准/`audit`(`ok:false`)/后台页.
- 依赖：宿主沙箱接口/阶段 1 存储层.
- 验收（全过）：发布可访问/取消即 404;`layer4` 打通（11/11）；非白名单 `9999` 被拒+审计；TTL 回收后 `GET /config/` 无残留.
- 状态：已完成（见 §6.4）；`--no-cache`.

#### 2.14.15 阶段 7 真机验收（Caddy v2.11.7）

- 验收：发布 `HTTP 200 "backend-ok path=/"`/取消 `HTTP 404`/`9999` 拒且无残留路由/`reclaimed=["ttl"]` 无 `forlife-svc-*`:全过.
- 约束：`.runtime/Caddyfile.e2e`/`.runtime/caddy-bin/caddy.exe run --config .runtime/Caddyfile.e2e`/`node packages/gateway/scripts/e2e-ports.ts`/`packages/gateway/scripts/e2e-ports.ts`/`CADDY_ADMIN`/`docs/deploy/PVE_DEPLOY.md`;`PUT /config/…/routes/0`(`PUT /id/<新id>`/`/id/` 无效);`Origin: <完整 origin URL>`(`client is not allowed to access from origin ''`;`host:port`/`Host`/`fetch` 无效);`createPortService`/`FORLIFE_PORT_WHITELIST`;无匹配默认 200:兜底 404;端口 `2019`/`12019`(1902–2001/11908–12107)>`13019`(`netsh interface ipv4 show excludedportrange`);`curl --ssl-no-revoke`.

---

#### 2.14.16 TCP 出口（layer4）

状态：已完成；真机 11/11（Caddy v2.11.7 + `layer4`，xcaddy）。脚本 `packages/gateway/scripts/e2e-ports-tcp.ts`；配置 `.runtime/Caddyfile.l4`。

交付物：`packages/gateway/src/caddy-tcp.ts`（`buildTcpRoute` / `tcpServerName` / `caddyTcpRouteId`）；`packages/gateway/test/caddy-tcp.test.ts` 4 例；`deploy/caddy/Dockerfile.forlife`（xcaddy 编入 `caddy-l4`，入口 `--resume`）。

约束：TCP 无路径信息 ⇒ 每服务独占对外端口；白名单判 `listenPort`，对外端口唯一（重复即拒）；server 名带端口 `forlife-l4-<port>`。

限制：①配置 API 不穿不存在路径，`layer4` 须先建父路径，否则 500（`invalid traversal path`）；②matcher 全协议专属，`layer4.matchers.tcp` 不存在，通用 TCP 不写 `match`；③删除后须列全量确认（`GET` 单条回 200 会误判）；④Caddy 须自建、升级须重建，不自建仅 HTTP 出口。见 `docs/deploy/PVE_DEPLOY.md`、`docs/notes/`。

待办：①构建镜像 `docker build -f deploy/caddy/Dockerfile.forlife -t forlife/caddy-l4:2.11 .`；②`port-service` 接 TCP；③迁移加 `listen_port` 列（唯一）；④真机复跑。

### 阶段 8 · 触发与自唤醒引擎

- 目标：按时间 / 条件自唤醒，复用同一轮次管线自主执行一轮（工期 6–10 天）。
- 交付物：①触发引擎 `timer` / `watcher` / `system` / `external` + `wake_triggers` / `wake_programs` / `wake_events`；②`wake-prompt` / `wake-bridge` / `wake-bridge-endpoint`；③监督器 `probe` / `watcher` / `service`；④事件订阅九类 ⇒ `system`；⑤六道闸 `decideWake`（深度 3、`0`＝不限）；⑥`schedule_wake` / `register_watcher` / `list_wakes` / `cancel_wake` / `wake_now`；⑦面板第 7 页（`GET` `/wakes` / `POST /wake-pause`）；⑧复用 `dsh-schedule` / `dsh-jobs` / `dsh-webhook`（§2.14.8）。
- 依赖：阶段 7 沙箱；`dsh` 4 profile（`forlife` / `forlife-headless` / `forlife-qq` / `forlife-web`）；NapCat 容器 `forlife-qq-1`（`:6099` / `:3001` / `:3010`；`scripts/start-admin.ps1`）。
- 验收标准：①2 分钟后任务到点唤醒并自主执行，重启后仍在 —— 通过：`packages/gateway/scripts/e2e-wake.ts` 32/0；②文件出现 5 秒内唤醒，崩溃退避、超限停用 —— 通过：1s → 2s、2 次停用；③QQ 断开 ⇒ `system` 唤醒、重连不重复 —— 通过：真机 down → up；④高频合并一次、自激深度 3 切断、静默期只记录 —— 通过：`packages/gateway/test/wake-engine.test.ts` + `wake-triggers.test.ts` 29 条；⑤面板见决策 / 花费 / 模型行为、全局暂停生效 —— 通过：`packages/gateway/scripts/e2e-wakes-api.ts` 16/0、`wake-now` / `wake-toggle` / `wake-cancel`。
- 状态：已完成；八项落地；测试见 §6.4。
- 备注：
  - 结论：事件接 6、缺 3（`migration.failed` 须带外、`contract.mismatch`、`job.failed`），入 `wake_trigger_events`。
  - 结论：防重入 `inFlight: Set<string>` + `next_fire_at` 派发后推进 + `tick()` 1 秒。
  - 结论：密钥仅 ASCII（`FORLIFE_WAKE_BRIDGE_URL`）；驱动 `--profile` + `--json` + stdin。
  - 未验：`agent.followup`；`child_process` spawn；`docker stop`。
  - 落点：`createGatewayRuntime` / `handleWakeRequest` / `observeConnection` / `packages/dsh-component/src/index.ts`。
  - 引用：`docs/incidents/`、`research/wake-scheduling-report.md`、§2.15。

### 阶段 9 · 冷数据与运维（PLAN 阶段五）

- 目标：blob 分层（`hot` / `warm` / `cold`），归档 HDD 并按需回读；迁移 / 碎片 / 备份可中断可回滚（工期 6–10 天）。
- 交付物：①分层根路径 + `storage_tier` + 定时沉降；②迁移（§2.4 五步）+ `forlife-admin migrate` CLI + 断点续传 + 回滚；③HDD 归档（Parquet）+ `recover(id)` + `recall_full(tool_call_id)`；④碎片合并 / 淘汰；⑤存储面板（`GET /stat/storage` / `cleanup(target)`）；⑥监控：压缩频率 / 召回预算 / 路由档位与守卫命中率 / 迁移耗时；⑦备份 / 恢复（SQLite 在线备份 API + 增量）。
- 依赖：阶段 4 存储层 + 分层根路径。
- 验收标准：①HDD / SSD 行为一致 —— 通过：`tier-modes.test.ts` 6/6（`FORLIFE_ROOT_COLD`）；②10k 条 blob 可中断 / 续传 / SHA 全通过 / 一键回滚 —— 部分达成：`migration-10k.test.ts` 3/3、526 ms，**向量目录未纳入**；③`recall_longterm` 冷层按需加载并记延迟 —— 通过：`cold-load.test.ts` 9/9、`cold_load_stats`（0027）、`source` = `archive` / `db`；④碎片超限自动合并 / 淘汰 —— 通过：`fragment-threshold.test.ts` 10/10（占比、最小 100、兜底 7 天、`forlife_state`）。
- 状态：进行中（三条通过；迁移仅覆盖 blob）。
- 备注：空值等于"关闭"（`Number('')` / `0 >= min`）；未验真机 HDD 吞吐；引用 `docs/deploy/PVE_DEPLOY.md`。

### 阶段 10 · 部署与硬化

- 目标：全新 PVE 从零部署 ≤ 30 分钟端到端；暴露面与鉴权达最低要求（工期 6–10 天）。
- 交付物：①`docker-compose.yml`：`caddy` / `dsh` / `gateway` / `qq` / `llama-server` + 卷 + 健康检查 + `depends_on`；②`Caddyfile` 仅基线，动态路由经 Admin API；③PVE 交付说明（规格 / 开机 / 升级 / 备份 / 暴露约定）；④硬化：鉴权 / 限流 / 脱敏 / 密钥 / Caddy 安全头 / Admin API 仅内网；⑤噪音过滤 + 本地嵌入；⑥运维手册（掉线 / 契约不匹配 / 磁盘告警 / `minimum` 降级 / 端口泄漏）。
- 依赖：阶段 7 端口出口 + 阶段 9 迁移 / 备份。
- 验收标准：①全新 PVE 从零部署 ≤ 30 分钟 —— 通过：Docker 2:05、`--no-cache` 2:11、增量 3:14.6、造冷层 0.154 秒，合计 ≈ 5–6 分钟；②`forlife doctor` 报契约不匹配点且降级可用 —— 通过：`packages/dsh-component/scripts/doctor.mjs` / `src/host-contract.ts` 8/8（5 必需 / 3 加固 ⇒ `broken` / `degraded`）；③备份 ⇒ 销毁 ⇒ 恢复（DB + blob）—— 通过：`drill-backup-restore.mjs` 10/0；④公网仅 443 + 显式发布端口，`/onebot` / DSH 直连 / Caddy Admin API 不可达 —— 未验（需公网）。
- 状态：进行中（部署与契约检查通过；多阶段 Dockerfile 未写，仅 `deploy/caddy/Dockerfile.forlife`；`docker-compose.yml` 中 `dsh` / `gateway` 为占位 `command: ["node", "--version"]`）。
- 备注：PVE 真机 11 处缺陷见 `docs/deploy/PVE_DEPLOY.md`；契约机制在 `packages/contracts`；备份 db 句柄须先关（Windows EPERM）、`check` 须 await。

### 阶段 11 · 主管理后台（gateway `/admin`）—— 日常主要使用入口

- 目标：`/admin` 唯一对外管理入口（自带鉴权，§2.12）；DSH Web UI 仅内网 / 隧道；同一份数据与语义（无第二真源）。
- 交付物：①`packages/admin-ui`（Vue 3 + Vite + TS，自建设计令牌；深 / 浅主题 + 手机端）；②`packages/gateway/src/server.ts`（单进程单端口，静态产物 + `/api/admin/*`）；③鉴权 scrypt + HttpOnly + SameSite=Lax + 限流 + 审计 + 迁移 0017；④板块：总览 / 会话与队列 / 记忆 / 压缩 / 路由与端点 / 提示词 / 唤醒 / 表情与媒体 / 存储 / 日志 / 设置。
- 依赖：`@forlife/store` + 同一份 SQLite。
- 验收标准：①`pnpm -F @forlife/admin-ui build` 通过、根 `pnpm typecheck` 干净 —— 通过；②未登录访问数据接口 401 —— 通过；③登录失败 429、改口令使其它设备会话失效 —— 通过；④拒路径穿越、CSP 无 `unsafe-inline` —— 通过；⑤手机端可打开操作 —— 通过；⑥六数据页可用、空数据显示"还没有数据" —— 部分通过；⑦`/admin` 之外不可达 —— 未验（需公网）。
- 状态：进行中（面板 / 鉴权 / SSE / 端口出口页有证据；多阶段 Dockerfile + compose + Caddy 反代未做）。
- 实测：`GET /api/admin/*` 14 接口在线（未登录 401）；侧边栏 12 页；QQ 入站 9 ⇒ 会话 2 ⇒ 轮次 6 done ⇒ 出站 8 全 `confirmed=1`；主库 512 KiB / WAL 1098 KiB / 迁移 v17 / 9 备份 2.8 MiB；测试见 §6.4。
- 备注：
  - 结论：SSE 须鉴权（未登录 401），失败回退 2 秒轮询、退避 5s → 10s → 20s（封顶 120s）。
  - 结论：`internal: true` 发布端口无效 ⇒ dev 叠 `edge`；NapCat 仅登录时初始化。
  - 落点：`packages/gateway/src/admin/sse.ts` / `packages/admin-ui/src/log-stream.ts` / `LogsView.vue` / `PromptsView.vue` / `PortsView.vue`。
  - 接口：`/api/admin/{session,setup,login,logout,password,overview,series}`、`GET /api/admin/logs/stream`、`GET /prompt-text` / `POST /prompt-revision` / `POST /prompt-rollback`（§2.14.13）、`/api/admin/send`、`/ports` / `/port-publish` / `/port-unpublish` + `publish_port` / `unpublish_port` / `list_ports`（§2.14.15、§2.14.16）。
  - 注意：`pathToFileURL`（`file://${path}` ≠ `import.meta.url`）；tsconfig 禁 `*/`（`pkg/*/src/**/*.ts`）；命中率空值 `null`。

---

## 5. 测试与验收策略

|层|手段|覆盖|
|---|---|---|
|保真度|`tests/fidelity.spec.ts`+`contracts/plan-baseline.json`|参数与时机；偏离登记|
|单元|vitest/node:test|渲染/裁决/碎片|
|协议|`@dsh-std/connection`+`createMemoryConnectionPair()`|协商/派发/权限拒|
|契约|`verify:contract`|API 形状变化|
|路由评分|回放 200 条+边界样本|命中率 40–60%/降级|
|视觉桥接|图片集+mock|三态（`undefined`）/假描述|
|表情库|图片集+top-k|去重/淘汰|
|端口出口|发布+扫描|可达/TTL;`GET /config/`|
|提示词|编辑/回滚/覆盖|哈希恰变一次/误差 ≤2%|
|集成（无 QQ）|headless+脚本化调用|压缩/沉降/召回/恢复|
|集成（带 QQ）|测试账号+回放|防抖/分段/挂起恢复|
|故障注入|kill -9/磁盘满/网络断/时钟跳变/`minimum` 宕机|崩溃一致性/续传|
|性能|基准脚本|10 万条召回 p95/评分 p95/内存|
|端到端|compose 起全栈|一轮真实 QQ 对话|
|接线守卫|读源码断言调用点（去注释、要求语句位置）+ 回退验证|新接线不得「生产零调用」；`catalog-wiring.test.ts`/`profile-patch-ids.test.ts`/`feed-entries-wiring.test.ts`|

结果：测试 1263 项、0 失败；typecheck 0 错误。

**接线纪律（第 18 类缺陷的通用防线）**

本项目反复栽同一个坑，**累计 18 次**：**「库代码写好了、单元测试全绿、生产路径上零调用」**。单元测试**永远抓不到它** —— 因为单元测试自己就是调用者。

最典型的一次（第 17 处）：`profile patch` 的 `id` 写成了**包名**，而 base bundle 用的是**短 id**（`- id: llm-pi-ai` 配 `name: '@deepseek-ai/dsh-llm-pi-ai'`）⇒ dsh **静默丢弃整段 patch**（正常启动一个字不说，只在 `--dump-config` 时打一行警告）⇒ **`opencode-go` 这个 provider 从来没注册上过**，而容器一直 `healthy`、插件一直 `0 failed to import`。

⇒ **纪律**：每个新接线都同时交付两样 ——

1. **接线守卫测试**：**读源码**断言调用点存在。三个附加要求（三条都有对应的事故）：**先去掉注释再匹配**（栽过「锚点匹配到注释 ⇒ 结论相反」）、**必须落在语句位置**（不加这条 `void 0 && f(ctx)` 能蒙混过关）、**断言结果被真的用了**（`void f()` 后丢掉返回值等于白调）。已有：`tests/profile-patch-ids.test.ts`、`packages/dsh-component/test/catalog-wiring.test.ts`、`tests/feed-entries-wiring.test.ts`。
2. **回退验证**：把接线**真的拆掉**（或改回错误写法）跑一次，守卫**必须变红**；不变红说明这条守卫是假的。

**字节级稳定前缀**(PLAN §10.2):`renderMidMemory()`→SHA-256 同；`renderPrompt(await assemble())` 空转 N 轮→哈希不变；压缩事件→哈希恰变一次；`assemble().tools` 稳定。

---

## 6. 部署：PVE VM + Docker + Caddy

### 6.1 虚拟机规格

|项|建议|说明|
|---|---|---|
|vCPU|4(+2 若 `minimum` 跑 CPU)|嵌入模型另加|
|内存|16 GB|向量/附件缓存大；纯远端 8 GB;0.5B≈400 MB|
|系统盘|64 GB SSD(virtio-scsi)|容器镜像+系统|
|数据盘|128 GB+ SSD|`db`/`hot`/`warm`/`vectors`/`attachments`/`tmp`/`logs`/`workspace`|
|冷数据盘|1 TB HDD（可选）|`cold` 根；无 HDD 则 `coldEnabled: false`|
|网络|virtio 桥接|对外仅 443+发布端口|
|GPU|无（设计前提）|R7 430/ROCm 不支持⇒CPU+量化|
|模型权重|SSD(`storage.roots.models`)|不下沉 HDD|

### 6.2 Compose 与路径约定

- 五服务 `caddy`/`dsh`/`gateway`/`qq`/`llama-server`+命名卷+`restart: unless-stopped`+healthcheck;`dsh`/`gateway` 共享数据卷（WAL 安全）;
- Caddy 只暴露 443 与显式发布端口；Admin API 与内部服务只 bind `127.0.0.1`/compose 内网;
- `DSH_HOME=/data/dsh`;`dsh-home-paths` 优先级「显式配置 > `$DSH_HOME` > `~/.dsh`」；profile 只读挂载进 `<DSH_HOME>/profiles/forlife` ⇒ 宿主零接触;
- 冷层：`FORLIFE_COLD_DIR` 指向宿主镜像，容器内 loop+ext4;**冷层根目录必须预先创建，缺失时写入失败且不报错**。

### 6.3 Caddy 配置策略

```
{
  admin unix//run/caddy/admin.sock      # unix socket(0200) 代替暴露 2019
  persist_config off
}

memory.example.com {
  handle /admin*   { reverse_proxy gateway:8081 }   # 公网唯一入口
  handle /svc/*    { reverse_proxy gateway:8081 }   # 已发布服务
  # 不放兜底 handle：避免遮蔽动态路由
  # DSH Web UI / OneBot / Admin API 一律不在公网
}

# QQ WebUI：独立域名站点块，**代理在根路径**（子路径反代会让 NapCat 的绝对路径
# 请求 `/webui/assets/…`、`/api/…` 打到 Caddy 根 ⇒ 404）。面板 iframe 走它
# ⇒ 同 HTTPS、无混合内容；6099 不直接对外。
# ⚠️ 前提：Caddy 在 `edge` 网络且 qq 也在（靠 deploy/docker-compose.dev.yml 覆盖），否则 502。
napcat.{$FORLIFE_HOST} {
  reverse_proxy qq:6099
  encode gzip
}
# TCP 穿透：layer4（自建 caddy 镜像），由 gateway 合成后 POST /load
```

- 单一真源 = gateway:最小引导配置+变更合成整份 JSON→`POST /load`（原子、失败回滚）；禁用「Caddyfile 基线+Admin API 追加」（`caddy reload`/`adapt` 即 `POST /load`,静默抹路由）。
- 端口发布两道硬闸门（gateway 侧）：端口段白名单、目标网段白名单（防反代 `127.0.0.1:2019`、`169.254.169.254`）；升级：拉新镜像→`forlife doctor --preflight`→重启 `dsh`。
- QQ WebUI 反代是**静态站点块**（不进动态路由）：`napcat.<host>` → `qq:6099`，根路径；NapCat 侧零改动（§1.2、§2.12）。

### 6.4 部署验收

|验收项|标准|结果|
|---|---|---|
|真机部署|`docker compose up -d`,四容器起来且健康|通过（PVE;`caddy`/`dsh`/`gateway` healthy,`qq` Up）|
|从零到可用|≤30 分钟|≈5–6 分钟（装 Docker 2 分 05 秒、冷构建 `--no-cache` 2 分 11 秒、增量 3 分 14.6 秒、造冷层 0.154 秒）；不配镜像加速源 33 分 8 秒|
|整机重启|冷层挂载、自愈|通过|
|记忆端到端|写入/检索/spill/沉降/冷层回读/`recover`|9/9|
|生产工具数|34|一致|

**验证边界**:公网 ACME 证书、`minimum` profile、QQ 扫码收发、cron 备份取法、容量实测未获端到端验证，首次上线按「第一次执行」对待；见 `docs/deploy/PVE_DEPLOY.md` 附录 B。

---

## 7. 风险登记册

### 7.1 宿主与兼容性

|风险 → 影响|缓解|
|---|---|
|宿主 API 漂移（DSH rc）/`node:sqlite` 非宿主用法→激活失败/需改造|`compat.hosts`+`optional` 契约；SQL 收口 `@forlife/store`;`ctx.storageDomain` 退路|
|`ctx.compaction` 被占用/`ctx.settings` 误写 persona/`complete: true`→挂不上/`no volatile fields`/吃掉 `system-prompt/assemble`|启动检测冲突；禁用 `complete`|
|无迁移框架（`version`/`compatibleVersions`）/废弃扩展点/本机 DSH 被误改→撕裂旧数据/白做工|有序 SQL+`user_version`;`~/.dsh/.agent-presets/` 已废弃|

### 7.2 存储与数据

|风险 → 影响|缓解|
|---|---|
|SQLite 写竞争/压缩压丢记忆→`SQLITE_BUSY`/损伤|WAL+`busy_timeout`;软删除+`recover`|
|前缀缓存失效/向量 >10 万/容量不足/迁移中断→费用升/检索慢/写失败|位置契约 lint;`VectorIndex` 可插拔；LanceDB 切换|

### 7.3 模型与路由

|风险 → 影响|缓解|
|---|---|
|`minimum` 不可用/纯 CPU 达不到 50 ms/「粘性基线」→路由退化/档位漂移|50 ms 超时；软预算 ≤800 ms;每 step 重新断言|
|内核无跨模型 failover/插件无重试→整轮失败/丢功能|`agent/request-error`+`agent/request` 换路由|
|权重下载失败/过大→部署失败|断点续传|
|按需冷启动抖动/外挂端点不可用/加速后端不匹配驱动→桥接失效/回落|空闲超时 10 min;只保证 `cpu`;校验生效后端|
|远程 SSH 凭据泄漏/模式切换打断轮次→起错主机/半截回复|凭据加密；优雅排水|
|多后端镜像膨胀/频繁切换→成本升|`models remove`|
|中介层写错目标：每轮调 `saveSelection()` 写**持久默认值**→默认模型被逐轮污染|每轮只写 `ModelSelectionRef.current`；`saveSelection` 只给人工/后台（§2.18.2、§2.20.3）|
|模型目录取数失败/可达性过期→某接入点抖动时「看不见还有别的可用」|取数层全 try/catch、单个 provider 失败不空表；深度可达性交独立心跳/探测（§2.20.1）|
|`minimum` 未部署/超时、目录无可达模型→初始路由无预评分或无从可选|50 ms 硬超时 + 启发式兜底；目录空**不硬选**（返回 `undefined` 带原因）（§2.20）|
|库已实现但未接线（`deploy.ts`/`download.ts`/`initialRoute`）→生产零调用、能力白写|接线守卫测试（读源码断言调用点）+ 回退验证（§5、§2.20.4）|

### 7.4 视觉、媒体与记忆质量

|风险 → 影响|缓解|
|---|---|
|provider 未声明模态（`undefined`）→硬拒 `UNSUPPORTED_CONTENT`|未知按不支持|
|桥接假描述/幻觉/`agent/pre-step` 抛错→污染记忆/整轮被毁|`resolveModelInfo` 硬校验；try/catch 退回|
|OCR 误读当事实→据错字行动|只作线索；`ocr-unverified`|
|视觉调用过频/表情库膨胀/抓取滥用→重复描述/磁盘满/来源风险|指纹表哈希优先；每轮上限 3|
|私有媒体库/QQ 图片超限额→磁盘满/进不了上下文|上限 2000 件/5 GB;入站降采样|

### 7.5 网络、端口与安全

|风险 → 影响|缓解|
|---|---|
|端口发布被滥用/SSRF→内网暴露/反代 Caddy 与元数据|端口段白名单；TTL;目标网段白名单|
|「Caddyfile 基线+API 追加」/路由陷阱→`caddy reload` 抹掉路由/被 `handle` 遮蔽|真源放 gateway;整份 `POST /load`;`PUT .../routes/0`|
|DSH Web 反代公网/Admin API 无鉴权→Host/Origin 栅栏/cookie 无 `Secure`/配置可改|只走 gateway;`admin unix//run/caddy/admin.sock`(0200)|
|layer4 需自建镜像/QQ 适配器暴露协议能力（`send_packet`）→穿透受阻/账号交给模型|评估 `xcaddy`;`QqTransport` 不实现红线动作|
|破坏性 QQ 动作（踢人/禁言/退群/删好友）/QQ 风控/掉线/封号→失联|默认禁用；独立容器+健康检查|
|`message_sent` 不可靠/群免打扰无接口→重复发送/一直响|指纹+时间窗+目标三重校验；本系统侧不唤醒；标 UNCERTAIN|

### 7.6 唤醒与时间

|风险 → 影响|缓解|
|---|---|
|唤醒风暴/自激循环（唤醒→再排）→token 烧穿|六道闸（预算+静默期+合并+级联+过期+幂等）；级联上限 3|
|监视程序失控/系统事件噪声/停机错过→拖垮宿主/告警风暴/补跑雪崩|限额 CPU 25%/内存 256 MB/时长 5 min/输出 1 MB;默认 `skip`;`coalesce`/`catch_up_once` 补跑|
|时间读数进稳定前缀/时钟插件节流/时区混用/时间锚过期→每轮未命中/日期错乱|位置契约 lint;权威时区 `Asia/Shanghai`;统一 `now()`;`defer_turn` 注入新读数；`time_drift`|

### 7.7 会话、来源与多路复用

|风险 → 影响|缓解|
|---|---|
|多会话单窗口/概率抽样/待读池膨胀→串味/溯源丢失/延迟回复|`source_scope`;`qq_reply(conversation)` 必填；`read_pending`;有界（200 条/72 h）|
|后台改了没告诉模型/故障状态被覆盖→认知过时/显示正常实则不可用|`affects_model` 唤醒或注入报告；`admin_actions.reported` 审计；`system` 原因锁|
|来源纪律被绕过（用了 `user`）→系统消息当授权|`MessageSourceMap` 只注册自有 kind|
|话痨群饿死其它会话/好友状态轮询→饿死/触发风控|优先级调度；轮询默认关闭、只 `L4`|
|三层时区被打乱/提示词误编辑→存储混入本地时间/破坏缓存|存储层强制 UTC(DB 约束+单测)|

---

## 8. 待决策项与待人工验证项

### 8.1 待人工验证清单

验证边界见 `docs/deploy/PVE_DEPLOY.md` 附录 B。

|#|项|验证方式|通过判据|状态|
|---|---|---|---|---|
|M1|记忆面板渲染|`dsh --profile forlife-web`(`DSH_HOME`→`.runtime\dsh`)|指标行+指纹+条目表|已验证（`/api/forlife/state` 200;四区块可见）|
|M2|真模型结构化压缩|配 API key 触发压缩|JSON 过校验；L3 新条目；`已提交`|已验证（9/9 压缩→沉降→回读）|
|M3|NapCat 登录与收发|起 `deploy/docker-compose.yml` 的 `qq` 扫码|登录态持久化；OneBot WS 连网关|容器 healthy;收发待确认|
|M4|端口发布实测|`docker compose up -d` 后从宿主外访问 Caddy|该通才通（面板），DSH Web 与 QQ 不对外；v2.13.0|待确认|
|M5|`minimum` 部署 + 初始路由|`deploy.ts`/`download.ts` 接线后一键部署 Qwen2.5-0.5B（GGUF Q4）|轮次开始产出初始路由并落到 `ModelSelectionRef.current`；**持久默认值不变**；`minimum` 超时走启发式|待接线|
|M6|NapCat WebUI 同源反代|浏览器开 `https://napcat.<host>/webui`（面板 iframe 同一链路）|无混合内容拦截；`/webui/assets/*`、`/api/*` 均 200；`6099` 不对外|待确认（Caddyfile 站点块与面板地址已就绪；需 `docker-compose.dev.yml` 把 qq 接上 `edge`）|
|M7|容器内 FFmpeg 与 PacketBackend|`docker compose logs qq`|`ffmpeg 4.4.2`；`[PacketHandler] 加载成功`；`[FFmpeg] ✓ 使用 Native Addon 适配器`|已验证|

### 8.2 死循环监控

需求：连续输出上百次重复文字（死循环）时自动终止本轮。

|层|文件|职责|测试|
|---|---|---|---|
|1 检测算法|`packages/store/src/loop-guard.ts`|归一化+周期+相似度|13/13|
|2 钩子适配|`dsh-component/src/loop-guard-hook.ts`|累积输出、按 agent 隔离、`cancel`|8/8|
|3 注册|`dsh-component/src/loop-guard-register.ts`|挂 `agent/assistant-stream`,两种约定都认|9/9|
|4 端到端接线|`dsh-component/test/loop-guard-e2e.test.ts`|跑真 `apply()`,喂帧 ⇒ 真 cancel|4/4|
|工具侧|`dsh-component/src/tool-loop-guard.ts`|不发言的循环（`tool/call`）|8/8|
|兜底|`dsh-component/src/qq-tools.ts`|`qq_reply` 入队前拦|6/6|

「自动检测」=归一化+周期+相似度。

已知限制：① 工具参数每次都变⇒工具侧判不出（`_ts` 无关 vs `offset`）。② 文字「相似但不相同」=换说法重复（判循环）；工具调用=传不同参数⇒只认精确重复。③ 已验证接线（真 `apply()`+真帧+真 cancel）与订阅挂载；未真跑模型。

### 8.3 面板缺陷与修复状态

|#|现象|根因|修复与护栏|状态|
|---|---|---|---|---|
|P1|「QQ 与后台」「模型与路由」空白（记忆/提示词正常）|React #137:`renderPanel` 无条件写 `children`,`node('input', {…})` 的 `children` 是 `[]` 而非 null ⇒ void element 错误，被 `SlotErrorBoundary` 吞成 `<div data-slot-error>`。|`VOID_TAGS` 清单；无子节点不写 `children`;jsx 替身照抄校验|已修复|
|P2|「模型与路由」空白（P1 后第二层）|`RoutesPanel` 直接返回 `node()` 裸描述符（漏 `renderPanel`）；loading 同样漏|两分支走 `jsx()`/`renderPanel()`;撤回即变红|已修复|
|P3|点「预览」没反应|卡片读 `snapshot.preview`,`fetchPromptSnapshot` 从不设该字段|改读 `ui.preview \|\| snapshot.preview`;新增真实路径测试|已修复|
|P4|出错只剩 `Cannot read properties of undefined (reading 'map')`|`renderPanel` 递归无位置信息；ErrorBoundary 吞异常|`renderPanel(h, panel, path)` 带路径；报 type 与位置|已修复|

验收：① 四区块两遍均为 React 元素（`panel-render.test.ts` 5 项），输入取自 `packages/dsh-component/test/fixtures/panel-api.json`;② 修复有「撤回即变红」+自检项，替身写全 `{type, props}`/`props.children`;prop 名合法+`onChange`;客户端已核验（`scripts/verify-served-client.mjs`）。

### 8.4 决策登记

|#|事项|状态|结论/选项与影响|
|---|---|---|---|
|1|QQ 客户端|已定|NapCat 主选，SnowLuma 备选（§1.2）|
|2|向量后端|已定|LanceDB;维度与距离待定|
|3|嵌入模型|待定|阶段 1 只 FTS5;阶段 5 定远端 API/ONNX|
|4|`minimum` 超小模型/本地推理后端|待定|外挂端点/`llama-server`/云 API/宿主内置|
|4b|本地部署哪些模型|部分已定|`minimum` 选型已定：Qwen2.5-0.5B-Instruct 4-bit / GGUF Q4 / 约 400 MB（纯 CPU 走 Q4）；嵌入模型仍待定（CPU-only 0.5B–1.5B 级）|
|4c|外挂目标机信息|待提供|`remote-ssh` 需主机/端口、SSH 密钥、GPU|
|5|常驻运行时 profile|待定|建议 `dsh-web`;轮次由 gateway 驱动|
|5b|面板归属/DSH Web 公网可达|待决|A 只用 gateway 面板；B 试 Host 重写；C 放弃|
|6|端口出口策略|待定|①端口段；②网段白名单；③人工批准；④layer4|
|7|表情来源政策|待定|域名白名单；上限 2000 张/2 GB|
|7b|自唤醒的边界|待定|①静默期默认关；②可唤醒事件只记录；③自建免批|
|7c|时间与时区|待确认|①`Asia/Shanghai`;②后续步 5 分钟/空闲 15 分钟|
|8b|记忆所有权与隔离|已定：不隔离|共用一套记忆；留 `source_scope`|
|8c|唤醒条件初始值|已定|群聊不唤醒（除 `@`）、私聊 80%、临时 20%(`temp_message`);`set_wake_rule`|
|8d|`L4 特别关心`状态类事件|已定|`peer_input_status` 开、`peer_status_change` 关|
|8e|小模型时钟建议|已定：生效|≥0.7 落表（`small_model_suggestion`）；<0.7 写 pending|
|8f|「系统状态」阈值与文案|已定|3 次唤醒失败/90 s 无响应；`set_status_preset`|
|8g|群消息免打扰|能力受限|QQ 无该接口（`mute-all`/`mute-member` 是禁言）；不唤醒|
|9|路由中介层|已定|插在「接入提供方」与「实际调用位置」之间：模型目录（标记+简介+可达性）+ 初始路由（定档与选模型分离）+ 取数层；输入只要三样（轮次输入/模型表/可达性）（§2.20）|
|10|档位命名与职责|已定|`minimum` 取代 `scorer` 且不作用途标签；职责四件，其中③QQ 工具决策、④工具内低阶智能决策源**待做**（§2.6 D、§2.20.4）|
|11|`minimum` 自动部署|已定（未接线）|`deploy.ts`/`download.ts` 已有实现、生产零调用；三种部署目标 + 断点续传 + SHA-256（§2.13.3、§2.20.4）|
|12|QQ WebUI 暴露方式|已定|独立域名站点块 `napcat.<host>` 根路径反代（同源、无混合内容）；不暴露 `6099`、不改 NapCat（§6.3、M6）|
|13|轮末「建议下次模型」|待定|落地形态三选一：自动采纳 / 需满足置信度 / 仅登记待人工确认；均写 `routing_log` 留理由（§2.18.4）|

---

## 附录 A · 调研产物索引

|文件|内容|
|---|---|
|`PLAN.MD`/`模型路由.MD`|设计报告；评分：守卫→L1→兜底|
|`EXECUTION_PLAN.md`|本文档|
|`docs/research/astrbot-admin-panel-research.md`/`docs/research/dsh-web-plugin-report.md`|AstrBot/DSH Web 后台与 `/api`|
|`research/dsh-plugin-authoring-reference.md`/`research/vision-modality-report.md`|插件编写：`defineTool`;视觉 `inputModalities`+`ctx.attachments`|
|`research/qq-client-report.md`/`research/napcat_readme.md`/`research/snowluma_readme.md`/`research/ncdocs/`/`research/sl/`/`research/sl2/`/`research/slsrc*/`/`research/napcat-capability-gaps.md`|QQ/NapCat 素材|
|`research/subagent-model-routing-report.md`/`research/wake-scheduling-report.md`|`agentOptions`/调度|
|`research/caddy-sandbox-ports-report.md`|Caddy/layer4/`POST /load`|
|`research/time-context-report.md`|`dsh-time-context` 幻觉根因|
|`research/headless-plugin-verification-tooling.md`/`research/dsh-std/`(16 个 `@dsh-std/*` 包)|headless 工具链；`.d.ts`/`research/sqlite-probe.mjs`|

**交付前清理项**:`research/_sources/astr-src/AstrBot-master/` 可重新获取，交付前删除。

---

