# DSH-ForLife

**给 DSH 装上长期记忆的插件。** 它让一个 AI 个体住在 QQ 账户后面：记住发生过的事、按需要想起来、在没人说话的时候也能自己醒来。

构建在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）之上，通过社区互操作标准 **dsh-std（Community v0.15）** 做成可移植组件 —— 同一份代码可以跑在 dsh-tui、DSH Web、headless 三种宿主上。

---

## 它能做什么

### 三层记忆，各司其职

| 层 | 装什么 | 什么时候动 |
| :--- | :--- | :--- |
| **短期** | 当前对话的完整轨迹 | 每一轮追加 |
| **中期** | 压缩出来的要点、事实、决定 | 压缩时追加，**稳定前缀**（缓存友好） |
| **长期** | 语义条目（可检索）+ 原始日志（冷归档） | 沉降与召回 |

「忘掉」不是删除，而是**位置迁移**：中期条目转成**碎片指针**，正文进长期记忆；
长期记忆冷下来之后，正文进归档文件、库里只留摘要 —— **任何时候都取得回来**。

### 压缩：模型可以自己要求，但系统说了算

对话变长时，模型可以调 `request_compaction(reason)` **申请**压缩；
**批不批由系统裁决**（内容太薄不批、冷却期不批、占比告急则强制放行）。
批准后一次调用产出四件事：要点进中期、碎片化、`keep_in_short` 替换被遮蔽区域、写审计日志。

### Recall：有预算的检索

长期记忆不是随便翻的。每轮有额度、每周期有额度，返回时**附带预算声明**
（还剩几次、什么时候重置、本轮已经查过什么）。额度用完可以
`request_recall_extension(reason)` 申请追加 —— 但要给理由，且有冷却。

### 大工具结果不占上下文

`pwsh` / `read` / `web_fetch` 吐出一大段时，**只把前若干行 + 一个 id 给模型**，
全文落库；模型需要时用 `recall_full(id)` 取回。

### QQ 集成

防抖合并（同会话连发算一次）、噪音过滤、同会话串行 / 跨会话并行、
轮次可挂起（`defer_turn`）、回复 / 表情 / 输入状态 / @全体 / 群公告 / 表情包。
出站消息走 SQLite 队列，网关认领发送 —— **崩溃不丢消息**。

### 自己醒来

定时唤醒（`schedule_wake`）、事件唤醒（注册观察者）、手动唤醒（`wake_now`）。
唤醒桥端点有密钥校验 —— 它是"叫醒模型并让它执行一段提示词"的入口，
**没有密钥就不挂**（`ctx.webServer` 自身无 TLS 无认证）。

### 模型分级路由

三档（L1 轻 / L2 中 / L3 强）：守卫规则拦截明显场景 → L1 小模型评分 → 启发式兜底。
轮次内不换模型（保持语气一致），但模型可以**受控地**申请换更强的档位。

### 管理后台

Web 面板：记忆条目、压缩日志、缓存命中率、路由决策、会话与轮次、唤醒规则、
提示词版本、spill 表。**实时日志走 SSE**（带轮询兜底）。

---

## 快速开始

### 环境要求

- **Node ≥ 24**（开发期依赖原生 TS 类型擦除；运行期依赖 `node:sqlite` 的 FTS5）
- **pnpm 12.3.4**（`packageManager` 字段锁定）
- 可选：Docker（部署）、DSH CLI（profile 组合）

### 本地开发

```powershell
pwsh -File scripts/setup-dev.ps1                  # 一键就位（工作区链接 + DSH_HOME 隔离）
$env:DSH_HOME = "D:\DSH-ForLife\.runtime\dsh"     # DSH 的家目录隔离在仓库内
node scripts/doctor.ts                            # 诊断环境
dsh --profile forlife-web --no-open               # 启动带记忆面板的 Web（:3080）
```

`DSH_HOME` 指向仓库内目录是**刻意的**：这个项目**绝不碰宿主的 `~/.dsh`**。

### Docker 部署

```bash
cd deploy
cp docker-daemon.json /etc/docker/daemon.json     # 镜像加速（国内必需）
systemctl restart docker

FORLIFE_HOST=your.domain ACME_EMAIL=you@example.com \
  docker compose up -d
```

`FORLIFE_HOST` **必须是域名** —— 写成 IP 时 Caddy 不会为它启用自动 HTTPS。

完整步骤（含国内网络的坑）见 **[`docs/deploy/PVE_DEPLOY.md`](docs/deploy/PVE_DEPLOY.md)**。

---

## 配置

**所有默认值都在 [`packages/contracts/plan-baseline.json`](packages/contracts/plan-baseline.json) 里** ——
代码只通过 `defaultFor('键名')` 引用，**不硬编码数字**。

需要改阈值就改那个文件；需要偏离设计文档就在
[`packages/contracts/src/deviations.ts`](packages/contracts/src/deviations.ts) 里登记并写清理由。
这两件事都有测试守着。

常用环境变量：

| 变量 | 作用 |
| :--- | :--- |
| `DSH_HOME` | DSH 家目录（**部署时指向容器内数据卷**） |
| `FORLIFE_ROOT_HOT` / `_WARM` / `_COLD` | 三层存储的根路径（**至少要配 HOT**） |
| `FORLIFE_COLD_DIR` | 冷层挂载点的宿主路径（换真 HDD 时只改这个） |
| `FORLIFE_MODE` | `container` 时启用容器内的路径约定 |
| `FORLIFE_WAKE_BRIDGE_SECRET` | 唤醒桥端点的密钥（**不配就不挂那个端点**） |
| `FORLIFE_ONEBOT` | 启用 QQ 链路 |

---

## 文档

| 文档 | 内容 |
| :--- | :--- |
| [`PLAN.MD`](PLAN.MD) | **设计规格**：记忆模型、压缩协议、碎片索引、Recall 预算、QQ 集成、模型分级、缓存策略 |
| [`模型路由.MD`](模型路由.MD) | **设计规格**：复杂度评分与档位判定 |
| [`EXECUTION_PLAN.md`](EXECUTION_PLAN.md) | 执行记录与验收标准 |
| [`docs/`](docs/README.md) | 文档索引（审计、部署、调研、事故记录） |

---

## 目录

```
packages/
  contracts/       # 唯一真源：保真度基线 + 默认值派生 + 偏离登记
  dsh-component/   # 便携组件（双入口：dsh-std facet + legacy cordis）
  store/           # node:sqlite 封装、迁移、分层存储、FTS5、冷归档
  memory-core/     # 中期/长期/碎片/预算/裁决（纯逻辑，可单测）
  router/          # 守卫 + L1 评分器 + 启发式兜底 + 路由日志
  inference/       # 推理端点：四种来源 × 四种运行模式
  media/           # 附件、表情库、私有媒体库
  gateway/         # QQ 适配、队列、轮次驱动、触发引擎
  admin-ui/        # 管理后台前端
profiles/          # 可移植 DSH profile
deploy/            # Dockerfile + compose + Caddyfile
docs/              # 文档（见 docs/README.md）
scripts/           # doctor、环境检查
tests/             # 可移植性与安全边界
```

---

## 许可证

**保留所有权利（All Rights Reserved）** —— 见 [`LICENSE`](LICENSE)。

未经版权持有人事先书面许可，不得复制、修改、分发或以其他方式使用本软件。
