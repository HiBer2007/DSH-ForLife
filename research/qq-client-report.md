# 个人 QQ 机器人协议端选型报告：SnowLuma vs NapCatQQ

> 目标场景：Windows 上 24/7 headless 常驻、由 Node.js/TS（DSH）托管、带 Web 管理面板的个人 QQ 机器人。
> 抓取时间：≈ 2026-10-05（GitHub API / 官方文档 / 源码实时抓取）。
> 结论先行：**推荐 NapCatQQ（Shell 无头版）**；SnowLuma 作为同契约备胎。

---

## 一、两个项目到底是什么

### NapCatQQ（推荐）
- **本质**：基于 NTQQ 的 **协议端框架**，通过启动器把 NapCat 注入/加载进官方 QQ NT 程序，**调用 QQ 客户端已有的 Node 模块接口**（不是自己实现 SendMsg），对外提供 **OneBot 11** 的 HTTP/WS。[README](https://github.com/NapNeko/NapCatQQ/blob/main/README.md) · [guide/napcat.md](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/napcat.md)
- **技术栈**：TypeScript（monorepo：`packages/napcat-{core,onebot,shell,webui-*,protocol,native,...}`）；Windows/Linux/macOS/ARM/Termux/Docker 全平台。[仓库](https://github.com/NapNeko/NapCatQQ)
- **是否要官方 QQ**：**要**。Shell 版由自身引导启动 QQ 程序（OneKey 包"无需安装 QQ 和 NapCat 已内置"），Framework 版作为 LiteLoaderQQNT 插件挂在带界面的 QQ 上（官方已**不推荐** Framework，QQ 9.9.19 后 LiteLoader 维护欠缺）。[Shell 文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Shell.md) · [Framework 文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Framework.md)
- **API 面**：OneBot 11 为主（HTTP 服务端/客户端、正向 WS、反向 WS、SSE、HTTP 上报），约 121 个 action 文件；另有 Core/Adapter 架构预留多协议。[源码目录](https://github.com/NapNeko/NapCatQQ/tree/main/packages/napcat-onebot/action)
- **多账号**：每账号独立配置文件 `onebot11_<uin>.json` / `napcat_<uin>.json`，WebUI 可管理多账号。[配置文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md)（单进程**同时**并发多账号：见 UNCERTAIN）
- **许可**：`Limited Redistribution License for NapCat © 2024 Mlikiowa` —— 禁商用、改版不得公开发布、再分发需保留许可全文。[LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)

### SnowLuma
- **本质**：**"远程协议框架"** —— 一个 native addon **以 ptrace 级注入把 hook 打进正在运行的 QQ 进程**（Windows `QQ.exe` / Linux `qq`），解析其内部数据包，再以 OneBot v11 暴露（HTTP / WS / 反向 WS / HTTP 上报）。**它自己实现了 OIDB/highway 协议栈**（`packages/protocol`），但**网络会话仍借用官方 QQ 客户端**。[introduction.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/introduction.mdx) · [bridge/hook 源码](https://github.com/SnowLuma/SnowLuma/tree/dev/packages/bridge/src)
- **技术栈**：TypeScript + 专有原生 addon（`snowluma-*.node/.dll`）+ better-sqlite3；monorepo：`protocol / bridge / core / onebot / sdk / mcp / webui`。[仓库](https://github.com/SnowLuma/SnowLuma)
- **是否要官方 QQ**：**要，且必须运行中**。默认开启自动注入（发现 `QQ.exe` 即注入），**只支持扫码登录**；原生 Windows 上可看到 QQ 窗口，Linux 无头必须 VNC/noVNC 扫码。[windows.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/deploy/windows.mdx) · [quickstart.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/quickstart.mdx)
- **API 面**：OneBot v11（含大量 extended action）+ 官方 npm SDK `@snowluma/sdk` + MCP 服务；默认端口 HTTP 3000 / WS 3001 / WebUI 5099。
- **多账号**：一个 UIN 一个 OneBot 实例，自动检测接入。[introduction.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/introduction.mdx)
- **许可**：源码可见**非商业**许可（非 OSI）；原生 addon 为专有组件，**禁止逆向**，且**将其并入第三方安装包/Docker 镜像或通过自动化脚本部署需书面授权**。[EULA.md](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md) · [LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)

> 有趣事实：NapCat 自己的 README 就写着"可以试试更新更好用的 SnowLuma 作为 NapCat GUI 替代品"，而 NapCat 官方的 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop)（Tauri/Rust MSI，Win10/Server 2016+）**同时管理 NapCat 和 SnowLuma**。两者不是敌人，是同一生态的两个形态。

---

## 二、并排对比表

| 维度 | NapCatQQ v4.18.29 | SnowLuma v1.14.21 |
|---|---|---|
| 类型 | 注入/引导官方 QQ，调用其 Node API；OneBot 11 协议端 | 注入官方 QQ 进程 hook 数据包 + 自研 NTQQ 协议栈；OneBot 11 |
| 语言/实现 | TypeScript（Core/Adapter） | TypeScript + 专有原生 addon |
| 需要官方 QQ 客户端 | 需要（Shell 由自身引导；OneKey 包内置 QQ） | **需要在运行中**（ptrace 注入 `QQ.exe`） |
| 还需 QQ GUI 窗口 | **不需要**（Shell 天生无头；扫码在 NapCat WebUI 里进行） | **需要**（只支持扫码，二维码在 QQ 窗口；Linux 靠 noVNC） |
| 无头/静默运行 | ✅ 官方定位"天生无头"，OneKey 版标注"无头绿色版本" | ⚠️ 进程可无界面，但登录必须能看到 QQ 窗口 |
| 内存 | 官方称 50–100 MB（无 Electron 加载） | QQ 本身是 Electron 客户端 + Node 运行时 + SQLite（无官方数字） |
| 多账号 | 支持（每账号独立配置；并发细节 UNCERTAIN） | 支持（一 UIN 一实例，自动接入） |
| API 面 | OneBot 11（HTTP/WS/正反向/SSE），121 个 action | OneBot 11（+extended），另有 `@snowluma/sdk`、MCP |
| Web 面板 | 内置 WebUI（默认 6099，随机 token，支持 SSL/限速） | 内置 WebUI（5099，TOTP、日志、动作调试） |
| 版本绑定风险 | QQ 版本钉死（v4.18.29 推荐 QQ 9.9.26-44343，最低 40768+）；QQ 更新可能破坏 | **文档明确警告**：native hook 与 QQ 版本绑定，不要手动升级 QQ，需自己阻断 QQ 自动更新 |
| 星标/分叉 | **10,839★ / 821 fork** | 1,436★ / 89 fork |
| Open issues | 20 | 14 |
| 最近提交 | 2026-10-05 | 2026-10-04 |
| 近 90 天发版 | 12 个 | **34 个**（迭代极快，也意味着接口/配置常变） |
| 项目年龄 | 2024-03 创建，2.5 年 | 2025-06 创建，~1.2 年，文档自述"**早期开发阶段**" |
| 许可 | Limited Redistribution License（禁商用/禁公开改版） | 源码可见非商业 + 专有 addon（禁逆向、禁自动化脚本部署/打包需授权） |
| 生态 | 巨大：插件、Docker、一键脚本、TUI-CLI、Desktop、AstrBot/MaiBot 官方推荐 | 较小：SDK/MCP、docs、Docker 镜像、Desktop 支持 |
| Windows 服务化 | 无官方服务；靠 NapCatQQ-Desktop（托盘/后台托管）、计划任务、NSSM | 无官方服务；`node ./index.mjs`，天然适合被父进程托管 |
| 许可/隐私 | 无遥测描述 | PRIVACY 声明默认无遥测（条款当前"未生效"，未来可能启用） |

---

## 三、推荐：NapCatQQ（Shell 无头版）

**为什么是它**
1. **直接命中"headless 24/7 + 不碰 QQ GUI"**：Shell 版官方定位"天生无头、不依赖 Electron"，OneKey 包内置 QQ 一步到位，登录二维码在 **NapCat WebUI 里扫**（[Shell 文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Shell.md) · [配置文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md)）。SnowLuma 恰好卡在"必须有可见 QQ 窗口才能扫码 + 注入要求同用户同权限"上（[windows.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/deploy/windows.mdx)），对无人值守的 Windows 服务器不友好。
2. **成熟度与体量碾压**：10.8k★ vs 1.4k★、2.5 年 vs 1.2 年、20 vs 14 个 open issue，且 NapCat 的 issue 大多是功能/细节问题；SnowLuma 的 open issue **集中在注入与版本兼容**（[#505 无法注入](https://github.com/SnowLuma/SnowLuma/issues/505)、[#504 hook 成功但 connected 恒 false](https://github.com/SnowLuma/SnowLuma/issues/504)、[#466 无法发现 QQ 进程](https://github.com/SnowLuma/SnowLuma/issues/466)、[#395 Hook 一直"等待登录"](https://github.com/SnowLuma/SnowLuma/issues/395)、[#507 群视频崩溃](https://github.com/SnowLuma/SnowLuma/issues/507)）。发版记录里也有 `fix(windows): restore sending on current QQ builds` 这类"QQ 一升级就挂"的痕迹（[releases](https://github.com/SnowLuma/SnowLuma/releases)）。
3. **运维与恢复**：NapCat 近期合并了"静默离线（无 KickedOffLine 通知）后自动恢复登录"（[#2080](https://github.com/NapNeko/NapCatQQ/issues/2080)，针对 [#2071](https://github.com/NapNeko/NapCatQQ/issues/2071)），加上反向 WS 自带重连间隔与心跳，正好补上"崩溃恢复"这一条；还有 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop) 做 Windows 的起停/日志/托盘。
4. **降级成本对称**：两者都是 OneBot 11 over WS，切换基本只改端口和 token（见第七节），所以选成熟的那个当下限更高。

**什么情况下反而该选 SnowLuma**
- 你的机器本来就是**有桌面的 Windows**（QQ 窗口常驻无所谓），且你更看重 **TypeScript 原生栈**：`@snowluma/sdk`（[npm](https://www.npmjs.com/package/@snowluma/sdk)）直接给类型完备的 HTTP/WS 客户端、消息链构造器、`ctx.reply()`，对 DSH 这种 TS 项目手感最好；SnowLuma 还自带消息/反应/历史 SQLite 存储与 MCP。
- 你希望**一个进程一个账号**、配置即代码、且愿意跟着它两三周一次的版本节奏走。
- 注意：它的非商业 EULA 禁止把专有 addon 打进第三方安装包/镜像或用自动化脚本部署（个人自托管被明确允许，但**别把它打包进你的发行物**）。

---

## 四、集成契约（NapCat / OneBot 11）

**传输形态（推荐反向 WS，让 NapCat 主动连 DSH）**

| 形态 | NapCat 配置 | 端 | 说明 |
|---|---|---|---|
| 反向 WS（推荐） | `websocketClients[]`: `url: ws://127.0.0.1:8082/`, `token`, `reconnectInterval: 5000`, `heartInterval: 30000` | DSH 起 WS Server | NapCat 重启后自动重连，DSH 不需要重启 |
| 正向 WS | `websocketServers[]`: `host 0.0.0.0`, `port 3001`, `token` | DSH 作客户端连 `ws://127.0.0.1:3001/` | DSH 自己要重连 |
| HTTP | `httpServers[]`: `port 3000`, `token` | DSH POST | 事件需配 `httpClients[]` 上报 |

（配置字段见 [config/basic.md](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md)；配置文件落盘为 `config/onebot11_<uin>.json`，v4.5.3+ 支持该文件作为默认配置。）

**鉴权**：`token` 即 access token。HTTP 用 `Authorization: Bearer <token>`；WS 用 `Authorization: Bearer <token>` 或 `?access_token=<token>`。WebUI 的 token 是**另一个**东西（默认 6099 端口、随启动日志打印的随机值，[配置文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md)）。服务端模式下务必启用 token，[安全文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/other/security.md) 明确警告裸暴露风险。

**发消息（多段 + 引用 + 图片/文件）**
```json
{"action":"send_group_msg","params":{"group_id":123456,"message":[
  {"type":"reply","data":{"id":"<被引用消息的 message_id>"}},
  {"type":"at","data":{"qq":"10001"}},
  {"type":"text","data":{"text":"收到\n"}},
  {"type":"image","data":{"file":"file:///C:/bot/a.png"}}
]},"echo":"req-1"}
```
响应：`{"status":"ok","retcode":0,"data":{"message_id":1234},"echo":"req-1"}`（[network.md](https://github.com/NapNeko/NapCatDocs/blob/main/src/onebot/network.md)）。私聊用 `send_private_msg`；群文件用 `upload_group_file` / `upload_private_file`（v4.18.29 起支持 `upload_file` 参数）。`message` 既可为段数组也可为 CQ 字符串（`messagePostFormat`）。

**收事件**：WS 上以 `post_type` 分流（`message` / `message_sent` / `notice` / `request` / `meta_event`），`message` 字段为段数组；无 `echo` 的帧是事件，带 `echo` 的是 action 响应。

**反应（emoji reaction）**
- 发送：`{"action":"set_msg_emoji_like","params":{"message_id":12345,"emoji_id":"76","set":true}}`（[SetMsgEmojiLike.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/msg/SetMsgEmojiLike.ts)，`set:false` 取消）。
- 接收：`notice_type:"group_msg_emoji_like"`，含 `message_id`、`likes:[{emoji_id,count}]`、`is_add`、`user_id`（他人给你点=空/0，你自己的消息被点=操作者）（[OB11MsgEmojiLikeEvent.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/event/notice/OB11MsgEmojiLikeEvent.ts)）。
- 查询：`fetch_emoji_like` / `get_emoji_likes`。
- ⚠️ `emoji_id` 是 QQ 表情 ID 字符串（如 76 一类），具体取值表需实测核对（UNCERTAIN）。

**输入状态（typing）**
- 发送：`{"action":"set_input_status","params":{"user_id":"10001","event_type":1}}`（源码固定走 `ChatType.KCHATTYPEC2C`，即**仅私聊**；[SetInputStatus.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/SetInputStatus.ts)）。
- 接收：`{"notice_type":"notify","sub_type":"input_status","user_id":..,"event_type":1,"status_text":"对方正在输入..."}`（[OB11InputStatusEvent.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/event/notice/OB11InputStatusEvent.ts)）。
- ⚠️ **群聊 typing 无接口**，只能用于私聊。

**action 名清单（源码枚举 [router.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/router.ts)）**：`send_msg` / `send_group_msg` / `send_private_msg` / `delete_msg` / `get_msg` / `get_forward_msg` / `send_forward_msg` / `get_group_msg_history` / `upload_group_file` / `upload_private_file` / `set_msg_emoji_like` / `fetch_emoji_like` / `get_emoji_likes` / `set_input_status` / `send_like` …

---

## 五、需求 → 能力核验（针对 NapCat）

| 需求 | NapCat 提供 | 我们的用法 |
|---|---|---|
| 收群/私聊消息 | `message` 事件（`message_type: group/private`），段数组 | WS 分发；`raw_message` 做命令匹配 |
| 多段回复 | `message` 为段数组，可任意组合 | 一次 action 提交整链；需要独立气泡时拆多次调用 |
| 表情回应 reaction | `set_msg_emoji_like` + `group_msg_emoji_like` 事件 | 收到 @ 时给自己消息点 76；监听他人回应 |
| typing | `set_input_status`（私聊）+ `input_status` notice | LLM 生成前先发 event_type=1，结束发 0 |
| 回复/引用 | `reply` 段（`data.id` = message_id） | 用事件里的 `message_id` |
| 图片/文件 | `image` 段（path/URL/base64）、`upload_group_file`/`upload_private_file` | 本地文件用 `file:///`，注意 `enableLocalFile2Url` 配置 |
| 会话级队列 | 协议端无队列概念 | **在 DSH 侧按 session key 串行**，用 `echo` 关联响应 + 超时 |
| 崩溃恢复 | 静默离线自动恢复登录（[#2080](https://github.com/NapNeko/NapCatQQ/issues/2080)）、反向 WS 重连、心跳 | DSH 侧再包一层进程守护 + WS 重连 + `get_status` 健康检查 |

---

## 六、Windows 落地要点

**NapCat（推荐路径：NapCat.Shell 无头 + OneKey 包）**
- 部署：下载 `NapCat.Shell.Windows.OneKey.zip`（自动化配置，内置 QQ，标"无头绿色版本"）→ 跑 `NapCatInstaller.exe` → `napcat.bat` / `NapCatWinBootMain.exe <QQ号>` 启动（[Shell 文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Shell.md)）。
- 登录：WebUI（默认 6099）里"QQ 登录"扫码，或命令行传 QQ 号做快速登录；登录态偶发失效与 IP/设备变化有关（[配置文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md)）。
- 自启/服务：**官方没有 Windows 服务**。三条路：① [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop)（MSI，托盘后台托管、组件安装、日志）；② 任务计划程序（开机 + 失败重启）；③ NSSM 之类包成服务。
- 版本：v4.18.29 推荐 QQ **9.9.26-44343（最低 40768+）**（[release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.29)）；**冻结 QQ 自动更新**，保留一份能跑的包。
- 风险提示：issue [#1973](https://github.com/NapNeko/NapCatQQ/issues/1973) 出现过"一键安装内置 QQ 下载链接 404"，[#2062](https://github.com/NapNeko/NapCatQQ/issues/2062)/[#2079](https://github.com/NapNeko/NapCatQQ/issues/2079) 有掉线与同时重扫码案例；卸载只需删目录（[安全文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/other/security.md)）。
- 群/账号安全建议（官方）：Bot 号与常用号不要同 IP/设备；社交风控时可把 `o3Hook` 设 0 关闭包拦截；可用 SOCKS5 代理（`NAPCAT_PROXY_ADDRESS/PORT`）。

**SnowLuma（若选它）**
- 装桌面版 QQ → 解压 win-x64 包 → `launcher.bat`（本质 `node ./index.mjs`）→ WebUI `http://127.0.0.1:5099/`（临时密码只在全新数据目录首次启动打印）。
- **必须与 QQ 同一 Windows 用户、同级权限**运行，否则注入失败；`hookAutoLoad` 默认开，先开 QQ 或先开 SnowLuma 都行；**登录只能在 QQ 窗口扫码**。
- **不要手动升级 QQ**：hook 与 QQ 版本绑定，需自己阻断 QQ 自动更新（[update.mdx](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/deploy/update.mdx)）。
- 端口 5099/3000/3001；access token 在 `config/onebot_<uin>.json`；升级"只换程序不动数据"。

**两者共同**：Windows Server Core（无桌面体验）大概率跑不动（QQ NT 需要桌面环境/注入需要窗口会话）——**UNCERTAIN，未实测**。

---

## 七、迁移 / 降级预案

由于两边都讲 **OneBot 11（HTTP + WS，同一套 action/event 名）**，切换成本主要在运维而非代码：

1. **在 DSH 里抽一层 `OneBotTransport`**：只暴露 `send(segments)`、`react(messageId, emojiId)`、`typing(userId, on)`、`events()`。协议端差异（端口/token/正反向 WS）只体现在配置。
2. **启动自检 + 能力探测**：连上后调 `get_login_info`/`get_status`/`get_version_info`；`set_msg_emoji_like` 与 `set_input_status` 用 try/catch 降级（失败不阻塞主流程）。
3. **降级顺序**：
   - 首选 NapCat Shell（本报告推荐）；
   - 备胎 A：**SnowLuma**（同一 OneBot 11 契约，`accessToken` 换一下即可；代价是需要可见 QQ 窗口 + 版本绑定更紧）；
   - 备胎 B：[LLBot（原 LLOneBot）](https://github.com/LLOneBot/LuckyLilliaBot)，GPL-2.0，OneBot 11 + Satori + Milky，文档称有**不依赖 QQ 客户端的无头模式**（UNCERTAIN，需自行验证）；生态第三大。
   - 备胎 C：Lagrange.Core v2 + 其内置 `Lagrange.Milky`（Milky 协议，不再走 OneBot 11，需要另写适配）。
4. **版本与备份纪律**：钉死协议端版本 + QQ 版本；备份 `config/` 与数据目录/卷；QQ 自动更新黑洞化；保留上一份可运行的整包以便回滚。
5. **队列与恢复留在 DSH**：每 session 一条串行队列 + `echo` 关联 + 超时重试；WS 断开指数退避重连；进程级用计划任务/NSSM 拉起。

---

## 八、备选生态 sanity check（≤10 行）

1. **Lagrange.Core**：纯 C# 自研协议、**不需 QQ 客户端**、可无头；但 V1 已 sunset，master 为 V2，**OneBot 11 适配器已下架**，V2 转向内置 `Lagrange.Milky`；2991★，根目录无 LICENSE（默认保留所有权利）。[repo](https://github.com/LagrangeDev/Lagrange.Core) · [LagrangeV2（已归档过渡仓）](https://github.com/LagrangeDev/LagrangeV2)
2. **LLOneBot → LuckyLilliaBot（LLBot）**：TypeScript/GPL-2.0，OneBot 11 + Satori + Milky，HOOK（有头）与**无头纯协议**双模式；3644★，v8.2.1 @2026-09-15，活跃。[repo](https://github.com/LLOneBot/LuckyLilliaBot) · [docs](https://luckylillia.com/guide/introduction)
3. **go-cqhttp**：已停维（README 自述无力维护），最后 release 2023-10，**勿用**。[repo](https://github.com/Mrs4s/go-cqhttp)
4. **Astral（ProtocolScience/AstralGocq + AstralGo）**：gocq 分支族，OneBot 11，AGPL-3.0，2025-04 后停更 → 半死。[AstralGocq](https://github.com/ProtocolScience/AstralGocq)
5. **Milky**：新的 QQ 机器人接口标准（非 OneBot），规范仓活跃、实现有 Lagrange.Milky / LLBot / nagisa；生态尚早期。[milky](https://github.com/SaltifyDev/milky) · [文档](https://milky.ntqqrev.org/)
6. **OneBot 12**：规范仓 2023-03 后停更，**无在维护的 QQ 实现**，生态实际转向 Milky 与 OneBot 11。[botuniverse/onebot](https://github.com/botuniverse/onebot)
7. 一句话：今天做个人 24/7 机器人，**NapCat 与 LLBot 是第一梯队**，SnowLuma 紧随其后；其余勿碰。

---

## 九、UNCERTAIN 清单（未能验证）

- NapCat Shell 在 Windows 上是否**完全无窗口**（文档称"无头绿色版本/天生无头"，未实测是否出现托盘或后台窗口）。
- NapCat **单进程并发多账号**能力（多账号配置存在，[#877](https://github.com/NapNeko/NapCatQQ/issues/877)、[#2079](https://github.com/NapNeko/NapCatQQ/issues/2079) 暗示多账号；并发上限与稳定性未验证）。
- NapCat "50–100 MB 内存" 为官方宣传值，未独立测量；SnowLuma 侧无官方数字。
- `emoji_id` 具体取值表（76 等）未逐项核对。
- **群聊 typing**：两家源码均为 C2C 语义，群聊是否可行未验证。
- Windows Server Core / 无桌面会话下两者可用性（均需 QQ NT + 桌面环境）。
- SnowLuma 遥测条款当前"未生效"（[PRIVACY.md](https://github.com/SnowLuma/SnowLuma/blob/main/PRIVACY.md)，截至 2026-06-17），未来版本可能启用。
- LLBot 无头模式"不需要 QQ 客户端"这一说法来自二手中文文档，未自行实测。
- 封号/风控：两家文档与 EULA 都承认账号风险（NapCat [安全文档](https://github.com/NapNeko/NapCatDocs/blob/main/src/other/security.md)、SnowLuma [EULA 3.6](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md)），但**没有可量化的封号率数据**。
- NapCat 插件后门传闻指向**第三方插件**而非核心（[社区讨论](https://linux.do/t/topic/1633322/2)，未能核实全文）；NapCat 官方 `SECURITY.md` 仅说明版本支持与"提 issue 报告"。

---

## 十、主要来源

- NapCat：[仓库](https://github.com/NapNeko/NapCatQQ) · [README](https://github.com/NapNeko/NapCatQQ/blob/main/README.md) · [LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE) · [v4.18.29 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.29) · 文档 [Shell](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Shell.md) / [Framework](https://github.com/NapNeko/NapCatDocs/blob/main/src/guide/boot/Framework.md) / [config/basic](https://github.com/NapNeko/NapCatDocs/blob/main/src/config/basic.md) / [onebot/network](https://github.com/NapNeko/NapCatDocs/blob/main/src/onebot/network.md) / [segment](https://github.com/NapNeko/NapCatDocs/blob/main/src/onebot/segment.md) / [security](https://github.com/NapNeko/NapCatDocs/blob/main/src/other/security.md)（站点：[napcat.napneko.icu](https://napcat.napneko.icu/)）· 源码 [SetMsgEmojiLike](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/msg/SetMsgEmojiLike.ts) / [SetInputStatus](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/SetInputStatus.ts) / [OB11InputStatusEvent](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/event/notice/OB11InputStatusEvent.ts) / [OB11MsgEmojiLikeEvent](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/event/notice/OB11MsgEmojiLikeEvent.ts) / [router.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/router.ts) · [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop)
- SnowLuma：[仓库](https://github.com/SnowLuma/SnowLuma) · [README](https://github.com/SnowLuma/SnowLuma/blob/main/README.md) · [EULA](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md) · [LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE) · [PRIVACY](https://github.com/SnowLuma/SnowLuma/blob/main/PRIVACY.md) · [releases](https://github.com/SnowLuma/SnowLuma/releases) · 文档 [introduction](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/introduction.mdx) / [quickstart](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/quickstart.mdx) / [windows](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/deploy/windows.mdx) / [configuration](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/configuration.mdx) / [update](https://github.com/SnowLuma/SnowLumaDocs/blob/main/content/docs/guide/deploy/update.mdx)（站点：[snowluma.github.io](https://snowluma.github.io/)）· [SDK README](https://github.com/SnowLuma/SnowLuma/blob/main/packages/sdk/README.md) · [@snowluma/sdk](https://www.npmjs.com/package/@snowluma/sdk) · 关键 issue [#505](https://github.com/SnowLuma/SnowLuma/issues/505) [#504](https://github.com/SnowLuma/SnowLuma/issues/504) [#466](https://github.com/SnowLuma/SnowLuma/issues/466) [#395](https://github.com/SnowLuma/SnowLuma/issues/395) [#507](https://github.com/SnowLuma/SnowLuma/issues/507)
- 备选：[Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) · [LLBot](https://github.com/LLOneBot/LuckyLilliaBot) · [go-cqhttp](https://github.com/Mrs4s/go-cqhttp) · [AstralGocq](https://github.com/ProtocolScience/AstralGocq) · [Milky](https://github.com/SaltifyDev/milky)
