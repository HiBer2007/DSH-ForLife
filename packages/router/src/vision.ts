/**
 * 视觉/非视觉分流桥接（EXECUTION_PLAN §2.7.2，阶段 5 交付物 8）。
 *
 * ## 最大的坑：模态是**三态**的
 *
 * `LlmModelInfo.inputModalities` 有三种取值，语义完全不同：
 *
 * | 取值 | 宿主行为 | 我们该怎么办 |
 * | :--- | :--- | :--- |
 * | `['text','image']` | 正常下发图片 | 直接进消息（`direct`） |
 * | `['text']` | 框架把图片换成占位文本 | 走桥接（`bridge`）—— 占位文本会**丢内容** |
 * | `undefined` | **未知，框架不降级** | 图片原样下发 ⇒ 适配器硬拒 `UNSUPPORTED_CONTENT` |
 *
 * 第三行是真正危险的那个：`undefined` 不是"不支持"，而是"没人声明"。
 * 所以我们必须**自己定义"未知"策略**，而且只能保守：**按不支持处理**（走桥接），
 * 同时把"该 provider 未声明模态"记进诊断，提示运维去补声明。
 *
 * ## OCR 是提示，不是结论（用户明确要求）
 *
 * 描述模板强制三段：**画面内容 / 文字（OCR）/ 不确定之处**。
 * 并且当 OCR 里出现重要字段（金额/时间/命令/人名）时，要**再走一次视觉复核** ——
 * 因为 OCR 错一个数字（"1000"→"1000"）在文本上看不出来，但后果是实打实的。
 * 复核过的内容才算结论；没复核的 OCR 内容若进了记忆，必须带 `ocr-unverified` 标记。
 *
 * ## 描述不进中期记忆
 *
 * 图片描述属于**短期轨迹**（这一轮看到的画面），只有主模型据此得出的**结论**才可能被 push。
 * 否则记忆里会堆满"图里有个杯子"这种噪音。
 *
 * @module @forlife/router/vision
 */

/** 模态声明（三态）。 */
export type InputModalities = readonly ('text' | 'image')[] | undefined

/** 分流决策。 */
export type ImageRoute = 'direct' | 'bridge' | 'bridge-unverified-modality'

/** 分流结果。 */
export interface ImageRouteDecision {
  readonly route: ImageRoute
  /** 给模型的说明（诊断用：为什么走了桥接）。 */
  readonly reason: string
  /** 是否要记诊断（提示运维补声明）。 */
  readonly diagnostic?: string
}

/**
 * 决定图片怎么走（§2.7.2 的分流表）。
 *
 * @param modalities - 本轮模型的模态声明（**注意三态**）。
 * @returns 决策。
 */
export function decideImageRoute(modalities: InputModalities): ImageRouteDecision {
  if (modalities === undefined) {
    return {
      route: 'bridge-unverified-modality',
      reason: '该 provider **未声明**模态（undefined ≠ 不支持）—— 图片原样下发会被适配器硬拒，所以保守地走桥接',
      diagnostic: '这个 provider/model 没有声明 inputModalities，请补声明（否则每次带图都要多花一次视觉调用，而且我们无法确认它到底支不支持）',
    }
  }
  if (modalities.includes('image')) {
    return { route: 'direct', reason: '模型声明支持 image ⇒ 图片直接进消息（走宿主附件管线，零额外调用）' }
  }
  return {
    route: 'bridge',
    reason: '模型显式声明纯文本 ⇒ 走桥接（不依赖框架的占位文本，那会丢内容）',
  }
}

/** 描述模板（三段强制）。 */
export interface DescriptionTemplate {
  readonly system: string
  readonly user: string
}

/**
 * 描述提示词。
 *
 * 需求方（用户）明确要求"OCR 是提示不是结论"，所以提示词里**直接告诉模型**：
 * 认不出的字要说不确定，不要猜一个看起来合理的。
 *
 * @returns 模板。
 */
export function describePrompt(context?: { readonly senderName?: string; readonly note?: string }): DescriptionTemplate {
  const lines = [
    '你在帮一个看不到图片的模型"看图"。请客观描述这张图片，供它继续对话使用。',
    '',
    '必须按这三段输出，每段都要有（没有内容就写"无"）：',
    '',
    '【画面内容】',
    '客观描述看到的东西：有谁/有什么、在做什么、什么场景。不要推测动机或情绪（除非画面明确）。',
    '',
    '【文字】',
    '把图里的文字**原样**抄下来（聊天截图、文档、路牌、代码都算）。',
    '看不清或认不准的字，用「?」标出，**不要猜一个看起来合理的字** ——',
    '后面的系统会把这段文字当作**线索而不是事实**，认错一个字可能比不认更糟。',
    '',
    '【不确定之处】',
    '明确说出你不确定的地方：是截图还是照片？有没有被裁掉？文字是否模糊？',
    '这一段很重要：它让后续判断知道"哪里不能当真"。',
  ]
  if (context?.senderName !== undefined) lines.push('', `（发送者：${context.senderName}）`)
  if (context?.note !== undefined) lines.push(`（补充：${context.note}）`)
  return {
    system: lines.join('\n'),
    user: '请描述这张图片。',
  }
}

/** 解析出来的描述三段。 */
export interface ParsedDescription {
  readonly scene: string
  readonly ocr?: string
  readonly uncertain?: string
  /** 原文（解析失败时保留，避免丢信息）。 */
  readonly raw: string
  /** OCR 段里有没有"看不清"的标记（说明 OCR 不可靠）。 */
  readonly ocrHasGaps: boolean
}

/** 段标题（容忍全角/半角括号与空格差异）。 */
const SECTION_PATTERNS: Readonly<Record<'scene' | 'ocr' | 'uncertain', RegExp>> = {
  scene: /[【\[]\s*画面内容\s*[】\]]/,
  ocr: /[【\[]\s*文字(?:（OCR）|\(OCR\)|OCR)?\s*[】\]]/,
  uncertain: /[【\[]\s*不确定(?:之处)?\s*[】\]]/,
}

/**
 * 解析描述文本（容忍模型不按格式写）。
 *
 * @param text - 模型输出。
 * @returns 三段与原文。
 */
export function parseDescription(text: string): ParsedDescription {
  const match = (pattern: RegExp): { readonly start: number; readonly end: number } | undefined => {
    const found = pattern.exec(text)
    return found === null ? undefined : { start: found.index, end: found.index + found[0].length }
  }
  const sceneMark = match(SECTION_PATTERNS.scene)
  const ocrMark = match(SECTION_PATTERNS.ocr)
  const uncertainMark = match(SECTION_PATTERNS.uncertain)

  const slice = (from: number | undefined, to: number | undefined): string | undefined => {
    if (from === undefined) return undefined
    const body = to === undefined ? text.slice(from) : text.slice(from, to)
    const trimmed = body.trim()
    if (trimmed === '' || /^无[。.]?$/.test(trimmed)) return undefined
    return trimmed
  }

  const scene = slice(sceneMark?.end, ocrMark?.start ?? uncertainMark?.start) ?? text.trim()
  const ocr = slice(ocrMark?.end, uncertainMark?.start)
  const uncertain = slice(uncertainMark?.end, undefined)
  // "看不清/不确定/?"都是 OCR 不可靠的信号
  const ocrHasGaps = ocr !== undefined && /[?？]|看不清|认不|模糊|不确定/.test(ocr)

  return { scene, ...(ocr === undefined ? {} : { ocr }), ...(uncertain === undefined ? {} : { uncertain }), raw: text, ocrHasGaps }
}

/** 重要字段的类型。 */
export type ImportantFieldKind = 'amount' | 'time' | 'command' | 'name'

/** 一条重要字段。 */
export interface ImportantField {
  readonly kind: ImportantFieldKind
  readonly text: string
}

/**
 * 从 OCR 文本里挑出**重要字段**（这些必须视觉复核）。
 *
 * 为什么是这四类：它们错了的后果最严重且最不可察觉 ——
 * 金额错一位、时间差一天、命令少个参数、人名认错，都是"看起来很正常"的错误。
 *
 * @param ocr - OCR 文本。
 * @returns 重要字段列表。
 */
export function findImportantFields(ocr: string): readonly ImportantField[] {
  const fields: ImportantField[] = []
  // 金额：带货币符号或"元/块/万"的数字
  for (const match of ocr.matchAll(/[¥$€£]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|块|万元|万|美元|欧元)/g)) {
    fields.push({ kind: 'amount', text: match[0] })
  }
  // 时间：日期、钟点、"周X"
  for (const match of ocr.matchAll(/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?|\d{1,2}\s*[:：]\s*\d{2}|(?:周|星期)[一二三四五六日]/g)) {
    fields.push({ kind: 'time', text: match[0] })
  }
  // 命令：看起来像要执行的东西（sudo/apt/pip/docker/git/rm + 参数）
  for (const match of ocr.matchAll(/(?:sudo\s+)?(?:apt|pip|npm|docker|git|systemctl|rm|cp|mv|chmod|curl|wget)\s+[^\n]{1,80}/g)) {
    fields.push({ kind: 'command', text: match[0].trim() })
  }
  // 人名：@某某 或"某某说/某某："
  for (const match of ocr.matchAll(/@[\w\u4e00-\u9fa5]{1,20}|[\u4e00-\u9fa5]{2,4}(?:说|：|:)/g)) {
    fields.push({ kind: 'name', text: match[0] })
  }
  // 去重（同一段文字可能被多条规则命中）
  const seen = new Set<string>()
  return fields.filter((field) => {
    const key = `${field.kind}:${field.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 复核判定。 */
export interface VerificationDecision {
  readonly needed: boolean
  readonly reason: string
  /** 需要复核的字段（复核时要在提示里点名问它们）。 */
  readonly fields: readonly ImportantField[]
}

/**
 * 判断是否需要"再走一次视觉复核"。
 *
 * @param ocr - OCR 文本。
 * @param options - 开关。
 * @returns 判定。
 */
export function decideVerification(
  ocr: string | undefined,
  options: { readonly enabled?: boolean } = {},
): VerificationDecision {
  const enabled = options.enabled ?? true
  if (ocr === undefined || ocr.trim() === '') return { needed: false, reason: '没有 OCR 文本', fields: [] }
  if (!enabled) return { needed: false, reason: '复核被关闭（配置）', fields: [] }

  const fields = findImportantFields(ocr)
  if (fields.length === 0) return { needed: false, reason: 'OCR 里没有金额/时间/命令/人名这类重要字段', fields: [] }

  const kinds = [...new Set(fields.map((field) => field.kind))].join('、')
  return {
    needed: true,
    reason: `OCR 里有重要字段（${kinds}）—— 这类字段认错一个字符在文本上看不出来，但后果是实打实的`,
    fields,
  }
}

/**
 * 复核提示词：**点名**让视觉模型确认那几个字段。
 *
 * 为什么不直接重跑一次描述：因为"再看一遍整张图"很容易得到同样的错。
 * 点名问"这个金额是 1000 还是 10000"才真正有对抗性。
 *
 * @param fields - 要复核的字段。
 * @returns 提示词。
 */
export function verificationPrompt(fields: readonly ImportantField[]): string {
  const lines = [
    '请**仔细核对**下面这些从图中读出的内容。逐条回答"正确"或给出正确内容，并说明依据（在图的哪个位置）。',
    '看不清就明确说看不清 —— 不要为了让答案完整而猜。',
    '',
  ]
  for (const field of fields) lines.push(`- [${field.kind}] ${field.text}`)
  return lines.join('\n')
}

/** 记忆条目的来源标记。 */
export interface MemorySourceMark {
  readonly source: 'ocr-unverified' | 'vision-verified'
  readonly note: string
}

/**
 * 给"要写进记忆的内容"打来源标记（用户明确要求）。
 *
 * 规则：
 *  - OCR 内容**未被视觉复核** ⇒ `ocr-unverified`（提示词里要告知模型"这是提示不是结论"）；
 *  - 复核过 ⇒ `vision-verified`。
 *
 * @param input - 是否复核过、是否含 OCR 内容。
 * @returns 标记，或 undefined（不含 OCR 内容就不需要标记）。
 */
export function markMemorySource(input: {
  readonly containsOcr: boolean
  readonly verified: boolean
}): MemorySourceMark | undefined {
  if (!input.containsOcr) return undefined
  return input.verified
    ? { source: 'vision-verified', note: '这段内容里的文字来自图片，已经过视觉复核' }
    : {
        source: 'ocr-unverified',
        note:
          '这段内容里的文字来自图片 OCR，**未经视觉复核** —— 它是提示不是结论。' +
          '涉及金额/时间/命令/人名时请先核对原图，不要直接当成事实使用。',
      }
}

/** 拼给主模型看的图片描述块。 */
export interface DescriptionBlockInput {
  readonly attachmentId: string
  readonly description: ParsedDescription
  readonly verified?: boolean
  readonly reused?: boolean
}

/**
 * 拼描述块（替代框架那个"图片被省略了"的占位文本）。
 *
 * @param input - 描述与元信息。
 * @returns 文本块。
 */
export function renderDescriptionBlock(input: DescriptionBlockInput): string {
  const lines = [`[图片描述${input.reused === true ? '（复用已有描述，未重复调用视觉模型）' : ''}]`, input.description.scene]
  if (input.description.ocr !== undefined) {
    lines.push('', '图中文字：', input.description.ocr)
    if (input.description.ocrHasGaps) {
      lines.push('（其中带「?」的地方是**没认准**的，不要当成事实）')
    }
  }
  if (input.description.uncertain !== undefined) lines.push('', `不确定之处：${input.description.uncertain}`)
  const mark = markMemorySource({ containsOcr: input.description.ocr !== undefined, verified: input.verified === true })
  if (mark !== undefined) lines.push('', `（来源标记：${mark.source} —— ${mark.note}）`)
  lines.push('', `（附件 id：${input.attachmentId}，需要再细看时可以用 describe_image 工具）`)
  return lines.join('\n')
}

/** 视觉调用计数（验收项：同一张图第二次 0 次调用）。 */
export interface VisionCallCounter {
  /** 这张图历史上被描述过几次。 */
  readonly calls: number
  /** 是否复用了缓存（true = 这次 0 次视觉调用）。 */
  readonly reused: boolean
}

/**
 * 判断"要不要真的调用视觉模型"。
 *
 * @param cached - 缓存里的条目（有 ⇒ 复用）。
 * @returns 是否需要调用，以及调用原因。
 */
export function decideVisionCall(cached: { readonly visionCalls: number; readonly verified?: boolean } | undefined): {
  readonly needed: boolean
  readonly reason: string
  readonly counter: VisionCallCounter
} {
  if (cached === undefined) {
    return { needed: true, reason: '首次见到这张图，需要描述', counter: { calls: 0, reused: false } }
  }
  return {
    needed: false,
    reason: `已有描述（历史调用 ${String(cached.visionCalls)} 次）⇒ 直接复用，**0 次视觉调用**`,
    counter: { calls: cached.visionCalls, reused: true },
  }
}
/**
 * 便捷适配：直接吃数据库行（`image_descriptions` 的 snake_case）。
 *
 * 放在这里是为了让"纯逻辑的 camelCase 契约"与"存储层的 snake_case"之间
 * 只有**一处**转换点 —— 散在各调用点的话，改列名时会漏掉某处而静默失效
 * （比如缓存永远不命中 ⇒ 每次都白花一次视觉调用，而没人会注意到）。
 *
 * @param row - 描述行（来自 `getImageDescription`）。
 * @returns 是否需要调用视觉模型。
 */
export function decideVisionCallForRow(row: { readonly vision_calls: number } | undefined): ReturnType<typeof decideVisionCall> {
  return decideVisionCall(row === undefined ? undefined : { visionCalls: row.vision_calls })
}
