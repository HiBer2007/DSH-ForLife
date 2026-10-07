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
