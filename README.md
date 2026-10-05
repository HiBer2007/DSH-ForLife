# DSH-ForLife

住在 QQ 账户后面的**一个独立个体**：拥有自己的一份长期记忆，能自己盯事、自己醒来、自己决定说什么。

构建在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）之上，通过社区互操作标准 **dsh-std（Community v0.15）** 做成可移植组件，因此能同时跑在 dsh-tui、DSH Web、headless 三种宿主上。

## 设计文档（先读这两份）

| 文档 | 内容 |
| :--- | :--- |
| [`PLAN.MD`](./PLAN.MD) | 三层记忆模型、压缩协议、碎片索引、Recall 预算、QQ 集成、模型分级、缓存策略 |
| [`模型路由.MD`](./模型路由.MD) | 复杂度评分修订：守卫 → L1 小模型评分 → 启发式兜底 |
| [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) | **执行计划**：选型结论、目标架构、PLAN→实现映射、阶段 0–10、验收标准、风险登记册 |

两份设计文档是**约束**：其中每个参数与时机都要一比一实现（见下"保真度"）。

## 当前状态：阶段 0 完成（可移植骨架与验证台）

已经能跑的东西：

```powershell
$env:DSH_HOME = "D:\DSH-ForLife\.runtime\dsh"   # 把 DSH 的家目录隔离到仓库内
node scripts/doctor.ts                          # 诊断：运行时/契约/可移植性/存储/工具链
node --test "packages/**/test/*.test.ts" "tests/*.test.ts"   # 13 项测试
dsh --profile forlife --dump-config             # 用真实 DSH 验证 profile 组合（只组合不挂载）
```

阶段 0 的可验证结论：

- **profile 组合通过**：真实 DSH 在隔离的 `DSH_HOME` 里成功组合 `dsh-base` + 我们的组件 + 显式挂载的 `dsh-time-context`；
- **保真度基线就位**：114 条参数（45 条来自设计文档）、20 个时机、**数值偏离 0**、1 条规则级偏离；
- **可移植性有测试守着**：仓库内无宿主绝对路径、`storageRoots` 全相对、无向宿主主目录写入的调用；
- **安全红线有测试守着**：`send_packet` / 凭据类等协议级动作在代码里零引用；
- **部署骨架就位**：`deploy/docker-compose.yml`（五服务拓扑）与 `deploy/Caddyfile`（单一真源 + unix socket Admin API）都能被解析。

## 三条不可动摇的规则

1. **绝不碰宿主 `~/.dsh`。** 开发与部署一律用 `DSH_HOME` 指向仓库内目录。`tests/portability.test.ts` 会红。
2. **默认值只能来自保真度基线。** 需要新阈值 → 加进 `packages/contracts/plan-baseline.json`；需要偏离文档 → 登记进 `packages/contracts/src/deviations.ts` 并写清理由。`tests/fidelity` 会红。
3. **协议级危险能力不进适配器。** `send_packet` / `get_cookies` 之类不是"实现了不给工具"，而是**根本不实现**。

## 目录

```
packages/
  contracts/       # 唯一真源：保真度基线 + 默认值派生 + 偏离登记
  dsh-component/   # 便携组件（双入口：dsh-std facet + legacy cordis）
  store/           # node:sqlite 封装、迁移、blob 分层、FTS5、LanceDB 向量
  memory-core/     # 中期/长期/碎片/预算/裁决（纯逻辑，可单测）
  router/          # 守卫 + L1 评分器 + 启发式兜底 + 路由日志
  inference/       # InferenceEndpoint：四种来源 × 四种运行模式 × 自动部署
  media/           # 附件、表情库、私有媒体库
  gateway/         # QQ 适配、队列、轮次驱动、后台、触发引擎
  admin-ui/        # 后台前端（构建产物内嵌 gateway）
profiles/forlife/  # 可移植 DSH profile（cordis.yml + cordis.patch.yml）
scripts/           # doctor / dev-up 等
deploy/            # compose + Caddyfile
tests/             # 可移植性与安全边界测试
research/          # 调研报告与素材（不作为运行时依赖）
```

## 开发环境要求

- **Node ≥ 24**：开发期依赖原生 TS 类型擦除（零构建），运行期依赖 `node:sqlite`（FTS5）
- **pnpm**：工作区链接
- 可选：Docker（部署端验证）、DSH CLI（profile 组合验证）

`node scripts/doctor.ts` 会把缺什么、怎么修直接打出来。
