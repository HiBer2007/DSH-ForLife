# Caddy 动态路由 + DSH 沙箱工作区端口发布 —— 调研报告
**A**：DSH 原生能力限制在"工作区"内；模型在里面起服务后把端口暴露到 Caddy（`https://<name>.vm.example.com/` 或 `https://vm.example.com/svc/<name>/`），非 HTTP 服务走 TCP 穿透。**B**：gateway 运行时动态增删 Caddy 路由。
依据：Caddy / caddy-l4 官方文档（在线核实）+ 本机只读 DSH 包源码（`path:line`；`R = …\node_modules\@deepseek-ai`，v`0.1.7-rc.2`）。未核实处标 **UNCERTAIN**。
## 0. TL;DR
1. **真源必须放 gateway 里**。`caddy reload`/`caddy adapt` 本质都是 `POST /load`（整份替换），会静默抹掉 API 追加的路由 → **"Caddyfile 基线 + API 追加"早晚会炸**。
2. **最小路径**：`POST /config/apps/http/servers/<srv>/routes` 追加带 `@id` 路由 → `DELETE /id/<id>` 撤销。⚠️ POST 到数组时 body 要传**单个对象**（传数组会把整个数组当一个元素追加，除非路径以 `/...` 结尾）。
3. **2019 绝不 publish 到宿主机**（内部 network 或 `admin unix//run/caddy/admin.sock`）。**Admin API 无内置鉴权**；`origins`/`enforce_origin` 只防浏览器/DNS-rebinding，不防本机进程。
4. **TCP/UDP 穿透需要 caddy-l4，官方镜像不含它**，必须自建（8 行 Dockerfile）。不自建就退到 PVE nftables DNAT（代价：无鉴权/无审计/无 SNI 分流/后端看不到真实 IP）。
5. **DSH 沙箱只管"文件写"，完全不管网络与端口**：三档模式全是文件语义，**没有任何"允许端口"的配置面**；bwrap profile 也没做网络命名空间隔离（只 `--unshare-pid`）→ **"模型在工作区里起 dev server"在 DSH 侧零改动即可行**，护栏全在 gateway + Caddy + 容器网络侧。DSH 侧唯一要改的是把会话 cwd / `workspaceRoot` 指到工作区目录。
6. ⚠️ **别把 DSH 自己的 Web GUI 经 Caddy 反代到公网域名**（§3.5）。
## 1. Caddy 动态配置
来源：[API](https://caddyserver.com/docs/api)、[Caddyfile 全局选项](https://caddyserver.com/docs/caddyfile/options)、[Conventions](https://caddyserver.com/docs/conventions)。
### 1.1 Admin API 语义速查（默认 `localhost:2019`；`CADDY_ADMIN` 或 `admin` 全局选项可改，配置文件值优先）
| 方法 + 路径 | 官方语义 |
|---|---|
| `POST /load` | **整份替换**；阻塞至完成或失败；失败**自动回滚、无停机**。Content-Type 即适配器名：`application/json`、`text/caddyfile`（用 `--data-binary`）。新旧相同则不 reload，`Cache-Control: must-revalidate` 可强制。 |
| `GET /config/[path]` | 导出该路径配置。`/id/<id>[/...]` 是 `@id` 直通，等价对应 `/config/...` 路径，**方法语义完全相同**。 |
| `POST /config/[path]` | 目标是**数组→追加**；是对象→创建或替换。特例：路径以 `/...` 结尾且 body 是数组时**元素逐个追加**。 |
| `PUT /config/[path]` | 数组下标→**插入**；对象→**严格新建**（已存在 409）。 |
| `PATCH /config/[path]` | **严格替换**已存在的值/数组元素。`DELETE` 删除；键不存在 **404**。 |

并发：`GET` 返回 `Etag`（如 `"/config/apps/http/servers 65760b8e"`）；写请求带 `If-Match: <etag>`，冲突 **412**，按"重读→改→重试"循环。
### 1.2 最小可跑：新增带 `@id` 的 reverse_proxy 路由
```bash
# 第 0 步：确认 server 名（Caddyfile 适配的通常叫 srv0，别假设）
curl -s http://caddy:2019/config/apps/http/servers | jq -r 'keys[]'
# 1-A 子域 https://foo.vm.example.com/
curl -X POST "http://caddy:2019/config/apps/http/servers/srv0/routes" -H "Content-Type: application/json" -d '{ "@id": "svc-foo", "match": [{ "host": ["foo.vm.example.com"] }],
        "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "svc-foo:3000" }] }] }'
# 1-B 子路径 https://vm.example.com/svc/foo/
#     rewrite+strip_path_prefix 就是 handle_path 的 JSON 展开
#     （官方：handle_path /p/* ≡ handle + uri strip_prefix /p）
curl -X POST "http://caddy:2019/config/apps/http/servers/srv0/routes" -H "Content-Type: application/json" -d '{ "@id": "svc-foo-path", "match": [{ "host": ["vm.example.com"], "path": ["/svc/foo/*"] }],
        "handle": [ { "handler": "rewrite", "strip_path_prefix": "/svc/foo" },
                    { "handler": "reverse_proxy", "upstreams": [{ "dial": "svc-foo:3000" }] } ] }'
# 抢优先级：插到最前面（已有路由下标后移，但 @id 引用不受影响）
curl -X PUT "http://caddy:2019/config/apps/http/servers/srv0/routes/0" -H "Content-Type: application/json" -d '{ "@id": "svc-foo", "match": [...], "handle": [...] }'
```
期望 **200** + 空 body。四个坑：

- ⚠️ **顺序**：Caddy 路由**首个匹配胜出**，POST 是**追加到末尾**。基线里若有 `vm.example.com` 的兜底 `handle`，新路由会被永久遮蔽 → 用上面的 `PUT .../routes/0` 插入。
- ⚠️ **子目录问题**：应用若输出绝对路径（`/assets/x.js`），反代到 `/svc/foo/` 会 404（官方 [subfolder problem](https://caddy.community/t/the-subfolder-problem-or-why-cant-i-reverse-proxy-my-app-into-a-subfolder/8575)）。**默认给子域**，子路径作降级并注入 `X-Forwarded-Prefix`。
- 子域证书 Caddy 自动申请（需该名字解析到本机）；泛域名不想逐站建块可用 `{ tls_automate_names *.vm.example.com }`（≥2.11.6，官方点名支持 layer4 场景）。
- `handle/<i>` 下标取决于模板：1-B 里 `handle[0]` 是 `rewrite`、`handle[1]` 才是 `reverse_proxy`。**先 `GET /id/<id>` 确认下标**，或在 gateway 里固定模板。
### 1.3 按 `@id` 删除 / 替换 / 改端口 / 对账
```bash
curl -X DELETE "http://caddy:2019/id/svc-foo"                    # 删除整条，期望 200
# 只改 upstream 端口（改标量最精准）；或换整组 upstream；或整条替换
curl -X PATCH "http://caddy:2019/id/svc-foo/handle/0/upstreams/0/dial" -H "Content-Type: application/json" -d '"svc-foo:3001"'
curl -X PATCH "http://caddy:2019/id/svc-foo/handle/0/upstreams" -H "Content-Type: application/json" -d '[{"dial":"svc-foo:3001"}]'
curl -X PATCH "http://caddy:2019/id/svc-foo" -H "Content-Type: application/json" -d '{ ...新路由... }'
# 列出所有已注册 @id（对账/漂移检测）
curl -s http://caddy:2019/config/ | jq -r '[.. | objects | select(has("@id")) | ."@id"] | sort | .[]'
```
### 1.4 Docker 里怎么安全暴露 2019
- **默认**：Compose 里 Caddy 服务**不写** `2019` 的 `ports:`，gateway 同内部 network 访问 `http://caddy:2019`。
- **最稳：unix socket + 文件权限**（官方对"跑不受信代码"的原文建议）：

```caddyfile
{ admin unix//run/caddy/admin.sock }   # 默认模式 0200；也可 unix//run/caddy/admin.sock|0660
```
```bash
curl --unix-socket /run/caddy/admin.sock http://localhost/config/
```
- **必须用 TCP 时**：`admin 127.0.0.1:2019`，**不要 `admin :2019`**——官方明确：绑到 wildcard interface 时**不校验 Host**。
- `origins`/`enforce_origin` 只在"暴露给浏览器"时有意义，**不是鉴权**。
- **不要 `admin off`**——`caddy reload` 也走 Admin API，关掉就再也改不了配置。
### 1.5 动态配置 vs 文件基线：推荐做法
**事实**：① `caddy reload`/`caddy adapt` 走的就是 `POST /load`（整份替换），手改 Caddyfile 再 reload 会静默清掉 API 追加的路由。② 默认 **autosave 开启**：每次 API 变更后最新配置写入 Caddy **配置目录**（Linux `$HOME/.config/caddy`；容器里通常 `/config/caddy`），供 `caddy run --resume` 重启恢复；`persist_config off` 可关（只支持 `off`）。注意 autosave 存的是**运行时 JSON，不是你写的 Caddyfile**——这是"重启后配置看起来变了"的常见困惑源。
**推荐：单一真源在 gateway，Caddy 只当执行器。**

1. Caddy 用**最小引导配置**启动（只留 `admin` + 一个空 server，甚至 `{}`）；不让手改的 Caddyfile 参与运行时。
2. gateway 维护「基线路由 + 动态路由」，**每次变更合成完整 JSON 并 `POST /load`**：原子、失败自动回滚、无停机、幂等，彻底消除顺序/漂移问题；配置小，全量推送成本可忽略。
3. 嫌全量重可用 `POST/PATCH/DELETE /config/...` 增量，**但真源仍是 gateway**，并定时 `GET /config/` 对账（配 `If-Match`/412 重试）。
4. `persist_config off`，避免上次运行残留的 autosave 在重启后冒充真源；重启一律由 gateway 重推。
5. 迁移期必须留 Caddyfile：在**部署时**转成 JSON 存成基线常量，运行时**再也不 reload**：

```bash
curl -s http://caddy:2019/adapt -H "Content-Type: text/caddyfile" --data-binary @Caddyfile | jq .
```
### 1.6 Admin API 侧安全要点
- **无内置鉴权**：官方文档从未提供 token/basic-auth 机制。唯一控制手段 = 绑 unix socket + 文件权限，或绑内部地址 + 网络隔离。
- **Caddy 本身不限制你能反代到哪个网段**（没有"只能映射固定端口段/固定网络"的配置面）——**这类约束必须由 gateway 在调 Admin API 之前自己校验**（§4.5 #1 #2）。
## 2. TCP/UDP 穿透：Caddy `layer4` app
来源：[caddy-l4 README](https://pkg.go.dev/github.com/mholt/caddy-l4)、[模块页](https://caddyserver.com/docs/modules/layer4)、[servers](https://github.com/mholt/caddy-l4/blob/master/docs/servers.md)、[handlers/proxy](https://github.com/mholt/caddy-l4/blob/master/docs/handlers/proxy.md)、[matchers](https://github.com/mholt/caddy-l4/blob/master/docs/matchers.md)、[routes](https://github.com/mholt/caddy-l4/blob/master/docs/routes.md)、[网络地址约定](https://caddyserver.com/docs/conventions#network-addresses)。已发布 tag `v0.1.0`/`v0.1.1`/`v0.1.2`。
### 2.1 标准镜像**不含** layer4 → 必须自建
官方模块页原文：**"This module does not come with Caddy."**；仓库自述"not an official repository of the Caddy Web Server organization"、"still in development, expect breaking changes"。`caddy:2`/`2-alpine`/`latest` 的 Dockerfile 直接下载**官方 release 二进制**，只含标准模块；`caddy:2-builder` 是构建器（golang + xcaddy），不含 Caddy 本体。自检：`docker run --rm caddy:2 caddy list-modules | grep -i layer4` 应**无输出**。

```dockerfile
# syntax=docker/dockerfile:1
FROM caddy:2-builder AS builder
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build xcaddy build --with github.com/mholt/caddy-l4@v0.1.2
FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
RUN caddy list-modules | grep -q '^layer4$'      # 构建期验证
```
> 锁 tag（别用 master）。builder 预设 `XCADDY_SETCAP=1`，新二进制带 `cap_net_bind_service`，覆盖后仍能绑 80/443。
> **UNCERTAIN**：GitHub Releases 是否附预编译二进制未核实（本环境 GitHub 不可达）。社区个人镜像存在（如 `ghcr.io/roamer7038/caddy-l4-docker`），但其 README 有"l4 不支持 Caddyfile"这类**与官方文档直接矛盾的错误**，不建议依赖。
### 2.2 最简配置：`vm.example.com:25565`(TCP) → `10.0.0.5:25565`
JSON（`routes` 在 **server** 里；app 只有 `servers` 一个字段）：

```json
{ "apps": { "layer4": { "servers": { "mc": {
  "listen": ["tcp/:25565"],
  "routes": [ { "@id": "l4-mc",
    "handle": [ { "handler": "proxy", "upstreams": [ { "dial": ["10.0.0.5:25565"] } ] } ] } ]
} } } } }
```
- handler 名是 **`proxy`**（不是 `tcp_proxy`）；**没有 `tcp`/`udp` matcher**——协议由 `listen` 决定（`:25565` ≡ `tcp/:25565`；UDP 用 `udp/:25565`）。
- `upstreams[].dial` **是字符串数组**（与 http `reverse_proxy` 的单个字符串不同）。
- **route 没有 matcher 就会吞掉所有流量**，后面的 route 不再生效。
- ⚠️ **layer4 不能与 http app 绑同一监听地址**（25565 与 443/80 无冲突；要共享 443 必须用 `listener_wrappers` 形式）。

Caddyfile（注意 `layer4` 是**全局选项块**里的指令，不是站点块）：

```caddyfile
{
	admin unix//run/caddy/admin.sock
	layer4 {
		:25565 {
			route {
				proxy 10.0.0.5:25565
			}
		}
	}
}
```
按 TLS SNI 分流（可选）：`{ "match": [ { "tls": { "sni": ["mc.example.com"] } } ], "handle": [ ...同上 proxy... ] }`
### 2.3 用 Admin API 动态挂上 / 摘掉
```bash
# ⚠️ 源码级结论：只有 PUT 会自动创建缺失的中间路径
#    → POST /config/apps/layer4 要求 apps 键已存在；layer4 不存在时用 PUT
curl -X PUT "http://caddy:2019/config/apps/layer4" -H "Content-Type: application/json" -d '{"servers":{"mc":{"listen":["tcp/:25565"],"routes":[{"@id":"l4-mc","handle":[{"handler":"proxy","upstreams":[{"dial":["10.0.0.5:25565"]}]}]}]}}}'
# 推荐：按 server 粒度增删（不动其他 server）
curl -X POST "http://caddy:2019/config/apps/layer4/servers/mc2" -H "Content-Type: application/json" -d '{"listen":["tcp/:25566"],"routes":[{"@id":"l4-mc2","handle":[{"handler":"proxy","upstreams":[{"dial":["10.0.0.5:25566"]}]}]}]}'
curl -X DELETE "http://caddy:2019/config/apps/layer4/servers/mc2"   # 撤销，只关这个端口
```
- `servers` **不需要**预建：`POST /config/apps/layer4` 的 body 就是整个 app 对象。
- 每次 `/config` 写入都是**一次完整配置重载**（`changeConfig` → 启停 app），不是"加一条规则"。正常不掉存量连接，但**别当高频写接口**。
- `POST` 到 `/config/apps/layer4` 是**整体替换**语义，会把之前攒的 server 全冲掉——生产用 server 粒度。
### 2.4 能力边界
- **22 个 matcher**：`tls`(sni/alpn)、`http`、`ssh`、`postgres`、`dns`、`quic`、`rdp`、`socks4/5`、`wireguard`、`xmpp`、`openvpn`、`winbox`、`regexp`、`local_ip`/`remote_ip`、`clock`、`not`、`vars` 等；只预读首个报文 ≤16 KiB，匹配超时默认 3s。
- **11 个 handler**：`proxy`、`tls`、`subroute`、`tee`、`proxy_protocol`、`postgres_tls`、`throttle`、`socks5`、`echo`、`close`、`vars`。
- `proxy` 支持主动/被动健康检查、7 种 LB 策略、`proxy_protocol: "v1"|"v2"` **输出**（后端拿真实客户端 IP 的关键）、`try_duration`/`try_interval`、upstream 级 `max_connections`/`weight`/`tls*`。
- 可观测：Prometheus `caddy_layer4_proxy_connections_total`、`_active_connections`、`_upstream_healthy`（走 admin `/metrics`）。
## 3. DSH 沙箱能力（本机只读调研）
### 3.1 三档模式与语义边界
模式词汇是**封闭三联**（`R\dsh-sandbox-policy\lib\index.js:26-30`，schema `:98`）：

| 模式 | 文件写 | 网络 | 监听端口 | 进程可见性 |
|---|---|---|---|---|
| `read-only`（**默认**） | 全部拒绝；仅 `/dev/null` 可写 | 不受限 | **可** | 因后端而异 |
| `workspace-write` | 工作区根 + 平台临时区 | 不受限 | **可** | 同上 |
| `danger-full-access` | 不限制；**完全绕过** `ctx.sandbox` | 不受限 | 可 | 宿主可见 |

**证据链**：①「模式只约束文件影响——**网络仍不受限制**」`R\dsh-bash-sandbox\README.zh.md:32`，「……**不是通用安全沙箱**」同文件 `:171`。②「**文件操作是完整的策略词汇**——该 seam 不表达网络、进程、系统调用、设备或凭据限制」`R\dsh-sandbox\README.zh.md:167`。③「网络和进程策略不在其词汇中，因此这里**没有限制它们的旋钮**」`R\dsh-sandbox-policy\README.zh.md:148`。④「写入与删除受限；**读取、网络与进程可见性不受限**……受限子进程可以打开套接字」`R\dsh-sandbox-windows-acl\README.zh.md:117`。⑤ **bwrap profile 只 `--unshare-pid`，没有 `--unshare-net`** → 与宿主共享网络命名空间：

```js
// R\dsh-sandbox-local\lib\index.js:22-39
const args = ["--ro-bind","/","/", "--dev","/dev", "--unshare-pid", "--proc","/proc", "--die-with-parent"];
if (policy.mode === "workspace-write") {
  args.push("--tmpfs","/tmp");
  args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
}
```
- `workspace-write` 的可写根**唯一定义**：工作区根 + `/tmp` + `os.tmpdir()`（`R\dsh-sandbox\lib\index.js:166-173`）；Seatbelt profile 与进程内 fs 栅栏共用同一函数，故「write 工具不能写 /tmp 但 bash 能」这类不对称不会出现（同文件 `:126-136`）。
- **读操作永不受限**——`fs-sandbox` 只拦写/编辑（`R\dsh-fs-sandbox\README.zh.md:46`）。
- 强制完整度是**报告的事实**：Windows ACL 档与较旧 Landlock ABI 报 `partial`（`R\dsh-sandbox-local\README.zh.md:53`、`:130-132`）。
### 3.2 沙箱根目录怎么配置
**两处，优先级从高到低**：① **会话不可变 cwd**（`SessionHeader.cwd`，官方注释 "Absolute working directory the session was created in" — `R\dsh-session\lib\types\types.d.ts:68-69`）。解析序：`已批准显式模式 > 会话最后一条 sandbox/mode 事件 > 部署默认`；`workspaceRoot = session?.header.cwd ?? 部署回退值`（`R\dsh-sandbox-policy\lib\index.js:142-146`）。② **部署回退** `workspaceRoot`（无会话 cwd 的调用）：`mode`（默认 `read-only`）+ `workspaceRoot`（默认 `process.cwd()`，相对值加载时报错）— `R\dsh-sandbox-policy\README.zh.md:45-48`。
你们实际的部署（本机核实）：

```yaml
# R\dsh-base\cordis.patch.yml:225-232
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
# R\dsh-base\cordis.patch.yml:517-518（fs 侧注释：cwd defaults to process.cwd(); an overlay can pin another workspace）
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
```
- 你的实际 profile 是 **`dsh-tui`**（env `DSH_PROFILE=dsh-tui`）；其 `cordis.patch.yml` **没有**覆盖 sandbox 行 → 当前生效的是 base 的 `workspace-write` + `process.cwd()`。本会话报告 `danger-full-access`，说明是**会话级 `sandbox/mode` 覆盖**（运行时切换只追加一条日志事件，靠回放跨重启保留 — `R\dsh-sandbox-policy\README.zh.md:75-76`）。
- **结论**：设 `DSH_PERMISSION_MODE=workspace-write`，把 DSH 进程 cwd（或每会话 cwd）指到工作区目录（如 `/workspace/<session>`）即可。要覆盖部署值就在 profile 的 `cordis.patch.yml` patch `- id: sandbox-policy`——⚠️ **`id` 定向 patch 会替换整行 config，所有键必须重述**（`C:\Users\HiBer2007\.dsh\profiles\web\cordis.patch.yml:18`）。
- ⚠️ **`dsh-workspace` 不是沙箱根目录！** 它是 GUI 的持久"项目列表"注册表（`ctx.workspaceRegistry`），「对模型不可见，不增加提示词或请求上下文成本」（`R\dsh-workspace\README.zh.md:12`）。
### 3.3 监听端口 / 网络：结论
- **沙箱默认既不禁止联网也不禁止监听端口，且没有任何"允许端口"的配置面。**（全树检索 `allowedPorts|allowPorts|portRange|allowedHosts|netPolicy|networkPolicy|egress` 在沙箱/策略包中**零命中**。）
- → **`workspace-write` 下模型在工作区里 `npm run dev -- --port 5173` 直接能起来**。你们要做的是"**发现 / 登记 / 暴露 / 回收**"，不是"放开权限"。
- 唯一与端口有关的 DSH 原生配置是它**自己的** Web 服务器：`dsh-host-webserver` 的 `host` 只接受 `127.0.0.1`（默认）与 `0.0.0.0`，`port: 0` 让 OS 分配（`R\dsh-host-webserver\README.zh.md:39`）；web-app 里默认 `127.0.0.1:3080`（`R\dsh-web-app\cordis.patch.yml:163-168`）。与沙箱策略无关。
### 3.4 `dsh-invariants` 是什么、能不能自用
**机制**：与产品无关的**运行时断言注册表** `ctx.invariants`。包可发布 `./invariant` **配套入口**，注册检查验证**自己拥有的持久关系**（权威事件流 vs 可变快照）；违规抛 `InvariantError`（稳定码 `INVARIANT` + 所属包完整 npm 名）— `R\dsh-invariants\README.zh.md:12`、`:90`。

- API 极小：`ctx.invariants.register(packageName, installer)`；`installer(ctx, fail)` 可声明 `installer.inject`；返回作用域化 disposer — `R\dsh-invariants\lib\types\index.d.ts:27-37`、`:80`。配置：`enabled`（默认 `true`）、`package_allowlist`、`package_blocklist`（大小写敏感 JS 正则源，blocklist 优先，空 allowlist = 全接纳）— `R\dsh-invariants\README.zh.md:36-50`。
- **只在某些 profile 挂载**：注册表只在 **`dsh-sdk-minimal`** 里挂载（`R\dsh-sdk-minimal\cordis.patch.yml:106-119`）；**`dsh-base` 刻意省略运行时诊断**（`R\dsh-invariants\README.zh.md:32`）→ 你的 `dsh-tui` profile 用 `dsh-base`，**当前没有挂载**。

最贴近的模板（校验 `sandbox/mode` 值在封闭词汇内）：

```js
// R\dsh-sandbox-policy\lib\invariant.js:30-53（节选）
const PACKAGE_NAME = "@deepseek-ai/dsh-sandbox-policy";
const install = Object.assign((ctx, fail) => {
  for (const s of ctx.sessions.list()) for (const e of s.snapshotEvents()) validateEvent(e, fail);
  ctx.on("internal/dispatch", (_m, ev, args) => {
    if (ev === "session/event") validateEvent(args[1], fail);
  }, { global: true });
}, { inject: ["sessions"] });
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
```
**能自用，但有 4 个前提**：① 先在 profile 挂上注册表（`- id: invariants` / `name: '@deepseek-ai/dsh-invariants'`，用 `package_allowlist` 只放自己的包）。② 你的插件得是真 npm 包，并在 `package.json` 的 `exports` 暴露 `"./invariant"` 子路径（模板 `R\dsh-sandbox-policy\package.json:16-27`）——配套入口是独立入口，普通入口不 import 诊断代码。③ ⚠️ **该机制只做"断言/告警"，不做"阻断"**，适合校验你自己的策略状态一致性（如"每条已发布端口映射都必须有对应审计记录"）。**真正的准入控制要放 `tools/execute` / `tools/pre-execute` waterfall**（`R\dsh-fs-observation-policy\README.zh.md:78` 明确："分层权限、审计或沙箱拦截属于 `tools/execute` waterfall"）。④ 失败即抛异常，只放"绝不允许发生"的断言。
### 3.5 ⚠️ 非显然坑：别把 DSH 自己的 Web GUI 经 Caddy 反代到公网
`dsh-web-app` 的 `/api` 有一道**浏览器信任栅栏**：`Host` 必须 loopback 或匹配 `trustedHosts`；带 `Origin` 时必须等于该 `Host`；`sec-fetch-site: cross-site` 一律拒绝；**`dsh web --host 0.0.0.0` 仍不受支持**（`R\dsh-client-connection\README.zh.md:43`）。会话 cookie 是 **host-only + `SameSite=Strict` + 不带 `Secure`**，密钥在 `$DSH_HOME/.credentials.yaml`（同文件 `:41`）；账号登录明确"**不支持非本机域名的反向代理**"（`R\dsh-deepseek-account-platform\README.zh.md:91`）。**正解**：DSH GUI 留在 loopback（SSH 隧道 / 仅本机），**只把"模型起的服务"经 Caddy 暴露**，两件事彻底分开。
## 4. 给实现者的最小可行方案（A + B）
### 4.1 架构
```
PVE 宿主机
└─ VM vm.example.com
   └─ docker compose（内部 network dsh-net，2019 不 publish）
      ├─ caddy     ← xcaddy 自建（含 layer4）；admin 走 unix socket 或 127.0.0.1:2019
      ├─ dsh        ← cwd=/workspace/<session>；DSH_PERMISSION_MODE=workspace-write
      │               模型在里面起 dev server(:3000) 或原生 TCP 服务(:25565)
      ├─ gateway    ← 唯一真源：校验 + 审计 + 调 Caddy Admin API
      └─ qq-client
```
**模型监听的是容器内端口，绝不 `ports:` 发布到宿主机**；外部可达性**只**由 Caddy 提供，且必经 gateway 校验。
### 4.2 时序（一次"发布端口"）
① 模型起服务 → 告知 gateway（或 gateway 在容器内 `ss -ltnp` 嗅探新监听端口）。② gateway 校验：端口是否在**白名单段**、是否已映射、调用方权限、目标是否在**允许网段**。③ **需要人显式批准**（HTTP 与 TCP 一视同仁）。④ 合成完整配置 → `POST /load`（或增量 `POST /config/...`）。⑤ 写审计 `{id, kind: http|tcp, listen, target, requestedBy, approvedBy, createdAt, expiresAt}`。⑥ 返回地址 `https://<name>.vm.example.com/`（默认）或 `https://vm.example.com/svc/<name>/`。⑦ 到 `expiresAt` / 一键撤销 / 会话结束 → `DELETE /id/<id>` 或 `DELETE /config/apps/layer4/servers/<name>` → 重推全量。
### 4.3 gateway 侧关键片段
```bash
# 发布 HTTP（子域，默认形态）
curl -X POST "http://caddy:2019/config/apps/http/servers/srv0/routes" -H "Content-Type: application/json" -d "$(jq -nc --arg id "svc-$NAME" --arg host "$NAME.vm.example.com" --arg up "$TARGET" \
        '{ "@id": $id, match: [{ host: [$host] }],
           handle: [{ handler: "reverse_proxy", upstreams: [{ dial: $up }] }] }')"
curl -X DELETE "http://caddy:2019/id/svc-$NAME"          # 撤销
# 发布 TCP（layer4，按 server 粒度）
curl -X POST "http://caddy:2019/config/apps/layer4/servers/$NAME" -H "Content-Type: application/json" -d "$(jq -nc --argjson port "$PORT" --arg up "$TARGET" \
        '{ listen: ["tcp/:" + ($port|tostring)],
           routes: [{ "@id": ("l4-" + $NAME),
                      handle: [{ handler: "proxy", upstreams: [{ dial: [$up] }] }] }] }')"
curl -X DELETE "http://caddy:2019/config/apps/layer4/servers/$NAME"   # 撤销
```
> 首次部署时 `apps.layer4` 可能不存在 → 用 `PUT /config/apps/layer4`（PUT 会自动创建中间路径），或先 `POST /config/apps -d '{}'`。之后一律用 server 粒度 POST。
### 4.4 一键撤销
- **幂等**：`DELETE` 对不存在的 id 视为成功（先 `GET /id/<id>` 探测，或忽略 404）。
- **撤销即回收**：同时 kill 掉模型起的那个进程（gateway 记录 PID/cgroup），避免"路由删了端口还在听"。
- **批量撤销**：按 `requestedBy` 前缀扫 `@id` 集合批量 DELETE。
### 4.5 安全护栏清单
| # | 护栏 | 落点 | 说明 |
|---|---|---|---|
| 1 | **端口段白名单** | gateway（调 API 前） | Caddy 不管这个（§1.6）。例：HTTP 只允许 `3000-3999`、TCP 只允许 `25565-25599`。硬拒绝，不做"警告后放行"。 |
| 2 | **目标网段白名单** | gateway | upstream 必须匹配 `dsh-net` 网段。**防 SSRF——最高危的一条**：没有它，模型能让你把 `169.254.169.254`（云元数据）、`127.0.0.1:2019`（Caddy 自己！）、PVE API 反代到公网。 |
| 3 | **必须显式批准** | gateway + 人 | 默认 deny；HTTP/TCP 都要批准（**TCP 无 TLS、无鉴权，风险更高**）。可对已知安全模板预授权以降摩擦。 |
| 4 | **自动过期** | gateway | 每条映射带 `expiresAt`（如 4h/24h）+ 定时回收；会话结束即回收。**防"临时暴露"变永久后门。** |
| 5 | **审计日志** | gateway | 谁/何时/申请什么/谁批准/何时撤销/访问量（可与 Caddy access log 对账）。追加写、不可改。 |
| 6 | **绝不 publish 容器端口** | compose | 只靠 Caddy 暴露；`dsh` 服务的 `ports:` 里不出现模型端口。 |
| 7 | **Admin API 隔离** | compose | 不 publish 2019；优先 unix socket + 文件权限；退而求其次 `127.0.0.1:2019`。**别无脑 `admin :2019`**（无 Host 校验）。 |
| 8 | **`@id` 命名空间** | gateway | 动态路由统一加前缀（`svc-`/`l4-`），撤销与对账只动自己前缀的条目，绝不误删基线。 |
| 9 | **速率/数量上限** | gateway | 每会话最多 N 条并发映射，防配置膨胀与端口扫描。 |
| 10 | **TLS 标注** | Caddy + UI | 子域走自动 HTTPS；**TCP 穿透是明文**，UI 必须明确标注。 |
### 4.6 落地检查清单
- [ ] `DSH_PERMISSION_MODE=workspace-write`，DSH cwd / 会话 cwd = 工作区目录（§3.2）
- [ ] **不做**"文件基线 + API 追加"；真源在 gateway（全量 `POST /load` 或增量 + 对账）（§1.5）
- [ ] `persist_config off`，重启后由 gateway 重推
- [ ] Caddy 自建镜像含 layer4，构建期 `caddy list-modules | grep -q '^layer4$'` 通过
- [ ] Caddy 2019 未 publish；gateway 走内部 network 或 unix socket
- [ ] §4.5 的 #1 #2 #3 #4 #5 已实现并有单测
- [ ] DSH GUI **不**经 Caddy 暴露（§3.5）
## 5. 方案对比（总表）
| 方案 | 动态性 | 权衡 |
|---|---|---|
| **Caddy Admin API**（主推） | ✅ 运行时增删 | 与现有栈一致、自动 HTTPS、无需额外组件。代价：**真源必须自建**（§1.5）、**无内置鉴权**（§1.6）、需自建含 layer4 的镜像。 |
| `lucaslorentz/caddy-docker-proxy` | ✅ label 驱动 | 真源是 **docker label**，只覆盖"容器"形态；你们要暴露的是"工作区里的进程 + 任意端口"，**不匹配**。且要挂 `docker.sock`（≈交出宿主 root），攻击面大。 |
| Caddyfile + `caddy reload` | ❌ 文件驱动 | 最简单、可 review、幂等；但**不是动态**，且整份替换会与 API 追加互踩。只适合基线路由。 |
| `xcaddy` 自定义构建 | — | **加 layer4 时绕不开**（§2.1）。代价：自持构建/升级链路、需跟随上游安全更新。 |
| 独立反代小服务（自研 / nginx + 生成配置 + reload） | ✅ 自持 | 鉴权、白名单、审计全在你手里；代价是丢掉 Caddy 的自动 HTTPS/HTTP3/成熟反代，等于自建一个反代。 |
| **caddy-l4**（TCP 穿透主推） | ✅ | 同栈统一：一份配置同时管 HTTP 与 L4，同一 Admin API 动态化，共用 TLS 证书与 matcher 心智。代价：**必须自建镜像**；自述实验性（锁 tag + 留回滚镜像）；l4 是**裸转发，无鉴权/限流/审计**。 |
| nginx `stream {}` | ❌ | 成熟、性能好、SNI 分流可用（1.25.5+）；但**动态性最差**——改配置 = 写文件 + reload（整份），与"运行时增删"冲突；需 `--with-stream` 编译进去，引入第二套栈。 |
| HAProxy | ✅ Runtime API | L4 能力与性能天花板最高，有 `add server` 可在线改后端（**UNCERTAIN**：版本门限与 `set server …` 语法未逐条核实）。代价：配置模型自成一套，与 Caddy 生态零复用。 |
| Traefik | ✅✅ 最强 | 容器起停自动增删；但 L4 匹配维度远少于 caddy-l4（TCP 只有 `HostSNI`/`ClientIP`/`ALPN`，非 TLS 只能 `HostSNI('*')`），且同样是容器模型。 |
| PVE nftables DNAT | ⚠️ 脚本化 | 最少组件、最直接、性能近裸转发；但**无鉴权、无审计、无过期、无 SNI 分流/健康检查**，规则散在宿主机脚本里与业务配置分离，最难回滚。**只作最后兜底。** |
## 6. 来源
**Caddy / 网络（外部）**

- Admin API（全部端点、语义、`@id`、Etag）：<https://caddyserver.com/docs/api> ・`admin`/`origins`/`enforce_origin`/`persist_config`/`tls_automate_names`：<https://caddyserver.com/docs/caddyfile/options> ・网络地址与配置目录（autosave 位置）：<https://caddyserver.com/docs/conventions>
- `handle_path` ≡ `handle` + `uri strip_prefix`：<https://caddyserver.com/docs/caddyfile/directives/handle_path> ・子目录问题：<https://caddy.community/t/the-subfolder-problem-or-why-cant-i-reverse-proxy-my-app-into-a-subfolder/8575>
- caddy-l4：[README/pkg.go.dev](https://pkg.go.dev/github.com/mholt/caddy-l4) ・[模块页](https://caddyserver.com/docs/modules/layer4) ・[servers](https://github.com/mholt/caddy-l4/blob/master/docs/servers.md) ・[handlers/proxy](https://github.com/mholt/caddy-l4/blob/master/docs/handlers/proxy.md) ・[matchers](https://github.com/mholt/caddy-l4/blob/master/docs/matchers.md) ・[routes](https://github.com/mholt/caddy-l4/blob/master/docs/routes.md) ・[combining_apps](https://github.com/mholt/caddy-l4/blob/master/docs/examples/combining_apps.md)
- 官方构建/多阶段 Docker：[docs/build#docker](https://caddyserver.com/docs/build#docker) ・[官方 caddy:2 Dockerfile 下载 release 二进制（证明不含第三方模块）](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile)
- Traefik TCP 规则与优先级：<https://doc.traefik.io/traefik/reference/routing-configuration/tcp/routing/rules-and-priority/> ・nginx stream：[核心模块](https://nginx.org/en/docs/stream/ngx_stream_core_module.html)・[HUP reload 语义](https://nginx.org/en/docs/control.html) ・HAProxy：[Runtime API `add server`](https://www.haproxy.com/documentation/haproxy-runtime-api/reference/add-server/)・[PROXY protocol 规范](https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt) ・nftables：[NAT](https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT))

**DSH 本机包（`R = …\node_modules\@deepseek-ai`，v0.1.7-rc.2）**

- `R\dsh-sandbox\README.zh.md:167` ・`R\dsh-sandbox\lib\index.js:126-136,166-173` ・`R\dsh-sandbox-policy\README.zh.md:45-48,75-76,148` ・`R\dsh-sandbox-policy\lib\index.js:26-30,98,142-146` ・`R\dsh-sandbox-policy\lib\invariant.js:30-53` ・`R\dsh-sandbox-policy\package.json:16-27`
- `R\dsh-sandbox-local\README.zh.md:53,130-132` ・`R\dsh-sandbox-local\lib\index.js:22-39` ・`R\dsh-bash-sandbox\README.zh.md:32,171` ・`R\dsh-fs-sandbox\README.zh.md:46` ・`R\dsh-sandbox-windows-acl\README.zh.md:117`
- `R\dsh-invariants\README.zh.md:12,32,36-50,90` ・`R\dsh-invariants\lib\types\index.d.ts:27-37,80` ・`R\dsh-sdk-minimal\cordis.patch.yml:106-119` ・`R\dsh-fs-observation-policy\README.zh.md:78` ・`R\dsh-workspace\README.zh.md:12`
- `R\dsh-session\lib\types\types.d.ts:68-69` ・`R\dsh-base\cordis.patch.yml:225-232,517-518` ・`R\dsh-web-app\cordis.patch.yml:163-168` ・`R\dsh-host-webserver\README.zh.md:39` ・`R\dsh-client-connection\README.zh.md:41,43` ・`R\dsh-deepseek-account-platform\README.zh.md:91` ・`R\dsh-web-app\README.zh.md:45-58`
- `C:\Users\HiBer2007\.dsh\profiles\dsh-tui\package.json` ・`C:\Users\HiBer2007\.dsh\profiles\web\cordis.patch.yml:18`

**UNCERTAIN 汇总**：① caddy-l4 GitHub Releases 是否附预编译二进制/OCI 镜像（本环境 GitHub 不可达；已确认官方 Docker tag 里没有带 l4 的镜像）。② HAProxy `add server` 引入版本与 `set server …` 语法。③ iptables DNAT 具体命令行（nftables 已核实）。④ `POST /config/apps/layer4` 在 `apps` 缺失时的精确状态码（**"必须先有 `apps` 键"本身是源码级确定的**；500 由 `handleError` 推导）。①–④ 均不影响主路径结论。
