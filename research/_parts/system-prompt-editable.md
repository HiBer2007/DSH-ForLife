# Q3 系统提示词可编辑性（源码实证）

> 基线 `@deepseek-ai/dsh-*` = 0.1.7-rc.2 / Node v24.19.0。下文 `pkg/...:line` 全部相对真实包根
> `R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（`.dsh\profiles\...\@deepseek-ai\` 下是坏 junction，未使用）。

## (a) 组装：谁贡献哪一段

**唯一注册 API**：`SystemPrompt.section(section: PromptSection): () => void`（`dsh-system-prompt/lib/types/index.d.ts:239`；实现 `dsh-system-prompt/lib/index.js:240-243`）。
形状 `{ name; order; text: string | ((ctx: AssembleContext) => string); interpolate?; complete? }`（`dsh-system-prompt/lib/types/index.d.ts:47-70`）。
排序 = `a.order - b.order || 名字 code-unit 序`（`dsh-system-prompt/lib/index.js:98`，用于 `:334`）。`text` 是函数时**每次 assemble 求值**（`dsh-system-prompt/lib/index.js:342`）。
`SECTION_ORDERS` 表**未导出**（`dsh-system-prompt/lib/index.js:10-43`；`export` 列表 `:365` 无它），只能 `getSectionOrder(name)` 读（`:249-251`）。

**导出的 persona 常量（真名，非猜测）**：
- `PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`（`dsh-system-prompt/lib/index.js:55`）
- `PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"`（`dsh-system-prompt/lib/index.js:57`）
- `TOOL_ORDER_REST = "<unlisted-tools>"`（`dsh-system-prompt/lib/index.js:63`）

**按 order 升序的 section 全表**（order 值源 `dsh-system-prompt/lib/index.js:10-43`）：

| order | section name | 贡献者（file:line） |
|---|---|---|
| -1000 | `harness:identity` | `dsh-system-prompt/lib/index.js:216`，文本 `"You are an AI agent powered by DeepSeek Harness."`（`:218`） |
| 0 | `deployment:persona-prefix` | `dsh-system-prompt/lib/index.js:221`（text=`config.personaPrefix`，`:223`）；scoped 覆盖：`dsh-persona/lib/index.js:37`、`dsh-subagent/lib/index.js:518` |
| 500 | `plan:policy` | `dsh-plan-mode/lib/index.js:172`（scoped） |
| 600 | `team:policy` | `dsh-experimental-tool-agent-team/lib/index.js:238`（scoped） |
| 800 | `tools:ptc-only` | `dsh-tools/lib/index.js:2730`（order 名 `PTC_ONLY`，`:2731`） |
| 900 | `context:file-reference` | `dsh-file-reference-local/lib/index.js:344`（text 为函数，`:346`） |
| 1000 | `tool:bash` | `dsh-tool-bash/lib/index.js:378` |
| 1010 | `tool:pwsh` | `dsh-tool-pwsh/lib/index.js:349` |
| 1100/1200/1300 | `tool:read` / `tool:write` / `tool:edit` | `dsh-tool-fs/lib/index.js:257` / `:522` / `:670` |
| 1400/1500 | `tool:glob` / `tool:grep` | `dsh-tool-fs-search/lib/index.js:776` / `:1085` |
| 1600 | `tool:jobs` | `dsh-tool-jobs/lib/index.js:258` |
| 2000/2100 | `tool:web_search` / `tool:web_fetch` | `dsh-tool-web/lib/index.js:257` / `:732` |
| 2400 | `tool:goal` | `dsh-tool-goal/lib/index.js:260` |
| 2600 | `tool:<toolName>` | `dsh-tool-workflow/lib/index.js:264` |
| 2700 | `tool:ralph` | `dsh-tool-ralph/lib/index.js:296` |
| 2800 | `tool:subagent` | `dsh-tool-subagent/lib/index.js:577`（text 为函数，`:579`） |
| 2900 | `tool:structured_output` | `dsh-subagent-in-process-driver/lib/index.js:81`（工具名常量 `:21`，文案 `:27`） |
| 3100 | `mcp:<server>` / `mcp-resource-servers` | `dsh-mcp-client/lib/index.js:737`（`interpolate:false`，`:739`）/ `dsh-mcp-resources/lib/index.js:120` |
| 5000 | `tools:sdk` | `dsh-tools/lib/index.js:2747` |
| 9000 | `ui:deliverable-file-references` | `dsh-client-ui-deliverables/lib/index.js:265` |
| 10000 | `harness:source` | `dsh-app-boot/lib/index.js:4130`（常量 `:4110`） |
| 10100 | `web-runtime` | `dsh-web-app/lib/index.js:188` |
| 10200 | `deployment:persona-suffix` | `dsh-system-prompt/lib/index.js:226`；scoped：`dsh-persona/lib/index.js:43` |

**不在 section 里的贡献者**（重要，别找错地方）：`dsh-agent-instructions`（AGENTS.md）、`dsh-time-context`、`dsh-tool-skill` **都不注册 system-prompt section**，而是往 inbox 注入 **user 角色消息**：
`dsh-agent-instructions` `inject = ["sessionProjections"]`（`dsh-agent-instructions/lib/index.js:1073`），产出 `kind:"agent-instructions"` 的 user 消息（`:1200-1209`）；`dsh-time-context` 在 `agent/pre-step` 追加 `source.form:"snapshot"` 的 user 消息（`dsh-time-context/lib/index.js:215`、`:231-244`）；`dsh-tool-skill` 产出 `kind:"skill-catalog"`（`dsh-tool-skill/lib/index.js:256`、`:280`）。
**动态 runtime context** 是另一套 API：`systemPrompt.context({name,order,text})`（`dsh-system-prompt/lib/types/index.d.ts:258`），`CONTEXT_ORDERS` = SANDBOX_POLICY 110 / APPROVAL_POLICY 115 / SUBAGENT_DELEGATION 120（`dsh-system-prompt/lib/index.js:44-48`），实际注册者 `dsh-sandbox-policy/lib/index.js:123`、`dsh-user-approval/lib/index.js:81`、`dsh-subagent/lib/index.js:513`；由 `joinContextSections` 拼成前缀 `"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."`（`dsh-system-prompt/lib/index.js:132-136`）。

## (b) 内容实际存在哪里

**persona** = `dsh-system-prompt` 行自己的 **config 字段**，默认**空字符串**（不是硬编码默认文案）：
`personaPrefix: z.string().default("")`、`personaSuffix: z.string().default("")`（`dsh-system-prompt/lib/index.js:204-205`，Config 定义 `:201-207`）。无磁盘文件、无 settings 条目。
覆盖机制 = **profile patch 层 YAML 的 `- id: system-prompt` 行**。落盘路径：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`PROFILES_DIR="profiles"` `dsh-app-boot/lib/index.js:485`、`join(home,PROFILES_DIR,name)` `:526`、`PROFILE_PATCH_FILENAME="cordis.patch.yml"` `:487`、`patchPath` `:587`），另有 home 层 `$DSH_HOME/cordis.patch.yml`（`dsh-hmr/lib/index.js:354`）。本机 `DSH_HOME=C:\Users\HiBer2007\.dsh`。
真实在产例证：`C:\Users\HiBer2007\.dsh\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui\cordis.patch.yml:19-35` → `- id: system-prompt` + `config: !!js ... return { personaPrefix: persona }`，源码 `You are a coding agent.`（`:22`），并说明 0.1.3-alpha.2 起 `persona`→`personaPrefix`（`:15-18`）。同构行也在 `...\cc-tui\node_modules\dsh-cc-tui\cordis.patch.yml:16-18`（仍用旧键 `persona:`）。
agent preset 内可用 `dsh-persona` 行覆盖：`prefix`(必填)/`suffix`/`complete`/`includeRuntimeContext`（`dsh-persona/lib/index.js:23-28`），**只能挂在 agent scope**，全局挂载会与注册表自己的注册撞名而报错（`dsh-persona/lib/index.js:7-15`、`:36-41`）。

**agent-instructions（AGENTS.md）**：文件名与目录顺序固定如下，全部走 user 消息、**不进 system prompt**：
- 文件名默认 `["AGENTS.md","CLAUDE.md"]` + `["AGENTS.local.md","CLAUDE.local.md"]`（`dsh-agent-instructions/lib/index.js:17-18`）；可经 config 改（`lib/types/config.d.ts:21,26`）。
- 用户全局：`join(dshHome,"AGENTS.md")`（`lib/index.js:141`、`:561`），显示为 `~/.dsh/AGENTS.md` 或 `$DSH_HOME/AGENTS.md`（`:755-757`、`:148`）。
- 项目链：从 cwd 向上找第一个含 marker（默认 `[".git"]`，`:16`）的目录为 projectRoot（`findProjectRoot` `:480-488`），再 `ancestorChain(projectRoot,cwd)` 由宽到窄（`:495-508`、`:578`）；每个目录先 base 候选再 `.local` 候选（`:578`）。同目录内按 trim 后内容去重，保留最早者（`:632-648`）。
- 预算：`maxBytes` 必填、`maxSourceBytes` 默认 1048576（`:19`、`:29`）。
- **会重读（准热更新）**：基线在 `agent/pre-step` 组装（`:1271-1289`），当身份指纹变化时重载（`workspaceBaselineIdentity` `:40-49`、判定 `:1124-1131`）；`tools/result` 里对 `read/write/edit` 的 `file_path` 触发增量重扫（`:1087-1098`、`:1290-1309`），`step/end` 提交（`:1264-1270`）。内容指纹 = SHA-1（`:90-92`）、trim 指纹（`:101-103`）。**注意不是文件系统 watch**：无 fs 工具触碰、无 resume 时，外部改动要等下次操作才可见（`dsh-agent-instructions/README.md:12`）。

## (c) 第三方插件能否在运行时替换/编辑

**(1) 同 id 注册 = 直接抛错，不会 replace/append。**
`section()` 落到 `NamedEntries.insert`：`if (data.has(name)) throw this.duplicateError(name)`（`dsh-scope/lib/index.js:27-30`）。错误文案由 system-prompt 构造：全局层为 ``prompt section "${name}" is already registered (for a per-agent override, register through that agent's `agent.ctx` instead)``，scoped 层为 ``prompt section "${name}" is already registered in this scope``（`dsh-system-prompt/lib/index.js:190`）。所以全局插件注册 `deployment:persona-prefix` 会在 apply 期直接失败。
**但跨层同名是"遮蔽"而非重复**：`ScopedLayers.merge` 先铺全局再按 scope 链覆盖，`merged.set(name, value)`，最近 scope 胜（`dsh-scope/lib/index.js:177-181`）。这正是 preset/子代理替换 persona 的官方机制（`dsh-persona/lib/index.js:8-11`）。
多份 `complete: true` 同时生效 → 组装抛错：`multiple complete prompt sections are active: ...`（`dsh-system-prompt/lib/index.js:335-336`）。

**(2) settings 服务目前写不进 persona/instructions。**
`settings` = `SettingsForms`（`dsh-settings/lib/types/index.d.ts:62`），写入口 `update/replace/mutate`（`:102,108,114`）最终走 `write()`，而 `write()` 要求该插件 Config **存在 volatile 字段**：`const form = volatileForm(schema); if (form === void 0) throw new Error('Plugin entry "${ns}" has no volatile fields')`（`dsh-settings/lib/index.js:505-506`），并逐路径校验 `isVolatilePath`（`:507`、`:516`）。`dsh-system-prompt` 的 Config 全是普通 `z.string()/z.boolean()`，**没有任何 `.volatile()`**（`dsh-system-prompt/lib/index.js:201-207`），`dsh-persona` 也没有（`dsh-persona/lib/index.js:23-28`）。而且 `describe()` 会直接跳过无 volatile 表单的条目（`dsh-settings/lib/index.js:417-419`）。⇒ **无有效 key 可写，UI 里也不会出现该条目**。写入的 ns 是 profile 条目 id（`entry.options.id`，`dsh-settings/lib/index.js:432`），可用 volatile 字段的例子只有 `agent-preset-registry.selectedDefault`（`dsh-agent-preset-registry/lib/index.js:473`）之类。
官方写盘通道是 `configEditor.edit(entry, change)`（`dsh-config-editor/lib/types/index.d.ts:34`），它 `writeFileAtomic(patchPath)` 后 `reconcileProfilePatches`（`dsh-config-editor/lib/index.js:117-124`）。

**(3) 每 step 重算 ⇒ 改完下一步生效，无需重启进程。**
`AgentLoop.turn()` 的 `while(true)` 里每轮都 `await this.preStep(...)`（`dsh-agent-loop/lib/index.js:951-957`），`preStep` 内 `await this.loopCtx.systemPrompt.assemble(...)`（`:907`），`step()` 内 `renderPrompt(assembly)`（`:1032`）。**没有 session/agent 级缓存**：`assemble()` 每次重新求值函数型 text、重新 merge 各层（`dsh-system-prompt/lib/index.js:310-362`）。
提交侧有投影对账：`SystemPromptProjection.project(rendered, input)`（`dsh-agent-loop/lib/index.js:264-282`）——首节点存在且内容相同则 `return []`（`:277`）；内容变了则 head `replace`（`:274`）或在 in-history 模式追加新 system 节点（`:278-281`）。DeepSeek 适配器的模型声明 `systemPromptUpdate: "in-history"`（`dsh-llm-deepseek/lib/index.js:47`、`:306`、`:1574`）。
⇒ 生效时机 = **注册/变更后的下一个 step（同一回合的后续 step 也算）**；进程重启、新会话都不是必需。注册/注销会广播 `system-prompt/change`（`dsh-system-prompt/lib/index.js:208-210`、`dsh-scope/lib/index.js:214-216`），可用于触发 UI 刷新。

**(4) 可行注入点，按稳健度排序**
1. **注册自己的新名字 section（最稳，纯内存、无冲突）**：`ctx.systemPrompt.section({ name: 'x:persona-extra', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1, text: () => myText })`。名字唯一→不触发 `:190` 的重复报错；`text` 用函数→每次请求读最新值；order 可精确插到任意位置（升序，`dsh-system-prompt/lib/index.js:98`）。缺点：只能"追加"，不能抹掉原 persona 文本。
2. **在 agent scope 内同名遮蔽（替换 persona 的唯一正道）**：拿 agent 作用域 ctx，用 `PERSONA_PREFIX_SECTION` 同名注册，如 `dsh-subagent/lib/index.js:517-521` 与 `dsh-persona/lib/index.js:36-41`；配 `complete: true` 还能让该段成为唯一系统提示（`dsh-system-prompt/lib/index.js:356-361`）。**UNCERTAIN**：第三方插件取得 per-agent `ctx` 的公开入口（本仓只见第一方用 `agent.ctx`，如 `dsh-file-reference-local/lib/index.js:342`、`dsh-tool-subagent/lib/index.js:576`），我未找到文档化的按 agent 建 scope 的公共事件，需再查 `dsh-agent` 的 agent 创建钩子。
3. **`system-prompt/assemble` 瀑布（最灵活，但有反制）**：`ctx.on('system-prompt/assemble', (assembly, context, next) => ...)`，可改 `assembly.sections/contexts/tools/variables`（事件签名 `dsh-system-prompt/lib/types/index.d.ts:27`；派发 `dsh-system-prompt/lib/index.js:355`，scope 过滤 `:355` + `dsh-scope/lib/index.js:327-338`）。**限制**：若该 scope 有生效的 `complete` section，瀑布结束后注册表会把它恢复成唯一 section，监听器的增删被丢弃（类型注释 `dsh-system-prompt/lib/types/index.d.ts:20-22`；代码 `dsh-system-prompt/lib/index.js:356-361`）。
4. **改 profile patch 并靠 HMR 热重载（持久化，非内存）**：写 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `- id: system-prompt` → `config.personaPrefix`；`dsh-hmr` 同时 watch `profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`（`dsh-hmr/lib/index.js:354`、`:375`）→ `reconcileProfilePatches` → `entry.update` → `ctx.emit("app-boot/config-reload")`（`dsh-app-boot/lib/index.js:3483-3493`）。cordis 的 `fiber.update(config)` 走 `restart()`，语义是 "Dispose and immediately reload this plugin with its current config"（`cordis/lib/index.js:1440`、`:1410`、`:1405`）⇒ 插件重挂载，构造函数重新注册 section（`dsh-system-prompt/lib/index.js:215-229`），**无需重启进程**。更推荐用 `ctx.configEditor.edit(entry, change)` 而不是裸写文件（`dsh-config-editor/lib/index.js:63-129`）。
5. **`systemPrompt.variable(name, provider)`（仅当已有 section 引用 `{{name}}`）**：`dsh-system-prompt/lib/types/index.d.ts:282`；同名重复抛错、变量名须 `^[a-z][a-z0-9_]*$`（`dsh-system-prompt/lib/index.js:298`）；引用未注册/undefined 变量在渲染期抛错（`:167-172`）。当前内置 persona/instructions 文本**不含** `{{...}}`，所以此路对本问题无用。
6. **`settings` 服务**：如 (2)，当前**不可用**（除非给 Config 加 `.volatile()`）。

**(5) 是否已有 persona / 系统提示词编辑 UI：没有。**
`dsh-client-ui-settings-general`（`lib/index.js:4` 仅 `welcomeNoticeVersion` 为 volatile）、`dsh-client-ui-settings-agent-loop`、`dsh-client-ui-agent-preset` 三个包全文检索 `persona|systemPrompt|system-prompt|instructions` **零命中**；`dsh-client-ui-agent-preset` 唯一写操作是 `ctx.remote.settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: id })`（`dsh-client-ui-agent-preset/lib/client.js:1080`）。settings 写盘点也只有 `agent-preset-registry.selectedDefault`（`dsh-agent-preset-registry/lib/index.js:473`）。

**UNCERTAIN**：(i) 第三方获取 per-agent scoped ctx 的公开入口（见 (4).2）；(ii) `harness:source`/`web-runtime` 等 order 名在 0.1.7-rc.2 的对齐我按 `SECTION_ORDERS` 值 + 各注册点 `getSectionOrder("NAME")` 交叉验证，未做运行时实测；(iii) 2036 行 `agent-loop` 中 `prepareRequest` 是否会在极端情况下跳过 assemble（正常路径 `:951-957` 每 step 必调），未逐分支确认。
