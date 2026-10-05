# DSH 模型分级路由 / 子代理调度 / 多模型混合 — 源码实证调研

**基线**：`@deepseek-ai/dsh-* = 0.1.7-rc.2`，Node v24.19.0。**真实包根** `R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（`.dsh\profiles\node_modules\@deepseek-ai\` 下 junction 断链，结论均按真路径实读）。下文 `R/...:LINE` 全是 `read`/`grep` 实证；`$DSH_HOME` 默认 `~/.dsh`（本机 `C:\Users\HiBer2007\.dsh`，`R/dsh-home-paths/lib/types/index.d.ts:7`）。
**订正**：不存在 `dsh-agent-presets`、`dsh-tool-subagent-report` 两个包（已核实）；真包为 `dsh-agent-preset`（单数，另含 skills）与 `dsh-agent-preset-registry`，`TOOL_REPORT: 2900` 只是预留 order。

## 0. 结论速览

| 需求 | 现成? | 关键 API | 备注 |
|---|---|---|---|
| 轮次开始选 L1/L2/L3 | ✅ 钩子现成 | `agent/pre-step`（读本轮 messages）→ `agent/request`（替换整份 `LlmCallConfig`） | 规则自研 |
| 会话内热切模型 | ✅ | `installModelSelection(agentCtx, ref)`（导出 `dsh-agent`）；`selectForNextRequest` | 直接用 |
| 给子代理指定便宜模型 | ✅ 全套 | `ctx.subagents.start(name,{agentOptions:{provider,model,reasoningEffort}})`；工具字段 `provider/model/reasoning_effort` | 策略自研 |
| 多模型混跑 | ✅ | 多 provider 并存 `ctx.llm.registerAdapter()`；`workflow` 的 `agent({provider,model})`；preset 内 `tool-subagent.agentOptions` | 直接用 |
| 提示词段落替换 + 热生效 | ✅ | `ctx.systemPrompt.section()`，同 section 名在**更窄作用域**注册即遮蔽；`text` 支持函数→每次装配重算 | 见 §3 |
| 用户可编辑提示词 + Web 后台 | ⚠️ 半现成 | 只有 `$DSH_HOME/AGENTS.md` 与 profile patch；**无任何现成提示词编辑 UI**；`ctx.settings` 只能编辑 volatile Config | UI 需自研 |
| 主模型失败自动换备模型 | ❌ **不存在** | `agent/request-error`（唯一动作 `{kind:'retry'}`）+ `agent/request` 自研 | 必须自研 |
| preset 声明模型 | ❌ 无 model 字段 | 只能经 preset 内子插件行 | — |

## 1. 子代理：创建、驱动、能否单独指定模型（Q1）

**服务接口** `ctx.subagents` → `SubagentRuntime`（`R/dsh-subagent/lib/types/index.d.ts:62-100`；事件 `subagent/provider-added|provider-removed|subagent/start|subagent/end` `:66-99`）：
- `start(name, request): Promise<SubagentRun>`（`:300`）一次性子代理唯一入口；`startContinuable(spec)`（`:142`，容量 `maxActiveSubagents` 默认 8，`:102-107`）。
- `registerProvider(provider): () => void`（`:276`）、`getProvider(name)`（`:282`）、`list()`（`:287`）。
- `sendMessage(sender,targetId,content,opts)`（`:157`）、`interrupt(targetSessionId, authority)`（`:186`）、`listChildren`（`:218`）/`listDescendants`（`:234`）、`drainContinuableChildren`（`:208`）。

**`SubagentStartRequest` 全字段**（`R/dsh-subagent/lib/types/types.d.ts:136-192`）——**能逐子代理指定模型**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `label?` | string | 展示名（持久为子会话 label） |
| `prompt` | `ContentBlock[]` | 子代理首条 user 消息 |
| `parent` | `Agent` | 派生 workspace/lineage/depth |
| `signal` | `AbortSignal` | 唯一取消通道 |
| **`agentOptions?`** | **`AgentOptions`** | **`:155-162` 原文「Optional host-Agent provider, model, reasoning-effort, and output-token overrides」** |
| `outputSchema?` | `ObjectJsonSchema` | 需 `capabilities.outputSchema` |
| `maxDepth?` | number | 递归上限，需 `capabilities.depthLimit` |
| `toolFilter?` | `ToolRestriction` | 工具裁剪 `allow/deny`，需 `capabilities.toolFilter` |
| `persona?` | string | **逐子代理 persona，遮蔽部署 persona**，需 `capabilities.persona` |

`AgentOptions = {provider?, model?, reasoningEffort?, maxTokens?}`（`R/dsh-agent/lib/types/runtime-types.d.ts:21-30`）→ **provider/model/reasoningEffort 三件套都能逐子代理指定**。`SubagentCapabilities = {agentOptions, outputSchema, depthLimit, toolFilter, persona}`（`types.d.ts:122-128`），缺能力**显式报错**不静默降级。内置两个 in-process 驱动**五项全 true**：spawn（`R/dsh-subagent-spawn-in-process/lib/index.js:23-30`，`inheritsParentContext=false`）、fork（`R/dsh-subagent-fork-in-process/lib/index.js:37-44`，`true`，seed 父会话已完成轮次 `:49-55`）。
合并规则 `resolveChildAgentOptions(parent, requested, childDepth)`（`R/dsh-subagent/lib/types/child-agent.d.ts:42-52`）：未指定则继承父 Agent 的 provider/model/effort/maxTokens；**改路由但未写 effort 会清掉继承 effort**；`provider` 与 `model` 必须成对（`R/dsh-tool-subagent/lib/index.js:68`）。可续聊子代理把 `agentProvider/agentModel/agentReasoningEffort/persona/toolFilter` 落进 `subagent/descriptor`（v3，`R/dsh-subagent/lib/types/descriptor.d.ts:44,64-79`）。

**`subagent_*` 工具参数**（`R/dsh-tool-subagent/lib/index.js:398-430`；工具名默认 `subagent`，实例配置 `toolName`，`lib/types/index.d.ts:24`）：
- 恒有 `description`（必填，3–5 词）、`prompt`（必填）；**仅当实例开启模型选择**（`modelSelectionSettings: true`）才有 `provider`/`model`/`reasoning_effort`（`:412-425`），省略=用实例默认/继承父路由；仅当 `enableRunInBackground !== false` 有 `run_in_background`（`:426-429`）。
- 输出 `oneOf`：`{kind:'background',jobId}` | `{kind:'continuable',subagentId}` | `{kind:'foreground',runId,output[]}`（`:432-483`）。同实例另注册 `list_subagent_models`（`:174-196`）。
- **模型看不到** `persona`/`toolFilter`/`maxDepth`/`outputSchema`——只来自**工具实例 config**（`:496-499,517-519`）或程序化调用。
- 开关链路：`modelSelectionSettings`（默认 false，`lib/types/index.d.ts:29`）→ 需 Host 服务 `subagentModelSelection`（`lib/index.js:586-587`）→ `current()` 给 `{enabled, allowedModels:[{provider,model}]}`（`lib/model-selection-settings.js:41-64`）→ **只对新建会话生效**；策略以持久事件 `subagent/model-selection-policy` 落日志，子代理继承父会话策略（`lib/index.js:198-232,588-605`）；白名单不符抛 `child LLM route "..." is not allowed for this Session`（`:91-98`）。UI 命名空间 `subagent-model-selection-settings`（`R/dsh-client-ui-settings-subagent/lib/client.js:515`）。

**程序化起子代理（官方范式，照抄）** `R/dsh-workflow-ptc/lib/index.js:328-340`：
```js
const run = await this.subagents.start(this.provider, {
  prompt:[{type:'text',text:req.prompt}], parent:this.parent, signal:this.controller.signal,
  ...(req.schema ? {outputSchema:req.schema} : {}),
  ...(req.provider||req.model ? {agentOptions:{provider:req.provider, model:req.model}} : {}) });
```
`dsh-workflow-ptc` 的 `agent()` 支持逐调用 `{provider, model}`（`:152-163`，`meta.phases[].provider/model` 校验 `:496-507`）——**「多模型混合」的现成范式**。
**控制类工具** `R/dsh-tool-subagent-control/lib/index.js`：`send_message`（:23）、`interrupt_agent`（:62）、`list_agents`（独立入口 `…/list-agents`）。

## 2. Agent Preset（Q2）

**只有 5 个字段，没有 model 字段**：`PresetDefinition = {id(必填), name?, description?, order?, plugins(必填: Cordis 子插件行数组)}`（`R/dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`；运行期 schema `R/dsh-agent-preset/lib/index.js:13-19`）。→ 模型/系统提示词/工具集/权限/sandbox/skills **全都不是 preset 字段**，只能由 `plugins` 里的子行表达（persona 用 `@deepseek-ai/dsh-persona` 行，子代理用 `@deepseek-ai/dsh-tool-subagent` 行）。
**磁盘格式 = Cordis YAML patch 行**（不是专用 preset 目录），见 `R/dsh-web-app/presets/minimal.patch.yml:4-16`：
```yaml
- insert:
    - id: preset-minimal
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: minimal, order: 3, plugins: [
        { id: persona, name: '@deepseek-ai/dsh-persona',
          config: { prefix: You are a helpful software engineer assistant., complete: true, includeRuntimeContext: false } } ] }
```
用户唯一可写层 = `$DSH_HOME/profiles/<name>/cordis.patch.yml`（`R/dsh-app-boot/lib/index.js:487` `PROFILE_PATCH_FILENAME="cordis.patch.yml"`；目录 `:524-527`），另有一层 `$DSH_HOME/cordis.patch.yml`（`R/dsh-hmr/lib/index.js:354`）。本机实证 `~/.dsh/profiles/web/cordis.patch.yml` 已 15KB（含 `agent-default-model` 的 `provider/model/reasoningEffort` `:539-544`、`llm-pi-ai` 自定义 provider/模型 `:30-40`）。
**`~/.dsh/.agent-presets/` 已废弃**：官方包 0 命中；`R/dsh-agent-preset-registry/README.md:46`「neither scans directories nor accepts preset paths」；`R/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:70`「Nothing reads that directory any more」。本机该目录只是第三方 `@deepseek-harness-tui/dsh-tui` 的私有约定（`~/.dsh/.agent-presets/liangshen/.dsh-tui-managed.json:2` owner 字段）。
**可动态注册，不能就地 patch**：服务 `ctx.agentPresets`（`…registry/lib/types/index.d.ts:15-19`）；`register(def): Promise<() => Promise<void>>`（`:39-43`，实现 `lib/index.js:500-524`）重复 id 抛 `Duplicate agent preset`（`:503`），返回 disposer（可移除）；**无** `define`/`upsert`/`patch`，`readDocument()` 明示只读（`:71-75`），改已发布 preset 只能覆写 Loader 行 config（且「override replaces the complete `config`」）。默认 preset `defaultId = selectedDefault ?? default`（`lib/index.js:493-495`），`selectedDefault` 是 volatile → 客户端 `ctx.remote.settings.update('agent-preset-registry',{selectedDefault:id})`（`R/dsh-client-ui-agent-preset/lib/client.js:1068,1080`）。会话绑定 `CreateAgentOptions.meta.agentPreset`（`R/dsh-agent/lib/types/index.d.ts:70`）；`select()` **只在空白会话**可用，已开场抛 `agent-preset/locked`（`…registry/lib/index.js:754-763`）。

## 3. 提示词可编辑性（Q3，关键）

**注册 API**（`R/dsh-system-prompt/lib/types/index.d.ts:47-70`）：
```ts
interface PromptSection { name: string; order: number;
  text: string | ((context: AssembleContext) => string);  // 函数→每次 assemble 求值
  interpolate?: boolean;   // 默认 true；false 保留字面量
  complete?: boolean; }    // 视为「整段系统提示词」
```
`ctx.systemPrompt.section(s): () => void`（`:239`，实现 `lib/index.js:240-243`）；排序 = `order` 升序 + 名字 code-unit 序（`lib/index.js:98`）。`getSectionOrder(name)`（`:245`，表 `SECTION_ORDERS` **未导出**）、`context()`（`:258`）、`tools()`（`:273`）、`variable()`（`:282`）、`assemble()`（`:292`）、`suppressRuntimeContext()`（`:265`）。
常量：**`PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`**（`:162`，order **0**）、**`PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"`**（`:164`，order **10200**，全表最后）；其余 `harness:identity=-1000`、`tool:subagent=2800`、`tool:structured_output=2900`（`lib/index.js:10-43`）。
瀑布：`'system-prompt/assemble'(assembly, context, next)`（`:27`，**scoped**）、`'system-prompt/change'()`（`:33`）。⚠️ `:19-22`：**某作用域若注册了 `complete:true` 段落，瀑布返回后该段被还原为唯一系统提示词，监听者的增删被丢弃**；多份 complete 同时生效装配抛错（`lib/index.js:335-336`）。

**内容存在哪里**：
- **全局 persona** = `dsh-system-prompt` 自己的 Config（`personaPrefix`/`personaSuffix`，`lib/types/index.d.ts:168-189`），构造函数**无条件**注册为上述两个 section（`lib/index.js:201-229`），**默认空串**（`:204-205`），无默认文案、无磁盘文件；shipped 值 `R/dsh-base/cordis.patch.yml:503-506`（`personaPrefix: ''`）。真实覆写例：`~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml:19-35`（源码 `You are a coding agent.`）。
- **作用域/preset persona** = `dsh-persona` 行 `{prefix(必填), suffix, complete, includeRuntimeContext}`（`R/dsh-persona/lib/index.js:23-28`），注册**同名** section（`:36-47`）；其注释 `:7-15` 是权威说明「this row is **scope-only**… mounted inside an agent preset it shadows the deployment persona… mounted globally it collides and fails loud」。
- **instructions（AGENTS.md）不是 section**：`dsh-agent-instructions`/`dsh-time-context`/`dsh-tool-skill` 都往 inbox 注入 **user 角色消息**（`kind:"agent-instructions"` `R/dsh-agent-instructions/lib/index.js:1200-1209`；`kind:"skill-catalog"` `R/dsh-tool-skill/lib/index.js:256,280`）。文件链：`$DSH_HOME/AGENTS.md`（`:141,148,561`）→ 项目根（向上首个含 `.git` 目录 `:16,480-488`）→ `ancestorChain` 由宽到窄，每目录先 `AGENTS.md`/`CLAUDE.md` 再 `.local.md`（`:17-18,578`），同目录 trim 去重留最早（`:632-648`），`maxBytes` 必填、`maxSourceBytes` 默认 1MiB（`:19,29`）。**准热更新**：`agent/pre-step` 每轮按指纹重算（`:1124-1131,1271-1289`）+ read/write/edit 触碰 `file_path` 触发增量重扫（`:1087-1098,1290-1309`）；**不是 fs watch**，无触碰的外部改动要等下次操作。
- **动态 runtime context** 是另一 API `systemPrompt.context({name,order,text})`（`:258`），orders `SANDBOX_POLICY=110/APPROVAL_POLICY=115/SUBAGENT_DELEGATION=120`。

**第三方运行时替换 —— 能，且可做到「改内存即生效」**：
1. **同 id 注册=抛错，跨层同名=遮蔽（唯一正道）**：`NamedEntries.insert` 重名即 `throw`（`R/dsh-scope/lib/index.js:27-30`），文案（`R/dsh-system-prompt/lib/index.js:190`）「is already registered (**for a per-agent override, register through that agent's `agent.ctx` instead**)」；`ScopedLayers.merge` 先全局后 scope 链，最近 scope 胜（`R/dsh-scope/lib/index.js:177-181`）；常量注释（`:49-54`）「both sides naming the same section is what makes the replacement work rather than duplicate」。用法：`agent.ctx.systemPrompt.section({name: PERSONA_PREFIX_SECTION, order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: () => store.persona})`——`text` 为函数则**每次装配重算**（`lib/types/index.d.ts:56-60`）。
2. **`system-prompt/assemble` 瀑布**改 `assembly.sections/contexts/tools/variables`（`:15-27`），限制见上 ⚠️；注意 `installModelSelection` 也占此瀑布注入 `variables.provider/model`（`R/dsh-agent/lib/index.js:167-180`）。
3. **写配置 + HMR 重载**：`ctx.configEditor.edit(entry, change)`（推荐，`R/dsh-config-editor/lib/index.js:63-129`）原子写 profile patch → `reconcileProfilePatches` → `emit("app-boot/config-reload")`（`R/dsh-app-boot/lib/index.js:3483-3493`）→ cordis `fiber.update` 走 `restart()`「Dispose and immediately reload this plugin with its current config」（`cordis/lib/index.js:1405-1440`）→ 插件重挂载重注册 section。**无需重启进程**；裸写 `cordis.patch.yml` 也被 `dsh-hmr` watch（`R/dsh-hmr/lib/index.js:354`）。
4. ⚠️ **`ctx.settings` 目前写不进 persona/instructions**：`write()` 要求该 Config 有 volatile 字段，否则抛 `Plugin entry "<ns>" has no volatile fields`（`R/dsh-settings/lib/index.js:505-506`）并逐路径 `isVolatilePath` 校验（`:507,516`）；而 `dsh-system-prompt`（`lib/index.js:201-207`）与 `dsh-persona`（`lib/index.js:23-28`）**无任何 `.volatile()`**，`describe()` 会跳过无 volatile 表单的条目（`:417-419`）→ **UI 里也不出现**。settings 只适用于**你自己的插件 Config**（加 `.volatile()` → Web 端自动生成表单 `SettingsDescriptor.autoGenerate`，`R/dsh-settings/lib/types/index.d.ts:11`；`update/replace/mutate` `:102-114`）。
5. **生效时机 = 下一个 step**（同回合后续 step 也算），**无进程/会话级缓存**：`turn()` 的 `while(true)` 每轮 `preStep()`（`R/dsh-agent-loop/lib/index.js:951-957`）内 `systemPrompt.assemble()`（`:907`），`step()` 内 `renderPrompt(assembly)`（`:1032`）；提交侧 `SystemPromptProjection.project` 内容相同则 `return []`，变了才 head replace 或 in-history 追加（`:264-282`；DeepSeek 声明 `systemPromptUpdate:"in-history"`，`R/dsh-llm-deepseek/lib/index.js:47,306,1574`）。
6. **第三方拿 per-agent ctx 的公开钩子**：`'agent/created'`（serial，`payload.agent` 带 `.ctx`，且「Listeners run in order and are awaited before creation resolves」，`R/dsh-agent/lib/types/runtime-types.d.ts:216-231`；`Agent.ctx` 公开只读 `:148-149`）：`ctx.on('agent/created', ({agent}) => { agent.ctx.systemPrompt.section({…}); installModelSelection(agent.ctx, ref); })`。
7. **现无任何提示词编辑 UI**：`dsh-client-ui-settings-general`/`-settings-agent-loop`/`-agent-preset` 三包全文检索 `persona|systemPrompt|system-prompt|instructions` **零命中**。

## 4. 默认模型与按角色路由（Q4）

**默认模型**：服务 `ctx.agentDefaultModel`（`R/dsh-agent-default-model/lib/types/index.d.ts:24`）→ `currentSelection(): ModelSelection`（`:42`）、`saveSelection(next): Promise<void>`（`:50`）；Config 三字段全 volatile（`:12-19`），**每次直接 `.get()`，无缓存**。落盘 = `configEditor.edit` → profile `cordis.patch.yml`（实现 `lib/index.js:53-66`；本机实证 `~/.dsh/profiles/web/cordis.patch.yml:539-544`）。**任何拿到 `ctx` 的插件都能改**；**对已存在会话不追溯**（创建时快照 `R/dsh-api-session-controller/lib/types/agent.js:513-516`，已有 header 的会话沿用日志路由 `:312-325`）。会话级切换（优先级更高、可 mid-session）：`ApiSessionAgentController.selectForNextRequest(agent, selection)`（`lib/types/agent.d.ts:107`，实现 `lib/index.js:319-322`）→ 追加 `model/selection` 事件（`lib/types/types.d.ts:35`）。

**既有扩展点（4 条）**：
1. **`agent/request` waterfall（最强，逐次请求）**：`R/dsh-agent/lib/types/runtime-types.d.ts:311-332`，payload `{agent,turn,step,signal}`，`next(): Promise<LlmCallConfig>`，**返回值即替换冻结的调用配置**；`LlmCallConfig = {provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}`（`R/dsh-llm/lib/types/call-config.d.ts:16-23`，与 `GenerateOptions` **1:1**）。种子/派发 `R/dsh-agent-loop/lib/index.js:1148-1184`（有 header 用 `requestProposal(persistedHeader)`，否则 `AgentOptions`），派发点 `:1164`。
   **时序（关键）**：该瀑布在 `step()` 的 `while(true)` **内部**（`:1034-1035`），**每次尝试都重跑**（含重试）；`agent/pre-step` 在 `preStep()` 里 **assemble 之后**（`:902-921`）→ 「轮次开始分级」= 在 `agent/pre-step` 读 `payload.messages` 定档并暂存，在 `agent/request` 按档返回替换配置；**同 step 内 pre-step 先于 request，链路成立**。
2. **`installModelSelection(agentCtx, {current, assembled})`**（导出 `dsh-agent`，`lib/types/model-selection.d.ts:16-49`；实现 `lib/index.js:166-210`）：挂 3 个监听——`system-prompt/assemble`（向 `variables` 注入 `{provider,model}`）、`agent/request`（覆盖 provider/model/effort 并**清掉继承 effort**）、`agent/pre-step`（`{prepend:true}` 追加**持久** user 消息 `[model changed: …]`，`:133-147`）。消费者 `R/dsh-api-session-controller/lib/index.js:288-312`、`R/dsh-headless/lib/index.js:308`、`R/dsh-acp/lib/index.js:346`。⚠️ `assembled` 在 assemble 时快照，而 assemble 早于 `agent/pre-step` → 在 pre-step 改 `selection.current` 只对**下一个 step** 生效。
3. **preset 内子插件实例配置**：`tool-subagent` 行 `agentOptions{provider,model,reasoningEffort,maxTokens}`（`R/dsh-tool-subagent/lib/types/index.d.ts:45`；合并「工具参数 > 实例 configured > 父 Agent」`lib/index.js:62-81`）——**preset 影响模型的唯一路径**。
4. **`ctx.llm.registerAdapter(providers, adapter): AdapterRegistrationHandle`**（`R/dsh-llm/lib/types/index.d.ts:253`）：多 provider 共存；任一 provider 已有适配器整体抛 `DUPLICATE_ADAPTER`（`:246-247`）；handle = disposer + `.replace(providers)` 原子换路由（`:193-211`，空数组合法）；未挂载也可配置的路由目录 `registerConfigurableProviders()`（`:281`）。

**优先级与「粘性」坑**：`agent/request` 返回值 > 会话 `model/selection` > 已记录 header > `agentDefaultModel.currentSelection()`。`prepareRequest` 下次用 `requestProposal(persistedHeader)` 作种子（`R/dsh-agent-loop/lib/index.js:1159`），而配置变更会被记成新 `request/header` 快照（`call-config.d.ts:1-6`「logs changed snapshots instead of allowing silent per-call drift」）→ **改一次路由它就成为后续 step 的新基线，必须每 step 重新断言策略**。

## 5. 回退链：重试与 failover（Q5）

**机制**：`agent/request-error` waterfall（`R/dsh-agent/lib/types/runtime-types.d.ts:333-356`）payload `{agent,turn,step,provider,failure:LlmFailure,retryPolicy,signal}`，动作联合**只有** `RequestErrorAction = {kind:'retry'} | undefined`（`:100-103`）——**没有「换模型」动作**。loop：`if (action?.kind !== "retry") throw new LlmError(...); continue;`（`R/dsh-agent-loop/lib/index.js:1101-1120`）。
**对轮次的影响**：重试完全在 `step()` 的 `while(true)` 内（`:1034`；turn/step 在 `:1029` 解构后不递增）；**不新开 turn/step、不重跑 `agent/pre-step`、不重复写 user 消息**（`firstAttempt` 守卫 `:1046-1047`）；失败尝试只落 `assistant/attempt`（`:1104`），成功才落 `assistant/message`（`:1129`）→ **不消耗也不回滚对话轮次**。每轮都重跑 `prepareRequest` → `agent/request` 也重跑（`:1164`，正是 failover 的挂点）。直接 `ctx.llm.stream()` 的插件调用**永远单次尝试，没有重试**（`R/dsh-llm-retry/README.md:32,132`）。
**配置**：`dsh-llm-retry` 是函数插件，`inject=["agents","sessionProjections"]`，**自身 Config 为空**且显式拒绝 `retryPolicy` 键（`R/dsh-llm-retry/lib/index.js:21-28`），唯一挂载点 `ctx.on("agent/request-error", …)`（`:175`）；**没有 `LlmRetry` 服务、不装饰 `ctx.llm.stream`**。`retryPolicy` 属**各 provider 的 Config**：`R/dsh-llm-deepseek/lib/types/config.d.ts:44`（注释「omission uses normal mode with five retries」`:43`）、`dsh-llm-deepseek-api-key`（`:32`）、`dsh-llm-deepseek-account`（`:23`）、pi-ai 在**每个 provider profile 内**（`R/dsh-llm-pi-ai/lib/types/config.d.ts:144,163`）；注册时冻结 `resolveRetryPolicy(config.retryPolicy, "llm-deepseek: retryPolicy")`（`R/dsh-llm-deepseek/lib/index.js:446`），经 `providerRetryPolicy(provider)` 暴露（`:2083`；契约 `R/dsh-llm/lib/types/index.d.ts:142`，读取 `:323`）。**无任何 retry UI**。
**类型/默认**（`R/dsh-llm/lib/types/retry-policy.d.ts:11-38`）：`mode:'normal'` + `maxRetries?`（默认 **5**）+ `retryableCodes?` + `backoff{initialDelayMs=500, maxDelayMs=10000, jitterRatio=0.1}`；或 `mode:'always'`。**默认重试码** `[EMPTY_RESPONSE,'RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`（`R/dsh-llm/lib/types/retry-policy.js:12-22`）。退避=**有界指数 + 对称抖动**（`R/dsh-llm-retry/lib/index.js:44-49`）；provider 的 `failure.providerRetryAfterMs` 有效且 `<=maxDelayMs` 时直接采用（`:168-171`）；normal 模式码不匹配或 `previousRetry>=maxRetries` 交还下游（`:160,164`）。**没有 `retryable` 布尔标记**：`LlmFailure = {message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`（`R/dsh-llm/lib/types/types.d.ts:26-44`），可重试性全看 code 是否在集合内；码分类在适配器侧（deepseek 429→`RATE_LIMIT`，`status>=500`/`api_error`/`overloaded_error`→`SERVER`，401/403→`AUTH`，402→`QUOTA`，400/413→`INVALID_REQUEST`，`R/dsh-llm-deepseek/lib/index.js:1744-1751`；`TIMEOUT`/`TRANSPORT` `:2124,2127`）。**持久化**：等待前 `session.append("llm/retry", …)`（`R/dsh-llm-retry/lib/index.js:141`），等待后 `"llm/retry-started"`（`:143`），负载 `{retryId,turn,step,provider,mode,policyKey,retry,maxRetries,delayMs,failure}`（`lib/types/types.d.ts:13-41`），计数经 projection 键 `"llmRetry"` 折叠（`:88-91`）——可据此审计/计费。

**「主模型失败→自动换备模型」：不存在。** 全树 grep `failover|backupModel|fallbackModel|modelChain|alternativeProviders|primaryFailed` 唯一命中是无关的前端 SQL 语法高亮文件（`R/dsh-web-frontend/dist/assets/langs/sql-CRqJ_cUM.js:1`）；干扰项 `dsh-compaction-basic` 的 "fallback model" 只是摘要目标顺序（`configured ?? latest header ?? agent options`，`R/dsh-compaction-basic/lib/index.js:294-303`）。**但缝已留好，可纯用公开 API 自研**：
```js
ctx.on('agent/request-error', (p, next) => {          // 1) 按 (agent,turn,step) 计数
  const n = bump(`${p.agent.id}:${p.turn}:${p.step}`);
  if (n <= MAX_FAILOVER && RETRYABLE.has(p.failure.code)) return {kind:'retry'};
  return next(); });
ctx.on('agent/request', async (p, next) => {           // 2) 重跑时换到备用路由
  const base = await next(); const r = routeFor(p.agent, p.turn, p.step);
  return r ? {...base, provider:r.provider, model:r.model,
              ...(r.reasoningEffort ? {reasoningEffort:r.reasoningEffort} : {})} : base; });
```
风险：`agent/request` 是 waterfall，多监听者结果叠加；`LlmCallConfig` 无 attempt 字段，须自行按 `(agent,turn,step)` 计数并在 step 前进时清理；换路由会被记成新 header → 后续步骤沿用（§4 粘性）。

## 6. 推理强度 reasoningEffort（Q6）

- **不是固定枚举**：`ReasoningEffortId = Branded<'ReasoningEffortId'>` 不透明字符串，构造器不校验（`R/dsh-llm/lib/types/brand.d.ts:48-55`）。
- **由 adapter 按精确 provider/model 声明**：`LlmModelReasoningInfo {efforts: LlmReasoningEffortInfo[], defaultEffort?}`（`R/dsh-llm/lib/types/types.d.ts:350-358`；`{id,name,description?}` `:341-348`），经 `LlmResolvedModelInfo.reasoning?` 暴露（`:383`），查询 `ctx.llm.resolveModelInfo(provider,model,signal)`（`R/dsh-llm/lib/types/index.d.ts:360`）/`listModels(provider)`（`:350`）。
- **deepseek adapter** 声明 **`off`/`low`/`high`/`max`**（`R/dsh-llm-deepseek/lib/index.js:452-477`；`thinking:'disabled'` 时只给 `off`，`:517-519`）。解析（`:1689`）：`purpose==='session-title' ? 'off' : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (thinking==='disabled' ? 'off' : 'high')`；不合法抛 `UNSUPPORTED_REASONING_EFFORT`（`:1695`）；线上序列化为 `thinking:{type:'disabled'|'enabled'}` + 非 off 时 `output_config:{effort}`（`:1702-1703`）——**不是 OpenAI 的 `reasoning_effort`**。
- **pi-ai adapter（第三方 provider）**：档位常量 `off/minimal/low/medium/high/xhigh/max`（`R/dsh-llm-pi-ai/lib/index.js:296-305`），逐模型用配置 `reasoningEfforts` 声明「档位→线上值」（`:547-578,997-1004`；`false`=非推理模型），解析 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`（`:1847`）。
- **两个字段都存在且 1:1**：`GenerateOptions.reasoningEffort`（`types.d.ts:493-494`）= `LlmCallConfig.reasoningEffort`（`call-config.d.ts:19`）= `AgentOptions.reasoningEffort`（`runtime-types.d.ts:27`）。`ctx.llm.resolveCallConfig()` 在 provider I/O 前拒绝不支持的显式 effort，**不 clamp、不别名**（`R/dsh-llm/lib/types/index.d.ts:364-374`）。
- 默认/持久：deepseek 插件配置 `reasoningEffort`（默认 `high`，`R/dsh-llm-deepseek/lib/types/config.d.ts:13-14`）；全局默认模型 `AgentDefaultModelConfig.reasoningEffort`（`R/dsh-agent-default-model/lib/types/index.d.ts:18`）；本机 profile patch `:544` `reasoningEffort: high`。
- **UI 位置**：**不在** settings-models（注释「Reasoning effort is deliberately absent」，`R/dsh-client-ui-settings-models/lib/types/client/ProviderEditor.d.ts:14`），而在输入框模型选择器的 Effort 子面板（选项来自 `model.reasoning.efforts`+`defaultEffort`，`R/dsh-client-ui-model-selection/lib/client.js:512-521`，提交 `select({provider,model,reasoningEffort})` `:686`）；`list_subagent_models` 也打印各档 id/name 并标 `(default)`（`R/dsh-tool-subagent/lib/index.js:164`）。

## 7. 一次性独立调用（Q7）

**`GenerateOptions` 全字段（只有 13 个）**（`R/dsh-llm/lib/types/types.d.ts:489-531`）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `provider` | string | ✅ | 已注册 adapter 路由 |
| `model` | string | ✅ | 精确模型 id |
| `reasoningEffort?` | `ReasoningEffortId` | | 该模型声明的档位；省略用 provider 默认 |
| `messages` | `RequestMessage[]` | ✅ | 完全装配的对话；loop 构造的请求把系统提示词放进首条 system-role 消息 |
| `system?` | string | | **一次性调用专用**：adapter 映射到 provider system 槽，置于 `messages` 之前 |
| `tools?` | `ToolSchema[]` | | 工具声明 |
| `toolHistory?` | `ToolHistory` | | 会话折叠的工具历史（路由投影用） |
| `temperature?`/`maxTokens?` | number | | 采样控制 |
| `stop?` | string[] | | 命中即停，停止串不含在输出中 |
| `signal?` | AbortSignal | | 取消；adapter 必须遵守 |
| `sessionId?` | `SessionId` | | loop 盖的**路由身份 + replay 游标**；只落传输层（deepseek 发 `x-deepseek-harness-session-id`，`R/dsh-llm-deepseek/lib/index.js:2196`）；**不写会话日志、不做 token 记账**；省略=头省略不报错，假值不校验 |
| `purpose?` | `'compaction'\|'session-title'` | | **仅这两个值**；分类标签：deepseek 对 `session-title` 强制 `effort='off'`（`:1689`），`compaction` 加 `x-deepseek-harness-compact: 1`（`:2197`）；**不参与计费**；pi-ai **完全不消费** |

**没有** `stream`/`metadata`/attribution 字段（attribution 是 adapter 每请求必带的固定头 `attributionHeaders()`，`R/dsh-llm/lib/types/attribution.d.ts:30,46`；契约 `lib/types/index.d.ts:126-128`）。`RequestMessage = Message | RequestUserInput`（`:475`）；一次性输入可用无身份无 source 的 `RequestUserInput`（`:468-473`），持久 `Message` 必须带 `source`（`createUserMessage()`，`lib/types/message.d.ts:132,213`）。
**调用与返回**：服务名 `"llm"`（`super(ctx,"llm")`，`R/dsh-llm/lib/index.js:1801`），插件用 `ctx.llm`。`ctx.llm.stream(options): AsyncIterable<StreamChunk>`（`R/dsh-llm/lib/types/index.d.ts:412`）——**返回异步可迭代对象，不是 Promise**。`StreamChunk`（`types.d.ts:417-447`）= `block-start|text-delta|reasoning-delta|tool-call-delta|block-end|usage|finish`，**必然以终态 `finish` 收尾**（adapter 抛错归一为终态 `error`/`aborted`）；可被进程级瀑布 `'llm/stream'` 包裹（`:33-45`）；**loop 构造的请求 deep-frozen 且带 `markAgentLoopRequest` 标记，监听者只能读不能改**。
**无非流式 helper**（无 `complete`/`generate`），装配用 `BlockAssembler`：`push(chunk)` → `blocks()`/`message(source)`/`usage`/`finish`/`interruptedBlocks()`（`R/dsh-llm/lib/types/assembler.d.ts:22-74`）。需要「校验+一次派发绑定」用 `ctx.llm.prepareCall(config, signal?)` → `PreparedLlmCall{config, retryPolicy, context, inputModalities, adapterDefaults, stream(options)}`（`index.d.ts:93-116,386`）。
**真实范例照抄**：`R/dsh-session-title-llm/lib/index.js:206-229`（`{provider,model,messages,system,maxTokens,sessionId,purpose:'session-title',signal}` → `for await (const c of ctx.llm.stream(o)) asm.push(c)`）；`R/dsh-compaction-basic/lib/index.js:312-336`（`purpose:'compaction'`，含 tools/toolHistory）。

## 8. UNCERTAIN

1. **preset 内嵌套 `plugins[]` 行是否各自成为可寻址 settings 命名空间**：`describe()` 只遍历 `entry.parent.tree.ctx.fiber.entry?.id === "include"` 的行（`R/dsh-settings/lib/index.js:415` 经 `configEditor.entries()`，`R/dsh-config-editor/lib/index.js:30-35`）；`standard.patch.yml:2-3` 注释称「Edits saved from the Web editor override this row's `config.plugins` by id from the profile patch」，但**未找到 ns 与 `SettingsPathOp.path` 如何寻址到 `plugins[i].config.*` 的代码证据**。
2. `configEditor.edit(entry, change)` 对 preset 内子行的可用性未实测（同 1）。
3. **多监听者叠加顺序**：自研 `agent/request` 监听与 `installModelSelection` 共存时谁后跑（决定最终 provider/model）未验证。
4. `select()` 开场判定（`turnBoundary`）与 fork/resume 会话行为未逐路径验证。
5. **pi-ai 是否把 `purpose` 映射到内部生成策略**：包内 grep 零命中，判定不消费，但未展开依赖 `@earendil-works/pi-ai`。
6. **`sessionId` 在 DeepSeek 服务端是否有语义**（限流/缓存/审计）：包内无服务端代码。
7. `SECTION_ORDERS` 与各注册点的对齐是交叉验证（各包 `getSectionOrder("NAME")`+order 值），**未运行时实测**；`prepareRequest` 是否存在跳过 assemble 的极端分支亦未逐分支确认。
8. 本机 `web` profile 实际生效的 provider 全集未穷举（bundle 层在 `dsh-base`/`dsh-web-app` 内，patch 只到 544 行）。

## 9. 给实现者的最小可行方案

### (a) 轮次开始按规则给 L1/L2/L3 选模型
**现成**：`agent/pre-step`（读本轮 messages）+ `agent/request`（替换整份 `LlmCallConfig`）+ `'agent/created'`（拿 per-agent ctx）。**自研**：分级函数与档位表。
```js
ctx.on('agent/created', ({agent}) => {                    // runtime-types.d.ts:216-231
  const tier = new Map();
  agent.ctx.on('agent/pre-step', async (p, next) => {      // p.messages = 本轮 claim 的用户消息
    const t = p.messages.flatMap(m=>m.content).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    tier.set(`${p.turn}:${p.step}`, classify(t)); return next(); });
  agent.ctx.on('agent/request', async (p, next) => {
    const base = await next(); const r = ROUTES[tier.get(`${p.turn}:${p.step}`) ?? 'L2'];
    return r ? {...base, provider:r.provider, model:r.model,
                ...(r.reasoningEffort ? {reasoningEffort:r.reasoningEffort} : {})} : base; }); });
```
坑位：①**每 step 必须重新断言**（改过的路由会成为新 header 基线，§4）；②想在提示词里用 `{{model}}` 变量得走 `installModelSelection`（注入 `assembly.variables`），但 assemble 早于 `agent/pre-step` → **只对下一个 step 生效**；③某 preset 用了 `complete:true` persona 时 `system-prompt/assemble` 上的改动会被丢弃（§3），但 `agent/request` 不受影响；④`installModelSelection` 会把换路由写成持久 user 通知（`[model changed: …]`），不需要就自己写监听。

### (b) 给子代理分配便宜模型
1. **改 preset 内 `tool-subagent` 行实例默认**（零代码，改 YAML）：`config: { provider: spawn, toolName: subagent, backgroundMode: continuable, agentOptions: { provider: <便宜provider>, model: <便宜model>, reasoningEffort: low } }`——证据 `R/dsh-tool-subagent/lib/types/index.d.ts:45` + 合并序 `lib/index.js:62-81`。
2. **让模型自己选**（零代码）：`modelSelectionSettings: true` + 会话 route 白名单（`subagentModelSelection` / Web 设置页 `subagent-model-selection-settings`），模型可传 `provider`/`model`/`reasoning_effort`，先用 `list_subagent_models` 查目录；**只对新建会话生效**。
3. **程序化控制**（少量自研，最灵活）：`ctx.subagents.start('spawn', {prompt, parent, signal, agentOptions:{provider,model,reasoningEffort}})`（范式 `R/dsh-workflow-ptc/lib/index.js:328-340`），校验用 `preflightChildLlmRoute`（`R/dsh-tool-subagent/lib/types/model-selection.d.ts:80`）。
⚠️ `provider`/`model` 必须成对；改路由不写 effort 会清掉继承 effort（`child-agent.d.ts:42-52`）。

### (c) Web 后台编辑系统提示词 + 风格提示词并热生效
**推荐架构：内存 store 为真源（函数型 section）+ 插件自有 volatile Config 做持久层 + Config 变更时同步 store。**
1. **风格提示词 → persona suffix（order 10200，排最后）**：在 `agent.ctx` 注册**同名** section 遮蔽：
   `agent.ctx.systemPrompt.section({ name: PERSONA_SUFFIX_SECTION, order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: () => store.style })`——`text` 为函数则**每次装配重算，改内存立即生效**（`lib/types/index.d.ts:56-60`），**这是唯一「保存即生效、无需重载」的路径**。系统提示词主体同理遮蔽 `PERSONA_PREFIX_SECTION`；要「整段替换」加 `complete:true`（⚠️ 会废掉该作用域 `system-prompt/assemble` 的后续修改能力，且同 scope 只能一个生效 complete）。
2. **持久化 + 表单 UI（全现成）**：插件自己声明 `static Config`，字段加 `.volatile()`（`volatileForm` 规则 `R/dsh-settings/lib/index.js:118-126`；无 volatile 字段则抛 `has no volatile fields` 且 UI 不出现该条目 `:505-507,417-419`）→ Web 设置页**自动生成表单**（`SettingsDescriptor.autoGenerate`，`lib/types/index.d.ts:11`）→ 保存走 `ctx.settings.update(ns, patch, revision)`/`mutate(ns, ops)`（`:102-114`），落 profile `cordis.patch.yml` 并 HMR 重载。**关键：Config 当持久层，在变更事件里 `store.style = cfg.style`** → 下一轮 assemble 立即用新值（§3-5：生效=下一个 step），既持久又不依赖 Loader 重启插件。
3. **项目/用户级提示词零开发复用**：`$DSH_HOME/AGENTS.md` + 项目 `AGENTS.md`/`CLAUDE.md`/`.local.md`，`dsh-agent-instructions` 每轮按指纹重读（`R/dsh-agent-instructions/lib/index.js:17-18,141-148,1124-1131`）——用户可直接用文本编辑器改，原生准热生效；Web 端只需一个文件读写接口。
4. **不要走的路**：`ctx.settings.update('system-prompt',{personaPrefix})` —— 该 Config **无 volatile 字段，会抛错且 UI 不显示**（§3-4）；也别指望现成 UI（三包全文检索零命中，§3-7）。

**必须自研**：L1/L2/L3 分级规则与档位表；跨模型 failover（`agent/request-error` 计数 + `agent/request` 换路由）；Web 端提示词编辑器；提示词版本/回滚/多套风格管理。
**不要碰**：preset 的 model 字段（不存在，用子插件行）；`~/.dsh/.agent-presets/`（已废弃，官方不读）；改 DSH 源码（以上需求全部有公开扩展点）。
