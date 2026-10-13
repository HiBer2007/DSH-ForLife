# Agent Preset 与默认模型路由（源码实证）

基线：所有 `@deepseek-ai/dsh-*` = 0.1.7-rc.2，Node v24.19.0。
`R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（以下路径均相对 `R`）。

## Q2 AGENT PRESET

### 1) 一个 preset 能定义什么：只有 5 个字段，没有 model/persona/tools/sandbox 字段
接口 `PresetDefinition`，`dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`：
- `id: string`（L5，readonly，必填）
- `name?: string`（L6 显示名）
- `description?: string`（L7 一句话描述）
- `order?: number`（L8 花名册排序）
- `plugins: readonly (Omit<EntryOptions,'id'|'disabled'> & { id?: string; disabled?: EntryOptions['disabled'] | JsExpr })[]`（L9-12，子 Cordis 插件入口列表，唯一能力载体）

运行期 schema 完全一致：`dsh-agent-preset/lib/index.js:13-19` `Config = z.object({ id: z.string().required(), name, description, order, plugins: z.array(z.any()).required() })`（:18 `plugins` required）；类型别名 `dsh-agent-preset/lib/types/index.d.ts:5-7` `import type { PresetDefinition } ... export type Config = PresetDefinition`。
只读投影多一个诊断字段 `broken?: string`：`dsh-agent-preset-registry/lib/types/preset.d.ts:4-10`（`AgentPreset`）。
组合清单把 `plugins` 压平成行：`lib/types/composition-inventory.d.ts:17-31`（`entryId`/`moduleName`/`enabled`/`condition`/`fiberState`）。
**结论**：model / provider / reasoningEffort / system prompt / instructions / persona / 工具集 / 权限 / sandbox / skills / subagent 策略 / compaction / workspace 全都不是 preset 字段，只能通过 `plugins` 里的子插件行表达。实证：官方 `standard` preset 用子行声明 persona（`dsh-web-app/presets/standard.patch.yml:11-15` `@deepseek-ai/dsh-persona`）、工具（:20-37 tool-bash/tool-pwsh/tool-fs/skill-filesystem）、plan-mode 组（:42-62）、compaction 组（:63-79）、delegation/subagent 组（:80-130 `@deepseek-ai/dsh-tool-subagent`）。子插件可用 `disabled: !!js ...` 条件表达式（:22,25）。

### 2) 磁盘格式与位置：Cordis YAML patch 行，不在专用 preset 目录
- 官方 preset = bundle 内的 patch 文件 `presets/<id>.patch.yml`，内容为 `- insert:` 下的 `@deepseek-ai/dsh-agent-preset` 声明行。声明处 `dsh-web-app/presets/standard.patch.yml:4-10`（`- insert: / - id: preset-standard / name: '@deepseek-ai/dsh-agent-preset' / config: {id: standard, order: 1, plugins: [...]}`）；同构文件 `ptc.patch.yml:4-9`、`minimal.patch.yml:4-9`、`cordis.patch.yml:4-9`。
- 装载顺序由 bundle 声明：`dsh-web-app/package.json:43-48` `"dsh": { "patch": ["./cordis.patch.yml","./presets/standard.patch.yml",...] }`。
- 用户层唯一可写位置 = profile 的 `cordis.patch.yml`：`dsh-app-boot/lib/index.js:487` `const PROFILE_PATCH_FILENAME = "cordis.patch.yml"`；:466-469 文档「A profile is a directory under `$DSH_HOME/profiles/<name>` ... and a `cordis.patch.yml`（the user's own patch layer, applied after every bundle layer）」；:524-527 `resolveProfileDir` = `join(home, PROFILES_DIR, name)`。Web 编辑器覆盖即写此文件（`standard.patch.yml:2-3` 注释「Edits saved from the Web editor override this row's `config.plugins` by id from the profile patch」）。
- **没有** `~/.dsh/.agent-presets/` 之类的现行路径：全 dsh 树 grep `\.agent-presets` 在 `*.js` 中 0 命中（仅 `dsh-agent-preset-registry/lib/invariant.js:803` 的 invariant 名 `agent-presets-invariant`）；`dsh-home-paths/lib/index.js:11` 只有 `DSH_HOME_DIR_NAME = ".dsh"`、:82 `dshHomePath(...segments)`，无 preset 段。注册表明确不扫目录：`dsh-agent-preset-registry/README.md:46`「Definitions are ordinary plugin rows; the registry neither scans directories nor accepts preset paths.」
- 历史格式（已废弃，YAML 而非 markdown-frontmatter）：`dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:70`「Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` (display `name`, `description`, `order`) and `agent.cordis.yml` (the plugin entry list). **Nothing reads that directory any more.**」本机残留实证：`C:\Users\HiBer2007\.dsh\.agent-presets\liangshen\preset.yml:1-3`（仅 `name`/`description`/`order`，无 plugins）、同目录 `agent.cordis.yml:57-60`（插件入口列表 `- id: tool-bootstrap / name: ./tool-bootstrap.mjs / config:`）、`.dsh-tui-managed.json:1-5`（owner `@deepseek-harness-tui/dsh-tui`，非官方包）。
- 新建 preset 的官方做法 = 第三方 bundle 两文件（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`），`SKILL.md:20-52`；覆盖已发布 preset 用 Loader 行 id 覆写而非插入，`SKILL.md:54-66`（「The override replaces the complete `config`, so restate `id`, `plugins` and every other field」）。

### 3) 第三方插件可在运行时注册；可移除但不可就地改
- 服务名：`ctx.agentPresets`（`dsh-agent-preset-registry/lib/types/index.d.ts:15-19` `interface Context { agentPresets: AgentPresetRegistry }`；实现 `lib/index.js:481` `super(ctx, "agentPresets")`）。
- 注册签名：`register(definition: PresetDefinition): Promise<() => Promise<void>>`（`lib/types/index.d.ts:39-43`；实现 `lib/index.js:500-524`）。重复 id 抛错：`lib/index.js:503`「Duplicate agent preset」。返回值是 disposer（`lib/index.js:511-520` 删除定义并 retire generation），即**可移除**。插件用它：`dsh-agent-preset/lib/index.js:24-26` `async *[Service.init]() { yield await this.ctx.agentPresets.register(this.config) }`，`static inject = ["agentPresets"]`（:10）。
- **无** `define`/`upsert`/`patch` 方法；`readDocument()` 注释明示只读（`lib/types/index.d.ts:71-75`「for viewing only」；实现 `lib/index.js:620-638` 用 js-yaml `dump`）；覆盖只能改 Loader 行 config（`SKILL.md:56`）。
- 其余公开方法（`lib/types/index.d.ts`）：`get defaultId` :39、`list()` :61、`remoteExportList()` :65、`resolve(id?)` :70、`mount(ctx,id?)` :84、`composeFrom(ctx,parent)` :90、`composedPreset(ctx)` :95、`serviceFor(agent,name)` :101、`recompose(ctx,id)` :109、`select(agent,agentPreset)` :115、`acquireScope(id?)` :120、`compositionInventory()` :126。
- 默认 preset：`get defaultId() { return this.config.selectedDefault.get() ?? this.config.default }`（`lib/index.js:493-495`）；`Config` = `{default: z.string().required(), selectedDefault: z.string().volatile()}`（:471-474；类型 `lib/types/preset.d.ts:12-17`）。`selectedDefault` 属设置命名空间 `agent-preset-registry`，客户端写：`dsh-client-ui-agent-preset/lib/client.js:1068` `const AGENT_PRESET_SETTINGS_NS = "agent-preset-registry"` → :1080 `ctx.remote.settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: id }, void 0)`。
- 与会话绑定：创建 header 带 `agentPreset`，投影 `agentPreset` 由 header 初始化（`lib/types/session.d.ts:31-41`；实现 `lib/index.js:48-58` `init: (header) => header.agentPreset ?? null`）；创建 Agent 时写入 meta（`dsh-api-session-controller/lib/types/agent.js:505-511` `meta: { cwd, ...agentPreset: composition.agentPreset }`）。
- **只能空白会话改，开场后锁死**：`select()` 先读 `turnBoundary`，已开始则抛 `agent-preset/locked`（`lib/index.js:754-763`；错误细节 `lib/types/types.d.ts:46-50`），通过后 `agent.session.append("agent-preset/selected", { agentPreset: preset.id })`（:761）并广播 Cordis 事件 `'agent-preset/selected'(sessionId, agentPreset)`（`lib/types/types.d.ts:63-72`；转发处 `lib/index.js:488-490`）。客户端调用点 `dsh-client-ui-agent-preset/lib/client.js:1383` `ctx.remote.agentPresets.select(session.id, staged)`；语义「首个 turn 及以后都跑新组合」见 `lib/types/session.d.ts:1-15`。

### 4) 捆绑 skills 不是 preset 内容，是随包发行的 skill 文件
`dsh-agent-preset/README.md:50`「The package also ships the `skills/` directory that creator mode mounts through `skill-filesystem`」；由 `cordis` preset 的行挂载（`dsh-web-app/presets/cordis.patch.yml:143-147` `skill-filesystem` + `customSkillDirs: [!!js ...resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')]`）。格式：`SKILL.md` YAML frontmatter `name`/`description`（`dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:1-4`），模板目录含 `cordis.patch.yml`+`package.json`（`skills/cordis-plugin-development/templates/mcp/`）。preset 自身内容仍是 `config.plugins`。

## Q4 默认模型与按角色路由

### 1) 存储：Volatile Config 引用 + 写入 profile patch（非 settings.yaml）
服务 `AgentDefaultModelConfig`（service 名 `agentDefaultModel`）：`dsh-agent-default-model/lib/index.js:27` `super(ownerContext, "agentDefaultModel")`，Config schema :21-25 `{ provider: z.string().required().volatile(), model: z.string().required().volatile(), reasoningEffort: z.string().volatile() }`（类型 `lib/types/index.d.ts:11-19`）。部署默认值：`dsh-base/cordis.patch.yml:82-86`（`id: agent-default-model`，`provider: deepseek-official`，`model: deepseek-flash`）。
写盘路径 = 当前 profile 的 `cordis.patch.yml`：`saveSelection()` 取 `this.ctx.get("configEditor")` 并 `editor.edit(entry, () => config)`（`lib/index.js:53-66`）；editor 的 `get documentPath() { return this.ownerContext.profileContext.patchPath }`（`dsh-config-editor/lib/index.js:24-26`）并 `await writeFileAtomic(path, String(document), { mode: 384 })`（:117），随后热重载 reconcile（:117-124）。路径拼接见 `dsh-app-boot/lib/index.js:487`、:524-527。
旧 `~/.dsh/settings.yaml` 已退役：`dsh-settings/lib/index.js:343-351` 将其重命名为 `${path}.imported`（:350-351）；本机残留 `C:\Users\HiBer2007\.dsh\settings.yaml.imported` 佐证。默认模型**不**走 settings 文件。

### 2) 读写 API：`ctx.agentDefaultModel`，实时读、异步落盘
- 读：`currentSelection(): ModelSelection`（`lib/types/index.d.ts:38-42`；实现 `lib/index.js:38-45` 每次直接 `this.config.provider.get()/model.get()/reasoningEffort.get()`，**无缓存**；`README.md:82`「a captured selection stays stable while later operations read updated Config references」）。
- 写：`saveSelection(next: ModelSelection): Promise<void>`（`lib/types/index.d.ts:43-50`；实现 `lib/index.js:53-66`，无 configEditor 时是 no-op：:56-57；写按提交顺序串行：:63-65）。写完即对后续读生效（Volatile 引用 + Loader 重载）；对**已存在**会话不追溯：消费方在创建 Agent 时快照 `agentOptions()` = `currentSelection()`（`dsh-api-session-controller/lib/types/agent.js:513-516`），已记录 request header 的会话沿用日志里的 provider/model（同文件 :312-325 `loggedHeader.config`；`dsh-agent-default-model/README.md:107` 同义）。
- 其它读点：`dsh-api-session-controller/lib/index.js:461`、目录默认值 `:500`、登录后初始化 `:2996`；`dsh-webhook/lib/index.js:89`；`dsh-headless/lib/index.js:296`。
- 会话级切换（优先级更高、可 mid-session）：`selectModel` → `resolveCallConfig` → `selectForNextRequest`（`dsh-api-session-controller/lib/types/commands.js:145-168`）→ 追加 `model/selection`（`lib/types/agent.js:349-352`）→ 投影 `modelSelection`（`lib/types/model-selection-projection.js:42-52`，事件在 :23-27）；后半段默认值也被后台保存（commands.js:165）。
- settings 服务是另一套（只用于配置表单写入）：`update(ns, patch, expectedRevision?)` / `replace` / `mutate(ns, ops, expected)`（`dsh-settings/lib/types/index.d.ts:96-114`）。

### 3) 按角色/子智能体分配模型的既有扩展点
- 子智能体工具实例级默认路由：`dsh-tool-subagent` Config `agentOptions: { provider, model, reasoningEffort, maxTokens }`（`dsh-tool-subagent/lib/index.js:258-263`）；合并函数 `requestedAgentOptions(parentOptions, configured, request, enabled)`（`lib/types/model-selection.d.ts:53`；实现 `lib/index.js:62-81`：请求参数 > 实例 configured > 父 Agent 值）。
- 用户策略开关：服务 `subagentModelSelection`，Config `{enabled, allowedModels: [{provider, model}]}`（`dsh-tool-subagent/lib/model-selection-settings.js:41-64`），随行挂载 `dsh-web-app/cordis.patch.yml:47-48` `'@deepseek-ai/dsh-tool-subagent/model-selection-settings'`；强制校验 `assertAllowedModelSelection`（`lib/types/model-selection.d.ts:63`；实现 `lib/index.js:91-98` 抛「not allowed for this Session」）；durable 策略事件 `subagent/model-selection-policy` 与投影 `subagentModelSelectionPolicy`（`lib/index.js:198-214`、追加 :232）。preset 里启用：`dsh-web-app/presets/standard.patch.yml:90-96` `modelSelectionSettings: true`。
- 事件（所有与模型路由相关）：
  - `'agent/request'`（waterfall，agent 作用域）payload `{ agent, turn, step, signal }`，`next(): Promise<LlmCallConfig>`，返回替换即「替换冻结的调用配置」，但「Model-visible content must use logged channels」：`dsh-agent/lib/types/runtime-types.d.ts:311-332`；派发点 `dsh-agent-loop/lib/index.js:1164` `await this.dispatch.waterfall("agent/request", {...})`。
  - `'agent/pre-step'`（waterfall）payload `{ agent, messages, turn, step, signal }` → `Promise<PreStepDecision>`：`runtime-types.d.ts:304-310`。
  - `'agent/request-error'`（waterfall）payload `{ agent, turn, step, provider, failure, retryPolicy, signal }`：`runtime-types.d.ts:348-356`。
  - `'llm/stream'`（waterfall，进程级）`dsh-llm/lib/index.js:2371` `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`；`'llm/adapters-updated'`（emit）`dsh-llm/lib/index.js:1806`。
  - 其余 agent-subject 事件清单（`agent/created`、`agent/disposed`、`agent/status`、`agent/error`、`agent/inbox/*`、`agent/assistant-stream`、`agent/turn-stopping`）见 `dsh-scope/lib/invariant.js:10-21`。
  - 每个 Agent 的静态路由字段：`AgentOptions { provider?, model?, reasoningEffort?, maxTokens? }`（`dsh-agent/lib/types/runtime-types.d.ts:21-29`），`Agent.options`（:139-141）。
- **不存在**「preset/registry 上的 model 字段」：`preset.d.ts:4-10`、`definition.d.ts:4-13` 均无；`dsh-agent-preset-registry` 也不发布模型相关事件（`lib/types/types.d.ts:62-73` 只声明 `agent-preset/selected`）。

### 4) 优先级（preset 不携带 model，故不参与）
实测链条：工具调用参数 > preset 内子插件实例配置 > 父 Agent 值（`dsh-tool-subagent/lib/index.js:62-81`，:63 `if (!hasDelegationModelRequest(request)) return configured;`）；主 Agent 侧：会话内 `model/selection`（`commands.js:145-168`）> 已记录 request header（`agent.js:312-325`）> `agentDefaultModel.currentSelection()`（`agent.js:314`、:513-516）；终极覆盖只有 `agent/request` waterfall 替换整个 `LlmCallConfig`（`runtime-types.d.ts:311-332`）。preset 对模型的唯一影响路径 = 其 `plugins` 里的 `dsh-tool-subagent` 行 `agentOptions`（`standard.patch.yml:90-96` 只开了 `modelSelectionSettings`，未设 provider/model）。

## UNCERTAIN
- 「preset 内挂 `dsh-agent-default-model` 以给该 preset 独立默认模型」这一用法未见任何官方 preset 或文档；理论上会成为 preset 隔离域内的第二个服务实例（服务泄漏会被拒：`dsh-agent-preset-registry/lib/types/mount.d.ts:29-39`、`lib/index.js:271-273`），而 host 侧消费方注入的是 host 实例（`dsh-api-session-controller/lib/index.js:2817` inject 列表含 `agentDefaultModel`），因此**无法确认**它能影响该 preset 的 Agent —— 需运行时实测。
- 未找到任何插件把 `agentDefaultModel.saveSelection` 暴露为远程 RPC 之外的「按角色」配置写入口；除 `selectModel` 后台保存（`commands.js:165`）与登录初始化（`lib/index.js:2996`）外，写默认值的调用点仅在 UI 侧，未逐一穷举客户端包。
- `.dsh/.agent-presets/liangshen/` 属第三方 `@deepseek-harness-tui/dsh-tui` 私有约定（`preset.yml`+`agent.cordis.yml`+`.dsh-tui-managed.json:2` owner 字段），官方包不读它。
