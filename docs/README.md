# 文档索引

> 仓库根目录只放**规格**与**门面**；其余文档按用途归到这里。

## 根目录（规格与门面）

| 文件 | 是什么 |
|---|---|
| `PLAN.MD` | **规格源**（`packages/contracts/plan-baseline.json` 的 `documents` 里就写它） |
| `模型路由.MD` | **规格源**（`router.*` 参数的 `src` 指向它） |
| `EXECUTION_PLAN.md` | 执行记录（**是"被核对对象"，不是依据** —— 审计里多处引用它正是为了指出「勾选 ≠ 已实现」） |
| `README.md` | 门面 |

## `docs/audit/` — 审计

| 文件 | 是什么 |
|---|---|
| `PLAN_FIDELITY_AUDIT.md` | **代码 vs PLAN.MD 的 1:1 保真度审计**（186 条，740 行）<br>★ **尤其看第 7 节「元问题」** —— 它记的是"为什么会出错"，比单条结论更重要 |

## `docs/deploy/` — 部署

| 文件 | 是什么 |
|---|---|
| `PVE_DEPLOY.md` | PVE 部署步骤 + **开头那节「真机部署实测结果」**（11 处缺陷与原始报错） |

## `docs/research/` — 调研

| 文件 | 是什么 |
|---|---|
| `astrbot-admin-panel-research.md` | 管理面板调研 |
| `dsh-web-plugin-report.md` | DSH Web 插件调研 |

## `docs/incidents/` — 事故与排障记录

**这些记录了真机踩过的坑**（有参考价值，但会过期 —— 别当成现状）。

| 文件 | 是什么 |
|---|---|
| `wake-incident-2026-10-06-remediation.md` | 唤醒事故的处置 |
| `wake-tools-contract-bug-2026-10-06.md` | 唤醒工具的契约 bug |
| `wake-prompt-truncation-2026-10-06.md` | 提示词截断 |
| `wake-2026-10-06-wake-tools-schema-fix.md` | 唤醒工具 schema 修复 |
| `wake-2026-10-06-2246-note.md` | 当天的记录 |
| `escalation-note-2026-10-06.md` | 升级说明 |
| `wake-log.md` | 排障日志 |

## `docs/status/` — 状态快照

**会过期** —— 看之前先看日期。

| 文件 | 是什么 |
|---|---|
| `WORK_STATUS.md` | 工作状态 |
| `runtime-status-2026-10-06.md` | 运行时状态快照 |

## ⚠️ 约定

**新写的临时笔记不要放根目录**（`.gitignore` 已挡掉常见命名）。
放 `docs/` 下对应目录，并在本文件加一行。
