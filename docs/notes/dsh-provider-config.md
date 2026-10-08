# DSH provider 接入：机制与真机报错对照

> 模型接入的**活文档在代码里** —— `profiles/*/cordis.patch.yml` 的注释逐条留了现象与结论。
> 本文件是汇总入口：讲机制、讲报错怎么读、讲坑在哪。

## 机制（两条，别再走弯路）

1. **`settings.yaml`（harness home 下）只在导入时读一次**，随后 DSH 把它**投影进 profile 的
   `cordis.patch.yml`**（provider 声明 + 默认模型）。投影之后，**patch 才是权威位置** ——
   再改 settings 不影响已生成的 profile。
2. **patch 条目的 `id` 必须与 base bundle 里已挂载模块的 `id` 精确一致**。
   当前仓库用完整包名（`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-agent-default-model`），
   项目自有插件用短名（`forlife-memory`、`compaction-basic`）。
   **id 不一致时匹配不上且静默无效** —— 表现就是"改了没反应"。判断依据是运行中的 profile patch，
   不是"短名/全名"这种口诀。

## 真机报错 → 根因对照

| 报错 | 根因 |
|---|---|
| `MISSING_CREDENTIAL: no API key for provider route "deepseek-official"` | DSH 默认走**内置** provider（要 `DEEPSEEK_API_KEY`）。不声明自己的 provider，设了 `FORLIFE_*` 密钥也没用 |
| `configurable provider "amazon-bedrock" is already declared` | `@deepseek-ai/dsh-llm-pi-ai` **已在 base bundle 里**：应**按 id 定位改 config**，不能再 insert 一份（两个实例抢同一批 provider 声明） |
| 仍然报 `deepseek-official` | provider 放错位置（`config:` 是**组合**，provider 来自 settings 文档 / 投影后的 patch）；或只加了 provider、**没改默认模型** —— 两者必须一起改 |
| `does not support reasoning effort "high"` | 档位必须**显式声明** `reasoningEfforts`；不声明时宿主认为该模型"不支持任何档位" |
| `expected "off" / "minimal" / …` | DSH **没有 `none`**；项目约定的 `none` = DSH 的 **`off`** |
| `400 MissingSessionID` | OpenCode Go **强制**每个请求带 `x-opencode-session`。它同时是路由与提示词缓存的依据，**值要稳定**（变了会掉缓存） |

## 档位取值（与项目约定对齐）

- 项目自有类型：`none | low | high | max`（**没有 `medium`**，它在 DeepSeek 与 GLM 上都不合法）。
- 宿主侧合法值域按模型能力而定，每个模型**显式声明**它支持哪些档位：
  - `profiles/forlife-qq/cordis.patch.yml` 中 DeepSeek 系列为 `off / low / high / max`，
    GLM 系列为 `low / high / max`。
- 默认模型（`@deepseek-ai/dsh-agent-default-model`）的 `reasoningEffort` 与项目档位是两套命名，
  映射见 `packages/router/src/routes.ts`。

## 密钥

只存**引用名**（`apiKeyEnv`，如 `FORLIFE_OPENCODE_GO_KEY`），值放环境变量或本机 gitignored 文件里。
文档、配置注释里都不写密钥本身。

## 怎么验证链路通

```console
$ dsh --profile forlife-headless --json "只回四个字：链路正常"
{"type":"final","text":"链路正常"}
```

单行任务可以作为位置参数；**多行文本必须走 stdin**（见 `dsh-headless-task-contract.md`）。
`{"type":"final", ...}` 是 NDJSON 事件流里的收尾事件。

> 注：`baseURL` 必须与 gateway 侧的 `OPENCODE_GO_BASE_URL` 一致，否则面板上的额度统计与实际调用对不上。
