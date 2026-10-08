# DSH-ForLife

住在 QQ 账户后面的**一个独立个体**：拥有自己的一份长期记忆，能自己盯事、自己醒来、自己决定说什么。

构建在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）之上，通过社区互操作标准 **dsh-std（Community v0.15）** 做成可移植组件，因此能同时跑在 dsh-tui、DSH Web、headless 三种宿主上。

---

## 现在到哪一步了

**阶段 0–11 全部交付**，并且**在一台真 PVE 虚拟机上从零部署跑通了**。

| 维度 | 状态 |
| :--- | :--- |
| **测试** | **1258 项全绿**（`store` 182 · `dsh-component` 368 · `gateway` 447 · `contracts` 18 · `memory-core` 100 · `router` 143） |
| **类型检查** | `pnpm typecheck` **0 错误**（严格档：`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` / 无 `any`） |
| **真机部署** | ✅ 四容器全 `healthy`；Caddy 反代 200 + `Via: 1.1 Caddy`；对外**只有 80/443/22** |
| **冷热分层** | ✅ **真的是两个文件系统**（`/data` 与 `/cold` 的 `fsid` 不同） |
| **整机重启** | ✅ 冷层自动挂载、四容器自愈、**数据完整**（61 表 / 迁移 27 不变） |
| **生产工具数** | ✅ **34 个**（含 `qq_reply` / `request_recall_extension` / `recover`） |

### 已经能跑的东西

```powershell
pwsh -File scripts/setup-dev.ps1                  # 一键就位（junction + 工作区链接 + DSH_HOME 隔离）
$env:DSH_HOME = "D:\DSH-ForLife\.runtime\dsh"     # DSH 的家目录隔离在仓库内
node scripts/doctor.ts                            # 诊断
pnpm typecheck                                    # 类型检查
node --test "packages/**/test/*.test.ts"          # 全量测试
dsh --profile forlife --dump-config               # profile 组合
dsh --profile forlife-headless "你好"              # 真实加载
dsh --profile forlife-web --no-open               # 带记忆面板的 Web（:3080）
```

---

## ★ 先读这两份（这个项目最值钱的东西）

### 1. [`docs/audit/PLAN_FIDELITY_AUDIT.md`](./docs/audit/PLAN_FIDELITY_AUDIT.md) —— 1:1 保真度审计

**逐条核对 186 项**「PLAN.MD 说的 vs 代码做的」，每条给四段式结论
（PLAN 原文要求 → 代码在哪 → 是否一致 → 证据）。

| 判定 | 数量 |
| :--- | ---: |
| ✅ 一致 | 62 |
| ⚠️ 部分一致 | 56 |
| ❌ 不一致（未登记） | 21 |
| ❓ 找不到实现 | 31 |
| ⚠️ 无法判定 | 17 |

**一句话结论**：**数值与表面结构复现得很好**（§12 的 15 个默认值逐字相等、
三张权威表字段名一个不缺、三个 QQ 工具名都对、渲染形态与位置契约有机器守卫），
**但行为与接线缺口很大**。

**★ 尤其读第 7 节「元问题」** —— 它记的是「**为什么会出错**」，比单条结论更重要：

- **`fidelity.test.ts` 是自指的**（只断言 JSON 对自己）⇒ **"保真度全绿" ≠ 一比一**
- **`EXECUTION_PLAN.md` 多处"声称有"而实际不存在** ⇒ **执行记录不能当实现证据**
- **测试用"想象中的接线"把缺口盖住了**
- **`deviations.ts` 两个方向都错了**（记了没实现的，漏了真偏离的）

### 2. [`docs/deploy/PVE_DEPLOY.md`](./docs/deploy/PVE_DEPLOY.md) —— 部署

**开头那节「真机部署实测结果」列了 11 处缺陷与原始报错** ——
其中 5 处致命（`docker-daemon.json` 的 `_comment` 让 dockerd 拒启、
包名少了 `@deepseek-ai/` scope、`/app:/app:ro` 遮蔽镜像代码……）。

**⇒ 照那份文档做之前，先读那一节。**

---

## 设计文档（约束）

| 文档 | 内容 |
| :--- | :--- |
| [`PLAN.MD`](./PLAN.MD) | 三层记忆模型、压缩协议、碎片索引、Recall 预算、QQ 集成、模型分级、缓存策略 |
| [`模型路由.MD`](./模型路由.MD) | 复杂度评分修订：守卫 → L1 小模型评分 → 启发式兜底 |
| [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) | 执行计划（**是"被核对对象"，不是依据** —— 审计里多处引用它正是为了指出「勾选 ≠ 已实现」） |

前两份是**规格源**：其中每个参数与时机都要一比一实现。

---

## 三条不可动摇的规则

1. **绝不碰宿主 `~/.dsh`。** 开发与部署一律用 `DSH_HOME` 指向仓库内目录。`tests/portability.test.ts` 会红。
2. **默认值只能来自保真度基线。** 需要新阈值 → 加进 `packages/contracts/plan-baseline.json`；
   需要偏离文档 → 登记进 `packages/contracts/src/deviations.ts` 并写清理由。
   **`scripts/verify-deploy-defects.mjs` 与 `param-consumption.test.ts` 会红。**
3. **协议级危险能力不进适配器。** `send_packet` / `get_cookies` 之类不是"实现了不给工具"，而是**根本不实现**。

---

## 目录

```
packages/
  contracts/       # 唯一真源：保真度基线(143 参数) + 默认值派生 + 偏离登记
  dsh-component/   # 便携组件（双入口：dsh-std facet + legacy cordis）
  store/           # node:sqlite 封装、迁移、blob 分层、FTS5、冷层沉降
  memory-core/     # 中期/长期/碎片/预算/裁决（纯逻辑，可单测）
  router/          # 守卫 + L1 评分器 + 启发式兜底 + 路由日志
  inference/       # InferenceEndpoint：四种来源 × 四种运行模式 × 自动部署
  media/           # 附件、表情库、私有媒体库
  gateway/         # QQ 适配、队列、轮次驱动、后台、触发引擎
  admin-ui/        # 后台前端（构建产物内嵌 gateway）
profiles/          # 可移植 DSH profile（forlife / -headless / -qq / -web）
scripts/           # doctor / 部署缺陷核对 / prompt 位置 lint
deploy/            # Dockerfile.app + compose + Caddyfile + daemon.json
docs/              # ★ 见 docs/README.md 的索引
  audit/           #   1:1 保真度审计报告
  deploy/          #   PVE 部署步骤 + 真机实测结果
  incidents/       #   事故与排障记录（有参考价值，但会过期）
  research/        #   调研资料
  status/          #   状态快照（会过期）
tests/             # 可移植性与安全边界测试
```

---

## 开发环境要求

- **Node ≥ 24**：开发期依赖原生 TS 类型擦除（零构建），运行期依赖 `node:sqlite`（FTS5）
- **pnpm 12.3.4**（`packageManager` 字段锁定）
- 可选：Docker（部署端验证）、DSH CLI（profile 组合验证）

`node scripts/doctor.ts` 会把缺什么、怎么修直接打出来。

---

## 记忆面板

`dsh --profile forlife-web --no-open` 启动后，**设置 → 记忆** 里能看到：

- epoch / 修订号 / 活跃条目 / 碎片数 / token 占用
- **提示词前缀指纹（sha256）** —— 一眼看出"这一轮的稳定前缀有没有变"
- 约束违反清单（渲染方只报告、不擅自改数据）
- 条目表：位置、类型（活跃/碎片）、摘要或碎片提示、token、来源范围、UTC 创建时间
- **压缩日志**（三态 `approved` / 拒绝理由 / 模型名）
- **缓存命中率**（`cache_metrics`）
- **spill 表**（大工具结果）

前端是 `packages/dsh-component/client/index.js`：**手写、零构建**，直接就是宿主加载器的模块格式，
`react` 由宿主提供。它注册进 `settings.section` 槽位（与官方设置页同一个位子），
数据来自 `/api/forlife/*`（日志流走 SSE，带轮询兜底）。

---

## ★ 这个项目踩过的坑（新贡献者请读）

审计报告第 7 节列了「元问题」，这里挑三条最贵的：

### 1. **"接线断了但测试全绿"** —— 栽过 **7 次**

`beginTurn` / `resetCycle` / `spill()` / `buildQqTools` / `cache-collector` 事件层级 ……

**模式都一样**：库代码写好了、单元测试过了、**生产路径上零调用**。

**⇒ 纪律**：每个修复都配一条「**接线守卫测试**」——
**读源码断言调用点存在**（见 `test/*-wiring.test.ts`，共 10 个）。
**这种测试不好看，但它拦的正是"功能写好了、测试全绿、而线上根本没跑"。**

### 2. **"假证据"比"缺功能"更危险**

那行 `已注册工具 …` 曾经是**硬编码字符串** ——
它让我和另一个 agent **都以为生产里只有 11 个工具**，甚至计划去"修"一个**根本不存在的 bug**。

**⇒ 一个会说谎的证据源，不仅掩盖问题，还会制造假问题。**
**⇒ 当你怀疑一个数字时，先问"这个数字是怎么产生的"，而不是"为什么它不对"。**

### 3. **"起来了" ≠ "能用"**

- 容器 `Up` 但**组件 3 条 entry 全 `failed to import`**（唯一症状是一行 `ERR_MODULE_NOT_FOUND`）
- `grep` 到字符串但**那是注释**（配置行还在）—— 因此得出过**相反**的结论
- 冷层写入**静默失败**，应用**一句话都不报**

**⇒ 判断"卡住"要看三个信号**：进程状态 **+ 日志/磁盘有没有动 + 网络是不是死连接**。
**只看 `ps` 会被骗**（同一个 `S` 状态，四次结论完全不同）。

---

## 许可证

**保留所有权利（All Rights Reserved）** —— 见 [`LICENSE`](./LICENSE)。

未经版权持有人事先书面许可，不得复制、修改、分发或以其他方式使用本软件。
`package.json` 的 `license` 字段为 `UNLICENSED`（npm 语义下的"保留所有权利"）。
