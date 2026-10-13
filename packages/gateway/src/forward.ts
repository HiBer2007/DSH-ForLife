/**
 * QQ **合并转发**（聊天记录打包）—— 纯逻辑层。
 *
 * ## 为什么单独一个模块
 *
 * 合并转发有**两个方向**，而它们共用同一套结构知识：
 *
 * | 方向 | 走哪个 action | 本模块提供 |
 * | :--- | :--- | :--- |
 * | **收**（解析别人转来的） | `get_forward_msg` | {@link parseForwardMessages} 把返回值摊成可读文本 |
 * | **发**（把一段打包发出去） | `send_{group,private,}_forward_msg` | {@link buildForwardNodes} 把模型的输入变成 NapCat 要的 node |
 *
 * 把这份结构知识放在一处，是因为"收"和"发"对 node 的理解**必须一致** ——
 * 各写一份的下场是"我们发出去的东西自己解析不回来"（SnowLuma 的 issue #467/#493 就是这个形状）。
 *
 * ## ★ 格式不是照 OneBot 文档抄的，是从 NapCat 源码读出来的
 *
 * 证据：容器内 `/app/napcat/napcat.mjs`（2026-10-09 实读，见 `docs/notes/decisions-2026-10-09.md`）。
 *
 * ### 发（`send_group_forward_msg` / `send_private_forward_msg` / `send_forward_msg`）
 *
 * 三个 action 共用同一个 `base_handle`，`messages` 参数经 `$a()` 透传后：
 *
 *  1. **必须全是 `type === 'node'`**。混了普通段会被 `check()` 直接判非法：
 *     原话「转发消息不能和普通消息混在一起发送,转发需要保证message只有type为node的元素」。
 *  2. 一个 node 里真正被读的字段是：
 *     - `data.content` —— **段数组**（不是 `data.message`！packet 路径读的是
 *       `$a(x.data.content)`；非 packet 路径读的也是 `u.data.content`）；
 *     - `data.user_id` / `data.uin` —— 发送者 QQ 号（缺省回落成机器人自己）；
 *     - `data.nickname` / `data.name` —— 发送者昵称（缺省回落成 `QQ用户`）；
 *     - `data.time` —— 节点时间（毫秒，缺省 `Date.now()`）；
 *     - `data.id` —— **转而引用一条已存在的消息**（给了它就不看 content）；
 *     - `data.source` / `news` / `summary` / `prompt` —— 卡片预览（转发卡片上那行小字）。
 *  3. **嵌套深度上限 3 层**，第 4 层起 NapCat 打 warn 并**停止解析**（`c >= 3`）。
 *  4. 返回 `{ message_id, res_id?, forward_id? }`（`res_id` 与 `forward_id` 同值）。
 *
 * ### 收（`get_forward_msg`）
 *
 *  - 入参 `{ message_id }`（也接受 `{ id }`），两个都没有会抛 `message_id is required`。
 *  - 返回 `{ messages: [...] }`。
 *  - ⚠️ **入站消息里的合并转发默认只是个壳**：NapCat 配置项 `parseMultMsg`
 *    **默认 false**（实读 `napcat.mjs` 的 `parseMultMsg: p.Boolean({ default: !1 })`，
 *    且线上 `onebot11_<uin>.json` 里就是 `"parseMultMsg": false`）。
 *    此时段是 `{ type: 'forward', data: { id: '<msgId>' } }` —— **只有 id，没有内容**。
 *    ⇒ 不调 `get_forward_msg` 就等于**整段内容静默丢失**（这正是本模块存在的理由）。
 *  - 打开 `parseMultMsg` 时段里会多一个 `content` 数组，元素是**完整的 OneBot 消息对象**
 *    （`{ user_id, time, sender: { nickname, card }, message: [段] }`），
 *    而不是 `{type:'node'}` —— 所以解析必须**同时认这两种形状**。
 *
 * ## 解析失败/截断一律**说出来**
 *
 * `notes` 里如实记下"哪一段没认出来、是不是被截断了"。
 * 本项目栽过"115 个附件分片旧版完全不渲染、静默丢了 115 个附件"，
 * 所以这里宁可让模型看到一行"有 3 个未知段未渲染"，也不假装那就是全部。
 *
 * @module @forlife/gateway/forward
 */
import { defaultFor } from '@forlife/contracts'

/** 发出去的一个节点（我们从模型的输入构造它）。 */
export interface ForwardNodeInput {
  /** 这一条是谁说的（显示名）。缺省用机器人自己的昵称。 */
  readonly name?: string
  /** 这一条是谁说的（QQ 号）。缺省用机器人自己。 */
  readonly userId?: string
  /** 节点时间（毫秒）；缺省 `Date.now()`。 */
  readonly time?: number
  /** 正文。 */
  readonly text: string
  /** 可选配图（本地路径 / URL / base64，与 `qq_send_image` 的 source 同义）。 */
  readonly image?: string
}

/** 一个 OneBot 段（收回来时我们只关心能变成文字的那几种）。 */
interface RawSegment {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** 把一个值安全地当成对象看。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** 从一个值里取字符串（非字符串返回 undefined，不 `String()` 一切——那会把 `{}` 变成 "[object Object]"）。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 取数字（数字或数字字符串）。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

// ── 发：构造 node ───────────────────────────────────────────────────────────

/** 段：文本。 */
function textSegment(text: string): Record<string, unknown> {
  return { type: 'text', data: { text } }
}

/** 段：图片。 */
function imageSegment(file: string): Record<string, unknown> {
  return { type: 'image', data: { file } }
}

/**
 * 把模型的输入变成 NapCat 真正接受的 node 数组。
 *
 * ⚠️ 这里产出的**只有** `{type:'node'}` —— 因为 NapCat 的 `check()` 明确拒绝混合数组。
 * 想要"一段文字 + 一个转发卡片"这种组合，那要分两条消息发（`qq_reply` + `qq_forward`），
 * 不是在这里塞普通段。
 *
 * 上限（`qq.forward.maxNodes` / `qq.forward.maxChars`）来自基线：
 * 超限**不是**默默砍掉 —— 砍掉会让模型以为发出去了完整的一份。
 * 所以这里返回 `error`，由工具层如实告诉模型"太长了，请分批"。
 *
 * @param nodes - 节点输入。
 * @returns 构造结果：成功给 `nodes`，失败给 `error`。
 */
export function buildForwardNodes(
  nodes: readonly ForwardNodeInput[],
): { readonly ok: true; readonly nodes: readonly Record<string, unknown>[] } | { readonly ok: false; readonly error: string } {
  const maxNodes = defaultFor<number>('qq.forward.maxNodes')
  const maxChars = defaultFor<number>('qq.forward.maxChars')
  if (nodes.length === 0) return { ok: false, error: '合并转发至少要有一个节点（空的一页聊天记录没有意义）' }
  if (nodes.length > maxNodes) {
    return {
      ok: false,
      error: `节点数 ${String(nodes.length)} 超过上限 ${String(maxNodes)}（基线 qq.forward.maxNodes）。请分成几次转发。`,
    }
  }

  const built: Record<string, unknown>[] = []
  for (const [index, node] of nodes.entries()) {
    const text = node.text.trim()
    if (text === '' && node.image === undefined) {
      return { ok: false, error: `第 ${String(index + 1)} 个节点既没有文字也没有图片 —— 空节点在 QQ 上会显示成一条空白。` }
    }
    if (text.length > maxChars) {
      return {
        ok: false,
        error: `第 ${String(index + 1)} 个节点正文 ${String(text.length)} 字，超过上限 ${String(maxChars)}（基线 qq.forward.maxChars）。请拆成多个节点。`,
      }
    }
    const content: Record<string, unknown>[] = []
    if (text !== '') content.push(textSegment(text))
    if (node.image !== undefined && node.image !== '') content.push(imageSegment(node.image))

    // ⚠️ **只写 `content`，不写 `message`**：NapCat 的 packet 与非 packet 两条路径
    // 读的都是 `data.content`（`$a(x.type === ze.node ? x.data.content : x)`）。
    // 写 `message` 会让节点变成**空消息**，而接口照样返回成功 —— 那种"成功但空白"最难查。
    const data: Record<string, unknown> = { content }
    if (node.userId !== undefined && node.userId !== '') data['user_id'] = node.userId
    if (node.name !== undefined && node.name !== '') data['nickname'] = node.name
    data['time'] = node.time ?? Date.now()
    built.push({ type: 'node', data })
  }
  return { ok: true, nodes: built }
}

/**
 * 把"转而引用已有消息"的 node 构造出来（`data.id`）。
 *
 * 用途：别人转来一段聊天记录，模型想原样再转给另一个人。
 * 这比"我们解析成文字再重新打包"更好 —— 图片/语音/表情都能原样保留。
 *
 * @param messageIds - 要转发的消息 id（**NapCat 的短 id**，即 `get_forward_msg` 返回值里那些）。
 * @returns 构造结果。
 */
export function buildForwardNodesFromIds(
  messageIds: readonly string[],
): { readonly ok: true; readonly nodes: readonly Record<string, unknown>[] } | { readonly ok: false; readonly error: string } {
  const maxNodes = defaultFor<number>('qq.forward.maxNodes')
  const ids = messageIds.map((id) => id.trim()).filter((id) => id !== '')
  if (ids.length === 0) return { ok: false, error: '没有可转发的消息 id' }
  if (ids.length > maxNodes) {
    return { ok: false, error: `消息数 ${String(ids.length)} 超过上限 ${String(maxNodes)}（基线 qq.forward.maxNodes）。` }
  }
  return { ok: true, nodes: ids.map((id) => ({ type: 'node', data: { id } })) }
}

// ── 收：解析 messages ───────────────────────────────────────────────────────

/** 解析结果。 */
export interface ParsedForward {
  /** 节点数（一条聊天记录里几条消息）。 */
  readonly nodeCount: number
  /** 摊平后的可读文本（每行 `发送者：内容`）。 */
  readonly text: string
  /**
   * 解析过程中的**如实告警**（截断、深度超限、没认出来的段）。
   *
   * 为什么必须有：静默丢弃正是本项目栽过 115 个附件的那类事故。
   * 有告警时调用方要把它们渲染给模型看，而不是只给"成功"。
   */
  readonly notes: readonly string[]
}

/** 单条节点最多渲染多少字（超了截断并记 notes）。 */
function nodeTextLimit(): number {
  return defaultFor<number>('qq.forward.renderNodeMaxChars')
}

/** 整段合并转发最多渲染多少节点（超了截断并记 notes）。 */
function renderNodeLimit(): number {
  return defaultFor<number>('qq.forward.renderNodeMaxNodes')
}

/** 嵌套深度上限（与 NapCat 的 3 层一致，见模块头）。 */
function depthLimit(): number {
  return defaultFor<number>('qq.forward.maxDepth')
}

/** 把一条消息的段数组渲染成一行文字。 */
function renderSegments(segments: readonly unknown[], notes: string[], where: string): string {
  const parts: string[] = []
  for (const raw of segments) {
    const segment = asRecord(raw)
    if (segment === undefined) {
      // 字符串段（CQ 码解析后的残留）：原样当文字用
      if (typeof raw === 'string') parts.push(raw)
      else notes.push(`${where}：有一个既不是段也不是字符串的元素，已跳过`)
      continue
    }
    const type = asString(segment['type']) ?? ''
    const data = asRecord(segment['data']) ?? {}
    switch (type) {
      case 'text':
        parts.push(asString(data['text']) ?? '')
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'record':
      case 'voice':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push('[文件]')
        break
      case 'at':
        parts.push(`@${asString(data['qq']) ?? '某人'}`)
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'reply':
        parts.push('[引用]')
        break
      case 'forward':
        // 嵌套的合并转发：**内容不在这一层**，只报它存在。
        // 不递归去拉（那要再调一次 get_forward_msg，且可能成环）——
        // 如实说明"这里还有一层"，由模型决定要不要单独取。
        parts.push('[嵌套的合并转发]')
        notes.push(`${where}：内部还有一层合并转发（内容未展开）`)
        break
      case 'json':
      case 'xml':
        parts.push('[卡片]')
        break
      default:
        parts.push(`[${type === '' ? '未知段' : type}]`)
        notes.push(`${where}：未渲染的段类型 ${type === '' ? '(空)' : type}`)
        break
    }
  }
  return parts.join('').trim()
}

/** 从一条消息对象里取发送者显示名。 */
function senderOf(message: Record<string, unknown>): string {
  const sender = asRecord(message['sender']) ?? {}
  return asString(sender['card']) ?? asString(sender['nickname']) ?? asString(message['sender_name']) ?? asString(message['nickname']) ?? asString(message['user_id']) ?? '某人'
}

/**
 * 把 `get_forward_msg` 的返回（或入站 `forward` 段的 `content`）摊成可读文本。
 *
 * **两种形状都要认**（这不是防御性编程，是实测事实，见模块头）：
 *  - **消息对象**：`{ user_id, time, sender: { nickname, card }, message: [段] }`
 *    —— NapCat 打开 `parseMultMsg` 后给的就是这个；
 *  - **node**：`{ type: 'node', data: { user_id, nickname, content|message } }`
 *    —— go-cqhttp / 其它实现给的形状。
 *
 * @param messages - 节点数组。
 * @param options - 已递归到的深度（内部用）。
 * @returns 摊平结果（含如实告警）。
 */
export function parseForwardMessages(messages: unknown, options: { readonly depth?: number } = {}): ParsedForward {
  const depth = options.depth ?? 0
  const notes: string[] = []
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) {
    return { nodeCount: 0, text: '', notes: ['这段合并转发里没有任何消息（可能已过期，或协议端没返回内容）'] }
  }
  if (depth >= depthLimit()) {
    return { nodeCount: 0, text: '', notes: [`嵌套超过 ${String(depthLimit())} 层，按 NapCat 的行为停止解析（内层内容未取）`] }
  }

  const maxNodes = renderNodeLimit()
  const limit = nodeTextLimit()
  const lines: string[] = []
  let rendered = 0

  for (const [index, raw] of list.entries()) {
    const where = `第 ${String(index + 1)} 条`
    const record = asRecord(raw)
    if (record === undefined) {
      notes.push(`${where}：不是对象，已跳过`)
      continue
    }
    if (rendered >= maxNodes) {
      notes.push(`只渲染了前 ${String(maxNodes)} 条（基线 qq.forward.renderNodeMaxNodes），后面还有 ${String(list.length - rendered)} 条未渲染`)
      break
    }

    // 形状 A：node（`{type:'node', data:{...}}`）
    if (record['type'] === 'node') {
      const data = asRecord(record['data']) ?? {}
      const name = asString(data['nickname']) ?? asString(data['name']) ?? asString(data['user_id']) ?? '某人'
      const body = data['content'] ?? data['message'] ?? []
      const renderedBody = renderSegments(Array.isArray(body) ? body : [body], notes, where)
      lines.push(`${name}：${clip(renderedBody, limit, notes, where)}`)
      rendered += 1
      continue
    }

    // 形状 B：完整消息对象（NapCat 的 parseMultMsg 路径）
    const body = record['message'] ?? record['content'] ?? record['raw_message'] ?? ''
    const segments = Array.isArray(body) ? body : [body]
    const renderedBody = renderSegments(segments, notes, where)
    lines.push(`${senderOf(record)}：${clip(renderedBody, limit, notes, where)}`)
    rendered += 1
  }

  return { nodeCount: rendered, text: lines.join('\n'), notes }
}

/** 截断并如实记一笔（不假装那是全文）。 */
function clip(text: string, limit: number, notes: string[], where: string): string {
  if (text.length <= limit) return text
  notes.push(`${where}：正文 ${String(text.length)} 字，已截断到前 ${String(limit)} 字（基线 qq.forward.renderNodeMaxChars）`)
  return `${text.slice(0, limit)}…`
}

/** `get_forward_msg` 的返回里取出 `messages`（形状不对时返回 undefined，让调用方如实报错）。 */
export function extractForwardMessages(payload: unknown): unknown[] | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  const messages = record['messages']
  return Array.isArray(messages) ? messages : undefined
}

/**
 * 入站 `forward` 段的**占位文本**。
 *
 * ★ 为什么必须有占位：旧代码对 `type === 'forward'` 完全不认，
 * 于是 `text` 停在 `''` ⇒ 消息看起来**是空的**。
 * 内容失没丢要先能看见"这里本来有东西"，否则连报警都没有。
 * 有了占位之后，取不回内容时模型看到的是
 * `[合并转发(id=xxx，内容未能取回)]` —— 那是**可见的失败**，不是空白。
 */
export function forwardPlaceholder(id: string, resolved: boolean): string {
  return resolved ? '[合并转发（内容已展开）]' : `[合并转发 id=${id}（内容未能取回，可用 qq_forward 的 read 模式按 id 重试）]`
}
