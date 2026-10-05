/**
 * 会话事件：把"记忆变了"写进会话日志。
 *
 * 宿主机制（实测 `dsh-session`）：
 *  - `SessionEventMap` 是**可合并扩展**的接口（`types.d.ts:255`）；
 *  - `append<T extends SessionEventType>(type, data, opts)`（`index.d.ts:246`）；
 *  - 未登记在 `KNOWN_SESSION_EVENT_TYPES` 里的事件，**必须**带 `{ ignorable: true }` 才会被
 *    当作"保留但不影响对话表面"的记录（`surface.js:210`）；
 *    否则会被当成未知事件而拒绝/报错。
 *
 * 因此：所有 `forlife.*` 事件一律以 `ignorable: true` 追加。
 *
 * @module forlife-memory/events
 */

/** 一条中期记忆被追加。 */
export interface MidMemoryAppendedEvent {
  readonly entryId: string
  readonly revision: number
  readonly windowOffset: number
  readonly tokenCount: number
  readonly sourceScope?: string | null
}

/** 渲染视图发生变化（修订号推进）。 */
export interface RenderChangedEvent {
  readonly epoch: number
  readonly revision: number
  readonly sha256: string
  readonly activeCount: number
  readonly fragmentCount: number
}

/** 一条中期记忆被降级为碎片（位置迁移，不是删除）。 */
export interface MidMemoryFragmentedEvent {
  readonly entryId: string
  readonly longMemoryId: string
  readonly hint: string
  readonly hintTokens: number
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** 中期记忆追加（`ignorable`）。 */
    'forlife.mid_memory.appended': MidMemoryAppendedEvent
    /** 中期记忆碎片化（`ignorable`）。 */
    'forlife.mid_memory.fragmented': MidMemoryFragmentedEvent
    /** 渲染视图已变（`ignorable`）。 */
    'forlife.render.changed': RenderChangedEvent
  }
}

/** 宿主会话的最小结构（只依赖 `append`）。 */
export interface SessionLike {
  append(type: string, data: unknown, opts?: { readonly ignorable?: true }): unknown
}

/** 我们声明的全部事件类型（测试用同一份清单）。 */
export const FORLIFE_EVENT_TYPES = [
  'forlife.mid_memory.appended',
  'forlife.mid_memory.fragmented',
  'forlife.render.changed',
] as const

/**
 * 追加一条 `forlife.*` 会话事件。
 *
 * 会话不存在时**静默跳过**：记忆写入本身是权威的（表已落盘），
 * 事件只是给会话日志的旁路记录，不该因为它让记忆写入失败。
 *
 * @param session - 会话（可为 undefined）。
 * @param type - 事件类型。
 * @param data - 事件数据。
 * @returns 是否真的写入了。
 */
export function emitForlifeEvent(session: SessionLike | undefined, type: string, data: unknown): boolean {
  if (session === undefined) return false
  try {
    session.append(type, data, { ignorable: true })
    return true
  } catch {
    return false
  }
}
