# DSH Web 栈 · 第三方插件扩展能力调研报告（0.1.7-rc.2 / Windows 本机实测）

## 0. 路径基准与前提勘误（先读）

**真实包根**（`.dsh\profiles\node_modules\@deepseek-ai\*` 下大量 junction 已断链，指向不存在的 `<pkg>\node_modules\...`，必须用扁平真路径）：
`<ROOT> = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`

任务给出的三条前提需纠正：
1. **没有 hono，也没有 express**。`dsh-host-webserver` 是原生 `node:http`，依赖仅 `compression` + `negotiator` + `schemastery`。
2. **`dsh-web` 不是 web UI bundle**，它是 web_search/web_fetch 的能力 seam（`ctx.web` = `WebRuntime`，`<ROOT>\dsh-web\lib\types\index.d.ts`）。真正的 bundle 是 **`dsh-web-app`**。
3. **`dsh-authorization` 与浏览器鉴权无关**，它是凭据获取流程 seam（OAuth 式 `ctx.authorization.registerFlow`）。浏览器鉴权在 **`dsh-client-connection`**。

另：`dsh-settings-file` 不存在；`dsh-client-runtime` 在本机不存在（断链）；**`dsh-plugin-mgr` 全盘未找到**（只有核心包 `dsh-plugin-manager`）。社区样例改用真实第三方插件 **`dsh-notify`**（`C:\Users\HiBer2007\.dsh\profiles\web\node_modules\dsh-notify`，含 web 客户端半边）与 `dsh-working-activity`。

---

## 1. Web UI 怎么构建、怎么服务

**装配**：`<ROOT>\dsh-web-app\cordis.patch.yml`（由 `dsh-web-app\package.json` 的 `dsh.bundle.patch` 声明）。关键行 id：
`web-startup`=`@deepseek-ai/dsh-web-app/startup`；**`webserver`=`@deepseek-ai/dsh-host-webserver`**，`config: { host: !!js ctx.webStartup.host ?? '127.0.0.1', port: !!js ctx.webStartup.port ?? 3080, compression: gzip, compressionLevel: 1, compressionThresholdBytes: 1024 }`；`web-runtime`=`@deepseek-ai/dsh-web-app`；`modules`=`@deepseek-ai/dsh-client-modules`；`connection`=`@deepseek-ai/dsh-client-connection`（`trustedHosts: !!js ctx.webRuntime.trustedHosts`）；另有 `client-hmr`/`file-upload`/`api-remotes`/`cordis-client-runner` 与全部 `ui-*` 客户端包。

**HTTP 服务**：服务名 `ctx.webServer`，`class WebServer extends Service`（`<ROOT>\dsh-host-webserver\lib\types\index.d.ts`）。
```ts
interface Config { host: '127.0.0.1'|'0.0.0.0'; port: number; compression?: 'none'|'gzip'; compressionLevel?: number; compressionThresholdBytes?: number }
register(route: WebRoute): () => void;      registerUpgrade(route: WebUpgradeRoute): () => void;
registerFallback(handler: WebRoute['handler']): () => void;   tapIndex(transform: (html:string)=>string): () => void;
renderIndex(html: string): string;          collectIndexInjections(): IndexInjection[];
type WebRouteKind = 'exact' | 'prefix';
interface WebRoute { kind: WebRouteKind; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
```
匹配序：exact 全表 → 最长 prefix → fallback；重复 `(kind,path)` throw；fallback 唯一（第二个 throw）。事件：`'webserver/index-inject'(table: IndexInjection[]): void`（emit）。

**前端是预构建产物，不 on-the-fly**：`<ROOT>\dsh-web-frontend\dist\` = `index.html`(825 B，单页单入口 `<div id="root">`) + `assets\index-Q6zc2uHV.js`(629 KB) + `vendor-CCJJTK99.js`(740 KB) + CSS/字体/`langs\*.js`。定位方式（`<ROOT>\dsh-web-app\lib\index.js:108-114`）：
```js
const require = createRequire(import.meta.url);
return join(dirname(require.resolve("@deepseek-ai/dsh-web-frontend/package.json")), "dist", "index.html");
```
`apply()` 内 `ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })`（`:176`）—— **`frontend-static` 没有独立 loader 行**。

**静态服务**：`<ROOT>\dsh-host-frontend-static`（`name = "frontend-static"`, `inject = ["webServer","connection"]`, `Config { distIndex: string }`）。抢 webserver 唯一 **fallback 席位**（`lib\index.js:87-96`）：非 GET/HEAD→405；越出 distRoot→403；`target===distRoot || target===distIndex` → 先 `ctx.connection.authorizeIndex(req,res)` 再 `ctx.webServer.renderIndex(...)`（并注入 `<base href="./">`）；其余 `readFile`，ENOENT/EISDIR/ENOTDIR→404。**没有 SPA history fallback**，**没有额外静态根配置 / 无 `frontend/static` 事件**。

**插件自服务资源的三条路**：
- 路由：`ctx.inject(['webServer'], w => w.effect(() => w.webServer.register({ kind:'prefix', path:'/my-plugin', handler }), 'label'))` —— 模板见 `<ROOT>\dsh-client-modules\lib\index.js:545-552`（`PLUGIN_ROUTE = "/plugins"`）与 `dsh-notify\lib\index.js:313-350`。
- 静态字节：自己读文件写 `res`；可复用导出的 `serveStatic(pathname,res,distRoot,distIndex,authorizeIndex,renderIndex)`（`dsh-host-frontend-static\lib\types\index.d.ts:37`）。
- 注入 HTML：`ctx.on('webserver/index-inject', table => table.push({ kind:'style', text }))`；`IndexInjection` union = `global | script | script-src | script-preload | style | html`（`lib\types\injections.d.ts:13-51`）。

---

## 2. 客户端模块系统：插件 UI 代码怎么进浏览器

**唯一机制 = `package.json` 的 `dsh.client` 字段 + `exports["./client"]` 子路径导出。**（**不存在** `dsh.client.entry` / `exports` / `css` / `i18n` 字段，也**不是** export condition。）

权威 schema：`<ROOT>\dsh-package-manifest\lib\types\types.d.ts:76-89`
```ts
export interface DshClientManifest {
  platform: string;        // Web 消费者只选 'web'
  inject?: string[];       // "Informational package-name dependencies, not Cordis service injection."
  immediately?: boolean;   // 阶段一预取
  external?: string[];     // 平台基线之外的精确模块请求，含 <pkg>/client 子路径
}
```
宿主解析（`<ROOT>\dsh-client-modules\lib\index.js`）：
- `:61-75` `parseDshClient(pkgName, value)`：只校验类型（`platform` 必须 string、`inject`/`external` 必须 string[]、`immediately` 必须 boolean），多余字段静默忽略。
- `:713-717` `decl === undefined || decl.platform !== "web"` → 该行不是客户端包（负结论缓存，重启前不变）。
- `:170-181` `clientExportOf()`：`exports["./client"]` 必须是 string 或 `{default: string}`；声明了 `dsh.client` 却无此导出 → throw。
- `:743-773` `locatePkgJson()`：只扫**当前 Loader entry 的 name**；`cordis:` 开头跳过，子路径/scheme specifier 跳过；`nearestPackage()` 向上找 `package.json` 且 `name` 必须匹配。扫描是增量的（`ctx.on("internal/plugin", …)` 打脏 + microtask flush，`:525-556`）。
- 服务：**`ctx.clientModules`** = `ClientModuleRegistry extends Service`（`lib/types/index.d.ts:31-36,78`）。方法 `graph()` / `clientPath(id)` / `fetchBundle(request)` / `artifactBaseline(id)` / `rebuilt(id)` / `onRebuilt` / `onGraphChanged`。**没有 register/define/list**——注册完全靠包元数据。

**浏览器引导**（`lib/index.js:453-498` `bootInjections()`，4 类 index 行按执行序注入 `<head>`）：内联 queue facade（`window.__ModuleLoader__ = { mode:'queue', pendingQueue, load(r){...}, create(options){...} }`）→ application combo 的 `script-preload` → bootstrap combo 的 parser-blocking `script-src` → `{kind:'global', name:'__DSH_BOOT__', value: graph}`。shell 随后 `__ModuleLoader__.create({ boot: __DSH_BOOT__, staticModules: WS() })`。

**bundle 契约**（`lib/types/client/manifest.d.ts:170-222`）：脚本唯一动作是
```js
window.__ModuleLoader__.load({ id: "<pkg 名>", factory: (require) => { /* exports.apply / exports.inject */ } })
```
`ClientBundleRequire`：同步 `require(spec)` + `require.async(spec) => Promise`。模块体副作用（含 CSS 注入）延迟到 materialize，`loadCache` 记忆化。

**最小真实样例（第三方，可直接照抄）**：`C:\Users\HiBer2007\.dsh\profiles\web\node_modules\dsh-notify`
```jsonc
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js", ... },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-conversation"] } }
```
```js
// lib/client.js（133 行，手写 CJS-factory，无需构建工具）
window.__ModuleLoader__.load({ id: "dsh-notify", factory: (require) => {
  var module = { exports: {} }, exports = module.exports;
  var react = require("react");                       // ← 平台种子，免费
  function apply(ctx) { ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({ name:'conversation.session.header.utilities', id:'dsh-notify', order:100 }, Bell)) }
  exports.apply = apply; exports.inject = ['slots'];  // ← cordis 服务名，不是包名
  return module.exports;
}});
```
更小的第一方样例：`<ROOT>\dsh-client-ui-brand-official`（`lib/client.js` 1863 B；host 半边 `lib/index.js` 全文只有 `function apply() {}`）。

**服务注入靠 bundle 自己的 `exports.inject`**（cordis 服务名如 `['slots']`）；`dsh.client.inject` 只是包名依赖边，影响 factory 到达顺序。**指向不存在的包会被静默忽略**（`:657-658` `const dependency = this.graphRows.get(packageName); if (dependency !== void 0) …`），所以 `dsh-notify` 声明本机不存在的 `dsh-client-runtime` 仍正常工作。会炸的只有"包存在但加载失败"与真实到达环。**UNCERTAIN/文档差异**：README 称 "Composition rejects … missing suppliers"，但 `orderByModuleGraph`（`:415-437`）只遍历 `external` 且 `if (dependency !== void 0) visit(dependency)` —— 代码层面缺供应商同样只是跳过。

**平台种子表（可免费 `require`，无需 `external`）**：`dsh-web-frontend\dist\assets\index-Q6zc2uHV.js` 内 `function WS(){ return { react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit" } }`。其他依赖必须内联进 bundle 或写进 `dsh.client.external`。

**URL 形态**（`PLUGIN_ROUTE = "/plugins"`，`:201`）：
| 用途 | URL |
|---|---|
| entry combo（真实入口） | `plugins/??<pkg>/client.js&rev=<rev>`（文档相对；`comboSearch` `:203-209`） |
| 动态分块 | `/plugins/<pkg>/client.<name>.js?rev=<rev>`，严格匹配 `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`（`:169`） |
| 实时图更新 | SSE `GET /plugins/events`（`dsh-client-hmr` 注册 `{kind:"exact"}`），帧 `{type:'rebuilt',id,rev}` / `{type:'graph',graph}` |

⚠️ **`/plugins/<pkg>/client.js` 不匹配 `CLIENT_CHUNK` → 404**；`dsh-working-activity\src\client\index.ts` 注释里的该 URL 形态是错的。

**构建约束**：必须 tsdown 预打包成 CJS-factory（**非 ESM**），`lib/client.js` 缺失 → 激活期 `MissingClientBundleError`；`.module.css` 编译成内联字符串 + `<style data-plugin data-plugin-css>` 注入块（在 factory 闭包内，例 `dsh-client-ui-goal\lib\client.js` 的 `\0dsh-css:` region）；分块必须自包含（不能同步 require 另一个相对 `client*.js`）。

**`dsh-client-resources` 不是模块服务**：host 半边 `lib/index.js` 只有 `function apply() {}`；浏览器半边提供 **`ctx.resources`**（`register(provider)` / `pin(address,signal)` / `source(address)`），地址协议 `dsh-resource://<protocol>/…`，`ResourceProtocolMap` 在 ui-slots 里 declaration-merge。

---

## 3. UI 贡献点清单

**核心 = slot 系统**。`<ROOT>\dsh-client-ui-slots`（纯核心：`interface SlotMap`(:17)、`SlotFactoryMap`(:20)、`LocaleNamespaceMap`(:30)、`class SlotCore`(:712)、`type SlotKind = 'single'|'list'|'keyed'|'chain'`(:83)、`type SlotScope = 'root'|'session-maybe'|'session'`(:85)、`SlotComponent<P>`(:343)、`ChildrenDecl`(:158)、`ChainSelect`(:257)、`SlotLabel = string | (() => string)`(:555)）+ `<ROOT>\dsh-client-ui-renderer`（**服务名 `ctx.slots`**，`SlotRegistry extends Service`，`lib/client.js:1323 super(ctx,"slots")`）。

注册 API（两步，硬性）：
```js
ctx.slots.inject('<slot.key>', () => ctx.slots.register({ name:'<slot.key>', ...kindOptions }, Component))
```
kind 专属（`KindOptions` :560）：`keyed`→`key`；`list`→`id`/`order`/`label`；`chain`→`select`(必填)/`priority`。声明方拥有渲染授权：`children` 声明子槽，组件用 `renderSlot` 渲染；越权 → `SlotOwnershipError`，dispose 后 → `StaleAuthorizationError`。三方包必须自己增补契约：`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'my.slot': { kind:'list'; scope:'root'; owner: MyProps } } }`。

| 目标 | 槽位 / API | 类型名 | 注册方式 |
|---|---|---|---|
| **设置页 section** | `settings.section`(list) | `SettingsSectionOwnerProps { close }` | `ctx.slots.register({name:'settings.section', id, order, label: () => t('nav'), locale, children}, Section)` — verbatim `<ROOT>\dsh-client-ui-settings-plugins\lib\client.js:201-212`；声明方 `dsh-client-ui-settings-general\lib\client.js:1107-1147` |
| 设置里加一行 | `settings.general.item`(list) | `SettingsGeneralItemOwnerProps` | 同上，无 owner props |
| **左侧栏图标/面板入口** | `sidebar.panellist`(list) | `SidebarPanelIconOwnerProps {size,active}`；元数据 `{id: MainPanelId; order; label}`，**id 必须＝main 面板 key** | `ctx.slots.register({name:'sidebar.panellist', id, order, label}, Icon)` |
| 左栏底部动作 | `sidebar.footer.action`(list) | `{ wide: boolean }` | 同上 |
| **独立中央面板（最接近"我的页面"）** | `main`(**keyed**/root) | `MainPanelId`；切页 `ctx.layout.selectPanel(id)`（`ILayout`，`dsh-client-ui-layout\lib\types\client\service.d.ts:24`） | verbatim `<ROOT>\dsh-client-ui-plugin-manager\lib\client.js:3428-3491`：`main` + `sidebar.panellist` + `ctx.layout.panelInfo` |
| **右栏 tab** | `sidebar.right.pane.tab`(keyed)/`.title` | `SidebarRightTabDefinition`（`dsh-client-ui-sidebar-right\lib\types\client\tab-registry.d.ts:75`）、`SidebarRightTabPriority='extension'\|'builtin'\|'fallback'`(:44) | 两步：`ctx.sidebarRightTabs.register(def)` + slot 注册；verbatim `<ROOT>\dsh-client-ui-deliverables\lib\client.js:2297-2309` |
| 全局悬浮层 | `shell.overlay`(list/root，click-through) | — | 普通 list 注册 |
| **聊天消息渲染器** | `conversation.chat.node`(**keyed**/session，key=`ChatNodeKind`) | `ChatNodeOwnerProps` / `ChatNodeHookContext` | 复用 key = 替换该节点；verbatim `dsh-client-ui-chat\lib\client.js:6711-6715` |
| **工具渲染器** | `tool.call.toolview`(**keyed**/session，key=**wire tool name**) | `ToolCallHookContext {callId,assistant}` | verbatim `dsh-client-ui-deliverables\lib\client.js:2291-2295`（`key:'present'`） |
| Turn 尾 / assistant 动作 / 命令卡片 | `conversation.chat.turnTail`(list)、`.assistant-actions`(list)、`.commandview`(keyed) | — | list/keyed 注册 |
| 整块可切换视图 | `conversation.view`(list/session) | `ConvViewOwnerProps` | verbatim `dsh-client-ui-trajectory\lib\client.js:8736-8741` |
| 输入区 | `conversation.input.{dock,left,right,activity,attachments,plan,permission,model}`、`conversation.composer.{dock,bar}`、`conversation.composer`(chain) | — | 社区样例：`dsh-working-activity\src\client\index.ts:35-44` 注册 `conversation.input.dock` |
| 会话头按钮 | `conversation.session.header.{actions,utilities,corner,lineage}` | — | verbatim `dsh-client-ui-jobs\lib\client.js:610-621` |
| **客户端命令** | `ctx.commandUi.register(...)`（**不是 `ctx.commands`**） | `CommandUiContract`、`CommandContribution`、`CommandUiSpec = PopupSelectSpec \| ActionSpec` | verbatim `dsh-client-ui-model-selection\lib\client.js:1056-1080`；事件 `'command/executed'` |
| 资源协议 | `ctx.resources.register(provider)` | `ResourceProvider<P>`、`UseResource` | `ResourceProtocolMap` 合并 |
| 原生 HTML 注入 | `ctx.on('webserver/index-inject', …)` | `IndexInjection` | 见 §1 |

**槽位全清单**（约 90 个，跨包 `SlotMap` 合并；已实测枚举）：`root`(禁注册)/`sidebar`(注册=整体替换导航列)/`main`/`rightbar`/`shell.leading`/`shell.overlay`/`shell.quota-notice`、conversation 系列 30+、`sidebar.*`、`sidebar.right.*`、`settings.*`(9)、`plugins.*`(7)、`tool.*`、`deliverables.*`。
**现成目录**：`<ROOT>\dsh-cordis-client-runner\lib\types\client\slot-catalog.d.ts` → `CLIENT_SLOT_API: readonly ClientSlotEntry[]`，每条含 `key/kind/scope/registerOptions/ownerProps/keyDomain/hookContext/slotInject/declaredBy/occupants/replaceRisk/example/source`（运行时数据含逐槽可运行 example）。

### ★ 独立页面裁决：**不支持真实 URL/route**
证据：① `dist\index.html` 单页单入口，无 `<base>`、无多入口；② 整个 `dist\` grep `pushState|location.pathname|history.|location.hash|URLSearchParams|react-router` → **零命中**；③ 全部 `dsh-client-ui-*` 的 `lib/*.js` 同 pattern 仅 2 处，均在 pdf.js 内部（`dsh-client-ui-sidebar-documentpreview\lib\client.pdf.js:27796-27797`）；④ 无 router 依赖，`beginNavigation()` 只返回 AbortSignal（不改 URL）；⑤「页面」的真实对应物是 `main` 槽的 key，切换用 `ctx.layout.selectPanel()`，URL 不变；⑥ 右栏内部的 `dsh-resource://…` / `sidebar://guide` 只是面板内 tab 地址。
**最佳替代**：A（留在 shell 内）`main`(keyed) + `sidebar.panellist` + `selectPanel`；B（真正独立 HTML 页）自注册 `prefix` 路由自服务 HTML（见 §6c）。

---

## 4. 插件 HTTP API 与浏览器鉴权

**三档注册方式**：

**A. 裸 node:http 路由**（`dsh-notify` 在用）——`ctx.webServer.register({ kind:'exact'|'prefix', path, handler(req,res) })`。**完全不过鉴权**（`/plugins` 路由同样不过；grep 无 `connection.admit`）。需自加同源检查：`dsh-notify\lib\index.js:238-242` 读 `req.headers['sec-fetch-site']`，非 `same-origin`/`none` 返回 403。

**B. `/api` 下的 Fetch route（推荐，自动获得鉴权）**——`ctx.connection.fetch.register(route)`：
```ts
interface ConnectionFetchRoute {           // <ROOT>\dsh-client-connection\lib\types\rpc.d.ts:111-120
  readonly path: string;                  // 必须在 /api 之下
  readonly methods: readonly ConnectionFetchMethod[];   // 'GET'|'HEAD'|'POST'
  readonly requestBody: ConnectionRequestBodyMode;      // 'buffered'|'streaming'
  readonly fetch: (request: Request) => Promise<Response>;
}
register(route: ConnectionFetchRoute): () => Promise<void>;   // HostConnectionFetch, :122-129
```
（`HostConnectionService implements HostConnectionHandle`，`get fetch(): HostConnectionFetch`，`rpc-host.d.ts:30`。）

**C. 官方 Typert Remote（重，需构建期代码生成）**——服务 `ctx.typertGateway`（`TypertGatewayService extends Service implements TypertGateway`，`static inject=["typert"]`）。namespace 由 `TypertRemoteService` + `bindTypertRemote(service, key, {namespace})` + `@Remote('method')` 装饰器声明；构建期由 `@deepseek-ai/dsh-typert-generator` 生成 `lib/typert.host.js` / `lib/typert.remote-client.js`（证据：`dsh-api-settings-controller\lib\typert.host.d.ts` 首行 `/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel */`）。网关用 `connection.rpc.intercept("/api", matches, handler)` 挂载（`dsh-api-gateway\lib\index.js:623-625`）；`claimsEndpoint` 要求 endpoint 恰为两段 `<namespace>/<method>`。实例：`super(ctx, "settingsController", { namespace: "settings" })`（`dsh-api-settings-controller\lib\index.js:382`）。

**URL / 信封**：`POST /api/<namespace>/<method>`，`content-type: application/json`；请求 `{ type:'client-request', rpcId, method, payload }`，响应 `{ type:'server-response', rpcId, result: {ok:true,value} | {ok:false,error:{code,message,details}} }`（**不是 `{ok,data}`**）。流式走 WebSocket upgrade `/api/remote.mux`（`REMOTE_STREAM_MUX_PATH`，`registerUpgrade` + `connection.admit`）。

**浏览器鉴权**（`ctx.connection` = `HostConnectionService`，`<ROOT>\dsh-client-connection`）：
- 机制 = **一次性 URL 令牌 → 签名 Cookie**（不是 Bearer / Authorization 头）。`TOKEN_QUERY = "token"`、`COOKIE_PREFIX = "dsh-auth-"`、cookie 名 = prefix + base64url(sha256(authority from `Host` 头))、`createHmac("sha256", secret)`、`HttpOnly; SameSite=Strict; Path=/`、默认 30 天（`cookieMaxAgeDays`）。
- 密钥持久化于凭据库：`credentialKey("client-connection","browser-session")`，record `{kind:"grant", payload:{version:1, secret}}`。
- 进程启动令牌：`PROCESS_LAUNCH_TOKENS`（WeakMap，key=`ctx.root`），`randomBytes(32)` base64url，跨 Connection 重载保留。
- 守卫（`dsh-client-connection\lib\index.js:585-589`）：`isTrustedApiRequest(request, trustedHosts)` 失败 → **403**；`browserAuth.isAuthenticated(request)` 失败 → **401**。
- `/api` 路由挂载（`:830-843`）：`{ kind:'prefix', path: API_PATH /* "/api" */, handler }`；waterfall 事件 `'connection/request'(request, response, next)`。
- Config：`trustedHosts?: string[]`、`cookieMaxAgeDays?: number`、`maxRequestBodyBytes?: number`(300 MiB)。
- 令牌进页面方式：**不注入 HTML**，而是 `connection.authenticatedUrl(webUrl)` 打印/打开（`dsh-web-app\lib\index.js:198-203`）。
- **无 per-namespace 鉴权开关**：凡 `/api` 一律过栅栏 + cookie；要免鉴权只能自己注册非 `/api` 路由。

---

## 5. 设置 / 状态同步

- `ctx.settings` = `SettingsForms extends Service`（`<ROOT>\dsh-settings\lib\types\index.d.ts:62`），`static inject = ["configEditor","profileContext"]`。
- **没有 `register(schema)`**。namespace = **Loader profile entry id**（`SettingsNamespace = Branded<'SettingsNamespace'>`，注释 "Nominal id of one profile plugin entry"）；schema 来自插件自己的 `static Config`（`@deepseek-ai/schemastery` 的 `z.object({...})`）。
- **第三方插件只要声明 `static Config`，Settings UI 就自动生成表单**：`dsh-settings\lib\index.js:426` `const autoGenerate = this.presentations.get(entry.fiber)?.auto ?? true;`。自带页面时关闭：`ctx.settings.configure({ auto: false })`（`:80-82`）。
- 服务 API：`describe(options?) → SettingsDescriptor[]`、`update(ns, patch, expectedRevision?)`、`replace(ns, section, expectedRevision?)`、`mutate(ns, ops, expectedRevision?)`、`get writable`、`get documentPath`、`prepareDocument()`；事件 `'settings/document-updated'(ns, revision)`；冲突 `SettingsConflictError`（`code = "SETTINGS_CONFLICT"`）。
- 浏览器侧 Remote（`dsh-api-settings-controller\lib\typert.remote-client.d.ts:24-37`）：`settings/describe`、`settings/update`、`settings/replace`、`settings/mutate`、`settings/openSettingsDocument`、`credentials/describe|set|unset` → `POST /api/settings/<method>`。视图 `SettingsNamespaceView { autoGenerate; ns; schema; value; base?; user?; applies:'live'; secrets; revision }`；`schema` 是 `schema.toJSON()` 信封（`new Schema(json)` 复原）。
- 落盘：`configEditor.documentPath` → `profileContext.patchPath`（活动 profile 的 patch 文件，即 `cordis.patch.yml` 一类）。
- 客户端读插件配置：**`ctx.configForms`**（`ConfigForms`/`ConfigForm`，`dsh-client-ui-settings\lib\types\client\index.d.ts`），实例 `dsh-client-ui-settings-shell\lib\client.js:182` `ctx.configForms.whileServed([ns...], served => …)` → 条件注册 `plugins.item`。

---

## 6. 最小可行配方（交给实现者）

目标包名 `dsh-hello`。**不需要构建工具也能跑**（照抄 `dsh-notify` 的手写 CJS-factory）。

### 6.1 `package.json`
```jsonc
{
  "name": "dsh-hello", "version": "1.0.0", "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js",
               "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web",
                "inject": ["@deepseek-ai/dsh-client-ui-renderer",
                           "@deepseek-ai/dsh-client-ui-settings"] }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```
`cordis.patch.yml`（自动挂载行）：
```yaml
- insert:
    - id: dsh-hello
      name: 'dsh-hello'
      config: { greeting: 'hello' }      # ← 这份 Config 会自动出现在 Settings UI
```

### 6.2 (a) 注册 HTTP API namespace
`lib/index.js`：
```js
import z from '@deepseek-ai/schemastery';
export const name = 'dsh-hello';
export const inject = ['webServer'];                       // B 档改/加 'connection'
export const Config = z.object({ greeting: z.string().default('hello') });

export function apply(ctx, config) {
  // —— B 档（推荐）：/api 下，自动获得 Host/Origin 栅栏 + cookie 鉴权
  ctx.inject(['connection'], (c) => {
    c.effect(() => c.connection.fetch.register({
      path: '/api/dsh-hello/state',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (req) => {
        if (req.method === 'GET')
          return Response.json({ greeting: config.greeting, at: Date.now() });
        const patch = await req.json().catch(() => null);
        if (patch === null) return new Response('bad json', { status: 400 });
        return Response.json({ greeting: patch.greeting ?? config.greeting });
      },
    }), 'dsh-hello: state route');
  });

  // —— A 档（无鉴权，需自加同源检查）：非 /api 的裸路由
  ctx.inject(['webServer'], (w) => {
    w.effect(() => w.webServer.register({
      kind: 'exact', path: '/dsh-hello/ping',
      handler: (req, res) => {
        const site = req.headers['sec-fetch-site'];
        if (site !== undefined && site !== 'same-origin' && site !== 'none') { res.writeHead(403); res.end('forbidden'); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
      },
    }), 'dsh-hello: ping route');
  });
}
```
> C 档（官方 Typert Remote）不推荐给三方插件：需要 `TypertRemoteService` + `@Remote` + 构建期 `dsh-typert-generator` 产出 `lib/typert.host.js` / `lib/typert.remote-client.js`，且信封为 `{type:'client-request',…}`。

### 6.3 (b) 设置页 section，调用上面的 API
`lib/client.js`：
```js
window.__ModuleLoader__.load({ id: 'dsh-hello', factory: (require) => {
  var module = { exports: {} }, exports = module.exports;
  var React = require('react'); var h = React.createElement;

  function HelloSection() {
    var s = React.useState(null), cfg = s[0], setCfg = s[1];
    React.useEffect(function () {
      fetch('/api/dsh-hello/state', { cache: 'no-store' }).then(r => r.json()).then(setCfg).catch(() => {});
    }, []);
    return h('div', null, [
      h('h2', { key: 't' }, 'Hello'),
      h('pre', { key: 'v' }, JSON.stringify(cfg)),
      h('button', { key: 'b', onClick: function () {
        fetch('/api/dsh-hello/state', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ greeting: 'hi ' + Date.now() }) }).then(r => r.json()).then(setCfg);
      } }, 'Call API'),
    ]);
  }

  function apply(ctx) {
    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register({
        name: 'settings.section', id: 'hello', order: 100,
        label: function () { return 'Hello'; },
      }, HelloSection);
    });
  }
  exports.apply = apply; exports.inject = ['slots'];
  return module.exports;
}});
```
> 更省事的路：**连客户端代码都不写**。只声明 host 侧 `export const Config = z.object({...})`，Settings → Plugins 会自动生成该 entry 的表单（`autoGenerate` 默认 true，见 §5）。要自定义 UI 才写上面的 `settings.section`。

### 6.4 (c) 独立页面 —— **不支持，给两个替代**
- **替代 A（shell 内的"页面"，推荐）**：客户端里再注册
  ```js
  ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'hello' }, HelloPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name:'sidebar.panellist', id:'hello', order: 50, label: () => 'Hello' }, HelloIcon));
  // 跳转：ctx.layout.selectPanel('hello')   （ctx.inject 里加 'layout'）
  ```
  参照 `<ROOT>\dsh-client-ui-plugin-manager\lib\client.js:3428-3491`。URL 不变，无路由。
- **替代 B（真正的独立 HTML 页）**：host 侧注册 `prefix` 路由并自己吐 HTML：
  ```js
  w.webServer.register({ kind:'prefix', path:'/dsh-hello',
    handler: (req, res) => { res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
                             res.end('<!doctype html><h1>Hello</h1>'); } });
  ```
  它在 SPA shell 之外，**不经过 Connection 鉴权**，必须自加同源/Host 校验；也可用 `ctx.connection.fetch.register({path:'/api/dsh-hello/page'})` 以复用鉴权后返回 HTML。

### 6.5 自检清单
1. `exports["./client"]` 存在且指向真实文件（缺失 → 激活期 `MissingClientBundleError`）。
2. `dsh.client.platform === 'web'`；`inject` 只写**已装载的包名**（写错静默忽略，不报错）。
3. 只用 `require('react' | 'react/jsx-runtime' | 'react-dom' | '@deepseek-ai/cordis' | '@deepseek-ai/dsh-client-store' | '@deepseek-ai/dsh-client-ui-slots' | '@deepseek-ai/dsh-client-ui-primitives' | '@deepseek-ai/dsh-client-ui-dockkit')` 免费；其他要么内联，要么进 `dsh.client.external` 且由另一个客户端行提供。
4. `exports.inject` 写 **cordis 服务名**（`['slots']`、`['slots','layout']`），不是包名。
5. 注册的槽名必须已被某个包**声明**（`SlotMap` 合并），否则 fail loud。
6. 用 `ctx.effect(() => dispose, 'label')` 绑定生命周期；不要裸调 `register` 不接 disposer。
7. 调试入口：`plugins/??dsh-hello/client.js&rev=<rev>`（**不是** `/plugins/dsh-hello/client.js`，后者 404）；SSE `GET /plugins/events`。

---

## 7. 未能确定 / 需注意的不确定性

1. **UNCERTAIN**：平台种子表的源码标识符名。README 写 `PLATFORM_MODULES`，产物里只剩压缩后的 `function WS()`；9 个键是读到的，名字不是。
2. **UNCERTAIN**：README "Sharing modules" 称 compose 会拒 "missing suppliers"，但 `orderByModuleGraph`（`dsh-client-modules\lib\index.js:415-437`）对 `external` 的缺失供应者只是 `if (dependency !== void 0)` 跳过。**文档与实现不一致**；实际后果是 `require()` 时才在浏览器抛（`lib/client.js:705`）。
3. **UNCERTAIN**：`dsh.client.inject` 的语义边界——代码只证明"未知包名静默跳过"，未验证"已存在但未激活"时的确切时序。
4. **UNCERTAIN**：`ctx.connection.fetch.register` 的 exact route 与 `/api` interceptor 的优先级、以及 `requestBody:'buffered'` 的具体上限（Config `maxRequestBodyBytes` 默认 300 MiB，但 exact route 是否共用未逐行确认）。
5. **UNCERTAIN**：`ctx.slots.inject` 回调返回 `function*` 的 TS 可赋值性（`d.ts` 只写 `() => SlotInjectionEffect`；官方 `lib/client.js` 里生成器用法确凿，但未用 tsc 实测）。
6. **UNCERTAIN**：`CLIENT_SLOT_API` 中 `replaceRisk` / `occupants` 的全量取值未展开（数据在 `dsh-cordis-client-runner\lib\client.js` 的极宽单行内）。
7. **UNCERTAIN**：`uiConversation.events.register(definition)` 的 definition 精确类型名（仅核实了调用点：`dsh-client-ui-chat\lib\client.js:7622`、`dsh-client-ui-deliverables\lib\client.js:2260`、`dsh-client-ui-trajectory\lib\client.js:1024`）。
8. **UNCERTAIN**：README 指向的 `../AGENTS.md#shared-modules-and-the-module-graph` 是仓库内文档，**未随 npm 包发布，本机不存在**，无法引用其原文。
9. **未验证**：本机 `3080` 端口当前无 DSH 服务在监听，所有结论均来自静态文件，未做运行时抓包验证。
10. `dsh-client-runtime` 在本机断链、`dsh-client-ui-dockkit` 无独立包（但都在种子表/声明里出现）→ 这两个名字在当前安装里是**悬空引用**。
