# DSH provider 接入：机制与真机报错对照

> 模型接入的**活文档在代码里** —— `profiles/*/cordis.patch.yml` 的注释逐条留了现象与结论。
> 本文件是汇总入口：讲机制、讲报错怎么读、讲坑在哪。

## 机制（两条，别再走弯路）

1. **`settings.yaml`（harness home 下）只在导入时读一次**，随后 DSH 把它**投影进 profile 的
   `cordis.patch.yml`**（provider 声明 + 默认模型）。投影之后，**patch 才是权威位置** ——
   再改 settings 不影响已生成的 profile。
2. **patch 条目的 `id` 必须与 base bundle 里已挂载模块的 `id` 精确一致**：
   `@deepseek-ai/dsh-llm-pi-ai` 在 base bundle 里是 `id: llm-pi-ai` +
   `name: @deepseek-ai/dsh-llm-pi-ai`，项目自有插件用短名（`forlife-memory`、`compaction-basic`）。
   **id 不一致时匹配不上且静默无效** —— 表现就是"改了没反应"。
   判据是**运行中的 profile patch**（`dsh --dump-config` 里那一行警告），不是"短名/全名"这种口诀；
   机器守卫见 `tests/profile-patch-ids.test.ts`。

## 真机报错 → 根因对照

| 报错 | 根因 |
|---|---|
| `MISSING_CREDENTIAL: no API key for provider route "deepseek-official"` | DSH 默认走**内置** provider（要 `DEEPSEEK_API_KEY`）。不声明自己的 provider，设了 `FORLIFE_*` 密钥也没用 |
| `configurable provider "amazon-bedrock" is already declared` | `@deepseek-ai/dsh-llm-pi-ai` **已在 base bundle 里**：应**按 id 定位改 config**，不能再 insert 一份（两个实例抢同一批 provider 声明） |
| 仍然报 `deepseek-official` | provider 放错位置（`config:` 是**组合**，provider 来自 settings 文档 / 投影后的 patch）；或只加了 provider、**没改默认模型** —— 两者必须一起改 |
| `does not support reasoning effort "high"` | 档位必须**显式声明** `reasoningEfforts`；不声明时宿主认为该模型"不支持任何档位" |
| `expected "off" / "minimal" / …` | DSH **没有 `none`**；项目约定的 `none` = DSH 的 **`off`** |
| `400 MissingSessionID` | OpenCode Go **强制**每个请求带 `x-opencode-session`。它同时是路由与提示词缓存的依据，**值要稳定**（变了会掉缓存） |

## 模型的上下文窗口（`contextWindow`）：真值与来源

**为什么这个数字要命**：宿主算 `thresholdTokens = floor(contextWindow × ratio)`
（`resolveCompactSpec`），压缩阈值 = **窗口 × 比例**。
窗口填错 ⇒ 压缩在错的地方触发；**填得比真实值大 ⇒ 压缩永不触发、上下文直接溢出**
（`isContextOverflow` 也一起失灵）。所以**声明值宁可偏小，也绝不能偏大**，
**查不到可靠来源就不要填**。

**兜底值不是真值**：`@deepseek-ai/dsh-llm-pi-ai` 的
`DEFAULT_CONTEXT_WINDOW = 262144`（`lib/index.js`，另见 `defaultContextWindow ?? 262144`）
是"没人填时别算出 0"的占位。解析优先级是
`entry.contextWindow ?? base?.contextWindow ?? defaultContextWindow`
（`resolveRouteModels()`）—— 注意**显式写的值会盖掉包内目录里的真值**，
所以"照抄一个像样的数字"比留空更坏。

### 2026-10-09 逐模型核对结果（用户裁定：把所有值都补上）

| 接入点 | 模型 | 此前声明 | 真值 | 来源 |
|---|---|---|---|---|
| `opencode-go` | `deepseek-v4.1-flash` | 262144 | **1000000** | 用户 2026-10-09 裁定；[models.dev opencode-go](https://models.dev/providers/opencode-go/) `limit.context=1000000`。⚠️ 包内目录里**没有**这个 id（只有 `deepseek-v4-flash`），所以它才是唯一真正吃到过兜底的 |
| `opencode-go` | `deepseek-v4-pro` | 262144 | **1000000** | pi-ai 包内目录 `@earendil-works/pi-ai/dist/providers/data/opencode-go.json`（`generatedAt 2026-09-05`）；models.dev 同值 |
| `opencode-go` | `glm-5.3-flash` | 204800 | **1000000** | 同上 |
| `opencode-go` | `glm-5.3` | 204800 | **1000000** | 同上 |
| `deepseek-official` | `deepseek-flash` | **未声明**（也不需要） | **1000000** | `@deepseek-ai/dsh-llm-deepseek/lib/index.js` 的 `DEFAULT_CONTEXT_WINDOW = 1e6` 与 `DEFAULT_MODELS[].contextWindow = 1e6`；models.dev 的 `deepseek` 页同值 |
| `deepseek-official` | `deepseek-v4-pro` | **未声明**（也不需要） | **1000000** | 同上 |

**两个接入点的值可以不同**（接入点自己有上游限制），所以**要分别核对**。
本次两边恰好都是 1M。**`deepseek-official` 的模型在 profile 里一个字都不必填** ——
它的目录与兜底都在 `dsh-llm-deepseek` 里，且都是 1e6（那条 262144 只属于 pi-ai）。

机器守卫：`packages/dsh-component/test/compaction-threshold.test.ts` 的
「每个模型都显式声明了窗口，且等于登记的真值」（含模型集合比对，新增模型漏登记会红）。

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
