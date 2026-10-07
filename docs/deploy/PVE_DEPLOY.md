# PVE 部署与交付说明

> **这份文档写给"拿到一台空的 PVE、要把 DSH-ForLife 跑起来"的人。**
>
> 它**不是**"设计文档"——设计在 `PLAN.MD` 与 `EXECUTION_PLAN.md`。
> 它只讲**怎么部署、怎么升级、怎么备份、出问题先看哪里**。
>
> ⚠️ **一个必须说清的前提**：**这份文档里的步骤，我没有在真实 PVE 上跑过。**
> 我验过的只有：compose 语法、Caddyfile 语法、启动脚本在本机跑通。
> **"在 PVE 上真的能起来"这件事没有被验证过** —— 所以下面每条都标了
> 「验过 / 没验过」，**请按标注对待，不要把没验过的当成已验证的**。

---

## ★★ 2026-10-07：**真机部署实测结果**（这一段是后加的，优先读）

在一台 **Ubuntu 26.04.1 / 4 核 / 7.9 GiB / 63G 单盘 / 无独立 HDD** 的 KVM 虚拟机上，
**从零**按本文档部署了一遍。结论：**照原文做会失败，且失败点有 5 处**；
修掉之后**四个容器全部起来且健康**，反代/端口/冷层/持久化都验过了。

### 会致命的 5 处（**都已在仓库里修掉**，原始报错附后）

| # | 位置 | 症状（原始报错） | 修法 |
|---|---|---|---|
| 1 | §0 `deploy/docker-daemon.json` 的 `_comment` 字段 | **dockerd 拒绝启动**：`unable to configure the Docker daemon with file /etc/docker/daemon.json: the following directives don't match any configuration option: _comment`（Docker **29** 起是严格解析） | 说明搬到 `deploy/docker-daemon.README.md`，JSON 只留合法字段 |
| 2 | `deploy/Dockerfile.app` 装 dsh CLI | `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`（`pnpm add -g` 要求全局 bin 目录在 PATH 里，而 `/root/.local/share/pnpm/bin` 不在） | 改用 `npm i -g`（装到 `/usr/local/bin`，天然在 PATH） |
| 3 | 同上，**包名少了 scope** | `pnpm add -g dsh@0.1.7-rc.2` 里的 `dsh` 在 npm 上**是另一个人的包**（实测只有 `1.0.0`/`1.0.1`）；真正的 CLI 是 **`@deepseek-ai/dsh`**（30 个版本，含 `0.1.7-rc.2`） | 改成 `npm i -g @deepseek-ai/dsh@0.1.7-rc.2`（仓库自己的 `scripts/setup-dev.ps1` 就是这么写的）。⚠️ 这**不只是构建失败，是供应链风险** |
| 4 | `deploy/docker-compose.yml` 的 `- /app:/app:ro` | 宿主没有 `/app` ⇒ Docker 建个**空目录盖住镜像里的代码**：`Error: Cannot find module '/app/packages/gateway/src/server.ts'`（`MODULE_NOT_FOUND`，两个服务都崩溃重启） | **删掉这两行**（那是"阶段 0 用 node 占位镜像"时代的残留） |
| 5 | 同上，`dsh` 服务的 profile | `Error: dsh: profile "forlife-web" does not exist; create it with 'dsh plugin --profile forlife-web add <package>'` —— **DSH 从 `$DSH_HOME/profiles/<名>` 找 profile，不从 cwd 找**（见 `setup-dev.ps1` 的 junction 做法），而镜像里根本没拷 `profiles/` | ①`Dockerfile.app` 补 `COPY --from=build /build/profiles ./profiles`；②dsh 的 command 先 `ln -sfn /app/profiles/forlife-web /data/dsh/profiles/forlife-web` 再 `exec dsh …` |

### 另外 4 处（不致命，但会让"看起来起来了"骗人）

| # | 位置 | 症状 | 修法 |
|---|---|---|---|
| 6 | 命名卷属主 | `mkdir: can't create directory '/data/dsh/profiles': Permission denied` / `EACCES … mkdir '/app/.runtime/dsh/forlife/db'` —— 命名卷是 `root:root`，容器却以 `node`(1000) 跑 | 镜像里预建 `/data*` 并 `chown node:node`（Docker 挂**空**命名卷时会连属主一起播种） |
| 7 | `gateway` 没设 `FORLIFE_DB` | 回落到 `<模块相对路径>/.runtime/…` = 容器里的 `/app/.runtime/…` ⇒ **EACCES**，且那路径在**镜像层**里（容器一重建记忆库就没了） | `FORLIFE_DB: /data/dsh/forlife/db/forlife.sqlite`，并把 `dsh-home` 卷也挂给 gateway（两边必须是**同一个库**） |
| 8 | `dsh` 服务继承了镜像的 HEALTHCHECK | 镜像那条探 `127.0.0.1:8081/admin/`（gateway 的端口），而 dsh 跑在 **3080** ⇒ 容器永远 `unhealthy` | 在 compose 里覆盖 healthcheck 探 3080 |
| 9 | 我们自己的组件 import 不到宿主的包 | `IMPORT FAIL: ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/schemastery' imported from /app/packages/dsh-component/src/config.ts` ⇒ dsh 起来了，但 **3 条 entry 全部 `failed to import`**（记忆/面板/压缩**全都没加载**，而容器看着是 Up 的） | 镜像里建 `node_modules/@deepseek-ai` → `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（等价 `setup-dev.ps1` 那条 junction）。目标在**镜像内**，不牵扯宿主 `~/.dsh` |

### 镜像加速源：**顺序很关键，而且卡住不转移**

- `docker.1ms.run`（本文档原来唯一的那个）真机实测**卡死**（13 分钟零字节 / 240 秒超时）
- 换 `docker.1panel.live` 到第一位后，`caddy:2-alpine` **16 秒**拉完
- 但 `1panel` / `xuanyuan` 对**非官方库**返回 **403**（`mlikiowa/napcat-docker`）⇒ napcat 要用
  `docker.m.daocloud.io` 或前缀形式 `docker pull docker.m.daocloud.io/mlikiowa/napcat-docker:latest` 再 `docker tag`
- ⚠️ **Docker 的 mirror 失败转移只在"明确报错"时发生，连接"卡住"不触发** ⇒ 列表第一位挂掉 = 全部拉取一起挂

### ★★ 一次「假证据」的教训：工具数**不是 11 个，是 34 个**

真机部署时，`docker logs dsh | grep 已注册工具` 给出的是：

```
[forlife] 已注册工具 remember / push_mid_memory / recall_longterm / recall_full / now / get_clock /
set_clock / list_clocks / switch_model / revert_model / router_status
```

**⇒ 看起来只注册了 11 个。** 我和子代理都拿它当证据，甚至一度怀疑
「代码里明明有 `request_recall_extension` / `recover`，为什么生产里没有」。

**根因：那行日志是【硬编码字符串】。**

```js
// packages/dsh-component/src/index.ts（修复前）
log('已注册工具 remember / push_mid_memory / … / router_status')
```

⇒ **它不管实际注册了什么，永远说这 11 个。** 代码加到 34 个工具后，它还说 11 个。

**已修**：加 `registeredNames` 收集器 + `registerOne()`（6 处注册点全改走它），
日志改成从真实列表生成。修完立刻看到：

```
[forlife] 已注册工具（34 个）：remember / push_mid_memory / recall_longterm / recall_full /
request_compaction / request_recall_extension / recover / now / get_clock / set_clock /
list_clocks / switch_model / revert_model / router_status / schedule_wake / register_watcher /
list_wakes / cancel_wake / wake_now / qq_reply / qq_react / qq_typing / defer_turn /
read_pending / list_wake_rules / set_wake_rule / set_status / clear_system_status /
sticker_search / qq_send_sticker / sticker_import / sticker_save / qq_mention_all / qq_group_notice
```

**⇒ 所有工具都在**（含 `qq_reply` —— 那是「`buildQqTools` 生产零调用」修复生效的直接证据）。

> **★ 一个会说谎的证据源，比没有证据更危险。**
> 它不仅**掩盖问题**，还会**制造假问题** ——
> 如果没修这行日志，我们会一直以为「生产里缺 3 个工具」，
> 甚至可能去「修」一个**根本不存在的 bug**。

### 真机验过的（可以依赖）

- ✅ **四个容器全起来**：`caddy`/`dsh`/`gateway` **healthy**、`qq`(NapCat 4.18.33) Up
- ✅ **Caddy 反代通**：`https://forlife.local/admin/` → **200 + `Via: 1.1 Caddy` + 真 HTML**（VM 本机与另一台 Windows 各发一次，都是 200）
- ✅ **只有 80/443 对外**：`ss -tlnp` 里只有 `docker-proxy` 占 80/443（+ sshd 22）；3080/8081/3010/6099/2019 **一个都没对外**
- ✅ **冷热真的是两个文件系统**：`/cold` = `/dev/loop11`(7.8G, ext4)，`/data` = `/dev/sda2`（容器内 `stat -f` 的 fsid 不同），容器 uid 1000 能往冷层写
- ✅ **重启后数据还在**：`docker compose restart gateway dsh` 前后 `tables=61 / migrations=27 / maxVersion=27` 完全一致，迁移不重跑、不重新播种
- ✅ 我们自己的组件**完整加载**：`记忆库就绪 …｜契约基线 v1（参数 143，doc 47）`、注册了 11 个工具、压缩引擎/沉降循环/唤醒轮询器/面板接口全部就位

### 真机**没能验**的（别当成验过了）

- ❌ **公网 ACME 证书**：本环境只有内网 IP、没有公网域名 ⇒ 签不出 Let's Encrypt 证书。
  实测走的是 **Caddy 自己的内部 CA**（`CN=Caddy Local Authority - ECC Intermediate`），
  且**只对"非 IP 的站点名"生效**：`FORLIFE_HOST` 写成 IP 时 Caddy **明确不为 IP 启用自动 HTTPS**（443 无证书）。
  ⇒ **`FORLIFE_HOST` 必须是域名**；真域名 + ACME 那一段仍然**没验过**
- ❌ **`docker compose up` 全量（含 qq）的端到端**：napcat 起来了，但**没有扫码登录**（要人工）
- ❌ **重启整机**：模拟 HDD 写进了 `/etc/fstab`（`loop,nofail,noatime`，`findmnt --verify` 0 错误），
  但**没有真的重启验证**（怕中断当时其它人的 SSH 会话）
- ❌ **评分器 profile**（`llama-server`）：没拉 ghcr 镜像、没有模型权重
- ❌ **"记忆系统真的工作"**：本轮验的是**环境与交付**（起得来、端口对、反代通、数据落对盘），
  **不是一个功能测试** —— 记忆写入/召回的正确性没有被验证

### 一处**行为**上的注意（不是 bug，但要知道）

`deploy/Caddyfile` 刻意**不放兜底 handle** ⇒ `/admin*`、`/svc/*` 之外的路径
**返回 `200` 空响应**（不是 404/403）。内容确实**拿不到**（响应头里没有 `Via: 1.1 Caddy`、
没有 CSP，说明根本没被反代到 gateway），但**状态码是 200** ——
做健康检查/监控的人要按"空 200"来判，别按 404 判。

---


## 一、虚拟机规格

| 项 | 建议 | 为什么 |
|---|---|---|
| **CPU** | 4 核起 | DSH + gateway 是 Node 进程；评分器（可选）另外吃核 |
| **内存** | 8 GiB 起 | 若启用 `llama-server` 评分器，**再加模型大小**（3B 量化约 2–3 GiB） |
| **系统盘（SSD）** | 40 GiB | 系统 + 容器镜像 + `hot`/`warm` 层 |
| **数据盘（HDD）** | 按需，建议 ≥ 200 GiB | **`cold` 层专用**（归档、老表情、老记忆） |
| **网络** | 桥接，固定 IP | Caddy 要占 80/443 |

### ★ 数据盘**必须单独挂**（这是整个分层设计的落点）

> **`cold` 层指向另一块物理盘**，才有意义 ——
> **备份和源数据在同一块盘上，盘坏了备份一起没**（`backup.ts` 模块头写了这条）。

挂载点建议：`/mnt/forlife-cold`，`fstab` 里用 **UUID**（不是 `/dev/sdX`，那个会变）。

**没验过**：这套规格是**按代码的资源需求推的**，不是在 PVE 上量出来的。

---

## 二、首次开机

### 0. ★ **先配镜像加速源**（不配的话后面必然失败）

> **国内直连 `registry-1.docker.io` 会超时**：
> `dialing registry-1.docker.io:443 ... i/o timeout`。
> **本机就是这样** —— 所以我写的 Dockerfile **一次都没构建成功过**。
> ⇒ **不配这一步，阶段 10/11 的构建必然失败。**

用 **[毫秒镜像（1ms.run）](https://1ms.run/)** 的加速源：

> ⚠️ **2026-10-07 真机实测**：照下面做**会把 dockerd 弄死**（Docker 29 严格解析 `daemon.json`）。
> 原因与修法见本节开头那张表第 1 行，以及 **`deploy/docker-daemon.README.md`**。
> **`daemon.json` 里绝不能有任何非 Docker 的字段（包括 `_comment`）。**
> 另外：实测 `docker.1ms.run` **会卡死**，可用的是 `docker.1panel.live`（顺序见 README）。

```bash
sudo cp -n /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true
sudo cp /opt/forlife/deploy/docker-daemon.json /etc/docker/daemon.json
sudo systemctl restart docker
systemctl is-active docker     # ★ 这一步必须 active，否则先看 journalctl -u docker

# 验证
docker pull caddy:2-alpine     # ★ 挑小的验；别拿 node:24-alpine 试（1ms 上会卡 13 分钟）
```

配置在 `deploy/docker-daemon.json`（列了**四个**源，**为了容灾** ——
单一站点挂掉时还能拉）。

### ⚠️ 它只管 **Docker Hub**

`registry-mirrors` 只对 **Docker Hub 的镜像**生效。本项目里有一个
**不在 Docker Hub 上**的镜像：

```
ghcr.io/ggml-org/llama.cpp:server   # 评分器（可选，profiles: [scorer]）
```

⇒ **那个不会被这个配置加速**，要另外想办法：
- 用 `docker.1ms.run/ghcr.io/ggml-org/llama.cpp:server` 这种**前缀形式**试试
  （很多国内加速源支持，**但我没验证过 1ms 是否支持**）；
- 或者从别处导出镜像再 `docker load`。

### ⚠️ 第三方加速源的固有风险（如实说）

**它能看到你拉了哪些镜像。** 生产环境如果有合规要求，
应当用**自建 registry 或云厂商的官方加速**，而不是第三方站点。

### 1. 装依赖

```bash
# Docker + compose 插件
curl -fsSL https://get.docker.com | sh
docker compose version    # 要 v2（本仓库用的是 `docker compose`，不是 `docker-compose`）
```

### 2. 拿代码

```bash
git clone <仓库地址> /opt/forlife
cd /opt/forlife
```

### 3. ★ 设两个**必需**的环境变量

```bash
export FORLIFE_HOST=forlife.example.com     # Caddy 的站点地址
export ACME_EMAIL=you@example.com           # ACME 账号邮箱
```

> **不设会怎样**：`deploy/Caddyfile` 里的 `email {$ACME_EMAIL}` 会展开成 `email `（空参数）
> ⇒ **Caddy 解析失败、起不来**，而报错是
> `wrong argument count or unexpected line ending after 'email'` ——
> **它完全没提环境变量**，排障的人会去改 Caddyfile 的 email 行。
>
> **`docker compose up` 会先警告** `The "ACME_EMAIL" variable is not set. Defaulting to a blank string.`
> ⇒ **先看 compose 的警告，再看 Caddy 的解析错误。**
>
> （**验过**：本机 `docker compose config --quiet` 两条路径都验过。
> **没验过**：在 PVE 上真的起 Caddy。）

### 4. 数据目录与权限

```bash
mkdir -p /mnt/forlife-cold
# 容器里的 uid/gid 要对得上（NapCat 用 1000:1000）
sudo chown -R 1000:1000 /mnt/forlife-cold

> ⚠️ **2026-10-07 真机实测（第 11 处缺陷）**：**光建挂载点不够** ——
> 冷层的**子目录**也要建，否则写入**静默失败**（`No such file or directory`，而应用不报错）：
>
> ```bash
> sudo mkdir -p /mnt/forlife-cold/{tiers/cold,archives,backups}
> sudo chown -R 1000:1000 /mnt/forlife-cold
> ```
>
> 这两个子目录分别对应 `FORLIFE_ROOT_COLD` / `FORLIFE_ARCHIVE_DIR` / `FORLIFE_BACKUP_DIR`。
> 镜像入口现在也会幂等地补建一遍，但**文档步骤不能省** ——
> 因为"照文档做"的人不该依赖镜像里的兜底。
```

### 5. 起服务

```bash
cd /opt/forlife/deploy

# 四个核心服务（caddy / dsh / gateway / qq）
docker compose up -d

# 要评分器再加 profile（它要几个 GB 的模型权重）
# docker compose --profile scorer up -d
```

**验过**：`docker compose config --quiet` 退出码 0；`--profile scorer` 时**五服务齐**
（caddy / dsh / gateway / llama-server / qq）。
**没验过**：真的把五个容器起起来跑通。

### 6. 扫码登录 QQ

NapCat 的 WebUI 只在**回环**上发布（`127.0.0.1:6099`）。
从宿主机开一条隧道过去扫码：

```bash
ssh -L 6099:127.0.0.1:6099 <pve-host>
# 然后浏览器开 http://127.0.0.1:6099/webui
```

> **⚠️ 千万不要 `docker stop` QQ 容器** ——
> 那会让 NapCat **掉登录、要人工重新扫码**。
> 本项目里已经因为这件事吃过一次亏（`EXECUTION_PLAN.md` 的验收③ 里记着）。

### 7. 首次设置后台口令

浏览器开 `https://$FORLIFE_HOST/admin/`，**第一次会要求设置口令**
（scrypt 加盐哈希，令牌只放 HttpOnly cookie）。

---

## 三、升级

```bash
cd /opt/forlife
git pull

# 1. 先备份（**升级前必做** —— 迁移会改库结构）
# ★ 备份**没有 CLI 脚本** —— 走后台接口（要登录）：
#   POST /api/admin/backup
# 或用 Node 直接调（本机验证时就是这么做的）：
#   import { runBackup } from "@forlife/store"
# 或 Linux 上直接调 store 的 runBackup（见下"备份"一节）

# 2. 重建并重启
cd deploy
docker compose build
docker compose up -d
```

> **迁移是自动的**：DSH 启动时会跑 `packages/store/src/migrations.ts` 里的迁移。
> **它会在迁移前做一个快照**（`db.ts` 的 `backupDatabase`）——
> 但那个快照**不做回读验证**，所以**不要把它当成唯一退路**。

---

## 四、备份

### 库备份：用 `VACUUM INTO`，**不是拷文件**

> **拷 `.sqlite` 是错的**：WAL 模式下最新数据可能在 `-wal` 里，
> 只拷主文件会**静默丢掉最近的写入**（备份看起来是好的，恢复后少一截）。

后台有手动接口：`POST /api/admin/backup`（**要登录**）。
目标目录由 **`FORLIFE_BACKUP_DIR`** 指定 —— **接口不接受任意路径**（那会是提权）。

```bash
export FORLIFE_BACKUP_DIR=/mnt/forlife-cold/backups   # ★ 指向**另一块盘**
```

**验过**：本机对真实库跑过一次，`schema v25 / 57 张表 / 完整性 ok`，
且**独立验证**（`verifyBackup`）通过。

### 归档：`FORLIFE_ARCHIVE_DIR`

```bash
export FORLIFE_ARCHIVE_DIR=/mnt/forlife-cold/archives
```

> **归档是"很久以后才回来读"的东西，所以它比备份更该放在另一块盘上。**

### 建议的定时（cron）

```cron
# 每天 03:00 备份
0 3 * * * curl -fsS -X POST -b /root/.forlife-cookie https://$FORLIFE_HOST/api/admin/backup
```

**没验过**：cron 与 cookie 的具体取法（本机是用管理会话调的接口）。

---

## 五、端口与暴露

| 端口 | 谁 | 对外吗 |
|---|---|---|
| **80 / 443** | Caddy | ✅ **唯一对外入口** |
| 8081 | gateway | ❌ 只在 `edge` 网络内（Caddy 反代过去） |
| 3080 | DSH Web UI | ❌ **绝不对外**（见下） |
| 3010 | OneBot（反向 WS） | ❌ 只在 `internal` |
| 6099 | NapCat WebUI | ❌ 只绑回环，靠 SSH 隧道 |
| 2019 | Caddy Admin API | ❌ **只走 unix socket**（绝不 publish） |

### ★ 为什么 DSH 的 Web UI 不在这里暴露

> 它的 `/api` 有 **Host/Origin 信任栅栏**，cookie 是 **host-only + SameSite=Strict**，
> **官方明确不支持非本机域名反代** ⇒ 留 loopback / 隧道。
> （这条写在 `deploy/Caddyfile` 的头部注释里，**别改**。）

---

## 六、⚠️ 一个**已知的暴露**（必须处理）

### 现象

DSH 自己的日志里**有一行把 web token 以明文写在 URL 查询串里**：

```
dsh web: http://127.0.0.1:3080/?token=<43 字符>
```

### 为什么不能靠"脱敏"解决

> 本项目的 gateway **已经在唯一的日志汇聚点做了写入侧脱敏**
> （`packages/gateway/src/redact.ts` + `server.ts` 的 `log` 函数，
> 有**接线守卫测试**防止被摘掉）。
>
> **但这一行是 DSH 自己写的，不是我们写的** ——
> 我们**不能在写入侧拦它**，而在展示侧脱敏正是 `log-buffer.ts` 明确反对的做法
> （"会给人'已经安全了'的错觉，而**真正的泄露早就发生了**"）。

### 所以缓解在**部署层**（三条都要做）

1. **日志文件权限收紧**：
   ```bash
   chmod 600 /opt/forlife/.runtime/web.log
   ```
2. **轮转并限制保留**（`logrotate`），让那条 token 不会长期躺在盘上：
   ```
   /opt/forlife/.runtime/web.log {
       daily
       rotate 7
       compress
       missingok
       notifempty
   }
   ```
3. **★ 绝不把 `web.log` 打包外发** ——
   排障时发 `admin.log`（那份已经脱敏过），**不要发 `web.log`**。

> **这条如实记在这里，而不是假装不存在。** 我们没有从根上解决它
> （根上要么 DSH 改日志格式，要么 token 不走 query），
> **所以至少要让运维的人知道它在那儿。**

---

## 七、出问题先看哪里

| 症状 | 先看 |
|---|---|
| Caddy 起不来，报 `... after 'email'` | **先看 compose 的警告**：`FORLIFE_HOST` / `ACME_EMAIL` 设了吗 |
| 容器起来了但 `docker port` 是空的 | 网络是 `internal: true` 的 —— **那种网络没有任何对外路由，发布端口对它完全无效**（这个坑记在 `deploy/docker-compose.dev.yml` 头部） |
| QQ 不回消息 | NapCat 登录态（WebUI）；**别 `docker stop` 它** |
| 后台打不开 | Caddy 路由；gateway 是否在 `edge` 网络上 |
| 沉降/碎片维护没动静 | 看 gateway 日志里有没有 `维护循环已启动`；没配 `FORLIFE_ROOT_HOT` 时**功能明确禁用**（不是坏了） |

---

## 八、这份文档里**没验过**的部分（汇总）

**别把下面这些当成已验证的**：

- ❌ 在真实 PVE 上部署（本文档的所有步骤）
- ❌ 五个容器真的跑通（只验了 compose 语法）
- ❌ `llama-server` 真的加载模型（本机没有权重文件）
- ❌ `ghcr.io/ggml-org/llama.cpp:server` 这个镜像标签是否还存在
- ❌ Caddy 真的申请到证书、真的反代成功
- ❌ cron 定时备份的具体取法
- ❌ 虚拟机规格是**按代码需求推的**，不是量出来的

**验过的**（可以依赖）：

- ✅ `docker compose config --quiet` 退出码 0（含 `--profile scorer` 五服务）
- ✅ `caddy adapt --config deploy/Caddyfile` 退出码 0
- ✅ 备份对真实库跑通并独立验证通过
- ✅ gateway 的日志脱敏已接线（有接线守卫测试）
- ✅ 各启动脚本在本机跑通（Windows）
