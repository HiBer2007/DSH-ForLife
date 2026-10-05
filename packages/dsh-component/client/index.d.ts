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
    readonly activeCount?: number
    readonly fragmentCount?: number
    readonly activeTokens?: number
    readonly fragmentTokens?: number
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
