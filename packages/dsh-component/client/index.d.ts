/**
 * 客户端模块的类型声明（手写）。
 *
 * `client/index.js` 是**要发布给浏览器的产物**，刻意用普通 JS 写成宿主加载器格式
 * （`window.__ModuleLoader__.load({ id, factory })`），不经过 TypeScript 编译。
 * 这里补一份声明，让测试与调用方有类型可依。
 *
 * @module forlife-memory/client
 */

/** 造元素函数（宿主传 `react/jsx-runtime` 的 `jsx`）。 */
export type CreateElement = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => unknown

/** 面板数据结构（与 `/api/forlife/*` 的响应一致）。 */
export interface PanelSnapshot {
  readonly state?: {
    readonly epoch?: number
    readonly revision?: number
    /** **全表**口径：active 条目数（不等于进上下文的条数）。 */
    readonly activeCount?: number
    readonly fragmentCount?: number
    /** **全表**口径：active 的 token 之和（诊断用；真机曾达 1,505k）。 */
    readonly activeTokens?: number
    readonly fragmentTokens?: number
    /** **窗口**口径：真正进系统提示词的条数。 */
    readonly windowEntries?: number
    /** **窗口**口径：真正进系统提示词的 token 之和 —— 面板显示的是它。 */
    readonly windowTokens?: number
    /** 被窗口丢掉的条目数。 */
    readonly windowDroppedEntries?: number
    /** 被窗口丢掉的 token 之和。 */
    readonly windowDroppedTokens?: number
    /** 其中由**条数上限**造成的条数（0 ⇒ token 预算在生效）。 */
    readonly windowDroppedByCount?: number
    readonly renderedTokens?: number
    readonly renderedSha256?: string
    readonly violations?: readonly string[]
    readonly dbPath?: string
  }
  readonly entries?: readonly {
    readonly id: string
    readonly type: string
    readonly status: string
    readonly summary: string
    readonly hint?: string | null
    readonly tokenCount: number
    readonly windowOffset: number
    readonly epoch: number
    readonly sourceScope?: string | null
    readonly createdAt: string
  }[]
  readonly compaction?: readonly Record<string, unknown>[]
  readonly error?: string
}

/** 结构树节点（与 React 元素同构，但只是数据，可在 Node 里断言）。 */
export interface PanelNode {
  readonly type: string
  readonly props: Record<string, unknown>
  readonly children: readonly (PanelNode | string)[]
}

/** 宿主注册表（`ctx.slots`）。 */
export interface SlotsLike {
  inject(key: string, callback: () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 浏览器侧插件上下文。 */
export interface ClientContext {
  readonly slots: SlotsLike
}

/** 安装面板。 */
export declare function apply(ctx: ClientContext): void
/** 客户端**服务**依赖（不是包名）。 */
export declare const inject: readonly string[]
/** 面板容器组件。 */
export declare function MemoryPanel(): unknown
/** 取一份面板数据快照（失败不抛，落进 `error`）。 */
export declare function fetchSnapshot(signal?: AbortSignal): Promise<PanelSnapshot>
/** 数据 → 结构树（纯函数）。 */
export declare function describePanel(snapshot: PanelSnapshot): PanelNode
/** 结构树 → 宿主元素。 */
export declare function renderPanel(h: CreateElement, panel: PanelNode): unknown
/** 结构树 → 纯文本（便于断言）。 */
export declare function panelText(panel: PanelNode): string

// ── QQ 与后台（阶段 3）──────────────────────────────────────────────────────

/** 出站队列行（与 `/api/forlife/qq/queue` 一致）。 */
export interface QqQueueRow {
  readonly id: string
  readonly conversation: string
  readonly conversationKind: 'group' | 'private' | 'temp'
  readonly kind: string
  readonly status: 'pending' | 'sending' | 'sent' | 'failed'
  readonly source: string
  readonly attempt: number
  readonly error: string | null
  readonly sentAt: string
}

/** QQ 快照（与 `/api/forlife/qq/*`、`/api/forlife/admin/chat` 一致）。 */
export interface QqSnapshot {
  readonly qq?: {
    readonly sessions?: number
    readonly inbound?: number
    readonly inboundPending?: number
    readonly turnsRunning?: number
    readonly turnsDeferred?: number
    readonly outbox?: { readonly pending?: number; readonly sending?: number; readonly sent?: number; readonly failed?: number }
    readonly pendingUnread?: number
    readonly transport?: {
      readonly connectedEvidence?: boolean
      readonly lastInboundAt?: string | null
      readonly lastOutboundAt?: string | null
    }
  }
  readonly queue?: readonly QqQueueRow[]
  readonly queueStats?: Record<string, number>
  readonly turns?: readonly Record<string, unknown>[]
  readonly rules?: readonly Record<string, unknown>[]
  readonly pending?: readonly Record<string, unknown>[]
  readonly pendingStats?: Record<string, number>
  readonly chat?: readonly {
    readonly id: string
    readonly role: 'human' | 'model'
    readonly actor?: string | null
    readonly text: string
    readonly at?: string
    readonly handled?: boolean
    readonly error?: string | null
  }[]
  readonly error?: string
}

/** QQ 面板的交互回调。 */
export interface QqPanelUi {
  readonly draft?: string
  readonly onDraft?: (value: string) => void
  readonly onSend?: () => void
  readonly busy?: boolean
  readonly onPatchRule?: (scope: string, condition: string, patch: Record<string, unknown>) => void
}

/** QQ 与后台面板容器组件。 */
export declare function QqPanel(): unknown
/** 取一份 QQ 与后台快照（失败不抛，落进 `error`）。 */
export declare function fetchQqSnapshot(signal?: AbortSignal): Promise<QqSnapshot>
/** QQ 数据 → 结构树（纯函数）。 */
export declare function describeQq(snapshot: QqSnapshot, ui?: QqPanelUi): PanelNode
/** 往后台对话发一条消息（**唯一的人类直发通道**）。 */
export declare function postAdminMessage(text: string, actor?: string): Promise<Record<string, unknown>>
/** 改一条唤醒规则。 */
export declare function patchWakeRule(scope: string, condition: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>

// ── 提示词（阶段 4）────────────────────────────────────────────────────────

/** 一个提示词槽位的状态。 */
export interface PromptSlugStatus {
  readonly slug: 'p1-system' | 'p2-style'
  readonly sha256: string
  readonly tokenCount: number
  readonly variables: readonly string[]
  readonly updatedAt: string
  readonly updatedBy: string
  readonly revisions: number
}

/** 提示词快照（与 `/api/forlife/prompts*` 一致）。 */
export interface PromptSnapshot {
  readonly prompts?: readonly PromptSlugStatus[]
  readonly variables?: readonly { readonly name: string; readonly dynamic: boolean; readonly description: string; readonly sample?: string }[]
  readonly overrides?: readonly { readonly scope: string; readonly slug: string; readonly revisionId: string }[]
  readonly revisions?: readonly Record<string, unknown>[]
  readonly activeText?: Readonly<Record<string, string>>
  readonly error?: string
}

/** 提示词面板交互回调。 */
export interface PromptPanelUi {
  readonly drafts?: Readonly<Record<string, string>>
  readonly dirty?: Readonly<Record<string, boolean>>
  readonly preview?: Record<string, unknown>
  readonly busy?: boolean
  readonly notice?: string
  readonly onDraft?: (slug: string, text: string) => void
  readonly onPreview?: (slug: string) => void
  readonly onSave?: (slug: string) => void
  readonly onRollback?: (revisionId: string) => void
}

/** 提示词面板容器组件。 */
export declare function PromptPanel(): unknown
/** 取一份提示词快照（失败不抛，落进 `error`）。 */
export declare function fetchPromptSnapshot(signal?: AbortSignal): Promise<PromptSnapshot>
/** 提示词数据 → 结构树（纯函数）。 */
export declare function describePrompts(snapshot: PromptSnapshot, ui?: PromptPanelUi): PanelNode
/** 预览一份提示词（最终拼装结果 + diff + token + 缓存影响）。 */
export declare function previewPrompt(slug: string, text: string): Promise<Record<string, unknown>>
/** 保存一份提示词。 */
export declare function savePrompt(slug: string, text: string): Promise<Record<string, unknown>>
/** 回滚到一个历史版本。 */
export declare function rollbackPromptRevision(revisionId: string): Promise<Record<string, unknown>>
