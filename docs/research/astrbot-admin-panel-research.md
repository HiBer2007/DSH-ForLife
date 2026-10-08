# AstrBot 管理后台设计调研（面向 DSH 个人 AI 长期记忆系统）

> 调研对象：[AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0，Python，默认分支 `master`，约 41.4k stars）；调研时间点 `master`。所有结论均以**直接读取源码/官方文档**为依据，来源在文末；无法验证处标注 **UNCERTAIN**，未发现的页面/接口明确写"未发现"，不做推测性命名。
> 本报告的用途：为「DSH + QQ 机器人前端的个人长期记忆系统」后台（记忆条目、压缩日志、QQ 会话/队列、模型路由、召回预算、SSD/HDD 分层、实时日志）提炼可抄与应避坑的设计。

---

## 1) 技术栈与部署形态

### 1.1 前端（`dashboard/`）

来源：[dashboard/package.json](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/package.json)、[dashboard/src/main.ts](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/main.ts)

| 维度 | 选型 |
| --- | --- |
| 框架 | **Vue 3.3.4**（Composition API + `<script setup>`），TypeScript 5.1.6 |
| UI 库 | **Vuetify 3.7.11** + `vite-plugin-vuetify`；图标混用 `@lucide/vue` 与 `@mdi/font`（构建时 `subset-font` 做字体子集化） |
| 状态管理 | **Pinia 2.1.6**（`stores/auth`、`stores/customizer`、`stores/common` 等） |
| 路由 | vue-router 4.2.4，**hash 模式**（`createWebHashHistory`）——为兼容 `/data/dist` 静态托管与插件页面 |
| 构建 | **Vite 6.4.1** + `vue-tsc --noEmit` 类型检查 + ESLint/Prettier；包管理 pnpm（含 overrides） |
| HTTP/类型 | axios；**`@hey-api/openapi-ts` 从 `openspec/openapi-v1.yaml` 生成 TS 客户端** |
| 重功能组件 | Monaco Editor（配置/JSON 原始编辑）、ApexCharts（统计图）、TipTap（富文本） |
| 富文本渲染 | markdown-it + stream-markdown + markstream-vue + shiki + katex + mermaid + DOMPurify |
| 流式通信 | **`event-source-polyfill`**（因原生 `EventSource` 不能带 `Authorization` 头） |
| 其他 | vue-i18n（自建 i18n 层）、vee-validate + yup、pinyin-pro（中文拼音搜索）、qrcode（TOTP） |

> 目录骨架（`layouts/full/vertical-sidebar`、`stores/customizer`、`plugins/confirmPlugin`）源自 CodedThemes 的 Vuetify 商业模板（`package.json` 中 `author: "CodedThemes"`），后经大量改造。

### 1.2 后端（`astrbot/dashboard/`）

来源：[astrbot/dashboard/server.py](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/server.py)、[requirements.txt](https://github.com/AstrBotDevs/AstrBot/blob/master/requirements.txt)

- **Web 框架：FastAPI**（`from fastapi import Request`；`create_dashboard_asgi_app()` 建 app）。
- **ASGI 服务器：Hypercorn**（`hypercorn.asyncio.serve`），非 uvicorn。
- **Flask/Quart 兼容垫片**：`FastAPIAppAdapter`（`asgi_runtime.py`）把 FastAPI app 包出 `app.config["MAX_CONTENT_LENGTH"]` 这类 Flask 风格接口，老插件代码 `from quart import ...` 仍可运行；官方文档称之为"Quart 兼容请求上下文"。**这是历史包袱的典型体现**（见 §7 应避免）。
- 数据层：SQLModel / SQLAlchemy async + aiosqlite（SQLite）；知识库向量用 FAISS；日志 loguru；凭证 pyjwt；TOTP pyotp；定时 APScheduler。
- 代码组织：`dashboard/api/`（路由）+ `dashboard/services/`（业务）+ `dashboard/server.py`（中间件/启动）。
- **两代 API 并存**：legacy `/api/*` 与 `/api/v1/*`（后者有 OpenAPI 规范与 scope 化 API Key）。

### 1.3 部署形态

来源：[server.py](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/server.py)、[compose.yml](https://github.com/AstrBotDevs/AstrBot/blob/master/compose.yml)、[Docker 部署文档](https://docs.astrbot.app/deploy/astrbot/docker.html)

- **单进程内嵌**：管理后台与机器人跑在**同一个 Python 进程**里，由 core lifecycle 启动，共享同一个 `AstrBotConfig` 与数据库实例。不是前后端分离部署。
- **单端口**：默认 `0.0.0.0:6185`；前端产物从 **`data/dist`** 提供（`resolve_dashboard_dist()`），后端同时提供 API 与 SPA 静态文件。
- 配置项：`data/cmd_config.json` 下 `dashboard.{enable,host,port,ssl,jwt_secret,username,password,auth_rate_limit,trust_proxy_headers,disable_access_log}`；环境变量 `DASHBOARD_PORT` / `DASHBOARD_HOST` / `DASHBOARD_SSL_*` 优先级高于配置文件。
- 启动前用 psutil 做**端口占用预检**，占用时打印占用进程详情并抛错（体验好，值得抄）。
- Docker：官方镜像 `soulter/astrbot:latest`，`6185`（WebUI）+ `6199`（可选 OneBot v11 / NapCat），数据卷 `./data:/AstrBot/data`。另有包管理器 / 桌面客户端 / 启动器 / 宝塔 / 1Panel / K8s 等多种部署方式。
- `host` 非 `127.0.0.1/localhost` 时，会额外打印局域网访问地址与安全警告；两者同时决定"默认密码免改"是否放行。

---

## 2) 信息架构（页面清单表）

**权威来源**：路由表 [dashboard/src/router/MainRoutes.ts](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/router/MainRoutes.ts)、侧边栏 [sidebarItem.ts](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/layouts/full/vertical-sidebar/sidebarItem.ts)、接口层 [dashboard/src/api/v1.ts](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/api/v1.ts)、[WebUI 文档](https://docs.astrbot.app/use/webui.html)。

侧边栏分两组：**系统**（欢迎 / 机器人 / 模型提供商 / 插件 / 配置文件 / 数据与日志 / 会话管理）与**扩展功能**（人格 / 知识库 / 定时任务 / 子代理）。左下角另有「系统设置」。

| 路由 | 视图组件 | 作用 | 主要后端接口 |
| --- | --- | --- | --- |
| `/welcome`（`/`→`/welcome`） | `WelcomePage.vue` | 落地页/欢迎引导。**内容细节 UNCERTAIN**（未逐行读取） | `GET /api/v1/stat/version`、`/api/v1/stat/first-notice` |
| `/platforms` | `PlatformPage.vue` | 消息平台适配器实例（QQ/OneBot/Telegram…）增删改、启停、连通性测试、运行统计 | `/api/v1/bot-types`、`/bots`、`/bots/stats`、`/bots/test`、`PATCH /bots/enabled` |
| `/providers` | `ProviderPage.vue` | 模型服务商与模型管理，按能力分 tab：对话/嵌入/重排/语音；「保存并获取模型」「测试模型」「自定义模型」 | `/api/v1/providers*`、`/provider-sources*`、`/providers/schema`、`/providers/test`、`/providers/embedding-dimension` |
| `/extension` | `PluginWorkspacePage.vue` | **插件工作区外壳**，顶部 tab 切换子页 | — |
| └ `/extension/plugins` | `ExtensionPage.vue`(`initialTab: installed`) | 已安装插件列表、启停、配置、卸载、重载、更新 | `/api/v1/plugins`、`PATCH /plugins/enabled`、`/plugins/{id}/reload`、`/plugins/update` |
| └ `/extension/plugins/market` | `ExtensionPage.vue`(`initialTab: market`) | 插件市场：搜索/分类/排序（推荐/下载量/更新时间/名称）、一键安装 | `GET /api/v1/plugins/market`、`/plugins/market/categories`、`POST /plugins/install/*` |
| └ `/extension/mcp` | `McpServersPage.vue` | MCP 服务器配置、启停、测试、ModelScope 源同步 | `/api/v1/mcp/servers*`、`PATCH /mcp/servers/enabled`、`POST /mcp/servers/test` |
| └ `/extension/skills` | `SkillsPage.vue` | Skills 管理、文件编辑、Neo 候选→评测→晋级/回滚 | `/api/v1/skills*`、`/skills/neo/*` |
| └ `/extension/components` | `ComponentsPage.vue` | 「管理行为」：指令/指令组/子指令、工具的统一管理（过滤、启停、重命名、权限） | `GET /api/v1/commands`、`/commands/conflicts`、`PATCH /commands/{id}`、`/tools`、`PATCH /tools/{id}/enabled` |
| `/extension/plugins/:pluginId` | `ExtensionPage.vue` | 插件详情页：README/CHANGELOG、组件清单、视图入口 | `/plugins/{id}`、`/plugins/{id}/readme`、`/plugins/{id}/changelog`、`/plugins/{id}/config/schema` |
| `/plugin-view/:pluginName/:pageName` | `PluginPagePage.vue` | **第三方插件自带的可视化页面**（受限 iframe + bridge） | `/api/v1/plugins/{id}/views/{page_name}`、`/plugins/extensions/{plugin_path}` |
| `/config` | `ConfigPage.vue` | **配置文件**可视化配置：选择配置文件后按 AI 配置/平台配置/插件配置分区，可搜索；右下角「保存配置」与 `{}` raw JSON 编辑 | `/api/v1/config-profiles*`、`/config-profiles/schema`、`PUT /config-profiles/{id}` |
| `/session-management` | `SessionManagementPage.vue` | **会话管理**：UMO 会话列表、筛选分页、会话规则、会话分组、**批量改 provider / service**（会话级模型路由） | `/api/v1/sessions`、`/sessions/active-umos`、`/sessions/rules`、`/session-groups`、`PATCH /sessions/provider`、`PATCH /sessions/service` |
| `/persona` | `PersonaPage.vue` | 人格（人设）管理：文件夹树、增删改、拖拽排序 | `/api/v1/personas*`、`/persona-folders*`、`/personas/tree`、`/personas/move` |
| `/knowledge-base` | `knowledge-base/index.vue` → `KBList.vue` / `KBDetail.vue` / `DocumentDetail.vue` | **知识库**：多知识库、选嵌入/重排模型、上传文档（≤10 个/次、单文件 ≤128MB）、分块查看、**召回测试** | `/api/v1/knowledge-bases*`、`/knowledge-documents*`、`/knowledge-chunks*`、`POST /knowledge-bases/{id}/retrieve` |
| `/alkaid/knowledge-base` | `alkaid/KnowledgeBase.vue` | 旧版知识库页（历史遗留） | — |
| `/data`（tab 容器） | `DataPage.vue` | 「数据与日志」外壳，默认重定向到统计 | — |
| └ `/data/statistics` | `stats/StatsPage.vue` | 统计：平台实例、消息、模型调用、Tokens、运行时长；消息/调用趋势与排名；1/3/7 天切换 | `GET /api/v1/stat*`、`/stat/provider-tokens`、`/stat/storage` |
| └ `/data/conversations` | `conversation/ConversationWorkspacePage.vue`（+`/legacy` 旧表格页） | 对话记录检索（关键词/机器人/群聊私聊/UMO）、服务端分页（默认 30/页）、按会话分组、导出、多选删除；右侧预览可用**只读 Monaco** 查看原始 `history` JSON | `GET /api/v1/conversations*`、`POST /conversations/export`、`PUT /conversations/{id}/messages` |
| └ `/data/logs` | `ConsolePage.vue` → `ConsoleDisplayer.vue` | **实时日志**：级别筛选、关键词搜索高亮、自动滚动、全屏、隐藏用户聊天日志；**可在页面内 pip 安装缺失依赖** | `GET /api/v1/logs/history` + **`SSE /api/v1/logs/live`**、`POST /api/v1/update/pip-install` |
| └ `/data/trace` | `TracePage.vue` | 运行追踪：模型调用路径与工具调用过程，页面顶部开关启停 | `GET/PUT /api/v1/trace/settings` |
| `/subagent` | `SubAgentPage.vue` | 子代理编排配置 | `/api/v1/subagents/config`、`/subagents/available-tools` |
| `/cron` | `CronJobPage.vue` | 定时/未来任务：列表、创建、启停、手动执行 | `/api/v1/cron-jobs*`、`POST /cron-jobs/{id}/run` |
| `/chat`（`/chat/:conversationId`） | `ChatPage.vue` + `components/chat/*` | **ChatUI：面板内直接和机器人/AI 对话**（详见 §5.3） | `POST /api/v1/chat`(SSE)、`GET /chat/ws`、`WS /api/v1/live-chat/ws`、`WS /api/v1/unified-chat/ws` |
| `/settings` | `Settings.vue` | **系统设置**：常规（时区/回调地址/日志/缓存）、外观（侧边栏/主题）、网络（代理/PyPI 源/GitHub 加速）、安全（HTTPS/登录限速/TOTP）、维护（备份/恢复/重启）、OpenAPI（API Key） | `/api/v1/system-config*`、`/api-keys*`、`/backups*`、`POST /stat/restart-core` |
| `/about` | `AboutPage.vue` | 关于/版本信息 | `GET /api/v1/stat/version` |
| `/auth/login`、`/auth/setup` | AuthRoutes | 登录与首次初始化 | `/api/v1/auth/login`、`/auth/setup-status`、`/auth/setup` |

**未发现（不要凭空假设存在）**：
- **独立的"概览/仪表盘"页已不存在**——`/dashboard/default` 只是重定向到 `数据 → 统计`；落地页是 `/welcome`。
- **未发现"上下文压缩/compaction 日志"页面或接口**：压缩能力存在（见 §4.4），但只在配置里开关，**没有任何可观测界面**——这是我们的差异化机会。**也未发现消息队列/积压深度监控页**：平台页只有实例与统计（`/bots/stats`），没有队列长度/延迟指标。
- `ChatBoxRoutes.ts` 内容 **UNCERTAIN**（未读取），推测为独立全屏聊天入口；`/alkaid` 下的 `LongTermMemory.vue` 在路由表中**已被整段注释掉**（AstrBot 曾有过长期记忆管理页，当前已下线），**不要引用为现有功能**。
- 大量历史重定向（`/normal`、`/system`、`/console`、`/conversation`、`/trace`、`/observability`、`/extension/market`、`/extension-marketplace`、`/plugin-page/...`）说明其 IA 经历过多次搬迁；官方文档甚至专门维护了一张[「菜单与旧入口对照」表](https://docs.astrbot.app/use/webui.html)。

---

## 3) 插件管理 UX

来源：[插件配置文档](https://docs.astrbot.app/dev/star/guides/plugin-config.html)、[插件可视化视图文档](https://docs.astrbot.app/dev/star/guides/plugin-pages.html)、[发布插件文档](https://docs.astrbot.app/dev/star/plugin-publish.md)、[plugin_service.py](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/services/plugin_service.py)

### 3.1 列表 / 启停 / 卸载

- 一个 `/extension` 工作区，把**插件 / 插件市场 / MCP / 技能 / 管理行为**收进顶部 tab，避免侧边栏爆炸。
- 列表项字段（`serialize_plugin_base`）：`name`、`display_name`、`marketplace_name`（`_`→`-`）、`version`、`author`、`desc`、`repo`、`reserved`(内置)、`activated`、`logo`、`support_platforms`、`astrbot_version`、`installed_at`、`i18n`、`root_dir_name`、`install_source`、**`updates_enabled` + `update_disabled_reason`**。
- 启停：`PATCH /api/v1/plugins/enabled` → `turn_on_plugin/ turn_off_plugin`。
- 卸载：`DELETE /api/v1/plugins/{plugin_id}`，可带 `delete_config` / `delete_data` 选项（**卸载时询问是否连带删除配置与数据**，细节到位）。
- 空壳插件（`is_ghost_plugin`：name/author/desc/version/display_name 全空）从列表里过滤掉。
- 插件 logo 不直出文件路径，而是注册**短时 file token**（300s、可复用）→ `/api/file/{token}`。

### 3.2 每个插件的配置表单 = **Schema 驱动自动表单**

核心机制：插件目录放一个 **`_conf_schema.json`**，后台据此生成表单，并生成本地配置文件 `data/config/<plugin_name>_config.json` 注入 `__init__(context, config)`。

支持的类型：`string` / `text` / `int` / `float` / `bool` / `object` / `list` / `dict` / `template_list`（v4.10.4+）/ `file`（v4.13.0+，可限 `file_types`）。字段级修饰：

| 字段 | 效果 |
| --- | --- |
| `description` / `hint` / `obvious_hint` | 标签、问号悬浮提示、醒目提示 |
| `default` | 缺省值 |
| `items` | `object` 的子 schema，可递归嵌套 |
| `invisible` | 不在面板显示 |
| `secret` | 密码框 + 临时可见切换（`string` 与字符串 `list`） |
| `options` | 下拉选项（选项文本支持 i18n） |
| `slider` | `{min,max,step}` 滑块（int/float） |
| `editor_mode` / `editor_language` / `editor_theme` | 代码编辑器模式（Monaco） |
| `_special` | **调用宿主能力的选择器**：`select_provider` / `select_provider_tts` / `select_provider_stt` / `select_persona` / `select_knowledgebase` —— 让插件直接复用面板里已配好的模型/人设/知识库，而不是让用户手抄 ID |

`dict` 类型支持 `template_schema`，让用户可视化编辑任意 KV（如 `custom_extra_body` 的 `temperature/top_p/max_tokens`）。
`template_list` 支持多套模板 + `display_item`（折叠列表里显示某个字段值以区分同类条目）+ `hide_hint_in_list`。

**Schema 演进**：插件升级改 schema 后，AstrBot 会**递归比对**，自动补缺失项默认值、删掉已不存在的项——这是长期可维护的关键。
**注意（原文明确）**：`secret: true` **只做 UI 遮罩，不加密配置文件里的值**，插件不应回显这些值。

前端相关接口：`GET /api/v1/plugins/{id}/config`、`GET /api/v1/plugins/{id}/config/schema`、`PUT /api/v1/plugins/{id}/config`；`file` 类型配置另有 `config-files` 上传/列表/删除接口。
> 具体由哪个 Vue 组件渲染 schema 表单 **UNCERTAIN**（未定位到组件文件）。

### 3.3 插件市场 / 安装 / 更新

- 安装入口共 4 种：`POST /api/v1/plugins/install/{github|git|url|upload}`（URL / GitHub 仓库 / git clone / 上传 zip），另有 `POST /plugins/validate/repo` 先校验仓库是否含合法 metadata。
- **注册表（registry）机制**（`RegistrySource` dataclass）：
  - 默认源列表（按序回退）：`https://api.soulter.top/astrbot/plugins`、`https://github.com/AstrBotDevs/AstrBot_Plugins_Collection/raw/refs/heads/main/plugin_cache_original.json`。
  - 变更探测用**旁车 md5 文件**：默认 `https://api.soulter.top/astrbot/plugins-md5`；自定义源规则为「`xxx.json` → `xxx-md5.json`」。
  - 本地磁盘缓存 `data/plugins.json`（自定义源为 `plugins_custom_{url_hash8}.json`），缓存里存 `timestamp` + `md5`；启动时先比对远端 md5 决定是否重新下载。
  - 支持**多个自定义插件源**（`custom_plugin_sources`，存在 shared preferences 里），市场请求可带 `custom_registry`、`force_refresh`。
- 安装来源被持久化（`plugin_install_sources`，key 为插件根目录名）：`install_method`（`market` / `repository` / `url` / `upload`）、`registry_url`、`registry_name`、`market_plugin_id`、`repo`、`download_url`、`installed_at`。
  → **`updates_enabled` 只在 `market` / `repository` 安装时为真**，否则提示"该插件不是通过插件市场安装，无法检测或执行更新"。这是个很聪明的溯源设计。
- 更新：单个 `POST /plugins/{id}/update`；批量 `POST /plugins/update` 用 `asyncio.Semaphore(3)` 限流，并逐项返回 `{name,status,message}` 与"N/M 个失败"汇总。
- **版本不兼容可强行安装**：命中 `PluginVersionUnsupportedError` 时返回结构化 warning `{warning_type: "astrbot_version_unsupported", can_ignore: true}`，前端提示后可用 `ignore_version_check` 覆盖。`GET /plugins/{id}/changelog` 展示更新日志。
- 发布侧：market 用 GitHub 托管插件，元数据 `metadata.yaml`（`name/display_name/desc/version/author/repo/astrbot_version/support_platforms/tags/short_desc`），通过 `https://cloud.astrbot.app/publish` 提审，zip ≤16MB。
- **DEMO_MODE 全局开关**会拦截所有写操作（安装/卸载/启停/重载）。

### 3.4 插件日志 / 错误如何呈现

- 加载失败：`GET /api/v1/plugins/failed` 返回失败插件字典；UI 有独立的「**加载失败插件**」列表，每项带 **「重载」** 按钮（`POST /plugins/failed/{plugin_id}/reload`），修好依赖或改完代码**无需重启整个程序**。
- 每个插件可单独设日志级别：`PUT /api/v1/plugins/{plugin_id}/log-level`（DEBUG/INFO/WARNING/ERROR/CRITICAL/null）。
- 插件详情页会列出该插件注册的**组件清单**（`components`），按 `page → skill → command → llm_tool → listener → hook` 固定顺序展示，让"这插件到底挂了哪些钩子"一目了然。
- 插件可在异常诊断文档指引下结合主日志 `data/logs/astrbot.log` 与事件循环看门狗日志排查。

### 3.5 插件自带页面的隔离模型（很值得抄）

插件在 `views/<page_name>/index.html` 放页面，Dashboard 以**受限 iframe**加载：`allow-scripts allow-forms allow-downloads`。

- 不能访问 Dashboard 的 cookie / localStorage / 父页面 DOM；必须通过注入的 `window.AstrBotPluginView` bridge 通信。
- bridge API：`ready()/getContext()/getLocale()/t()/onContext()` + `apiGet/apiPost/upload/download/subscribeSSE/unsubscribeSSE`。
- 请求转发路径：视图 `bridge.apiGet("items/123")` → `/api/v1/plugins/extensions/<plugin_name>/items/123`；插件后端用 `context.register_web_api("/<plugin_name>/items/<item_id>", handler, ["GET"], desc)` 注册。
- 静态资源路径被自动重写并附加**短期 `asset_token`**；响应带 `X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: frame-ancestors 'self'; object-src 'none'`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 明确提醒：视图内不要用原生 `new EventSource(...)`（不能带 Authorization 头），要用 `bridge.subscribeSSE()`。
- 官方建议：只需少量配置项时**优先用 `_conf_schema.json`**，可视化视图留给复杂表单/状态面板/日志/文件上传/SSE 实时流。

---

## 4) 配置系统 UX

来源：[AstrBot 配置文件文档](https://docs.astrbot.app/dev/astrbot-config.html)、[WebUI 文档](https://docs.astrbot.app/use/webui.html)、[上下文压缩文档](https://docs.astrbot.app/use/context-compress.html)

### 4.1 三层配置模型

1. **配置文件（profile）** — `/config` 页：`data/cmd_config.json` 是默认 profile `default`；WebUI 新建的 profile 存 `data/config/abconf_*.json`。内容按 `AI 配置 / 平台配置 / 插件配置 / 扩展功能` 分区，每区再分 `模型 / 人格 / 能力 / 高级` 等子组（v4.0.0 起引入多配置文件）。
2. **系统设置** — 左下角 `/settings`，**全局唯一、不属于任何 profile**：常规 / 外观 / 网络 / 安全 / 维护 / OpenAPI。
3. **会话级路由** — `/session-management` 的 `PATCH /sessions/provider`、`PATCH /sessions/service`，以及 `config-routes`（`GET/PUT /api/v1/config-routes`、`PUT/DELETE /config-routes/{umo}`）——**按 UMO（会话）覆盖用哪个模型/配置文件**。这正好对应我们要的"模型路由配置"。

### 4.2 Schema 如何驱动设置 UI

- 后端暴露 `GET /api/v1/config-profiles/schema` 与 `GET /api/v1/system-config/schema`；前端据此渲染表单（与插件 `_conf_schema.json` 是同一套思路：**schema 是唯一真源，UI 是投影**）。
- 顶部提供**配置项搜索**，避免长表单迷路。
- 保存是**显式动作**：右下角磁盘图标「保存配置」+ 成功提示；系统设置则"修改后自动保存"并提示，必要时提示重启。

### 4.3 可视化 ↔ 原始 JSON 双通道

- 右下角 `{}` 按钮「编辑配置文件」直接编辑当前 profile 的 JSON；编辑后先点「**应用此配置**」把内容**暂存到可视化编辑器**，关闭窗口后再点「保存配置」——**两阶段提交**，避免直接落盘脏配置。
- 对话历史原始 JSON 也复用**只读 Monaco** 展示（`/data/conversations` 预览顶部 `{}`）。

### 4.4 热重载与压缩策略（与我们的 compaction 直接相关）

- 插件配置：`config.save_config()` 落盘；插件 schema 变更自动补齐/清理。
- 插件与失败插件的**重载不重启进程**（`/plugins/{id}/reload`）。
- 系统配置改动通常即时生效；部分项提示需重启，`POST /api/v1/stat/restart-core` 提供面板内重启。
- **上下文压缩**（v4.11.0+）：在 `AI 配置 → 高级 → 上下文管理策略` 配置；达到所用模型上下文窗口 **82%** 时触发；策略一「按对话轮数截断」（默认，可设一次丢弃轮数），策略二「LLM 压缩」（可指定压缩模型、保留最近轮数、自定义提示词），压缩后**二次检查**仍超限则对半砍。压缩模型窗口取自 [models.dev](https://models.dev/)，也可手工填 `max_context_tokens`。
  → **能力有、可观测性没有**：没有压缩历史/压缩前后 token 对比/压缩产物查看页面。

### 4.5 秘密与凭证

- 插件层：`secret: true` 仅 UI 遮罩，**不加密落盘**（文档明示）。
- 面板账号：`dashboard.password` 存 **MD5**（`<your_password_md5>`），并存在 `change_pwd_hint` / `md5_pwd_hint` / `password_upgrade_required` 这类"密码需要升级"的迁移提示字段——即**正在从 MD5 迁移走**但历史遗留仍在。
- 模型 API Key：v4.13.0 起支持"**环境变量引用**"——在 API Key 字段填 `$DEEPSEEK_API_KEY` 即可从环境变量读取，避免明文入配置文件（好设计，建议直接抄）。
- 对外 API Key：面板 `设置 → OpenAPI` 创建，格式 `abk_xxx`，用 `Authorization: Bearer abk_xxx` 或 `X-API-Key` 传递；**11 个顶级 scope + 2 个敏感子权限**（`config:edit_admin`、`chat:admin` 必须显式授予，不随父 scope 隐式获得；取消 `bot`/`provider` 会同步取消依赖它们的 `config`）。scope 不足返回 `403 Insufficient API key scope`。

---

## 5) 实时日志 / 流式通信

### 5.1 实时日志 = **SSE（不是 WebSocket、不是轮询）**

来源：[log_service.py](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/services/log_service.py)、[ConsoleDisplayer.vue](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/components/shared/ConsoleDisplayer.vue)

- 服务端核心是 `astrbot.core.LogBroker`：维护一个**环形日志缓存** `log_cache`，并提供 `register()` / `unregister(queue)` 给每个订阅者一条独立的 `asyncio.Queue`。
- SSE 帧格式：`id: {ts}\ndata: {json}\n\n`，其中 JSON 为 `{"type": "log", ...log}`（含 `time`/`level`/`data`/`category`）。
- `GET /api/v1/logs/history` 一次性取回缓存做**冷启动回填**；`SSE /api/v1/logs/live` 做增量。
- **断线续传**：客户端重连时携带 `Last-Event-ID`，服务端 `replay_cached_logs()` 只补发 `time > last_ts` 的日志 —— 不丢不重。
- 前端用 `EventSourcePolyfill`（`event-source-polyfill`）以携带 `Authorization: Bearer <token>`，`heartbeatTimeout: 300000`、`withCredentials: true`；**指数退避重连**（1s 基数、上限 30s、最多 10 次），401 明确提示 token 过期。
- 前端本地缓存上限 `commonStore.log_cache_max_len`（默认 200 行），按 `time` 排序；用 `DocumentFragment` 批量插入 DOM 避免逐行 reflow；ANSI 颜色映射、`[INFO]` 等级三段式结构化渲染、关键词正则剥离 ANSI 后高亮、全文搜索（250ms 防抖）、自动滚动、全屏、以及一个 **`hide_user_chat`** 开关（按 `category === "user_chat"` 过滤掉用户聊天日志）。
- **运维闭环**：日志页内直接 pip 安装缺失依赖（`POST /api/v1/update/pip-install`，可指定镜像源）。

### 5.2 其他流式通道

| 场景 | 机制 | 端点 |
| --- | --- | --- |
| ChatUI 发消息 | **SSE**（`fetch`/POST 流） | `POST /api/v1/chat` |
| 恢复某次运行流 | SSE | `GET /api/v1/chat/runs/{run_id}/stream` |
| 实时聊天 | **WebSocket**（token 走 query） | `WS /api/v1/live-chat/ws?token=...` |
| 统一聊天 | WebSocket | `WS /api/v1/unified-chat/ws?token=...` |
| 日志 | SSE | `GET /api/v1/logs/live` |
| 插件自定义页面内 SSE | bridge 转发（带鉴权头） | `/plugins/extensions/...` |
| 长任务进度（更新/备份） | 轮询 | `/api/v1/update/progress`、`/backups/progress/{task_id}` |

> 注意：SSE 走 `Authorization` 头，而 **WebSocket 与文件下载只能把 token 放 URL query**（`?token=...`）——浏览器限制所致。

### 5.3 面板内对话 / 调试控制台（ChatUI）

来源：[WebUI 文档](https://docs.astrbot.app/use/webui.html)、`dashboard/src/components/chat/*`

- `/chat` 页内置 **ChatUI**，可在浏览器里直接和已配置模型对话：会话列表（首屏最近 30 个，滚动加载更早的，可重试）、创建/重命名/删除会话、选择配置文件+提供商+模型（provider 会话隔离时可单独选模型）。
- 输入支持文本/图片/文件/语音，上传带预览并按文件签名辅助识别类型。
- 展示**模型思考过程、工具调用状态、知识库/网页搜索引用来源、每条回复的 Token 与耗时**。
- 对已有回复可复制、重新生成、**换模型重新生成**；可编辑用户消息后从该消息继续生成，也可对某段内容开**分支追问**。
- 可切换**流式/普通**响应，以及 **SSE / WebSocket** 通信模式。
- 组件层有 `MessageList.vue`(46KB)、`ToolCallCard.vue`、`ReasoningBlock.vue`、`RefsSidebar.vue`、`LiveMode.vue`、`ProjectList.vue` 等。
- 文档提醒：同一浏览器会话只保留一个 ChatUI 页面，否则可能出现"需要重新建立连接"。

---

## 6) 认证与安全

来源：[server.py](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/server.py)、[http.ts](https://github.com/AstrBotDevs/AstrBot/blob/master/dashboard/src/api/http.ts)、[WebUI 文档](https://docs.astrbot.app/use/webui.html)、[OpenAPI 文档](https://docs.astrbot.app/dev/openapi.html)

- **首次登录**：随机初始密码打印在启动日志里（用户名通常 `astrbot`），首次登录后应立刻修改。
- **JWT**：`jwt.decode(token, self._jwt_secret, algorithms=["HS256"])`（PyJWT + HS256）。
  - `jwt_secret` 若未配置，则 `os.urandom(32).hex()` 生成并写回配置。
  - token 可来自 `Authorization: Bearer` **或 cookie**（`DASHBOARD_JWT_COOKIE_NAME`）。
  - 过期校验区分「Token 过期」与「Token 无效」两种错误信息。**有效期时长 UNCERTAIN**（未读 `auth_service.py`）。
- **中间件作用域**：只拦截 `/api*`；`/api/v1/*` **完全跳过 Dashboard JWT 校验**（由 v1 自己的 API Key/scope 体系负责）—— 双轨鉴权，是风险点（见 §7）。
  - 免鉴权白名单：`/api/auth/login`、`/api/auth/logout`、`/api/auth/setup-status`、`/api/auth/setup`、`/api/stat/versions`，以及前缀 `/api/file`、`/api/v1/files/tokens`、`/api/platform/webhook`、`/api/stat/start-time`、`/api/backup/download`（备份下载用 URL 参数传 token）。
- **登录限速**：按 IP 的**令牌桶**（`_RateLimiterRegistry`，空闲 1 小时过期、每 30 分钟清理），作用于 `/api/auth/login`、`/api/v1/auth/login`、`/api/auth/totp/setup`、`/api/v1/auth/totp/setup`、`/api/config/astrbot/update`、`/api/v1/auth/desktop-session`；超限返回 429 并提示"可能正在遭受暴力破解"。参数 `dashboard.auth_rate_limit.{enable,average_interval,max_burst}`（默认 enable、1.0s、burst 3）。
- **TOTP 双因素**（pyotp）：`设置 → 安全 → WebUI 安全` 开启，扫码绑定；生成**一次性恢复码**（用后自动关闭 2FA，需重设）；改 TOTP 需先验当前验证码；**改密码会撤销所有受信任设备**；恢复码丢失只能手工改 `data/cmd_config.json` 里 `dashboard.totp.*`。
- **传输安全**：可选 HTTPS（`dashboard.ssl.{enable,cert_file,key_file,ca_certs}` 或 `DASHBOARD_SSL_*` 环境变量），证书缺失时降级并告警。
- **反代**：`dashboard.trust_proxy_headers` 为真时才信任 `X-Forwarded-For` / `X-Real-IP`（且做 `ipaddress` 校验），并替换 Hypercorn 访问日志里的 host。
- **请求体限制**：默认 `MAX_CONTENT_LENGTH = 128MB`，按路由前缀覆盖（分块上传 ×2、文件上传、配置上传、知识库上传等）；缺 `Content-Length` 的 multipart 直接 411，超限 413。
- **插件页面隔离**：受限 iframe + bridge + 短时 `asset_token`（带 scope 校验，只对某插件页路径有效）+ 严格安全响应头；插件页面路径受 `PluginPageAuth` 保护。
- 访问日志默认**关闭**（`disable_access_log: true`）。

---

## 7) 值得借鉴的设计要点 & 应避免的坑

### 7.1 值得借鉴（按对我们的价值排序）

1. **单进程 + 单端口 + 同仓前端，产物从 `data/dist` 提供。** 对个人项目是最省的部署形态：一个 `docker run -p 6185:6185 -v ./data:/data` 跑完，无需反向代理、无跨域。我们直接照搬这个形状（DSH 后台 + QQ 前端同进程）。
2. **Schema 即唯一真源的表单引擎，并内建"引用宿主对象"的字段类型。** 插件用 `_conf_schema.json`，核心用 `config-profiles/schema` 与 `system-config/schema`，UI 只是投影；我们的「召回预算 / 存储分层 / 模型路由 / 压缩阈值」**应先定 schema 再生成表单**，并抄它的 **schema 演进递归补齐默认值/删除废弃项** 逻辑，否则用户升级后配置会烂掉。同时照搬 `_special`（可直接下拉选已配好的 provider/persona/知识库，而非手抄 ID），我们内建 `select_model_route` / `select_memory_tier` / `select_recall_profile` 等价物。
3. **三层配置 + 会话级覆盖。** 全局系统设置 / 配置文件（profile）/ 按 UMO 的 `config-routes`。对"QQ 群 A 用便宜模型、私聊用强模型、某群不开长期记忆"这类需求，这一层抽象刚好够用，且比"给每个会话开一份完整配置"干净得多。
4. **可视化表单 + `{}` raw JSON 双通道，且是两阶段提交**（应用此配置 → 保存配置）。调试召回预算这类复杂嵌套配置时，raw JSON 是刚需；两阶段提交避免半途落盘。Monaco 复用到处（配置、只读 history JSON、模板）。
5. **实时日志用 SSE + `Last-Event-ID` 续传 + 服务端环形缓存 + 客户端指数退避**，而不是 WebSocket。单向流用 SSE 更简单（自动重连语义内建），配合 `EventSourcePolyfill` 解决鉴权头问题。这套组合我可以几乎原样复刻到我们的"实时日志/压缩事件流"。
6. **日志页内嵌装依赖（pip install）的运维闭环。** 换成我们的语境就是：日志页里直接给"重建索引 / 重跑压缩 / 清理缓存 / 重载记忆库"这类修复动作入口。面板不只是看，还能就地救火。
7. **失败态是一等公民。** 加载失败的插件单独成列表 + 「重载」按钮（不重启进程）；不兼容时可 `ignore_version_check` 强装（结构化 warning `can_ignore`）；批量更新逐项返回成败并汇总。**我们应给"记忆索引加载失败 / 压缩任务失败 / QQ 连接断开"同样的一等失败面板 + 就地重试。**
8. **扩展性用受限 iframe + postMessage bridge 隔离。** 插件页面拿不到 cookie/localStorage，只能走 bridge 调后端；静态资源自动重写并附短时 `asset_token`。若我们以后要做"记忆浏览器/召回调试台"的可插拔视图，这个隔离模型比"让插件往主 SPA 里塞 Vue 组件"稳得多。
9. **市场注册表 = 静态 JSON + `-md5.json` 旁车 + 本地磁盘缓存 + 可配置多源。** 极轻量：一个 GET 就能判断要不要重新拉全量；默认源挂了有第二个源兜底；用户可加自建源。可迁移用于"共享记忆模板/提示词包/模型路由预设"的分发。
10. **安装来源溯源决定可更新性。** 记录 `install_method`/`registry_url`/`repo`，只有来自市场或仓库的才允许更新，否则明确告知原因。这个"不许静默覆盖用户手改的东西"的原则，我们用在"用户手改过的记忆条目/配置"上同样成立。
11. **对外 API 用 scope 化密钥，可观测性接口与页面同级。** 它用 `abk_xxx` + 11 个 scope + 必须显式授予的敏感子权限（`config:edit_admin`/`chat:admin`）；我们开外部接口时应区分"只读召回"与"写入/删除记忆"（`memory:write`/`memory:delete` 必须显式授予）。它还把 `GET /api/v1/stat/storage`、`cleanup(target)`、`/stat/provider-tokens` 直接做成接口——**对应我们的 SSD/HDD 分层，存储占用/冷热分布/清理动作应当和记忆条目管理同级**，而不是塞进某个角落。

### 7.2 应避免（我们不要复制）

1. **两套 API 长期并存 + 中间件里按路径前缀绕过鉴权。** `server.py` 里 `if path.startswith("/api/v1"): return None` 直接跳过 Dashboard JWT，再由 v1 自己实现鉴权；前端还要写 `withLegacyFallback` 在 404 或 "missing api key" 时回退到 legacy `/api/*`。认知负担大、且是安全缝隙的温床。**我们一开始就定一套 API，版本演进用显式迁移而不是双活。**
2. **密钥保密性不足。** `dashboard.password` 存 **MD5**（还在迁移中，靠 `password_upgrade_required` 这类提示兜着），插件 `secret: true` **只遮罩不加密**（官方文档白纸黑字）。我们应默认用 Argon2/bcrypt 存面板口令，并对 API Key、QQ 凭据做**真加密**（或强制 `$ENV_VAR` 引用）。
3. **JWT 放 `localStorage`，且 WS/下载把 token 放在 URL query。** `http.ts` 的 `getToken()` 直读 `localStorage.token`；`liveWebSocketUrl(token)` 与备份下载都是 `?token=`。会进浏览器历史、代理日志与 Referer。我们应优先 HttpOnly + SameSite cookie，WS/下载用**短时一次性 ticket** 换取，而不是长期 JWT 裸奔在 URL 里。
4. **历史包袱污染路由表。** `/normal`、`/system`、`/console`、`/conversation`、`/trace`、`/observability`、`/extension/market`、`/extension-marketplace`、`/plugin-page/...` 全是兼容跳转，官方文档甚至要专门维护「菜单与旧入口对照」表来解释"哪个入口搬到了哪里"。**这说明早期 IA 没设计够；我们应在动手前把页面清单和归属定稳**（本报告 §2 的表格可直接作为我们的 IA 基线）。
5. **巨型文件与框架垫片。** 后端 `plugin_service.py` 79KB、`chat_service.py` 80KB、`config_service.py` 77KB、`config/default.py` 160KB；前端 `MessageList.vue` 46KB、`ConsoleDisplayer.vue` 单文件混合模板 + 大段手写 DOM 操作。再加上 `FastAPIAppAdapter` 为兼容 Quart 老插件而做的框架垫片——**能跑，但读起来贵**。我们从第一天就按"路由 / service / schema 三层 + 单文件 <800 行"约束自己，别给自己造兼容层。

### 7.3 我们相对 AstrBot 的差异化机会

- AstrBot **有压缩能力、没有压缩可观测性**（无压缩日志页、无压缩前后 token 对比、无压缩产物查看）；**有长期记忆的历史痕迹（已注释掉的 `LongTermMemory.vue`）但当前无长期记忆管理页**。这两块正是我们系统的核心，**必须做成一级页面**（记忆条目 CRUD + 检索/召回预览 + 压缩历史时间线 + 每次压缩的 token 收支与产物 diff）。
- AstrBot **没有 QQ 会话队列/积压监控**（只有平台实例与统计）。我们的"QQ bot sessions/queues"应补上：每会话队列深度、处理中/等待中、最近延迟、卡住会话一键取消。
- 它的知识库页已有 `POST /knowledge-bases/{id}/retrieve`（**召回测试**）——这是我们"召回预算"调参的直接对标物，建议做成"给定 query → 展示命中的记忆条目、分数、消耗 token、是否被预算截断"的调试面板。

---

## 参考来源

**官方文档**
- [AstrBot 仓库主页](https://github.com/AstrBotDevs/AstrBot) ・ [WebUI 使用文档](https://docs.astrbot.app/use/webui.html) ・ [AstrBot 配置文件字段详解](https://docs.astrbot.app/dev/astrbot-config.html)
- [插件配置（_conf_schema.json）](https://docs.astrbot.app/dev/star/guides/plugin-config.html) ・ [插件可视化视图（iframe + bridge）](https://docs.astrbot.app/dev/star/guides/plugin-pages.html) ・ [发布插件到插件市场](https://docs.astrbot.app/dev/star/plugin-publish.html) ・ [插件总览](https://docs.astrbot.app/use/plugin.html)
- [接入模型服务](https://docs.astrbot.app/providers/start.html) ・ [知识库](https://docs.astrbot.app/use/knowledge-base.html) ・ [上下文压缩](https://docs.astrbot.app/use/context-compress.html) ・ [异常诊断](https://docs.astrbot.app/others/diagnostics.html)
- [AstrBot HTTP API](https://docs.astrbot.app/dev/openapi.html) ・ [API Scope 与接口对照（自动生成，全量端点表）](https://docs.astrbot.app/dev/openapi-scopes.html) ・ [Docker 部署](https://docs.astrbot.app/deploy/astrbot/docker.html)

**源码（`master` 分支，均逐文件读取）**
- `dashboard/package.json` ・ `dashboard/src/main.ts` ・ `dashboard/src/router/index.ts` ・ `dashboard/src/router/MainRoutes.ts` ・ `dashboard/src/layouts/full/vertical-sidebar/sidebarItem.ts` ・ `dashboard/src/api/http.ts` ・ `dashboard/src/api/v1.ts` ・ `dashboard/src/views/ConsolePage.vue` ・ `dashboard/src/components/shared/ConsoleDisplayer.vue`
- `astrbot/dashboard/server.py` ・ `astrbot/dashboard/services/log_service.py` ・ `astrbot/dashboard/services/plugin_service.py` ・ `astrbot/builtin_stars/astrbot/metadata.yaml` ・ `requirements.txt` ・ `compose.yml`
- 目录结构经 GitHub Contents API 核实：`astrbot/dashboard/{api,services}`、`dashboard/src/{views,api,router,stores,components}`；另有 `astrbot/builtin_stars/{astrbot,builtin_commands}` 等目录一并核实。

**方法与限制说明**
- 本沙箱内 `github.com` / `api.github.com` / `raw.githubusercontent.com` 的 DNS 被解析到非公网地址而不可直连；源码与 API 均通过 `https://gh-proxy.com/` 中继读取。`cdn.jsdelivr.net` 的**文件清单 API 返回的是过期快照**（曾据此误判 `astrbot/dashboard/routes/*.py` 仍存在），故所有路径均以 GitHub Contents API 的实时结果为准。
- 标注 **UNCERTAIN** 的三处：`WelcomePage.vue` 的具体内容、`ChatBoxRoutes.ts` 的路由内容、JWT 有效期时长；另有"渲染插件 schema 表单的具体 Vue 组件"未定位到文件。文中未出现的页面名一律视为**未验证存在**，未作推测性命名。
