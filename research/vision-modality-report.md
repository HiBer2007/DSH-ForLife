# DSH 视觉/非视觉模型分路处理调研报告

- **真包根** `R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（`.dsh\profiles\node_modules\@deepseek-ai\*` 多数 junction 断链，本报告全部结论读自 `R`）
- **基线** `@deepseek-ai/dsh-* = 0.1.7-rc.2`，Node v24.19.0。只读调研，未改任何文件。以下 `path:line` 均相对 `R`。
- **符号更正（先看）**：`ToolExecutionContext`、`recentImages`、`imageBudget`、`ToolImage`、`ToolContentBlock`、`LlmImageRequestBudget` 之外的 `imageBudget`、`ctx.attachment`（单数）、`llm/request`、`beforeRequest` **全树零命中或名字不存在**；真实名字见各节。

## 0. 速览

1. **能力声明**：`LlmModelInfo.inputModalities?: readonly ModelModality[]`，`ModelModality = 'text'|'image'`。**三态**：`undefined`=未知（框架**不降级**）、`['text']`=显式纯文本（**降级**）、`['text','image']`=支持图片。
2. **运行时查询**：`await ctx.llm.resolveModelInfo(provider, model, signal)`；当前路由 `agent.session.requestHeader()?.config ?? agent.options`。首方已有 5 处范例可抄。
3. **图片在消息里是引用**：`ImageBlock{type:'image', attachment: ImageAttachmentRef}`（非 base64；字节归 `ctx.attachments`，`attachmentId = "sha256:<64hex>"`）。
4. **框架已内置非视觉降级**：`LlmRuntime.stream()` 在 dispatch 前把 image 块换成 `[image omitted because this model accepts text only; attachment sha256:<前8位>]` —— **不崩但内容全丢**，这就是要补的缝。但它**只在模态显式声明且不含 image 时触发**；`undefined` 时图原样下发，被适配器硬拒（`UNSUPPORTED_CONTENT`）。
5. **切模型两个正式点**：`agent/request` waterfall 返回替换后的 `LlmCallConfig`（per-request、静默、**payload 看不到消息**，seed 深冻结）；`installModelSelection(agentCtx,{current})`（per-agent、**留 durable 通知**）。
6. **一跳调用**：`ctx.llm.stream(GenerateOptions)` + `BlockAssembler`。`purpose` 是闭集 `'compaction'|'session-title'`，**不可自定义**（TS 拒绝；运行时无校验也无消费者，建议留空）。
7. **没有现成视觉桥接**：0 命中 `describeImage/imageToText/ocr/vlm/multimodal`。最接近的只有文本占位与 `read_image`（要求模型**本身**支持图片）。**桥接必须自研**。
8. **最佳挂载点 `agent/pre-step`**：其返回值含 `messages: UserMessage[]`，是**唯一可改写本轮消息**的地方（`agent/request` 明文 "cannot mutate messages"）。

## 1. 模型能力如何声明与查询

**1.1 类型（`dsh-llm`）**
```ts
// dsh-llm/lib/types/types.d.ts:211
export interface ModelModalityMap { text:'text'; image:'image'; }
export type ModelModality = ModelModalityMap[keyof ModelModalityMap];               // :217
export interface LlmModelInfo {                                                     // :304
    provider: string; id: string; name: string; description?: string;
    inputModalities?: readonly ModelModality[];   // 缺席=未知；显式省略=负能力     // :314
}
export interface LlmResolvedModelInfo extends LlmModelInfo {                        // :377 ← 运行时权威
    context?: LlmModelContext; defaultMaxTokens?: number; reasoning?: LlmModelReasoningInfo;
    systemPromptUpdate?: SystemPromptUpdate; toolUpdate?: ToolUpdate;
}
// :291 LlmDiscoveredModel 同字段（端点自述，通常只有 id）
```
**1.2 provider 怎么声明纯文本 / 文本+图片**
pi-ai（自定义 provider 正式入口）：`PiAiModelProfile.input?: PiAiModality[]`（`dsh-llm-pi-ai/lib/types/catalog.d.ts:282`）——注释明说"声明 image 才让手写视觉模型可用；只声明 text 可纠正 catalog 撒谎"（:271-281）；逐模型修正用 `PiAiModelOverride = Omit<PiAiModelProfile,'id'>`（:301）+ `modelOverrides`（:313）；路由级兜底 `defaultInput?`（`lib/types/config.d.ts:112`，**默认 `['text']`**，不可为空）。相关预算：`maxRequestImageBytes`（config.d.ts:135，默认 20971520，`lib/index.js:1093`）、`requestImagePixelBudget`（:137）、`requestImageMaxBytes`（:142）。摊平点 `inputModalities: [...model.input]`（`dsh-llm-pi-ai/lib/index.js:1802/1821/2290`）。
DeepSeek 一方适配器的 catalog 校验可当规范参考：`inputModalities` 必须非空、只含 `text|image`、无重复，否则抛错（`dsh-llm-deepseek/lib/index.js:303,349-353`）。

**1.3 运行时怎么查"当前选中模型支不支持 image"**
```ts
// dsh-llm/lib/types/index.d.ts
listModels(provider): Promise<LlmModelInfo[]>;                                  // :350
resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>;      // :360
```
首方标准写法（可直接抄）：
```js
// dsh-tool-fs/lib/index.js:898  assertImageCapableRoute
const routed = exec.agent?.session.requestHeader()?.config;
const provider = routed?.provider ?? exec.agent?.options.provider;
const model    = routed?.model    ?? exec.agent?.options.model;
const active = await llm.resolveModelInfo(provider, model, exec.signal);
if (active.inputModalities === undefined || !active.inputModalities.includes('image')) throw new Error(/* 让用户换模型 */);
```
同型实现：`dsh-acp/lib/index.js:60-68`（`supportsAcpImagePrompts` :78-88）、`dsh-api-session-controller/lib/index.js:870-874`（拒码 `MODEL_DOES_NOT_SUPPORT_IMAGES`）、`dsh-subagent/lib/index.js:1984`、`dsh-mcp-client/lib/index.js:299`。另一条取当前选择：`ctx.agents.selectionFor(agent).current`（`dsh-api-session-controller/lib/types/agent.d.ts:101`）。
**⚠️ 两个坑**：① `undefined` 不触发框架降级，图片原样下发后被适配器硬拒（`dsh-llm-deepseek/lib/index.js:1410` "requires a vision model and attachment service"，code `UNSUPPORTED_CONTENT`；`dsh-llm-pi-ai/lib/index.js:1855-1857`）；② 因此插件必须显式定义未知策略（建议未知按不支持 → 走桥接）。

## 2. 消息里的图片怎么表达

**2.1 块形状**：`ImageBlock{type:'image'; attachment: ImageAttachmentRef; offloaded?: true}`（`dsh-llm/lib/types/types.d.ts:61`）；`FileBlock{type:'file'; attachment: FileAttachmentRef}`（:79）；`ContentBlockMap`（:114）/`ContentBlock`（:126）。`ImageAttachmentRef`（`dsh-attachment/lib/types/types.d.ts:7`）= `{attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}`，**只有 id，永不含路径或 bearer URL**。

**2.2 进请求体的投影链**（dispatch 前最后一道，`LlmRuntime.adapterStream`）
```js
// dsh-llm/lib/index.js:2309-2311
if (msgs.some(m => contentHasFile(m.content))) msgs = projectFilesToText(msgs, ref => this.fileReadPath(ref));
if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')
 && msgs.some(m => contentHasImage(m.content))) msgs = projectImagesForTextModel(msgs);   // ← 内置降级
```
| 符号（`lib/types/content.d.ts` / `content.js`） | 作用 |
|---|---|
| `contentHasImage` :59 / :87 | 唯一图片遍历，各策略共用；`contentHasFile` :66 |
| `textOnlyImageText` :33 / :47 | 纯文本占位 `[image omitted because this model accepts text only; attachment sha256:<8>]`（:49） |
| `projectImagesForTextModel` :124,130 / :240 | image 块 → 上述文本（**不是描述**） |
| `requestImageHandleText(ref,{w,h},access?)` / :61 | 视觉模型看到的句柄文本（含尺寸、只读路径） |
| `offloadedImageText` :73 | 超限被丢的图 → `[image omitted to fit request image limits; …]` + 恢复路径 |
| `resolveImageAttachmentAccess(store,mapHostPath,ref)` :27 | 附件 → 工具可读只读路径 |
投影只影响**请求体**：append-only 历史与 UI 不受影响；`tool`-role 消息里的图**同样**被替换（与 role 无关）。

**2.3 消息载体**：`RequestUserInput{role:'user'; content: UserMessage['content']; id?:never; source?:never}`（types.d.ts:468）与 `RequestMessage = Message | RequestUserInput`（:475）。副调用最省事用 `RequestUserInput`；进日志用 `createUserMessage({content,source})`（`lib/types/message.d.ts:213`）；改写既有消息**保 MessageId** 用 `freezeMessage({...msg,content})`（message.d.ts:190；`LlmRuntime.forAdapter` 就这么干 `lib/index.js:2248`）。

**2.4 预算 / 溢出 / 降采样（三级，互不相同）**
1. **存储期归一化**（`dsh-attachment-local`）：超限**缩小后存副本**（不是拒绝）。按总像素 + 长边等比缩小（`lib/index.js:234-243`），EXIF `rotate()` + sRGB（:226），质量阶梯 `[85,75,60]`（:60-64），带 alpha→WebP 否则 JPEG（:84-87）；全不达标保留最小输出（:94-105）；干净源**逐字节透传**（:212-214）；缩小时记 `originalDimensions`。默认目标 2048² 像素 / 长边 8192 / 4 MiB（:912-916）；并发默认 2、上限 8（:918-920）。
2. **请求期降采样**（适配器）：`resolveRequestImageTarget()`（`dsh-llm-deepseek/lib/index.js:239-246`）= token 网格/`imagePixelBudget` → `REQUEST_IMAGE_MAX_DIMENSION=4096`（:219）单边封顶 → `maxBytes = model.imageMaxBytes ?? 2097152`（:227）。**真正的字节投影由 provider 调 `ctx.attachments.readImageRequest(ref, target)` 完成**（`dsh-attachment-local/lib/index.js:1053-1076` 带缓存 + inflight 合并；`dsh-llm-deepseek/lib/index.js:1586-1602` 编码成 base64 或 Files API `file_id`；`dsh-llm-pi-ai/lib/index.js:1193-1220`）。注意 `dsh-attachment/lib/types/request-projection.d.ts` **只是纯几何**（`requestImageDimensions` :17、`longEdgeDimensions` :27），不做字节投影、不含降级逻辑。
3. **请求期字节预算 + 溢出**：`LlmImageRequestBudget{representation:'raw'|'base64'; maxBytes?; maxImages?; byteQuantum?; countQuantum?}`（types.d.ts:328）；`requiredImageOffload(messages,budget,versionBytes)`（content.d.ts:118 / content.js:215，base64 按 `base64Length` 计）算出还需丢多少**最老**出现位置；超预算抛 `LlmError`，code **`IMAGE_OFFLOAD_REQUIRED`**（`types/error.js:154` / `lib/index.js:236`），失败带 `LlmFailure.offloadImages`（types.d.ts:37-43）。恢复者 `dsh-compaction-image-offload`：捕获 → 记 `image/offload` → retry（`lib/index.js:139-152`，选择逻辑 :14-44；接线 `dsh-base/cordis.patch.yml:427`）。适配器侧预算：deepseek `DEFAULT_MAX_IMAGES_PER_REQUEST=600`、`DEFAULT_REQUEST_IMAGE_MAX_BYTES=2MiB`、`DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET=512²`、`DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES=20MiB`（`dsh-llm-deepseek/lib/index.js:23-29,208-219`）；pi-ai `maxRequestImageBytes`（`lib/index.js:1330`）。
4. **token 计价**：`LlmAdapter.imageRequestPricing()`（`lib/types/index.d.ts:152`）→ `LlmImageRequestPricing.priceImages(ImageBlock[])`（types.d.ts:195-203），经 `ctx.llm.imageRequestPricing(provider,model)`（:333）；未声明则中性估算。文本模型路径复用同一占位文案计价（`dsh-llm-deepseek/lib/index.js:247-257,274`）。

## 3. 附件管线

**3.1 服务是 `ctx.attachments`（复数）**：`dsh-attachment/lib/types/index.d.ts:12-16`（`lib/types/index.js:12` `super(ctx,'attachments')`）。`AttachmentStore` 全部成员（`index.d.ts:18-130`）：`imageLimits`(:21)、`validateImage`(:28)、`validateImageBatch`(protected :37)、`saveImages`(:43)、`admitPromptContent`(:51)、`admitEncodedFile`(:58)、`isAttachmentError`(:64)、`saveImage`(:73)、`readImage`(:81)、`imageHostPath`(:88)、`saveFile`(:97)、`saveFileStream`(:105)、`readFileStream`(:114)、`fileHostPath`(:121)、`readImageRequest`(:129)。
**没有** `register/create/put/open/resolve/stat/gc/delete/prune`，**也没有删除/保留策略**（"Stored images are never deleted automatically"，`dsh-attachment-local/README.md:55`）。模块级自由函数：`admitEncodedImages`/`admitEncodedFile`（`lib/types/admission.d.ts:14,25`）、`requestImageDimensions`/`longEdgeDimensions`（`request-projection.d.ts:17,27`）、`AttachmentId(value)`/`ImageVariantId(value)`（`brand.d.ts:10,18`）。错误码全集 `error.d.ts:5`（常用：`TOO_MANY_IMAGES, IMAGES_TOO_LARGE, UNSUPPORTED_IMAGE_TYPE, INVALID_IMAGE, IMAGE_TYPE_MISMATCH, IMAGE_TOO_LARGE, IMAGE_TOO_MANY_PIXELS, IMAGE_DIMENSION_TOO_LARGE, ATTACHMENT_CORRUPT, ATTACHMENT_WRITE_FAILED, ATTACHMENT_NOT_FOUND`）。

**3.2 从外部来源登记一张图 —— 没有 path/Buffer/Readable 直通 API**，唯一入口是内存字节：
```ts
// dsh-attachment/lib/types/types.d.ts:115
export interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string; }
export type ImageMediaType = 'image/png'|'image/jpeg'|'image/webp'|'image/gif';          // :5
```
标准序列（照抄 `read_image`，`dsh-tool-fs/lib/index.js:998-1019`）：
```js
const attachments = ctx.get('attachments');            // 可能 undefined
const cap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
const data = await ctx.fs.readBytes(path, signal, cap);                 // 或自备网络下载
const mediaType = declared ?? sniffImageMediaType(data);                // 需自行魔数嗅探
const ref = await attachments.saveImage({ data, mediaType, name });      // → { type:'image', attachment: ref }
```
返回对象 `ImageAttachmentRef`（**不是 URI、不是裸字符串**）；`attachmentId` 是 branded 字符串，实际值 `sha256:<64hex>`（构造 `dsh-attachment-local/lib/index.js:338`，校验正则 :275）。`validateImage` 只吃 `Uint8Array`（**不接受 path/base64 字符串**）且做完整解码；`saveImages` 是"全批先验、任一失败零写入"（`dsh-attachment/lib/index.js:228-233`）。HTTP 二进制上传另有 `ctx.fileUploads`（`dsh-client-file-upload/lib/index.js:205,217`，raw 路由 `/api/session/uploadFileBinary`）。

**3.3 `dsh-attachment-local` 存储与配置**：根 `<DSH_HOME>/attachments/v1`（`lib/index.js:996`），缓存 `<dshHome>/cache/attachments`（:997）。`dshHome` 优先级 `config.dshHome` > `$DSH_HOME` > `~/.dsh`（`dsh-home-paths/lib/index.js:11-15,65-73`）。布局：图片 `objects/<sha[:2]>/<sha>`（:296-299）、文件 `file-objects/<sha[:2]>/<sha>`（:672-674）+ 硬链接别名 `files/<sha[:2]>/<sha>/<清洗后文件名>`（:667-670）、请求图缓存 `request-images/<hash[:2]>/<hash>`（:812-814）、staging `tmp/<uuid>`（:499-502）。发布：staged write → fsync → `link` 原子落位 → 摘要校验去重 → `chmod 0400/0600` → 逐级 fsync（:433-560；Windows 跳过目录 fsync :357-359）。自定义目录只改 `dshHome`。默认组合无 config 挂载（`dsh-base/cordis.patch.yml:138-139`）。**全树唯一的 `AttachmentStore` 实现**。

**3.4 默认限额**（`lib/index.js:896-920`）：单图 **20 MiB**（:896）/ 单消息 **20 张**（:898）/ 聚合 **200 MiB**（:900）/ **64e6 像素**（:902）/ **单边 8192**（:904）。**超限拒绝并抛错，不自动缩小**（缩小只发生在归一化与请求版本）。允许的媒体类型 png/jpeg/webp/gif 由 store 冻结提供、**Config 中不可配**（:1004-1009）。批级闸门 `dsh-attachment/lib/types/index.js:22-36`；单图闸门 `dsh-attachment-local/lib/index.js:328-350`。

## 4. 工具侧图片能力

**4.1 不存在 `ToolExecutionContext`**：真实类型 `ToolExecutionInput`（`dsh-tools/lib/types/index.d.ts:216`）、`ToolExecution`（:282）、`ToolDispatchExecution`（:293）、`ToolRunContext`（:305）。`ToolRunContext` 只有两个自有成员且与图片无关：`deferContext(context: UserMessage): void`（:312）、`concludeTurn(): void`（:321）。**`recentImages`/`imageBudget`/`ToolImage` 零命中**；**没有**"已展示图片"追踪，**没有** per-turn/per-tool-result 图片配额。

**4.2 `validateImage / saveImage / imageLimits` 的真实宿主是 `ctx.attachments`**（签名/语义/默认值见 §3）。要点：`saveImage` 返回**仅 `ImageAttachmentRef`**（不返回 content block、不返回 markdown），工具须自己包成 `ImageBlock`；`imageLimits` 由承载插件提供并 `Object.freeze`，工具**无权**覆盖。

**4.3 工具怎么"返回图片"**：`execute` 只回 JSON 值，模型可见内容由 `ToolOutputDefinition.render(args, value): ContentBlock[]` 投影（`dsh-tools/lib/types/index.d.ts:110`）。树内唯一真实例子（`read_image`）：
```js
// dsh-tool-fs/lib/index.js:950  imageReadContent
[ { type:'text',  text: formatImageReadOutput(value.path, value.image) },
  { type:'image', attachment: imageRefFromValue(value.image) } ]   // :917 重铸为 ImageAttachmentRef；接线 render :994
```
结果形状 `ToolResult{content: ContentBlock[], isError, meta?}`（`dsh-tools/lib/types/index.d.ts:193-204`），成功态 `ToolExecutionSuccess.content`（:417）。工具侧有比框架更严的**自设门禁**：`assertImageCapableRoute()`（`dsh-tool-fs/lib/index.js:898-906`）先证明路由声明 image，否则报错让用户换模型 —— **不降级**。
**真正产出图片的调用点**：`read_image`（`dsh-tool-fs/lib/index.js:1015`）、MCP 外部工具结果（`dsh-mcp-client/lib/index.js:340`→:343，失败降级为文本诊断）、ACP 入站图（`dsh-acp/lib/index.js:126`）、`dsh-commands/lib/index.js:457`。**无 screenshot 类工具**。

**4.4 spill 不用于附件，但有一个可借用的文本缝**：`ctx.spillStore` 只有 `saveText(input): Promise<SpillRef>`（`dsh-spill/lib/types/index.d.ts:41-48`），**纯文本**。`dsh-spill-policy` 在工具结果超 token 预算时保留文本头尾、把图片视为不可分割整体（`lib/types/retention.d.ts:1-21`、`notice.d.ts:8-13`），并生成 `[Image: "<path>"; <mediaType>; WxH. Use read_image to view it.]` 这类**指向工具的文本占位**（`dsh-spill-policy/lib/index.js:168-177`）—— 这是"丢图但给模型一条线索"的既有范式，值得在自研桥接的兜底文案里沿用。

## 5. 按请求改模型 / 切模型点

**5.1 `LlmCallConfig`**（waterfall 传输物，`dsh-llm/lib/types/call-config.d.ts:16`）：`{provider; model; reasoningEffort?; temperature?; maxTokens?; stop?}`——只有 `provider`+`model` 能换模型。`:28 LlmCallConfigAdapterDefaults{reasoningEffort?:true; maxTokens?:true}`；`:40 callConfigEquals(a,b)`；`:46 markAgentLoopRequest`；`:52 isAgentLoopRequest`。文件头 :1-7 说明这些是 request-header 状态，waterfall 替换、loop 记录变更快照而不许静默漂移。

**5.2 `agent/request` —— per-request 换模型的正门**
```ts
// dsh-agent/lib/types/runtime-types.d.ts:327
'agent/request'(this: Scoped<Agent>,
  payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>;
```
```js
// dsh-agent-loop/lib/index.js:1148-1185  prepareRequest
const seedConfig = deepFreeze(structuredClone(...));                    // :1159 ← seed 深冻结
const proposedConfig = await this.dispatch.waterfall('agent/request', {turn,step,signal}, () => Promise.resolve(seedConfig));
if (!proposedConfig.provider || !proposedConfig.model) throw new Error(`agent "${this.id}" has no provider/model: ...`);   // :1170
preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal);   // :1174 真正换路由；NO_ADAPTER 回退 :1176-1179
```
要点：① **seed 深冻结，就地 mutate 无效/抛错，必须 `return` 替换对象**；② **只有 6 个字段被采纳**，其它键丢弃；③ **payload 看不到消息内容**（文档 :311-326 明说 "cannot mutate messages"）→ **无法仅凭 `agent/request` 按图选路**；④ 时机 `step()` 开头、`systemPrompt.project` 之前（:1035），结果写入持久 `request/header`（:1198-1213，reason `initial|resume|change`）；⑤ 官方覆盖范式 `dsh-agent/lib/types/model-selection.js:61-75`（先 `await next()` 再整体覆盖 provider/model，并显式剥离继承的 `reasoningEffort`）；条件式变体 `dsh-webhook/lib/index.js:126-136`（仅首个 header 前覆盖）。

**5.3 `agent/pre-step` —— 唯一能改写本轮消息的地方**
```ts
// dsh-agent/lib/types/runtime-types.d.ts:304
'agent/pre-step'(this: Scoped<Agent>,
  payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
// :92
export type PreStepDecision = { kind:'reject' } | { kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true };
```
```js
// dsh-agent-loop/lib/index.js:911
const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal },
    () => Promise.resolve({ kind:'enter', messages: context === undefined ? claimed : [...claimed, context] }));
if (decision.kind === 'reject') return decision;
return { ...decision, assembly };                                       // :921-924
```
注意默认 decision 里**可能追加了一条 runtime-context 消息**，改写时别丢。agent 面共 3 个 waterfall：`agent/pre-step`、`agent/request`、`agent/request-error`（:302/325/346）。

**5.4 `installModelSelection` —— per-agent 正式选择（会留痕）**（`dsh-agent/lib/types/model-selection.d.ts`）：`ModelSelection{provider; model; reasoningEffort?}`（:16）、`ModelSelectionRef{current; assembled}`（:25）、`installModelSelection(agentCtx, selection): () => void`（:49）。语义（:31-43）：assembly 先快照 selection 再应用 provider/model/effort；**provider/model 变化会往下一个已接纳请求追加一条 durable user-role 通知**（source kind `'model-selection'`），effort-only 不留痕。实现体共三处监听（`dsh-agent/lib/types/model-selection.js:45-88`）：`system-prompt/assemble` 把 provider/model 写进 prompt variables（:46-59）、`agent/request` 覆盖 route（:61-75）、`agent/pre-step` 以 `on(..., {prepend:true})` 注册并 `return {...decision, messages:[...decision.messages, modelSwitchNotice(...)]}`（:76-88）—— **首方自己就在 pre-step 里改写 `decision.messages`**，这为 §9.2 的"图→文改写"提供了直接先例与 `{prepend:true}` 监听顺序技巧。会话级入口 `session/selectModel`（`dsh-api-session-controller/lib/index.js:720-748` → durable `model/selection` :319-322 → `installModelSelection`）；UI 走这条（`dsh-client-ui-model-selection/lib/client.js:237`，host 半边为空 `lib/index.js:9`）。

**5.5 全局默认、per-agent、preset、子代理**
- `ctx.agentDefaultModel`（`dsh-agent-default-model/lib/types/index.d.ts:8,42,50`）：`Config{provider, model, reasoningEffort}` 全 `Volatile`（:12-19）；**单例服务**（`lib/index.js:27`），`saveSelection` 经 `configEditor.edit(entry,…)` 写 owning fiber 的 composition entry（profile YAML，:53-66）→ **全局/部署级持久，不影响已存在 agent**。schema `required().volatile()`，**无代码兜底**；缺失时 `agentOptions()` 返回 `{provider:'',model:''}`（`dsh-api-session-controller/lib/index.js:460-466`）并在 loop:1170 抛错；唯一引导兜底 `initializeDefaultModel()` 无 key 时取 `deepseek-account` 组首模型（同文件 :2986-2997）。模型默认值**不走 settings 服务**（`agent-default-model/lib/index.js:30-32` 显式 `settings.configure({auto:false})`），只走 `configEditor`。
- `AgentOptions{provider?, model?, reasoningEffort?, maxTokens?}`（`dsh-agent/lib/types/runtime-types.d.ts:21-30`）：per-agent，创建期 seed，之后由 header 接管。
- **agent preset 不带模型字段**：`PresetDefinition` 只有 `id/name/description/order/plugins`（`dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`）；给 preset 配模型只能靠它挂的插件（如挂 `tool-subagent` 实例配 `agentOptions`，或挂自研插件注册 `agent/request`）。
- **子代理可用不同模型（有白名单）**：`DelegationModelRequest{provider?, model?, reasoning_effort?}`（`dsh-tool-subagent/lib/types/model-selection.d.ts:32`；模型可见 schema `lib/index.js:412-425`，`modelSelectionSettings` 默认关）；每实例默认 `agentOptions?`（`lib/types/index.d.ts:45`）；策略 `SubagentModelSelectionSettings{enabled, allowedModels}`（`model-selection-settings.d.ts:13-18`）+ 强制点 `assertAllowedModelSelection`（`model-selection.d.ts:63`）；底层 seam `SubagentRequest.agentOptions?`（`dsh-subagent/lib/types/types.d.ts:156-162`，需 `SubagentCapabilities.agentOptions`）。合并 `resolveChildAgentOptions`：**父的最新 request header 优先于创建选项**，改 route 未指 effort 会清掉父的 effort（`dsh-subagent/lib/types/child-agent.d.ts:33-52`）。agent-team 只有 provider 投影字段（`dsh-experimental-agent-team/lib/types/types.d.ts:36,48-50`），无模型覆盖。另有 webhook `WebhookModelSelection{provider,model,maxTokens?}`（`dsh-webhook/lib/types/types.d.ts:23-30`）、ACP `AcpModelControl.set`/`pinTurn`（`dsh-acp/lib/types/model-control.d.ts:35,54`）。

**5.6 官方切换点优先级（第三方插件该用哪个）**：① 创建期 `AgentOptions`（per-agent，持久）→ ② 全局 `agentDefaultModel`（持久，仅 seed/回退）→ ③ `session/selectModel`→`installModelSelection`（持久、留痕、下一步生效）→ ④ **`agent/request` waterfall（per-step、非持久；第三方插件的预期使用点）** → ⑤ 子代理 `agentOptions`（受白名单约束）。**`llm/stream` 不是切换点**：loop 请求带 `markAgentLoopRequest` 且**深冻结**（`dsh-llm/lib/types/index.d.ts:37-42` "listeners read it, never rewrite it"），`PreparedLlmCall.stream` 还要求 call-config 一致否则 `INVALID_PREPARED_CALL`（:108-115）；但自建 `ctx.llm.stream(options)` 另选 provider/model 是**合法途径**（插件做独立副调用就走这条）。llm 面**没有** `llm/request`/`beforeRequest`（零命中）；`providerOptions`/`overrideModel`/`setModel(` 亦零命中。
> **既有的"按用途换模型"先例（不含 vision，正是桥接该抄的形态）**：压缩可用 `config.summarizationProvider/summarizationModel`（`dsh-compaction-basic/lib/types/types.d.ts:17-20`，解析 `lib/index.js:292-303` `const target = configured ?? latest ?? agentTarget`）；标题可用 `config.provider/model`，否则回退会话路由（`dsh-session-title-llm/lib/index.js:139-145`）。两者都手搓 `ctx.llm.stream`，**不经** `agent/request`。**无"按内容/图片自动换模型"的实现**，只有能力准入与 `serializeImageAdmission` 串行化（`dsh-api-session-controller/lib/index.js:348-352`）。

## 6. 已有的一跳调用

**6.1 `GenerateOptions`**（唯一入口 `ctx.llm.stream(options): AsyncIterable<StreamChunk>`，`dsh-llm/lib/types/index.d.ts:412`）
```ts
// dsh-llm/lib/types/types.d.ts:489
{ provider: string; model: string;                  // ← 路由（选 adapter）
  reasoningEffort?: ReasoningEffortId;
  messages: RequestMessage[];                       // ← 图片只能在这里（ImageBlock）
  system?: string; tools?: ToolSchema[]; toolHistory?: ToolHistory;
  temperature?: number; maxTokens?: number; stop?: string[]; signal?: AbortSignal;
  sessionId?: Branded<'SessionId'>;
  purpose?: 'compaction' | 'session-title'; }       // :530 ← 闭集
```
**`GenerateOptions` 没有任何 image/attachment 字段**。兄弟 API：`prepareCall(config,signal)`（:386）→ `PreparedLlmCall.stream(options)`（:115）、`resolveModelInfo`（:360）、`resolveCallConfig`（:374）；**没有** `generate`/`complete`/`call`。

**6.2 `purpose` 不可自定义**：闭合字面量联合（types.d.ts:530，typert 声明同字面量 `dsh-llm/lib/typert.host.js:313`），非 branded、无 registry、**无运行时校验**（`stream()` 非 `@Remote`，无 zod）。适配器只用 `===` 比较：`dsh-llm-deepseek/lib/index.js:1689`（`'session-title'` → 强制 `reasoningEffort:'off'`）、:2172（传输元数据）、:2197（`'compaction'` → HTTP 头 `x-deepseek-harness-compact:1`）。**结论：别填自定义值（TS 拒绝、运行时等同 undefined、没人识别）；建议留空，用自己的日志事件标记桥接调用。**

**6.3 收文本 + 真实范式**：`StreamChunk`（types.d.ts:417-447）= `block-start{index,blockType} | text-delta{index,text} | reasoning-delta | tool-call-delta | block-end{index,block} | usage | finish{reason,replayState?}`；`FinishReason = stop|tool-calls|max-tokens|aborted|error`（:131-151）。标准汇聚工具 `BlockAssembler`（`lib/types/assembler.d.ts:22-73`：`push(chunk)`/`blocks()`/`interruptedBlocks()`/`usage`/`finish`（无 finish 默认 `{kind:'stop'}`）/`message(source)`）。
```js
// dsh-session-title-llm/lib/index.js:197-235（可当模板）
const options = deepFreeze({ provider: route.provider, model: route.model,
  messages: [ createUserMessage({ content:[{type:'text', text: framedInput}], source:{kind:'dsh-session-title-llm'} }) ],
  system, maxTokens: config.maxOutputTokens, sessionId: request.session.id,
  purpose: 'session-title', signal: callDeadline.signal });
const assembler = new BlockAssembler();
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);        // :226
const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join(' ');
```
其他范式：手写无身份输入 `messages:[{role:'user', content:[{type:'text',…}]}]`（`dsh-experimental-auto-review/lib/index.js:401-415`，无 purpose）；压缩 `purpose:'compaction'`（`dsh-compaction-basic/lib/index.js:312-323`）；自定义 `source.kind` 的 merge-declare 写法（`dsh-session-title-llm/lib/types/index.d.ts:9-15`）。
**⚠️ 桥接调用同样受 §2.2 投影影响**：若选的 route 其实没声明 `image`，"看图"请求会被换成 `[image omitted ...]`，模型会一本正经地描述"图片被省略了"。**必须先用 `resolveModelInfo` 证明该 route 声明了 `image`。**

## 7. 是否已有现成的视觉桥接：**没有**

全树 grep（`describeImage|describe image|imageToText|image-to-text|imageCaption|multimodal|\bvlm\b|\bocr\b|caption|vision|screenshot|supportsImage|acceptsImage|imageSupport`）分类：**能力标志/门禁**（§1.3 各处，只答"能否收图"，不转换）；**文本占位** `textOnlyImageText`/`projectImagesForTextModel`（content.js:47/240，不是描述）；**丢图给线索** `dsh-spill-policy/lib/index.js:168-177`（文本重定向，非转换）；**看图工具** `read_image`（`dsh-tool-fs/lib/index.js:973-1046`，把图交给**模型自己**看，要求模型支持 image）；**反向能力** `dsh-compaction-image-offload`（丢图换占位 + retry）；**假匹配** excel 预览 `saveImage(ctx)`、i18n/CSS `caption`、文档 `screenshot`、office 技能 `visual`。
**架构先例 `speechToText`**（模态→文本的**服务化**范式，但不走 LLM）：服务 `speechToText`（`dsh-experimental-speech-to-text/lib/index.js:18`，Context 声明 `lib/types/index.d.ts:6-11`）提供 `register()`（:40）/`resolve()`（:83）/`transcribe(spec,signal): Promise<Transcript>`（:90）；provider 契约 `transcribe({audio:Uint8Array, language}, signal)` → `Transcript{text, audioSeconds, inferenceSeconds}`（`lib/types/types.d.ts:97-117`）；本地 provider 注册 `dsh-experimental-speech-to-text-sensevoice/lib/index.js:914,930-946`（`inject=["speechToText","subprocess"]`）；远端控制器 `dsh-experimental-api-speech-to-text/lib/index.js:135,195-215`（失败包 `RemoteError("speech/transcription-failed")`）。
**结论**：DSH 只有"图像作为原生多模态输入"，**不存在**"注册一个图片→文本转换器"的扩展缝。想做通用能力可模仿 `speechToText` 定义自己的 `visionDescribe` 服务（`register/resolve/describe`）+ provider 供多个插件复用；对本项目直接自研一个插件即可。

## 8. 不确定 / 未查到的点

1. **`agent/pre-step` 改写消息的下游副作用**：已被首方实践部分证伪——`installModelSelection` 自己就在 pre-step 里 `return {...decision, messages:[...decision.messages, notice]}`（`dsh-agent/lib/types/model-selection.js:76-88`），说明"改 decision.messages"是被认可的；**仍未验证的是"替换（而非追加）既有 user 消息内容、并用 `freezeMessage` 保住原 MessageId"**是否有隐含假设（steering 回执、`agent/inbox/claimed` 记录、UI 侧消息去重）。
2. **换模型对 prompt cache 的影响未实测**：`callConfigEquals`（call-config.d.ts:40）会把每轮不同 route 判为"真变化"并写新 header；缓存失效/成本增量未量化。
3. **`agent/request` 与 `installModelSelection` 同时作用**时的最终胜出顺序未读实现体（仅读声明与文档）。
4. **pi-ai 的 `input` → `inputModalities` 完整摊平链**只读了 3 个赋值点（`lib/index.js:1802/1821/2290`），未通读 catalog 物化流程。
5. **DeepSeek 内置 catalog 里究竟哪些模型声明了 image**：只见 `lib/index.js:46` 一处 `['text','image']`，未枚举全表。
6. **`agent/pre-step` 的 `startsRequestSeries` 语义**未深挖（可能与缓存/系列切分相关，桥接若改写消息或许需要它）。
7. **QQ 侧取图**：DSH 无"从 URL 下载并登记图片"的一体 API；`ctx.fs.readBytes(path, signal, cap)`（`dsh-tool-fs/lib/index.js:1009`）只读执行世界内路径，`dsh-web-fetch-http` 未确认能否取二进制。
8. **`ctx.fs.readBytes` 的确切签名与上限语义**未逐字确认（只在工具里见过调用形态）。
9. **`requiredImageOffload` 完整实现**（content.js:215-226）与 offload 选择算法未读全。
10. **用户 profile 侧第三方插件**（`.dsh\profiles` 下）是否有外部 vision 插件未检查（junction 可能失效）。
11. **`MAX_IMAGE_BYTES = 32MiB`**（`dsh-llm-deepseek/lib/index.js:910`）用途未逐一追踪（疑为 Files API 上传上限）。
12. **`imageLimits` 是否有下发给浏览器端的 RPC**未找到（`dsh-client-ui-conversation/lib/types/client/image-labels.d.ts:22` 只是本地化文案签名）；`dsh-client-ui-attachment` 宿主侧是空实现（`lib/types/index.d.ts:3`），纯展示。

## 9. 给实现者的最小可行方案

**9.1 现成 vs 自研**
| 环节 | 现成？ | 用什么 |
|---|---|---|
| 判断当前路由是否支持图片 | ✅ | `ctx.llm.resolveModelInfo(provider, model)` → `inputModalities.includes('image')` |
| QQ 图片字节 → 持久引用 | ✅ | `ctx.attachments.saveImage({data, mediaType, name})` |
| 图片放进消息 | ✅ | `ImageBlock{type:'image', attachment: ref}` + `createUserMessage` |
| 非视觉模型"不崩" | ✅（但丢内容） | 框架自动 `projectImagesForTextModel` → `[image omitted ...]`（仅当模态显式纯文本） |
| 本轮换模型 | ✅ | `agent/request` waterfall `return` 替换后的 `LlmCallConfig` |
| 改写本轮消息（图→文） | ✅ 机制 | `agent/pre-step` waterfall + `freezeMessage` |
| 一跳视觉调用 | ✅ | `ctx.llm.stream(GenerateOptions)` + `BlockAssembler` |
| **图片→文字描述本身** | ❌ **自研** | 视觉模型 prompt + 输出清洗 |
| **"何时桥接"的决策与缓存** | ❌ 自研 | pre-step 判定 + `attachmentId` → 描述缓存 |
| **QQ 取图/解码/媒体类型嗅探** | ❌ 自研 | 网络下载 + 魔数嗅探（框架未导出 sniff） |
| 自定义消息来源标签 | ✅ 机制 | merge-declare `MessageSourceMap`（范式 `dsh-agent/lib/types/model-selection.d.ts:8-14`） |

**9.2 三条路线**
- **A · 纯切模型（最小改动）**：`agent/pre-step` 扫 `payload.messages[*].content` 找 `type==='image'`，命中则在本 agent 的 scoped 状态置位；`agent/request` 里置位则 `return {provider: visionProvider, model: visionModel, reasoningEffort, maxTokens}`。约 30 行、全现成 API。缺点：**整轮**都跑在视觉模型上（记忆/人设/成本/缓存全变）。
- **B · 真桥接（推荐，主模型不变）**
  1. 配置 `visionProvider/visionModel/describePrompt/maxDescribeTokens/timeoutMs`。启动时用 `ctx.llm.listProviders()` + `listModels(provider)` 过滤 `inputModalities?.includes('image')` 出候选，并用 `resolveModelInfo` **硬校验**（不通过就禁用桥接并告警）。配置形态可抄压缩的 `summarizationProvider/summarizationModel`（§5.6）。
  2. `ctx.on('agent/pre-step', async (payload, next) => {...}, { prepend: true })`（`{prepend:true}` 抄 `model-selection.js:88`，保证在其他 pre-step 监听者之前改写）：`const decision = await next(); if (decision.kind==='reject') return decision;` → 对 `decision.messages` 中含 `ImageBlock` 的用户消息逐 `ref` 取缓存或发起 `ctx.llm.stream({provider:V, model:M, maxTokens, signal: payload.signal, messages:[{role:'user', content:[{type:'image', attachment: ref}, {type:'text', text: describePrompt}]}]})` → `BlockAssembler` → 拼 `type==='text'` 块 → 按 `ref.attachmentId` 写缓存 → `freezeMessage({...msg, content: [ {type:'text', text:`[图片描述] ${desc}`}, ...非图块 ]})` 替换 → 返回 `{...decision, messages: rewritten}`（**保留**默认 decision 里追加的 runtime-context 消息）。
  3. 兜底：描述失败 → 退回框架同款占位文本（或 §4.4 那种"指向 read_image"的线索文案），**绝不**让 pre-step 抛错阻断整轮。
  - 优点：主模型/人设/记忆链路不变；图片仍以 `ImageBlock` 留在 durable 历史（UI 可显示、可审计）。风险：pre-step 内网络调用**抬高首 token 延迟**（加超时；多图 `Promise.all` 并行；可考虑异步预热）。
- **C · 工具化（按需，须配合 A/B）**：注册 `describe_image(attachment_id)` 工具返回 `[{type:'text', text: desc}]`。单用不行——非视觉模型看到的占位文本只有 sha256 前 8 位、**没有 id/路径**，无从调用；必须由 A/B 在 pre-step 注入"存在图片，可调 `describe_image(attachmentId=…)`"的提示（正是 §4.4 spill-policy 文案的思路）。适合"图多、只想看几张"的省钱场景。

**9.3 QQ 入站接线（自研部分的最小闭环）**
```
QQ 图片消息
 → 插件下载字节（自带 HTTP），魔数嗅探 mediaType（png/jpeg/webp/gif）
 → 超限则先自行降采样（>20MiB / 单边 >8192px / 像素 >64e6；目标 2048² / 4MiB 以内）
 → ctx.attachments.saveImage({ data, mediaType, name }) → ImageAttachmentRef
 → createUserMessage({ content: [ {type:'image', attachment: ref}, ...(文本? [{type:'text',text}]:[]) ],
                       source: { kind:'qq', ...自定义字段 } })     // kind 需 merge-declare，否则用 'user'
 → agent.followup(msg)    // 运行中可 agent.steer(msg)（dsh-agent/lib/types/runtime-types.d.ts:192/200）
```
`ctx.fs.readBytes` 只能读执行世界内路径，**没有**"从 URL 取图并登记"的一体 API —— 这是最大的自研空档。（若走 HTTP 上传形态，另有 `ctx.fileUploads` + `/api/session/uploadFileBinary`，但那是浏览器/客户端通道，不解决服务端主动拉图。）

**9.4 落地检查清单**
1. 先做 `visionRoute` 健康检查：`resolveModelInfo` → `inputModalities?.includes('image') === true`；不成立就**别**开桥接（否则得到"图片被省略"的假描述）。
2. 桥接调用一律带 `signal: payload.signal` + 自身 timeout；多图并行。
3. 描述结果按 `attachmentId` 缓存；改写消息用 `freezeMessage` 保住 `MessageId`。
4. 能力判定显式处理 `undefined`（未知）——框架不会替你降级，适配器会直接 `UNSUPPORTED_CONTENT`。
5. 非视觉路径的最后一公里**已由框架兜底**（占位文本），所以插件失败模式是"退回框架行为"而非崩溃 —— 可安全灰度。
6. 只做 per-request 静默换模型 → `agent/request`；要用户可见的"已切到视觉模型"提示 → `installModelSelection` 或自行 `session.append`。
7. 别指望 `purpose` 或 `llm/stream` waterfall 帮你做任何路由/转换；`agent/request` 里也拿不到消息内容。
