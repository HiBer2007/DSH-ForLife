/**
 * 视觉桥接的运行时（阶段 5 交付物 8 的接线部分，§2.7.2）。
 *
 * ## 这里的每一条"防御"都对应一种会让模型说胡话的失败
 *
 * ① **永不抛异常**：这个桥接跑在 `agent/pre-step` 里，抛错会**毁掉整轮** ——
 *    宁可退回占位文本（模型说"图片我看不清"），也不能让用户的消息掉在地上。
 * ② **描述不进中期记忆**：图片描述是**短期轨迹**（这一轮看到的画面），
 *    只有主模型据此得出的**结论**才可能被 push。否则记忆里会堆满"图里有个杯子"。
 * ③ **未复核的 OCR 带标记**：金额/时间/命令/人名这类字段认错一个字符，
 *    在文本上看不出来，但后果是实打实的。
 * ④ **同图不重复调用**：内容寻址（`sha256:`）⇒ 命中缓存就是 0 次视觉调用。
 *
 * @module forlife-memory/vision-bridge
 */
import {
  decideVerification,
  decideVisionCallForRow,
  describePrompt,
  markMemorySource,
  parseDescription,
  renderDescriptionBlock,
  verificationPrompt,
  type ParsedDescription,
} from '@forlife/router'
import { getImageDescription, recordVisionCall, saveImageDescription } from '@forlife/store'

import type { MemoryRuntime } from './runtime.ts'

/** 视觉模型接口（注入：真机用 `ctx.llm.stream`，测试用假的）。 */
export interface VisionDescriber {
  /**
   * 用视觉模型描述一张图。
   *
   * @param input - 附件 id 与提示词。
   * @returns 模型输出（原始文本）。
   */
  describe: (input: { readonly attachmentId: string; readonly system: string; readonly user: string }) => Promise<string>
}

/** 桥接结果。 */
export interface VisionBridgeResult {
  /** 给主模型看的文本块。 */
  readonly text: string
  /** 是否复用了缓存（true = 0 次视觉调用）。 */
  readonly reused: boolean
  /** 本次实际发生的视觉调用次数。 */
  readonly calls: number
  /** 是否经过复核。 */
  readonly verified: boolean
  /** 描述是否可用（false = 退回了占位文本）。 */
  readonly ok: boolean
  /** 失败原因（ok=false 时）。 */
  readonly error?: string
}

/** 桥接选项。 */
export interface VisionBridgeOptions {
  readonly describer?: VisionDescriber
  readonly provider?: string
  readonly model?: string
  /** 是否对重要字段做二次视觉复核（默认开）。 */
  readonly verifyImportantFields?: boolean
  readonly log?: (message: string) => void
}

/** 占位文本（与宿主框架同款语义：明确说"图被省略了"，并给出附件 id 以便追查）。 */
export function placeholderText(attachmentId: string, reason: string): string {
  return `[图片未能描述：${reason}；附件 ${attachmentId}]`
}

/**
 * 视觉桥接。
 */
export class VisionBridge {
  private readonly runtime: MemoryRuntime
  private readonly options: VisionBridgeOptions

  constructor(runtime: MemoryRuntime, options: VisionBridgeOptions = {}) {
    this.runtime = runtime
    this.options = options
  }

  /**
   * 取（或生成）一张图的描述块。
   *
   * **这个方法永不抛异常** —— 任何失败都退回占位文本。
   *
   * @param attachmentId - 附件 id（`sha256:<64hex>`）。
   * @returns 结果。
   */
  async describeImage(attachmentId: string): Promise<VisionBridgeResult> {
    const cached = getImageDescription(this.runtime.db, attachmentId)
    const decision = decideVisionCallForRow(cached)

    // ① 缓存命中 ⇒ **0 次视觉调用**（验收项）
    if (!decision.needed && cached !== undefined) {
      this.options.log?.(`图片 ${attachmentId.slice(0, 16)}… 命中描述缓存（${decision.reason}）`)
      return {
        text: renderDescriptionBlock({
          attachmentId,
          description: { scene: cached.scene, ...(cached.ocr_text === null ? {} : { ocr: cached.ocr_text }), ...(cached.uncertain === null ? {} : { uncertain: cached.uncertain }), raw: cached.description, ocrHasGaps: /[?？]/.test(cached.ocr_text ?? '') },
          reused: true,
        }),
        reused: true,
        calls: 0,
        verified: false,
        ok: true,
      }
    }

    const describer = this.options.describer
    if (describer === undefined) {
      // 没有视觉模型 ⇒ 如实退回占位文本（**不假装看懂了**）
      return {
        text: placeholderText(attachmentId, '没有可用的视觉模型（该 provider 未声明 image 能力，或视觉角色未配置）'),
        reused: false,
        calls: 0,
        verified: false,
        ok: false,
        error: '视觉模型未配置',
      }
    }

    const prompt = describePrompt()
    try {
      const raw = await describer.describe({ attachmentId, system: prompt.system, user: prompt.user })
      recordVisionCall(this.runtime.db, {
        attachmentId,
        reason: 'bridge',
        provider: this.options.provider ?? null,
        model: this.options.model ?? null,
      })
      let calls = 1
      let description = parseDescription(raw)
      let verified = false

      // ② 重要字段复核（金额/时间/命令/人名）—— "再看一遍整张图"很容易得到同样的错，
      //    所以复核提示要**点名**那几个字段，才有对抗性
      const verification = decideVerification(description.ocr, { enabled: this.options.verifyImportantFields ?? true })
      if (verification.needed) {
        try {
          const checked = await describer.describe({
            attachmentId,
            system: '你是核对者。只核对用户点名的字段，不要重新描述整张图。',
            user: verificationPrompt(verification.fields),
          })
          recordVisionCall(this.runtime.db, {
            attachmentId,
            reason: 'verify-important-fields',
            provider: this.options.provider ?? null,
            model: this.options.model ?? null,
          })
          calls += 1
          verified = true
          description = mergeVerification(description, checked)
          this.options.log?.(`图片 ${attachmentId.slice(0, 16)}… 的重要字段已复核：${verification.reason}`)
        } catch (error) {
          // 复核失败**不算致命**：描述本身还在，只是要标成未复核
          this.options.log?.(`图片 ${attachmentId.slice(0, 16)}… 重要字段复核失败（描述仍可用，但会标为未复核）：${String(error)}`)
        }
      }

      const block = renderDescriptionBlock({ attachmentId, description, ...(verified ? { verified: true } : {}) })
      saveImageDescription(this.runtime.db, {
        attachmentId,
        scene: description.scene,
        ocrText: description.ocr ?? null,
        uncertain: description.uncertain ?? null,
        description: block,
        provider: this.options.provider ?? null,
        model: this.options.model ?? null,
      })
      return { text: block, reused: false, calls, verified, ok: true }
    } catch (error) {
      // ③ **任何异常都必须吞掉**：这个桥接跑在 pre-step 里，抛错会毁掉整轮
      recordVisionCall(this.runtime.db, {
        attachmentId,
        reason: 'bridge',
        provider: this.options.provider ?? null,
        model: this.options.model ?? null,
        ok: false,
        note: String(error).slice(0, 200),
      })
      this.options.log?.(`图片 ${attachmentId.slice(0, 16)}… 描述失败，已退回占位文本：${String(error)}`)
      return {
        text: placeholderText(attachmentId, '视觉调用失败'),
        reused: false,
        calls: 0,
        verified: false,
        ok: false,
        error: String(error),
      }
    }
  }

  /**
   * 描述是否可以进中期记忆（**默认不可以**）。
   *
   * 这条判断单独成一个方法，是为了让"描述属短期轨迹"这个约定**显式**存在 ——
   * 否则将来某处顺手把它 push 进记忆，没人会注意到。
   *
   * @returns 恒为 false，并给出理由。
   */
  canEnterMidMemory(): { readonly allowed: boolean; readonly reason: string } {
    return {
      allowed: false,
      reason:
        '图片描述属于**短期轨迹**（这一轮看到的画面），只有主模型据此得出的**结论**才可能被 push。' +
        '否则记忆里会堆满"图里有个杯子"这类噪音，把真正重要的记忆挤出去。',
    }
  }
}

/**
 * 把复核结果并进描述（在 OCR 段后追加一段"复核结论"）。
 *
 * @param description - 原描述。
 * @param checked - 复核输出。
 * @returns 新描述。
 */
function mergeVerification(description: ParsedDescription, checked: string): ParsedDescription {
  const trimmed = checked.trim()
  if (trimmed === '') return description
  return {
    ...description,
    uncertain: [description.uncertain, `（重要字段复核结论）${trimmed}`].filter((part) => part !== undefined && part !== '').join('\n'),
  }
}

/**
 * 描述块要不要给"未复核"标记（供上层写记忆时调用）。
 *
 * @param input - 是否含 OCR、是否复核过。
 * @returns 标记或 undefined。
 */
export function describeSourceMark(input: { readonly containsOcr: boolean; readonly verified: boolean }): ReturnType<typeof markMemorySource> {
  return markMemorySource(input)
}
