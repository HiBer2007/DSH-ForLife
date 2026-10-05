# DSH Plugin Authoring Reference

**Evidence root** `R = C:\Users\HiBer2007\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\`.
`@deepseek-ai/dsh-tools/lib/types/index.d.ts:636` means `R\@deepseek-ai\dsh-tools\lib\types\index.d.ts:636`.

> **Trap:** `C:\Users\HiBer2007\.dsh\profiles\node_modules\@deepseek-ai\` is a junction farm into `R`, and several
> junctions are **dangling** (`dsh-agent-loop`, `dsh-hmr`, `dsh-storage-json`, `dsh-settings-file`,
> `dsh-config-editor`, `dsh-client-modules`, `dsh-host-frontend-static`, `dsh-session-query-sqlite`,
> `dsh-plugin-manager` all fail `Get-ChildItem`). Always read from `R`.

**Versions** all `@deepseek-ai/dsh-*` = `0.1.7-rc.2`; `cordis` = `4.0.4`; `cordis-plugin-loader` = `1.0.5`;
`schemastery` ≈ `3.18.4`; Node = **v24.19.0**. Third-party reference plugins: `dsh-notify@1.0.0`,
`dsh-gateway-models@0.2.0` in `C:\Users\HiBer2007\.dsh\profiles\dsh-tui\node_modules\`.

---

## 1. Plugin shape

**Contract** (`cordis/lib/types/registry.d.ts:48-81`): `Plugin<T> = Plugin.Function<T> | Plugin.Constructor<T> |
Plugin.Object<T>`, all extending `Plugin.Base`:
`{ name?: string; Config?: StandardSchemaV1<any,T>; inject?: Inject; provide?: string|string[]; intercept?: Dict<boolean> }`.
DSH uses the **object form** `apply(ctx, config)`. `Config` is a Standard Schema; in practice always **schemastery**
(`import z from '@deepseek-ai/schemastery'`). **`reusable` does not exist** in cordis 4.0.4 (grep across
`cordis/lib` → no matches).

**Loader row** = `EntryOptions { id, name, config?, group?, disabled?, inject? }`
(`cordis-plugin-loader/lib/types/config/entry.d.ts:6-19`). `name` is the module specifier; **`id` is also the
settings namespace** (§7). `Loader.unwrapExports(exports)` normalizes export shapes
(`cordis-plugin-loader/lib/types/index.d.ts:66-83`) ⇒ **use named exports, not a default export**. Canonical footer
(`dsh-tool-todo/lib/index.js:196`): `export { Config, apply, inject, name };`

**`package.json` `dsh` key** — `DshManifest` (`dsh-package-manifest/lib/types/types.d.ts:28-89`):
`{ manifestVersion?: 1; bundle?: { patch: string|string[] }; profile?: { bundles?: string[] };
client?: { platform: string; inject?: string[]; immediately?: boolean; external?: string[] } }`.
A host-only plugin needs **no `dsh` key at all**; add `dsh.bundle.patch` only to auto-insert its own row.

**Composition order** (per `dsh-tui/cordis.yml:1-4`): (1) each bundle in `dsh.profile.bundles` in order; (2) the
profile's `cordis.patch.yml`; (3) `--patch` overlays.

```jsonc
// <profile>/package.json — dsh-tui/package.json:9-18
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui",
                                 "dsh-notify", "dsh-gateway-models"] } }
```

```yaml
# <profile>/cordis.yml:4 — ALWAYS an empty entry list; the tree is built from patches
[]
# dsh-base/cordis.patch.yml:15-16 — one big insert over the empty root
- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'
```

Patch semantics (`dsh-base/cordis.patch.yml:5-13`, `dsh-tui/cordis.patch.yml:13-20`): `- insert: [...]` adds rows;
`- id: <existing>` targets a row for `config:` / `disabled:`; **a patch replaces the targeted row's whole `config`,
it does not merge** ("every key is restated"); `!!js` expressions allowed (`dsh-base/cordis.patch.yml:22,30,133`);
**row order carries no load semantics** — activation is service-availability driven (`dsh-base/cordis.patch.yml:12-13`).
A self-registering bundle is 3 lines — `dsh-notify/cordis.patch.yml:1-4`, whole file: `- insert:` /
`- id: dsh-notify` / `name: 'dsh-notify'`.

**Minimal skeleton**

```jsonc
{ "name": "dsh-my-plugin", "version": "1.0.0", "type": "module", "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=22.13" },                        // dsh-notify/package.json:67-69
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },  // dsh-notify/package.json:59-61
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

```js
// lib/index.js
import z from '@deepseek-ai/schemastery';
export const name = 'my-plugin';
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({ greeting: z.string().default('hello').volatile() }); // §7
export function apply(ctx, config) {
  ctx.logger.info('[my-plugin] loaded: %s', config.greeting);
  ctx.effect(() => ctx.tools.register(/* §2 */), 'my-plugin: tool registration');
}
```

---

## 2. Registering tools (`@deepseek-ai/dsh-tools`)

**Service** `ctx.tools: ToolRuntime` (`index.d.ts:32-35`): `register(definition: ToolDefinition): () => void` (`:636`);
`restrict(filter)` (`:644`); `guard(guard: ToolGuard)` (`:655`); `schemas(scope?): ToolSchema[]` (`:711`).

**The schema DSL is custom** — not typebox, not zod (`schema.d.ts:9-84`):

```ts
export interface ValueSchemaAnnotations { description?: string; title?: string; default?: JsonValue; examples?: JsonValue }
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object'; properties?: ParameterSchemaSpec;
    additionalProperties: boolean;   // MANDATORY — "Openness is mandatory so a nested or output object
}                                    //  never acquires an accidental JSON Schema default"
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };
export type ValueSchemaSpec = String… | Number… | Integer… | Boolean… | Null… | Array… | Object… | JsonValue… | OneOf…;
```

Node types `string|number|integer|boolean|null|array|object|json|oneOf`. `parameters` is an **implicit open object
root**; requiredness is per-property `required: true` (`:77-84`). Arg types are inferred (`InferArgs<S>`, `:150`),
bounded to 16 container levels (`:124-148`). Typebox/zod exist in the tree, but **zod is the vocabulary for session
projections and storage domains**, not tools.

**`defineTool<const S, const O>(options: DefineToolOptions<S,O>): ToolDefinition`** (`schema.d.ts:248`). Members
(`:178-240`): `name`, `description`, `parameters`, **`output`**, `deferLoading?`, `timeoutMs?`,
`isConcurrencySafe?(args)`, `execute(args, exec: ToolRunContext)`, `presentCall?`, `presentResult?`,
`projectContent?`, `finalizeContent?`. Two rules surprise authors:

1. **`output` is mandatory** — `ToolDefinition extends ToolSchema` with `readonly output: ToolOutputDefinition`
   (`index.d.ts:115-117`), i.e. `{ schema, render(args, value): ContentBlock[], presentationMeta? }`. `execute`
   returns the **canonical JSON value** declared by `output.schema`; the registry validates it (`ToolOutputError`,
   `:407-411`) and `render` projects model-facing `ContentBlock[]`. Returning prose violates the contract.
2. **Tool results do not stream.** One canonical value per call; streaming is the loop's concern
   (`agent/assistant-stream`, §4).

`ContentBlock` (`dsh-llm/lib/types/types.d.ts:114-126`): `text | reasoning | image | file | tool-call |
tool-addition | tool-removal` — merge-extensible; switch on `type`, fall through unknowns.

**Verbatim example** (trimmed, `dsh-tool-todo/lib/index.js:95-193`):

```js
ctx.tools.register(defineTool({
  name: "todo_write",
  description: describe(allowParallel),
  parameters: { todos: { type: "array", required: true,
    description: "The COMPLETE task list, replacing any previous list.",
    items: { type: "object", additionalProperties: false, properties: {
      content: { type: "string", required: true, description: "…" },
      status:  { type: "string", required: true, enum: [...STATUSES], description: "…" } } } } },
  output: {
    schema: { type: "object", additionalProperties: false, properties: {
      todos:  { type: "array",  required: true, items: { /* … */ } },
      counts: { type: "object", required: true, additionalProperties: false, properties: {
        pending: { type: "integer", required: true }, /* … */ } } } },
    render: (_args, value) => [{ type: "text", text: `Updated todo list: ${value.counts.pending} pending, …` }],
  },
  execute(args, exec) {
    if (!exec.agent) throw new Error("todo_write requires an owning agent session");
    exec.agent.session.append("todo/write", { todos });   // durable, merge-extensible event type
    return Promise.resolve({ todos: /* … */, counts: /* … */ });
  },
  presentCall: (args) => ({ card: "generic", title: "Update todo list", kind: "other", rawInput: args.todos }),
}));
```

**Docs.** Tool-level `description: string`; per-parameter `description` on each schema node; `title`/`default`/
`examples` are projected but non-validating. **Only `name`/`description`/`parameters` reach the model** —
`schemas()` whitelists exactly those (`index.d.ts:705-711`); `timeoutMs` "is NEVER sent to the model" (`:151-158`).
`presentCall`/`presentResult`/`meta` are UI-only and must be **pure and replay-safe** — they run during live
streaming *and* session-log replay (`:173-190`).

**Approval and "read-only".** **There is no `readOnly` flag on a tool** (grep for `readOnly` across all `.d.ts` finds
only sandbox modes, settings editors, plugin-manager reasons). Approval is a policy pipeline:

*(a) `tools/pre-execute` waterfall* → `PreToolDecision` (`index.d.ts:445-460`):

```ts
| { kind: 'allow' } | { kind: 'deny'; reason: string; info?: ToolErrorInfo } | { kind: 'cancel' }
| { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }
```

`ask` resolves through `ctx.approval`; `'allowed-once'` is the only grant, and **no approval service degrades to
deny** (`:816-827`). Complete real example (`dsh-experimental-auto-review/lib/index.js:462-489`):

```js
yield ctx.on("tools/pre-execute", async (exec, next) => {
  const agent = exec.agent;
  if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();
  if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();
  const downstream = await next();
  if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;
  return askUser(exec, decision.reason);   // -> { kind:'ask', reason, displayReason:{en,zh} }   (:433-445)
}, { prepend: true });
```

*(b)* `ctx.tools.guard(guard)` — monotonic, no allow result, so ordering cannot turn a denial back into permission
(`:514-522`, `:645-657`): `type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;`.

The nearest "read-only" concept is the **sandbox/approval knob pair**: `dsh-sandbox-policy`
`mode: 'read-only' | 'workspace-write' | 'danger-full-access'` (`lib/types/index.d.ts:57`) and
`dsh-permission-presets` `PresetSpec = { sandbox, approval }` (`lib/types/index.d.ts:35-42`). Express read-only via a
`guard`/`pre-execute` listener or a preset, never as tool metadata.

**Pipeline events** — `tools/pre-execute` (waterfall, `:47`), `tools/execute` (waterfall, `:58`),
`tools/post-execute` (waterfall, `:70`), `tools/ptc-dispatch-log` (waterfall, `:84`), `tools/result` (emit, `:92`),
`tools/change` (emit, `:102`). All scope-filtered (agent-scoped listeners see only that agent). `ToolRunContext` adds
`deferContext(context: UserMessage)` — context appended after the `tool/result` — and `concludeTurn()` (`:305-322`).
Presentation mode is plugin config `Config = { mode?: 'native'|'ptc'|'both', maxParallelSubCalls? }` (`:483-503`);
`ptc` collapses the model-facing surface to `run_code` plus a generated SDK prompt.

---

## 3. System prompt / context assembly (`@deepseek-ai/dsh-system-prompt`)

**Yes — there is an ordered list of prompt sections plugins contribute to.** `ctx.systemPrompt: SystemPrompt`
(`index.d.ts:10-13`):

```ts
section(section: PromptSection): () => void;                              // :239  STATIC prefix block
context(context: PromptContext): () => void;                              // :258  DYNAMIC tail block
tools(provider: (c: AssembleContext) => ToolProviderResult): () => void;  // :273
variable(name: string, provider: (c) => string|undefined): () => void;    // :282
suppressRuntimeContext(): () => void;                                     // :265
assemble(context?: AssembleContext): Promise<PromptAssembly>;             // :292
getSectionOrder(name: PromptSectionOrderName): number;                    // :245
getContextOrder(name: PromptContextOrderName): number;                    // :251
```

```ts
export interface PromptSection { readonly name: string;   // unique — duplicate registration throws
    readonly order: number;                              // ascending; ties broken by name
    readonly text: string | ((context: AssembleContext) => string);
    readonly interpolate?: boolean;                      // default true; {{var}} interpolation
    readonly complete?: boolean; }                       // treat as THE whole prompt
export interface PromptContext { readonly name: string; readonly order: number;
    readonly text: string | ((context: AssembleContext) => string); }     // :47-79
export interface PromptAssembly { sections: AssembledSection[]; contexts: AssembledContext[];
    tools: ToolSchema[]; variables: Record<string, string|undefined>; }   // :107-112
```

`renderPrompt(assembly)` joins sections with blank lines, drops empty ones, interpolates strict `{{variable}}`
(`:190-199`); `renderContextSnapshot(assembly)` renders the dynamic context (`:205`). `AssembleContext` is
**merge-extensible**; `dsh-agent` adds the agent (`dsh-agent/lib/types/runtime-types.d.ts:14-19`):
`declare module '@deepseek-ai/dsh-system-prompt' { interface AssembleContext { agent?: Agent } }` — providers read
`context.agent?.session` / `.options.provider` / `.options.model`.

**Centrally allocated orders** — `SECTION_ORDERS` (`:113-146`): `HARNESS_IDENTITY -1000 |
DEPLOYMENT_PERSONA_PREFIX 0 | PLAN_POLICY 500 | TEAM_POLICY 600 | PTC_ONLY 800 | FILE_REFERENCE 900 |
TOOL_BASH 1000 … TOOL_PTY 1700 | TOOL_WEB_SEARCH 2000 … TOOL_COMPUTER_USE 3000 | MCP_SERVERS 3100 |
TOOLS_SDK 5000 | DELIVERABLE_FILE_REFERENCES 9000 | STRUCTURED_OUTPUT 9900 | HARNESS_SOURCE 10000 |
WEB_SURFACE 10100 | DEPLOYMENT_PERSONA_SUFFIX 10200`. `CONTEXT_ORDERS` (`:149-153`): `SANDBOX_POLICY 110 |
APPROVAL_POLICY 115 | SUBAGENT_DELEGATION 120`. A plugin picks its own number (e.g. `-900` between identity and
persona, or `10` after the persona). Reserved persona names: `PERSONA_PREFIX_SECTION =
"deployment:persona-prefix"`, `PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"` (`:162-164`).

**Stable prefix** (e.g. "中期记忆区") — a `section` whose text is constant or rarely changes:

```js
ctx.systemPrompt.section({ name: 'memory:mid-term', order: -900,   // after HARNESS_IDENTITY, before persona
                           text: () => renderMidTermMemory() });   // keep this STABLE across turns
```

**Dynamic tail** — two verified options:

1. *Registered runtime context* → "Dynamic model context materialized as a **durable user-role snapshot**" (`:71`).
   Real pattern (`dsh-user-approval/lib/index.js:79-89`):

   ```js
   ctx.inject(["systemPrompt"], (scope) => {
     scope.systemPrompt.context({ name: "approval:policy",
       order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY"),
       text: (context) => { const agent = context.agent; if (agent === void 0) return "";
                            return effective(agent) === "never" ? NEVER_SENTENCE : ASK_SENTENCE; } });
   });
   ```

2. *Appended user message at pre-step* — the `dsh-time-context` pattern (`dsh-time-context/lib/index.js:215-246`),
   a **prepended** `agent/pre-step` waterfall:

   ```js
   ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
     const decision = await next();
     if (decision.kind === "reject" || signal.aborted) return decision;
     const text = renderText(/* … */);
     return { ...decision, messages: [...decision.messages, createUserMessage({
       content: [{ type: "text", text }],
       source: { kind: name, form: "snapshot", sections: [{ name, text }] } })] };
   }, { prepend: true });
   ```

   `ContextForm` (`dsh-llm/lib/types/message.d.ts:44-93`): `'instructions' | 'catalog' | 'snapshot' | 'notice' |
   'relay' | 'recall'`; `snapshot` requires `sections: ContextSnapshotSection[]`, `notice` requires `summary: string`.

**Variables** `variable(name, provider)`, name `[a-z][a-z0-9_]*`; strict `{{var}}` throws when unknown/undefined.
`dsh-agent-loop` registers `provider`, `model`, `cwd` (`dsh-agent-loop/lib/index.js:1549-1551`).

**Workspace instructions** `dsh-agent-instructions` loads `AGENTS.md`-compatible files — baseline instructions enter
durable context before the first request; fs tool touches project nested/changed/removed instructions into the inbox
(`lib/types/index.d.ts:1-21`). Config `dshHome`, `projectRootMarkers`, `maxBytes`, `maxSourceBytes`,
`instructionFileCandidates`, `localInstructionFileCandidates` (`config.d.ts:8-27`). It contributes through `ctx.fs`,
**not** `systemPrompt.section` — the model for content that belongs in history, not the prefix.

**Persona** `dsh-persona` is **scope-only**, mounting `deployment:persona-prefix`/`-suffix`; mounted globally it
collides with the registry's own registration and **fails loud** (`lib/types/index.d.ts:1-13`, config `:24-40`).

**Cache-friendliness — four verified mechanisms:** (1) `system/message` is surface node 0 and "a prepared in-history
route can append nonempty changes in a continuing series… an incapable route or new series normalizes text to the
first system node" (`dsh-session/lib/types/types.d.ts:303-319`); (2) `SystemPromptUpdate = 'in-history'` — "so a
changed prompt can **follow the cached history instead of rewriting message 0**"
(`dsh-llm/lib/types/types.d.ts:359-365`); (3) `ToolUpdate = 'in-history' | 'addition-only'` — an added tool "follows
the cached history instead of rewriting the declaration list" (`:366-375`); (4) call-config drift breaks cache —
"provider routing, model, reasoning effort, and sampling values are request-header state that **can affect cache
reuse**" (`dsh-llm/lib/types/call-config.d.ts:1-5`). Accounting is observable: `TokenUsage.cacheReadTokens` /
`cacheWriteTokens`, disjoint from `inputTokens` (`types.d.ts:153-172`). **Rule:** rarely-changing text in a low-`order`
`section()`; per-turn text in `context()` or an appended pre-step message; never let a `section()` provider churn per
step on a route lacking `systemPromptUpdate: 'in-history'`.

---

## 4. Conversation lifecycle hooks

**Agent events** (`dsh-agent/lib/types/runtime-types.d.ts:212-408`) — all **scope-filtered**:

| Event | Mode | Contract |
|---|---|---|
| `agent/created` | serial | `{ agent, source, signal? }`; awaited before creation resolves |
| `agent/disposed` | emit | `{ agent }` |
| `agent/status` | emit | `{ agent, status }` — `idle` ⇄ `running` |
| `agent/inbox/inserted` / `claimed` / `discarded` | emit | `{ agent, message[, turn] }` |
| **`agent/pre-step`** | waterfall | `{ agent, messages, turn, step, signal }` → `PreStepDecision`; may reject or replace the step's messages |
| **`agent/request`** | waterfall | `{ agent, turn, step, signal }` → `LlmCallConfig`; replace provider/model/effort |
| `agent/request-error` | waterfall | `{ agent, turn, step, provider, failure, retryPolicy, signal }` → `RequestErrorAction` |
| `agent/assistant-stream` | emit | `{ agent, frame }`; chunk frames are transient |
| **`agent/turn-stopping`** | serial | `{ agent, turn, signal }` — the turn is about to close |
| `agent/error` | emit | `{ agent, turn, step, error }` |

`dsh-agent-loop` adds `agent-loop/config-start-failed` (`dsh-agent-loop/lib/types/index.d.ts:50-53`).
`PreStepDecision` starts `{ kind: 'reject' }` (`runtime-types.d.ts:92-93`).

**Turn-end caveat, verified in the wild** — `dsh-notify/lib/index.js:10-12`: *"this DSH version emits NO `turn/end`
event and `agent/status` is scoped to the agent (invisible to global listeners), so completion is derived by polling
`agents.list()` phase objects."* `turn/end` **does** exist as a *session* event type
(`dsh-session/lib/types/types.d.ts:273-276`), reachable via `session/event`; the reliable agent-scoped hook is
`agent/turn-stopping`. `agent.phase` is a real runtime property (`dsh-agent-loop/lib/index.js:753,783-791`, kinds
`idle | running | maintenance`) but is **not in the public `.d.ts`** — treat as private.

**Session events** (`dsh-session/lib/types/index.d.ts:26-75`): `session/created`, `session/disposed`,
**`session/event(session, event)`** (emit), `session/flush` (parallel). `SessionEventMap` is **merge-extensible**:

```ts
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap { 'myplugin/thing': { turn: number; payload: JsonValue }; } }
```

Built-ins (`lib/types/types.d.ts:255-433`): `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`,
`developer/message`, `system/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`,
`request/header`, `request/context`, `session/end-seed`. `dsh-compaction` adds `compaction/start|summary|end|prune`
(`dsh-compaction/lib/types/types.d.ts:15-100`); `dsh-user-approval` adds `approval/asked|decided|policy`.
`ignorable?: true` means a reader may skip an unrecognized type; **absent means required** and a reader must refuse to
reconstruct (`:497-507`). Downstream plugin events are outside `KNOWN_SESSION_EVENT_TYPES` by construction
(`known-event-types.d.ts:7-21`) ⇒ **set `ignorable` for purely informational events**.

**(a) Trigger compaction — yes.** `ctx.compaction: CompactionEngine` (`dsh-compaction/lib/types/index.d.ts:67-70`):

```ts
abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger,
                         signal: AbortSignal): Promise<CompactionResult | null>;      // :116
abstract compactNow(agent: ManualCompactAgentContext, signal: AbortSignal,
                    sourceCommandId?: CommandId): Promise<CompactionResult | null>;  // :137
abstract compactRegion(start: SessionSeq, end: SessionSeq, agent, signal?): Promise<CompactionResult>; // :157
```

`CompactionTrigger = 'pressure' | 'context-overflow'` (`:25`). Real call site (`dsh-command-compact/lib/index.js:55`):
`await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`. Automatic policy lives
in `dsh-compaction-basic/lib/index.js:839-872`: `agent/pre-step` → `compactIfNeeded(agent, 'pressure', signal)`,
`agent/request-error` → `'context-overflow'`, priced through `this.ctx.tokenMeter`. Expected failures are
`ManualCompactionError` with `code: 'busy'|'cancelled'|'changed'|'summary'|'commit'|'persistence'` (`:27-43`). The
one **extension point** is a waterfall (`:85-90`): `'compaction/summary-error'(payload, next: () => boolean): boolean`
— return true only after making progress. Backends are pluggable by subclassing `CompactionEngine` and mounting one as
`ctx.compaction` (`:93-102`).

**(b) Rewrite/replace the in-window history — yes, via surface ops:**

```ts
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };   // :458-462
export type SurfaceEventType = 'system/message' | 'developer/message' | 'user/message'
                             | 'assistant/message' | 'tool/result';                              // :442
append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
       ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;    // index.d.ts:246
```

Doc: *"`{ op:'replace', startSeq, endSeq }` replaces surface nodes from `startSeq` (inclusive) through `endSeq`
(inclusive) with this node… the node's `sourceEventSeqs` must include every shadowed surface node. **Used by
compaction; any surface-replacing producer may use it.**"* Read side: `Session.snapshotEvents(fromSeq?, toSeqExclusive?)`,
`ownEvents()`, `surface`, `seq` (`lib/types/index.d.ts:110,193,200,208`). For *ordinary* injection prefer the supported
paths (`dsh-agent/lib/types/runtime-types.d.ts:186-209`): `agent.inject(message)` (context for the next pre-step
without waking the driver), `agent.followup(message)` (own turn), `agent.steer(message)` (nearest step boundary),
`agent.send(message, target, wakeup)`.

**(c) Observe token usage — yes.** `ctx.tokenMeter: TokenMeter` (`dsh-token-meter/lib/types/index.d.ts:14-18`):
`measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement` (`:46`) and
`estimateMessage(message: Message): number` (`:57`). `measure` returns "a detached deeply immutable pressure and
surface measurement"; provider usage is reused only when the latest successful call's canonical request envelope
matches `requestHeader` (`:26-45`). Per-message accounting also rides the log: `assistant/message.usage?: TokenUsage`.

**Session projections** — `ctx.sessionProjections: SessionProjectionRegistry`
(`dsh-session-projection/lib/types/index.d.ts:23-27`). A projection is a pure synchronous fold
(`ProjectionDefinition`, `:38-80`): `{ key, stateSchema: ZodType<S>, init, apply(state, event): S /* same reference
when uninterested */, wire?: { viewSchema, view }, stateVersion }`. Registry `register(definition)` (`:150-159`),
`onChanged(listener)` (`:166`), `stateOf(session, key)` (`:175`), `snapshot(session, keys?)` (`:185`),
`cachedSnapshot` (`:194`). **Schema type is zod here.** Real usage `dsh-tool-todo/lib/index.js:80-94`.

---

## 5. Storage

| Package | Registers | Role |
|---|---|---|
| `dsh-storage` | `ctx.storage: Storage` | hub; forms + backend registry (`lib/types/index.d.ts:23-27,33-62`) |
| `dsh-storage-domain` | `ctx.storageDomain` **and** `ctx.storage.domain` | schema-validated KV domains (`lib/types/index.d.ts:20-28`) |
| `dsh-storage-json` | backend name `"json"` + key `storage.backend.json` | the only media backend (`lib/index.js:598-608`) |

`Storage`: `mount(form, facility)`, `form(name)`, `get domain()`, `readonly backend: BackendRegistry`;
`storageBackendServiceKey(name)` → `` `storage.backend.${name}` `` (`index.d.ts:22`). Registry `register(name, backend)`,
`get(name)`, `names()` (`registry.d.ts:21-32`).

**Domain abstraction** (`dsh-storage-domain/lib/types/spec.d.ts`):

```ts
export interface DomainSpec {                              // :31-68
    readonly name: string;                                 // UNIT_NAME_RE /^[a-z][a-z0-9_]*$/ — also the on-disk unit name
    readonly version: number;
    readonly layout?: 'single' | 'per-record';             // default 'single'
    readonly compatibleVersions?: readonly number[];       // older stamps readable by CURRENT schemas
    readonly invalidRecords?: 'backup-and-skip';           // else open rejects with invalid-record
    readonly global?: DomainGlobalSpec<unknown>;           // { schema: ZodType<G>; initial: G }
    readonly tables: Record<string, DomainTableSpec>; }    // { valueSchema: ZodType<V>; __key?: K }
export declare function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>;  // :80
export declare function defineDomain<S extends DomainSpec>(spec: S): S;                              // :93
```

**Schema type is zod here** — *"Plugin `Config` is schemastery; record schemas inside domain specs are zod"*
(`index.d.ts:1-8`). Read/write API (`domain.d.ts:36-105`):

```ts
export interface KvTable<K extends string, V> {
    get(key: K): V | undefined;                            // sync, from authoritative in-memory state
    entries(): IterableIterator<[K, V]>; keys(): IterableIterator<K>; readonly size: number;
    put(key: K, value: V): Promise<void>;                  // durable FIRST, then memory, then event
    delete(key: K): Promise<boolean>;
    update(key: K, fn: (current: V) => V): Promise<V>; }   // atomic RMW on the domain write chain
export interface Domain<S extends DomainSpec> { readonly name: string; readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>;
    close(): Promise<void>; }
```

Every durable write emits `'domain/changed'` — `{ operation:'put', value } | { operation:'deleted' }`, `table`/`key` =
`''` for the global slot (`events.d.ts:31-43`). `DomainFacility` (`index.d.ts:52-99`): `open(spec)`, `get(name)`,
`closeAll()`; single-open per name (`already-open`), config `{ backend: string; routes?: Record<string, string> }`.
**The caller owns the handle** — `ctx.effect(() => () => domain.close())`.

**No migration callback exists** (grep `migrat` in `dsh-storage-domain/lib` → only prose). Versioning is declarative:
stamp `version` on write; `single` reads are exact-version; `per-record` reads accept `compatibleVersions`; a whole-unit
mismatch rejects with `version-mismatch`. Migration is the plugin's own read-time job. Canonical usage
(`dsh-session-projection-cache/lib/index.js:90-102,136-156`):

```js
const projectionCacheDomainSpec = defineDomain({
  name: "session_projcache", version: 7, compatibleVersions: [3,4,5,6],
  invalidRecords: "backup-and-skip", layout: "per-record",
  tables: { sessions: domainTable(checkpointRecord) } });
static inject = ["storageDomain", "sessionProjections", "sessions"];
async [Service.init]() {
  const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
  this.ctx.effect(() => () => domain.close(), "sessionProjectionCache.domainClose");
  this.table = domain.table("sessions"); }
```

**SQLite: exactly one binding — `node:sqlite` — and it is closed.** grep for
`node:sqlite|better-sqlite3|DatabaseSync|sqlite3` across every `*.js` in the tree yields **3 hits, all in
`dsh-session-query-sqlite/lib/index.js`** (`:50-51`):

```js
const { DatabaseSync } = await import("node:sqlite");   // dynamic — never loaded when openAt:'never'
const db = new DatabaseSync(actual);
```

Its only runtime dependency is `@deepseek-ai/schemastery` — **no sqlite dependency**; it uses the Node stdlib, typed as
`import type { DatabaseSync } from 'node:sqlite'` (`lib/types/schema.d.ts:2,15`). **A plugin cannot add tables to it:**
`PRAGMA application_id` = `1146308689`, `user_version` = 8, tables `search_state`, `persisted_sessions`, FTS5
`persisted_docs` (`lib/index.js:11-23,82-118`); open refuses foreign DBs and unrecognized user tables
(`:56-57,74-77`). FTS5 + `STRICT` tables are required. **Default mount is inert**
(`dsh-base/cordis.patch.yml:141-153`): `- id: session-query-sqlite` / `config: { path: ':memory:', openAt: never }` —
so SQLite is `:memory:` and **never opened**; search fails with `SESSION_QUERY_SEARCH_DISABLED`.
`dsh-web-app/cordis.patch.yml:22-30` restates the same values deliberately. Net effect in this TUI profile: **no SQLite
file is ever created**. `node:sqlite` is experimental and version-gated; local Node v24.19.0 has `DatabaseSync` (the
README calls it "SQLite's experimental warning", deferred by lazy open). **UNCERTAIN:** no file states a minimum Node;
the only version-bound evidence is third-party (`dsh-notify/package.json:67-69` → `">=22.13"`). **No
`@deepseek-ai/dsh-*` package declares `engines` at all.**

**Which package for own relational tables?** **There is no relational storage facility** — installed backends are
`json` only, `StorageForms` has exactly one member (`domain`), there is no `dsh-storage-sqlite`. **Use a domain** with
one table per logical table (`per-record` = one JSON document per key), string keys, zod record schemas: that buys
validation, namespacing, version gating, change events and durability. If you genuinely need SQL, open your **own**
`node:sqlite` `DatabaseSync`, inheriting the experimental/version implications, with **no harness helper, path slot, or
migration facility**. UNCERTAIN: no in-tree plugin does this. On-disk layout
(`dsh-base/cordis.patch.yml:165-176`): `storage-json` root = `dshHomePath('storages')` (override → `$DSH_HOME` →
`~/.dsh`), `storage-domain` config `backend: json`. Observed: `C:\Users\HiBer2007\.dsh\storages\workspace.json`,
`…\session_projcache.json`, and a `…\session_projcache\sessions\<uuid>.json` tree.

---

## 6. LLM access from a plugin (`@deepseek-ai/dsh-llm`)

`ctx.llm: LlmRuntime` (`index.d.ts:28-31`): `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` (`:412`);
`prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>` (`:386`); `resolveCallConfig(config, signal?)`
(`:374`); `registerAdapter(providers, adapter)` (`:253`); `registerConfigurableProviders(entries)` (`:281`);
`registerModelDiscovery(settingsNs, discover)` (`:297`).

```ts
export interface GenerateOptions {                 // dsh-llm/lib/types/types.d.ts:489-531
    provider: string;                              // selects the adapter instance
    model: string;
    reasoningEffort?: ReasoningEffortId;           // adapter-owned, per exact model
    messages: RequestMessage[];
    system?: string;                               // for hand-built one-shot callers
    tools?: ToolSchema[]; toolHistory?: ToolHistory;
    temperature?: number; maxTokens?: number; stop?: string[];
    signal?: AbortSignal; sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';      // provider-neutral auxiliary-call classification
}
```

`ReasoningEffortId` is a branded string (`brand.d.ts:49-55`). For the official DeepSeek adapter the ids are literally
**`"off" | "low" | "high" | "max"`** (`dsh-llm-deepseek/lib/index.js:452-456`), and `purpose === "session-title"`
forces `"off"` (`:1689`). Per-route efforts come from `LlmResolvedModelInfo.reasoning:
{ efforts: LlmReasoningEffortInfo[]; defaultEffort? }` (`types.d.ts:340-358`). Real one-shot call (shape from
`dsh-experimental-auto-review/lib/index.js:400-415`):

```js
const options = deepFreeze({ provider: snapshot.provider, model: snapshot.model,
  system: REVIEW_POLICY,
  messages: [{ role: "user", content: [{ type: "text", text: reviewUserText(snapshot) }] }],
  temperature: 0, signal });
return readDecision(ctx.llm.stream(options));
```

**Compaction with its own model** (`dsh-compaction-basic/lib/types/types.d.ts:7-38`): `summarizationProvider?` (`:17`),
`summarizationModel?` (`:19`), `modelPolicies?: ModelCompactPolicyConfig[]` (exact provider/model overrides; duplicate
targets fail load). Also `CompactionAgentContext.options: { provider?: string; model?: string }`
(`dsh-compaction/lib/types/index.d.ts:45-51`). There is **no separate reasoning-effort knob for compaction** — effort
follows the routed model default (UNCERTAIN whether a `modelPolicies` entry could carry one; only `provider`/`model`
are declared as the match key). Set `purpose: 'compaction'` to classify an auxiliary call.

**Interception/extension:** `'llm/stream'` waterfall (`index.d.ts:45`) — "waterfall around every streaming model call
(retry, replay, routing)"; **loop-built requests arrive deep-frozen and must be read, never rewritten**; live use
`dsh-gateway-models/lib/index.js:293`. `ctx.deepseekLlmApiExtensions.register(field, provider)` lets plugins own
independent **top-level request fields** for the official DeepSeek adapter in one transaction
(`dsh-deepseek-llm-api-extensions/lib/types/index.d.ts:9-33`). Default selection:
`ctx.agentDefaultModel.currentSelection()` / `saveSelection(next)` (`dsh-agent-default-model/lib/types/index.d.ts:5-51`).
The loop replaces per-request config via the **`agent/request` waterfall** → `LlmCallConfig` =
`{ provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }` (`call-config.d.ts:16-23`).

---

## 7. Settings / config

`ctx.settings: SettingsForms` — *"Schema-derived plugin configuration forms"* (`dsh-settings/lib/types/index.d.ts:24-29`);
`static inject = ["configEditor", "profileContext"]` (`dsh-settings/lib/index.js:322-341`).
`ctx.configEditor: ConfigEditor` is the persistence layer (`dsh-config-editor/lib/types/index.d.ts:3-8`).
Author-facing surface (`dsh-settings/lib/types/index.d.ts`): `configure(presentation: { auto?: boolean }, owner?: Fiber)`
(`:80-82`), `get writable()` (`:85`), `describe(options?)` (`:96`), `update(ns, patch, expectedRevision?)` (`:102`),
`replace(ns, section, rev?)` (`:108`), `mutate(ns, ops: readonly SettingsPathOp[], rev?)` (`:114`),
`SettingsConflictError` (`:31-44`).

**Can a plugin declare settings that appear in the GUI? Yes, with two conditions.** **There is no `defineSettings` and
no settings-declaration DSL** (grep: no matches) — **a plugin's settings section *is* its Cordis `Config` export**.
`describe()` walks Loader entries and requires (`dsh-settings/lib/index.js:413-450,538-541`): (1) a schema on the live
fiber — `entry.fiber?.runtime?.Config`, gated on `"toJSON" in schema`; (2) **at least one `volatile` field** —
`const form = volatileForm(schema); if (form === void 0) return [];` (`:418-419`), where `volatileForm` needs
`schema.meta.volatile` at the root or under an object `dict` (`:122-131`). The namespace is the **row `id`**
(`ns = entry.options.id`, `:444`), not the package name. `schema: form.toJSON()` and `applies: 'live'` are served to
the client. Schema type is **schemastery**; `.role('secret')` marks write-only fields (redacted to
`SettingsSecretView { path, set }`). Real examples (`dsh-web-search-deepseek/lib/index.js:237-243`):

```js
apiKey: z.string().role("secret").volatile(),
apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile(),
maxUses: z.number().step(1).min(1).default(5).volatile()
```

Writes go to the **active profile patch** (`profileContext.patchPath`), written atomically and reconciled through the
Loader (`dsh-config-editor/lib/index.js:24-26,71-124`); a home patch or `--patch` overlay overriding the same id makes
the write fail loud (`:116`). Non-volatile paths are refused (`Config field "x.y" is not volatile`,
`dsh-settings/lib/index.js:507,520`).

**Cordis `Config` vs `dsh-settings`** — one mechanism, two consumers. The Loader validates the row's raw `config`
against the exported schemastery `Config` at activation; `dsh-settings` projects that same schema into a form and writes
the raw layer back. Both services are composed only in profile launches — base rows carry
`disabled: !!js "!ctx.get('profileContext')"` (`dsh-base/cordis.patch.yml:97-103`) — so a bare `cordis.yml` start has
neither, which is why robust plugins guard with `ctx.inject(['settings'], …)`
(`dsh-gateway-models/lib/index.js:1102-1106`). Client side: `ctx.configForms` with `describe()`, `get(entryId)`, and
`whileServed(namespaces, register)` (*"a plugin whose page edits a namespace another plugin owns registers the page
through this"*). UI seats: `settings.section` (one page per list entry), `settings.plugins.tab`,
`settings.general.item`, and per-plugin `plugins.item` / `plugins.bundle.config` / `plugins.row.config` keyed
`<package>#<row id>`.

**Caveat (UNCERTAIN).** `autoGenerate` reaches the browser but no client consumer was found; every in-tree page is an
explicit `plugins.item` card, and official plugins *suppress* auto-generation via
`settings.configure({ auto: false }, ctx.fiber)` (13 call sites, e.g. `dsh-agent-default-model/lib/index.js:31`). Treat
"declare a volatile `Config` ⇒ GUI grows a page" as **unverified**; the verified fact is that the descriptor is served.
**Third-party reality check:** `dsh-notify` exports **no `Config`** and keeps tunables in a hand-rolled
`~/.dsh/dsh-notify.json` served over its own HTTP route (`lib/index.js:30-32,85-103,313-322`) — so it gets **no
settings page**. `dsh-gateway-models` has no exported `Config` either; it *writes another plugin's* namespace
(`const NS = 'llm-pi-ai'`, `:349`; `settings.update(NS, …)` `:1057`; re-runs on
`ctx.on('settings/document-updated', ns => …)` `:1090-1092`).

---

## 8. Web contributions

**Serving/build — prebuilt static bundle.** `dsh-web-frontend/package.json:3`: *"Web application entry: vite build
over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's dsh web"*. `vite` is a **devDependency**
(`:37`); `files` excludes maps (`:20`). Artifacts: `dist/index.html`, `dist/assets/index-*.js` (~629 KB),
`dist/assets/vendor-*.js` (~741 KB). Served by `dsh-host-frontend-static` on the webserver's **single fallback seat**
(`inject = ["webServer","connection"]`, `Config = z.object({ distIndex: z.string().required() })`,
`ctx.webServer.registerFallback(...)` — `lib/index.js:21-22,87`). The dist path is an assembly fact:
`join(dirname(require.resolve("@deepseek-ai/dsh-web-frontend/package.json")), "dist", "index.html")`
(`dsh-web-app/lib/index.js:110`, mounted `:176`). **HMR covers plugin client bundles only, not the shell dist** —
`dsh-client-hmr` is always mounted but "idle until a rebuild watcher (`pnpm run dev:web`) actually rewrites client
bundles" (`dsh-web-app/cordis.patch.yml:192-197`); SSE `EVENTS_ENDPOINT = "/plugins/events"`
(`dsh-client-hmr/lib/types/events.d.ts:38`).

**Client modules.** `ctx.clientModules: ClientModuleRegistry` (`dsh-client-modules/lib/types/index.d.ts:31-36,78`).
Bundle route is a **`/plugins` prefix** registration (`lib/index.js:201,546-550`):

```js
webCtx.effect(() => webCtx.webServer.register({
    kind: "prefix", path: PLUGIN_ROUTE, handler: this.serveBundle }), "client-modules: bundle route");
```

Bundles are revisioned (`/plugins/<pkg>/client.js?rev=<rev>`). The host injects `window.__DSH_BOOT__`
(`WebBootGraph { rev; entries; batches }`); the page-global facade is `window.__ModuleLoader__`. The shell seeds a
frozen module table (`PLATFORM_MODULES`: React, Cordis, static UI libraries) — *"every dynamic bundle resolves its
externals against exactly that baseline"* (`dsh-client-modules/README.md:46`). Discovery requires
`dsh.client.platform === "web"` **and** a `./client` export, else it throws
`client-modules: <pkg> declares dsh.client but exports no "./client" bundle` (`lib/index.js:713-719`); a missing built
artifact fails loudly with ``run `pnpm run build` before launch`` (`:128`).

**How a plugin contributes UI — the verified contract.** `dsh-notify/package.json:42-53` declares
`dsh.client { platform: "web", inject: [...] }` and exports `./client`. `lib/client.js:1-17` is **plain JS, no build
step, no JSX** — a self-registering lazy factory:

```js
window.__ModuleLoader__.load({
  id: "dsh-notify",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    (() => {
      var __require = typeof require !== "undefined" ? require : (x) => { throw new Error('require("' + x + '") unavailable'); };
      var import_react = __require("react");
      var h = import_react.createElement;
```

and `lib/client.js:96-104,128-129`:

```js
function apply(ctx) {
  ctx.slots.inject('conversation.session.header.utilities', function () {
    return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-notify', order: 100 }, Bell);
  });
}
exports.apply = apply;
exports.inject = ['slots'];
```

So the client module is a **Cordis plugin object** (`{ apply, inject }`) reached through
`window.__ModuleLoader__.load({ id: <exact package name>, factory(require) })`. The only import specifier is
`require("react")`. The factory body must have **no side effects at execution time** — CSS injection and `fetch()` live
inside `useEffect` (`lib/client.js:42-51`). Note `@deepseek-ai/dsh-client-runtime` **does not exist in this install**;
harmless, because `dsh.client.inject` only orders activation and a missing target is silently skipped
(`dsh-client-modules/lib/client.js:656-659`).

**Slots.** `ctx.slots: SlotRegistry` (`dsh-client-ui-renderer/lib/types/client/index.d.ts:25-30`) with
`register(options, component)`, `registerFactory`, `inject(key, callback): () => void`
(`.../client/registry.d.ts:85,95,111`). Four kinds `'single' | 'list' | 'keyed' | 'chain'`, three scopes
`'root' | 'session-maybe' | 'session'` (`dsh-client-ui-slots/lib/types/index.d.ts:83-85`); slots are declared by
`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {…} }`. Verified names: layout `sidebar`,
`main` (keyed), `rightbar`, `shell.overlay` (list), `shell.leading`; sidebar `sidebar.panellist` (list),
`sidebar.settings`, `sidebar.footer.action`; conversation 26 keys incl. `conversation.session.header.utilities`
(list), `conversation.composer.dock` (list), `conversation.composer` (chain); settings `settings.section` (list),
`settings.plugins.tab` (list), `settings.general.item` (list). **Do not register into `root`** — occupied by AppFrame,
and *"the page would render your component alone"* (`.../registry.d.ts:24-31`). `defineClientModule` **does not
exist** (0 grep matches). Official guidance (`dsh-agent-preset@0.1.7-rc.2`,
`skills/cordis-plugin-development/references/practices.md:35-36`): *"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module… Contribute through slots:
`ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`. Do not write DOM outside your component or append to
`document.body`."*

**Own HTTP API routes — yes.** `ctx.webServer: WebServer` (`dsh-host-webserver/lib/types/index.d.ts:16-18`) is **plain
`node:http`** — *"It knows no harness concepts and serves no files"* (`README.md:12`); **no express, no hono**.

```ts
export type WebRouteKind = 'exact' | 'prefix';                                    // :31
export interface WebRoute { kind: WebRouteKind; path: string;                      // :33-39
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>; }
register(route: WebRoute): () => void;            // :90    registerUpgrade(route)  // :97
registerFallback(handler): () => void;            // :106   tapIndex(transform)     // :114
```

Matching: exact table → longest prefix → fallback; duplicate `(kind, path)` throws. Verbatim third-party use
(`dsh-notify/lib/index.js:313-328`):

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact', path: CONFIG_ROUTE,
    handler: async (req, res) => { if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return; } … },
  }), 'dsh-notify: config route');
});
```

Typed RPC also exists (`dsh-api-gateway` `TypertGatewayService.invoke(...)`, `dsh-typert-registry`
`register(contribution)`) but is **codegen-backed** (generated `lib/typert.host.js` / `lib/typert.remote-client.js`).
Plain `webServer.register` + `fetch` needs no build step.

**Adding a whole page — yes, in practice.** Register a **keyed `main`** panel plus a matching **`sidebar.panellist`**
list entry with the *same* id (`dsh-client-ui-schedule/lib/client.js:6793-6810`):

```js
ctx.slots.inject("main", () => ctx.slots.register({
    name: "main", key: PANEL_ID, locale: MANAGER_NS, inject: () => ({ ...detail }) }, TaskManagerPage));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist", id: PANEL_ID, order: 10, locale: MANAGER_NS, label: () => t("panel") }, TaskManagerIcon));
```

Slot docs state the linkage: *"Each list id addresses the matching main panel; the sidebar owns the button and resolves
its label from list metadata"* (`dsh-client-ui-sidebar/.../slots.d.ts:42-50`).
`dsh-client-ui-plugin-manager/lib/client.js:3434-3491` does the same. Official policy: *"Render plugin pages as React
components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not
receive the host's theme tokens, light/dark switching, or `ctx.locale`."* (`practices.md:33`). **UNCERTAIN:** no doc
states this recipe outright; it is inferred from two shipped implementations plus the slot docs. A settings-only page
is simpler: one `settings.section` list entry.

---

## 9. Verification tooling

**`dsh-headless` — a Cordis bundle + CLI profile, not a library.** No `bin`; a plugin bundle
(`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`) described as *"The dsh one-shot bundle: a direct core
Agent/Session runner over dsh-base with no Host, HTTP, or browser layer"*. Exports `name = "headless-runner"`,
`inject`, `Config { task?, sessionId?, json? }`, `apply(ctx, config)` (`lib/types/index.d.ts:15-33`), plus a `./startup`
sibling (`HEADLESS_STARTUP_SERVICE = "headlessStartup"`). Invoked as `dsh --profile headless "<task>"`; the launcher
auto-initializes the profile from `PROFILE_TEMPLATES` (`dsh-app-boot/lib/index.js:529-535`). **Hard requirement:**
`apply` throws unless the launcher provided `ctx.appExit` (`lib/index.js:355-357`). `--json` is the machine-assertion
surface: events `status|text|thinking|tool_call|tool_result`, exit 0 only for a `completed` `turn/end`.

**`dsh-sdk-*` — JSON-RPC over stdio; no `createApp`/`boot`/`runPrompt` anywhere.** `dsh-sdk-minimal` — *"The package's
substance is `cordis.patch.yml` … this module carries no runtime interface"* (`lib/types/index.d.ts:1-8`); it is the
**only** bundle that mounts `dsh-invariants` (`cordis.patch.yml:106-119`). `dsh-sdk-app` — startup/stdio-lifetime
provider only (`name = "sdk-app-startup"`). `dsh-sdk-jsonrpc-server` — the real API and the only documented in-process
test hooks: `interface JsonRpcConfig { maxTokensAsSuccess?: boolean; input?: Readable; output?: Writable;
exit?: (code) => void }` (*"Transport input override; production uses `process.stdin`"*); class
`HarnessSdkJsonRpcServer` with `initialize(params)`, `prompt(params)`, `shutdown()`,
`handleRequest(method, params)`. `dsh-sdk-protocol` — `JsonRpcLineTransport`; wire types
`InitializeParams { cwd, provider, model, reasoningEffort?, maxTokens? }`,
`SessionPromptParams { sessionId, contentBlocks }`.

**`dsh-invariants`** — `ctx.invariants: InvariantRegistry` (`dsh-invariants/lib/types/index.d.ts:51-81`):

```ts
type InvariantFailure = (message: string) => never;                                     // :25
interface InvariantInstaller { (ctx: Context, fail: InvariantFailure): void | Promise<void>;
                               readonly inject?: Inject }                               // :27-37
register(packageName: string, installer: InvariantInstaller): () => void;                // :57-81
```

Copyable pattern (`dsh-agent-loop/lib/invariant.js:8-40`): export `name` / `inject = ["invariants"]` and
`apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))`. **Gap:** `ctx.invariants` is
mounted **only by `dsh-sdk-minimal`**; `dsh-base`, headless and web-app patches add no `invariant` row, so in those
profiles a plugin with `inject: ["invariants"]` never activates unless the author patches the row in.

**Programmatic boot — a config path is mandatory**
(`dsh-app-boot/lib/types/index.d.ts:307`):

```ts
export declare function boot(binName: string, absoluteConfigPath: string, patches?: PatchOptions[],
                             prepare?: (ctx: Context) => Promise<void> | void,
                             bareModuleBaseUrl?: string): Promise<Context>;
```

Helpers: `mountRootInclude(...)`, `loadOptionalPatches` / `loadOverlayPatches`, `renderConfigDump(...)`,
**`composeEntries(layers, warn?)`** — the same patch application `boot` performs, so composition can be asserted
without mounting. **No API takes a plugin list alone**; plugins are handed in as `insert` patch rows — the exact
shipped-bundle shape.

**Headless test recipe (verified APIs only).** *(A) Out-of-process, zero code:*
`dsh --profile headless --patch .\test.patch.yml "prompt"`, with `test.patch.yml` an insert list mounting your plugin
plus every row it `inject`s; assert exit code, stdout, or the `--json` stream. Pre-check composition with
`dsh --profile headless --dump-config`. *(B) In-process, one prompt to completion* — mirrors
`dsh-headless/lib/index.js:293-349` step for step:

```js
import { boot } from '@deepseek-ai/dsh-app-boot';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
const ctx = await boot('dsh-test', absoluteConfigPath, patches /* insert YOUR plugin row */);
await ctx.get('loader')?.await();
const agents = ctx.get('agents'), sessions = ctx.get('sessions');
const sel = ctx.get('agentDefaultModel').currentSelection();
const agent = (await agents.create({ sessionId, meta: { cwd },
  agentOptions: { provider: sel.provider, model: sel.model },
  setup: (agentCtx) => installModelSelection(agentCtx, { current: sel, assembled: undefined }) })).agent;
await agent.whenIdle();
agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
await agent.whenIdle();
await sessions.flush(agent.session);
// verdict: fold agent.session over the seq range → last non-empty assistant/message + final turn/end reason
```

*(C) JSON-RPC-shaped test:* mount `dsh-sdk-jsonrpc-server` with `Config = { input, output, exit }` over a
`JsonRpcLineTransport` and drive `initialize` → `session/prompt` → `shutdown`.

**Infrastructure that does *not* exist here:** no `@deepseek-ai/dsh-test*` package is installed; `dsh-tools` ships
`lib/types/testing.d.ts` (`defineContentToolFixture`) but has **no `./testing` export subpath**, so importing it fails
with `ERR_PACKAGE_PATH_NOT_EXPORTED`; `dsh-agent-loop-testkit` is a devDependency of 42 packages and is published on
npm at the matching version but is **not installed locally**; `dsh-notify` declares `"test": "node --test"` yet ships
**zero test files**. Only the JSON-RPC server's `input`/`output`/`exit` are documented test hooks.
**Diagnostics:** `ctx.logger` (printf-style `ctx.logger.info('%s', x)`), plus `installFailLoud(binName)` and
`auditStartupEntries(ctx, binName, warn?)` which throws `StartupError` carrying
`entries: readonly StartupEntryDiagnostic[]` — the best assertion target when your plugin fails to mount.

---

## Top 10 facts I would need to write the plugin tomorrow

1. **The plugin is a Cordis object plugin**: `export const name`, `export const inject = [...]`,
   `export const Config` (schemastery), `export function apply(ctx, config)`, **named exports only** — the loader's
   `unwrapExports` normalizes them. `reusable` does not exist in cordis 4.0.4.
2. **Tools use a bespoke schema DSL and `output` is mandatory.** `defineTool({ name, description, parameters,
   output: { schema, render }, execute })` — `execute` returns a *canonical JSON value*, not text; the registry
   validates it against `output.schema` and `render` projects `ContentBlock[]`. There is no `readOnly` flag and no
   per-tool approval flag.
3. **Approval is a policy pipeline**: return `{ kind: 'ask', reason, displayReason: {en, zh} }` (or `deny`/`cancel`)
   from a `tools/pre-execute` waterfall listener, or register a monotonic `ctx.tools.guard()`. Without an
   `ApprovalService`, `ask` degrades to deny.
4. **The prompt has an ordered section registry plus a separate dynamic-context channel**:
   `ctx.systemPrompt.section({name, order, text})` for the **stable prefix** (pick an `order` from `SECTION_ORDERS`,
   e.g. `-900` before the persona prefix) and `ctx.systemPrompt.context({name, order, text})` for a **dynamic tail**
   that becomes a durable *user-role snapshot*. `AssembleContext` carries `context.agent` via module augmentation.
5. **Cache-friendliness is explicit in the type system**: `SystemPromptUpdate = 'in-history'` lets a changed prompt
   "follow the cached history instead of rewriting message 0", and `ToolUpdate` does the same for tool declarations —
   but on routes lacking them, churning section text invalidates the prefix. Keep prefix text stable; put per-turn text
   in `context()` or an appended `agent/pre-step` message.
6. **The reliable lifecycle hooks are agent-scoped waterfalls/emits** (`agent/pre-step`, `agent/request`,
   `agent/turn-stopping`, `agent/error`, `agent/status`, `agent/assistant-stream`) plus `session/event(session, event)`
   for the durable log. `turn/end` exists as a *session* event; `agent.phase` is a real but **undeclared** runtime
   property.
7. **A plugin can trigger compaction and rewrite history**: `ctx.compaction.compactNow(agent, signal, cmdId)` /
   `compactIfNeeded(agent, 'pressure'|'context-overflow', signal)`, and
   `session.append(type, data, { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs })` — the same
   primitive compaction uses. Token pressure is readable via `ctx.tokenMeter.measure(session)`.
8. **Persistence = a storage domain, not SQL.** `defineDomain({name, version, compatibleVersions, layout,
   tables: { t: domainTable(zodSchema) }})` + `await ctx.storageDomain.open(spec)`, then
   `domain.table('t').get/put/update/delete`. **No migrations** — version gating only. The only SQLite in the tree is
   `node:sqlite` `DatabaseSync` inside the closed session-search index, mounted `:memory:` + `openAt: never` by default
   and refusing foreign tables.
9. **Settings = your Cordis `Config` + `.volatile()`.** The row `id` becomes the namespace; `dsh-settings` introspects
   `entry.fiber.runtime.Config` (schemastery, `"toJSON" in schema`) and skips any entry with no volatile field. There is
   no `defineSettings`. A plugin with no exported `Config` gets no settings page.
10. **Web UI is reachable without a build step**: add `dsh.client { platform: 'web' }` + a `./client` export whose file
    calls `window.__ModuleLoader__.load({ id: '<exact package name>', factory(require) })` and returns
    `{ inject: ['slots'], apply(ctx) { ctx.slots.inject(key, () => ctx.slots.register(opts, Component)) } }`, importing
    only `require('react')`. Host HTTP routes come from
    `ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })` (plain `node:http`); a whole page is a keyed
    `main` slot plus a same-id `sidebar.panellist` entry.

### Marked UNCERTAIN

* `reusable` — absent from cordis 4.0.4; may exist in a newer major.
* No doc states the `main` + `sidebar.panellist` page recipe outright (inferred from two shipped plugins).
* `autoGenerate` is served to the client but no client consumer was found; "volatile `Config` ⇒ automatic GUI page" is
  unverified.
* Minimum Node for unflagged `node:sqlite`; no `@deepseek-ai/dsh-*` package declares `engines`.
* No supported pattern for a plugin opening its own SQLite DB (no in-tree example, no helper).
* `agent.phase` is not in the public `.d.ts`; `dsh-notify` relies on it anyway.
* Whether `ModelCompactPolicyConfig` can carry a reasoning effort — only `provider`/`model` are declared.
* `dsh-agent-loop-testkit` exists on npm at 0.1.7-rc.2 but is not installed locally.
* No dedicated tool-attachment API was found; images/files travel as `ContentBlock`s resolved by
  `dsh-attachment-local`.
