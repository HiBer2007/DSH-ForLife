# dsh-llm 重试 / reasoningEffort / 一次性调用 调研（READ-ONLY）

基线：所有 `@deepseek-ai/dsh-*` = 0.1.7-rc.2，Node v24.19.0。
路径约定：`pkg/...:LINE` 均相对真实包根 `R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（`.dsh\profiles\...` 下 junction 是坏的，未使用）。

## Q5 重试 / 回退链

### 机制：不包裹 ctx.llm.stream，而是挂在 agent loop 的失败步扩展点
- `dsh-llm-retry` 是函数插件：`name = "llm-retry"`、`inject = ["agents","sessionProjections"]` — `dsh-llm-retry/lib/index.js:21-22`。
- 自身**无配置**：`const Config = z.object({});` — `dsh-llm-retry/lib/index.js:24`；显式拒绝 `retryPolicy` 键并提示 "retryPolicy belongs under each provider configuration" — `:28`；类型注释同义 — `dsh-llm-retry/lib/types/index.d.ts:14`。
- 唯一挂载点：`ctx.on("agent/request-error", (payload, next) => ...)` — `dsh-llm-retry/lib/index.js:175`。**它不装饰 `ctx.llm.stream`，也没有 `LlmRetry` 服务**；`lib/types/history.d.ts:12` 只导出纯函数 `providerForOpenStep()`。
- 扩展点契约：`'agent/request-error'(this, payload:{agent,turn,step,provider,failure,retryPolicy,signal}, next): Promise<RequestErrorAction>` — `dsh-agent/lib/types/runtime-types.d.ts:348-356`；`RequestErrorAction = { kind:'retry' } | undefined` — `:101-103`（**没有**"换模型"这个动作）。
- loop 消费：`const action = await this.dispatch.waterfall("agent/request-error", {... retryPolicy: preparedCall?.retryPolicy ...}); if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure); continue;` — `dsh-agent-loop/lib/index.js:1109-1119`。
- 调度即持久化：等待前 `agent.session.append("llm/retry", eventData)` — `dsh-llm-retry/lib/index.js:141`，等待成功后再 `"llm/retry-started"` — `:143`；负载 `{retryId,turn,step,provider,mode,policyKey,retry,maxRetries,delayMs,failure}` — `dsh-llm-retry/lib/types/types.d.ts:13-41`。重试计数经 session projection 键 `"llmRetry"` 折叠 — `dsh-llm-retry/lib/index.js:88-91`。

### 是否消耗/回滚一个对话轮次：不会，是同一 assistant step 内的按请求重试
- `step()` 里 `while (true)` — `dsh-agent-loop/lib/index.js:1034`；`turn/step` 进入前解构一次（`:1029`），循环内不递增；`continue`（`:1119`）回到循环头重新 `prepareRequest(turn, step, signal)`（`:1035`）。
- 用户消息只在首轮追加：`if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", ...)` 后 `firstAttempt = false` — `dsh-agent-loop/lib/index.js:1046-1047`；失败尝试只落 `assistant/attempt`（`:1104`），成功才落 `assistant/message`（`:1129`）→ 不产生额外 user turn，也不撤销 turn。
- 每轮都重跑 `prepareRequest`，故 `agent/request` waterfall 也重跑 — `dsh-agent-loop/lib/index.js:1164`（这正是 failover 的可用挂点）。
- 直接 `ctx.llm.stream()` 的调用方**没有重试**（单次尝试）— `dsh-llm-retry/README.md:32`、`:132`。

### 配置 schema（字段 / 默认值 / 退避）
- `BackoffConfig { initialDelayMs? (默认 500), maxDelayMs? (默认 10000), jitterRatio? (默认 0.1) }` — `dsh-llm/lib/types/retry-policy.d.ts:11-18`。
- `NormalRetryPolicyConfig { mode:'normal'; maxRetries? (默认 5); retryableCodes? (默认见下); backoff? }` — `dsh-llm/lib/types/retry-policy.d.ts:20-29`。
- `AlwaysRetryPolicyConfig { mode:'always'; backoff? }` — `dsh-llm/lib/types/retry-policy.d.ts:31-36`；`RetryPolicyConfig = Normal | Always`（`:38`）；`RetryPolicySchema`（schemastery union，`:58`）；`resolveRetryPolicy(config, path)`（`:65`）。
- 默认常量：`DEFAULT_MAX_RETRIES = 5`、`DEFAULT_INITIAL_DELAY_MS = 500`、`DEFAULT_MAX_DELAY_MS = 10_000`、`DEFAULT_JITTER_RATIO = 0.1`、`DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']` — `dsh-llm/lib/types/retry-policy.js:12-22`。
- 退避种类：**有界指数退避 + 对称抖动**。`exponential = min(initialDelayMs * 2**(retry-1), maxDelayMs)`；`jitter = 1 - jitterRatio + 2*jitterRatio*random()`；再 `min(..., maxDelayMs)` — `dsh-llm-retry/lib/index.js:44-49`。
- 优先用 provider 的 `Retry-After`：`providerRetryAfterMs` 有效且 `<= maxDelayMs` 时直接采用；超界时 normal 交还下游、always 退回本地退避 — `dsh-llm-retry/lib/index.js:168-171`。
- 预算/资格：normal 模式码不在 `retryableCodes` 交还（`:160`）、`previousRetry >= maxRetries` 交还（`:164`）；always 模式先结算下游并尊重下游的 `{kind:'retry'}`（`:153-159`）。
- **没有 `retryable` 布尔标记**：`normalizeLlmFailure()` 只产出 `{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}` — `dsh-llm/lib/types/types.d.ts:26-44` + `dsh-llm/lib/types/adapter-failure.js:13-26`。可重试性完全由「code 是否在策略的 retryableCodes 集合内」决定。
- 码分类在适配器侧，如 deepseek：429/`rate_limit_error`→`RATE_LIMIT`；`status>=500` 或 `api_error`/`overloaded_error`→`SERVER`；401/403→`AUTH`；402/quota→`QUOTA`；context→`CONTEXT_WINDOW_EXCEEDED`；400/413→`INVALID_REQUEST` — `dsh-llm-deepseek/lib/index.js:1744-1751`；`TIMEOUT`/`TRANSPORT` 由流空闲看门狗与传输异常抛出 — `dsh-llm-deepseek/lib/index.js:2124,2127`（pi-ai：`:1906` 与文本分类 `dsh-llm-pi-ai/lib/index.js:1383-1385`）。`EMPTY_RESPONSE` 语义 — `dsh-llm/lib/types/error.d.ts:32`。

### 配置放哪：provider 插件配置（cordis.yml / provider profile），不是 llm-retry
- `retryPolicy` 属各 provider 的 Config：`dsh-llm-deepseek/lib/types/config.d.ts:44`（`Volatile<RetryPolicyConfig|undefined>`，schema `:74`，注释 "omission uses normal mode with five retries" `:43`）；`dsh-llm-deepseek-api-key/lib/types/config.d.ts:32`；`dsh-llm-deepseek-account/lib/types/config.d.ts:23`；pi-ai 在**每个 provider profile 内** `dsh-llm-pi-ai/lib/types/config.d.ts:144`（`ResolvedPiAiProviderProfile.retryPolicy: ResolvedRetryPolicy` `:163`）。
- 注册时冻结为 resolved policy：`retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-deepseek: retryPolicy")` — `dsh-llm-deepseek/lib/index.js:446`；pi-ai `resolveRetryPolicy(retryPolicy, 'llm-pi-ai: provider "<p>" retryPolicy')` — `dsh-llm-pi-ai/lib/index.js:1140`；经 `providerRetryPolicy(provider)` 暴露 — `dsh-llm-deepseek/lib/index.js:2083`、`dsh-llm-pi-ai/lib/index.js:1791`、基类契约 `dsh-llm/lib/types/index.d.ts:142`、运行时读取 `LlmRuntime.providerRetryPolicy()` `:323`。
- 设置命名空间：api-key provider `settingsNs = ctx.fiber.entry?.options.id ?? "llm-deepseek-api-key"`、`settingsPath: []` — `dsh-llm-deepseek-api-key/lib/index.js:52-57`；pi-ai `settingsNs = entry id ?? NS("llm-pi-ai")`、`settingsPath: ["providers", provider]` — `dsh-llm-pi-ai/lib/index.js:2488,2516-2517`。
- 无 UI：`dsh-client-ui-settings-models` 全包无 `retryPolicy` 字段（仅 i18n "retry" 文案 `dsh-client-ui-settings-models/lib/client.js:2880,2996`）；agent-loop 设置页只有 `maxParallelToolCalls`，`AGENT_LOOP_NS="agent-loop"` — `dsh-client-ui-settings-agent-loop/lib/types/client/agent-loop-card-controller.d.ts:8,13-16`。→ 只能改 cordis.yml / provider profile。

### "主模型失败→自动切备用模型"：不存在
- 全树 grep `failover|backupModel|fallbackModel|modelChain|alternativeProviders|primaryFailed`：唯一命中是无关的 SQL 语法高亮文件 `dsh-web-frontend/dist/assets/langs/sql-CRqJ_cUM.js:1`。**无任何 failover 实现。**
- 最接近的扩展点（可自建）：`'agent/request'` waterfall，返回 `LlmCallConfig`（provider/model/reasoningEffort/temperature/maxTokens/stop）— `dsh-agent/lib/types/runtime-types.d.ts:327-332`；每次重试迭代都会重跑（`dsh-agent-loop/lib/index.js:1164`），故"记下失败 provider，再在 `agent/request` 换 route"即可做 failover。现成范式 `installModelSelection()` — `dsh-agent/lib/types/model-selection.d.ts:49`，实现 `dsh-agent/lib/types/model-selection.js:61-75`（覆盖 `provider/model/reasoningEffort`）。注意该 waterfall **不能改 messages**（契约 `runtime-types.d.ts:317-319`），且换 route 会写 `model/selection` 通知（`model-selection.js:76-88`）。
- 干扰项：`dsh-compaction-basic` 的 "fallback model" 只是摘要目标回退顺序 `configured ?? latest header ?? agent options` — `dsh-compaction-basic/lib/index.js:294-303`，与 failover 无关。

### 多 provider 并存 / registerAdapter
- `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` — `dsh-llm/lib/types/index.d.ts:253`；任一 provider 已有适配器则整体抛 `DUPLICATE_ADAPTER`（全有或全无）`:246-247`；handle = disposer + `replace(providers)` 原子换路由（`:193-211`，空数组合法）。
- `LlmAdapter` 能力声明：`providerInfo(provider)` `:136`、`providerRetryPolicy(provider)` `:142`、`imageRequestPricing(provider,model)` `:152`、`listModels(provider)` `:161`、`resolveModel(provider,model,signal)` `:171`、`prepareCall(...)` `:181`、抽象 `stream(options)` `:187`（唯一必需方法）。模型能力经 `LlmResolvedModelInfo`（context/defaultMaxTokens/reasoning/systemPromptUpdate/toolUpdate）— `dsh-llm/lib/types/types.d.ts:377-388`。
- 一个适配器实例可服务多条 route：pi-ai `ctx.llm.registerAdapter(routes, adapter)` — `dsh-llm-pi-ai/lib/index.js:2619`；deepseek 单 route `dsh-llm-deepseek/lib/index.js:2262`。未挂载也可配置的 route 目录走 `registerConfigurableProviders()` — `dsh-llm/lib/types/index.d.ts:281`。

## Q6 reasoningEffort

- **取值集合不是固定枚举**：`ReasoningEffortId = Branded<'ReasoningEffortId'>`，不透明字符串 — `dsh-llm/lib/types/brand.d.ts:49`（构造器 `:55`，不校验）。
- 由**适配器按精确 provider/model 声明**：`LlmModelReasoningInfo { efforts: readonly LlmReasoningEffortInfo[]; defaultEffort?: ReasoningEffortId }` — `dsh-llm/lib/types/types.d.ts:350-358`；`LlmReasoningEffortInfo { id, name, description? }` — `:341-348`；经 `LlmResolvedModelInfo.reasoning?` 暴露 — `:383`；查询入口 `LlmRuntime.resolveModelInfo(provider,model,signal)` — `dsh-llm/lib/types/index.d.ts:360`。
- deepseek 声明 `off/low/high/max`：`dsh-llm-deepseek/lib/index.js:452-477`（含 name/description）；`thinking:'disabled'` 时只给 `off` — `:517-519`，默认 effort 由配置推导 — `:520-523`。
- pi-ai 声明：`THINKING_LEVELS: readonly ModelThinkingLevel[]` — `dsh-llm-pi-ai/lib/types/catalog.d.ts:20`；`PiAiReasoningEfforts = Partial<Record<ModelThinkingLevel, string|null>>` — `:68`；profile 覆盖 `reasoningEfforts?: false | PiAiReasoningEfforts` — `:290`（`false`=非推理模型）；支持级别解析 `getSupportedThinkingLevels(model)` — `dsh-llm-pi-ai/lib/types/models.d.ts:29`。
- **两个字段都存在**：`GenerateOptions.reasoningEffort?: ReasoningEffortId` — `dsh-llm/lib/types/types.d.ts:493-494`；`LlmCallConfig.reasoningEffort?: ReasoningEffortId` — `dsh-llm/lib/types/call-config.d.ts:19`，文档："Every field maps 1:1 onto the same-named `GenerateOptions` field" — `:10-14`。运行时校验 `resolveCallConfig()`：不支持的显式 effort 在 provider I/O 前拒绝，不 clamp、不别名 — `dsh-llm/lib/types/index.d.ts:364-374`。
- 流入 deepseek 请求体：`const effort = options.purpose === "session-title" ? "off" : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (thinking==='disabled' ? "off" : "high")` — `dsh-llm-deepseek/lib/index.js:1689`；非法值抛 `UNSUPPORTED_REASONING_EFFORT` — `:1690-1695`；序列化为 `thinking:{type:'disabled'|'enabled'}` + 非 off 时 `output_config:{effort}` — `:1702-1703`。（deepseek 包内无 `reasoning_effort` 字面量；pi-ai 侧有该兼容字段 — `dsh-llm-pi-ai/lib/types/catalog.d.ts:165`。）
- 默认/全局：deepseek 插件配置 `reasoningEffort`（默认 `high`）— `dsh-llm-deepseek/lib/types/config.d.ts:13-14`；全局默认模型选择 `AgentDefaultModelConfig.reasoningEffort` — `dsh-agent-default-model/lib/types/index.d.ts:18`（`currentSelection()`/`saveSelection()` `:42,50`）。
- UI：**不在** settings-models（"Reasoning effort is deliberately absent" — `dsh-client-ui-settings-models/lib/types/client/ProviderEditor.d.ts:14`，同义 `CustomProviderCard.d.ts:20-21`），而在输入框模型选择器的 Effort 子面板：选项来自 `model.reasoning.efforts` + `defaultEffort` — `dsh-client-ui-model-selection/lib/client.js:512-521`，提交 `select({provider,model,reasoningEffort})` `:686`，文案键 `menu.effort`/`effort.providerDefault` — `:937-938`。
- 持久化：session 事件 `'model/selection': ModelSelection{provider,model,reasoningEffort?}` — `dsh-api-session-controller/lib/types/types.d.ts:35`（类型 `:91-95`）；折叠投影 `modelSelection:{lastUsed,pending}` — `:17-26,97-108`；客户端每 session 目录 `select()` — `dsh-client-ui-model-selection/lib/types/client/directory.d.ts:65`。loop 侧生效点 `agent/request` 覆盖 — `dsh-agent/lib/types/model-selection.js:61-75`；适配器默认值删除逻辑 `dsh-agent-loop/lib/index.js:719`。

## Q7 一次性 LLM 调用

- 入口：`ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` — `dsh-llm/lib/types/index.d.ts:412`；服务名字符串 **"llm"**：`super(ctx, "llm")` — `dsh-llm/lib/index.js:1801`；`interface Context { llm: LlmRuntime }` — `dsh-llm/lib/types/index.d.ts:30`。插件用 `ctx.llm`（或 `ctx.get("llm")`）。
- `GenerateOptions` 完整字段（`dsh-llm/lib/types/types.d.ts:489-531`）——**没有** `stream` / `metadata` / 任何 attribution 字段：
  - `provider: string` **必填** — 注册的 provider route，选适配器实例（`:490-491`）。
  - `model: string` **必填** — 精确模型 id（`:492`）。
  - `reasoningEffort?: ReasoningEffortId` 选填 — 该模型下适配器拥有的 effort（`:493-494`）。
  - `messages: RequestMessage[]` **必填** — 已完全装配的对话消息（`:495-501`）。
  - `system?: string` 选填 — 一次性调用的 system 文本，适配器映射到 provider system 槽；loop 构建的请求留空（`:502-506`）。
  - `tools?: ToolSchema[]` 选填 — 工具声明，映射到 provider `tools`（`:507-508`）。
  - `toolHistory?: ToolHistory` 选填 — session 折叠的工具历史用于 route 投影；省略=发送完整声明（`:509-510`）。
  - `temperature?: number` / `maxTokens?: number` 选填（`:511-512`）。
  - `stop?: string[]` 选填 — 命中即停，停止串本身不含在输出中（`:513-518`）。
  - `signal?: AbortSignal` 选填 — 取消（`:519`）。
  - `sessionId?: Branded<'SessionId'>` 选填 — loop 盖的 session 身份，用于请求路由/重放游标（`:520-524`）。
  - `purpose?: 'compaction' | 'session-title'` 选填 — 辅助调用的 provider 中立分类（`:525-530`）。
- `RequestMessage = Message | RequestUserInput`（`:475`）；`RequestUserInput = {role:'user', content, id?: never, source?: never}`（`:468-473`）→ 一次性输入可无身份无 source；持久 `Message` 必须带 `source: MessageSource`（`dsh-llm/lib/types/message.d.ts:132`），用 `createUserMessage()` 构造（`:213`）。
- attribution：不是请求字段，而是**每请求固定头**：`APP_IDENTITY`/`attributionHeaders()` — `dsh-llm/lib/types/attribution.d.ts:30,46`；适配器契约要求每个 HTTP 请求都带（`dsh-llm/lib/types/index.d.ts:126-128`）；deepseek 实测 `...attributionHeaders()` 合并进 headers — `dsh-llm-deepseek/lib/index.js:2189`。消息级归属是 `MessageSource`（`message.d.ts:101-108`）与 `AssistantProviderMetadata{provider,model,replayState?}`（`:5-16`）。
- 返回值：`AsyncIterable<StreamChunk>`，联合为 `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish` — `dsh-llm/lib/types/types.d.ts:417-447`；**必然以终态 `finish` 收尾**，适配器抛错被归一为终态 `error`/`aborted` finish — `:410-416`。中间还可被 `llm/stream` waterfall 包裹 — `dsh-llm/lib/types/index.d.ts:45`。
- **没有非流式 helper**：dsh-llm 内不存在 `complete`/`generate`（`lib/types/index.d.ts` 无此符号），唯一入口是 `stream`；装配工具 `BlockAssembler`（`push/blocks()/interruptedBlocks()/usage/finish/replayState/message(source)`）— `dsh-llm/lib/types/assembler.d.ts:22,32,49,57,59,61,67,73`，导出 `dsh-llm/lib/types/index.d.ts:25`。
- 真实一次性调用范例（照抄即可）：`dsh-session-title-llm/lib/index.js:206-229`（构造 `{provider,model,messages,system,maxTokens,sessionId,purpose:'session-title',signal}` → `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`）；`dsh-compaction-basic/lib/index.js:312-336`（`purpose:'compaction'`，含 toolHistory/tools）。
- `purpose` 合法值只有这两个（`types.d.ts:530`）。它是**分类标签**，改变路由侧生成策略与传输头，但**不参与 token/费用记账**（`dsh-token-meter` 全包 grep `purpose` 无命中）：deepseek 对 `session-title` 强制 effort=`off` — `dsh-llm-deepseek/lib/index.js:1689`；`purpose` 透传给扩展请求 — `:2172`（扩展契约 `dsh-deepseek-llm-api-extensions/lib/types/types.d.ts:13-22`）；`compaction` 额外加 `x-deepseek-harness-compact: 1` — `:2197`。pi-ai **不消费** `purpose`（只消费 sessionId — `dsh-llm-pi-ai/lib/index.js:1881`）。注意 trajectory UI 的 `purpose:'assistant'|'compaction'` 是另一套无关词表 — `dsh-client-ui-trajectory/lib/client.js:1474`。
- `sessionId` 绑定什么：定义为"loop 盖的请求路由身份；重放用它区分游标；适配器可映射为模型不可见的传输元数据" — `dsh-llm/lib/types/types.d.ts:520-523`；loop 侧赋值 `sessionId: this.session.id` — `dsh-agent-loop/lib/index.js:1259`；它是**本地声明** brand（避免与 dsh-session 循环依赖）— `dsh-llm/README.md:161`。实际落点只有传输层：deepseek 发 `x-deepseek-harness-session-id` 头（`dsh-llm-deepseek/lib/index.js:2196`）并传给扩展（`:2171`）；pi-ai 传给 pi-ai 的 sessionId（`dsh-llm-pi-ai/lib/index.js:1881`）。**它本身不写 session 日志、不做 token 记账**（记账靠 loop 落 `assistant/message` 的 usage — `dsh-agent-loop/lib/index.js:1129-1135`）。缺省=头字段省略（`:2196`），不报错；传假值 dsh-llm 不校验，只会让传输头失真。

## UNCERTAIN
- `sessionId` 在 DeepSeek 服务端是否有语义（限流/缓存/审计）：包内无服务端代码，无法验证。
- pi-ai 是否把 `purpose` 映射到任何生成策略：`dsh-llm-pi-ai` 全包 grep `purpose` 零命中，判定为不消费；但其内部依赖 `@earendil-works/pi-ai` 未展开核对。
- `providerRetryAfterMs` 除 `dsh-llm-retry/lib/index.js:168-171` 那一个分支外是否还有别的消费者：未发现其他读取点。
