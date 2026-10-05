/**
 * 消息来源登记（铁律 2 的类型层落地）。
 *
 * ## 为什么来源是"类型问题"而不只是"命名规范"
 *
 * 用户要求："所有唤醒模型的消息都不使用人类发送消息，而是为系统，
 * 人类发送消息保留到后台的一个区域，是唯一直接向模型发送人类消息的位置。"
 *
 * 这句话落到代码里就是：**模型收到的每条消息都必须带一个可判定的来源**，
 * 而 `user` 这个来源在本项目里是禁止的（后台「对话」页用 `forlife:admin`）。
 * 所以这里把三类来源注册进宿主的 `MessageSourceMap`，并提供构造器 ——
 * 构造器会**断言**来源合法，任何试图用 `user` 的地方会在构造时就炸，而不是发出去之后才发现。
 *
 * | 来源 | 谁 | 可信度/审计要求 |
 * | :--- | :--- | :--- |
 * | `forlife:system` | 系统（唤醒、报告、时间上下文） | 系统生成，可复算 |
 * | `forlife:qq` | QQ 用户（通过网关进来） | 外部输入，不可信，要过滤 |
 * | `forlife:admin` | 后台「对话」页的人类 | **唯一的人类直发通道**，要审计 |
 *
 * @module forlife-memory/sources
 */
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'

import { ALLOWED_SOURCES, assertReportSource, type ForlifeSource } from '@forlife/gateway'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 系统消息：唤醒提示、后台报告、异常通知。 */
    'forlife:system': {
      readonly kind: 'forlife:system'
      /** 为什么发这条（进会话日志，便于事后解释"它当时为什么知道这件事"）。 */
      readonly reason?: string
    }
    /** QQ 用户消息（经网关归一化后注入）。 */
    'forlife:qq': {
      readonly kind: 'forlife:qq'
      /** 会话键（多会话单窗口下必须能指回来源）。 */
      readonly conversation: string
      /** 平台侧消息 id，便于与 QQ 侧对账。 */
      readonly platformMessageId?: string
    }
    /** 后台「对话」页的人类消息（唯一的人类直发入口）。 */
    'forlife:admin': {
      readonly kind: 'forlife:admin'
      /** 管理员标识。 */
      readonly actor: string
    }
  }
}

/**
 * 构造一条 `forlife:*` 用户角色消息。
 *
 * @param source - 来源标识。
 * @param text - 消息文本。
 * @param meta - 来源附加信息。
 * @returns 冻结后的消息对象。
 * @throws 当来源是 `user` 或未登记时（铁律 2）。
 */
export function createForlifeMessage(
  source: ForlifeSource,
  text: string,
  meta: { readonly reason?: string; readonly conversation?: string; readonly platformMessageId?: string; readonly actor?: string } = {},
): Message {
  assertReportSource(source)
  const sourceValue =
    source === 'forlife:system'
      ? ({ kind: source, ...(meta.reason === undefined ? {} : { reason: meta.reason }) } as const)
      : source === 'forlife:qq'
        ? ({
            kind: source,
            conversation: meta.conversation ?? '',
            ...(meta.platformMessageId === undefined ? {} : { platformMessageId: meta.platformMessageId }),
          } as const)
        : ({ kind: source, actor: meta.actor ?? 'admin' } as const)

  return createUserMessage({
    content: [{ type: 'text', text }],
    source: sourceValue,
  }) as unknown as Message
}

/** 系统消息（唤醒提示、后台报告）。 */
export function systemMessage(text: string, reason: string): Message {
  return createForlifeMessage('forlife:system', text, { reason })
}

/** QQ 用户消息。 */
export function qqMessage(text: string, conversation: string, platformMessageId?: string): Message {
  return createForlifeMessage('forlife:qq', text, {
    conversation,
    ...(platformMessageId === undefined ? {} : { platformMessageId }),
  })
}

/** 后台人类消息。 */
export function adminMessage(text: string, actor: string): Message {
  return createForlifeMessage('forlife:admin', text, { actor })
}

/** 供测试与审计使用的来源清单。 */
export const FORLIFE_SOURCES = ALLOWED_SOURCES
