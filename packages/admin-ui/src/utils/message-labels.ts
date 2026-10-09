/**
 * 入站消息的**类型标签** —— 一份事实，面板多处使用。
 *
 * ## 为什么要有这个模块（审计 §6.2 的「面板显示方向」）
 *
 * `ConversationsView` 的消息预览只映射了 `image` / `file` 两种媒体类型，
 * 于是**语音与视频消息在面板上显示成「（无文本）」** —— 看起来像一条空消息，
 * 而实际上那里有一条语音。同一个毛病在 `MediaView` 的「类型」列上也有
 * （`record` / `video` 直接把英文枚举名显示给用户）。
 *
 * ## 两类标签，对应**两个不同的数据来源**
 *
 * | 标签 | 来源 | 什么时候出现 |
 * | :--- | :--- | :--- |
 * | `MEDIA_KIND_LABELS` | `qq_inbox.media_kind` 列（**只有 4 个取值**） | 图片/文件/语音/视频 |
 * | `SEGMENT_LABELS` | `text` 里的 `[未解析:<type>]` 占位符 | 表情/卡片/合并转发/在线文件… |
 *
 * 为什么表情/卡片那些不能走 `media_kind`：网关的 `mediaKind` 只认那 4 类
 * （`transport.ts` 的 `InboundMessage['mediaKind']`），其余 segment 只留一个**占位文本**
 * （`onebot.ts` 的 `else` 分支，2026-10-09 P0-1 补的）。所以面板要读的是**文本里的占位符**，
 * 而不是等一个永远不会有的列。
 *
 * ⚠️ 段名清单以审计报告 §二 的 segment 枚举（NapCat 实测 24 种）为准 ——
 * 少列一个的后果是那个类型在面板上显示成 `[未解析:mface]` 这样的英文代号
 * （比编一个错的中文名好，但不如列全）。
 *
 * @module admin-ui/utils/message-labels
 */

/** `qq_inbox.media_kind` 的 4 个取值 → 中文（**只有这 4 个**，见 `transport.ts`）。 */
export const MEDIA_KIND_LABELS: Readonly<Record<string, string>> = {
  image: '图片',
  file: '文件',
  record: '语音',
  video: '视频',
}

/**
 * 消息段名 → 中文（NapCat 实测 24 种 segment 枚举，审计 §二）。
 *
 * `text` / `at` / `reply` 也会出现（它们被正常解析了），留着是为了
 * "同一张表管所有段名" —— 只列未解析的那几个的话，将来谁改了渲染就会漏。
 */
export const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  text: '文本',
  image: '图片',
  music: '音乐',
  video: '视频',
  record: '语音',
  file: '文件',
  at: '@某人',
  reply: '引用',
  json: '分享卡片',
  face: 'QQ表情',
  mface: '商城表情',
  markdown: 'Markdown',
  node: '转发节点',
  forward: '合并转发',
  xml: 'XML 消息',
  poke: '拍一拍',
  dice: '骰子',
  rps: '猜拳',
  miniapp: '小程序',
  contact: '名片',
  location: '位置',
  onlinefile: '在线文件',
  flashtransfer: '闪传',
}

/** 媒体类型 → 中文；不是已知类型（或没有值）时返回 `undefined`（让调用方决定怎么显示）。 */
export function mediaKindLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return MEDIA_KIND_LABELS[value]
}

/**
 * 把文本里的 `[未解析:<段名>]` 占位符翻成中文（未知段名保持不变）。
 *
 * **为什么不直接改网关输出的文本**：那段文本会进模型提示词，改动它等于改提示词内容
 * （属于另一条链路的事）；而这里只影响面板显示 —— 两件事分开，各自可以独立演进。
 */
export function translateSegmentTokens(text: string): string {
  return text.replace(/\[未解析:([^\]]+)\]/g, (whole, rawType: string) => {
    const label = SEGMENT_LABELS[rawType]
    return label === undefined ? whole : `[${label}]`
  })
}

/** 入站消息在列表里的预览文本（媒体标记 + 正文，正文为空时给占位符）。 */
export function inboundPreview(input: { readonly mediaKind: unknown; readonly text: unknown }): string {
  const label = mediaKindLabel(input.mediaKind)
  const prefix = label === undefined ? '' : `[${label}]`
  const body = translateSegmentTokens(typeof input.text === 'string' ? input.text.trim() : '')
  if (body === '') return prefix === '' ? '（无文本）' : prefix
  // 正文里已经有同一个标签（网关自己就会写 `[图片]`）⇒ 不再重复一遍
  if (prefix !== '' && body.startsWith(prefix)) return body
  return `${prefix === '' ? '' : `${prefix} `}${body}`
}
