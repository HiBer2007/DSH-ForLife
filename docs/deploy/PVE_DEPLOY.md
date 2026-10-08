# PVE 部署与交付手册

> **这份文档写给"拿到一台空的 PVE、要把 DSH-ForLife 跑起来"的人。**
>
> 它**不是**"设计文档"——设计在 [`PLAN.MD`](../../PLAN.MD) 与 [`EXECUTION_PLAN.md`](../../EXECUTION_PLAN.md)。
> 它只讲**怎么部署、怎么升级、怎么备份、出问题先看哪里**。
>
> **怎么读**：每节是"命令 → 预期结果 → 注意事项"。首次部署走**第三节**，升级走**第五节**，
> 备份走**第六节**，出事直接跳**第九节**；改动编排/镜像前先看**第四节**。
> 尚未取得端到端验证的环节汇总在**附录 B**，首次上线按"第一次执行"对待。
>
> 当次部署的逐次失败、原始报错与排查过程属于**排障记录**，不是操作手册，因此不内联在这里 ——
> 见 [`docs/incidents/`](../incidents/)（索引在 [`docs/README.md`](../README.md)）。
> 那些记录会过期，**别当成现状**。

---

## 〇、约定

- 命令按 Linux / `sh` 写；`<...>` 是占位符，按实际值替换。需要 root 的命令都带 `sudo`。
- **示例统一用 `wget`，不用 `curl`** —— 部分最小化系统（含本次交付验证所用的虚拟机）**没有 `curl`**；
  机器上有 `curl` 时两者等价。
- 部署根目录记作 `/opt/forlife`，冷层挂载点记作 `/mnt/forlife-cold`。
- **版本前提**：Docker Engine + `docker compose` **v2**（是 `docker compose`，不是 `docker-compose`）；
  基础镜像由仓库固定为 `node:24-alpine` / `caddy:2-alpine`；**Docker 29 起严格解析 `daemon.json`**（见 1.1）。

---

## 一、前置条件

以下五条都是**硬前置**：缺任何一条，都会在后面的步骤里卡住（构建失败、启动失败，或写入静默失败）。

### 1.1 镜像加速源（不配，构建必然失败）

国内直连 `registry-1.docker.io` 超时（`dialing registry-1.docker.io:443 ... i/o timeout`），
而 `docker compose build` 必须拉 `node:24-alpine` 与 `caddy:2-alpine`。

```bash
sudo cp -n /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true
sudo cp /opt/forlife/deploy/docker-daemon.json /etc/docker/daemon.json
sudo systemctl restart docker
systemctl is-active docker              # 期望 active；不是就看 journalctl -u docker
docker info | grep -A5 'Registry Mirrors'
docker pull caddy:2-alpine              # 验证：挑小的镜像，期望秒级完成
```

> ⚠️ **`daemon.json` 里不能写任何非 Docker 字段，包括 `_comment`。**
> Docker 29 是严格解析，未知顶层键会让 **dockerd 直接拒绝启动**（不是"忽略这一行"）：
> `unable to configure the Docker daemon with file /etc/docker/daemon.json: the following directives don't match any configuration option: _comment`
> ⇒ 配置说明只写在 `deploy/docker-daemon.README.md` 里。那条报错**只说字段不认识**，
> 不会提示"注释字段非法" —— 别去怀疑镜像源。

> ⚠️ **源的顺序有意义，而且"卡住"不会故障转移。** Docker 的 mirror 失败转移只在**明确报错**时发生，
> 连接**卡住不触发** ⇒ 列表第一位挂掉 = **所有拉取一起挂**。
> 当前顺序：`docker.1panel.live` → `docker.1ms.run` → `docker.xuanyuan.me` → `docker.m.daocloud.io`；
> **定期用上面那条 `docker pull` 验证第一位还能不能拉**。

> ⚠️ **非官方库在部分源上返回 403**（`mlikiowa/napcat-docker` 在 `docker.1panel.live` / `docker.xuanyuan.me` 上）。
> 换支持它的源，或用**前缀形式**再打回本地 tag：
> ```bash
> docker pull docker.m.daocloud.io/mlikiowa/napcat-docker:latest
> docker tag  docker.m.daocloud.io/mlikiowa/napcat-docker:latest mlikiowa/napcat-docker:latest
> ```

**`registry-mirrors` 只管 Docker Hub**：`ghcr.io/ggml-org/llama.cpp:server`（评分器，可选 `scorer` profile）
不在 Docker Hub 上，不会被加速（ghcr.io 本身可达：未带 token 返回 401，属正常）。
**合规提示**：第三方加速源能看到你拉了哪些镜像；有合规要求时用自建 registry 或云厂商官方加速。

### 1.2 已知的源解析陷阱：IPv6-only 的源必然超时

`security.ubuntu.com`、`mirrors.tuna.tsinghua.edu.cn` 等**解析出 IPv6-only 地址**；
机器若**没有 IPv6 默认路由**（`ip -6 route` 只有 `fe80::/64`），这类源**必然超时**，
而报错看起来像"网络时好时坏"（其实取决于那次解析出的是哪个地址族）。

⇒ 换有 IPv4 的镜像源（如 `mirrors.aliyun.com`），或给机器配上 IPv6 默认路由。**先查地址族，再怀疑网络质量。**

### 1.3 两个必需的环境变量

| 变量 | 取值 | 作用 |
|---|---|---|
| `FORLIFE_HOST` | **域名**，如 `forlife.example.com` | Caddy 的站点地址 |
| `ACME_EMAIL` | ACME 账号邮箱 | Caddy 申请证书的账号 |

```bash
export FORLIFE_HOST=forlife.example.com
export ACME_EMAIL=you@example.com
```

> ⚠️ **`FORLIFE_HOST` 必须是域名，不能写 IP** —— 写成 IP 时 Caddy **不会为 IP 启用自动 HTTPS**（443 上没有证书）。

> ⚠️ **不设 `ACME_EMAIL` 会让 Caddy 起不来，而报错完全不提环境变量**：
> `deploy/Caddyfile` 的 `email {$ACME_EMAIL}` 展开成 `email `（有指令没参数）⇒
> `wrong argument count or unexpected line ending after 'email'`。
> **别去改 Caddyfile 的 email 行，去设变量。**

> **排障顺序**：变量没设时 `docker compose up` **会先警告**
> `The "ACME_EMAIL" variable is not set. Defaulting to a blank string.`
> ⇒ **先看 compose 的警告，再看 Caddy 的解析错误。**

两个变量由 `deploy/docker-compose.yml` 的 `${...}` 插值读取 ⇒ 在**执行 compose 的那个 shell** 里 `export`，
或写进 `deploy/.env`（compose 自动读取，适合长期部署）。只在别的 shell 里 export 会退化成上面那条解析错误。

### 1.4 冷层：必须是独立文件系统

**`cold` 层指向另一块物理盘才有意义** —— 备份和源数据在同一块盘上，**盘坏了备份一起没**。
生产用 HDD；单盘/演练环境可以用 **loop + ext4 稀疏文件**造一个独立文件系统：

```bash
# 生产：把 HDD 挂到 /mnt/forlife-cold，fstab 里用 UUID（不要用会变的 /dev/sdX）

# 单盘/演练：稀疏文件模拟一块 HDD（约 0.15 秒建完，不占实际空间）
sudo fallocate -l 8G /var/lib/forlife-cold.img
sudo mkfs.ext4 -F /var/lib/forlife-cold.img
sudo mkdir -p /mnt/forlife-cold
echo '/var/lib/forlife-cold.img /mnt/forlife-cold ext4 loop,nofail,noatime 0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
findmnt --verify          # 期望 0 错误
```

> ⚠️ **光建挂载点不够：冷层的子目录也必须建。** 在**空**的冷盘上写入会**静默失败**
> （`No such file or directory`，**而应用一句话都不报**）⇒ 沉降、归档、备份**全部写不进去**。
>
> ```bash
> sudo mkdir -p /mnt/forlife-cold/{tiers/cold,archives,backups}
> sudo chown -R 1000:1000 /mnt/forlife-cold
> ```
>
> 三个子目录分别对应容器里的 `FORLIFE_ROOT_COLD` / `FORLIFE_ARCHIVE_DIR` / `FORLIFE_BACKUP_DIR`。
> 镜像入口也会幂等地补建一遍，但**照文档做时不要依赖镜像里的兜底**。

> ⚠️ **属主必须是容器内运行用户的 uid**：`node` 与 NapCat 都用 **1000:1000**，冷层由两个容器共用。

### 1.5 其它

固定 IP 的桥接网络（Caddy 要占 **80/443**，不能被别的东西占着）；到 `<仓库地址>` 的 git 访问权限。

---

## 二、虚拟机规格

| 项 | 建议 | 依据 |
|---|---|---|
| **CPU** | 4 核起 | DSH 与 gateway 都是 Node 进程；评分器（可选）另吃核 |
| **内存** | 8 GiB 起 | 启用 `llama-server` 评分器时**再加模型大小**（3B 量化约 2–3 GiB） |
| **系统盘（SSD）** | 40 GiB | 系统 + 容器镜像 + `hot` / `warm` 层 |
| **数据盘（HDD）** | 按需，建议 ≥ 200 GiB | **`cold` 层专用**（归档、老表情、老记忆） |
| **网络** | 桥接、固定 IP | Caddy 要占 80/443 |

- 冷层挂载点固定用 `/mnt/forlife-cold`；换真盘时把盘挂到这里（或改 `FORLIFE_COLD_DIR`），容器侧路径不用改。
- 单盘部署也能跑：不设 `FORLIFE_ROOT_COLD` 时冷层会**退回 warm**，日志与面板会明说"冷层退回了"（**不是坏了**）。
- 这套规格是**按代码的资源需求推的**，不是压测量出来的 —— 见附录 B。

---

## 三、首次部署

**总览**：装 Docker → 配加速源 → 取代码 → 建数据目录 → 设变量 → 构建启动 → 设口令 →（可选）接 QQ → 验证。
**从零合计约 5–6 分钟**（分项见附录 A）。

### 3.1 装 Docker

```bash
wget -qO- https://get.docker.com | sh
docker compose version      # 期望 v2.x
```

**预期耗时**：2 分 05 秒（4 核虚拟机实测）。

### 3.2 配镜像加速源

按 **1.1** 执行到位（含 `docker pull caddy:2-alpine` 那步验证）。**这一步没验证通过，不要往下走。**

### 3.3 取代码

```bash
git clone <仓库地址> /opt/forlife
cd /opt/forlife
```

### 3.4 建数据目录与冷层

按 **1.4** 建好挂载点、三个子目录与属主：

```bash
sudo mkdir -p /mnt/forlife-cold/{tiers/cold,archives,backups}
sudo chown -R 1000:1000 /mnt/forlife-cold
```

### 3.5 设环境变量

按 **1.3** 设好 `FORLIFE_HOST`（**域名**）与 `ACME_EMAIL`。

### 3.6 构建并启动

```bash
cd /opt/forlife/deploy
docker compose build          # 冷构建（--no-cache）2 分 11 秒；增量（缓存热）3 分 14.6 秒
docker compose up -d
docker compose ps
```

**预期结果**：`caddy` / `dsh` / `gateway` 三个 **healthy**，`qq` **Up**。

要评分器再加 profile（需先把 `scorer.gguf` 放进 `FORLIFE_MODELS_DIR`，它是几 GB 的模型权重）：

```bash
docker compose --profile scorer up -d     # 五服务齐：外加 llama-server
```

**这一步最容易踩的三条**（完整清单见第四节）：

1. **不要**给任何服务挂 `- /app:/app:ro`（宿主没有 `/app` ⇒ 空目录盖住镜像里的代码 ⇒ `MODULE_NOT_FOUND`）。
2. 带 `build:` 的**只能有 `dsh` 一个**；`gateway` 必须纯引用同一个 tag，否则 `--no-cache` 时 BuildKit export 撞车。
3. `command:` 的 `>-` 折叠块里**不能出现 `#`**（那是内容不是注释 ⇒ 整条命令变成注释、**退出码 0** ⇒ `Restarting (0)` 无限重启）。

### 3.7 首次设置后台口令

浏览器打开 `https://$FORLIFE_HOST/admin/`，**第一次会要求设置口令**
（scrypt 加盐哈希；令牌只放 HttpOnly cookie）。内网自签环境下浏览器会提示证书不受信任，属预期（附录 B）。

### 3.8 接 QQ（可选，但需要人工一步）

**a) 先启用 QQ 链路。** 主编排**默认不开**：gateway 只在 `FORLIFE_ONEBOT=1` 时才起 OneBot 服务，
否则日志里明确写 `[admin] QQ 链路未启用（要启用请设 FORLIFE_ONEBOT=1）`。
`deploy/docker-compose.yml` 的 `gateway.environment` **目前没有**这几项，需要按需补上：

```yaml
      FORLIFE_ONEBOT: "1"
      FORLIFE_ONEBOT_TOKEN: <自己生成的访问令牌>   # accessToken 是唯一门槛
      FORLIFE_ONEBOT_PORT: "3010"
      FORLIFE_DRIVER: headless                    # ★ 不设时默认 fake（不真的驱动 DSH）
      FORLIFE_NAPCAT_WEBUI_PORT: "6099"           # 面板内嵌 NapCat 页用；不设则 CSP 不放行 frame-src、页面白屏
      FORLIFE_NAPCAT_TOKEN: <NapCat WebUI 的 token>
```

NapCat 侧配置**反向 WS**：地址 `ws://gateway:3010/`（两边同在 `internal` 网络，服务名可直接解析），鉴权用同一个 token。

**b) 再扫码登录。** 主编排里 `qq` 只挂 `internal` 网络、**不发布任何端口**（`expose` 只对容器间可见）。
用覆盖文件临时接一条 `edge` 网络并把 6099 发布到宿主：

```bash
cd /opt/forlife/deploy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d qq
docker port qq                            # 期望 6099/tcp -> 0.0.0.0:6099
docker logs qq 2>&1 | grep -i webui       # WebUI 的 token 在启动日志里

# 在你自己的机器上开隧道，再开 http://127.0.0.1:6099/webui 扫码
ssh -L 6099:127.0.0.1:6099 <pve-host>
```

> ⚠️ `docker-compose.dev.yml` 是**覆盖文件，不能单独校验**：
> `docker compose -f deploy/docker-compose.dev.yml config` **必然失败**
> （`service "qq" has neither an image nor a build context specified` —— 它本来就没有 `image`）。
> **别急着给它补一个 `image`**（那会让覆盖变成重新定义服务）；正确写法是**两份一起给**。

> ⚠️ 覆盖文件把 6099 发布在 **`0.0.0.0`** ⇒ 扫完码把它退回主编排（`docker compose up -d qq`）或用防火墙挡住。
> **这个端口不该长期对外。**

> ⚠️ **不要 `docker stop` / `docker rm` QQ 容器**（会让 NapCat 掉登录、要人工重新扫码）；
> **永远不要 `docker compose down -v`** —— 它会连卷一起删，登录态必然重扫。

### 3.9 验证清单

逐条对，任何一条不符先跳第九节。

```bash
cd /opt/forlife/deploy

# ① 四个容器：caddy / dsh / gateway healthy，qq Up
docker compose ps

# ② 对外只有 80/443（+ sshd 22）；3080/8081/3010/6099/2019 一个都不该对外
ss -tlnp | grep LISTEN

# ③ 组件加载与契约基线
docker logs dsh 2>&1 | grep 记忆库就绪
#    期望：记忆库就绪：/data/dsh/forlife/db/forlife.sqlite｜契约基线 v1（参数 N，doc M）

# ④ 生产工具数（"组件真的挂上了"的证据）
docker logs dsh 2>&1 | grep 已注册工具
#    期望：已注册工具（34 个）：…（含 qq_reply 等）

# ⑤ 反代通：响应头里要有 Via: 1.1 Caddy，body 是真的 HTML
wget -S -qO- https://$FORLIFE_HOST/admin/ | head

# ⑥ 冷热确实是两个文件系统（fsid 不同），且容器 uid 1000 能往冷层写
docker compose exec dsh sh -c 'stat -f -c %i /cold; stat -f -c %i /data; touch /cold/tiers/cold/.probe && echo cold-writable'
```

**预期结果（本次交付实测口径）**：四个容器全部起来且健康；对外端口**只有 80 / 443 / 22**；
`https://<域名>/admin/` 返回 **200** 且响应头含 `Via: 1.1 Caddy`；冷层与数据层是两个文件系统；生产工具数 **34**。

> ⚠️ **工具数只信"从真实注册列表生成"的那行日志。** 若某个版本把它写成硬编码字符串，
> 它会**不管实际注册了什么**都报同一个数字 —— 那不仅掩盖问题，还会**制造假问题**
> （让人去"修"一个不存在的 bug）。数字与代码里的注册点不一致时，**先查日志是不是被写死了**。

> ⚠️ **已知行为：`/admin/` 以外的路径返回 `200` 且 body 为空**（不是 404）。
> `deploy/Caddyfile` 刻意**不放兜底 handle**（兜底会把后续动态插入的路由永久遮蔽）。
> 内容确实拿不到（响应头里没有 `Via: 1.1 Caddy`、没有 CSP，说明根本没被反代到 gateway），
>

> ⚠️ **2026-10-08 更正**：这里原来写着
> 「状态码是 200 ⇒ 做健康检查/监控时**按空 200 判**，别按 404 判」。
>
> **那个判断是错的。** 「非 `/admin` 路径返回空 200」**不是设计，是缺陷** ——
> 站点块当时**只 `handle /admin*` 与 `/svc/*`**，没代理 `/api/*`（见下面「站点块必须代理 /api/*」）。
> 现在修好了：未匹配的路径返回**正常的 404**。
>
> **⇒ 把异常当成"已知行为"记进文档，是最坏的一种记录方式** ——
> 它会让人**照着错的行为去做监控**。

**重启后的数据检查**（升级或重启后各做一次）：

```bash
docker compose restart gateway dsh
docker logs dsh 2>&1 | grep -E '已应用迁移|记忆库就绪'
```

**预期**：重启前后 `记忆库就绪` 报告的路径与契约基线一致，且**没有新的 `已应用迁移` 行**
（迁移不重跑、不重新播种）。

---

## ★ 站点块必须代理 `/api/*`（**否则整个管理面板不能用**）

`deploy/Caddyfile` 的站点块里，**除了 `/admin*`，还必须有一条 `/api/*`**：

```caddyfile
{$FORLIFE_HOST} {
	handle /admin* {
		reverse_proxy gateway:8081
	}
	handle /api/* {          # ★ 少这一条，面板直接打不开
		reverse_proxy gateway:8081
	}
	handle /svc/* {
		reverse_proxy gateway:8081
	}
}
```

**漏掉它会怎样**：前端要调 `/api/admin/*` 与 `/api/client/*`，
没匹配到任何 `handle` ⇒ Caddy 返回 **200 + 空 body** ⇒ 浏览器报

```
JSON.parse: unexpected end of data at line 1 column 1 of the JSON data
```

**而且不进首次设置流程**（因为没有 `needsSetup` 可读），停在登录页 ——
看起来像"口令配错了"，其实**请求根本没到后端**。

**怎么快速定位**：在容器里**绕过 Caddy** 直连 gateway ——
如果直连是好的、经 Caddy 才变空，**问题一定在路由层**：

```bash
docker exec <gateway容器> node -e '
  require("node:http").get({host:"127.0.0.1",port:8081,path:"/api/admin/session"},
    (r)=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log(r.statusCode,b));})'
# 期望：200 {"authenticated":false,"needsSetup":true}
```

> **空 200 比 404 更难查**：404 一眼就是"没有这个路径"，
> 而空 200 看起来像"通了，但没数据"，会让人去查后端、查数据库、查鉴权、查 CORS，
> **而真正的问题在最前面那道门。**

## 四、编排与镜像里的硬约束（改动前先看这张表）

每一条都是"看起来可以简化、简化了就坏"的地方：

| 位置 | 约束 | 违反了会怎样 |
|---|---|---|
| `deploy/docker-daemon.json` | 只能有合法 Docker 字段，**不能有 `_comment` 之类的说明键** | Docker 29 严格解析 ⇒ **dockerd 起不来**（整个 Docker 挂掉） |
| `deploy/Dockerfile.app` | dsh CLI 包名必须是 **`@deepseek-ai/dsh`**（带 scope） | 装到**别人的同名包**上 —— 不只是构建失败，是**供应链风险** |
| 同上 | 用 `npm i -g`，**不要** `pnpm add -g` | pnpm 12 要求全局 bin 目录在 PATH 里 ⇒ `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH` |
| 同上 | **两个 `FROM` 阶段各自**设一次 registry（`pnpm config set` 必须在 `corepack enable` 之后） | 容器读不到宿主 `~/.npmrc`，而 `FROM` 开新阶段不继承上一阶段的设置 ⇒ 最慢那步（`npm i -g @deepseek-ai/dsh`，786 MB）走公网，冷构建从 **2 分 11 秒**变 **33 分 8 秒**；顺序写错则 `/bin/sh: pnpm: not found`（exit 127） |
| 同上 | `COPY --from=build /build/profiles ./profiles` | `dsh --profile forlife-web` 找不到 profile ⇒ 崩溃重启循环 |
| 同上 | `/app/node_modules/@deepseek-ai` → 全局安装的包树（镜像内软链） | dsh 能起来，但**三条 entry 全部 `failed to import`**（记忆/面板/压缩全没加载，而容器看着是 Up 的） |
| 同上 | `/app/profiles` 与 `/data*` 预建并 `chown node:node` | ①DSH 每次启动无条件重写 `cordis.yml` ⇒ `EACCES … prepareProfile`；②命名卷是 `root:root`、容器以 `node`(1000) 跑 ⇒ `Permission denied` |
| `deploy/docker-compose.yml` | `dsh` / `gateway` **不要**挂 `/app:/app:ro` | 空目录盖住镜像里的代码 ⇒ `MODULE_NOT_FOUND`，两个服务崩溃重启 |
| 同上 | `build:` 只写在 `dsh` 上，`gateway` 纯引用同一 tag | `--no-cache` 时 BuildKit 并行 export 撞车：`image ...: already exists` |
| 同上 | `command:` 的折叠块里不能出现 `#` 注释 | 命令变成注释 ⇒ 退出码 **0** ⇒ `Restarting (0)` 无限重启 |
| 同上 | `dsh` 的 healthcheck 探 **3080**（不是 8081） | dsh 永远 unhealthy（服务其实是好的）⇒ 人会开始忽略健康状态 |
| 同上 | `gateway` 必须显式 `FORLIFE_DB` 且**与 dsh 同一个库**，并挂 `dsh-home` 卷 | 回落到 `/app/.runtime/…` ⇒ `EACCES` 且**镜像重建就丢**；只挂 `forlife-data` 时两个进程**各写各的库**（都 Up、日志不报错，最难发现） |
| 同上 | 三层的根必须显式设（`FORLIFE_ROOT_HOT/_WARM/_COLD`） | `resolveTierRoots()` 连 HOT 都没有默认值 ⇒ 分层不生效，**HDD 冷层形同虚设** |
| 同上 | 变量用 `${VAR}`，**不要**改成 `${VAR:?消息}` | 本仓库所用的 compose 版本对 `:?` 一律报 `invalid interpolation format`（报错本身又变成一条看不懂的错误） |
| `deploy/Caddyfile` | **不放兜底 handle**；Admin API 只走 unix socket；**不暴露 DSH 自己的 Web UI** | 兜底会永久遮蔽动态路由；2019 无任何内置鉴权；DSH 的 `/api` 有 Host/Origin 信任栅栏、cookie 是 host-only + SameSite=Strict，**官方明确不支持非本机域名反代** |
| 编排里的 `FORLIFE_GATEWAY_PORT` / `FORLIFE_DATA_DIR` | 当前**不被代码读取**（gateway 端口由 `FORLIFE_ADMIN_PORT` 决定，镜像已设 8081） | 改它们没有任何效果 —— 别在这里排查端口问题 |

---

## 五、升级

```bash
cd /opt/forlife
# 1) 升级前先备份（★ 必做：迁移会改库结构）—— 走后台接口，见第六节
git pull
# 2) 重建并重启
cd deploy
docker compose build
docker compose up -d
docker compose ps
```

**预期耗时**：缓存热时**增量部署 3 分 14.6 秒**（含重建与重启）。

> **迁移是自动的**：DSH 启动时跑 `packages/store/src/migrations.ts` 里的迁移，并在迁移前做一个快照
> （`db.ts` 的 `backupDatabase`）—— 但**那个快照不做回读验证** ⇒ **不要把它当成唯一退路**。
> 迁移失败时 `db.ts` 会明确报出失败版本与"迁移前备份在哪里"。
> **迁移只前滚**，回滚靠备份（没有 down 迁移）。

---

## 六、备份与归档

### 6.1 库备份用 `VACUUM INTO`，不是拷文件

> ⚠️ **直接拷 `.sqlite` 是错的**：WAL 模式下最新数据可能在 `-wal` 里，
> 只拷主文件会**静默丢掉最近的写入**（备份看起来是好的，恢复后少一截）。

目标目录由 **`FORLIFE_BACKUP_DIR`** 指定 —— **接口不接受任意路径**（那会是提权）。
编排里已指向冷层 `/cold/backups`（宿主上是 `/mnt/forlife-cold/backups`，**另一块盘**）。

| 接口 | 做什么 | 落点 |
|---|---|---|
| `POST /api/admin/backup-now` | 立即做一份备份（`VACUUM INTO`），非破坏性 | **库旁边**（数据卷内）—— 快，但与源数据同盘，**不能当异地备份** |
| `POST /api/admin/backup` | 一次完整备份（库 + 可选 blob） | `FORLIFE_BACKUP_DIR` 下的时间戳目录 |
| `POST /api/admin/backup-verify` | **恢复前先验证备份可用**（完整性 + schema 版本 + 表数） | 传 `FORLIFE_BACKUP_DIR` 下的**相对路径** |

> ⚠️ `/api/admin/*` 的状态变更请求有两条硬要求，缺一条就是 400：**① 登录会话（cookie）；
> ② `Content-Type: application/json`**（否则报 `状态变更请求必须使用 application/json`）。
> **写 cron 时最容易漏第 2 条：**

```bash
# 手工调一次（--load-cookies 指向你的管理会话 cookie 文件）
wget -qO- --header='Content-Type: application/json' --post-data='{}' \
     --load-cookies /root/.forlife-cookie \
     https://$FORLIFE_HOST/api/admin/backup
```

```cron
# 每天 03:00 备份（★ 写**字面域名**：cron 的 shell 不会继承你 export 的变量）
0 3 * * * wget -qO- --header='Content-Type: application/json' --post-data='{}' --load-cookies /root/.forlife-cookie https://forlife.example.com/api/admin/backup >> /var/log/forlife-backup.log 2>&1
```

> **库备份失败 ⇒ 整个备份算失败**（blob 单独备份没有意义：没有索引指向它们）。
> 恢复流程：**先 `backup-verify`，再恢复** —— 而不是恢复到一半才发现备份不行。

### 6.2 归档：`FORLIFE_ARCHIVE_DIR`

编排里指向 `/cold/archives`。**归档是"很久以后才回来读"的东西，比备份更该放在另一块盘上。**
没配时 `/archive` 明确返回 400，**不会**悄悄写到一个默认位置。

### 6.3 建议的定时

- **每天一次**完整备份（上面那条 cron），保留周期按容量定。
- 备份目录**再往机外同步一次**（`rsync` 到另一台机器或对象存储）—— 同机备份挡不住"整机丢失"。
- **定期做恢复演练**：`backup-verify` → 恢复到临时目录 → 核对具体数据行，而不只是"表存在"。

---

## 七、端口与暴露

| 端口 | 谁 | 对外吗 |
|---|---|---|
| **80 / 443** | Caddy | ✅ **唯一对外入口** |
| 22 | sshd | ⚠️ 宿主的运维入口，按常规加固 |
| 8081 | gateway | ❌ 只在 `edge` 网络内（Caddy 反代过去） |
| 3080 | DSH Web UI | ❌ **绝不对外**（见下） |
| 3010 | OneBot（反向 WS） | ❌ 只在 `internal` |
| 6099 | NapCat WebUI | ❌ 主编排不发布任何端口；**只在扫码时**用覆盖文件临时发布（3.8b） |
| 2019 | Caddy Admin API | ❌ **只走 unix socket**（绝不 publish） |

### 为什么 DSH 的 Web UI 不在这里暴露

> DSH 自己的 `/api` 有 **Host/Origin 信任栅栏**，cookie 是 **host-only + SameSite=Strict**，
> **官方明确不支持非本机域名反代** ⇒ 留 loopback / 隧道。
> （这条写在 `deploy/Caddyfile` 的头部注释里，**别改**。）

---

## 八、⚠️ 一个已知的暴露（必须处理）

**现象**：**DSH 自己的日志里有一行把 web token 明文写在 URL 查询串里**：

```
dsh web: http://127.0.0.1:3080/?token=<43 字符>
```

**为什么不能靠"脱敏"解决**：gateway 已经在唯一的日志汇聚点做了**写入侧脱敏**
（`packages/gateway/src/redact.ts` + `server.ts` 的 `log`，有**接线守卫测试**防止被摘掉）；
**但这一行是 DSH 自己写的，不是本项目写的** ⇒ 写入侧拦不住它。
而在展示侧脱敏正是 `log-buffer.ts` 明确反对的做法
（"会给人'已经安全了'的错觉，而**真正的泄露早就发生了**"）。

**缓解做在部署层（三条都要做）**：

1. **排障外发只发 gateway 的日志**（那份已脱敏）；**绝不外发 `docker logs dsh` 的全文**，
   也不要把 `dsh-home` 卷打包 —— 那行 token 就在里面。
2. **容器日志按大小轮转**：`deploy/docker-daemon.json` 已设
   `log-opts: { max-size: 10m, max-file: 3 }`，保证 token 不会无限堆在盘上；
   **不要**把它调成无限（删掉这项或设 `max-size: 0`）。
3. **宿主模式下 DSH 若把日志落到文件**（`.runtime/web.log`），收紧权限并配 logrotate：

   ```bash
   chmod 600 /opt/forlife/.runtime/web.log
   ```

   ```
   /opt/forlife/.runtime/web.log {
       daily
       rotate 7
       compress
       missingok
       notifempty
   }
   ```

> 这条**没有从根上解决**（根上要么 DSH 改日志格式，要么 token 不走 query）。
> 部署方至少要按"**这行 token 会落盘**"来对待日志文件的去向与权限。

---

## 九、出问题先看哪里

| 症状 | 先看 |
|---|---|
| `docker compose up` 有 `variable is not set` 警告 | `FORLIFE_HOST` / `ACME_EMAIL` 没设 —— **先处理它，再看别的报错** |
| Caddy 起不来，报 `... after 'email'` | 同上：**去设变量，别改 Caddyfile** |
| `dockerd` 起不来，报 `directives don't match any configuration option` | `/etc/docker/daemon.json` 里有非法字段（如 `_comment`）⇒ 换回 `deploy/docker-daemon.json` 的原文 |
| 拉镜像卡住、十几分钟零字节 | 加速源第一位挂了（**卡住不转移**）⇒ 换第一位，并用 `docker pull caddy:2-alpine` 验证 |
| 拉非官方库报 403 | 该源不支持非官方库（napcat）⇒ 换 `docker.m.daocloud.io` 或前缀形式 |
| 构建报 `image "...": already exists` | 两个服务都写了 `build:` ⇒ `gateway` 只留 `image:` |
| 容器 `Restarting (0)` | `command:` 的 `>-` 块里混进了 `#` 注释 ⇒ 命令变成注释、退出码 0 |
| dsh 报 `profile "forlife-web" does not exist` | `$DSH_HOME/profiles/` 下没有它 ⇒ 查 `command` 里的软链与镜像里的 `profiles/` |
| dsh 日志里三条 entry `failed to import` | `/app/node_modules/@deepseek-ai` 那条链断了（容器却是 Up 的） |
| `EACCES … prepareProfile` / 命名卷 `Permission denied` | 目录属主不是 `node`(1000) |
| dsh 永远 unhealthy | healthcheck 探错端口（应为 3080）；或看 `docker logs dsh` |
| gateway 报 `EACCES … /app/.runtime/…` | 没设 `FORLIFE_DB` ⇒ 库落回镜像层 |
| 沉降/归档/备份"没动静" | 冷层**子目录**没建（1.4）；或 `FORLIFE_ROOT_HOT` 没配 ⇒ 功能**明确禁用**（不是坏了） |
| 沉降日志说"冷层退回了" | 没配 `FORLIFE_ROOT_COLD` ⇒ 归档与热数据同盘，**这是如实上报，不是故障** |
| 容器起来了但 `docker port` 是空的 | 网络是 `internal: true` —— **那种网络没有任何对外路由，发布端口对它完全无效**（记在 `deploy/docker-compose.dev.yml` 头部） |
| QQ 不回消息 | ①gateway 日志有没有 `QQ 链路未启用`（没设 `FORLIFE_ONEBOT=1`）；②`FORLIFE_DRIVER` 是不是 `fake`；③NapCat 登录态（WebUI）；**别 `docker stop` 它** |
| 后台打不开 | Caddy 路由；gateway 是否在 `edge` 网络上 |
| `/admin/` 之外的路径"返回 200" | **已知行为**：空 body 的 200，不是被反代成功（见 3.9） |
| `apt` 源时通时不通 | 该源解析出 **IPv6-only**，而机器没有 IPv6 默认路由（1.2） |

---

## 附录 A：耗时参考（4 核 / 8 GiB 虚拟机实测）

| 口径 | 实测 |
|---|---|
| 装 Docker | **2 分 05 秒** |
| **冷构建（`--no-cache`，已配镜像加速源）** | **2 分 11 秒** |
| 增量部署（缓存热，含重建 + 重启） | **3 分 14.6 秒** |
| 造冷层（loop + ext4，稀疏） | **0.154 秒** |
| **从零合计** | **≈ 5–6 分钟** |

- 冷构建这条**以"镜像加速源已配好"为前提**：不配源时会退化到 **33 分 8 秒**（见第四节相关行）。
- 首次启动后各服务要几十秒才转 healthy（在 `start_period` 内属正常）。

---

## 附录 B：验证边界（首次上线重点观察）

以下是**尚未取得端到端验证**的环节。不是"不能用"，而是**第一次执行时按第一次执行对待**：

| 环节 | 首次上线怎么确认 |
|---|---|
| 公网 ACME 证书 | 用真域名部署后看 Caddy 日志是否签出 Let's Encrypt 证书；内网环境走 Caddy 内部 CA 属预期 |
| 评分器 profile（`llama-server`） | `docker compose --profile scorer up -d` 后确认容器 Up 且 `/models/scorer.gguf` 被加载 |
| QQ 端到端（扫码 → 收发） | 按 3.8 扫码后看 gateway 日志的连接状态与一次真实收发 |
| 整机重启 | 首次重启后确认冷层已挂载、四个容器自启、数据仍在 |
| 记忆系统功能正确性 | 写入一条记忆并召回，核对结果 |
| cron 定时备份的长期取法 | 首次 cron 跑完后检查备份目录与日志 |
| 虚拟机规格 | 上线后看内存与冷层容量的实际用量 |

**已取得端到端验证的**（可以依赖）：

- ✅ 四个容器全部起来且健康；对外只有 80/443/22；Caddy 反代 200（含 `Via: 1.1 Caddy`）。
- ✅ 冷层与数据层是两个独立文件系统；容器 uid 1000 能往冷层写。
- ✅ 重启 `gateway` / `dsh` 后数据还在，迁移不重跑、不重新播种。
- ✅ 本项目的组件完整加载：契约基线、**34 个生产工具**、压缩引擎/沉降循环/唤醒轮询器/面板接口。
- ✅ 备份对真实库跑通并通过独立的 `verifyBackup`；备份→销毁→恢复演练通过。
- ✅ `docker compose config --quiet` 退出码 0（含 `--profile scorer` 五服务）；`caddy adapt` 退出码 0。
- ✅ gateway 的日志脱敏已接线（有接线守卫测试）。
