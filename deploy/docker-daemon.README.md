# `docker-daemon.json` 为什么长这样（**别把说明写回那个 JSON 里**）

## ★ 最重要的那条：**JSON 里不能有任何"说明字段"**

原来这个文件里有一个 `"_comment": [...]` 字段放说明。2026-10-07 在真机（Docker **29.1.3**，
Ubuntu 26.04）上照 `PVE_DEPLOY.md` §0 做 `cp docker-daemon.json /etc/docker/daemon.json
&& systemctl restart docker` 之后，**dockerd 直接拒绝启动**：

```
unable to configure the Docker daemon with file /etc/docker/daemon.json:
the following directives don't match any configuration option: _comment
```

Docker 29 对 `daemon.json` 是**严格解析**（未知的顶层键 = 致命错误），而它的报错
**只说 `_comment` 不认识，不会说"你的说明字段是非法的"** —— 排障的人会去怀疑镜像源。

⇒ **说明搬到本文件**，`docker-daemon.json` 只留合法字段。

## 为什么这个文件是**部署前置条件**（而不是可选项）

`docker compose build` 要拉基础镜像（`node:24-alpine`、`caddy:2-alpine`），
而**国内直连 `registry-1.docker.io` 会超时**（实测：`Network is unreachable`）。
⇒ 不配镜像加速源，构建必然失败。

## ⚠️ 实测：`registry-mirrors` 的**顺序**很关键，而且**卡住时不会故障转移**

真机实测（2026-10-07）：

| 源 | 结果 |
|---|---|
| `docker.1ms.run`（原来排第一） | **拉取卡死**：`docker pull node:24-alpine` 13 分钟零字节（到 `104.17.57.231:443` 连接 ESTABLISHED 但无数据）；`docker pull caddy:2-alpine` 240 秒超时（rc=124） |
| `docker.1panel.live`（提到第一位后） | **`caddy:2-alpine` 16 秒拉完**，`node:24-alpine` 53 秒 |
| `docker.1panel.live` | ⚠️ 对**非官方库**（`mlikiowa/napcat-docker`）返回 **403 Forbidden** |
| `docker.xuanyuan.me` | ⚠️ 同上 403 |
| `docker.m.daocloud.io` | ✅ 401（需 token，正常）⇒ napcat **2.14GB 拉成功**；非官方库可以用它，或**前缀形式**：`docker pull docker.m.daocloud.io/mlikiowa/napcat-docker:latest` 再 `docker tag` |

**关键教训**：Docker 的 mirror 失败转移只在**明确报错**时发生，
**连接"卡住"不触发转移** ⇒ 列表第一位挂掉 = 所有拉取一起挂。
（所以顺序不是"随便排"，而且**要定期验证第一个源还能不能拉**。）

## ⚠️ 它只管 **Docker Hub**

`registry-mirrors` 只对 **Docker Hub 的镜像**生效。本项目里有一个
**不在 Docker Hub 上**的镜像：

```
ghcr.io/ggml-org/llama.cpp:server   # 评分器（可选，profiles: [scorer]）
```

⇒ 那个不会被这个配置加速，要另外想办法。
**（更正一条旧说法）**：真机实测 `https://ghcr.io/v2/` 从 VM **可达**（返回 401 =
需要 token，属正常），所以"ghcr 拉不到"不成立 —— 本次没拉是因为它是可选 profile。

## ⚠️ 第三方加速源的固有风险（如实说）

它能看到你**拉了哪些镜像**。生产环境如果有合规要求，
应当用**自建 registry 或云厂商的官方加速**，而不是第三方站点。
这里列多个是为了容灾（单一站点挂掉时还能拉）。

## 怎么用

```bash
sudo cp -n /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true
sudo cp /opt/forlife/deploy/docker-daemon.json /etc/docker/daemon.json
sudo systemctl restart docker
systemctl is-active docker            # ★ 必须 active（不是的话看 journalctl -u docker）
docker info | grep -A5 'Registry Mirrors'
docker pull caddy:2-alpine            # 验证（挑小的，别拿几百 MB 的试）
```
